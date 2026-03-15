/**
 * Zero-shot NER via GLiNER ONNX  pure TypeScript inference.
 *
 * Uses onnxruntime-node for model inference and @huggingface/transformers
 * for DeBERTa v2 tokenization. No Python dependency at runtime.
 *
 * The ONNX model is pre-exported from urchade/gliner_small-v2.1 and lives
 * in models/gliner/. See scripts/export-gliner.py for the export process.
 *
 * Lazy-loads on first call. If model files or dependencies are missing,
 * isAvailable() returns false and extractEntities returns []  callers
 * should fall back to the regex path.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NER_LABELS } from "./vocabulary.js";

/** A single entity extracted by NER. */
export interface NEREntity {
  text: string;
  label: string;
  score: number;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_WIDTH = 12;
const WORD_REGEX = /\w+(?:[-_]\w+)*|\S/g;

const GLINER_MODEL_ID = 'shsolo/gliner-small-v2.1-onnx';
const GLINER_CACHE_DIR = join(homedir(), '.cache', 'myelin', 'models', 'gliner');
const HF_BASE_URL = 'https://huggingface.co/' + GLINER_MODEL_ID + '/resolve/main';
const MODEL_FILES = ['model.onnx', 'tokenizer.json', 'gliner_config.json', 'tokenizer_config.json'];

// ---------------------------------------------------------------------------
// Module-level cache (lazy-loaded)
// ---------------------------------------------------------------------------

interface GlinerSession {
  session: import("onnxruntime-node").InferenceSession;
  tokenizer: any; // AutoTokenizer from @huggingface/transformers
  entTokenId: number;
  sepMarkerId: number;
  clsTokenId: number;
  sepTokenId: number;
}

let _gliner: GlinerSession | null = null;
let _loadFailed = false;

/**
 * Ensure the GLiNER ONNX model files are downloaded from HuggingFace.
 * Downloads to ~/.cache/myelin/models/gliner/ on first run.
 * Returns the model directory path, or null if download fails.
 */
export async function ensureGlinerModel(): Promise<string | null> {
  const modelPath = join(GLINER_CACHE_DIR, 'model.onnx');
  if (existsSync(modelPath)) return GLINER_CACHE_DIR;

  try {
    mkdirSync(GLINER_CACHE_DIR, { recursive: true });
    for (const file of MODEL_FILES) {
      const url = HF_BASE_URL + '/' + file;
      const destPath = join(GLINER_CACHE_DIR, file);
      if (existsSync(destPath)) continue;

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to download ' + file + ': ' + response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(destPath, buffer);
    }
    return GLINER_CACHE_DIR;
  } catch {
    return null;
  }
}

async function loadGliner(): Promise<GlinerSession | null> {
  if (_gliner !== null) return _gliner;
  if (_loadFailed) return null;

  const modelDir = await ensureGlinerModel();
  if (modelDir === null) {
    _loadFailed = true;
    return null;
  }

  try {
    const ort = await import("onnxruntime-node");
    const { AutoTokenizer } = await import("@huggingface/transformers");

    const session = await ort.InferenceSession.create(join(modelDir, "model.onnx"), {
      executionProviders: ["cpu"],
    });

    const tokenizer = await AutoTokenizer.from_pretrained(modelDir, {
      local_files_only: true,
    });

    // Resolve special token IDs from the vocabulary
    const vocab: Map<string, number> = tokenizer.model.tokens_to_ids;
    const entTokenId = vocab.get("<<ENT>>");
    const sepMarkerId = vocab.get("<<SEP>>");
    const clsTokenId = vocab.get("[CLS]");
    const sepTokenId = vocab.get("[SEP]");

    if (
      entTokenId === undefined ||
      sepMarkerId === undefined ||
      clsTokenId === undefined ||
      sepTokenId === undefined
    ) {
      throw new Error("Missing required special tokens in tokenizer vocabulary");
    }

    _gliner = { session, tokenizer, entTokenId, sepMarkerId, clsTokenId, sepTokenId };
    return _gliner;
  } catch {
    _loadFailed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

interface WordSplit {
  words: string[];
  positions: Array<[start: number, end: number]>;
}

/** Split text into words using the same regex as GLiNER's whitespace splitter. */
function splitWords(text: string): WordSplit {
  const words: string[] = [];
  const positions: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  WORD_REGEX.lastIndex = 0;
  while ((match = WORD_REGEX.exec(text)) !== null) {
    words.push(match[0]);
    positions.push([match.index, match.index + match[0].length]);
  }
  return { words, positions };
}

/**
 * Build the GLiNER input sequence.
 *
 * Format: [CLS] <<ENT>> label1_subtokens <<ENT>> label2_subtokens ... <<SEP>> word_subtokens... [SEP]
 *
 * Returns the token IDs and a mapping from word index  first subtoken position
 * in the input sequence (used for words_mask).
 */
function buildInputIds(
  words: string[],
  labels: string[],
  g: GlinerSession,
): { inputIds: number[]; wordSubtokenStarts: number[] } {
  const inputIds: number[] = [g.clsTokenId];

  // Entity label tokens
  for (const label of labels) {
    inputIds.push(g.entTokenId);
    const encoded: number[] = g.tokenizer.encode(label, {
      add_special_tokens: false,
    });
    inputIds.push(...encoded);
  }
  inputIds.push(g.sepMarkerId);

  // Text word tokens  track where each word starts
  const wordSubtokenStarts: number[] = [];
  for (const word of words) {
    wordSubtokenStarts.push(inputIds.length);
    const encoded: number[] = g.tokenizer.encode(word, {
      add_special_tokens: false,
    });
    inputIds.push(...encoded);
  }

  inputIds.push(g.sepTokenId);
  return { inputIds, wordSubtokenStarts };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function runInference(
  text: string,
  labels: string[],
  threshold: number,
  g: GlinerSession,
): Promise<NEREntity[]> {
  const ort = await import("onnxruntime-node");

  const { words, positions } = splitWords(text);
  const numWords = words.length;
  if (numWords === 0) return [];

  const { inputIds, wordSubtokenStarts } = buildInputIds(words, labels, g);
  const seqLen = inputIds.length;

  // Attention mask: all 1s
  const attentionMask = new Array(seqLen).fill(1);

  // Words mask: 1-indexed word number at each word's first subtoken
  const wordsMask = new Array(seqLen).fill(0);
  for (let w = 0; w < numWords; w++) {
    wordsMask[wordSubtokenStarts[w]] = w + 1;
  }

  // Span indices: every (start, end) word pair up to MAX_WIDTH, padded
  const totalSpans = numWords * MAX_WIDTH;
  const spanFlat: number[] = [];
  const spanMask: number[] = [];

  for (let s = 0; s < numWords; s++) {
    for (let w = 0; w < MAX_WIDTH; w++) {
      const e = s + w;
      if (e < numWords) {
        spanFlat.push(s, e);
        spanMask.push(1);
      } else {
        spanFlat.push(0, 0);
        spanMask.push(0);
      }
    }
  }

  // Build ONNX tensors
  const feeds: Record<string, import("onnxruntime-node").Tensor> = {
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(inputIds.map(BigInt)),
      [1, seqLen],
    ),
    attention_mask: new ort.Tensor(
      "int64",
      BigInt64Array.from(attentionMask.map(BigInt)),
      [1, seqLen],
    ),
    words_mask: new ort.Tensor(
      "int64",
      BigInt64Array.from(wordsMask.map(BigInt)),
      [1, seqLen],
    ),
    text_lengths: new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(numWords)]),
      [1, 1],
    ),
    span_idx: new ort.Tensor(
      "int64",
      BigInt64Array.from(spanFlat.map(BigInt)),
      [1, totalSpans, 2],
    ),
    span_mask: new ort.Tensor(
      "bool",
      Uint8Array.from(spanMask),
      [1, totalSpans],
    ),
  };

  // Run inference
  const results = await g.session.run(feeds);
  const logits = results.logits;
  const [, nW, mW, nL] = logits.dims;
  const logitsData = logits.data as Float32Array;

  // Decode logits  entities via sigmoid + threshold
  const entities: NEREntity[] = [];

  for (let s = 0; s < nW; s++) {
    for (let w = 0; w < mW; w++) {
      const e = s + w;
      if (e >= numWords) continue;

      for (let l = 0; l < nL; l++) {
        const idx = s * mW * nL + w * nL + l;
        const score = 1 / (1 + Math.exp(-logitsData[idx]));

        if (score > threshold) {
          entities.push({
            text: text.slice(positions[s][0], positions[e][1]),
            label: labels[l],
            score: Math.round(score * 10_000) / 10_000,
            start: positions[s][0],
            end: positions[e][1],
          });
        }
      }
    }
  }

  entities.sort((a, b) => a.start - b.start);
  return entities;
}

// ---------------------------------------------------------------------------
// Public API (unchanged from original)
// ---------------------------------------------------------------------------

/** Check whether the NER model can be loaded. */
export function isAvailable(): boolean {
  return _gliner !== null;
}

/**
 * Extract named entities from text using zero-shot NER.
 *
 * @param text      The input text to analyse.
 * @param labels    Entity labels to detect. Defaults to NER_LABELS.
 * @param threshold Minimum confidence score (01). Default 0.3.
 * @returns         NEREntity instances sorted by position, or [] if unavailable.
 */
export async function extractEntities(
  text: string,
  labels?: string[],
  threshold = 0.3,
): Promise<NEREntity[]> {
  const g = await loadGliner();
  if (!g) return [];
  if (!text.trim()) return [];

  const effectiveLabels = labels ?? NER_LABELS;

  try {
    return await runInference(text, effectiveLabels, threshold, g);
  } catch {
    return [];
  }
}

/** Reset the cached model (useful for testing). */
export function resetModel(): void {
  _gliner = null;
  _loadFailed = false;
}
