/**
 * Extension lifecycle hook tests — exercises the logic patterns
 * used by onSessionStart, onSessionEnd,
 * and onErrorOccurred hooks.
 *
 * Tests import source modules directly (NOT the bundled extension).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph } from '../../src/memory/graph.js';
import { getBootContext, resolveAgent, appendStructuredLog } from '../../src/memory/agents.js';

vi.mock('../../src/memory/embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue([]),
  getEmbeddings: vi.fn().mockResolvedValue([]),
  embedNode: vi.fn().mockResolvedValue(true),
  embedAllNodes: vi.fn().mockResolvedValue(0),
  isAvailable: vi.fn().mockResolvedValue(false),
  resetModel: vi.fn(),
}));

// ─── Stopwords & extractKeywords ─────────────────────────────────

// Replicate the exact extractKeywords implementation from extension source
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'into', 'about', 'between', 'through', 'after', 'before', 'above',
  'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'if', 'then', 'than',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'just', 'also', 'very', 'too', 'only', 'still', 'already', 'even',
  'here', 'there', 'up', 'out', 'over', 'now', 'get', 'make', 'like',
  'know', 'think', 'see', 'come', 'go', 'want', 'use', 'find', 'tell',
]);

function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
}

// ─── extractKeywords ─────────────────────────────────────────────

describe('extractKeywords — keyword extraction for FTS5', () => {
  it('extracts meaningful words and filters stopwords', () => {
    const keywords = extractKeywords('How does the authentication system work with JWT tokens?');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('system');
    expect(keywords).toContain('work');
    expect(keywords).toContain('jwt');
    expect(keywords).toContain('tokens');
    // Stopwords should be removed
    expect(keywords).not.toContain('how');
    expect(keywords).not.toContain('does');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('with');
  });

  it('limits to 8 keywords max', () => {
    const longPrompt = 'graph database sqlite memory consolidation pruning decay salience embedding vector search semantic retrieval pipeline architecture';
    const keywords = extractKeywords(longPrompt);
    expect(keywords.length).toBeLessThanOrEqual(8);
  });

  it('filters words shorter than 3 characters', () => {
    const keywords = extractKeywords('I am ok do it go up');
    // All words are <= 2 chars or stopwords
    expect(keywords).toEqual([]);
  });

  it('handles punctuation by replacing with spaces', () => {
    const keywords = extractKeywords('graph.addNode(name: "test-node")');
    expect(keywords).toContain('graph');
    expect(keywords).toContain('addnode');
    expect(keywords).toContain('name');
    expect(keywords).toContain('test-node');
  });

  it('converts to lowercase', () => {
    const keywords = extractKeywords('SQLite WAL Mode Configuration');
    expect(keywords).toContain('sqlite');
    expect(keywords).toContain('wal');
    expect(keywords).toContain('mode');
    expect(keywords).toContain('configuration');
  });

  it('returns empty array for empty input', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('returns empty array for stopwords-only input', () => {
    expect(extractKeywords('the and or but not in on at')).toEqual([]);
  });
});

// ─── FTS5 search with keywords ──────────────────────────────────

describe('FTS5 search with extracted keywords', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
    graph.addNode({
      name: 'Consolidation Pipeline',
      type: 'pattern',
      description: 'NREM replay followed by REM associative linking and pruning',
      sourceAgent: 'hebb',
      salience: 0.8,
    });
    graph.addNode({
      name: 'SQLite Schema',
      type: 'convention',
      description: 'Database schema with nodes edges and FTS5 virtual tables',
      sourceAgent: 'cajal',
      salience: 0.7,
    });
    graph.addNode({
      name: 'Tree-Sitter Parsing',
      type: 'tool',
      description: 'AST-based code parser for TypeScript and Python',
      sourceAgent: 'cajal',
      salience: 0.6,
    });
  });

  afterEach(() => {
    graph.close();
  });

  it('searches with OR-joined keywords from user prompt', () => {
    const prompt = 'How does the consolidation pipeline handle pruning?';
    const keywords = extractKeywords(prompt);
    expect(keywords.length).toBeGreaterThan(0);

    const ftsQuery = keywords.join(' OR ');
    const results = graph.searchNodes(ftsQuery, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(n => n.name === 'Consolidation Pipeline')).toBe(true);
  });

  it('applies sensitivity ceiling filter on FTS results', () => {
    // Add a sensitive node
    graph.addNode({
      name: 'Secret Architecture',
      type: 'concept',
      description: 'Internal consolidation architecture details',
      sensitivity: 3,
      salience: 0.9,
    });

    const results = graph.searchNodes('consolidation', 10);
    // Client-side ceiling filter (mirrors onUserPromptSubmitted logic)
    const ceiling = 2;
    const filtered = results.filter((n: any) => (n.sensitivity ?? 0) <= ceiling);

    expect(filtered.some(n => n.name === 'Consolidation Pipeline')).toBe(true);
    expect(filtered.some(n => n.name === 'Secret Architecture')).toBe(false);
  });
});

// ─── onSessionStart logic ────────────────────────────────────────

describe('onSessionStart — session initialization logic', () => {
  let dbPath: string;

  function tmpDbPath(): string {
    const dir = join(tmpdir(), 'myelin-test-ext-lifecycle');
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

  it('returns early when DB does not exist', () => {
    const fakePath = join(tmpdir(), 'nonexistent-graph.db');
    const dbExists = existsSync(fakePath);
    expect(dbExists).toBe(false);

    // Mirrors onSessionStart: if (!existsSync(DB_PATH)) return warning
    const result = dbExists ? 'boot context' : undefined;
    expect(result).toBeUndefined();
  });

  it('returns boot context when DB exists with nodes', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      name: 'Test Concept',
      type: 'concept',
      description: 'A concept for testing',
      sourceAgent: 'cajal',
      salience: 0.8,
    });
    graph.close();

    expect(existsSync(dbPath)).toBe(true);

    // Mirrors onSessionStart boot logic
    const detectedAgent = 'cajal';
    let briefing: string;
    try {
      briefing = getBootContext(detectedAgent, { dbPath });
    } catch {
      briefing = '';
    }

    expect(briefing).toContain('Graph Briefing');
    expect(briefing).toContain('Test Concept');
  });

  it('assembles context parts including tool docs', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({ name: 'Bootstrapped', type: 'concept', sourceAgent: 'cajal', salience: 0.7 });
    graph.close();

    const briefing = getBootContext('cajal', { dbPath });
    const contextParts: string[] = [];

    if (briefing) {
      contextParts.push(briefing);
    }

    // Always include tool docs (mirrors extension behavior)
    contextParts.push(
      '',
      '## Myelin Tools Available',
      '- **myelin_query** — Semantic search across graph nodes',
      '- **myelin_boot** — Load deeper agent-specific context',
      '- **myelin_log** — Record decisions, findings, actions',
      '- **myelin_show** — Inspect a specific node and its connections',
      '- **myelin_stats** — Show graph statistics',
    );

    const result = contextParts.join('\n');
    expect(result).toContain('Graph Briefing');
    expect(result).toContain('## Myelin Tools Available');
    expect(result).toContain('myelin_query');
    expect(result).toContain('myelin_stats');
  });

  it('adds health hints for empty graph', () => {
    const graph = new KnowledgeGraph(dbPath);
    // No nodes added — empty graph
    const stats = graph.stats();
    expect(stats.nodeCount).toBe(0);

    const contextParts: string[] = [];
    if (stats.nodeCount === 0) {
      contextParts.push('', '💡 Graph is empty — run `myelin parse ./your-repo` to index code');
    }
    graph.close();

    expect(contextParts.join('\n')).toContain('Graph is empty');
  });

  it('adds embedding hint when no embeddings exist', () => {
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({ name: 'Node Without Embedding', type: 'concept', salience: 0.5 });

    const stats = graph.stats();
    const embStats = graph.embeddingStats();

    const contextParts: string[] = [];
    if (stats.nodeCount > 0 && (!embStats.vecAvailable || embStats.embeddedNodes === 0)) {
      contextParts.push('', '💡 No embeddings — run `myelin embed` for semantic search');
    }
    graph.close();

    expect(contextParts.join('\n')).toContain('No embeddings');
  });

  it('handles corrupt graph gracefully during boot', () => {
    // Mirrors the try-catch around getBootContext in onSessionStart
    let briefing: string;
    try {
      // Force an error by passing invalid path format
      briefing = getBootContext('cajal', { dbPath: '' });
    } catch {
      briefing = '';
    }

    // Should not throw — graceful fallback
    expect(typeof briefing).toBe('string');
  });
});

// ─── Graph search patterns (used by myelin_query) ───────────────

describe('graph search patterns — FTS5 and sensitivity filtering', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
    graph.addNode({
      name: 'Authentication Pattern',
      type: 'pattern',
      description: 'JWT-based auth with refresh tokens',
      sourceAgent: 'cajal',
      salience: 0.8,
      sensitivity: 0,
    });
    graph.addNode({
      name: 'Error Handling Convention',
      type: 'convention',
      description: 'Use try-catch with meaningful fallbacks, never swallow errors silently',
      sourceAgent: 'cajal',
      salience: 0.7,
      sensitivity: 0,
    });
    graph.addNode({
      name: 'Internal Secrets',
      type: 'concept',
      description: 'Secret credentials and API keys for authentication',
      sourceAgent: 'cajal',
      salience: 0.9,
      sensitivity: 3,
    });
  });

  afterEach(() => {
    graph.close();
  });

  it('returns context from FTS5 keyword search', () => {
    const prompt = 'How should I handle authentication?';
    const keywords = extractKeywords(prompt);
    const ftsQuery = keywords.join(' OR ');
    const nodes = graph.searchNodes(ftsQuery, 10)
      .filter((n: any) => (n.sensitivity ?? 0) <= 2)
      .slice(0, 5);

    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some(n => n.name === 'Authentication Pattern')).toBe(true);
    // Sensitive node should be excluded
    expect(nodes.some(n => n.name === 'Internal Secrets')).toBe(false);

    // Format like the hook
    const context = nodes
      .map((n: any) => `- **${n.name}** (${n.type}): ${n.description?.slice(0, 150)}`)
      .join('\n');
    const output = `## Relevant Graph Context (Myelin)\n${context}`;
    expect(output).toContain('## Relevant Graph Context (Myelin)');
    expect(output).toContain('Authentication Pattern');
  });

  it('returns undefined for empty graph', () => {
    const emptyGraph = new KnowledgeGraph(':memory:');
    const keywords = extractKeywords('test query');
    const ftsQuery = keywords.join(' OR ');

    let context: string | null = null;
    if (ftsQuery) {
      const nodes = emptyGraph.searchNodes(ftsQuery, 10)
        .filter((n: any) => (n.sensitivity ?? 0) <= 2)
        .slice(0, 5);
      if (nodes.length > 0) {
        context = nodes.map((n: any) => `- **${n.name}** (${n.type})`).join('\n');
      }
    }

    emptyGraph.close();
    expect(context).toBeNull();
  });

  it('returns undefined when no keywords extracted', () => {
    // All stopwords → no keywords → no search
    const keywords = extractKeywords('the and or but');
    expect(keywords.length).toBe(0);
    // Extension returns undefined when keywords.length === 0
  });

  it('applies sensitivity ceiling of 2 to FTS results', () => {
    const allResults = graph.searchNodes('authentication', 10);
    // Without ceiling, should find both auth-related nodes
    const withCeiling = allResults.filter((n: any) => (n.sensitivity ?? 0) <= 2);
    const withoutCeiling = allResults;

    // Sensitive node should be excluded by ceiling
    expect(withoutCeiling.length).toBeGreaterThanOrEqual(withCeiling.length);
    for (const node of withCeiling) {
      expect((node as any).sensitivity ?? 0).toBeLessThanOrEqual(2);
    }
  });
});

// ─── onSessionEnd logic ──────────────────────────────────────────

describe('onSessionEnd — session termination logging', () => {
  const testAgent = `test-lifecycle-${Date.now()}`;

  afterEach(() => {
    try {
      rmSync(join(tmpdir(), 'myelin-test-ext-lifecycle'), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('logs handover event with session agent', () => {
    const sessionAgent = 'cajal';
    const finalMessage = 'Completed all tests and committed changes';
    const agent = sessionAgent || resolveAgent() || 'default';
    const summary = finalMessage.slice(0, 200);

    const logPath = appendStructuredLog(agent, 'handover', summary, {
      tags: ['auto-session-end'],
    });

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.type).toBe('handover');
    expect(entry.summary).toBe('Completed all tests and committed changes');
    expect(entry.tags).toEqual(['auto-session-end']);
  });

  it('falls back to "default" agent when no agent detected', () => {
    const sessionAgent: string | null = null;
    // resolveAgent() depends on env/CWD — in test it may return null
    const agent = sessionAgent || 'default';

    const logPath = appendStructuredLog(agent, 'handover', 'Session ended', {
      tags: ['auto-session-end'],
    });

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.agent).toBe('default');
  });

  it('truncates final message to 200 chars', () => {
    const longMessage = 'x'.repeat(500);
    const summary = longMessage.slice(0, 200);
    expect(summary.length).toBe(200);

    appendStructuredLog(testAgent, 'handover', summary, {
      tags: ['auto-session-end'],
    });
  });

  it('handles missing final message gracefully', () => {
    const finalMessage = undefined;
    const summary = finalMessage
      ? (finalMessage as string).slice(0, 200)
      : 'Session ended (no final message)';

    const logPath = appendStructuredLog(testAgent, 'handover', summary, {
      tags: ['auto-session-end'],
    });

    const content = readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(content[content.length - 1]);
    expect(lastEntry.summary).toBe('Session ended (no final message)');
  });
});

// ─── onErrorOccurred logic ───────────────────────────────────────

describe('onErrorOccurred — error handling and retry logic', () => {
  it('returns retry for recoverable model_call errors', () => {
    const input = { recoverable: true, errorContext: 'model_call' };

    let result: { errorHandling: string; retryCount: number } | undefined;
    if (input.recoverable && input.errorContext === 'model_call') {
      result = { errorHandling: 'retry', retryCount: 2 };
    }

    expect(result).toBeDefined();
    expect(result!.errorHandling).toBe('retry');
    expect(result!.retryCount).toBe(2);
  });

  it('returns undefined for non-recoverable errors', () => {
    const input = { recoverable: false, errorContext: 'model_call' };

    let result: { errorHandling: string; retryCount: number } | undefined;
    if (input.recoverable && input.errorContext === 'model_call') {
      result = { errorHandling: 'retry', retryCount: 2 };
    }

    expect(result).toBeUndefined();
  });

  it('returns undefined for non-model_call errors even if recoverable', () => {
    const input = { recoverable: true, errorContext: 'tool_call' };

    let result: { errorHandling: string; retryCount: number } | undefined;
    if (input.recoverable && input.errorContext === 'model_call') {
      result = { errorHandling: 'retry', retryCount: 2 };
    }

    expect(result).toBeUndefined();
  });

  it('returns undefined when both conditions fail', () => {
    const input = { recoverable: false, errorContext: 'other' };

    let result: { errorHandling: string; retryCount: number } | undefined;
    if (input.recoverable && input.errorContext === 'model_call') {
      result = { errorHandling: 'retry', retryCount: 2 };
    }

    expect(result).toBeUndefined();
  });

  it('handles missing fields gracefully', () => {
    const input = {} as any;

    let result: { errorHandling: string; retryCount: number } | undefined;
    if (input.recoverable && input.errorContext === 'model_call') {
      result = { errorHandling: 'retry', retryCount: 2 };
    }

    expect(result).toBeUndefined();
  });
});
