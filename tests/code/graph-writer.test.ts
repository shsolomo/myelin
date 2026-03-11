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
  });
});
