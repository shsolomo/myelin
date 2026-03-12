/**
 * Tests for replay.ts — NREM/REM consolidation pipeline.
 *
 * Covers:
 * - remRefine: decay, prune, orphan edge cleanup
 * - nremReplay: with LLM extractions (pre-supplied JSON)
 * - runFullCycle: integration of NREM + REM
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph, NodeType, RelationshipType } from '../../src/memory/graph.js';
import { remRefine, nremReplay, runFullCycle } from '../../src/memory/replay.js';

// Mock NER so extractFromEntry uses regex fallback
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

let graph: KnowledgeGraph;
const TEST_DIR = join(tmpdir(), `myelin-replay-test-${Date.now()}`);

beforeEach(() => {
  graph = new KnowledgeGraph(':memory:');
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  graph.close();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Create a temp log.md file with content and return its path. */
function createTempLog(content: string): string {
  const logPath = join(TEST_DIR, 'log.md');
  writeFileSync(logPath, content, 'utf-8');
  return logPath;
}

// ---------------------------------------------------------------------------
// remRefine
// ---------------------------------------------------------------------------

describe('remRefine', () => {
  it('decays node salience', () => {
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString();
    graph.addNode({ id: 'old-node', name: 'Old', salience: 0.5, lastReinforced: old });

    const result = remRefine(graph);
    expect(result.nodesDecayed).toBe(1);
    expect(graph.getNode('old-node')!.salience).toBeLessThan(0.5);
  });

  it('prunes stale low-salience nodes', () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    graph.addNode({ id: 'stale', name: 'Stale', salience: 0.01, lastReinforced: old });

    const result = remRefine(graph, { pruneThreshold: 0.05, pruneMinAgeDays: 30 });
    expect(result.nodesPruned).toBe(1);
    expect(graph.getNode('stale')).toBeNull();
  });

  it('cleans up orphan edges', () => {
    graph.addNode({ id: 'a', name: 'A' });
    graph.addNode({ id: 'b', name: 'B' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });

    // Disable FK to create orphan edge state (FK CASCADE would normally clean it)
    graph.db.pragma('foreign_keys = OFF');
    graph.db.prepare('DELETE FROM nodes WHERE id = ?').run('b');
    graph.db.pragma('foreign_keys = ON');

    const result = remRefine(graph);
    expect(result.edgesPruned).toBe(1);
  });

  it('uses custom decay rate', () => {
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString();
    graph.addNode({ id: 'n', name: 'N', salience: 0.5, lastReinforced: old });

    remRefine(graph, { decayRate: 0.3 });
    expect(graph.getNode('n')!.salience).toBeLessThan(0.3);
  });

  it('returns zero counts for empty graph', () => {
    const result = remRefine(graph);
    expect(result.nodesDecayed).toBe(0);
    expect(result.nodesPruned).toBe(0);
    expect(result.edgesPruned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nremReplay (with LLM extractions)
// ---------------------------------------------------------------------------

describe('nremReplay', () => {
  it('returns zero counts when no log path provided', async () => {
    const result = await nremReplay(graph);
    expect(result.entriesProcessed).toBe(0);
    expect(result.entitiesExtracted).toBe(0);
  });

  it('processes LLM extractions into graph', async () => {
    // nremReplay needs entries to not exit early — provide a log file
    const logPath = createTempLog(`## 2025-12-01\n\n### Meeting notes\nDiscussed auth service with Alex Chen.\n`);

    const extraction = JSON.stringify({
      entities: [
        { id: 'auth-service', type: 'tool', name: 'Auth Service', description: 'Handles JWT auth', salience: 0.8 },
        { id: 'alex', type: 'person', name: 'Alex Chen', description: 'Team lead', salience: 0.6 },
      ],
      relationships: [
        { source: 'alex', target: 'auth-service', relationship: 'authored_by', description: 'Alex built it' },
      ],
    });

    const result = await nremReplay(graph, logPath, {
      llmExtractions: [extraction],
    });

    expect(result.entitiesExtracted).toBe(2);
    expect(result.relationshipsExtracted).toBe(1);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);
    expect(graph.getNode('auth-service')).not.toBeNull();
    expect(graph.getNode('alex')).not.toBeNull();
  });

  it('reinforces existing nodes on re-extraction', async () => {
    const logPath = createTempLog(`## 2025-12-01\n\n### Entry\nSome content here.\n`);

    const extraction = JSON.stringify({
      entities: [{ id: 'test-node', type: 'concept', name: 'Test', salience: 0.5 }],
      relationships: [],
    });
    await nremReplay(graph, logPath, { llmExtractions: [extraction] });
    const initialSalience = graph.getNode('test-node')!.salience;

    // Second extraction with same entity
    const result = await nremReplay(graph, logPath, { llmExtractions: [extraction] });
    expect(result.nodesReinforced).toBe(1);
    expect(graph.getNode('test-node')!.salience).toBeGreaterThan(initialSalience);
  });

  it('processes multiple LLM extractions', async () => {
    const logPath = createTempLog(`## 2025-12-01\n\n### Entry\nContent.\n`);

    const ext1 = JSON.stringify({
      entities: [{ id: 'a', type: 'concept', name: 'A' }],
      relationships: [],
    });
    const ext2 = JSON.stringify({
      entities: [{ id: 'b', type: 'concept', name: 'B' }],
      relationships: [],
    });

    const result = await nremReplay(graph, logPath, {
      llmExtractions: [ext1, ext2],
    });

    expect(result.entitiesExtracted).toBe(2);
    expect(result.nodesAdded).toBe(2);
  });

  it('processes entries via regex extraction when no llmExtractions', async () => {
    const logPath = createTempLog(`## 2025-12-01\n\n### Bug found\nFound a critical bug in the cache module.\n`);

    const result = await nremReplay(graph, logPath, { agentName: 'hebb' });

    expect(result.entriesProcessed).toBe(1);
    expect(result.entriesByType['action']).toBeUndefined; // it should be classified
  });

  it('tracks high-salience entries', async () => {
    // Include both importance and novelty signals to push combined above 0.7
    const logPath = createTempLog(`## 2025-12-01\n\n### Security alert\nArchitectural decision: breakthrough insight into security. Root cause discovered unexpectedly.\n`);

    const result = await nremReplay(graph, logPath);
    expect(result.highSalienceEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runFullCycle
// ---------------------------------------------------------------------------

describe('runFullCycle', () => {
  it('runs both NREM and REM phases', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    graph.addNode({ id: 'stale', name: 'Stale', salience: 0.01, lastReinforced: old });

    const logPath = createTempLog(`## 2025-12-01\n\n### New stuff\nFresh content for the graph.\n`);
    const extraction = JSON.stringify({
      entities: [{ id: 'fresh', type: 'concept', name: 'Fresh', salience: 0.9 }],
      relationships: [],
    });

    const { nrem, rem } = await runFullCycle(graph, logPath, {
      llmExtractions: [extraction],
    });

    expect(nrem.nodesAdded).toBe(1);
    expect(rem.nodesPruned).toBe(1);
    expect(graph.getNode('fresh')).not.toBeNull();
    expect(graph.getNode('stale')).toBeNull();
  });
});
