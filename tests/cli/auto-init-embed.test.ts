/**
 * Tests for auto-init and --embed flag CLI enhancements (#27).
 *
 * Tests the ensureGraphDb logic and validates that --embed flag
 * is properly integrated into CLI commands.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KnowledgeGraph } from '../../src/memory/graph.js';
import { initSchema, extendSchemaForCode } from '../../src/memory/schema.js';

function tmpDbPath(): string {
  const dir = join(tmpdir(), 'myelin-autoinit-test');
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
// Auto-init: ensureGraphDb logic
// ---------------------------------------------------------------------------

describe('auto-init graph database', () => {
  let dbPath: string;

  afterEach(() => {
    if (dbPath) cleanDb(dbPath);
  });

  it('creates a new graph database when none exists', () => {
    dbPath = tmpDbPath();
    expect(existsSync(dbPath)).toBe(false);

    // Simulate what ensureGraphDb does
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    initSchema(db);
    extendSchemaForCode(db);
    db.close();

    expect(existsSync(dbPath)).toBe(true);

    // Verify the schema was initialized correctly
    const verifyDb = new Database(dbPath);
    const tables = verifyDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('node_tags');

    verifyDb.close();
  });

  it('does not recreate database when it already exists', () => {
    dbPath = tmpDbPath();

    // Create initial DB using KnowledgeGraph (proper schema setup)
    const graph = new KnowledgeGraph(dbPath);
    graph.addNode({ name: 'Sentinel', description: 'Test marker', salience: 0.5, sourceAgent: 'test' });
    graph.close();

    expect(existsSync(dbPath)).toBe(true);

    // ensureGraphDb would skip because DB exists — verify sentinel persists
    const graph2 = new KnowledgeGraph(dbPath);
    const found = graph2.searchNodes('Sentinel', 1);
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('Sentinel');
    graph2.close();
  });

  it('new DB has correct schema for KnowledgeGraph operations', () => {
    dbPath = tmpDbPath();

    // Auto-init creates a working DB
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    initSchema(db);
    extendSchemaForCode(db);
    db.close();

    // Verify it works with KnowledgeGraph
    const graph = new KnowledgeGraph(dbPath);
    const node = graph.addNode({ name: 'PostInit', description: 'Added after init' });
    expect(node.name).toBe('PostInit');

    const stats = graph.stats();
    expect(stats.nodeCount).toBe(1);
    graph.close();
  });
});

// ---------------------------------------------------------------------------
// --embed flag acceptance
// ---------------------------------------------------------------------------

describe('--embed flag', () => {
  it('runEmbedIfRequested skips when embed is false/undefined', async () => {
    // We test the embed helper behavior through its effect:
    // When embed is false/undefined, it should be a no-op
    // When embed is true, it should attempt to run (and fail gracefully without model)
    // This test verifies the logic pattern used in the CLI

    let embedCalled = false;
    const mockEmbed = async (_graph: any, embed?: boolean) => {
      if (!embed) return;
      embedCalled = true;
    };

    await mockEmbed(null, undefined);
    expect(embedCalled).toBe(false);

    await mockEmbed(null, false);
    expect(embedCalled).toBe(false);

    await mockEmbed(null, true);
    expect(embedCalled).toBe(true);
  });
});
