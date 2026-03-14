/**
 * Tests for consolidation resilience: locking, backup, integrity checks, quarantine.
 * Covers issue #17.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph, NodeType, RelationshipType } from '../../src/memory/graph.js';
import {
  acquireLock,
  releaseLock,
  lockPathFor,
  backupDatabase,
  runIntegrityChecks,
  nremReplay,
  remRefine,
  runFullCycle,
} from '../../src/memory/replay.js';

// Mock NER so extractFromEntry uses regex fallback
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

const TEST_DIR = join(tmpdir(), `myelin-resilience-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Create a file-backed KnowledgeGraph in the test directory. */
function createFileGraph(name = 'graph.db'): KnowledgeGraph {
  const dbPath = join(TEST_DIR, name);
  return new KnowledgeGraph(dbPath);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

describe('acquireLock / releaseLock', () => {
  it('acquires lock on first call', () => {
    const graph = createFileGraph();
    try {
      const result = acquireLock(graph);
      expect(result.acquired).toBe(true);
      expect(result.message).toBeUndefined();

      const lockFile = lockPathFor(graph);
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      releaseLock(graph);
      graph.close();
    }
  });

  it('blocks when a recent lock exists', () => {
    const graph = createFileGraph();
    try {
      // Write a fresh lock
      const lockFile = lockPathFor(graph);
      writeFileSync(lockFile, String(Date.now()), 'utf-8');

      const result = acquireLock(graph);
      expect(result.acquired).toBe(false);
      expect(result.message).toContain('already in progress');
    } finally {
      releaseLock(graph);
      graph.close();
    }
  });

  it('overrides stale lock (> 10 min)', () => {
    const graph = createFileGraph();
    try {
      const lockFile = lockPathFor(graph);
      const staleTime = Date.now() - 11 * 60 * 1000; // 11 minutes ago
      writeFileSync(lockFile, String(staleTime), 'utf-8');

      const result = acquireLock(graph);
      expect(result.acquired).toBe(true);
      expect(result.message).toContain('Stale lock');
    } finally {
      releaseLock(graph);
      graph.close();
    }
  });

  it('releases lock cleanly', () => {
    const graph = createFileGraph();
    try {
      acquireLock(graph);
      const lockFile = lockPathFor(graph);
      expect(existsSync(lockFile)).toBe(true);

      releaseLock(graph);
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      graph.close();
    }
  });

  it('skips locking for in-memory databases', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      const result = acquireLock(graph);
      expect(result.acquired).toBe(true);
      expect(lockPathFor(graph)).toBe('');
    } finally {
      graph.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

describe('backupDatabase', () => {
  it('creates a timestamped backup', () => {
    const graph = createFileGraph();
    try {
      // Add some data so the db has content
      graph.addNode({ name: 'BackupTest', type: NodeType.Concept });

      const backupPath = backupDatabase(graph);
      expect(backupPath).not.toBeNull();
      expect(existsSync(backupPath!)).toBe(true);
      expect(backupPath!).toContain('.backup-');
    } finally {
      graph.close();
    }
  });

  it('rotates to keep only 3 backups', () => {
    const graph = createFileGraph();
    try {
      graph.addNode({ name: 'RotationTest' });

      // Pre-create 5 backup files with guaranteed unique timestamps
      // (calling backupDatabase in a tight loop can produce identical
      // timestamps on fast CI runners, causing overwrites — see #46)
      const dbName = graph.db.name;
      const dir = join(TEST_DIR);
      for (let i = 0; i < 5; i++) {
        const ts = `2026-01-0${i + 1}T00-00-00-000Z`;
        writeFileSync(join(dir, `${dbName.split(/[\\/]/).pop()}.backup-${ts}`), '');
      }

      // One more backup + rotation
      backupDatabase(graph);

      const backups = readdirSync(dir).filter(f => f.includes('.backup-'));
      expect(backups.length).toBe(3);
    } finally {
      graph.close();
    }
  });

  it('returns null for in-memory databases', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      const result = backupDatabase(graph);
      expect(result).toBeNull();
    } finally {
      graph.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integrity checks
// ---------------------------------------------------------------------------

describe('runIntegrityChecks', () => {
  it('removes orphan edges', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      graph.addNode({ id: 'a', name: 'A' });
      graph.addNode({ id: 'b', name: 'B' });
      graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });

      // Create orphan by deleting node with FK disabled
      graph.db.pragma('foreign_keys = OFF');
      graph.db.prepare('DELETE FROM nodes WHERE id = ?').run('b');
      graph.db.pragma('foreign_keys = ON');

      const result = runIntegrityChecks(graph);
      expect(result.orphanEdgesRemoved).toBe(1);
    } finally {
      graph.close();
    }
  });

  it('clamps salience below 0', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      graph.addNode({ id: 'neg', name: 'Negative', salience: 0.5 });
      // Manually set salience below 0
      graph.db.prepare('UPDATE nodes SET salience = -0.5 WHERE id = ?').run('neg');

      const result = runIntegrityChecks(graph);
      expect(result.salienceClamped).toBe(1);
      expect(graph.getNode('neg')!.salience).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('clamps salience above 1', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      graph.addNode({ id: 'high', name: 'High', salience: 0.5 });
      // Manually set salience above 1
      graph.db.prepare('UPDATE nodes SET salience = 1.5 WHERE id = ?').run('high');

      const result = runIntegrityChecks(graph);
      expect(result.salienceClamped).toBe(1);
      expect(graph.getNode('high')!.salience).toBe(1);
    } finally {
      graph.close();
    }
  });

  it('returns zero counts for clean graph', () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      graph.addNode({ id: 'ok', name: 'OK', salience: 0.5 });

      const result = runIntegrityChecks(graph);
      expect(result.orphanEdgesRemoved).toBe(0);
      expect(result.salienceClamped).toBe(0);
    } finally {
      graph.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Quarantine (malformed entries don't abort)
// ---------------------------------------------------------------------------

describe('quarantine', () => {
  it('quarantines malformed JSONL lines without aborting', async () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      const logPath = join(TEST_DIR, 'mixed.jsonl');
      const lines = [
        JSON.stringify({ ts: '2025-12-01T10:00:00Z', agent: 'test', type: 'finding', summary: 'Good entry', detail: '', sessionId: '', tags: [], context: {} }),
        'THIS IS NOT VALID JSON {{{',
        JSON.stringify({ ts: '2025-12-01T11:00:00Z', agent: 'test', type: 'action', summary: 'Another good entry', detail: '', sessionId: '', tags: [], context: {} }),
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf-8');

      const result = await nremReplay(graph, logPath, { agentName: 'test' });

      // Should process 2 good entries, quarantine 1 bad one
      expect(result.entriesProcessed).toBe(2);
      expect(result.quarantined.length).toBe(1);
      expect(result.quarantined[0].source).toContain('line2');
      expect(result.quarantined[0].error).toBeDefined();
    } finally {
      graph.close();
    }
  });

  it('handles malformed LLM extractions gracefully without aborting', async () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      const logPath = join(TEST_DIR, 'for-llm.jsonl');
      writeFileSync(logPath, JSON.stringify({
        ts: '2025-12-01T10:00:00Z', agent: 'test', type: 'finding',
        summary: 'Test entry', detail: '', sessionId: '', tags: [], context: {},
      }), 'utf-8');

      const goodExtraction = JSON.stringify({
        entities: [{ id: 'good', type: 'concept', name: 'Good Entity', salience: 0.7 }],
        relationships: [],
      });
      // parseLlmExtraction handles bad JSON gracefully (returns empty result)
      const badExtraction = 'NOT JSON AT ALL!!!';

      const result = await nremReplay(graph, logPath, {
        agentName: 'test',
        llmExtractions: [goodExtraction, badExtraction],
      });

      // Good extraction should succeed
      expect(result.nodesAdded).toBe(1);
      expect(graph.getNode('good')).not.toBeNull();
      // Bad extraction is handled gracefully — no crash, just 0 entities from it
      expect(result.entitiesExtracted).toBe(1); // only from good extraction
    } finally {
      graph.close();
    }
  });

  it('continues processing after quarantine', async () => {
    const graph = new KnowledgeGraph(':memory:');
    try {
      const logPath = join(TEST_DIR, 'continue.jsonl');
      const lines = [
        'BROKEN',
        JSON.stringify({ ts: '2025-12-01T10:00:00Z', agent: 'test', type: 'finding', summary: 'Entry after broken', detail: '', sessionId: '', tags: [], context: {} }),
        'ALSO BROKEN',
        JSON.stringify({ ts: '2025-12-01T11:00:00Z', agent: 'test', type: 'action', summary: 'Last good entry', detail: '', sessionId: '', tags: [], context: {} }),
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf-8');

      const result = await nremReplay(graph, logPath, { agentName: 'test' });

      expect(result.entriesProcessed).toBe(2);
      expect(result.quarantined.length).toBe(2);
    } finally {
      graph.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: full cycle with resilience features
// ---------------------------------------------------------------------------

describe('full cycle resilience integration', () => {
  it('backup + integrity check work with file-backed graph', () => {
    const graph = createFileGraph();
    try {
      // Add data
      graph.addNode({ id: 'a', name: 'A', salience: 0.5 });
      graph.addNode({ id: 'b', name: 'B', salience: 0.5 });
      graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });

      // Create backup
      const backupPath = backupDatabase(graph);
      expect(backupPath).not.toBeNull();

      // Create integrity issue
      graph.db.pragma('foreign_keys = OFF');
      graph.db.prepare('DELETE FROM nodes WHERE id = ?').run('b');
      graph.db.pragma('foreign_keys = ON');

      // Fix via integrity check
      const integrity = runIntegrityChecks(graph);
      expect(integrity.orphanEdgesRemoved).toBe(1);
    } finally {
      graph.close();
    }
  });

  it('lock + unlock + integrity check round-trip', () => {
    const graph = createFileGraph();
    try {
      // Acquire
      const lockResult = acquireLock(graph);
      expect(lockResult.acquired).toBe(true);

      // Do work
      graph.addNode({ id: 'work', name: 'Work' });

      // Integrity check
      const integrity = runIntegrityChecks(graph);
      expect(integrity.orphanEdgesRemoved).toBe(0);

      // Release
      releaseLock(graph);
      expect(existsSync(lockPathFor(graph))).toBe(false);
    } finally {
      releaseLock(graph); // safety
      graph.close();
    }
  });
});
