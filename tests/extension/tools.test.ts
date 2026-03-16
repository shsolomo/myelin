/**
 * Extension tool handler tests — exercises the graph operations
 * that the myelin_query, myelin_boot, myelin_log, myelin_show,
 * and myelin_stats tool handlers perform.
 *
 * Tests import source modules directly (NOT the bundled extension).
 * Uses mocked homedir to avoid polluting real agent logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect agent log writes to a temp directory
const TEST_LOG_DIR = join(tmpdir(), `myelin-test-tools-${Date.now()}`);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    homedir: () => TEST_LOG_DIR,
  };
});

vi.mock('../../src/memory/embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue([]),
  getEmbeddings: vi.fn().mockResolvedValue([]),
  embedNode: vi.fn().mockResolvedValue(true),
  embedAllNodes: vi.fn().mockResolvedValue(0),
  isAvailable: vi.fn().mockResolvedValue(false),
  resetModel: vi.fn(),
}));

// Dynamic imports — must come after TEST_LOG_DIR is initialized
// so structured-log.ts sees the mocked homedir during module load
const { KnowledgeGraph } = await import('../../src/memory/graph.js');
const { getBootContext, appendStructuredLog } = await import('../../src/memory/agents.js');

beforeEach(() => {
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_LOG_DIR)) {
    try { rmSync(TEST_LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── myelin_query ────────────────────────────────────────────────

describe('myelin_query — graph search operations', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('searchNodes returns matching nodes via FTS5', () => {
    graph.addNode({
      name: 'JWT Authentication',
      type: 'convention',
      description: 'Use JSON Web Tokens for API authentication',
      sourceAgent: 'cajal',
      salience: 0.8,
    });
    graph.addNode({
      name: 'SQLite WAL Mode',
      type: 'convention',
      description: 'Always enable WAL journal mode for concurrent reads',
      sourceAgent: 'cajal',
      salience: 0.6,
    });

    const results = graph.searchNodes('authentication', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('JWT Authentication');
  });

  it('searchNodes returns empty array for no matches', () => {
    graph.addNode({ name: 'Unrelated Node', description: 'Nothing relevant here' });
    const results = graph.searchNodes('xyznonexistent', 10);
    expect(results).toEqual([]);
  });

  it('FTS5 ceiling filter excludes sensitive nodes (client-side)', () => {
    graph.addNode({
      name: 'Public Config',
      type: 'convention',
      description: 'Public configuration pattern',
      sensitivity: 0,
    });
    graph.addNode({
      name: 'Secret Config',
      type: 'convention',
      description: 'Secret configuration with credentials',
      sensitivity: 3,
    });

    const allNodes = graph.searchNodes('config', 20);
    expect(allNodes.length).toBe(2);

    // Client-side ceiling filter (mirrors extension behavior)
    const ceiling = 1;
    const filtered = allNodes.filter((n: any) => (n.sensitivity ?? 0) <= ceiling);
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe('Public Config');
  });

  it('search result can be formatted like tool output', () => {
    graph.addNode({
      name: 'Consolidation Pipeline',
      type: 'pattern',
      description: 'NREM replay followed by REM pruning',
      salience: 0.75,
      sourceAgent: 'hebb',
    });

    const nodes = graph.searchNodes('consolidation', 10);
    expect(nodes.length).toBe(1);

    // Format like myelin_query tool handler
    const lines = nodes.map(
      n => `${n.type} | ${n.name} (${n.salience.toFixed(2)}) — ${n.description?.slice(0, 100)}`
    );
    const output = `FTS5 search: 'consolidation' (ceiling=1)\n${lines.join('\n')}`;
    expect(output).toContain('pattern | Consolidation Pipeline');
    expect(output).toContain('0.75');
    expect(output).toContain('NREM replay');
  });
});

// ─── myelin_query — null graph ───────────────────────────────────

describe('myelin_query — null graph behavior', () => {
  it('returns appropriate message when graph is null', () => {
    // Mirrors getGraph() returning null when DB doesn't exist
    const graph: KnowledgeGraph | null = null;
    const message = graph ? 'results' : 'No graph database found. Run `myelin init` first.';
    expect(message).toBe('No graph database found. Run `myelin init` first.');
  });
});

// ─── myelin_boot ─────────────────────────────────────────────────

describe('myelin_boot — boot context generation', () => {
  let dbPath: string;

  function tmpDbPath(): string {
    const dir = join(tmpdir(), 'myelin-test-ext-tools');
    mkdirSync(dir, { recursive: true });
    return join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  function cleanDb(path: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = path + suffix;
      if (existsSync(p)) {
        try { rmSync(p); } catch { /* ignore */ }
      }
    }
  }

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    cleanDb(dbPath);
  });

  it('returns briefing with agent-specific nodes', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      name: 'Graph Core',
      type: 'concept',
      description: 'SQLite-backed knowledge graph',
      sourceAgent: 'cajal',
      salience: 0.9,
    });
    graph.addNode({
      name: 'Sprint Planning',
      type: 'meeting',
      description: 'Weekly sprint ceremony',
      sourceAgent: 'donna',
      salience: 0.7,
    });
    graph.close();

    const context = getBootContext('cajal', { dbPath });
    expect(context).toContain('Graph Briefing');
    expect(context).toContain('cajal');
    expect(context).toContain('Graph Core');
  });

  it('returns fallback when no nodes exist', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.close();

    const context = getBootContext('cajal', { dbPath });
    expect(context).toContain('No graph nodes found');
  });

  it('includes pinned nodes regardless of agent', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      name: 'Critical Rule',
      type: 'rule',
      description: 'Always run tests before committing',
      sourceAgent: 'hebb',
      salience: 0.95,
      pinned: true,
    });
    graph.close();

    const context = getBootContext('cajal', { dbPath });
    expect(context).toContain('Critical Rule');
  });

  it('respects sensitivity ceiling in boot context', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      name: 'Public Knowledge',
      type: 'concept',
      description: 'Widely shared info',
      sourceAgent: 'cajal',
      salience: 0.8,
      sensitivity: 0,
    });
    graph.addNode({
      name: 'Classified Info',
      type: 'concept',
      description: 'Top secret data',
      sourceAgent: 'cajal',
      salience: 0.9,
      sensitivity: 3,
    });
    graph.close();

    // Boot context uses ceiling: 1 — should exclude sensitivity 3 nodes
    const context = getBootContext('cajal', { dbPath });
    expect(context).toContain('Public Knowledge');
    expect(context).not.toContain('Classified Info');
  });
});

// ─── myelin_log ──────────────────────────────────────────────────

describe('myelin_log — structured log writing', () => {
  const testAgent = `test-agent-${Date.now()}`;

  it('appendStructuredLog writes JSONL entry and returns file path', () => {
    const logPath = appendStructuredLog(testAgent, 'action', 'Implemented feature X', {
      tags: ['feature', 'sprint'],
    });

    expect(logPath).toBeTruthy();
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.agent).toBe(testAgent);
    expect(entry.type).toBe('action');
    expect(entry.summary).toBe('Implemented feature X');
    expect(entry.tags).toEqual(['feature', 'sprint']);
  });

  it('appendStructuredLog handles tag parsing like extension handler', () => {
    // Extension handler splits comma-separated tags string
    const tagsInput = 'feature, ci, test';
    const tags = tagsInput.split(',').map((t: string) => t.trim());
    expect(tags).toEqual(['feature', 'ci', 'test']);

    const logPath = appendStructuredLog(testAgent, 'decision', 'Chose approach B', { tags });
    const content = readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(content[content.length - 1]);
    expect(lastEntry.tags).toEqual(['feature', 'ci', 'test']);
  });

  it('appendStructuredLog includes sensitivity context when provided', () => {
    // Mirrors extension handler's context assembly
    const context: Record<string, unknown> = {};
    context.sensitivity = 2;
    context.sensitivityReason = 'Contains internal architecture';

    const logPath = appendStructuredLog(testAgent, 'finding', 'Found security gap', {
      tags: ['security'],
      context: Object.keys(context).length > 0 ? context : undefined,
    });

    const content = readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(content[content.length - 1]);
    expect(lastEntry.context.sensitivity).toBe(2);
    expect(lastEntry.context.sensitivityReason).toBe('Contains internal architecture');
  });
});

// ─── myelin_show ─────────────────────────────────────────────────

describe('myelin_show — node inspection with edges', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('returns node details with outgoing and incoming edges', () => {
    const nodeA = graph.addNode({
      name: 'KnowledgeGraph',
      type: 'concept',
      description: 'Core graph data structure',
      sourceAgent: 'cajal',
      salience: 0.9,
      tags: ['core', 'graph'],
    });
    const nodeB = graph.addNode({
      name: 'SQLite',
      type: 'tool',
      description: 'Embedded database engine',
      sourceAgent: 'cajal',
    });
    const nodeC = graph.addNode({
      name: 'Consolidation',
      type: 'pattern',
      description: 'Memory consolidation pipeline',
      sourceAgent: 'hebb',
    });

    graph.addEdge({ sourceId: nodeA.id, targetId: nodeB.id, relationship: 'depends_on' });
    graph.addEdge({ sourceId: nodeC.id, targetId: nodeA.id, relationship: 'relates_to' });

    // Replicate myelin_show handler logic
    const nodes = graph.searchNodes('KnowledgeGraph', 1);
    expect(nodes.length).toBe(1);
    const node = nodes[0];

    const edges = graph.getEdges(node.id);
    const tags = graph.getTags(node.id);

    expect(tags).toContain('core');
    expect(tags).toContain('graph');
    expect(edges.length).toBe(2);

    // Format output like the tool handler
    let result = `${node.type} | ${node.name}\n`;
    result += `Salience: ${node.salience.toFixed(2)} | Agent: ${node.sourceAgent}\n`;
    result += `Description: ${node.description}\n`;
    if (tags.length > 0) result += `Tags: ${tags.join(', ')}\n`;
    if (edges.length > 0) {
      result += `\nConnections (${edges.length}):\n`;
      for (const e of edges) {
        const target = e.sourceId === node.id ? e.targetId : e.sourceId;
        const dir = e.sourceId === node.id ? '→' : '←';
        const other = graph.getNode(target);
        result += `  ${dir} ${e.relationship}: ${other?.name ?? target}\n`;
      }
    }

    expect(result).toContain('concept | KnowledgeGraph');
    expect(result).toContain('Salience: 0.90');
    expect(result).toContain('Tags: core, graph');
    expect(result).toContain('→ depends_on: SQLite');
    expect(result).toContain('← relates_to: Consolidation');
  });

  it('returns no-match message for unknown node', () => {
    const nodes = graph.searchNodes('nonexistent-node-xyz', 1);
    expect(nodes.length).toBe(0);
    const message = nodes.length === 0 ? "No node matching 'nonexistent-node-xyz'" : '';
    expect(message).toBe("No node matching 'nonexistent-node-xyz'");
  });
});

// ─── myelin_stats ────────────────────────────────────────────────

describe('myelin_stats — graph statistics', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('returns correct node and edge counts', () => {
    graph.addNode({ name: 'Node A', type: 'concept', salience: 0.8 });
    graph.addNode({ name: 'Node B', type: 'person', salience: 0.6 });
    graph.addNode({ name: 'Node C', type: 'concept', salience: 0.4 });

    const nodeA = graph.searchNodes('Node A', 1)[0];
    const nodeB = graph.searchNodes('Node B', 1)[0];
    graph.addEdge({ sourceId: nodeA.id, targetId: nodeB.id, relationship: 'relates_to' });

    const stats = graph.stats();
    expect(stats.nodeCount).toBe(3);
    expect(stats.edgeCount).toBe(1);
    expect(stats.typeDistribution['concept']).toBe(2);
    expect(stats.typeDistribution['person']).toBe(1);
  });

  it('computes average salience correctly', () => {
    graph.addNode({ name: 'High', salience: 0.9 });
    graph.addNode({ name: 'Low', salience: 0.3 });

    const stats = graph.stats();
    expect(stats.avgSalience).toBeCloseTo(0.6, 1);
  });

  it('returns zero counts for empty graph', () => {
    const stats = graph.stats();
    expect(stats.nodeCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.avgSalience).toBe(0);
  });

  it('formats output like the stats tool handler', () => {
    graph.addNode({ name: 'Alpha', type: 'concept', salience: 0.7 });
    graph.addNode({ name: 'Beta', type: 'pattern', salience: 0.5 });

    const stats = graph.stats();
    const embStats = graph.embeddingStats();

    const output = [
      `Nodes: ${stats.nodeCount}`,
      `Edges: ${stats.edgeCount}`,
      `Avg salience: ${stats.avgSalience}`,
      `Embedded: ${embStats.embeddedNodes}/${embStats.totalNodes} (${embStats.coveragePct.toFixed(1)}%)`,
      `Type distribution:`,
      ...Object.entries(stats.typeDistribution).map(([t, c]) => `  ${t}: ${c}`),
    ].join('\n');

    expect(output).toContain('Nodes: 2');
    expect(output).toContain('Edges: 0');
    expect(output).toContain('Type distribution:');
    expect(output).toContain('concept: 1');
    expect(output).toContain('pattern: 1');
  });
});
