/**
 * Zero-shot NER via GLiNER — replaces regex-based entity extraction.
 *
 * Lazy-loads the model on first call to avoid import-time downloads.
 * Falls back gracefully when dependencies aren't installed.
 *
 * Two fallback paths are attempted:
 * 1. @huggingface/transformers (transformers.js with GLiNER support)
 * 2. onnxruntime-node with a pre-exported ONNX model
 *
 * If neither is available, isAvailable() returns false and extractEntities
 * returns empty arrays — callers should use the regex fallback.
 */

import { NER_LABELS } from "./vocabulary.js";

/** A single entity extracted by NER. */
export interface NEREntity {
  text: string;
  label: string;
  score: number;
  start: number;
  end: number;
}

// Module-level model cache (lazy-loaded)
let _pipeline: any = null;
let _loadFailed = false;

async function loadPipeline(): Promise<any> {
  if (_pipeline !== null) return _pipeline;
  if (_loadFailed) return null;

  // Path 1: Try @huggingface/transformers (transformers.js)
  try {
    const transformers = await import("@huggingface/transformers");
    _pipeline = await (transformers as any).pipeline(
      "token-classification",
      "urchade/gliner_small-v2.1",
    );
    return _pipeline;
  } catch {
    // transformers.js unavailable or GLiNER model not supported
  }

  // Path 2: Try onnxruntime-node with pre-exported ONNX model
  try {
    await import("onnxruntime-node");
    // TODO: Wire up ONNX model loading when model file is available.
    // For MVP, fall through to unavailable state.
  } catch {
    // onnxruntime-node not installed
  }

  _loadFailed = true;
  return null;
}

/** Check whether the NER model can be loaded. */
export function isAvailable(): boolean {
  return _pipeline !== null;
}

/**
 * Extract named entities from text using zero-shot NER.
 *
 * @param text      The input text to analyse.
 * @param labels    Entity labels to detect. Defaults to NER_LABELS.
 * @param threshold Minimum confidence score (0–1). Default 0.3.
 * @returns         NEREntity instances sorted by position, or [] if unavailable.
 */
export async function extractEntities(
  text: string,
  labels?: string[],
  threshold = 0.3,
): Promise<NEREntity[]> {
  const pipe = await loadPipeline();
  if (!pipe) return [];

  if (!text.trim()) return [];

  const effectiveLabels = labels ?? NER_LABELS;

  try {
    const raw: Array<{
      text: string;
      label: string;
      score: number;
      start: number;
      end: number;
    }> = await pipe(text, { labels: effectiveLabels, threshold });

    const entities: NEREntity[] = raw.map((ent) => ({
      text: ent.text,
      label: ent.label,
      score: Math.round(ent.score * 10_000) / 10_000,
      start: ent.start,
      end: ent.end,
    }));

    entities.sort((a, b) => a.start - b.start);
    return entities;
  } catch {
    return [];
  }
}

/** Reset the cached model (useful for testing). */
export function resetModel(): void {
  _pipeline = null;
  _loadFailed = false;
}
