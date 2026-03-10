/**
 * Salience scoring — the dopamine and norepinephrine signals.
 *
 * Dopamine = importance: "this matters, consolidate it"
 * Norepinephrine = novelty/surprise: "this is unexpected, pay attention"
 *
 * Combined salience determines which memories get promoted to long-term
 * storage and which fade through decay.
 */

import type { LogEntry } from './log-parser.js';
import { makeEntry } from './log-parser.js';

// --- Interfaces ---

export interface SalienceScore {
  importance: number; // 0-1: dopamine signal
  novelty: number; // 0-1: norepinephrine signal
  combined: number; // 0-1: weighted combination
}

function computeScore(
  importance: number,
  novelty: number,
  importanceWeight = 0.7,
): SalienceScore {
  const noveltyWeight = 1.0 - importanceWeight;
  const combined = importance * importanceWeight + novelty * noveltyWeight;
  return {
    importance: round3(importance),
    novelty: round3(novelty),
    combined: round3(Math.min(1.0, combined)),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// --- Signal dictionaries ---

/** Importance signals — things that indicate HIGH dopamine. */
export const IMPORTANCE_SIGNALS: Record<string, number> = {
  // Critical
  'architectural decision': 0.9,
  'design decision': 0.9,
  'key decision': 0.9,
  'breaking change': 0.9,
  'security': 0.85,
  'root cause': 0.85,
  'blocked': 0.8,

  // High
  'bug': 0.7,
  'fix': 0.7,
  'pattern': 0.7,
  'convention': 0.7,
  'rule': 0.7,
  'initiative': 0.65,
  'milestone': 0.65,

  // Medium
  'decision': 0.6,
  'action item': 0.6,
  'created': 0.5,
  'updated': 0.5,
  'implemented': 0.5,

  // Low
  'meeting': 0.3,
  'discussed': 0.3,
  'mentioned': 0.2,
  'register': 0.2,
};

/** Novelty signals — things that indicate HIGH norepinephrine. */
export const NOVELTY_SIGNALS: Record<string, number> = {
  'breakthrough': 0.95,
  'insight': 0.9,
  'discovery': 0.9,
  'unexpected': 0.85,
  'surprise': 0.85,
  'first time': 0.8,
  'new': 0.6,
  'never': 0.6,
  'workaround': 0.7,
  'learned': 0.65,
  'realized': 0.65,
  'correction': 0.6,
  'changed': 0.4,
  'updated': 0.3,
};

// --- Public API ---

/**
 * Score a log entry's salience based on text signals.
 *
 * This is the rule-based scorer. The LLM-based scorer in the consolidation
 * skill provides richer judgment, but this gives a baseline.
 */
export function scoreEntry(entry: LogEntry): SalienceScore {
  const text = entry.fullText.toLowerCase();

  // Compute importance (dopamine)
  const importanceScores: number[] = [];
  for (const [signal, weight] of Object.entries(IMPORTANCE_SIGNALS)) {
    if (text.includes(signal)) importanceScores.push(weight);
  }
  let importance =
    importanceScores.length > 0 ? Math.max(...importanceScores) : 0.3;

  // Handovers are always important
  if (entry.entryType === 'handover') importance = Math.max(importance, 0.7);

  // Decisions are always important
  if (entry.entryType === 'decision') importance = Math.max(importance, 0.6);

  // Compute novelty (norepinephrine)
  const noveltyScores: number[] = [];
  for (const [signal, weight] of Object.entries(NOVELTY_SIGNALS)) {
    if (text.includes(signal)) noveltyScores.push(weight);
  }
  const novelty =
    noveltyScores.length > 0 ? Math.max(...noveltyScores) : 0.2;

  return computeScore(importance, novelty);
}

/** Score arbitrary text for salience. Used for entities extracted by LLM. */
export function scoreText(text: string): SalienceScore {
  const entry = makeEntry('', '', text, 'observation');
  return scoreEntry(entry);
}
