/**
 * Semantic embedding support for knowledge graph nodes.
 *
 * Lazy-loads @huggingface/transformers to avoid slowing CLI startup.
 * Falls back gracefully when dependencies aren't available.
 */

import type { KnowledgeGraph, Node } from "./graph.js";

export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

// Lazy-loaded singleton
let _pipeline: any = null;
let _loadFailed = false;

async function getPipeline(): Promise<any> {
  if (_pipeline !== null) return _pipeline;
  if (_loadFailed) return null;

  try {
    const { pipeline } = await import("@huggingface/transformers");
    _pipeline = await pipeline("feature-extraction", MODEL_NAME);
    return _pipeline;
  } catch {
    _loadFailed = true;
    return null;
  }
}

/** Check whether the embedding model can be loaded. */
export async function isAvailable(): Promise<boolean> {
  return (await getPipeline()) !== null;
}

/** Embed a single text string. Returns 384-dim float vector, or empty array on failure. */
export async function getEmbedding(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  if (!pipe) return [];

  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/** Batch embed multiple texts. More efficient than calling getEmbedding in a loop. */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const pipe = await getPipeline();
  if (!pipe || texts.length === 0) return [];

  const results: number[][] = [];
  // Process in batches to manage memory
  for (const text of texts) {
    const output = await pipe(text, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
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
  const pipe = await getPipeline();
  if (!pipe) return 0;

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
    const output = await pipe(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data as Float32Array);
    graph.upsertEmbedding(row.id, embedding);
  }

  return toEmbed.length;
}

/** Reset the cached pipeline (for testing). */
export function resetModel(): void {
  _pipeline = null;
  _loadFailed = false;
}
