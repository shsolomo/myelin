/**
 * Tests for salience.ts — the dopamine & norepinephrine scoring engine.
 *
 * Covers: scoreEntry, scoreText, signal matching, combined weighting, boundary conditions
 */

import { describe, it, expect } from 'vitest';
import {
  scoreEntry,
  scoreText,
  IMPORTANCE_SIGNALS,
  NOVELTY_SIGNALS,
} from '../../src/memory/salience.js';
import { makeEntry } from '../../src/memory/log-parser.js';

// ---------------------------------------------------------------------------
// Signal dictionaries
// ---------------------------------------------------------------------------

describe('signal dictionaries', () => {
  it('IMPORTANCE_SIGNALS has values in [0, 1]', () => {
    for (const [key, val] of Object.entries(IMPORTANCE_SIGNALS)) {
      expect(val, `${key}`).toBeGreaterThanOrEqual(0);
      expect(val, `${key}`).toBeLessThanOrEqual(1);
    }
  });

  it('NOVELTY_SIGNALS has values in [0, 1]', () => {
    for (const [key, val] of Object.entries(NOVELTY_SIGNALS)) {
      expect(val, `${key}`).toBeGreaterThanOrEqual(0);
      expect(val, `${key}`).toBeLessThanOrEqual(1);
    }
  });

  it('contains the highest-priority importance signals', () => {
    expect(IMPORTANCE_SIGNALS['architectural decision']).toBeGreaterThanOrEqual(0.9);
    expect(IMPORTANCE_SIGNALS['security']).toBeGreaterThanOrEqual(0.8);
    expect(IMPORTANCE_SIGNALS['root cause']).toBeGreaterThanOrEqual(0.8);
  });

  it('contains the highest-priority novelty signals', () => {
    expect(NOVELTY_SIGNALS['breakthrough']).toBeGreaterThanOrEqual(0.9);
    expect(NOVELTY_SIGNALS['insight']).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// scoreEntry
// ---------------------------------------------------------------------------

describe('scoreEntry', () => {
  it('returns a SalienceScore with importance, novelty, and combined', () => {
    const entry = makeEntry('2025-12-01', 'Test', 'Some content', 'observation');
    const score = scoreEntry(entry);
    expect(score).toHaveProperty('importance');
    expect(score).toHaveProperty('novelty');
    expect(score).toHaveProperty('combined');
  });

  it('scores high importance for architectural decisions', () => {
    const entry = makeEntry('2025-12-01', 'Design', 'Made an architectural decision to use SQLite.', 'decision');
    const score = scoreEntry(entry);
    expect(score.importance).toBeGreaterThanOrEqual(0.9);
  });

  it('scores high importance for security content', () => {
    const entry = makeEntry('2025-12-01', 'Alert', 'Found a security vulnerability in auth.', 'observation');
    const score = scoreEntry(entry);
    expect(score.importance).toBeGreaterThanOrEqual(0.8);
  });

  it('scores high novelty for breakthroughs', () => {
    const entry = makeEntry('2025-12-01', 'Wow', 'Breakthrough: the new approach is 10x faster.', 'observation');
    const score = scoreEntry(entry);
    expect(score.novelty).toBeGreaterThanOrEqual(0.9);
  });

  it('scores high novelty for unexpected discoveries', () => {
    const entry = makeEntry('2025-12-01', 'Surprise', 'Unexpected behavior: the cache invalidates itself.', 'observation');
    const score = scoreEntry(entry);
    expect(score.novelty).toBeGreaterThanOrEqual(0.8);
  });

  it('gives default importance of 0.3 when no signals match', () => {
    const entry = makeEntry('2025-12-01', 'Nothing special', 'The weather is nice.', 'observation');
    const score = scoreEntry(entry);
    expect(score.importance).toBe(0.3);
  });

  it('gives default novelty of 0.2 when no signals match', () => {
    const entry = makeEntry('2025-12-01', 'Nothing special', 'The weather is nice.', 'observation');
    const score = scoreEntry(entry);
    expect(score.novelty).toBe(0.2);
  });

  it('boosts importance for handover entries', () => {
    const entry = makeEntry('2025-12-01', 'Session Handover', 'Pending items for next session.', 'handover');
    const score = scoreEntry(entry);
    expect(score.importance).toBeGreaterThanOrEqual(0.7);
  });

  it('boosts importance for decision entries', () => {
    const entry = makeEntry('2025-12-01', 'Random note', 'Some random stuff.', 'decision');
    const score = scoreEntry(entry);
    expect(score.importance).toBeGreaterThanOrEqual(0.6);
  });

  it('uses case-insensitive signal matching', () => {
    const entry = makeEntry('2025-12-01', '', 'Found a BUG in the system.', 'observation');
    const score = scoreEntry(entry);
    expect(score.importance).toBeGreaterThanOrEqual(0.7);
  });

  it('combined is capped at 1.0', () => {
    const entry = makeEntry('2025-12-01', 'Critical', 'Architectural decision about security: breakthrough insight, root cause found.', 'decision');
    const score = scoreEntry(entry);
    expect(score.combined).toBeLessThanOrEqual(1.0);
  });

  it('combined uses 0.7*importance + 0.3*novelty weighting', () => {
    // Use a text with known signal matches
    const entry = makeEntry('2025-12-01', '', 'bug found, a new approach', 'observation');
    const score = scoreEntry(entry);
    const expected = Math.min(1.0, score.importance * 0.7 + score.novelty * 0.3);
    // Round to 3 decimal places for comparison
    expect(score.combined).toBeCloseTo(expected, 3);
  });

  it('takes the max importance signal when multiple match', () => {
    // 'bug' is 0.7, 'security' is 0.85 — should use 0.85
    const entry = makeEntry('2025-12-01', '', 'security bug in the auth layer', 'observation');
    const score = scoreEntry(entry);
    expect(score.importance).toBe(0.85);
  });

  it('takes the max novelty signal when multiple match', () => {
    // 'new' is 0.6, 'insight' is 0.9 — should use 0.9
    const entry = makeEntry('2025-12-01', '', 'new insight into the performance problem', 'observation');
    const score = scoreEntry(entry);
    expect(score.novelty).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// scoreText
// ---------------------------------------------------------------------------

describe('scoreText', () => {
  it('scores arbitrary text as an observation entry', () => {
    const score = scoreText('Found a critical security bug.');
    expect(score.importance).toBeGreaterThanOrEqual(0.7);
    expect(score.combined).toBeGreaterThan(0);
  });

  it('returns baseline scores for neutral text', () => {
    const score = scoreText('The weather is nice today.');
    expect(score.importance).toBe(0.3);
    expect(score.novelty).toBe(0.2);
  });

  it('handles empty string', () => {
    const score = scoreText('');
    expect(score.importance).toBe(0.3);
    expect(score.novelty).toBe(0.2);
    expect(score.combined).toBeGreaterThan(0);
  });
});
