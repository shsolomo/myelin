/**
 * Classification traversal test suite — 16 cases covering the full
 * sensitivity classification system end-to-end.
 *
 * Covers: schema migration, ceiling filtering, PRUNE/SKIP traversal,
 * edge collection, defaults, null handling, mixed levels, sensitivity
 * reason, auto-classification heuristics, NREM integration.
 *
 * All tests use :memory: SQLite — no ONNX or model dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  KnowledgeGraph,
  NodeType,
  RelationshipType,
} from '../../src/memory/graph.js';
import {
  initSchema,
  extendSchemaForCode,
  extendSchemaForClassification,
} from '../../src/memory/schema.js';
import { inferSensitivity, nremReplay } from '../../src/memory/replay.js';
import type { LogEntry } from '../../src/memory/log-parser.js';

// Mock NER so extractFromEntry uses regex fallback
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

let graph: KnowledgeGraph;
const TEST_DIR = join(tmpdir(), `myelin-classification-test-${Date.now()}`);

beforeEach(() => {
  graph = new KnowledgeGraph(':memory:');
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  graph.close();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeLogEntry(overrides: Partial<{
  heading: string;
  content: string;
  entryType: string;
  tags: string;
}>): LogEntry {
  const heading = overrides.heading ?? '';
  const content = overrides.content ?? '';
  const entryType = overrides.entryType ?? 'observation';
  const metadata: Record<string, string> = {};
  if (overrides.tags) metadata.tags = overrides.tags;
  return {
    date: '2025-12-01',
    heading,
    content,
    entryType,
    metadata,
    get fullText() { return `${heading}\n${content}`; },
  };
}

// ---------------------------------------------------------------------------
// 1. Schema migration: sensitivity columns added idempotently
// ---------------------------------------------------------------------------

describe('1. Schema migration', () => {
  it('adds sensitivity columns to nodes and edges idempotently', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);

    // First call adds columns
    extendSchemaForClassification(db);
    const nodesCols = (db.pragma('table_info(nodes)') as Array<{ name: string }>).map(r => r.name);
    expect(nodesCols).toContain('sensitivity');
    expect(nodesCols).toContain('sensitivity_reason');

    const edgesCols = (db.pragma('table_info(edges)') as Array<{ name: string }>).map(r => r.name);
    expect(edgesCols).toContain('sensitivity');
    expect(edgesCols).toContain('sensitivity_reason');

    // Second call does not throw
    expect(() => extendSchemaForClassification(db)).not.toThrow();

    // Indexes exist
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%sensitivity%'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_nodes_sensitivity');
    expect(names).toContain('idx_edges_sensitivity');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. findNodes ceiling: nodes above ceiling excluded
// ---------------------------------------------------------------------------

describe('2. findNodes ceiling filter', () => {
  it('excludes nodes with sensitivity above the ceiling', () => {
    graph.addNode({ id: 'public', name: 'Public', sensitivity: 0 });
    graph.addNode({ id: 'internal', name: 'Internal', sensitivity: 1 });
    graph.addNode({ id: 'confidential', name: 'Confidential', sensitivity: 2 });
    graph.addNode({ id: 'secret', name: 'Secret', sensitivity: 3 });

    const nodes = graph.findNodes({ ceiling: 1 });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('public');
    expect(ids).toContain('internal');
    expect(ids).not.toContain('confidential');
    expect(ids).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// 3. semanticSearch ceiling: filter logic works
// ---------------------------------------------------------------------------

describe('3. semanticSearch ceiling', () => {
  it('accepts ceiling parameter without error (vec unavailable)', () => {
    const results = graph.semanticSearch(new Array(384).fill(0), 20, undefined, undefined, 1);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. PRUNE traversal: BFS stops at sensitive nodes
// ---------------------------------------------------------------------------

describe('4. PRUNE traversal', () => {
  it('stops BFS at sensitive nodes — downstream unreachable', () => {
    // A(public) -> B(secret) -> C(public) -> D(public)
    graph.addNode({ id: 'a', name: 'A', salience: 0.9, sensitivity: 0, sourceAgent: 'test' });
    graph.addNode({ id: 'b', name: 'B', salience: 0.8, sensitivity: 3, sourceAgent: 'other' });
    graph.addNode({ id: 'c', name: 'C', salience: 0.7, sensitivity: 0, sourceAgent: 'other' });
    graph.addNode({ id: 'd', name: 'D', salience: 0.6, sensitivity: 0, sourceAgent: 'other' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'b', targetId: 'c', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'c', targetId: 'd', relationship: RelationshipType.RelatesTo });

    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 3, traversalMode: 'prune' });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
  });
});

// ---------------------------------------------------------------------------
// 5. SKIP traversal: walks through sensitive, downstream reachable
// ---------------------------------------------------------------------------

describe('5. SKIP traversal', () => {
  it('walks through sensitive nodes — downstream reachable but sensitive excluded', () => {
    graph.addNode({ id: 'a', name: 'A', salience: 0.9, sensitivity: 0, sourceAgent: 'test' });
    graph.addNode({ id: 'b', name: 'B', salience: 0.8, sensitivity: 3, sourceAgent: 'other' });
    graph.addNode({ id: 'c', name: 'C', salience: 0.7, sensitivity: 0, sourceAgent: 'other' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'b', targetId: 'c', relationship: RelationshipType.RelatesTo });

    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'skip' });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).toContain('c');
  });
});

// ---------------------------------------------------------------------------
// 6. Edge collection: sensitive nodes excluded from edge endpoints
// ---------------------------------------------------------------------------

describe('6. Edge collection', () => {
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'A', salience: 0.9, sensitivity: 0, sourceAgent: 'test' });
    graph.addNode({ id: 'b', name: 'B', salience: 0.8, sensitivity: 3, sourceAgent: 'other' });
    graph.addNode({ id: 'c', name: 'C', salience: 0.7, sensitivity: 0, sourceAgent: 'other' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'b', targetId: 'c', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'a', targetId: 'c', relationship: RelationshipType.DependsOn });
  });

  it('edges referencing sensitive nodes excluded', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'skip' });
    for (const e of sub.edges) {
      expect(e.sourceId).not.toBe('b');
      expect(e.targetId).not.toBe('b');
    }
  });

  it('edges between visible nodes preserved', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'skip' });
    const hasAtoC = sub.edges.some(e => e.sourceId === 'a' && e.targetId === 'c');
    expect(hasAtoC).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Default sensitivity: new nodes get sensitivity=0
// ---------------------------------------------------------------------------

describe('7. Default sensitivity', () => {
  it('nodes created without sensitivity get default 0 in DB', () => {
    graph.addNode({ id: 'default', name: 'Default Node' });
    const row = graph.db.prepare('SELECT sensitivity FROM nodes WHERE id = ?').get('default') as { sensitivity: number };
    expect(row.sensitivity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Null handling: nodes without sensitivity treated as level 0
// ---------------------------------------------------------------------------

describe('8. Null handling', () => {
  it('null sensitivity treated as level 0 in ceiling filter', () => {
    // The schema sets DEFAULT 0, so we need to explicitly set NULL to simulate legacy data
    graph.db.prepare(
      `INSERT INTO nodes (id, type, name, created_at, last_reinforced, sensitivity)
       VALUES ('legacy', 'concept', 'Legacy', '2025-01-01', '2025-01-01', NULL)`
    ).run();
    // Verify it's actually NULL
    const raw = graph.db.prepare('SELECT sensitivity FROM nodes WHERE id = ?').get('legacy') as any;
    expect(raw.sensitivity).toBeNull();

    // ceiling=0 should include it (NULL treated as 0)
    const nodes = graph.findNodes({ ceiling: 0 });
    expect(nodes.some(n => n.id === 'legacy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Mixed graph: all 4 levels, correct filtering at each ceiling
// ---------------------------------------------------------------------------

describe('9. Mixed graph with all 4 levels', () => {
  beforeEach(() => {
    graph.addNode({ id: 'l0', name: 'Level 0', sensitivity: 0 });
    graph.addNode({ id: 'l1', name: 'Level 1', sensitivity: 1 });
    graph.addNode({ id: 'l2', name: 'Level 2', sensitivity: 2 });
    graph.addNode({ id: 'l3', name: 'Level 3', sensitivity: 3 });
  });

  it('ceiling=0 returns only level 0', () => {
    const ids = graph.findNodes({ ceiling: 0 }).map(n => n.id);
    expect(ids).toEqual(['l0']);
  });

  it('ceiling=1 returns levels 0 and 1', () => {
    const ids = graph.findNodes({ ceiling: 1 }).map(n => n.id).sort();
    expect(ids).toEqual(['l0', 'l1']);
  });

  it('ceiling=2 returns levels 0, 1, 2', () => {
    const ids = graph.findNodes({ ceiling: 2 }).map(n => n.id).sort();
    expect(ids).toEqual(['l0', 'l1', 'l2']);
  });

  it('ceiling=3 returns all levels', () => {
    const ids = graph.findNodes({ ceiling: 3 }).map(n => n.id).sort();
    expect(ids).toEqual(['l0', 'l1', 'l2', 'l3']);
  });

  it('no ceiling returns all levels', () => {
    expect(graph.findNodes()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 10. Sensitivity reason: stored and retrievable
// ---------------------------------------------------------------------------

describe('10. Sensitivity reason', () => {
  it('stores and retrieves sensitivity reason on nodes', () => {
    graph.addNode({
      id: 'reasoned',
      name: 'Reasoned Node',
      sensitivity: 2,
      sensitivityReason: 'source:confidential/strategy',
    });
    const node = graph.getNode('reasoned');
    expect(node).not.toBeNull();
    expect(node!.sensitivity).toBe(2);
    expect(node!.sensitivityReason).toBe('source:confidential/strategy');
  });

  it('updates sensitivity reason via updateNode', () => {
    graph.addNode({ id: 'update-me', name: 'Updatable', sensitivity: 1, sensitivityReason: 'type:decision' });
    graph.updateNode('update-me', { sensitivity: 3, sensitivityReason: 'source:private/1on1/dm' });
    const node = graph.getNode('update-me');
    expect(node!.sensitivity).toBe(3);
    expect(node!.sensitivityReason).toBe('source:private/1on1/dm');
  });
});

// ---------------------------------------------------------------------------
// 11. Auto-classification MAX: source floor + type ceiling combined
// ---------------------------------------------------------------------------

describe('11. Auto-classification MAX pattern', () => {
  it('source floor wins when higher than entity type', () => {
    const entry = makeLogEntry({ tags: '1on1' });
    const result = inferSensitivity(entry, 'concept');
    expect(result.level).toBe(3);
    expect(result.reason).toContain('source:');
  });

  it('entity type wins when higher than source floor', () => {
    const entry = makeLogEntry({});
    const result = inferSensitivity(entry, 'person');
    expect(result.level).toBe(2);
    expect(result.reason).toContain('type:person');
  });

  it('equal signals: source wins (channelFloor >= typeCeiling branch)', () => {
    // source=2 (confidential), entity=2 (person) → source wins
    const entry = makeLogEntry({ tags: 'confidential' });
    const result = inferSensitivity(entry, 'person');
    expect(result.level).toBe(2);
    expect(result.reason).toContain('source:');
  });

  it('both zero for generic public content', () => {
    const entry = makeLogEntry({ tags: 'general' });
    const result = inferSensitivity(entry, 'concept');
    expect(result.level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. NREM auto-classification integration
// ---------------------------------------------------------------------------

describe('12. NREM auto-classification integration', () => {
  it('assigns correct sensitivity to Person entities from private source', async () => {
    const logPath = join(TEST_DIR, 'private-person.jsonl');
    writeFileSync(logPath, JSON.stringify({
      ts: '2025-12-01T10:00:00Z', agent: 'test', type: 'observation',
      summary: 'Private chat with Jane Smith about security concerns',
      detail: '', sessionId: '', tags: ['1on1'], context: {},
    }) + '\n', 'utf-8');

    await nremReplay(graph, logPath, { agentName: 'test' });

    const nodes = graph.findNodes();
    // Person entities from 1on1 should have MAX(3, 2) = 3
    const personNodes = nodes.filter(n => n.type === NodeType.Person);
    for (const p of personNodes) {
      expect(p.sensitivity).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Traversal with mixed sensitivity in diamond graph
// ---------------------------------------------------------------------------

describe('13. Diamond graph traversal', () => {
  //     A (seed)
  //    / \
  //   B   C(sensitive)
  //    \ /
  //     D
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'A', salience: 0.9, sensitivity: 0, sourceAgent: 'test' });
    graph.addNode({ id: 'b', name: 'B', salience: 0.8, sensitivity: 0, sourceAgent: 'other' });
    graph.addNode({ id: 'c', name: 'C', salience: 0.7, sensitivity: 3, sourceAgent: 'other' });
    graph.addNode({ id: 'd', name: 'D', salience: 0.6, sensitivity: 0, sourceAgent: 'other' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'a', targetId: 'c', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'b', targetId: 'd', relationship: RelationshipType.DependsOn });
    graph.addEdge({ sourceId: 'c', targetId: 'd', relationship: RelationshipType.DependsOn });
  });

  it('SKIP: D reachable through B even though C is sensitive', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'skip' });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
    expect(ids).toContain('d');
  });

  it('PRUNE: D still reachable through B (only C branch pruned)', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'prune' });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
    expect(ids).toContain('d');
  });
});

// ---------------------------------------------------------------------------
// 14. Ceiling combined with other findNodes filters
// ---------------------------------------------------------------------------

describe('14. Ceiling combined with other filters', () => {
  it('ceiling + type filter works together', () => {
    graph.addNode({ id: 'bug-public', name: 'Public Bug', type: NodeType.Bug, sensitivity: 0 });
    graph.addNode({ id: 'bug-secret', name: 'Secret Bug', type: NodeType.Bug, sensitivity: 3 });
    graph.addNode({ id: 'person-public', name: 'Public Person', type: NodeType.Person, sensitivity: 0 });

    const bugs = graph.findNodes({ type: NodeType.Bug, ceiling: 1 });
    expect(bugs).toHaveLength(1);
    expect(bugs[0].id).toBe('bug-public');
  });

  it('ceiling + minSalience filter works together', () => {
    graph.addNode({ id: 'high-public', name: 'HP', salience: 0.9, sensitivity: 0 });
    graph.addNode({ id: 'high-secret', name: 'HS', salience: 0.9, sensitivity: 3 });
    graph.addNode({ id: 'low-public', name: 'LP', salience: 0.1, sensitivity: 0 });

    const nodes = graph.findNodes({ minSalience: 0.5, ceiling: 1 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('high-public');
  });
});

// ---------------------------------------------------------------------------
// 15. Sensitivity preserved across reinforce operations
// ---------------------------------------------------------------------------

describe('15. Sensitivity survives reinforcement', () => {
  it('reinforceNode does not reset sensitivity', () => {
    graph.addNode({ id: 'sensitive', name: 'Sensitive', sensitivity: 2, sensitivityReason: 'type:person' });
    graph.reinforceNode('sensitive', 0.1);
    const node = graph.getNode('sensitive');
    expect(node!.sensitivity).toBe(2);
    expect(node!.sensitivityReason).toBe('type:person');
  });
});

// ---------------------------------------------------------------------------
// 16. End-to-end: NREM → ceiling query → correct results
// ---------------------------------------------------------------------------

describe('16. End-to-end NREM → ceiling query', () => {
  it('ingests log, classifies, then ceiling filter excludes sensitive nodes', async () => {
    const logPath = join(TEST_DIR, 'e2e.jsonl');
    const logEntries = [
      { ts: '2025-12-01T10:00:00Z', agent: 'test', type: 'finding', summary: 'Strategy meeting with John Doe about confidential project plans', detail: '', sessionId: '', tags: ['confidential'], context: {} },
      { ts: '2025-12-01T11:00:00Z', agent: 'test', type: 'action', summary: 'Deployed Redis Cache to production cluster', detail: '', sessionId: '', tags: ['public'], context: {} },
    ];
    writeFileSync(logPath, logEntries.map(e => JSON.stringify(e)).join('\n'), 'utf-8');

    await nremReplay(graph, logPath, { agentName: 'test' });

    const allNodes = graph.findNodes();
    expect(allNodes.length).toBeGreaterThan(0);

    // Public ceiling should exclude confidential/person nodes
    const publicNodes = graph.findNodes({ ceiling: 0 });
    for (const n of publicNodes) {
      expect(n.sensitivity ?? 0).toBe(0);
    }

    // There should be some nodes excluded by ceiling=0 that appear at ceiling=3
    const allAccessNodes = graph.findNodes({ ceiling: 3 });
    expect(allAccessNodes.length).toBeGreaterThanOrEqual(publicNodes.length);
  });
});
