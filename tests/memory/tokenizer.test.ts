import { describe, it, expect, beforeAll } from "vitest";
import { loadTokenizer, type Tokenizer } from "../../src/memory/tokenizer.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// WordPiece tokenizer tests (all-MiniLM-L6-v2)
// ---------------------------------------------------------------------------

describe("WordPiece tokenizer", () => {
  let tokenizer: Tokenizer;

  // Primary: committed fixture (always available, including CI)
  const fixturePath = join(process.cwd(), "tests", "fixtures", "wordpiece-tokenizer.json");
  // Fallbacks: local cache locations (dev machines only)
  const hfCachePath = join(
    homedir(),
    ".cache",
    "huggingface",
    "hub",
    "models--sentence-transformers--all-MiniLM-L6-v2",
    "snapshots",
    "c9745ed1d9f207416be6d2e6f8de32d1f16199bf",
    "tokenizer.json",
  );
  const myelinCachePath = join(
    homedir(),
    ".cache",
    "myelin",
    "models",
    "embeddings",
    "tokenizer.json",
  );

  beforeAll(async () => {
    const path = existsSync(fixturePath)
      ? fixturePath
      : existsSync(hfCachePath)
        ? hfCachePath
        : existsSync(myelinCachePath)
          ? myelinCachePath
          : null;
    if (!path) {
      throw new Error(
        "WordPiece tokenizer.json not found. Expected at tests/fixtures/wordpiece-tokenizer.json",
      );
    }
    tokenizer = await loadTokenizer(path);
  });

  it("loads vocabulary with expected size", () => {
    // Standard BERT vocab has 30,522 entries + added tokens
    expect(tokenizer.vocab.size).toBeGreaterThanOrEqual(30522);
  });

  it("special token lookups", () => {
    expect(tokenizer.tokenToId("[PAD]")).toBe(0);
    expect(tokenizer.tokenToId("[UNK]")).toBe(100);
    expect(tokenizer.tokenToId("[CLS]")).toBe(101);
    expect(tokenizer.tokenToId("[SEP]")).toBe(102);
    expect(tokenizer.tokenToId("[MASK]")).toBe(103);
  });

  it("vocab map access works", () => {
    expect(tokenizer.vocab.get("[CLS]")).toBe(101);
    expect(tokenizer.vocab.get("[SEP]")).toBe(102);
  });

  it("tokenToId and idToToken round-trip", () => {
    const id = tokenizer.tokenToId("hello");
    expect(id).toBeDefined();
    expect(tokenizer.idToToken(id!)).toBe("hello");
  });

  it("basic tokenization with special tokens", () => {
    const ids = tokenizer.encode("hello world");
    // Should start with [CLS]=101 and end with [SEP]=102
    expect(ids[0]).toBe(101);
    expect(ids[ids.length - 1]).toBe(102);
    expect(ids.length).toBeGreaterThan(2); // at least [CLS] + tokens + [SEP]
  });

  it("without special tokens omits CLS/SEP", () => {
    const withSpecial = tokenizer.encode("hello world", { addSpecialTokens: true });
    const without = tokenizer.encode("hello world", { addSpecialTokens: false });
    // Without should be 2 tokens shorter (no CLS/SEP)
    expect(without.length).toBe(withSpecial.length - 2);
    // And should not start with CLS or end with SEP
    expect(without[0]).not.toBe(101);
    expect(without[without.length - 1]).not.toBe(102);
  });

  it("case normalization: Hello and hello produce same tokens", () => {
    const upper = tokenizer.encode("Hello");
    const lower = tokenizer.encode("hello");
    expect(upper).toEqual(lower);
  });

  it("subword splitting for uncommon words", () => {
    const ids = tokenizer.encode("tokenization", { addSpecialTokens: false });
    // Should be split into subwords (more than 1 token)
    expect(ids.length).toBeGreaterThan(1);
    // All tokens should be valid (not UNK)
    for (const id of ids) {
      expect(id).not.toBe(100); // [UNK]
    }
  });

  it("punctuation handling", () => {
    const ids = tokenizer.encode("hello, world!", { addSpecialTokens: false });
    // Punctuation should be separate tokens
    expect(ids.length).toBeGreaterThan(2); // hello + , + world + !
  });

  it("empty string produces only special tokens", () => {
    const ids = tokenizer.encode("");
    // Should have [CLS] and [SEP] only
    expect(ids).toEqual([101, 102]);
  });

  it("empty string without special tokens produces empty array", () => {
    const ids = tokenizer.encode("", { addSpecialTokens: false });
    expect(ids).toEqual([]);
  });

  it("handles accented characters via stripping", () => {
    const withAccent = tokenizer.encode("café");
    const withoutAccent = tokenizer.encode("cafe");
    // After BertNormalizer strips accents, these should be the same
    expect(withAccent).toEqual(withoutAccent);
  });

  it("known token 'the' gets single ID", () => {
    const ids = tokenizer.encode("the", { addSpecialTokens: false });
    expect(ids.length).toBe(1);
    expect(ids[0]).toBe(tokenizer.tokenToId("the"));
  });
});

// ---------------------------------------------------------------------------
// Unigram tokenizer tests (GLiNER DeBERTa v2)
// ---------------------------------------------------------------------------

describe("Unigram tokenizer", () => {
  let tokenizer: Tokenizer;
  const unigramPath = join(process.cwd(), "models", "gliner", "tokenizer.json");

  beforeAll(async () => {
    if (!existsSync(unigramPath)) {
      throw new Error("GLiNER tokenizer.json not found at " + unigramPath);
    }
    tokenizer = await loadTokenizer(unigramPath);
  });

  it("loads vocabulary with expected size", () => {
    // GLiNER DeBERTa v2 has 128,000 vocab entries + added tokens
    expect(tokenizer.vocab.size).toBeGreaterThanOrEqual(128000);
  });

  it("special token lookups", () => {
    expect(tokenizer.tokenToId("[PAD]")).toBe(0);
    expect(tokenizer.tokenToId("[CLS]")).toBe(1);
    expect(tokenizer.tokenToId("[SEP]")).toBe(2);
    expect(tokenizer.tokenToId("[UNK]")).toBe(3);
    expect(tokenizer.tokenToId("[MASK]")).toBe(128000);
    expect(tokenizer.tokenToId("[FLERT]")).toBe(128001);
    expect(tokenizer.tokenToId("<<ENT>>")).toBe(128002);
    expect(tokenizer.tokenToId("<<SEP>>")).toBe(128003);
  });

  it("vocab map access for GLiNER-specific tokens", () => {
    expect(tokenizer.vocab.get("<<ENT>>")).toBe(128002);
    expect(tokenizer.vocab.get("<<SEP>>")).toBe(128003);
  });

  it("basic tokenization of simple words", () => {
    const ids = tokenizer.encode("hello world", { addSpecialTokens: false });
    expect(ids.length).toBeGreaterThan(0);
    // All tokens should be valid (not UNK=3)
    for (const id of ids) {
      expect(id).not.toBe(3);
    }
  });

  it("addSpecialTokens: false works correctly", () => {
    const withSpecial = tokenizer.encode("hello", { addSpecialTokens: true });
    const without = tokenizer.encode("hello", { addSpecialTokens: false });
    // With special tokens should wrap with [CLS]=1 and [SEP]=2
    expect(withSpecial[0]).toBe(1);
    expect(withSpecial[withSpecial.length - 1]).toBe(2);
    // Without should not have them
    expect(without[0]).not.toBe(1);
    expect(without.length).toBe(withSpecial.length - 2);
  });

  it("metaspace handling: spaces become ▁ prefix", () => {
    // The tokenizer should produce tokens that start with ▁ for word boundaries
    const ids = tokenizer.encode("hello world", { addSpecialTokens: false });
    expect(ids.length).toBeGreaterThan(0);
    // Should be deterministic
    const ids2 = tokenizer.encode("hello world", { addSpecialTokens: false });
    expect(ids).toEqual(ids2);
  });

  it("NFC normalization applied", () => {
    // é (U+00E9) and e + combining accent (U+0065 U+0301) should normalize
    const nfc = tokenizer.encode("caf\u00E9", { addSpecialTokens: false });
    const nfd = tokenizer.encode("cafe\u0301", { addSpecialTokens: false });
    expect(nfc).toEqual(nfd);
  });

  it("whitespace normalization: tabs and newlines become spaces", () => {
    const withTabs = tokenizer.encode("hello\tworld", { addSpecialTokens: false });
    const withSpace = tokenizer.encode("hello world", { addSpecialTokens: false });
    expect(withTabs).toEqual(withSpace);
  });

  it("tokenToId and idToToken round-trip", () => {
    const id = tokenizer.tokenToId("▁hello");
    if (id !== undefined) {
      expect(tokenizer.idToToken(id)).toBe("▁hello");
    }
    // At least special tokens should round-trip
    expect(tokenizer.idToToken(128002)).toBe("<<ENT>>");
  });

  it("encodes NER label text correctly", () => {
    // This matches how ner.ts uses the tokenizer for encoding labels
    const ids = tokenizer.encode("person", { addSpecialTokens: false });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
    }
  });
});
