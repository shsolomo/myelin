/**
 * Tests for the `myelin sleep` command logic.
 *
 * Tests agent directory discovery and consolidation orchestration.
 * Does NOT test the CLI itself (Commander wiring), but tests the
 * underlying functions that sleep depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph } from '../../src/memory/graph.js';
import { nremReplay, remRefine } from '../../src/memory/replay.js';
import { writeLogEntry } from '../../src/memory/structured-log.js';

// Create a temp directory to simulate ~/.copilot/.working-memory/agents/
function createTempAgentsDir(): string {
  const base = join(tmpdir(), `myelin-sleep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tmpDbPath(): string {
  const dir = join(tmpdir(), 'myelin-sleep-test-db');
  mkdirSync(dir, { recursive: true });
  return join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent directory discovery
// ---------------------------------------------------------------------------

describe('agent directory discovery', () => {
  let agentsDir: string;

  afterEach(() => {
    if (agentsDir) cleanDir(agentsDir);
  });

  it('discovers agent directories from the agents folder', () => {
    agentsDir = createTempAgentsDir();
    mkdirSync(join(agentsDir, 'donna'), { recursive: true });
    mkdirSync(join(agentsDir, 'cajal'), { recursive: true });
    mkdirSync(join(agentsDir, 'hebb'), { recursive: true });

    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(agents).toContain('donna');
    expect(agents).toContain('cajal');
    expect(agents).toContain('hebb');
    expect(agents).toHaveLength(3);
  });

  it('returns empty array when agents directory is empty', () => {
    agentsDir = createTempAgentsDir();

    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(agents).toHaveLength(0);
  });

  it('ignores non-directory entries (files)', () => {
    agentsDir = createTempAgentsDir();
    mkdirSync(join(agentsDir, 'donna'), { recursive: true });
    writeFileSync(join(agentsDir, 'README.md'), 'not a directory');

    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(agents).toEqual(['donna']);
  });

  it('handles non-existent agents directory gracefully', () => {
    const fakeDir = join(tmpdir(), 'does-not-exist-' + Date.now());

    const agents = existsSync(fakeDir)
      ? readdirSync(fakeDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];

    expect(agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sleep consolidation cycle (NREM + REM per agent)
// ---------------------------------------------------------------------------

describe('sleep consolidation cycle', () => {
  let dbPath: string;
  let agentsDir: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    agentsDir = createTempAgentsDir();
  });

  afterEach(() => {
    cleanDb(dbPath);
    cleanDir(agentsDir);
  });

  it('consolidates logs for a single agent with NREM + REM', async () => {
    // Create agent log directory with a JSONL log
    const agentDir = join(agentsDir, 'testbot');
    mkdirSync(agentDir, { recursive: true });

    // Write a JSONL log file with correct structured-log format
    const logPath = join(agentDir, 'log.jsonl');
    const entries = [
      { ts: new Date().toISOString(), type: 'decision', summary: 'Use SQLite for storage', agent: 'testbot', detail: '', sessionId: '', tags: ['architecture'], context: {} },
      { ts: new Date().toISOString(), type: 'finding', summary: 'SQLite supports WAL mode for concurrent reads', agent: 'testbot', detail: '', sessionId: '', tags: ['performance'], context: {} },
    ];
    writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const graph = new KnowledgeGraph(dbPath);

    // NREM with LLM extraction path (extractFromEntry is deprecated, returns empty)
    // Test that NREM processes entries without crashing, even with no extraction
    const nrem = await nremReplay(graph, logPath, { agentName: 'testbot' });
    expect(nrem.entriesProcessed).toBeGreaterThanOrEqual(2);

    // Test LLM ingestion path directly (needs logPath so nremReplay doesn't short-circuit)
    const llmExtraction = JSON.stringify({
      entities: [
        { id: 'sqlite-storage', type: 'decision', name: 'Use SQLite', description: 'Chose SQLite for storage', salience: 0.8 },
      ],
      relationships: [],
    });
    const nremLlm = await nremReplay(graph, logPath, { agentName: 'testbot', llmExtractions: [llmExtraction] });
    expect(nremLlm.entitiesExtracted).toBe(1);

    // Run REM
    const rem = remRefine(graph);
    expect(rem.nodesDecayed).toBeGreaterThanOrEqual(0);

    // Verify graph has the LLM-extracted node
    const stats = graph.stats();
    expect(stats.nodeCount).toBeGreaterThan(0);

    graph.close();
  });

  it('consolidates multiple agents sequentially', async () => {
    const graph = new KnowledgeGraph(dbPath);

    // Agent 1
    const agent1Dir = join(agentsDir, 'alpha');
    mkdirSync(agent1Dir, { recursive: true });
    const log1 = join(agent1Dir, 'log.jsonl');
    writeFileSync(log1, JSON.stringify({
      ts: new Date().toISOString(), type: 'action', summary: 'Alpha deployed the service', agent: 'alpha', detail: '', sessionId: '', tags: ['deploy'], context: {},
    }) + '\n');

    // Agent 2
    const agent2Dir = join(agentsDir, 'beta');
    mkdirSync(agent2Dir, { recursive: true });
    const log2 = join(agent2Dir, 'log.jsonl');
    writeFileSync(log2, JSON.stringify({
      ts: new Date().toISOString(), type: 'finding', summary: 'Beta found a performance bottleneck', agent: 'beta', detail: '', sessionId: '', tags: ['perf'], context: {},
    }) + '\n');

    // Consolidate both agents
    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    let totalProcessed = 0;
    for (const agent of agents) {
      const logPath = join(agentsDir, agent, 'log.jsonl');
      if (existsSync(logPath)) {
        const nrem = await nremReplay(graph, logPath, { agentName: agent });
        totalProcessed += nrem.entriesProcessed;
      }
    }

    const rem = remRefine(graph);

    // Both agents' entries were processed
    expect(totalProcessed).toBeGreaterThanOrEqual(2);

    graph.close();
  });

  it('skips agents without log files', async () => {
    const graph = new KnowledgeGraph(dbPath);

    // Agent with log
    const withLog = join(agentsDir, 'active');
    mkdirSync(withLog, { recursive: true });
    writeFileSync(join(withLog, 'log.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), type: 'action', summary: 'Active agent did work', agent: 'active', detail: '', sessionId: '', tags: ['work'], context: {},
    }) + '\n');

    // Agent without log
    mkdirSync(join(agentsDir, 'empty'), { recursive: true });

    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    let processedCount = 0;
    for (const agent of agents) {
      const logPath = join(agentsDir, agent, 'log.jsonl');
      if (existsSync(logPath)) {
        await nremReplay(graph, logPath, { agentName: agent });
        processedCount++;
      }
    }

    expect(processedCount).toBe(1);
    expect(agents).toHaveLength(2);

    graph.close();
  });

  it('REM phase handles empty graph gracefully', () => {
    const graph = new KnowledgeGraph(dbPath);

    // REM on empty graph should not throw
    const rem = remRefine(graph);
    expect(rem.nodesDecayed).toBe(0);
    expect(rem.nodesPruned).toBe(0);
    expect(rem.edgesPruned).toBe(0);

    graph.close();
  });
});
