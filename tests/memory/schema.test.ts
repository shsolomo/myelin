/**
 * Tests for schema.ts — SQLite schema initialization.
 *
 * Covers: initSchema, extendSchemaForCode, idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, extendSchemaForCode, SCHEMA_SQL, CODE_SCHEMA_EXTENSIONS } from '../../src/memory/schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// initSchema
// ---------------------------------------------------------------------------

describe('initSchema', () => {
  it('creates the nodes table', () => {
    initSchema(db);
    const info = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('type');
    expect(columns).toContain('name');
    expect(columns).toContain('description');
    expect(columns).toContain('salience');
    expect(columns).toContain('confidence');
    expect(columns).toContain('source_agent');
    expect(columns).toContain('created_at');
    expect(columns).toContain('last_reinforced');
  });

  it('creates the edges table with composite PK', () => {
    initSchema(db);
    const info = db.pragma('table_info(edges)') as Array<{ name: string; pk: number }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain('source_id');
    expect(columns).toContain('target_id');
    expect(columns).toContain('relationship');
    expect(columns).toContain('weight');
    // Composite PK
    const pkCols = info.filter(r => r.pk > 0).map(r => r.name);
    expect(pkCols).toEqual(['source_id', 'target_id', 'relationship']);
  });

  it('creates the node_tags table', () => {
    initSchema(db);
    const info = db.pragma('table_info(node_tags)') as Array<{ name: string }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain('node_id');
    expect(columns).toContain('tag');
  });

  it('creates the properties table', () => {
    initSchema(db);
    const info = db.pragma('table_info(properties)') as Array<{ name: string }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain('node_id');
    expect(columns).toContain('key');
    expect(columns).toContain('value');
  });

  it('creates the node_fts virtual table', () => {
    initSchema(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='node_fts'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('creates FTS sync triggers', () => {
    initSchema(db);
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all() as Array<{ name: string }>;
    const triggerNames = triggers.map(t => t.name);
    expect(triggerNames).toContain('nodes_ai');
    expect(triggerNames).toContain('nodes_ad');
    expect(triggerNames).toContain('nodes_au');
  });

  it('creates indexes', () => {
    initSchema(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_nodes_type');
    expect(names).toContain('idx_nodes_salience');
    expect(names).toContain('idx_edges_source');
    expect(names).toContain('idx_edges_target');
  });

  it('is idempotent — running twice does not throw', () => {
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extendSchemaForCode
// ---------------------------------------------------------------------------

describe('extendSchemaForCode', () => {
  beforeEach(() => {
    initSchema(db);
  });

  it('adds code-graph columns to nodes', () => {
    extendSchemaForCode(db);
    const info = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    const columns = info.map(r => r.name);
    expect(columns).toContain('category');
    expect(columns).toContain('file_path');
    expect(columns).toContain('line_start');
    expect(columns).toContain('line_end');
    expect(columns).toContain('namespace');
  });

  it('is idempotent — running twice does not throw', () => {
    extendSchemaForCode(db);
    expect(() => extendSchemaForCode(db)).not.toThrow();
  });

  it('creates code-specific indexes', () => {
    extendSchemaForCode(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_nodes_%'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_nodes_category');
    expect(names).toContain('idx_nodes_file_path');
    expect(names).toContain('idx_nodes_namespace');
  });
});

// ---------------------------------------------------------------------------
// SCHEMA_SQL and CODE_SCHEMA_EXTENSIONS exports
// ---------------------------------------------------------------------------

describe('exports', () => {
  it('exports SCHEMA_SQL as a non-empty string', () => {
    expect(typeof SCHEMA_SQL).toBe('string');
    expect(SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it('exports CODE_SCHEMA_EXTENSIONS as an array of ALTER TABLE statements', () => {
    expect(Array.isArray(CODE_SCHEMA_EXTENSIONS)).toBe(true);
    for (const stmt of CODE_SCHEMA_EXTENSIONS) {
      expect(stmt).toMatch(/^ALTER TABLE nodes ADD COLUMN/);
    }
  });
});
