/**
 * Tests for graph.ts — the KnowledgeGraph class (SQLite-backed cortex).
 *
 * Uses in-memory SQLite databases for isolation. Covers:
 * - Node CRUD (add, get, find, search, update, delete, reinforce)
 * - Edge operations (add, get, reinforce)
 * - Tags and properties
 * - Subgraph queries
 * - Homeostatic operations (decay, prune)
 * - Statistics
 * - Embedding stubs (without sqlite-vec)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  KnowledgeGraph,
  NodeType,
  RelationshipType,
} from '../../src/memory/graph.js';

let graph: KnowledgeGraph;

beforeEach(() => {
  graph = new KnowledgeGraph(':memory:');
});

afterEach(() => {
  graph.close();
});

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

describe('addNode', () => {
  it('creates a node with defaults', () => {
    const node = graph.addNode({ name: 'Test Node' });
    expect(node.name).toBe('Test Node');
    expect(node.type).toBe(NodeType.Concept);
    expect(node.salience).toBe(0.5);
    expect(node.confidence).toBe(1.0);
    expect(node.id).toBe('test-node');
  });

  it('uses provided id over generated one', () => {
    const node = graph.addNode({ id: 'custom-id', name: 'Custom' });
    expect(node.id).toBe('custom-id');
  });

  it('respects provided type and salience', () => {
    const node = graph.addNode({
      name: 'A Person',
      type: NodeType.Person,
      salience: 0.9,
    });
    expect(node.type).toBe(NodeType.Person);
    expect(node.salience).toBe(0.9);
  });

  it('stores tags', () => {
    graph.addNode({ id: 'tagged', name: 'Tagged', tags: ['alpha', 'beta'] });
    const tags = graph.getTags('tagged');
    expect(tags).toContain('alpha');
    expect(tags).toContain('beta');
  });

  it('generates id from name via kebab-case', () => {
    const node = graph.addNode({ name: 'My Cool Node!' });
    expect(node.id).toBe('my-cool-node');
  });

  it('truncates generated id to 40 chars', () => {
    const node = graph.addNode({ name: 'A'.repeat(100) });
    expect(node.id.length).toBeLessThanOrEqual(40);
  });
});

describe('getNode', () => {
  it('retrieves an existing node', () => {
    graph.addNode({ id: 'n1', name: 'Node 1', type: NodeType.Bug, description: 'A bug' });
    const node = graph.getNode('n1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('Node 1');
    expect(node!.type).toBe(NodeType.Bug);
    expect(node!.description).toBe('A bug');
  });

  it('returns null for non-existent node', () => {
    expect(graph.getNode('nonexistent')).toBeNull();
  });

  it('includes tags in retrieved node', () => {
    graph.addNode({ id: 'n1', name: 'Node 1', tags: ['t1', 't2'] });
    const node = graph.getNode('n1');
    expect(node!.tags).toContain('t1');
    expect(node!.tags).toContain('t2');
  });
});

describe('findNodes', () => {
  beforeEach(() => {
    graph.addNode({ id: 'n1', name: 'Bug A', type: NodeType.Bug, salience: 0.8, sourceAgent: 'donna' });
    graph.addNode({ id: 'n2', name: 'Person B', type: NodeType.Person, salience: 0.3, sourceAgent: 'hebb' });
    graph.addNode({ id: 'n3', name: 'Bug C', type: NodeType.Bug, salience: 0.6, sourceAgent: 'donna', tags: ['critical'] });
  });

  it('returns all nodes when no filters', () => {
    const nodes = graph.findNodes();
    expect(nodes.length).toBe(3);
  });

  it('filters by type', () => {
    const bugs = graph.findNodes({ type: NodeType.Bug });
    expect(bugs).toHaveLength(2);
    expect(bugs.every(n => n.type === NodeType.Bug)).toBe(true);
  });

  it('filters by sourceAgent', () => {
    const donna = graph.findNodes({ sourceAgent: 'donna' });
    expect(donna).toHaveLength(2);
  });

  it('filters by minSalience', () => {
    const high = graph.findNodes({ minSalience: 0.7 });
    expect(high).toHaveLength(1);
    expect(high[0].id).toBe('n1');
  });

  it('filters by tag', () => {
    const critical = graph.findNodes({ tag: 'critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0].id).toBe('n3');
  });

  it('respects limit', () => {
    const limited = graph.findNodes({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('sorts by salience descending', () => {
    const nodes = graph.findNodes();
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].salience).toBeGreaterThanOrEqual(nodes[i].salience);
    }
  });
});

// ---------------------------------------------------------------------------
// Sensitivity ceiling filter
// ---------------------------------------------------------------------------

describe('findNodes ceiling filter', () => {
  beforeEach(() => {
    graph.addNode({ id: 'public', name: 'Public Info', salience: 0.8, sensitivity: 0 });
    graph.addNode({ id: 'internal', name: 'Internal Doc', salience: 0.7, sensitivity: 1 });
    graph.addNode({ id: 'secret', name: 'Secret Key', salience: 0.9, sensitivity: 3 });
    graph.addNode({ id: 'unset', name: 'No Sensitivity', salience: 0.5 });
  });

  it('returns all nodes when no ceiling set', () => {
    const nodes = graph.findNodes();
    expect(nodes).toHaveLength(4);
  });

  it('filters out nodes above ceiling', () => {
    const nodes = graph.findNodes({ ceiling: 1 });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('public');
    expect(ids).toContain('internal');
    expect(ids).toContain('unset');
    expect(ids).not.toContain('secret');
  });

  it('ceiling=0 returns only level-0 and null sensitivity', () => {
    const nodes = graph.findNodes({ ceiling: 0 });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('public');
    expect(ids).toContain('unset');
    expect(ids).not.toContain('internal');
    expect(ids).not.toContain('secret');
  });

  it('treats null sensitivity as level 0 (backward compatible)', () => {
    const nodes = graph.findNodes({ ceiling: 0 });
    expect(nodes.some(n => n.id === 'unset')).toBe(true);
  });

  it('ceiling high enough returns everything', () => {
    const nodes = graph.findNodes({ ceiling: 10 });
    expect(nodes).toHaveLength(4);
  });

  it('combines ceiling with other filters', () => {
    graph.addTag('secret', 'credential');
    graph.addTag('public', 'credential');
    const nodes = graph.findNodes({ tag: 'credential', ceiling: 1 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('public');
  });
});

describe('searchNodes', () => {
  beforeEach(() => {
    graph.addNode({ id: 'auth', name: 'Auth Module', description: 'JWT-based authentication' });
    graph.addNode({ id: 'cache', name: 'Redis Cache', description: 'Caching layer for API' });
  });

  it('finds nodes by name via FTS', () => {
    const results = graph.searchNodes('Auth');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(n => n.id === 'auth')).toBe(true);
  });

  it('finds nodes by description', () => {
    const results = graph.searchNodes('JWT');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(n => n.id === 'auth')).toBe(true);
  });

  it('returns empty array for no match', () => {
    const results = graph.searchNodes('zzz-nonexistent-zzz');
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const results = graph.searchNodes('Module', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('updateNode', () => {
  it('updates name', () => {
    graph.addNode({ id: 'n1', name: 'Old Name' });
    const ok = graph.updateNode('n1', { name: 'New Name' });
    expect(ok).toBe(true);
    expect(graph.getNode('n1')!.name).toBe('New Name');
  });

  it('updates salience', () => {
    graph.addNode({ id: 'n1', name: 'Node', salience: 0.5 });
    graph.updateNode('n1', { salience: 0.9 });
    expect(graph.getNode('n1')!.salience).toBe(0.9);
  });

  it('returns false for non-existent node', () => {
    expect(graph.updateNode('nope', { name: 'X' })).toBe(false);
  });

  it('returns false when no fields provided', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    expect(graph.updateNode('n1', {})).toBe(false);
  });
});

describe('deleteNode', () => {
  it('removes a node', () => {
    graph.addNode({ id: 'n1', name: 'Node 1' });
    expect(graph.deleteNode('n1')).toBe(true);
    expect(graph.getNode('n1')).toBeNull();
  });

  it('returns false for non-existent node', () => {
    expect(graph.deleteNode('nope')).toBe(false);
  });

  it('cascade-deletes tags', () => {
    graph.addNode({ id: 'n1', name: 'Node 1', tags: ['a', 'b'] });
    graph.deleteNode('n1');
    expect(graph.getTags('n1')).toHaveLength(0);
  });

  it('cascade-deletes properties', () => {
    graph.addNode({ id: 'n1', name: 'Node 1' });
    graph.setProperty('n1', 'key', 'val');
    graph.deleteNode('n1');
    expect(graph.getProperty('n1', 'key')).toBeNull();
  });

  it('cascade-deletes edges', () => {
    graph.addNode({ id: 'n1', name: 'Node 1' });
    graph.addNode({ id: 'n2', name: 'Node 2' });
    graph.addEdge({ sourceId: 'n1', targetId: 'n2', relationship: RelationshipType.RelatesTo });
    graph.deleteNode('n1');
    expect(graph.getEdges('n2', 'incoming')).toHaveLength(0);
  });
});

describe('reinforceNode', () => {
  it('boosts salience by the given amount', () => {
    graph.addNode({ id: 'n1', name: 'Node', salience: 0.5 });
    const newSalience = graph.reinforceNode('n1', 0.2);
    expect(newSalience).toBe(0.7);
  });

  it('caps salience at 1.0', () => {
    graph.addNode({ id: 'n1', name: 'Node', salience: 0.95 });
    const newSalience = graph.reinforceNode('n1', 0.2);
    expect(newSalience).toBe(1.0);
  });

  it('uses default boost of 0.1', () => {
    graph.addNode({ id: 'n1', name: 'Node', salience: 0.5 });
    const newSalience = graph.reinforceNode('n1');
    expect(newSalience).toBe(0.6);
  });

  it('returns null for non-existent node', () => {
    expect(graph.reinforceNode('nope')).toBeNull();
  });

  it('updates lastReinforced timestamp', () => {
    // Use an old timestamp so reinforcement clearly updates it
    const oldDate = '2020-01-01T00:00:00.000Z';
    graph.addNode({ id: 'n1', name: 'Node', lastReinforced: oldDate });
    graph.reinforceNode('n1');
    const after = graph.getNode('n1')!.lastReinforced;
    expect(after).not.toBe(oldDate);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(oldDate).getTime());
  });
});

// ---------------------------------------------------------------------------
// Edge Operations
// ---------------------------------------------------------------------------

describe('addEdge', () => {
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'A' });
    graph.addNode({ id: 'b', name: 'B' });
  });

  it('creates an edge between two nodes', () => {
    const edge = graph.addEdge({
      sourceId: 'a',
      targetId: 'b',
      relationship: RelationshipType.DependsOn,
    });
    expect(edge.sourceId).toBe('a');
    expect(edge.targetId).toBe('b');
    expect(edge.relationship).toBe(RelationshipType.DependsOn);
    expect(edge.weight).toBe(1.0);
  });

  it('allows custom weight and description', () => {
    const edge = graph.addEdge({
      sourceId: 'a',
      targetId: 'b',
      relationship: RelationshipType.RelatesTo,
      weight: 0.5,
      description: 'loosely related',
    });
    expect(edge.weight).toBe(0.5);
    expect(edge.description).toBe('loosely related');
  });

  it('enforces composite PK (no duplicate edges)', () => {
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    expect(() =>
      graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo })
    ).toThrow();
  });

  it('allows same nodes with different relationship types', () => {
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    expect(() =>
      graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.DependsOn })
    ).not.toThrow();
  });
});

describe('getEdges', () => {
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'A' });
    graph.addNode({ id: 'b', name: 'B' });
    graph.addNode({ id: 'c', name: 'C' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.DependsOn });
    graph.addEdge({ sourceId: 'c', targetId: 'a', relationship: RelationshipType.RelatesTo });
  });

  it('returns outgoing edges', () => {
    const edges = graph.getEdges('a', 'outgoing');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('b');
  });

  it('returns incoming edges', () => {
    const edges = graph.getEdges('a', 'incoming');
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe('c');
  });

  it('returns both directions by default', () => {
    const edges = graph.getEdges('a');
    expect(edges).toHaveLength(2);
  });

  it('filters by relationship type', () => {
    graph.addEdge({ sourceId: 'a', targetId: 'c', relationship: RelationshipType.Supersedes });
    const edges = graph.getEdges('a', 'outgoing', RelationshipType.DependsOn);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe(RelationshipType.DependsOn);
  });

  it('returns empty for node with no edges', () => {
    graph.addNode({ id: 'lonely', name: 'Lonely Node' });
    expect(graph.getEdges('lonely')).toHaveLength(0);
  });
});

describe('reinforceEdge', () => {
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'A' });
    graph.addNode({ id: 'b', name: 'B' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo, weight: 0.5 });
  });

  it('boosts edge weight', () => {
    const ok = graph.reinforceEdge('a', 'b', RelationshipType.RelatesTo, 0.2);
    expect(ok).toBe(true);
    const edges = graph.getEdges('a', 'outgoing');
    expect(edges[0].weight).toBeCloseTo(0.7);
  });

  it('caps weight at 1.0', () => {
    graph.reinforceEdge('a', 'b', RelationshipType.RelatesTo, 0.9);
    const edges = graph.getEdges('a', 'outgoing');
    expect(edges[0].weight).toBe(1.0);
  });

  it('returns false for non-existent edge', () => {
    expect(graph.reinforceEdge('a', 'b', RelationshipType.DependsOn)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tags & Properties
// ---------------------------------------------------------------------------

describe('tags', () => {
  it('addTag adds a tag to a node', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    graph.addTag('n1', 'test-tag');
    expect(graph.getTags('n1')).toContain('test-tag');
  });

  it('addTag is idempotent', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    graph.addTag('n1', 'tag');
    graph.addTag('n1', 'tag');
    expect(graph.getTags('n1')).toHaveLength(1);
  });

  it('getTags returns empty array for untagged node', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    expect(graph.getTags('n1')).toHaveLength(0);
  });
});

describe('properties', () => {
  beforeEach(() => {
    graph.addNode({ id: 'n1', name: 'Node' });
  });

  it('setProperty and getProperty roundtrip', () => {
    graph.setProperty('n1', 'color', 'blue');
    expect(graph.getProperty('n1', 'color')).toBe('blue');
  });

  it('setProperty upserts (replaces existing value)', () => {
    graph.setProperty('n1', 'color', 'blue');
    graph.setProperty('n1', 'color', 'red');
    expect(graph.getProperty('n1', 'color')).toBe('red');
  });

  it('getProperty returns null for non-existent key', () => {
    expect(graph.getProperty('n1', 'nonexistent')).toBeNull();
  });

  it('getProperties returns all properties', () => {
    graph.setProperty('n1', 'a', '1');
    graph.setProperty('n1', 'b', '2');
    const props = graph.getProperties('n1');
    expect(props).toEqual({ a: '1', b: '2' });
  });

  it('getProperties returns empty object for node with no properties', () => {
    expect(graph.getProperties('n1')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Subgraph Queries
// ---------------------------------------------------------------------------

describe('querySubgraph', () => {
  beforeEach(() => {
    graph.addNode({ id: 'center', name: 'Center', salience: 0.8 });
    graph.addNode({ id: 'neighbor', name: 'Neighbor', salience: 0.6 });
    graph.addNode({ id: 'far', name: 'Far', salience: 0.4 });
    graph.addEdge({ sourceId: 'center', targetId: 'neighbor', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'neighbor', targetId: 'far', relationship: RelationshipType.DependsOn });
  });

  it('returns seed nodes and edges at depth 0', () => {
    const sub = graph.querySubgraph({ depth: 0 });
    expect(sub.nodes.length).toBeGreaterThan(0);
  });

  it('expands neighborhood at depth 1', () => {
    // minSalience applies to BOTH seed and expanded nodes, so neighbor (0.6) must pass too
    const sub = graph.querySubgraph({ minSalience: 0.5, depth: 1 });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('center');
    expect(ids).toContain('neighbor');
  });

  it('collects edges between visible nodes', () => {
    const sub = graph.querySubgraph({ depth: 1 });
    expect(sub.edges.length).toBeGreaterThan(0);
  });

  it('sorts nodes by salience descending', () => {
    const sub = graph.querySubgraph({ depth: 2 });
    for (let i = 1; i < sub.nodes.length; i++) {
      expect(sub.nodes[i - 1].salience).toBeGreaterThanOrEqual(sub.nodes[i].salience);
    }
  });

  it('respects limit', () => {
    const sub = graph.querySubgraph({ limit: 1 });
    expect(sub.nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// querySubgraph traversal modes (PRUNE / SKIP)
// ---------------------------------------------------------------------------

describe('querySubgraph traversal modes', () => {
  // Graph: A ---> B(sensitive) ---> C
  //                                 ^-- reachable only through B
  beforeEach(() => {
    graph.addNode({ id: 'a', name: 'Node A', salience: 0.8, sensitivity: 0, sourceAgent: 'test' });
    graph.addNode({ id: 'b', name: 'Node B', salience: 0.7, sensitivity: 3, sourceAgent: 'other' });
    graph.addNode({ id: 'c', name: 'Node C', salience: 0.6, sensitivity: 0, sourceAgent: 'other' });
    graph.addEdge({ sourceId: 'a', targetId: 'b', relationship: RelationshipType.RelatesTo });
    graph.addEdge({ sourceId: 'b', targetId: 'c', relationship: RelationshipType.RelatesTo });
  });

  it('default mode is SKIP — excludes sensitive node but continues expansion', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2 });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).toContain('c');
  });

  it('PRUNE mode — excludes sensitive node AND stops expansion at that branch', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'prune' });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });

  it('SKIP mode — edges only between visible nodes', () => {
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 1, depth: 2, traversalMode: 'skip' });
    // B is not visible, so no edge should reference B
    for (const e of sub.edges) {
      expect(e.sourceId).not.toBe('b');
      expect(e.targetId).not.toBe('b');
    }
  });

  it('no ceiling returns all nodes as before', () => {
    const sub = graph.querySubgraph({ agent: 'test', depth: 2 });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('null sensitivity treated as level 0', () => {
    graph.addNode({ id: 'd', name: 'Node D', salience: 0.5, sourceAgent: 'test' }); // no sensitivity set
    graph.addEdge({ sourceId: 'a', targetId: 'd', relationship: RelationshipType.RelatesTo });
    const sub = graph.querySubgraph({ agent: 'test', ceiling: 0, depth: 1 });
    const ids = sub.nodes.map(n => n.id);
    expect(ids).toContain('d');
  });
});

// ---------------------------------------------------------------------------
// Homeostatic Operations
// ---------------------------------------------------------------------------

describe('decayAll', () => {
  it('decays salience of nodes', () => {
    // Add a node with old lastReinforced so decay kicks in
    const oldDate = new Date(Date.now() - 14 * 86_400_000).toISOString();
    graph.addNode({
      id: 'old',
      name: 'Old Node',
      salience: 0.8,
      lastReinforced: oldDate,
    });
    const count = graph.decayAll(0.1);
    expect(count).toBe(1);
    const node = graph.getNode('old')!;
    expect(node.salience).toBeLessThan(0.8);
  });

  it('does not decay recently reinforced nodes (much)', () => {
    graph.addNode({ id: 'fresh', name: 'Fresh', salience: 0.8 });
    graph.decayAll(0.1);
    const node = graph.getNode('fresh')!;
    // Recently created — decay should be minimal (within temporal kernel)
    expect(node.salience).toBeGreaterThan(0.7);
  });

  it('does not decay nodes below 0', () => {
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    graph.addNode({ id: 'low', name: 'Low', salience: 0.01, lastReinforced: oldDate });
    graph.decayAll(0.5);
    const node = graph.getNode('low')!;
    expect(node.salience).toBeGreaterThanOrEqual(0);
  });

  it('returns count of decayed nodes', () => {
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString();
    graph.addNode({ id: 'a', name: 'A', salience: 0.5, lastReinforced: old });
    graph.addNode({ id: 'b', name: 'B', salience: 0.5, lastReinforced: old });
    const count = graph.decayAll(0.1);
    expect(count).toBe(2);
  });
});

describe('prune', () => {
  it('removes low-salience old nodes', () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    graph.addNode({ id: 'stale', name: 'Stale', salience: 0.01, lastReinforced: old });
    const count = graph.prune(0.05, 30);
    expect(count).toBe(1);
    expect(graph.getNode('stale')).toBeNull();
  });

  it('does not prune high-salience nodes', () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    graph.addNode({ id: 'important', name: 'Important', salience: 0.9, lastReinforced: old });
    graph.prune(0.05, 30);
    expect(graph.getNode('important')).not.toBeNull();
  });

  it('does not prune recent low-salience nodes', () => {
    graph.addNode({ id: 'recent', name: 'Recent', salience: 0.01 });
    graph.prune(0.05, 30);
    expect(graph.getNode('recent')).not.toBeNull();
  });

  it('both conditions must hold (salience < threshold AND age > min)', () => {
    // High salience, old — should NOT be pruned
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    graph.addNode({ id: 'old-important', name: 'Old Important', salience: 0.9, lastReinforced: old });
    // Low salience, recent — should NOT be pruned
    graph.addNode({ id: 'new-low', name: 'New Low', salience: 0.01 });
    // Low salience, old — SHOULD be pruned
    graph.addNode({ id: 'stale', name: 'Stale', salience: 0.01, lastReinforced: old });

    const count = graph.prune(0.05, 30);
    expect(count).toBe(1);
    expect(graph.getNode('old-important')).not.toBeNull();
    expect(graph.getNode('new-low')).not.toBeNull();
    expect(graph.getNode('stale')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe('stats', () => {
  it('returns correct counts for empty graph', () => {
    const s = graph.stats();
    expect(s.nodeCount).toBe(0);
    expect(s.edgeCount).toBe(0);
    expect(s.tagCount).toBe(0);
    expect(s.avgSalience).toBe(0);
  });

  it('returns correct counts after adding data', () => {
    graph.addNode({ id: 'n1', name: 'A', type: NodeType.Bug, salience: 0.8, tags: ['t1'] });
    graph.addNode({ id: 'n2', name: 'B', type: NodeType.Bug, salience: 0.6, tags: ['t2'] });
    graph.addNode({ id: 'n3', name: 'C', type: NodeType.Person, salience: 0.4 });
    graph.addEdge({ sourceId: 'n1', targetId: 'n2', relationship: RelationshipType.RelatesTo });

    const s = graph.stats();
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(1);
    expect(s.tagCount).toBe(2);
    expect(s.typeDistribution[NodeType.Bug]).toBe(2);
    expect(s.typeDistribution[NodeType.Person]).toBe(1);
    expect(s.avgSalience).toBeCloseTo(0.6, 1);
  });
});

// ---------------------------------------------------------------------------
// Embedding stubs (without sqlite-vec)
// ---------------------------------------------------------------------------

describe('embedding operations (without sqlite-vec)', () => {
  it('hasEmbedding returns false when vec not available', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    expect(graph.hasEmbedding('n1')).toBe(false);
  });

  it('embeddingStats reports vecAvailable=false', () => {
    const stats = graph.embeddingStats();
    expect(stats.vecAvailable).toBe(false);
    expect(stats.embeddedNodes).toBe(0);
  });

  it('semanticSearch returns empty when vec not available', () => {
    const results = graph.semanticSearch(new Array(384).fill(0));
    expect(results).toHaveLength(0);
  });

  it('semanticSearch accepts ceiling parameter without error', () => {
    const results = graph.semanticSearch(new Array(384).fill(0), 20, undefined, undefined, 2);
    expect(results).toHaveLength(0);
  });

  it('upsertEmbedding does not throw when vec not available', () => {
    graph.addNode({ id: 'n1', name: 'Node' });
    expect(() => graph.upsertEmbedding('n1', new Array(384).fill(0))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extendForCode
// ---------------------------------------------------------------------------

describe('extendForCode', () => {
  it('adds code columns without error', () => {
    graph.extendForCode();
    const info = graph.db.pragma('table_info(nodes)') as Array<{ name: string }>;
    const cols = info.map(r => r.name);
    expect(cols).toContain('category');
    expect(cols).toContain('file_path');
    expect(cols).toContain('namespace');
  });

  it('is idempotent', () => {
    graph.extendForCode();
    expect(() => graph.extendForCode()).not.toThrow();
  });

  it('allows setting category and namespace on addNode after extension', () => {
    graph.extendForCode();
    const node = graph.addNode({
      id: 'code-node',
      name: 'MyClass',
      category: 'code',
      namespace: 'myapp',
    });
    expect(node.category).toBe('code');
    expect(node.namespace).toBe('myapp');
  });
});

// ---------------------------------------------------------------------------
// Classification (sensitivity)
// ---------------------------------------------------------------------------

describe('extendForClassification', () => {
  it('adds sensitivity columns to nodes', () => {
    graph.extendForClassification();
    const info = graph.db.pragma('table_info(nodes)') as Array<{ name: string }>;
    const cols = info.map(r => r.name);
    expect(cols).toContain('sensitivity');
    expect(cols).toContain('sensitivity_reason');
  });

  it('adds sensitivity columns to edges', () => {
    graph.extendForClassification();
    const info = graph.db.pragma('table_info(edges)') as Array<{ name: string }>;
    const cols = info.map(r => r.name);
    expect(cols).toContain('sensitivity');
    expect(cols).toContain('sensitivity_reason');
  });

  it('is idempotent', () => {
    graph.extendForClassification();
    expect(() => graph.extendForClassification()).not.toThrow();
  });

  it('allows setting sensitivity on addNode after extension', () => {
    graph.extendForClassification();
    const node = graph.addNode({
      id: 'sensitive-node',
      name: 'Secret Project',
      sensitivity: 3,
      sensitivityReason: 'contains credentials',
    });
    expect(node.sensitivity).toBe(3);
    expect(node.sensitivityReason).toBe('contains credentials');

    const retrieved = graph.getNode('sensitive-node');
    expect(retrieved!.sensitivity).toBe(3);
    expect(retrieved!.sensitivityReason).toBe('contains credentials');
  });

  it('allows updating sensitivity via updateNode', () => {
    graph.extendForClassification();
    graph.addNode({ id: 'n1', name: 'Node' });
    graph.updateNode('n1', { sensitivity: 2, sensitivityReason: 'internal only' });
    const node = graph.getNode('n1');
    expect(node!.sensitivity).toBe(2);
    expect(node!.sensitivityReason).toBe('internal only');
  });

  it('sensitivity defaults to 0 when not specified', () => {
    graph.extendForClassification();
    graph.addNode({ id: 'n1', name: 'Default Node' });
    const row = graph.db.prepare('SELECT sensitivity FROM nodes WHERE id = ?').get('n1') as { sensitivity: number };
    expect(row.sensitivity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('close does not throw', () => {
    const g = new KnowledgeGraph(':memory:');
    expect(() => g.close()).not.toThrow();
  });
});
