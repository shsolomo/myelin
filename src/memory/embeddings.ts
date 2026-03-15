/**
 * Embeddings stub — local inference removed.
 *
 * Semantic search now uses FTS5 keywords as the primary path.
 * Embeddings may return as an optional enhancement in a future version.
 * This stub preserves the public API surface so callers continue to work.
 */

export const MODEL_NAME = "all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

/** No-op — model downloads removed. */
export async function ensureEmbeddingModel(): Promise<string | null> {
  return null;
}

/** Always returns false — local embeddings are no longer available. */
export async function isAvailable(): Promise<boolean> {
  return false;
}

/** Returns empty array — FTS5 keyword search is the primary search path. */
export async function getEmbedding(_text: string): Promise<number[]> {
  return [];
}

/** Returns empty array — FTS5 keyword search is the primary search path. */
export async function getEmbeddings(_texts: string[]): Promise<number[][]> {
  return [];
}

/** Returns false — local embeddings removed. */
export async function embedNode(_graph: any, _nodeId: string): Promise<boolean> {
  return false;
}

/** Returns 0 — local embeddings removed. */
export async function embedAllNodes(_graph: any, _category?: string, _force?: boolean): Promise<number> {
  return 0;
}

/** No-op — no model to reset. */
export function resetModel(): void {}

