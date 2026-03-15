/**
 * Semantic embedding support for knowledge graph nodes.
 *
 * Uses onnxruntime-node directly with a custom WordPiece tokenizer for
 * all-MiniLM-L6-v2 inference. No @huggingface/transformers dependency.
 *
 * Lazy-loads on first call. Falls back gracefully when model files or
 * dependencies aren't available.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { KnowledgeGraph, Node } from "./graph.js";
import { loadTokenizer, type Tokenizer } from "./tokenizer.js";

export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

const EMBEDDING_CACHE_DIR = join(homedir(), ".cache", "myelin", "models", "embeddings");
const HF_BASE_URL = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";
const MODEL_FILES = [
  { remote: "onnx/model.onnx", local: "model.onnx" },
  { remote: "tokenizer.json", local: "tokenizer.json" },
];

// ---------------------------------------------------------------------------
// Module-level cache (lazy-loaded)
// ---------------------------------------------------------------------------

interface EmbeddingSession {
  session: import("onnxruntime-node").InferenceSession;
  tokenizer: Tokenizer;
}

let _session: EmbeddingSession | null = null;
let _loadFailed = false;

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

/**
 * Ensure the embedding ONNX model files are downloaded from HuggingFace.
 * Downloads to ~/.cache/myelin/models/embeddings/ on first run.
 * Returns the model directory path, or null if download fails.
 */
export async function ensureEmbeddingModel(): Promise<string | null> {
  const modelPath = join(EMBEDDING_CACHE_DIR, "model.onnx");
  if (existsSync(modelPath)) return EMBEDDING_CACHE_DIR;

  try {
    mkdirSync(EMBEDDING_CACHE_DIR, { recursive: true });
    for (const file of MODEL_FILES) {
      const url = HF_BASE_URL + "/" + file.remote;
      const destPath = join(EMBEDDING_CACHE_DIR, file.local);
      if (existsSync(destPath)) continue;

      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to download " + file.remote + ": " + response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(destPath, buffer);
    }
    return EMBEDDING_CACHE_DIR;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lazy loading
// ---------------------------------------------------------------------------

async function getSession(): Promise<EmbeddingSession | null> {
  if (_session !== null) return _session;
  if (_loadFailed) return null;

  const modelDir = await ensureEmbeddingModel();
  if (modelDir === null) {
    _loadFailed = true;
    return null;
  }

  try {
    const ort = await import("onnxruntime-node");

    const session = await ort.InferenceSession.create(
      join(modelDir, "model.onnx"),
      { executionProviders: ["cpu"] },
    );

    const tokenizer = await loadTokenizer(join(modelDir, "tokenizer.json"));

    _session = { session, tokenizer };
    return _session;
  } catch {
    _loadFailed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

/**
 * Run a single embedding inference.
 * Tokenizes the text, runs ONNX model, mean-pools, and L2-normalizes.
 */
async function runEmbedding(
  es: EmbeddingSession,
  text: string,
): Promise<number[]> {
  const ort = await import("onnxruntime-node");

  // Tokenize with special tokens ([CLS] ... [SEP])
  const tokenIds = es.tokenizer.encode(text, { addSpecialTokens: true });
  const seqLen = tokenIds.length;

  // Build tensors
  const inputIds = new BigInt64Array(tokenIds.map(BigInt));
  const attentionMask = new BigInt64Array(seqLen).fill(1n);
  const tokenTypeIds = new BigInt64Array(seqLen).fill(0n);

  const feeds: Record<string, import("onnxruntime-node").Tensor> = {
    input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, seqLen]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, seqLen]),
  };

  // Run inference
  const results = await es.session.run(feeds);

  // Output shape: [1, seqLen, 384]
  const output = results.last_hidden_state ?? results.token_embeddings ?? Object.values(results)[0];
  const data = output.data as Float32Array;

  // Mean pooling (masked by attention — all 1s here, but correct pattern)
  const embedding = new Float64Array(EMBEDDING_DIM);
  for (let t = 0; t < seqLen; t++) {
    const offset = t * EMBEDDING_DIM;
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      embedding[d] += data[offset + d];
    }
  }
  for (let d = 0; d < EMBEDDING_DIM; d++) {
    embedding[d] /= seqLen;
  }

  // L2 normalize
  let norm = 0;
  for (let d = 0; d < EMBEDDING_DIM; d++) {
    norm += embedding[d] * embedding[d];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      embedding[d] /= norm;
    }
  }

  return Array.from(embedding);
}

// ---------------------------------------------------------------------------
// Public API (unchanged from original)
// ---------------------------------------------------------------------------

/** Check whether the embedding model can be loaded. */
export async function isAvailable(): Promise<boolean> {
  return (await getSession()) !== null;
}

/** Embed a single text string. Returns 384-dim float vector, or empty array on failure. */
export async function getEmbedding(text: string): Promise<number[]> {
  const es = await getSession();
  if (!es) return [];

  try {
    return await runEmbedding(es, text);
  } catch {
    return [];
  }
}

/** Batch embed multiple texts. More efficient than calling getEmbedding in a loop. */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const es = await getSession();
  if (!es || texts.length === 0) return [];

  const results: number[][] = [];
  for (const text of texts) {
    try {
      results.push(await runEmbedding(es, text));
    } catch {
      results.push([]);
    }
  }
  return results;
}

/** Embed a single node's name+description and store in graph. */
export async function embedNode(
  graph: KnowledgeGraph,
  nodeId: string,
): Promise<boolean> {
  const node = graph.getNode(nodeId);
  if (!node) return false;

  const text = node.description
    ? `${node.name}. ${node.description}`
    : node.name;
  const embedding = await getEmbedding(text);
  if (embedding.length === 0) return false;

  graph.upsertEmbedding(nodeId, embedding);
  return true;
}

/** Batch embed all nodes. Skip already-embedded unless force=true. Returns count embedded. */
export async function embedAllNodes(
  graph: KnowledgeGraph,
  category?: string,
  force = false,
): Promise<number> {
  const es = await getSession();
  if (!es) return 0;

  // Build query for nodes
  let query = "SELECT id, name, description FROM nodes";
  const params: any[] = [];

  if (category) {
    query += " WHERE category = ?";
    params.push(category);
  }

  const rows = graph.db.prepare(query).all(...params) as Array<{
    id: string;
    name: string;
    description: string;
  }>;
  if (rows.length === 0) return 0;

  // Filter out already-embedded unless force
  const toEmbed = force
    ? rows
    : rows.filter((r) => !graph.hasEmbedding(r.id));
  if (toEmbed.length === 0) return 0;

  // Embed and store
  for (const row of toEmbed) {
    const text = row.description
      ? `${row.name}. ${row.description}`
      : row.name;
    try {
      const embedding = await runEmbedding(es, text);
      graph.upsertEmbedding(row.id, embedding);
    } catch {
      // Skip nodes that fail to embed — don't block the batch
      continue;
    }
  }

  return toEmbed.length;
}

/** Reset the cached session (for testing). */
export function resetModel(): void {
  _session = null;
  _loadFailed = false;
}
