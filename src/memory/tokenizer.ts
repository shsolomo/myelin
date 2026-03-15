/**
 * Pure TypeScript tokenizer that reads HuggingFace tokenizer.json format.
 *
 * Supports two algorithms:
 *   - WordPiece (for all-MiniLM-L6-v2 embedding model)
 *   - Unigram   (for GLiNER DeBERTa v2 NER model)
 *
 * No external dependencies — reads the tokenizer.json file and implements
 * tokenization directly.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Tokenizer {
  encode(text: string, options?: { addSpecialTokens?: boolean }): number[];
  tokenToId(token: string): number | undefined;
  idToToken(id: number): string | undefined;
  vocab: Map<string, number>;
}

// ---------------------------------------------------------------------------
// tokenizer.json schema (subset we care about)
// ---------------------------------------------------------------------------

interface TokenizerJson {
  model: {
    type: string;
    vocab: Record<string, number> | Array<[string, number]>;
    unk_token?: string;
    unk_id?: number;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
    byte_fallback?: boolean;
  };
  normalizer?: NormalizerConfig;
  pre_tokenizer?: PreTokenizerConfig;
  added_tokens?: AddedToken[];
}

interface NormalizerConfig {
  type: string;
  normalizers?: NormalizerConfig[];
  pattern?: { Regex?: string; String?: string };
  content?: string;
  strip_left?: boolean;
  strip_right?: boolean;
  lowercase?: boolean;
  strip_accents?: boolean;
}

interface PreTokenizerConfig {
  type: string;
  replacement?: string;
  prepend_scheme?: string;
  split?: boolean;
}

interface AddedToken {
  id: number;
  content: string;
  special: boolean;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export async function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer> {
  const raw = readFileSync(tokenizerJsonPath, "utf-8");
  const config: TokenizerJson = JSON.parse(raw);

  // Merge added_tokens into vocab
  const addedTokenMap = new Map<string, number>();
  if (config.added_tokens) {
    for (const t of config.added_tokens) {
      addedTokenMap.set(t.content, t.id);
    }
  }

  if (config.model.type === "WordPiece") {
    return buildWordPieceTokenizer(config, addedTokenMap);
  } else if (config.model.type === "Unigram") {
    return buildUnigramTokenizer(config, addedTokenMap);
  } else {
    throw new Error(`Unsupported tokenizer type: ${config.model.type}`);
  }
}

// ============================================================================
// WordPiece tokenizer (BertTokenizer)
// ============================================================================

function buildWordPieceTokenizer(
  config: TokenizerJson,
  addedTokens: Map<string, number>,
): Tokenizer {
  const vocabObj = config.model.vocab as Record<string, number>;
  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(vocabObj)) {
    vocab.set(token, id);
  }
  // Merge added tokens (overwrite if conflict)
  for (const [token, id] of addedTokens) {
    vocab.set(token, id);
  }

  const reverseVocab = new Map<number, string>();
  for (const [token, id] of vocab) {
    reverseVocab.set(id, token);
  }

  const unkToken = config.model.unk_token ?? "[UNK]";
  const prefix = config.model.continuing_subword_prefix ?? "##";
  const maxChars = config.model.max_input_chars_per_word ?? 100;
  const clsId = vocab.get("[CLS]") ?? 101;
  const sepId = vocab.get("[SEP]") ?? 102;

  // Normalizer config
  const normConfig = config.normalizer;
  const doLowercase = normConfig?.type === "BertNormalizer" && normConfig.lowercase !== false;
  const doStripAccents = normConfig?.type === "BertNormalizer" && normConfig.strip_accents !== false;

  function normalize(text: string): string {
    let result = text;
    if (doLowercase) {
      result = result.toLowerCase();
    }
    if (doStripAccents) {
      // NFD decompose → remove combining characters (Unicode category Mn) → NFC
      result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
    }
    return result;
  }

  function preTokenize(text: string): string[] {
    // BertPreTokenizer: split on whitespace, then split punctuation
    const tokens: string[] = [];
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) {
      // Split runs of (letters/numbers/underscore) vs (punctuation/symbols)
      let current = "";
      let currentIsPunct: boolean | null = null;
      for (const ch of word) {
        const isPunct = isUnicodePunctuation(ch);
        if (currentIsPunct !== null && isPunct !== currentIsPunct) {
          if (current.length > 0) tokens.push(current);
          current = "";
        }
        current += ch;
        currentIsPunct = isPunct;
      }
      if (current.length > 0) tokens.push(current);
    }
    return tokens;
  }

  function wordPieceTokenize(word: string): number[] {
    if (word.length > maxChars) {
      return [vocab.get(unkToken) ?? 100];
    }

    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let foundId: number | undefined;
      while (start < end) {
        const substr = start > 0 ? prefix + word.slice(start, end) : word.slice(start, end);
        const id = vocab.get(substr);
        if (id !== undefined) {
          foundId = id;
          break;
        }
        end--;
      }
      if (foundId === undefined) {
        // No subword match found → entire word is [UNK]
        return [vocab.get(unkToken) ?? 100];
      }
      ids.push(foundId);
      start = end;
    }
    return ids;
  }

  function encode(text: string, options?: { addSpecialTokens?: boolean }): number[] {
    const addSpecial = options?.addSpecialTokens !== false; // default true
    const normalized = normalize(text);
    const preTokens = preTokenize(normalized);

    const ids: number[] = [];
    if (addSpecial) ids.push(clsId);
    for (const preToken of preTokens) {
      ids.push(...wordPieceTokenize(preToken));
    }
    if (addSpecial) ids.push(sepId);
    return ids;
  }

  return {
    encode,
    tokenToId: (token: string) => vocab.get(token),
    idToToken: (id: number) => reverseVocab.get(id),
    vocab,
  };
}

// ============================================================================
// Unigram tokenizer (SentencePiece-style)
// ============================================================================

function buildUnigramTokenizer(
  config: TokenizerJson,
  addedTokens: Map<string, number>,
): Tokenizer {
  const vocabArray = config.model.vocab as Array<[string, number]>;
  const vocab = new Map<string, number>();
  const scores = new Map<string, number>();

  for (let i = 0; i < vocabArray.length; i++) {
    const [token, score] = vocabArray[i];
    vocab.set(token, i);
    scores.set(token, score);
  }

  // Merge added tokens
  for (const [token, id] of addedTokens) {
    vocab.set(token, id);
  }

  const reverseVocab = new Map<number, string>();
  for (const [token, id] of vocab) {
    reverseVocab.set(id, token);
  }

  const unkId = config.model.unk_id ?? 3;

  // Build a trie for efficient prefix lookup
  const trie = buildTrie(vocabArray);

  // Normalizer config
  const normConfig = config.normalizer;

  function normalize(text: string): string {
    let result = text;
    if (normConfig) {
      if (normConfig.type === "Sequence" && normConfig.normalizers) {
        for (const n of normConfig.normalizers) {
          result = applyNormalizer(result, n);
        }
      } else {
        result = applyNormalizer(result, normConfig);
      }
    }
    return result;
  }

  function metaspacePreTokenize(text: string): string[] {
    if (text.length === 0) return [];
    // Prepend ▁ to entire text, then replace all spaces with ▁
    const transformed = "▁" + text.replace(/ /g, "▁");
    // Split into segments on ▁ boundaries, keeping the ▁ prefix on each segment
    const segments: string[] = [];
    let current = "";
    for (let i = 0; i < transformed.length; i++) {
      const ch = transformed[i];
      if (ch === "▁" && current.length > 0) {
        segments.push(current);
        current = "▁";
      } else {
        current += ch;
      }
    }
    if (current.length > 0) segments.push(current);
    return segments;
  }

  function unigramTokenize(preToken: string): number[] {
    const len = preToken.length;
    if (len === 0) return [];

    // Viterbi algorithm
    const bestScore = new Float64Array(len + 1);
    const bestLen = new Int32Array(len + 1); // length of best token ending at position i
    bestScore[0] = 0;
    for (let i = 1; i <= len; i++) {
      bestScore[i] = -Infinity;
    }

    for (let i = 0; i < len; i++) {
      if (bestScore[i] === -Infinity) continue;
      // Find all vocab tokens starting at position i using trie
      const matches = trieSearch(trie, preToken, i);
      for (const { token, score } of matches) {
        const end = i + token.length;
        const candidateScore = bestScore[i] + score;
        if (candidateScore > bestScore[end]) {
          bestScore[end] = candidateScore;
          bestLen[end] = token.length;
        }
      }
    }

    // Backtrack
    if (bestScore[len] === -Infinity) {
      // No valid segmentation → emit UNK for each character
      return new Array(len).fill(unkId);
    }

    const tokenIds: number[] = [];
    let pos = len;
    while (pos > 0) {
      const tokenLen = bestLen[pos];
      if (tokenLen === 0) {
        // Safety: should never happen if forward pass is correct
        return new Array(len).fill(unkId);
      }
      const token = preToken.slice(pos - tokenLen, pos);
      const id = vocab.get(token);
      tokenIds.push(id ?? unkId);
      pos -= tokenLen;
    }
    tokenIds.reverse();
    return tokenIds;
  }

  function encode(text: string, options?: { addSpecialTokens?: boolean }): number[] {
    const addSpecial = options?.addSpecialTokens !== false; // default true
    const normalized = normalize(text);
    const preTokens = metaspacePreTokenize(normalized);

    const ids: number[] = [];
    if (addSpecial) ids.push(vocab.get("[CLS]") ?? 1);
    for (const preToken of preTokens) {
      ids.push(...unigramTokenize(preToken));
    }
    if (addSpecial) ids.push(vocab.get("[SEP]") ?? 2);
    return ids;
  }

  return {
    encode,
    tokenToId: (token: string) => vocab.get(token),
    idToToken: (id: number) => reverseVocab.get(id),
    vocab,
  };
}

// ============================================================================
// Trie for efficient prefix matching
// ============================================================================

interface TrieNode {
  children: Map<string, TrieNode>;
  token: string | null; // full token string if this is a terminal
  score: number;
}

function buildTrie(vocabArray: Array<[string, number]>): TrieNode {
  const root: TrieNode = { children: new Map(), token: null, score: 0 };
  for (const [token, score] of vocabArray) {
    let node = root;
    for (const ch of token) {
      let child = node.children.get(ch);
      if (!child) {
        child = { children: new Map(), token: null, score: 0 };
        node.children.set(ch, child);
      }
      node = child;
    }
    node.token = token;
    node.score = score;
  }
  return root;
}

interface TrieMatch {
  token: string;
  score: number;
}

function trieSearch(root: TrieNode, text: string, startPos: number): TrieMatch[] {
  const matches: TrieMatch[] = [];
  let node = root;
  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];
    const child = node.children.get(ch);
    if (!child) break;
    node = child;
    if (node.token !== null) {
      matches.push({ token: node.token, score: node.score });
    }
  }
  return matches;
}

// ============================================================================
// Normalizer helpers
// ============================================================================

function applyNormalizer(text: string, config: NormalizerConfig): string {
  switch (config.type) {
    case "BertNormalizer": {
      let result = text;
      if (config.lowercase !== false) result = result.toLowerCase();
      if (config.strip_accents !== false) {
        result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
      }
      return result;
    }
    case "Replace": {
      const pattern = config.pattern;
      if (pattern?.Regex) {
        const regex = new RegExp(pattern.Regex, "g");
        return text.replace(regex, config.content ?? "");
      }
      if (pattern?.String) {
        return text.replaceAll(pattern.String, config.content ?? "");
      }
      return text;
    }
    case "NFC":
      return text.normalize("NFC");
    case "NFD":
      return text.normalize("NFD");
    case "NFKC":
      return text.normalize("NFKC");
    case "NFKD":
      return text.normalize("NFKD");
    case "Strip": {
      let result = text;
      if (config.strip_left) result = result.trimStart();
      if (config.strip_right !== false) result = result.trimEnd();
      return result;
    }
    case "Lowercase":
      return text.toLowerCase();
    case "Sequence": {
      let result = text;
      if (config.normalizers) {
        for (const n of config.normalizers) {
          result = applyNormalizer(result, n);
        }
      }
      return result;
    }
    default:
      return text;
  }
}

// ============================================================================
// Unicode helpers
// ============================================================================

/**
 * Check if a character is Unicode punctuation (matches BERT's definition).
 * BERT considers ASCII punctuation + Unicode Punctuation categories (P*).
 */
function isUnicodePunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  // ASCII punctuation ranges
  if (
    (cp >= 33 && cp <= 47) ||   // ! " # $ % & ' ( ) * + , - . /
    (cp >= 58 && cp <= 64) ||   // : ; < = > ? @
    (cp >= 91 && cp <= 96) ||   // [ \ ] ^ _ `
    (cp >= 123 && cp <= 126)    // { | } ~
  ) {
    return true;
  }
  // Unicode punctuation categories: Pc, Pd, Ps, Pe, Pi, Pf, Po, Sk, Sc, So, Sm
  // Use a regex test for Unicode property escape
  return /^\p{P}$/u.test(ch);
}
