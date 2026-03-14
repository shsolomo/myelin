/**
 * Tests for heartbeat-migration.ts — heartbeat memory.md import tool.
 *
 * Covers:
 * - Parsing of ## Corrected and ## Learned sections
 * - Date extraction (corrected, learned, reinforced)
 * - Node creation with correct type and salience
 * - Duplicate detection / skipping
 * - Edge cases: empty file, no sections, mixed content
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph, NodeType } from '../../src/memory/graph.js';
import {
  parseHeartbeatMemory,
  migrateHeartbeatToGraph,
  entryToId,
  learnedSalience,
} from '../../src/memory/heartbeat-migration.js';

let graph: KnowledgeGraph;

beforeEach(() => {
  graph = new KnowledgeGraph(':memory:');
});

afterEach(() => {
  graph.close();
});

// ---------------------------------------------------------------------------
// parseHeartbeatMemory
// ---------------------------------------------------------------------------

describe('parseHeartbeatMemory', () => {
  it('parses corrected entries with dates', () => {
    const content = `## Corrected
- Prefer tabs over spaces in JS - *corrected: 2026-03-11*
- Always use strict mode - *corrected: 2026-03-10*
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      text: 'Prefer tabs over spaces in JS',
      kind: 'corrected',
      date: '2026-03-11',
      reinforcedDate: undefined,
    });
    expect(entries[1]).toEqual({
      text: 'Always use strict mode',
      kind: 'corrected',
      date: '2026-03-10',
      reinforcedDate: undefined,
    });
  });

  it('parses learned entries with dates', () => {
    const content = `## Learned
- Deploy pipeline: staging -> canary -> prod - *learned: 2026-03-04*
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      text: 'Deploy pipeline: staging -> canary -> prod',
      kind: 'learned',
      date: '2026-03-04',
      reinforcedDate: undefined,
    });
  });

  it('parses learned entries with reinforced dates', () => {
    const content = `## Learned
- Deploy pipeline: staging -> canary -> prod - *learned: 2026-03-04, reinforced: 2026-03-11*
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].reinforcedDate).toBe('2026-03-11');
    expect(entries[0].date).toBe('2026-03-04');
  });

  it('parses both sections in one document', () => {
    const content = `# Memory

## Corrected
- Use const over let - *corrected: 2026-03-10*

## Learned
- Redis caching best practices - *learned: 2026-03-05, reinforced: 2026-03-12*
- API versioning strategy - *learned: 2026-03-08*
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe('corrected');
    expect(entries[1].kind).toBe('learned');
    expect(entries[2].kind).toBe('learned');
  });

  it('stops parsing section at next ## heading', () => {
    const content = `## Corrected
- Rule one - *corrected: 2026-03-10*

## Other Section
- This should not be parsed

## Learned
- Fact one - *learned: 2026-03-05*
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('corrected');
    expect(entries[1].kind).toBe('learned');
  });

  it('handles entries without date metadata', () => {
    const content = `## Corrected
- Some undated correction
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Some undated correction');
    // Should still have a date (defaults to today)
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles empty content', () => {
    const entries = parseHeartbeatMemory('');
    expect(entries).toHaveLength(0);
  });

  it('handles content with no recognized sections', () => {
    const content = `# Memory

## About
- Just some info

## Details
- More info
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(0);
  });

  it('ignores non-bullet lines within sections', () => {
    const content = `## Corrected

Some descriptive paragraph here.

- Actual entry - *corrected: 2026-03-10*

Another paragraph.
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Actual entry');
  });

  it('handles bare date format without asterisks', () => {
    const content = `## Corrected
- Use ESM imports - corrected: 2026-03-11
`;
    const entries = parseHeartbeatMemory(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-03-11');
  });
});

// ---------------------------------------------------------------------------
// entryToId
// ---------------------------------------------------------------------------

describe('entryToId', () => {
  it('converts text to kebab-case', () => {
    expect(entryToId('Prefer tabs over spaces')).toBe('prefer-tabs-over-spaces');
  });

  it('strips special characters', () => {
    expect(entryToId('staging -> canary -> prod')).toBe('staging-canary-prod');
  });

  it('truncates to 40 chars', () => {
    const long = 'this is a very long entry text that exceeds the forty character limit';
    expect(entryToId(long).length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// learnedSalience
// ---------------------------------------------------------------------------

describe('learnedSalience', () => {
  it('returns higher salience for recent entries', () => {
    const today = new Date().toISOString().slice(0, 10);
    const salience = learnedSalience(today);
    expect(salience).toBeGreaterThanOrEqual(0.7);
  });

  it('returns lower salience for old entries', () => {
    const salience = learnedSalience('2020-01-01');
    expect(salience).toBe(0.5); // Floor
  });

  it('adds bonus for reinforced entries', () => {
    const today = new Date().toISOString().slice(0, 10);
    const without = learnedSalience(today);
    const withReinforced = learnedSalience(today, today);
    expect(withReinforced).toBeGreaterThan(without);
  });

  it('caps at 0.9', () => {
    const today = new Date().toISOString().slice(0, 10);
    const salience = learnedSalience(today, today);
    expect(salience).toBeLessThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// migrateHeartbeatToGraph
// ---------------------------------------------------------------------------

describe('migrateHeartbeatToGraph', () => {
  it('imports corrected entries as Rule nodes with salience 0.9', () => {
    const content = `## Corrected
- Always use strict mode in TypeScript - *corrected: 2026-03-11*
`;
    const result = migrateHeartbeatToGraph(graph, content);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const node = graph.getNode(entryToId('Always use strict mode in TypeScript'));
    expect(node).not.toBeNull();
    expect(node!.type).toBe(NodeType.Rule);
    expect(node!.salience).toBe(0.9);
  });

  it('imports learned entries as Concept nodes', () => {
    const content = `## Learned
- Redis caching patterns for high throughput - *learned: 2026-03-05*
`;
    const result = migrateHeartbeatToGraph(graph, content);
    expect(result.imported).toBe(1);

    const node = graph.getNode(entryToId('Redis caching patterns for high throughput'));
    expect(node).not.toBeNull();
    expect(node!.type).toBe(NodeType.Concept);
  });

  it('sets lastReinforced from reinforced date', () => {
    const content = `## Learned
- API versioning strategy - *learned: 2026-03-04, reinforced: 2026-03-11*
`;
    migrateHeartbeatToGraph(graph, content);

    const node = graph.getNode(entryToId('API versioning strategy'));
    expect(node).not.toBeNull();
    expect(node!.lastReinforced).toContain('2026-03-11');
  });

  it('sets createdAt from entry date', () => {
    const content = `## Corrected
- Use const not let - *corrected: 2026-03-10*
`;
    migrateHeartbeatToGraph(graph, content);

    const node = graph.getNode(entryToId('Use const not let'));
    expect(node).not.toBeNull();
    expect(node!.createdAt).toContain('2026-03-10');
  });

  it('skips duplicates on second import', () => {
    const content = `## Corrected
- Unique rule entry - *corrected: 2026-03-10*
`;
    const first = migrateHeartbeatToGraph(graph, content);
    expect(first.imported).toBe(1);
    expect(first.skipped).toBe(0);

    const second = migrateHeartbeatToGraph(graph, content);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('tags nodes with heartbeat and kind', () => {
    const content = `## Corrected
- Tag test entry - *corrected: 2026-03-10*
`;
    migrateHeartbeatToGraph(graph, content);

    const node = graph.getNode(entryToId('Tag test entry'));
    expect(node).not.toBeNull();
    const tags = graph.getTags(node!.id);
    expect(tags).toContain('heartbeat');
    expect(tags).toContain('corrected');
  });

  it('handles empty content', () => {
    const result = migrateHeartbeatToGraph(graph, '');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it('imports multiple entries from both sections', () => {
    const content = `## Corrected
- Rule one - *corrected: 2026-03-10*
- Rule two - *corrected: 2026-03-11*

## Learned
- Fact one - *learned: 2026-03-04*
- Fact two - *learned: 2026-03-05, reinforced: 2026-03-12*
`;
    const result = migrateHeartbeatToGraph(graph, content);
    expect(result.imported).toBe(4);
    expect(result.entries).toHaveLength(4);
  });

  it('uses custom sourceAgent and namespace', () => {
    const content = `## Corrected
- Custom agent test - *corrected: 2026-03-10*
`;
    migrateHeartbeatToGraph(graph, content, {
      sourceAgent: 'donna',
      namespace: 'genesis',
    });

    const node = graph.getNode(entryToId('Custom agent test'));
    expect(node).not.toBeNull();
    expect(node!.sourceAgent).toBe('donna');
  });
});
