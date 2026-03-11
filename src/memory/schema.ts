/**
 * Schema DDL for the SQLite-backed knowledge graph.
 *
 * Tables: nodes, edges, node_tags, properties
 * FTS5 virtual table (node_fts) with INSERT/UPDATE/DELETE triggers
 * Code-graph extension columns (category, file_path, etc.)
 */

import type Database from 'better-sqlite3';

// ── Core schema ──────────────────────────────────────────────────────────────

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    salience REAL DEFAULT 0.5,
    confidence REAL DEFAULT 1.0,
    source_agent TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    last_reinforced TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    description TEXT DEFAULT '',
    source_agent TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    last_reinforced TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id, relationship),
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS node_tags (
    node_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (node_id, tag),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS properties (
    node_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (node_id, key),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
    name, description, content='nodes', content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO node_fts(rowid, name, description)
    VALUES (new.rowid, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO node_fts(node_fts, rowid, name, description)
    VALUES ('delete', old.rowid, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO node_fts(node_fts, rowid, name, description)
    VALUES ('delete', old.rowid, old.name, old.description);
    INSERT INTO node_fts(rowid, name, description)
    VALUES (new.rowid, new.name, new.description);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_salience ON nodes(salience DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_source_agent ON nodes(source_agent);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON edges(relationship);
CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag);
`;

// ── Code-graph extension ─────────────────────────────────────────────────────

const CODE_COLUMNS: Array<[string, string]> = [
  ['category', "TEXT DEFAULT 'knowledge'"],
  ['file_path', 'TEXT'],
  ['line_start', 'INTEGER'],
  ['line_end', 'INTEGER'],
  ['ado_id', 'INTEGER'],
  ['state', 'TEXT'],
  ['iteration', 'TEXT'],
  ['namespace', "TEXT DEFAULT 'unclassified'"],
];

const CODE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_category_type ON nodes(category, type)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_ado_id ON nodes(ado_id)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace)',
];

/** ALTER TABLE statements that add code-graph columns (idempotent). */
export const CODE_SCHEMA_EXTENSIONS: string[] = CODE_COLUMNS.map(
  ([name, typedef]) => `ALTER TABLE nodes ADD COLUMN ${name} ${typedef}`,
);

// ── Init helpers ─────────────────────────────────────────────────────────────

/** Run core DDL (tables, FTS, triggers, indexes). */
export function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Idempotently add code-graph columns and indexes.
 * Safe to call multiple times — skips columns that already exist.
 */
export function extendSchemaForCode(db: Database.Database): void {
  const existing = new Set(
    (db.pragma('table_info(nodes)') as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  for (const [colName, colDef] of CODE_COLUMNS) {
    if (!existing.has(colName)) {
      db.exec(`ALTER TABLE nodes ADD COLUMN ${colName} ${colDef}`);
    }
  }

  for (const idx of CODE_INDEXES) {
    db.exec(idx);
  }
}
