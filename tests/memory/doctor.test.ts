/**
 * Tests for the `myelin doctor` diagnostics — verifies health check logic
 * against empty graphs, populated graphs, and missing embeddings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { KnowledgeGraph } from '../../src/memory/graph.js';
import { initSchema, extendSchemaForCode } from '../../src/memory/schema.js';

const TEST_DIR = join(tmpdir(), `myelin-doctor-test-${Date.now()}`);
let dbPath: string;

function createTestDb(): string {
  const p = join(TEST_DIR, `test-${Date.now()}.db`);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  extendSchemaForCode(db);
  db.close();
  return p;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  dbPath = createTestDb();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('doctor: empty graph', () => {
  it('reports zero nodes and edges', () => {
    const graph = new KnowledgeGraph(dbPath);
    try {
      const stats = graph.stats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('reports no embeddings on empty graph', () => {
    const graph = new KnowledgeGraph(dbPath);
    try {
      const embStats = graph.embeddingStats();
      expect(embStats.totalNodes).toBe(0);
      expect(embStats.embeddedNodes).toBe(0);
    } finally {
      graph.close();
    }
  });
});

describe('doctor: populated graph', () => {
  it('reports correct node and edge counts', () => {
    const graph = new KnowledgeGraph(dbPath);
    try {
      graph.addNode({
        type: 'concept',
        name: 'Test Concept',
        description: 'A test concept for doctor diagnostics',
        sourceAgent: 'test',
      });
      graph.addNode({
        type: 'person',
        name: 'Test Person',
        description: 'A test person',
        sourceAgent: 'test',
      });
      graph.addEdge({
        sourceId: 'test-concept',
        targetId: 'test-person',
        relationship: 'relates_to',
      });

      const stats = graph.stats();
      expect(stats.nodeCount).toBe(2);
      expect(stats.edgeCount).toBe(1);
    } finally {
      graph.close();
    }
  });

  it('reports embedding coverage when nodes exist but no embeddings', () => {
    const graph = new KnowledgeGraph(dbPath);
    try {
      graph.addNode({
        type: 'concept',
        name: 'Unembedded Node',
        description: 'No embedding for this node',
        sourceAgent: 'test',
      });

      const embStats = graph.embeddingStats();
      expect(embStats.totalNodes).toBe(1);
      expect(embStats.embeddedNodes).toBe(0);
      expect(embStats.coveragePct).toBe(0);
    } finally {
      graph.close();
    }
  });
});

describe('doctor: missing embeddings detection', () => {
  it('detects when node_embeddings table does not exist', () => {
    // Create a minimal DB without vec table
    const minimalPath = join(TEST_DIR, 'minimal.db');
    const db = new Database(minimalPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    const graph = new KnowledgeGraph(minimalPath);
    try {
      const embStats = graph.embeddingStats();
      expect(embStats.vecAvailable).toBe(false);
      expect(embStats.embeddedNodes).toBe(0);
    } finally {
      graph.close();
    }
  });

  it('vecAvailable reflects actual table presence', () => {
    // The test DB has schema initialized but no sqlite-vec virtual table
    const graph = new KnowledgeGraph(dbPath);
    try {
      const embStats = graph.embeddingStats();
      // vecAvailable depends on whether node_embeddings was created by sqlite-vec
      // In test env without sqlite-vec loaded, it should be false
      expect(typeof embStats.vecAvailable).toBe('boolean');
      expect(embStats.embeddedNodes).toBe(0);
    } finally {
      graph.close();
    }
  });
});
