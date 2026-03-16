/**
 * NER stub — local inference removed.
 *
 * Entity extraction now happens via the host LLM through the
 * myelin_sleep tool. This stub preserves the public API surface
 * so callers (extractors.ts) continue to work without changes.
 */

/** A single entity extracted by NER. */
export interface NEREntity {
  text: string;
  label: string;
  score: number;
  start: number;
  end: number;
}

/** Always returns false — local NER is no longer available. */
export function isAvailable(): boolean {
  return false;
}

/** Returns empty array — use LLM extraction via myelin_sleep instead. */
export async function extractEntities(
  _text?: string,
  _labels?: string[],
  _threshold?: number,
): Promise<NEREntity[]> {
  return [];
}

/** No-op — model downloads removed. */
export async function ensureGlinerModel(): Promise<string | null> {
  return null;
}

/** No-op — no model to reset. */
export function resetModel(): void {}

