/**
 * Tests for code/graph-writer.ts — writing parsed code to the knowledge graph.
 *
 * Uses temp SQLite databases to verify code entities are written correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initSchema, extendSchemaForCode } from '../../src/memory/schema.js';
import { writeToGraph } from '../../src/code/graph-writer.js';
import { makeEntity, makeEdge, makeParsedFile } from '../../src/code/models.js';

const TEST_DIR = join(tmpdir(), `myelin-gw-test-${Date.now()}`);
let dbPath: string;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  dbPath = join(TEST_DIR, 'test.db');
  // Initialize DB with both core and code schemas
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  extendSchemaForCode(db);
  db.close();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeToGraph
// ---------------------------------------------------------------------------

describe('writeToGraph', () => {
  it('writes a parsed file with entities', () => {
    const pf = makeParsedFile({
      filePath: 'src/service.ts',
      language: 'typescript',
      entities: [
        makeEntity({
          entityType: 'class',
          name: 'UserService',
          fullyQualifiedName: 'UserService',
          filePath: 'src/service.ts',
          lineStart: 1,
          lineEnd: 50,
          modifiers: ['export'],
          members: [
            makeEntity({
              entityType: 'method',
              name: 'getUser',
              fullyQualifiedName: 'UserService.getUser',
              filePath: 'src/service.ts',
              lineStart: 10,
              lineEnd: 20,
            }),
          ],
        }),
      ],
    });

    const result = writeToGraph([pf], dbPath);
    expect(result.files).toBe(1);
    expect(result.nodes).toBeGreaterThanOrEqual(3); // File + class + method

    // Verify data in DB
    const db = new Database(dbPath);
    const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(nodeCount).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('writes multiple parsed files', () => {
    const files = [
      makeParsedFile({
        filePath: 'a.ts',
        language: 'typescript',
        entities: [
          makeEntity({ entityType: 'class', name: 'A', fullyQualifiedName: 'A', filePath: 'a.ts', lineStart: 1, lineEnd: 10 }),
        ],
      }),
      makeParsedFile({
        filePath: 'b.ts',
        language: 'typescript',
        entities: [
          makeEntity({ entityType: 'class', name: 'B', fullyQualifiedName: 'B', filePath: 'b.ts', lineStart: 1, lineEnd: 10 }),
        ],
      }),
    ];

    const result = writeToGraph(files, dbPath);
    expect(result.files).toBe(2);
    expect(result.nodes).toBeGreaterThanOrEqual(4); // 2 files + 2 classes
  });

  it('creates file nodes for each parsed file', () => {
    const pf = makeParsedFile({
      filePath: 'src/main.ts',
      language: 'typescript',
    });

    writeToGraph([pf], dbPath);

    const db = new Database(dbPath);
    const fileNodes = db.prepare("SELECT * FROM nodes WHERE type = 'File'").all();
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('sets category to code on all entities', () => {
    const pf = makeParsedFile({
      filePath: 'src/foo.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'Foo', fullyQualifiedName: 'Foo', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    writeToGraph([pf], dbPath);

    const db = new Database(dbPath);
    const nonCode = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE category != 'code'").get() as { c: number };
    expect(nonCode.c).toBe(0);
    db.close();
  });

  it('clean re-indexes: removes old nodes for same file path', () => {
    const pf1 = makeParsedFile({
      filePath: 'src/service.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'OldClass', fullyQualifiedName: 'OldClass', filePath: 'src/service.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    writeToGraph([pf1], dbPath);

    const pf2 = makeParsedFile({
      filePath: 'src/service.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'NewClass', fullyQualifiedName: 'NewClass', filePath: 'src/service.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    writeToGraph([pf2], dbPath);

    const db = new Database(dbPath);
    const nodes = db.prepare("SELECT name FROM nodes WHERE file_path = 'src/service.ts' AND type != 'File'").all() as Array<{ name: string }>;
    const names = nodes.map(n => n.name);
    expect(names).toContain('NewClass');
    expect(names).not.toContain('OldClass');
    db.close();
  });

  it('sets namespace when provided', () => {
    const pf = makeParsedFile({
      filePath: 'src/x.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'X', fullyQualifiedName: 'X', filePath: 'src/x.ts', lineStart: 1, lineEnd: 5 }),
      ],
    });

    writeToGraph([pf], dbPath, 'myelin');

    const db = new Database(dbPath);
    const row = db.prepare("SELECT namespace FROM nodes WHERE name = 'X'").get() as { namespace: string } | undefined;
    expect(row?.namespace).toBe('myelin');
    db.close();
  });

  it('handles empty file list', () => {
    const result = writeToGraph([], dbPath);
    expect(result.files).toBe(0);
    expect(result.nodes).toBe(0);
    expect(result.edges).toBe(0);
    expect(result.staleNodesRemoved).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Stale node cleanup
  // ---------------------------------------------------------------------------

  it('cleans stale nodes when allFilePaths excludes a previously indexed file', () => {
    // Index two files
    const files = [
      makeParsedFile({
        filePath: 'src/keep.ts',
        language: 'typescript',
        entities: [
          makeEntity({ entityType: 'class', name: 'Keep', fullyQualifiedName: 'Keep', filePath: 'src/keep.ts', lineStart: 1, lineEnd: 10 }),
        ],
      }),
      makeParsedFile({
        filePath: 'src/delete-me.ts',
        language: 'typescript',
        entities: [
          makeEntity({ entityType: 'class', name: 'DeleteMe', fullyQualifiedName: 'DeleteMe', filePath: 'src/delete-me.ts', lineStart: 1, lineEnd: 10 }),
        ],
      }),
    ];

    writeToGraph(files, dbPath, 'test-ns');

    // Re-index with only keep.ts in allFilePaths (delete-me.ts was deleted from repo)
    const result = writeToGraph(
      [files[0]],
      dbPath,
      'test-ns',
      ['src/keep.ts'],
    );

    expect(result.staleNodesRemoved).toBeGreaterThan(0);

    // Verify stale nodes are gone
    const db = new Database(dbPath);
    const deletedNodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE file_path = 'src/delete-me.ts'").get() as { c: number };
    expect(deletedNodes.c).toBe(0);

    // Verify kept nodes still exist
    const keptNodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE file_path = 'src/keep.ts'").get() as { c: number };
    expect(keptNodes.c).toBeGreaterThan(0);
    db.close();
  });

  it('stale cleanup only affects the correct namespace', () => {
    // Index a file in namespace A
    const fileA = makeParsedFile({
      filePath: 'src/a.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'A', fullyQualifiedName: 'A', filePath: 'src/a.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    // Index a file in namespace B
    const fileB = makeParsedFile({
      filePath: 'src/b.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'B', fullyQualifiedName: 'B', filePath: 'src/b.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    writeToGraph([fileA], dbPath, 'ns-a');
    writeToGraph([fileB], dbPath, 'ns-b');

    // Re-index ns-a with an empty file list — should only clean ns-a nodes
    const result = writeToGraph([], dbPath, 'ns-a', ['src/other.ts']);

    expect(result.staleNodesRemoved).toBeGreaterThan(0);

    // Verify ns-b nodes are untouched
    const db = new Database(dbPath);
    const nsBNodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE namespace = 'ns-b'").get() as { c: number };
    expect(nsBNodes.c).toBeGreaterThan(0);

    // Verify ns-a nodes are cleaned
    const nsANodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE namespace = 'ns-a' AND file_path = 'src/a.ts'").get() as { c: number };
    expect(nsANodes.c).toBe(0);
    db.close();
  });

  it('returns staleNodesRemoved = 0 when no stale nodes exist', () => {
    const pf = makeParsedFile({
      filePath: 'src/x.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'X', fullyQualifiedName: 'X', filePath: 'src/x.ts', lineStart: 1, lineEnd: 5 }),
      ],
    });

    const result = writeToGraph([pf], dbPath, 'ns', ['src/x.ts']);
    expect(result.staleNodesRemoved).toBe(0);
  });

  it('does not clean stale nodes when allFilePaths is not provided', () => {
    const pf = makeParsedFile({
      filePath: 'src/old.ts',
      language: 'typescript',
      entities: [
        makeEntity({ entityType: 'class', name: 'Old', fullyQualifiedName: 'Old', filePath: 'src/old.ts', lineStart: 1, lineEnd: 10 }),
      ],
    });

    writeToGraph([pf], dbPath, 'ns');

    // Re-index without allFilePaths — no cleanup
    const result = writeToGraph([], dbPath, 'ns');
    expect(result.staleNodesRemoved).toBe(0);

    const db = new Database(dbPath);
    const nodes = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE file_path = 'src/old.ts'").get() as { c: number };
    expect(nodes.c).toBeGreaterThan(0);
    db.close();
  });
});
