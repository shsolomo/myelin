/**
 * Tests for LLM-driven sleep tools: prepareSleep(), ingestExtractions(),
 * getWatermark(), setWatermark().
 * Covers issues #59 and #65.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph } from '../../src/memory/graph.js';
import {
  prepareSleep,
  ingestExtractions,
  getWatermark,
  setWatermark,
} from '../../src/memory/replay.js';

// Mock NER so extractFromEntry uses regex fallback (not needed directly, but avoids ONNX load)
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

// Mock structured-log's log directory to use our temp dir
const TEST_DIR = join(tmpdir(), `myelin-consol-tools-${Date.now()}`);
const AGENTS_DIR = join(TEST_DIR, 'agents');

vi.mock('../../src/memory/structured-log.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...original,
    readLogEntries: (agentName: string, options?: { sinceDate?: string }) => {
      const logFile = path.join(AGENTS_DIR, agentName, 'log.jsonl');
      if (!fs.existsSync(logFile)) return [];

      const raw = fs.readFileSync(logFile, 'utf-8').trim();
      if (!raw) return [];

      const entries: any[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const entry = {
            ts: data.ts,
            agent: data.agent ?? agentName,
            type: data.type,
            summary: data.summary,
            detail: data.detail ?? '',
            sessionId: data.sessionId ?? '',
            tags: data.tags ?? [],
            context: data.context ?? {},
          };
          if (options?.sinceDate && entry.ts.slice(0, 10) < options.sinceDate) continue;
          entries.push(entry);
        } catch { /* skip bad lines */ }
      }
      return entries;
    },
  };
});

/** Write test log entries to a mock agent log file. */
function writeTestLog(agentName: string, entries: object[]): void {
  const logDir = join(AGENTS_DIR, agentName);
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'log.jsonl');
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(logFile, lines, 'utf-8');
}

beforeEach(() => {
  mkdirSync(AGENTS_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// prepareSleep
// ---------------------------------------------------------------------------

describe('prepareSleep', () => {
  it('returns chunks from agent log entries', () => {
    writeTestLog('test-agent', [
      { ts: '2026-03-10T10:00:00Z', agent: 'test-agent', type: 'action', summary: 'Deployed service', detail: 'Released v2.1', tags: ['deploy'] },
      { ts: '2026-03-10T11:00:00Z', agent: 'test-agent', type: 'decision', summary: 'Chose PostgreSQL', detail: 'Over MySQL for JSON support', tags: ['database'] },
      { ts: '2026-03-10T12:00:00Z', agent: 'test-agent', type: 'finding', summary: 'Memory leak in auth', detail: 'Connection pool not closing', tags: ['bug'] },
    ]);

    const result = prepareSleep('test-agent');
    expect(result.agentName).toBe('test-agent');
    expect(result.totalEntries).toBe(3);
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0].entryCount).toBe(3);
    expect(result.chunks[0].text).toContain('Deployed service');
    expect(result.chunks[0].text).toContain('Chose PostgreSQL');
    expect(result.extractionPrompt).toContain('entities');
  });

  it('chunks entries by chunkSize', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-03-10T${String(i + 10).padStart(2, '0')}:00:00Z`,
      agent: 'chunky',
      type: 'observation',
      summary: `Entry ${i}`,
      detail: '',
      tags: [],
    }));
    writeTestLog('chunky', entries);

    const result = prepareSleep('chunky', { chunkSize: 3 });
    expect(result.totalEntries).toBe(10);
    expect(result.chunks.length).toBe(4); // 3 + 3 + 3 + 1
    expect(result.chunks[0].entryCount).toBe(3);
    expect(result.chunks[3].entryCount).toBe(1);
  });

  it('filters by sinceDate', () => {
    writeTestLog('dated-agent', [
      { ts: '2026-03-08T10:00:00Z', agent: 'dated-agent', type: 'action', summary: 'Old entry', detail: '', tags: [] },
      { ts: '2026-03-10T10:00:00Z', agent: 'dated-agent', type: 'action', summary: 'New entry', detail: '', tags: [] },
      { ts: '2026-03-11T10:00:00Z', agent: 'dated-agent', type: 'action', summary: 'Newest entry', detail: '', tags: [] },
    ]);

    const result = prepareSleep('dated-agent', { sinceDate: '2026-03-10' });
    expect(result.totalEntries).toBe(2);
    expect(result.chunks[0].text).not.toContain('Old entry');
    expect(result.chunks[0].text).toContain('New entry');
  });

  it('returns empty result for missing log', () => {
    const result = prepareSleep('nonexistent-agent');
    expect(result.totalEntries).toBe(0);
    expect(result.chunks).toHaveLength(0);
    expect(result.extractionPrompt).toBe('');
  });

  it('returns empty result for empty log', () => {
    const logDir = join(AGENTS_DIR, 'empty-agent');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'log.jsonl'), '', 'utf-8');

    const result = prepareSleep('empty-agent');
    expect(result.totalEntries).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('includes tags and detail in chunk text', () => {
    writeTestLog('detailed-agent', [
      { ts: '2026-03-10T10:00:00Z', agent: 'detailed-agent', type: 'decision', summary: 'Use Redis', detail: 'For session caching', tags: ['infrastructure', 'caching'] },
    ]);

    const result = prepareSleep('detailed-agent');
    expect(result.chunks[0].text).toContain('Use Redis');
    expect(result.chunks[0].text).toContain('For session caching');
    expect(result.chunks[0].text).toContain('infrastructure');
  });

  it('extraction prompt contains entity and relationship types', () => {
    writeTestLog('prompt-agent', [
      { ts: '2026-03-10T10:00:00Z', agent: 'prompt-agent', type: 'action', summary: 'Test entry', detail: '', tags: [] },
    ]);

    const result = prepareSleep('prompt-agent');
    expect(result.extractionPrompt).toContain('ENTITY TYPES');
    expect(result.extractionPrompt).toContain('RELATIONSHIP TYPES');
    expect(result.extractionPrompt).toContain('SALIENCE GUIDE');
  });
});

// ---------------------------------------------------------------------------
// ingestExtractions
// ---------------------------------------------------------------------------

describe('ingestExtractions', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('writes valid extraction to graph', () => {
    const extraction = JSON.stringify({
      entities: [
        { id: 'redis-cache', type: 'tool', name: 'Redis Cache', description: 'In-memory data store', salience: 0.7, tags: ['infrastructure'] },
        { id: 'auth-module', type: 'concept', name: 'Auth Module', description: 'JWT authentication system', salience: 0.8, tags: ['security'] },
      ],
      relationships: [
        { source: 'auth-module', target: 'redis-cache', relationship: 'depends_on', description: 'Auth uses Redis for session storage' },
      ],
    });

    const result = ingestExtractions(graph, [extraction], 'test-agent');
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);

    // Verify nodes exist in graph
    const redis = graph.getNode('redis-cache');
    expect(redis).not.toBeNull();
    expect(redis!.name).toBe('Redis Cache');

    const auth = graph.getNode('auth-module');
    expect(auth).not.toBeNull();
    expect(auth!.name).toBe('Auth Module');
  });

  it('reinforces existing nodes instead of duplicating', () => {
    // Pre-add a node
    graph.addNode({ id: 'redis-cache', name: 'Redis', description: 'Cache', salience: 0.5 });

    const extraction = JSON.stringify({
      entities: [
        { id: 'redis-cache', type: 'tool', name: 'Redis Cache', description: 'In-memory data store for caching', salience: 0.7, tags: [] },
      ],
      relationships: [],
    });

    const result = ingestExtractions(graph, [extraction], 'test-agent');
    expect(result.nodesReinforced).toBe(1);
    expect(result.nodesAdded).toBe(0);

    // Verify node was reinforced (salience boosted)
    const node = graph.getNode('redis-cache');
    expect(node!.salience).toBeGreaterThan(0.5);
  });

  it('handles multiple extractions', () => {
    const ext1 = JSON.stringify({
      entities: [
        { id: 'node-a', type: 'concept', name: 'Node A', description: 'First', salience: 0.5, tags: [] },
      ],
      relationships: [],
    });
    const ext2 = JSON.stringify({
      entities: [
        { id: 'node-b', type: 'concept', name: 'Node B', description: 'Second', salience: 0.6, tags: [] },
      ],
      relationships: [],
    });

    const result = ingestExtractions(graph, [ext1, ext2], 'test-agent');
    expect(result.nodesAdded).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    const result = ingestExtractions(graph, ['not valid json {}}}'], 'test-agent');
    // parseLlmExtraction handles bad JSON by returning empty extraction
    // So no nodes added but also no thrown errors
    expect(result.nodesAdded).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles mixed valid and invalid extractions', () => {
    const validExt = JSON.stringify({
      entities: [
        { id: 'valid-node', type: 'concept', name: 'Valid', description: 'Works', salience: 0.5, tags: [] },
      ],
      relationships: [],
    });

    const result = ingestExtractions(graph, [validExt, '{bad json'], 'test-agent');
    expect(result.nodesAdded).toBe(1);
    // Invalid JSON returns empty extraction (not an error)
    expect(graph.getNode('valid-node')).not.toBeNull();
  });

  it('sets namespace on new nodes', () => {
    const extraction = JSON.stringify({
      entities: [
        { id: 'namespaced', type: 'concept', name: 'Namespaced Node', description: 'Test', salience: 0.5, tags: [] },
      ],
      relationships: [],
    });

    ingestExtractions(graph, [extraction], 'hebb');

    // loadExtractionToGraph sets namespace to agent-{agentName}
    const nodes = graph.findNodes({ namespace: 'agent-hebb' });
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some(n => n.id === 'namespaced')).toBe(true);
  });

  it('skips edges where target node does not exist', () => {
    const extraction = JSON.stringify({
      entities: [
        { id: 'existing-node', type: 'concept', name: 'Exists', description: 'Present', salience: 0.5, tags: [] },
      ],
      relationships: [
        { source: 'existing-node', target: 'missing-node', relationship: 'depends_on', description: 'Edge to nowhere' },
      ],
    });

    const result = ingestExtractions(graph, [extraction], 'test-agent');
    expect(result.nodesAdded).toBe(1);
    // Edge should be skipped because 'missing-node' doesn't exist
    const edges = graph.getEdges('existing-node');
    expect(edges.filter(e => e.targetId === 'missing-node')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getWatermark / setWatermark
// ---------------------------------------------------------------------------

describe('getWatermark / setWatermark', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('returns null for new agent', () => {
    const wm = getWatermark(graph, 'never-slept');
    expect(wm).toBeNull();
  });

  it('round-trips a watermark', () => {
    setWatermark(graph, 'test-agent', '2026-03-15T10:00:00Z', 25);
    const wm = getWatermark(graph, 'test-agent');
    expect(wm).toBe('2026-03-15T10:00:00Z');
  });

  it('upserts and accumulates entries_processed', () => {
    setWatermark(graph, 'agent-a', '2026-03-14T10:00:00Z', 10);
    setWatermark(graph, 'agent-a', '2026-03-15T10:00:00Z', 5);

    const wm = getWatermark(graph, 'agent-a');
    expect(wm).toBe('2026-03-15T10:00:00Z');

    const row = graph.db
      .prepare('SELECT entries_processed FROM consolidation_state WHERE agent = ?')
      .get('agent-a') as { entries_processed: number };
    expect(row.entries_processed).toBe(15);
  });

  it('handles multiple agents independently', () => {
    setWatermark(graph, 'donna', '2026-03-15T08:00:00Z', 50);
    setWatermark(graph, 'hebb', '2026-03-15T09:00:00Z', 30);

    expect(getWatermark(graph, 'donna')).toBe('2026-03-15T08:00:00Z');
    expect(getWatermark(graph, 'hebb')).toBe('2026-03-15T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// prepareSleep — watermark and .md log support
// ---------------------------------------------------------------------------

describe('prepareSleep watermark support', () => {
  it('result includes watermark field (null when no watermark set)', () => {
    writeTestLog('wm-agent', [
      { ts: '2026-03-15T10:00:00Z', agent: 'wm-agent', type: 'action', summary: 'Entry one', detail: '', tags: [] },
    ]);

    const result = prepareSleep('wm-agent');
    expect(result).toHaveProperty('watermark');
    expect(result.watermark).toBeNull();
  });

  it('filters entries past watermark when dbPath is provided', () => {
    writeTestLog('wm-filter', [
      { ts: '2026-03-14T10:00:00Z', agent: 'wm-filter', type: 'action', summary: 'Old entry', detail: '', tags: [] },
      { ts: '2026-03-15T10:00:00Z', agent: 'wm-filter', type: 'action', summary: 'At watermark', detail: '', tags: [] },
      { ts: '2026-03-16T10:00:00Z', agent: 'wm-filter', type: 'finding', summary: 'New entry', detail: '', tags: [] },
    ]);

    const dbPath = join(TEST_DIR, 'watermark-test.db');
    const graph = new KnowledgeGraph(dbPath);
    try {
      setWatermark(graph, 'wm-filter', '2026-03-15T10:00:00Z', 2);
    } finally {
      graph.close();
    }

    const result = prepareSleep('wm-filter', { dbPath });
    expect(result.watermark).toBe('2026-03-15T10:00:00Z');
    expect(result.totalEntries).toBe(1);
    expect(result.chunks[0].text).toContain('New entry');
    expect(result.chunks[0].text).not.toContain('Old entry');
    expect(result.chunks[0].text).not.toContain('At watermark');
  });

  it('chunkIndex returns only the specified chunk', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-03-15T${String(i + 10).padStart(2, '0')}:00:00Z`,
      agent: 'chunk-idx',
      type: 'observation',
      summary: `Entry ${i}`,
      detail: '',
      tags: [],
    }));
    writeTestLog('chunk-idx', entries);

    const result = prepareSleep('chunk-idx', { chunkSize: 3, chunkIndex: 1 });
    expect(result.totalEntries).toBe(10);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].entryCount).toBe(3);
    expect(result.chunks[0].text).toContain('Entry 3');
  });

  it('chunkIndex out of range returns empty chunks', () => {
    writeTestLog('chunk-oob', [
      { ts: '2026-03-15T10:00:00Z', agent: 'chunk-oob', type: 'action', summary: 'Only entry', detail: '', tags: [] },
    ]);

    const result = prepareSleep('chunk-oob', { chunkIndex: 99 });
    expect(result.totalEntries).toBe(1);
    expect(result.chunks).toHaveLength(0);
  });
});

describe('prepareSleep .md log support', () => {
  it('reads .md log entries', () => {
    const logDir = join(AGENTS_DIR, 'md-agent');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'log.md'), [
      '## 2026-03-14',
      '### Shipped the feature',
      'Deployed the new API endpoint with rate limiting.',
      '### Fixed the auth bug',
      'Token refresh was using stale cache. Cleared and retested.',
    ].join('\n'), 'utf-8');

    const result = prepareSleep('md-agent', { logsDir: AGENTS_DIR });
    expect(result.totalEntries).toBe(2);
    expect(result.chunks[0].text).toContain('Shipped the feature');
    expect(result.chunks[0].text).toContain('Fixed the auth bug');
  });

  it('merges .jsonl and .md entries sorted by date', () => {
    const logDir = join(AGENTS_DIR, 'merge-agent');
    mkdirSync(logDir, { recursive: true });

    // Write JSONL entries
    writeTestLog('merge-agent', [
      { ts: '2026-03-15T10:00:00Z', agent: 'merge-agent', type: 'action', summary: 'JSONL entry', detail: '', tags: [] },
    ]);

    // Write .md entries (earlier date)
    writeFileSync(join(logDir, 'log.md'), [
      '## 2026-03-14',
      '### Markdown entry from yesterday',
      'This was logged in the old .md format.',
    ].join('\n'), 'utf-8');

    const result = prepareSleep('merge-agent', { logsDir: AGENTS_DIR });
    expect(result.totalEntries).toBe(2);
    // .md entry (2026-03-14) should sort before .jsonl entry (2026-03-15)
    expect(result.chunks[0].text.indexOf('Markdown entry')).toBeLessThan(
      result.chunks[0].text.indexOf('JSONL entry'),
    );
  });

  it('handles missing .md log gracefully', () => {
    writeTestLog('no-md-agent', [
      { ts: '2026-03-15T10:00:00Z', agent: 'no-md-agent', type: 'action', summary: 'Only JSONL', detail: '', tags: [] },
    ]);

    const result = prepareSleep('no-md-agent', { logsDir: AGENTS_DIR });
    expect(result.totalEntries).toBe(1);
    expect(result.chunks[0].text).toContain('Only JSONL');
  });
});
