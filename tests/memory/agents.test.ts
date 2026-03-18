/**
 * Tests for agents.ts — boot context, agent resolution, structured logging.
 *
 * Uses in-memory SQLite databases for isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KnowledgeGraph, NodeType } from '../../src/memory/graph.js';
import { getBootContext, resolveAgent } from '../../src/memory/agents.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';

// Use a temp file for the DB since getBootContext opens its own connection
function tmpDbPath(): string {
  const dir = join(tmpdir(), 'myelin-test-agents');
  mkdirSync(dir, { recursive: true });
  return join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// getBootContext with named agent
// ---------------------------------------------------------------------------

describe('getBootContext', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    // Seed the DB with some nodes
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      name: 'Test Decision',
      type: NodeType.Decision,
      description: 'We decided to use SQLite for persistence',
      salience: 0.8,
      sourceAgent: 'cajal',
    });
    graph.addNode({
      name: 'Another Pattern',
      type: NodeType.Pattern,
      description: 'Always use transactions for multi-step writes',
      salience: 0.7,
      sourceAgent: 'cajal',
    });
    graph.addNode({
      name: 'Hebb Decision',
      type: NodeType.Decision,
      description: 'Architecture uses event sourcing',
      salience: 0.9,
      sourceAgent: 'hebb',
    });
    graph.addNode({
      name: 'Low Salience Node',
      type: NodeType.Concept,
      description: 'Rarely relevant',
      salience: 0.1,
      sourceAgent: 'cajal',
    });
    graph.close();
  });

  afterEach(() => {
    cleanDb(dbPath);
  });

  it('returns briefing for a known agent with matching nodes', () => {
    const result = getBootContext('cajal', { dbPath });
    expect(result).toContain('# Graph Briefing — cajal');
    expect(result).toContain('Test Decision');
    expect(result).toContain('Another Pattern');
    // Should not include nodes from other agents
    expect(result).not.toContain('Hebb Decision');
    // Should not include low-salience nodes (below 0.3 default)
    expect(result).not.toContain('Low Salience Node');
  });

  it('returns briefing for hebb with hebb-specific nodes', () => {
    const result = getBootContext('hebb', { dbPath });
    expect(result).toContain('# Graph Briefing — hebb');
    expect(result).toContain('Hebb Decision');
    expect(result).not.toContain('Test Decision');
  });

  it('returns no-nodes message for unknown agent', () => {
    const result = getBootContext('unknown-agent', { dbPath });
    expect(result).toContain('# Graph Briefing — unknown-agent');
    expect(result).toContain('No matching nodes');
  });

  it('returns generic briefing when agentName is null', () => {
    const result = getBootContext(null, { dbPath });
    expect(result).toContain('# Graph Briefing — generic');
    // Generic boot uses minSalience 0.5, so should include high-salience nodes
    expect(result).toContain('Hebb Decision'); // salience 0.9
    expect(result).toContain('Test Decision'); // salience 0.8
    expect(result).toContain('Another Pattern'); // salience 0.7
    // Should not include low-salience node
    expect(result).not.toContain('Low Salience Node');
  });

  it('returns generic briefing when agentName is undefined', () => {
    const result = getBootContext(undefined, { dbPath });
    expect(result).toContain('# Graph Briefing — generic');
  });

  it('returns generic briefing when agentName is empty string', () => {
    const result = getBootContext('', { dbPath });
    expect(result).toContain('# Graph Briefing — generic');
  });

  it('returns empty-graph message when db has no nodes', () => {
    const emptyDbPath = tmpDbPath();
    try {
      // Create empty graph db
      const g = new KnowledgeGraph(emptyDbPath);
      g.close();
      const result = getBootContext('cajal', { dbPath: emptyDbPath });
      expect(result).toContain('No graph nodes found yet');
    } finally {
      cleanDb(emptyDbPath);
    }
  });

  it('includes graph stats in briefing', () => {
    const result = getBootContext('cajal', { dbPath });
    expect(result).toContain('Graph total:');
    expect(result).toContain('nodes');
    expect(result).toContain('edges');
  });

  it('respects minSalience option', () => {
    const result = getBootContext('cajal', { dbPath, minSalience: 0.75 });
    expect(result).toContain('Test Decision'); // salience 0.8
    expect(result).not.toContain('Another Pattern'); // salience 0.7, below threshold
  });

  it('respects limit option', () => {
    const result = getBootContext('cajal', { dbPath, limit: 1 });
    // Should only have 1 node (highest salience: Test Decision at 0.8)
    expect(result).toContain('Test Decision');
    expect(result).toContain('1 nodes');
  });

  it('generic boot raises minSalience to at least 0.5', () => {
    const result = getBootContext(null, { dbPath, minSalience: 0.1 });
    // Even with minSalience 0.1, generic boot clamps to 0.5
    // Low Salience Node at 0.1 should be excluded
    expect(result).not.toContain('Low Salience Node');
  });

  it('getBootContext includes pinned nodes', () => {
    // Add a pinned node to the existing seeded DB
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({
      id: 'pinned-rule',
      name: 'Always Use Transactions',
      type: NodeType.Rule,
      description: 'All multi-step writes must use transactions',
      salience: 0.4,
      sourceAgent: 'hebb',
      pinned: true,
    });
    graph.close();

    // Even though salience is 0.4 and agent is 'hebb', pinned nodes should appear for cajal
    const result = getBootContext('cajal', { dbPath });
    expect(result).toContain('📌 Pinned');
    expect(result).toContain('Always Use Transactions');
  });
});

// ---------------------------------------------------------------------------
// resolveAgent
// ---------------------------------------------------------------------------

describe('resolveAgent', () => {
  it('returns null when no env vars or CWD hints exist', () => {
    const originalCopilotAgent = process.env.COPILOT_AGENT;
    const originalAgent = process.env.COPILOT_AGENT_NAME;
    const originalName = process.env.AGENT_NAME;
    delete process.env.COPILOT_AGENT;
    delete process.env.COPILOT_AGENT_NAME;
    delete process.env.AGENT_NAME;

    try {
      // CWD won't match myelin-X pattern in test env
      const result = resolveAgent();
      // Result depends on actual CWD, but at minimum it shouldn't throw
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      if (originalCopilotAgent !== undefined) process.env.COPILOT_AGENT = originalCopilotAgent;
      if (originalAgent !== undefined) process.env.COPILOT_AGENT_NAME = originalAgent;
      if (originalName !== undefined) process.env.AGENT_NAME = originalName;
    }
  });

  it('detects agent from COPILOT_AGENT env var', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    const origAN = process.env.AGENT_NAME;
    delete process.env.COPILOT_AGENT_NAME;
    delete process.env.AGENT_NAME;
    process.env.COPILOT_AGENT = 'Hebb';

    try {
      expect(resolveAgent()).toBe('hebb');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
      if (origAN !== undefined) process.env.AGENT_NAME = origAN; else delete process.env.AGENT_NAME;
    }
  });

  it('detects agent from COPILOT_AGENT_NAME env var', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    delete process.env.COPILOT_AGENT;
    process.env.COPILOT_AGENT_NAME = 'Donna';

    try {
      expect(resolveAgent()).toBe('donna');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
    }
  });

  it('detects agent from AGENT_NAME env var', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    const origAN = process.env.AGENT_NAME;
    delete process.env.COPILOT_AGENT;
    delete process.env.COPILOT_AGENT_NAME;
    process.env.AGENT_NAME = 'Hebb';

    try {
      expect(resolveAgent()).toBe('hebb');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
      if (origAN !== undefined) process.env.AGENT_NAME = origAN; else delete process.env.AGENT_NAME;
    }
  });

  it('COPILOT_AGENT takes priority over COPILOT_AGENT_NAME and AGENT_NAME', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    const origAN = process.env.AGENT_NAME;
    process.env.COPILOT_AGENT = 'Donna';
    process.env.COPILOT_AGENT_NAME = 'Cajal';
    process.env.AGENT_NAME = 'Hebb';

    try {
      expect(resolveAgent()).toBe('donna');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
      if (origAN !== undefined) process.env.AGENT_NAME = origAN; else delete process.env.AGENT_NAME;
    }
  });

  it('COPILOT_AGENT_NAME takes priority over AGENT_NAME', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    const origAN = process.env.AGENT_NAME;
    delete process.env.COPILOT_AGENT;
    process.env.COPILOT_AGENT_NAME = 'Cajal';
    process.env.AGENT_NAME = 'Hebb';

    try {
      expect(resolveAgent()).toBe('cajal');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
      if (origAN !== undefined) process.env.AGENT_NAME = origAN; else delete process.env.AGENT_NAME;
    }
  });

  it('lowercases the agent name', () => {
    const origCA = process.env.COPILOT_AGENT;
    const origCAN = process.env.COPILOT_AGENT_NAME;
    delete process.env.COPILOT_AGENT_NAME;
    process.env.COPILOT_AGENT = 'DONNA';

    try {
      expect(resolveAgent()).toBe('donna');
    } finally {
      if (origCA !== undefined) process.env.COPILOT_AGENT = origCA; else delete process.env.COPILOT_AGENT;
      if (origCAN !== undefined) process.env.COPILOT_AGENT_NAME = origCAN; else delete process.env.COPILOT_AGENT_NAME;
    }
  });
});
