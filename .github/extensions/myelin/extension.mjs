import { createRequire as __createRequire } from "node:module";
if (!globalThis.require) { globalThis.require = __createRequire(import.meta.url); }
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// require-external:@github/copilot-sdk
var require_copilot_sdk = __commonJS({
  "require-external:@github/copilot-sdk"(exports, module) {
    module.exports = globalThis.require("@github/copilot-sdk");
  }
});

// require-external:@github/copilot-sdk/extension
var require_extension = __commonJS({
  "require-external:@github/copilot-sdk/extension"(exports, module) {
    module.exports = globalThis.require("@github/copilot-sdk/extension");
  }
});

// require-external:better-sqlite3
var require_better_sqlite3 = __commonJS({
  "require-external:better-sqlite3"(exports, module) {
    module.exports = globalThis.require("better-sqlite3");
  }
});

// src/extension/extension.in-process.ts
var import_copilot_sdk = __toESM(require_copilot_sdk(), 1);
var import_extension = __toESM(require_extension(), 1);
import { homedir as homedir4 } from "node:os";
import { join as join4 } from "node:path";
import { existsSync as existsSync3 } from "node:fs";

// src/memory/graph.ts
var import_better_sqlite3 = __toESM(require_better_sqlite3(), 1);

// src/memory/schema.ts
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    salience REAL DEFAULT 0.5,
    confidence REAL DEFAULT 1.0,
    source_agent TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    last_reinforced TEXT NOT NULL,
    pinned INTEGER DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_nodes_pinned ON nodes(pinned) WHERE pinned = 1;

CREATE TABLE IF NOT EXISTS consolidation_state (
    agent TEXT PRIMARY KEY,
    last_consolidated_ts TEXT,
    last_run_ts TEXT,
    entries_processed INTEGER DEFAULT 0
);
`;
var CODE_COLUMNS = [
  ["category", "TEXT DEFAULT 'knowledge'"],
  ["file_path", "TEXT"],
  ["line_start", "INTEGER"],
  ["line_end", "INTEGER"],
  ["ado_id", "INTEGER"],
  ["state", "TEXT"],
  ["iteration", "TEXT"],
  ["namespace", "TEXT DEFAULT 'unclassified'"]
];
var CODE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_category_type ON nodes(category, type)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_ado_id ON nodes(ado_id)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace)"
];
var CODE_SCHEMA_EXTENSIONS = CODE_COLUMNS.map(
  ([name, typedef]) => `ALTER TABLE nodes ADD COLUMN ${name} ${typedef}`
);
var CLASSIFICATION_COLUMNS = {
  nodes: [
    ["sensitivity", "INTEGER DEFAULT 0"],
    ["sensitivity_reason", "TEXT"]
  ],
  edges: [
    ["sensitivity", "INTEGER DEFAULT 0"],
    ["sensitivity_reason", "TEXT"]
  ]
};
var CLASSIFICATION_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_nodes_sensitivity ON nodes(sensitivity)",
  "CREATE INDEX IF NOT EXISTS idx_edges_sensitivity ON edges(sensitivity)"
];
var PINNED_COLUMNS = [
  ["pinned", "INTEGER DEFAULT 0"]
];
var PINNED_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_nodes_pinned ON nodes(pinned) WHERE pinned = 1"
];
function initSchema(db) {
  db.exec(SCHEMA_SQL);
}
function extendSchemaForCode(db) {
  const existing = new Set(
    db.pragma("table_info(nodes)").map(
      (r) => r.name
    )
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
function extendSchemaForClassification(db) {
  const existingNodes = new Set(
    db.pragma("table_info(nodes)").map(
      (r) => r.name
    )
  );
  const existingEdges = new Set(
    db.pragma("table_info(edges)").map(
      (r) => r.name
    )
  );
  for (const [colName, colDef] of CLASSIFICATION_COLUMNS.nodes) {
    if (!existingNodes.has(colName)) {
      db.exec(`ALTER TABLE nodes ADD COLUMN ${colName} ${colDef}`);
    }
  }
  for (const [colName, colDef] of CLASSIFICATION_COLUMNS.edges) {
    if (!existingEdges.has(colName)) {
      db.exec(`ALTER TABLE edges ADD COLUMN ${colName} ${colDef}`);
    }
  }
  for (const idx of CLASSIFICATION_INDEXES) {
    db.exec(idx);
  }
}
function extendSchemaForPinned(db) {
  const existing = new Set(
    db.pragma("table_info(nodes)").map(
      (r) => r.name
    )
  );
  for (const [colName, colDef] of PINNED_COLUMNS) {
    if (!existing.has(colName)) {
      db.exec(`ALTER TABLE nodes ADD COLUMN ${colName} ${colDef}`);
    }
  }
  for (const idx of PINNED_INDEXES) {
    db.exec(idx);
  }
}

// src/memory/graph.ts
var NodeType = /* @__PURE__ */ ((NodeType2) => {
  NodeType2["Concept"] = "concept";
  NodeType2["Person"] = "person";
  NodeType2["Decision"] = "decision";
  NodeType2["Pattern"] = "pattern";
  NodeType2["Bug"] = "bug";
  NodeType2["Convention"] = "convention";
  NodeType2["Initiative"] = "initiative";
  NodeType2["Tool"] = "tool";
  NodeType2["Meeting"] = "meeting";
  NodeType2["Rule"] = "rule";
  return NodeType2;
})(NodeType || {});
var RelationshipType = /* @__PURE__ */ ((RelationshipType2) => {
  RelationshipType2["RelatesTo"] = "relates_to";
  RelationshipType2["DependsOn"] = "depends_on";
  RelationshipType2["Supersedes"] = "supersedes";
  RelationshipType2["LearnedFrom"] = "learned_from";
  RelationshipType2["BelongsTo"] = "belongs_to";
  RelationshipType2["AuthoredBy"] = "authored_by";
  RelationshipType2["BlockedBy"] = "blocked_by";
  RelationshipType2["MentionedIn"] = "mentioned_in";
  RelationshipType2["EvolvedInto"] = "evolved_into";
  RelationshipType2["ConflictsWith"] = "conflicts_with";
  return RelationshipType2;
})(RelationshipType || {});
function isoNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function nameToId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function shortId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var KnowledgeGraph = class {
  /** Underlying database handle. Prefer class methods for most operations. */
  db;
  vecAvailable = false;
  constructor(dbPath = ":memory:") {
    this.db = new import_better_sqlite3.default(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    initSchema(this.db);
    extendSchemaForCode(this.db);
    extendSchemaForClassification(this.db);
    extendSchemaForPinned(this.db);
    this.initVecExtension();
  }
  // ── Schema helpers ───────────────────────────────────────────────────────
  /** Extend core schema with code-graph columns (idempotent). */
  extendForCode() {
    extendSchemaForCode(this.db);
  }
  /** Extend core schema with classification columns (idempotent). */
  extendForClassification() {
    extendSchemaForClassification(this.db);
  }
  initVecExtension() {
    try {
      let sqliteVec;
      try {
        sqliteVec = globalThis.require?.("sqlite-vec");
      } catch {
        try {
          const mod = globalThis.require?.("node:module");
          if (mod?.createRequire) {
            const req = mod.createRequire(import.meta.url);
            sqliteVec = req("sqlite-vec");
          }
        } catch {
        }
      }
      if (!sqliteVec) return;
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings
        USING vec0(
            node_id TEXT PRIMARY KEY,
            embedding FLOAT[384]
        )
      `);
      this.vecAvailable = true;
    } catch {
    }
  }
  // ── Node Operations ──────────────────────────────────────────────────────
  addNode(node) {
    const now = isoNow();
    const id = node.id || nameToId(node.name) || shortId();
    const full = {
      id,
      type: node.type ?? "concept" /* Concept */,
      name: node.name,
      description: node.description ?? "",
      salience: node.salience ?? 0.5,
      confidence: node.confidence ?? 1,
      sourceAgent: node.sourceAgent ?? "",
      createdAt: node.createdAt ?? now,
      lastReinforced: node.lastReinforced ?? now,
      tags: node.tags ?? [],
      category: node.category,
      filePath: node.filePath,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
      namespace: node.namespace,
      sensitivity: node.sensitivity,
      sensitivityReason: node.sensitivityReason,
      pinned: node.pinned
    };
    this.db.prepare(
      `INSERT INTO nodes (id, type, name, description, salience, confidence,
         source_agent, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      full.id,
      full.type,
      full.name,
      full.description,
      full.salience,
      full.confidence,
      full.sourceAgent,
      full.createdAt,
      full.lastReinforced
    );
    if (full.category || full.namespace || full.sensitivity !== void 0 || full.sensitivityReason || full.pinned) {
      try {
        const sets = [];
        const vals = [];
        if (full.category) {
          sets.push("category = ?");
          vals.push(full.category);
        }
        if (full.namespace) {
          sets.push("namespace = ?");
          vals.push(full.namespace);
        }
        if (full.sensitivity !== void 0) {
          sets.push("sensitivity = ?");
          vals.push(full.sensitivity);
        }
        if (full.sensitivityReason) {
          sets.push("sensitivity_reason = ?");
          vals.push(full.sensitivityReason);
        }
        if (full.pinned) {
          sets.push("pinned = ?");
          vals.push(1);
        }
        if (sets.length > 0) {
          vals.push(full.id);
          this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        }
      } catch {
      }
    }
    const tagStmt = this.db.prepare(
      "INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)"
    );
    for (const tag of full.tags) {
      tagStmt.run(full.id, tag);
    }
    return full;
  }
  getNode(id) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    if (!row) return null;
    return this.rowToNode(row);
  }
  findNodes(filters = {}) {
    const {
      type,
      sourceAgent,
      tag,
      minSalience = 0,
      limit = 50,
      namespace,
      category,
      ceiling,
      pinned
    } = filters;
    let query = "SELECT DISTINCT n.* FROM nodes n";
    const conditions = ["n.salience >= ?"];
    const params = [minSalience];
    if (tag) {
      query += " JOIN node_tags nt ON n.id = nt.node_id";
      conditions.push("nt.tag = ?");
      params.push(tag);
    }
    if (type) {
      conditions.push("n.type = ?");
      params.push(type);
    }
    if (sourceAgent) {
      conditions.push("n.source_agent = ?");
      params.push(sourceAgent);
    }
    if (namespace) {
      conditions.push("n.namespace = ?");
      params.push(namespace);
    }
    if (category) {
      conditions.push("n.category = ?");
      params.push(category);
    }
    if (ceiling !== void 0) {
      conditions.push("(n.sensitivity IS NULL OR n.sensitivity <= ?)");
      params.push(ceiling);
    }
    if (pinned === true) {
      conditions.push("n.pinned = 1");
    } else if (pinned === false) {
      conditions.push("(n.pinned = 0 OR n.pinned IS NULL)");
    }
    query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY n.salience DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params);
    return rows.map((r) => this.rowToNode(r));
  }
  searchNodes(query, limit = 20) {
    try {
      const rows2 = this.db.prepare(
        `SELECT n.* FROM nodes n
           JOIN node_fts fts ON n.rowid = fts.rowid
           WHERE node_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
      ).all(query, limit);
      if (rows2.length > 0) {
        return rows2.map((r) => this.rowToNode(r));
      }
    } catch {
    }
    const like = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM nodes
         WHERE name LIKE ? OR description LIKE ?
         ORDER BY salience DESC
         LIMIT ?`
    ).all(like, like, limit);
    return rows.map((r) => this.rowToNode(r));
  }
  /**
   * FTS5-based keyword search returning scored results.
   * Primary search path — works without embeddings.
   * Falls back to LIKE if FTS5 query syntax fails.
   */
  queryByKeyword(query, limit = 10, ceiling) {
    const ceilingFilter = ceiling !== void 0 ? " AND (n.sensitivity IS NULL OR n.sensitivity <= ?)" : "";
    try {
      const params = [query];
      if (ceiling !== void 0) params.push(ceiling);
      params.push(limit);
      const rows2 = this.db.prepare(
        `SELECT n.*, rank FROM nodes n
           JOIN node_fts fts ON n.rowid = fts.rowid
           WHERE node_fts MATCH ?${ceilingFilter}
           ORDER BY rank
           LIMIT ?`
      ).all(...params);
      if (rows2.length > 0) {
        return rows2.map((r) => ({
          node: this.rowToNode(r),
          score: 1 / (1 + Math.abs(r.rank))
        }));
      }
    } catch {
    }
    const like = `%${query}%`;
    const likeParams = [like, like];
    if (ceiling !== void 0) likeParams.push(ceiling);
    likeParams.push(limit);
    const rows = this.db.prepare(
      `SELECT * FROM nodes n
         WHERE (n.name LIKE ? OR n.description LIKE ?)${ceilingFilter}
         ORDER BY n.salience DESC
         LIMIT ?`
    ).all(...likeParams);
    return rows.map((r) => ({
      node: this.rowToNode(r),
      score: r.salience
    }));
  }
  updateNode(id, fields) {
    const allowed = {
      name: "name",
      description: "description",
      salience: "salience",
      confidence: "confidence",
      sourceAgent: "source_agent",
      lastReinforced: "last_reinforced",
      sensitivity: "sensitivity",
      sensitivityReason: "sensitivity_reason",
      pinned: "pinned"
    };
    const sets = [];
    const vals = [];
    for (const [jsKey, dbCol] of Object.entries(allowed)) {
      const val = fields[jsKey];
      if (val !== void 0) {
        sets.push(`${dbCol} = ?`);
        vals.push(jsKey === "pinned" ? val ? 1 : 0 : val);
      }
    }
    if (sets.length === 0) return false;
    vals.push(id);
    const result = this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return result.changes > 0;
  }
  deleteNode(id) {
    const result = this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return result.changes > 0;
  }
  reinforceNode(id, boost = 0.1) {
    const now = isoNow();
    const row = this.db.prepare("SELECT salience FROM nodes WHERE id = ?").get(id);
    if (!row) return null;
    const newSalience = Math.min(1, row.salience + boost);
    this.db.prepare(
      "UPDATE nodes SET salience = ?, last_reinforced = ? WHERE id = ?"
    ).run(newSalience, now, id);
    return newSalience;
  }
  // ── Edge Operations ──────────────────────────────────────────────────────
  addEdge(edge) {
    const now = isoNow();
    const full = {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      weight: edge.weight ?? 1,
      description: edge.description ?? "",
      sourceAgent: edge.sourceAgent ?? "",
      createdAt: edge.createdAt ?? now,
      lastReinforced: edge.lastReinforced ?? now
    };
    this.db.prepare(
      `INSERT INTO edges (source_id, target_id, relationship, weight,
         description, source_agent, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      full.sourceId,
      full.targetId,
      full.relationship,
      full.weight,
      full.description,
      full.sourceAgent,
      full.createdAt,
      full.lastReinforced
    );
    return full;
  }
  getEdges(nodeId, direction = "both", relationship) {
    const edges = [];
    if (direction === "outgoing" || direction === "both") {
      let query = "SELECT * FROM edges WHERE source_id = ?";
      const params = [nodeId];
      if (relationship) {
        query += " AND relationship = ?";
        params.push(relationship);
      }
      const rows = this.db.prepare(query).all(...params);
      edges.push(...rows.map((r) => this.rowToEdge(r)));
    }
    if (direction === "incoming" || direction === "both") {
      let query = "SELECT * FROM edges WHERE target_id = ?";
      const params = [nodeId];
      if (relationship) {
        query += " AND relationship = ?";
        params.push(relationship);
      }
      const rows = this.db.prepare(query).all(...params);
      edges.push(...rows.map((r) => this.rowToEdge(r)));
    }
    return edges;
  }
  reinforceEdge(sourceId, targetId, relationship, boost = 0.1) {
    const now = isoNow();
    const result = this.db.prepare(
      `UPDATE edges SET weight = MIN(1.0, weight + ?), last_reinforced = ?
         WHERE source_id = ? AND target_id = ? AND relationship = ?`
    ).run(boost, now, sourceId, targetId, relationship);
    return result.changes > 0;
  }
  // ── Tag Operations ───────────────────────────────────────────────────────
  addTag(nodeId, tag) {
    this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nodeId, tag);
  }
  getTags(nodeId) {
    const rows = this.db.prepare("SELECT tag FROM node_tags WHERE node_id = ?").all(nodeId);
    return rows.map((r) => r.tag);
  }
  // ── Property Operations ──────────────────────────────────────────────────
  setProperty(nodeId, key, value) {
    this.db.prepare(
      "INSERT OR REPLACE INTO properties (node_id, key, value) VALUES (?, ?, ?)"
    ).run(nodeId, key, value);
  }
  getProperty(nodeId, key) {
    const row = this.db.prepare("SELECT value FROM properties WHERE node_id = ? AND key = ?").get(nodeId, key);
    return row?.value ?? null;
  }
  getProperties(nodeId) {
    const rows = this.db.prepare("SELECT key, value FROM properties WHERE node_id = ?").all(nodeId);
    const result = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }
  // ── Subgraph Queries ─────────────────────────────────────────────────────
  querySubgraph(filters = {}) {
    const {
      agent,
      tag,
      minSalience = 0,
      depth = 1,
      limit = 50,
      ceiling,
      traversalMode = "skip"
    } = filters;
    const seedNodes = this.findNodes({
      sourceAgent: agent,
      tag,
      minSalience,
      limit,
      ceiling
    });
    const visited = /* @__PURE__ */ new Set();
    const visibleIds = /* @__PURE__ */ new Set();
    const nodes = [];
    for (const n of seedNodes) {
      visited.add(n.id);
      visibleIds.add(n.id);
      nodes.push(n);
    }
    for (let d = 0; d < depth; d++) {
      const frontier = /* @__PURE__ */ new Set();
      for (const nid of visited) {
        if (ceiling !== void 0 && traversalMode === "prune" && !visibleIds.has(nid)) {
          continue;
        }
        for (const e of this.getEdges(nid)) {
          frontier.add(e.sourceId);
          frontier.add(e.targetId);
        }
      }
      for (const nid of frontier) {
        if (!visited.has(nid)) {
          visited.add(nid);
          const node = this.getNode(nid);
          if (node && node.salience >= minSalience) {
            const nodeSensitivity = node.sensitivity ?? 0;
            if (ceiling === void 0 || nodeSensitivity <= ceiling) {
              visibleIds.add(nid);
              nodes.push(node);
            }
          }
        }
      }
    }
    const edges = [];
    for (const nid of visibleIds) {
      for (const e of this.getEdges(nid, "outgoing")) {
        if (visibleIds.has(e.targetId)) {
          edges.push(e);
        }
      }
    }
    nodes.sort((a, b) => b.salience - a.salience);
    return { nodes: nodes.slice(0, limit), edges };
  }
  // ── Homeostatic Operations ───────────────────────────────────────────────
  decayAll(decayRate = 0.05) {
    const now = Date.now();
    const rows = this.db.prepare(
      "SELECT id, salience, last_reinforced FROM nodes WHERE salience > 0 AND (pinned = 0 OR pinned IS NULL)"
    ).all();
    let count = 0;
    const updateStmt = this.db.prepare(
      "UPDATE nodes SET salience = ? WHERE id = ?"
    );
    for (const row of rows) {
      const lastReinforced = new Date(row.last_reinforced).getTime();
      const daysSince = (now - lastReinforced) / 864e5;
      const effectiveDecay = decayRate * Math.min(1, daysSince / 7);
      const newSalience = Math.max(0, row.salience - effectiveDecay);
      if (newSalience !== row.salience) {
        updateStmt.run(newSalience, row.id);
        count++;
      }
    }
    return count;
  }
  prune(minSalience = 0.05, minAgeDays = 30) {
    const cutoffMs = Date.now() - minAgeDays * 864e5;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const result = this.db.prepare(
      "DELETE FROM nodes WHERE salience < ? AND last_reinforced < ? AND (pinned = 0 OR pinned IS NULL)"
    ).run(minSalience, cutoffIso);
    return result.changes;
  }
  // ── Statistics ───────────────────────────────────────────────────────────
  stats() {
    const nodeCount = this.db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
    const edgeCount = this.db.prepare("SELECT COUNT(*) as c FROM edges").get().c;
    const tagCount = this.db.prepare("SELECT COUNT(DISTINCT tag) as c FROM node_tags").get().c;
    const typeDistribution = {};
    const typeDist = this.db.prepare("SELECT type, COUNT(*) as c FROM nodes GROUP BY type").all();
    for (const row of typeDist) {
      typeDistribution[row.type] = row.c;
    }
    const avgRow = this.db.prepare("SELECT AVG(salience) as a FROM nodes").get();
    const avgSalience = avgRow.a != null ? Math.round(avgRow.a * 1e3) / 1e3 : 0;
    return {
      nodeCount,
      edgeCount,
      tagCount,
      typeDistribution,
      avgSalience
    };
  }
  // ── Vector Embedding Operations ──────────────────────────────────────────
  hasVecTable() {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='node_embeddings'"
    ).get();
    return row.c > 0;
  }
  semanticSearch(queryEmbedding, limit = 20, category, namespace, ceiling) {
    if (!this.hasVecTable()) return [];
    try {
      const queryVec = new Float32Array(queryEmbedding).buffer;
      const extraConditions = [];
      const extraParams = [];
      const cols = new Set(
        this.db.pragma("table_info(nodes)").map(
          (r) => r.name
        )
      );
      if (category && cols.has("category")) {
        extraConditions.push("n.category = ?");
        extraParams.push(category);
      }
      if (namespace && cols.has("namespace")) {
        extraConditions.push("n.namespace = ?");
        extraParams.push(namespace);
      }
      if (ceiling !== void 0 && cols.has("sensitivity")) {
        extraConditions.push("(n.sensitivity IS NULL OR n.sensitivity <= ?)");
        extraParams.push(ceiling);
      }
      const whereExtra = extraConditions.length > 0 ? " AND " + extraConditions.join(" AND ") : "";
      const rows = this.db.prepare(
        `SELECT n.*, e.distance FROM nodes n
           JOIN node_embeddings e ON n.id = e.node_id
           WHERE e.embedding MATCH ? AND k = ?${whereExtra}
           ORDER BY e.distance`
      ).all(Buffer.from(queryVec), limit, ...extraParams);
      return rows.map((r) => ({ node: this.rowToNode(r), distance: r.distance }));
    } catch {
      return [];
    }
  }
  upsertEmbedding(nodeId, embedding) {
    if (!this.hasVecTable()) return;
    try {
      const vec = Buffer.from(new Float32Array(embedding).buffer);
      this.db.prepare("DELETE FROM node_embeddings WHERE node_id = ?").run(nodeId);
      this.db.prepare(
        "INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)"
      ).run(nodeId, vec);
    } catch {
    }
  }
  hasEmbedding(nodeId) {
    if (!this.hasVecTable()) return false;
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM node_embeddings WHERE node_id = ?"
    ).get(nodeId);
    return row.c > 0;
  }
  embeddingStats() {
    const totalNodes = this.db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
    if (!this.hasVecTable()) {
      return {
        totalNodes,
        embeddedNodes: 0,
        coveragePct: 0,
        vecAvailable: false
      };
    }
    const embeddedNodes = this.db.prepare("SELECT COUNT(*) as c FROM node_embeddings").get().c;
    const coveragePct = totalNodes > 0 ? Math.round(embeddedNodes / totalNodes * 1e3) / 10 : 0;
    return {
      totalNodes,
      embeddedNodes,
      coveragePct,
      vecAvailable: true
    };
  }
  // ── Lifecycle ────────────────────────────────────────────────────────────
  close() {
    this.db.close();
  }
  // ── Internal helpers ─────────────────────────────────────────────────────
  rowToNode(row) {
    const tags = this.getTags(row.id);
    return {
      id: row.id,
      type: Object.values(NodeType).includes(row.type) ? row.type : row.type,
      name: row.name,
      description: row.description,
      salience: row.salience,
      confidence: row.confidence,
      sourceAgent: row.source_agent,
      createdAt: row.created_at,
      lastReinforced: row.last_reinforced,
      tags,
      category: row.category ?? void 0,
      filePath: row.file_path ?? void 0,
      lineStart: row.line_start ?? void 0,
      lineEnd: row.line_end ?? void 0,
      namespace: row.namespace ?? void 0,
      sensitivity: row.sensitivity ?? void 0,
      sensitivityReason: row.sensitivity_reason ?? void 0,
      pinned: row.pinned === 1 ? true : void 0
    };
  }
  rowToEdge(row) {
    return {
      sourceId: row.source_id,
      targetId: row.target_id,
      relationship: Object.values(RelationshipType).includes(
        row.relationship
      ) ? row.relationship : row.relationship,
      weight: row.weight,
      description: row.description,
      sourceAgent: row.source_agent,
      createdAt: row.created_at,
      lastReinforced: row.last_reinforced
    };
  }
};

// src/memory/agents.ts
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/memory/structured-log.ts
import { readFileSync as readFileSync2, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/memory/log-parser.ts
import { readFileSync } from "node:fs";
var DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})/;
var SECTION_HEADING = /^### (.+)/;
var CONSOLIDATED_NOTE = /^_Consolidated .+\._$/;
var HANDOVER_HEADING = /^### Session Handover/;
var DECISION_MARKERS = /\b(decided|agreed|chose|going with|settled on|key decision|design decision)\b/i;
var ACTION_MARKERS = /\b(created|updated|built|implemented|fixed|deployed|published|posted|sent)\b/i;
function classifyEntry(heading, content) {
  const combined = `${heading}
${content}`;
  if (HANDOVER_HEADING.test(`### ${heading}`)) return "handover";
  if (DECISION_MARKERS.test(combined)) return "decision";
  if (ACTION_MARKERS.test(combined)) return "action";
  return "observation";
}
function makeEntry(date, heading, content, entryType, metadata = {}) {
  return {
    date,
    heading,
    content,
    entryType,
    metadata,
    get fullText() {
      return this.heading ? `${this.heading}
${this.content}` : this.content;
    }
  };
}
function parseLog(content) {
  const entries = [];
  const lines = content.split("\n");
  let currentDate = null;
  let currentHeading = null;
  let currentLines = [];
  function flush() {
    if (currentDate && currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text && !CONSOLIDATED_NOTE.test(text)) {
        const entryType = classifyEntry(currentHeading ?? "", text);
        entries.push(
          makeEntry(currentDate, currentHeading ?? "", text, entryType)
        );
      }
    }
    currentLines = [];
  }
  for (const line of lines) {
    if (line.startsWith("# Log") || line.startsWith("_Append-only")) {
      continue;
    }
    const dateMatch = DATE_HEADING.exec(line);
    if (dateMatch) {
      flush();
      currentDate = dateMatch[1];
      currentHeading = null;
      continue;
    }
    const sectionMatch = SECTION_HEADING.exec(line);
    if (sectionMatch) {
      flush();
      currentHeading = sectionMatch[1];
      continue;
    }
    if (line.trim() === "---") {
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return entries;
}
function parseLogFile(path) {
  const content = readFileSync(path, "utf-8");
  return parseLog(content);
}
function entriesSince(entries, sinceDate) {
  return entries.filter((e) => e.date >= sinceDate);
}

// src/memory/structured-log.ts
var COPILOT_ROOT = join(homedir(), ".copilot");
var AGENT_LOGS_DIR = join(COPILOT_ROOT, ".working-memory", "agents");
function writeLogEntry(agentName, entryType, summary, options = {}) {
  const logDir = join(AGENT_LOGS_DIR, agentName);
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "log.jsonl");
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    agent: agentName,
    type: entryType,
    summary,
    detail: options.detail ?? "",
    sessionId: options.sessionId ?? "",
    tags: options.tags ?? [],
    context: options.context ?? {}
  };
  appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
  return logFile;
}
function readLogEntries(agentName, options = {}) {
  const logFile = join(AGENT_LOGS_DIR, agentName, "log.jsonl");
  if (!existsSync(logFile)) return [];
  const raw = readFileSync2(logFile, "utf-8").trim();
  if (!raw) return [];
  let entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    const entry = {
      ts: data.ts,
      agent: data.agent,
      type: data.type,
      summary: data.summary,
      detail: data.detail ?? "",
      sessionId: data.sessionId ?? data.session_id ?? "",
      tags: data.tags ?? [],
      context: data.context ?? {}
    };
    if (options.sinceDate && entry.ts.slice(0, 10) < options.sinceDate) continue;
    if (options.entryType && entry.type !== options.entryType) continue;
    entries.push(entry);
  }
  if (options.limit !== void 0) {
    entries = entries.slice(-options.limit);
  }
  return entries;
}

// src/memory/agents.ts
var COPILOT_ROOT2 = join2(homedir2(), ".copilot");
var AGENTS_DIR = join2(COPILOT_ROOT2, "agents");
var AGENT_LOGS_DIR2 = join2(COPILOT_ROOT2, ".working-memory", "agents");
var DEFAULT_DB = join2(COPILOT_ROOT2, ".working-memory", "graph.db");
function resolveAgent() {
  const envName = process.env.COPILOT_AGENT_NAME || process.env.AGENT_NAME;
  if (envName) return envName.toLowerCase();
  const cwd = process.cwd();
  const cwdMatch = cwd.match(/myelin-(\w+)\d*$/i);
  if (cwdMatch) return cwdMatch[1].toLowerCase();
  return null;
}
function getBootContext(agentName, options = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB;
  const minSalience = options.minSalience ?? 0.3;
  const limit = options.limit ?? 30;
  const resolvedAgent = agentName || null;
  const graph = new KnowledgeGraph(dbPath);
  try {
    const pinnedNodes = graph.findNodes({ pinned: true, limit: 100 });
    const pinnedIds = new Set(pinnedNodes.map((n) => n.id));
    let allNodes;
    if (resolvedAgent) {
      const ownNodes = graph.findNodes({
        sourceAgent: resolvedAgent,
        minSalience,
        limit,
        ceiling: 1
      });
      const taggedNodes = graph.findNodes({
        tag: resolvedAgent,
        minSalience,
        limit,
        ceiling: 1
      });
      const seen = /* @__PURE__ */ new Set();
      allNodes = [];
      for (const node of [...ownNodes, ...taggedNodes]) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          allNodes.push(node);
        }
      }
    } else {
      allNodes = graph.findNodes({
        minSalience: Math.max(minSalience, 0.5),
        limit,
        ceiling: 1
      });
    }
    const seenIds = new Set(allNodes.map((n) => n.id));
    for (const pn of pinnedNodes) {
      if (!seenIds.has(pn.id)) {
        seenIds.add(pn.id);
        allNodes.push(pn);
      }
    }
    allNodes.sort((a, b) => b.salience - a.salience);
    const nodes = allNodes.slice(0, limit);
    const label = resolvedAgent ?? "generic";
    if (nodes.length === 0 && pinnedNodes.length === 0) {
      const stats2 = graph.stats();
      if (stats2.nodeCount === 0) {
        return `# Graph Briefing \u2014 ${label}

No graph nodes found yet. The graph will populate as consolidation cycles run.
`;
      }
      return `# Graph Briefing \u2014 ${label}

No matching nodes above salience threshold. Graph has ${stats2.nodeCount} nodes total.
`;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const lines = [
      `# Graph Briefing \u2014 ${label}`,
      `_Generated ${now}_`,
      `_${nodes.length} nodes, sorted by salience_`,
      ""
    ];
    const pinnedInResults = nodes.filter((n) => pinnedIds.has(n.id));
    if (pinnedInResults.length > 0) {
      lines.push("## \u{1F4CC} Pinned");
      for (const node of pinnedInResults) {
        lines.push(
          `- **${node.name}** (${node.salience.toFixed(2)}): ${node.description.slice(0, 120)}`
        );
        const edges = graph.getEdges(node.id, "outgoing");
        for (const edge of edges.slice(0, 3)) {
          const target = graph.getNode(edge.targetId);
          if (target) {
            lines.push(`  \u2192 ${edge.relationship}: ${target.name}`);
          }
        }
      }
      lines.push("");
    }
    const byType = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      if (pinnedIds.has(node.id)) continue;
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }
    for (const [nodeType, typeNodes] of [...byType.entries()].sort()) {
      const title = nodeType.charAt(0).toUpperCase() + nodeType.slice(1) + "s";
      lines.push(`## ${title}`);
      for (const node of typeNodes) {
        const marker = node.salience >= 0.8 ? "\u{1F534}" : node.salience >= 0.5 ? "\u{1F7E1}" : "\u26AA";
        lines.push(
          `- ${marker} **${node.name}** (${node.salience.toFixed(2)}): ${node.description.slice(0, 120)}`
        );
        const edges = graph.getEdges(node.id, "outgoing");
        for (const edge of edges.slice(0, 3)) {
          const target = graph.getNode(edge.targetId);
          if (target) {
            lines.push(`  \u2192 ${edge.relationship}: ${target.name}`);
          }
        }
      }
      lines.push("");
    }
    const stats = graph.stats();
    lines.push("---");
    lines.push(
      `_Graph total: ${stats.nodeCount} nodes, ${stats.edgeCount} edges, avg salience ${stats.avgSalience}_`
    );
    return lines.join("\n");
  } finally {
    graph.close();
  }
}
function appendStructuredLog(agentName, entryType, summary, options = {}) {
  return writeLogEntry(agentName, entryType, summary, options);
}

// src/memory/embeddings.ts
async function getEmbedding(_text) {
  return [];
}

// src/memory/replay.ts
import { readFileSync as readFileSync3, existsSync as existsSync2, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join as join3, basename } from "node:path";
import { homedir as homedir3 } from "node:os";

// src/memory/vocabulary.ts
var ENTITY_PATTERNS = [
  {
    nodeType: "person" /* Person */,
    keywords: ["mentioned", "said", "asked", "responded", "messaged", "posted", "reviewed"],
    description: "People referenced in log entries"
  },
  {
    nodeType: "decision" /* Decision */,
    keywords: ["decided", "agreed", "chose", "approved", "settled on", "going with", "won't"],
    description: "Decisions made during sessions"
  },
  {
    nodeType: "bug" /* Bug */,
    keywords: ["bug", "broken", "fix", "error", "crash", "regression", "root cause", "workaround"],
    description: "Bugs found, fixed, or worked around"
  },
  {
    nodeType: "pattern" /* Pattern */,
    keywords: ["pattern", "convention", "best practice", "anti-pattern", "always", "never", "should"],
    description: "Code or workflow patterns discovered"
  },
  {
    nodeType: "concept" /* Concept */,
    keywords: ["architecture", "system", "framework", "model", "approach", "strategy"],
    description: "Technical concepts and architectural ideas"
  },
  {
    nodeType: "initiative" /* Initiative */,
    keywords: ["initiative", "project", "feature", "epic", "story", "sprint", "milestone"],
    description: "Work initiatives and project tracking"
  },
  {
    nodeType: "tool" /* Tool */,
    keywords: ["tool", "CLI", "MCP", "skill", "agent", "plugin", "extension", "library"],
    description: "Tools, skills, and infrastructure"
  },
  {
    nodeType: "meeting" /* Meeting */,
    keywords: ["meeting", "standup", "sync", "review", "demo", "retrospective", "hub hour"],
    description: "Meetings and recurring ceremonies"
  },
  {
    nodeType: "rule" /* Rule */,
    keywords: ["rule", "constraint", "must not", "always use", "never use", "workaround"],
    description: "Operational rules and constraints"
  },
  {
    nodeType: "convention" /* Convention */,
    keywords: ["naming", "format", "style", "convention", "standard", "template"],
    description: "Naming conventions, formatting standards"
  }
];
var RELATIONSHIP_PATTERNS = [
  {
    relationship: "depends_on" /* DependsOn */,
    signalPhrases: ["depends on", "requires", "needs", "blocked by", "waiting for"]
  },
  {
    relationship: "relates_to" /* RelatesTo */,
    signalPhrases: ["related to", "connects to", "similar to", "see also", "cf."]
  },
  {
    relationship: "supersedes" /* Supersedes */,
    signalPhrases: ["replaces", "supersedes", "obsoletes", "instead of", "no longer"]
  },
  {
    relationship: "learned_from" /* LearnedFrom */,
    signalPhrases: ["learned from", "discovered in", "found during", "came from"]
  },
  {
    relationship: "belongs_to" /* BelongsTo */,
    signalPhrases: ["part of", "belongs to", "under", "within", "inside"]
  },
  {
    relationship: "authored_by" /* AuthoredBy */,
    signalPhrases: ["created by", "authored by", "built by", "designed by", "wrote"],
    targetType: "person" /* Person */
  },
  {
    relationship: "mentioned_in" /* MentionedIn */,
    signalPhrases: ["mentioned in", "discussed at", "came up in", "raised during"],
    targetType: "meeting" /* Meeting */
  },
  {
    relationship: "evolved_into" /* EvolvedInto */,
    signalPhrases: ["evolved into", "became", "grew into", "led to", "resulted in"]
  },
  {
    relationship: "conflicts_with" /* ConflictsWith */,
    signalPhrases: ["conflicts with", "contradicts", "incompatible with", "clashes with"]
  }
];
var ALL_NODE_TYPES = Object.values(NodeType);
var ALL_RELATIONSHIP_TYPES = Object.values(RelationshipType);
function getLlmExtractionPrompt(text, existingEntities) {
  const entityTypes = ALL_NODE_TYPES.join(", ");
  const relTypes = ALL_RELATIONSHIP_TYPES.join(", ");
  let existingContext = "";
  if (existingEntities && existingEntities.length > 0) {
    const list = existingEntities.map((e) => `- ${e}`).join("\n");
    existingContext = `

Existing entities in the graph (link to these when relevant):
${list}`;
  }
  return `Extract entities and relationships from this log text.

ENTITY TYPES: ${entityTypes}
RELATIONSHIP TYPES: ${relTypes}
${existingContext}

TEXT:
${text}

Return JSON with this structure:
{
  "entities": [
    {"id": "short-kebab-id", "type": "concept|person|...", "name": "Display Name", "description": "One-line description", "salience": 0.0-1.0, "tags": ["domain1"]}
  ],
  "relationships": [
    {"source": "entity-id", "target": "entity-id", "relationship": "relates_to|depends_on|...", "description": "Why this relationship exists"}
  ]
}

RULES:
1. PERSON type is ONLY for real human names (first + last name like "Jeff West", "Ian Philpot"). Never classify project names, concepts, agent names, events, meetings, or abstract nouns as person.
2. Use SPECIFIC relationship types \u2014 avoid "relates_to" when a more precise type fits:
   - depends_on: X requires Y to work, X is blocked by Y
   - belongs_to: X is part of Y, X is a component of Y
   - authored_by: X was created/built/designed by person Y
   - learned_from: X was discovered/informed by experience Y
   - evolved_into: X became Y, X was replaced by Y
   - mentioned_in: X was discussed at meeting Y
   - supersedes: X replaces/obsoletes Y
   - blocked_by: X is blocked/prevented by Y
   - conflicts_with: X contradicts/is incompatible with Y
3. Every entity MUST have at least one relationship. If you can't connect it, it's probably not meaningful enough to extract.
4. Use consistent IDs: lowercase kebab-case, descriptive, max 40 chars. For the same concept across chunks, use the same ID (e.g. always "myelin-v090" not sometimes "v090-release").

SALIENCE GUIDE:
- 1.0: Critical decision, blocking bug, architectural change
- 0.7-0.9: Important pattern, key person interaction, initiative progress
- 0.4-0.6: Standard meeting outcome, routine update
- 0.1-0.3: Minor mention, context detail

Only extract entities that are MEANINGFUL \u2014 skip filler, transient details, and routine status updates.
`;
}

// src/memory/extractors.ts
var LABEL_TO_NODE_TYPE = {
  person: "person" /* Person */,
  "software tool": "tool" /* Tool */,
  "architectural decision": "decision" /* Decision */,
  "bug or error": "bug" /* Bug */,
  "design pattern": "pattern" /* Pattern */,
  "project or initiative": "initiative" /* Initiative */,
  "meeting or ceremony": "meeting" /* Meeting */,
  "operational rule": "rule" /* Rule */
};
function nameToId2(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function buildNode(id, type, name, description, salience, sourceAgent, tags) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id,
    type,
    name,
    description,
    salience,
    confidence: 1,
    sourceAgent,
    createdAt: now,
    lastReinforced: now,
    tags
  };
}
function buildEdge(sourceId, targetId, relationship, description, sourceAgent) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    sourceId,
    targetId,
    relationship,
    weight: 1,
    description,
    sourceAgent,
    createdAt: now,
    lastReinforced: now
  };
}
var CO_OCCURRENCE_PROXIMITY = 300;
var GENERIC_NAMES = /* @__PURE__ */ new Set([
  "service",
  "execute",
  "created",
  "domain",
  "output",
  "module",
  "resource",
  "config",
  "default",
  "common",
  "location",
  "result",
  "client",
  "context",
  "options",
  "request",
  "response",
  "handler",
  "provider",
  "factory",
  "builder",
  "helper",
  "manager",
  "worker",
  "monitor",
  "status",
  "source",
  "target",
  "deploy",
  "update",
  "delete",
  "create"
]);
function buildCodeIndex(graph, minNameLength = 12) {
  try {
    const rows = graph.db.prepare(
      `SELECT id, name FROM nodes
         WHERE category = 'code'
           AND type IN ('Class', 'Interface', 'Struct', 'Enum',
                        'Method', 'Function', 'Resource', 'Module')`
    ).all();
    const index = {};
    for (const row of rows) {
      if (row.name.length < minNameLength) continue;
      if (GENERIC_NAMES.has(row.name.toLowerCase())) continue;
      index[row.name] = row.id;
    }
    return index;
  } catch {
    return {};
  }
}
function parseLlmExtraction(jsonText, sourceAgent = "donna", defaultSalience = 0.5) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    const jsonMatch = /```(?:json)?\s*(\{.*?\})\s*```/s.exec(jsonText);
    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
      } catch {
        return {
          sourceEntry: makeEntry("", "llm-parse-error", jsonText, "observation"),
          entities: [],
          relationships: [],
          salience: 0
        };
      }
    } else {
      return {
        sourceEntry: makeEntry("", "llm-parse-error", jsonText, "observation"),
        entities: [],
        relationships: [],
        salience: 0
      };
    }
  }
  const nodeTypeValues = new Set(Object.values(NodeType));
  const relTypeValues = new Set(Object.values(RelationshipType));
  const entities = [];
  for (const e of data.entities ?? []) {
    const rawType = e.type ?? "concept";
    const nodeType = nodeTypeValues.has(rawType) ? rawType : "concept" /* Concept */;
    const rawId = e.id ?? "";
    const normalizedId = rawId ? nameToId2(rawId) : nameToId2(e.name ?? "unknown");
    if (!normalizedId) continue;
    entities.push(
      buildNode(
        normalizedId,
        nodeType,
        e.name ?? "Unknown",
        e.description ?? "",
        Number(e.salience ?? defaultSalience),
        sourceAgent,
        e.tags ?? []
      )
    );
  }
  const relationships = [];
  for (const r of data.relationships ?? []) {
    const rawRel = r.relationship ?? "relates_to";
    const relType = relTypeValues.has(rawRel) ? rawRel : "relates_to" /* RelatesTo */;
    const sourceId = nameToId2(r.source ?? "");
    const targetId = nameToId2(r.target ?? "");
    if (!sourceId || !targetId) continue;
    relationships.push(
      buildEdge(
        sourceId,
        targetId,
        relType,
        r.description ?? "",
        sourceAgent
      )
    );
  }
  const maxSalience = entities.length > 0 ? Math.max(...entities.map((e) => e.salience)) : 0;
  return {
    sourceEntry: makeEntry("", "llm-extraction", "", "observation"),
    entities,
    relationships,
    salience: maxSalience
  };
}
function loadExtractionToGraph(graph, result, merge = true, namespace) {
  const stats = {
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    edgesSkipped: 0
  };
  for (const node of result.entities) {
    const existing = graph.getNode(node.id);
    if (existing && merge) {
      graph.reinforceNode(node.id, 0.1);
      if (node.description.length > existing.description.length) {
        graph.updateNode(node.id, { description: node.description });
      }
      stats.nodesReinforced++;
    } else if (!existing) {
      if (namespace) {
        node.namespace = namespace;
        node.category = "knowledge";
      }
      graph.addNode(node);
      stats.nodesAdded++;
    }
  }
  for (const edge of result.relationships) {
    if (!graph.getNode(edge.sourceId) || !graph.getNode(edge.targetId)) {
      stats.edgesSkipped++;
      continue;
    }
    try {
      graph.addEdge(edge);
      stats.edgesAdded++;
    } catch {
      graph.reinforceEdge(edge.sourceId, edge.targetId, edge.relationship);
      stats.edgesAdded++;
    }
  }
  const crossEdges = resolveCodeReferences(graph, result);
  stats.edgesAdded += crossEdges;
  return stats;
}
function resolveCodeReferences(graph, result, codeIndex) {
  if (result.entities.length === 0) return 0;
  const index = codeIndex ?? buildCodeIndex(graph);
  if (Object.keys(index).length === 0) return 0;
  const text = result.sourceEntry.fullText;
  let edgesCreated = 0;
  const codePositions = /* @__PURE__ */ new Map();
  for (const [codeName, codeId] of Object.entries(index)) {
    const positions = [];
    let idx = text.indexOf(codeName);
    while (idx !== -1) {
      positions.push(idx);
      idx = text.indexOf(codeName, idx + 1);
    }
    if (positions.length > 0) {
      codePositions.set(codeId, positions);
    }
  }
  if (codePositions.size === 0) return 0;
  for (const entity of result.entities) {
    if (!graph.getNode(entity.id)) continue;
    const entityPositions = [];
    let eIdx = text.indexOf(entity.name);
    while (eIdx !== -1) {
      entityPositions.push(eIdx);
      eIdx = text.indexOf(entity.name, eIdx + 1);
    }
    if (entityPositions.length === 0) continue;
    for (const [codeId, codePositionList] of codePositions) {
      let nearby = false;
      for (const ep of entityPositions) {
        for (const cp of codePositionList) {
          if (Math.abs(ep - cp) <= CO_OCCURRENCE_PROXIMITY) {
            nearby = true;
            break;
          }
        }
        if (nearby) break;
      }
      if (!nearby) continue;
      try {
        graph.addEdge(
          buildEdge(
            entity.id,
            codeId,
            "relates_to" /* RelatesTo */,
            "Referenced in session log",
            "cross-domain"
          )
        );
        edgesCreated++;
      } catch {
        try {
          graph.reinforceEdge(
            entity.id,
            codeId,
            "relates_to" /* RelatesTo */
          );
        } catch {
        }
      }
    }
  }
  return edgesCreated;
}

// src/memory/replay.ts
var SOURCE_TAGS_LEVEL3 = ["1on1", "1:1", "private", "dm", "direct-message"];
var SOURCE_TAGS_LEVEL2 = ["confidential", "strategy", "sensitive", "security"];
var SOURCE_TAGS_LEVEL1 = ["observation", "finding", "internal"];
function inferSensitivity(entry, entityType) {
  const tagsRaw = entry.metadata?.tags ?? "";
  const tags = tagsRaw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  const entryContent = `${entry.heading} ${entry.content}`.toLowerCase();
  let channelFloor = 0;
  let channelReason = "";
  if (SOURCE_TAGS_LEVEL3.some((t) => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 3;
    channelReason = "source:private/1on1/dm";
  } else if (SOURCE_TAGS_LEVEL2.some((t) => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 2;
    channelReason = "source:confidential/strategy";
  } else if (SOURCE_TAGS_LEVEL1.some((t) => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 1;
    channelReason = "source:observation/finding";
  }
  let typeCeiling = 0;
  let typeReason = "";
  const normalizedType = entityType.toLowerCase();
  if (normalizedType === "person" /* Person */) {
    typeCeiling = 2;
    typeReason = "type:person";
  } else if (normalizedType === "decision" /* Decision */ || normalizedType === "meeting" /* Meeting */) {
    typeCeiling = 1;
    typeReason = "type:decision/meeting";
  }
  if (channelFloor >= typeCeiling) {
    return { level: channelFloor, reason: channelReason || "source:public" };
  }
  return { level: typeCeiling, reason: typeReason };
}
function applySensitivity(extraction) {
  for (const node of extraction.entities) {
    const { level, reason } = inferSensitivity(extraction.sourceEntry, node.type);
    if (level > 0) {
      node.sensitivity = level;
      node.sensitivityReason = reason;
    }
  }
}
var LOCK_STALE_MS = 10 * 60 * 1e3;
function formatBackupTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function backupGraph(dbPath) {
  if (!dbPath || !existsSync2(dbPath)) return null;
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const now = /* @__PURE__ */ new Date();
  const tsStr = formatBackupTimestamp(now);
  const todayPrefix = tsStr.slice(0, 8);
  const prefix = `${base}.backup-`;
  try {
    const existing = readdirSync(dir).filter((f) => f.startsWith(prefix));
    if (existing.some((f) => f.startsWith(`${prefix}${todayPrefix}`))) return null;
  } catch {
  }
  const backupPath = join3(dir, `${prefix}${tsStr}`);
  copyFileSync(dbPath, backupPath);
  return backupPath;
}
function getWatermark(graph, agent) {
  try {
    const row = graph.db.prepare("SELECT last_consolidated_ts FROM consolidation_state WHERE agent = ?").get(agent);
    return row?.last_consolidated_ts ?? null;
  } catch {
    return null;
  }
}
function prepareConsolidation(agentName, options) {
  const chunkSize = options?.chunkSize ?? 8;
  const AGENT_LOGS_DIR3 = options?.logsDir ?? join3(homedir3(), ".copilot", ".working-memory", "agents");
  let watermark = null;
  let effectiveSinceDate = options?.sinceDate;
  if (!effectiveSinceDate && options?.dbPath && existsSync2(options.dbPath)) {
    try {
      const graph = new KnowledgeGraph(options.dbPath);
      try {
        watermark = getWatermark(graph, agentName);
        if (watermark) {
          effectiveSinceDate = watermark;
        }
      } finally {
        graph.close();
      }
    } catch {
    }
  }
  const jsonlEntries = readLogEntries(agentName, {
    sinceDate: effectiveSinceDate
  });
  const mdLogPath = join3(AGENT_LOGS_DIR3, agentName, "log.md");
  let mdEntries = [];
  if (existsSync2(mdLogPath)) {
    try {
      const allMdEntries = parseLogFile(mdLogPath);
      if (effectiveSinceDate) {
        mdEntries = entriesSince(allMdEntries, effectiveSinceDate);
      } else {
        mdEntries = allMdEntries;
      }
    } catch {
    }
  }
  const textEntries = [];
  for (const e of jsonlEntries) {
    if (watermark && e.ts <= watermark) continue;
    const parts = [`[${e.ts}] ${e.type}: ${e.summary}`];
    if (e.detail) parts.push(e.detail);
    if (e.tags.length > 0) parts.push(`Tags: ${e.tags.join(", ")}`);
    textEntries.push({ sortKey: e.ts, text: parts.join("\n") });
  }
  for (const e of mdEntries) {
    if (watermark && e.date <= watermark) continue;
    const parts = [`[${e.date}] ${e.entryType}: ${e.heading}`];
    if (e.content) parts.push(e.content);
    textEntries.push({ sortKey: e.date, text: parts.join("\n") });
  }
  textEntries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  if (textEntries.length === 0) {
    return {
      agentName,
      totalEntries: 0,
      chunks: [],
      extractionPrompt: "",
      watermark
    };
  }
  const allChunks = [];
  for (let i = 0; i < textEntries.length; i += chunkSize) {
    const batch = textEntries.slice(i, i + chunkSize);
    const text = batch.map((e) => e.text).join("\n\n---\n\n");
    allChunks.push({ text, entryCount: batch.length });
  }
  const chunks = options?.chunkIndex !== void 0 ? allChunks.slice(options.chunkIndex, options.chunkIndex + 1) : allChunks;
  let existingEntities = [];
  if (options?.dbPath && existsSync2(options.dbPath)) {
    try {
      const graph = new KnowledgeGraph(options.dbPath);
      try {
        const nodes = graph.findNodes({ limit: 200, minSalience: 0.3 });
        existingEntities = nodes.map((n) => `${n.name} (${n.type})`);
      } finally {
        graph.close();
      }
    } catch {
    }
  }
  const extractionPrompt = getLlmExtractionPrompt(
    "",
    existingEntities.length > 0 ? existingEntities : void 0
  );
  return {
    agentName,
    totalEntries: textEntries.length,
    chunks,
    extractionPrompt,
    watermark
  };
}
function ingestExtractions(graph, extractions, agentName) {
  const result = {
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    errors: []
  };
  const namespace = `agent-${agentName}`;
  for (let i = 0; i < extractions.length; i++) {
    try {
      const extraction = parseLlmExtraction(extractions[i], agentName);
      applySensitivity(extraction);
      const stats = loadExtractionToGraph(graph, extraction, true, namespace);
      result.nodesAdded += stats.nodesAdded;
      result.nodesReinforced += stats.nodesReinforced;
      result.edgesAdded += stats.edgesAdded;
    } catch (err) {
      result.errors.push(
        `extraction[${i}]: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}
function runIntegrityChecks(graph) {
  const orphanEdgesRemoved = pruneOrphanEdges(graph);
  const clamped = graph.db.prepare(
    `UPDATE nodes SET salience = CASE
         WHEN salience < 0 THEN 0
         WHEN salience > 1 THEN 1
         ELSE salience
       END
       WHERE salience < 0 OR salience > 1`
  ).run();
  return {
    orphanEdgesRemoved,
    salienceClamped: clamped.changes
  };
}
function remRefine(graph, options = {}) {
  const dbName = graph.db.name;
  if (dbName && dbName !== ":memory:") {
    backupGraph(dbName);
  }
  const decayRate = options.decayRate ?? 0.05;
  const pruneThreshold = options.pruneThreshold ?? 0.05;
  const pruneMinAgeDays = options.pruneMinAgeDays ?? 30;
  const nodesDecayed = graph.decayAll(decayRate);
  const nodesPruned = graph.prune(pruneThreshold, pruneMinAgeDays);
  const edgesPruned = pruneOrphanEdges(graph);
  const orphansPruned = graph.db.prepare(
    `DELETE FROM nodes WHERE
       category IN ('knowledge', 'nrem')
       AND salience < 0.5
       AND id NOT IN (SELECT source_id FROM edges)
       AND id NOT IN (SELECT target_id FROM edges)`
  ).run();
  try {
    graph.db.prepare("DELETE FROM node_embeddings WHERE node_id NOT IN (SELECT id FROM nodes)").run();
  } catch {
  }
  return {
    nodesDecayed,
    nodesPruned: nodesPruned + orphansPruned.changes,
    edgesPruned,
    associationsCreated: 0,
    abstractionsMade: 0
  };
}
function pruneOrphanEdges(graph) {
  const result = graph.db.prepare(
    `DELETE FROM edges WHERE
       source_id NOT IN (SELECT id FROM nodes) OR
       target_id NOT IN (SELECT id FROM nodes)`
  ).run();
  return result.changes;
}

// src/extension/extension.in-process.ts
var WORKING_MEMORY = join4(homedir4(), ".copilot", ".working-memory");
var DB_PATH = join4(WORKING_MEMORY, "graph.db");
var MYELIN_VERSION = "0.9.0";
var sessionAgent = null;
function getGraph() {
  if (!existsSync3(DB_PATH)) return null;
  return new KnowledgeGraph(DB_PATH);
}
var session = await (0, import_extension.joinSession)({
  onPermissionRequest: import_copilot_sdk.approveAll,
  hooks: {
    onSessionStart: async (_input, _invocation) => {
      try {
        await session.log(`Myelin v${MYELIN_VERSION} loaded \u2014 5 tools, 3 hooks`);
        if (!existsSync3(DB_PATH)) {
          await session.log("No graph database found. Run `myelin init` to create one.", { level: "warning" });
          return;
        }
        const detectedAgent = resolveAgent();
        if (detectedAgent) {
          sessionAgent = detectedAgent;
        }
        let briefing;
        try {
          briefing = getBootContext(detectedAgent, { dbPath: DB_PATH });
        } catch (bootErr) {
          await session.log(`Graph boot failed: ${bootErr.message}`, { level: "warning" });
          briefing = "";
        }
        const contextParts = [];
        if (briefing) {
          contextParts.push(briefing);
        }
        contextParts.push(
          "",
          "## Myelin \u2014 When to Use These Tools",
          "",
          "You have a persistent knowledge graph with extracted entities, relationships, and agent history.",
          "Use myelin tools for **conceptual, historical, and cross-domain** questions. Use grep/glob/view for **textual and file-level** searches.",
          "",
          "| Question type | Use | Why |",
          "|---|---|---|",
          "| Find a specific string in code | `grep` | Exact text match, line-level results |",
          "| Find a file by name/pattern | `glob` | Pattern matching on file paths |",
          "| Read a known file | `view` | Direct file access |",
          "| How does auth work? | `myelin_query` | Conceptual \u2014 finds relationships across code, docs, and agent history |",
          "| What did we decide about caching? | `myelin_query` | Historical \u2014 past decisions logged by agents over time |",
          "| Who worked on the API? | `myelin_query` | Cross-domain \u2014 connects people to code to decisions |",
          "| What's this node connected to? | `myelin_show` | Graph exploration \u2014 follow edges and relationships |",
          "",
          "**Tool reference:**",
          "- **myelin_query** \u2014 Search by meaning across all knowledge (code, people, decisions, patterns). Use for 'how', 'why', 'who', and conceptual questions.",
          "- **myelin_boot** \u2014 Load agent-specific context. Call with your agent name for a richer domain briefing.",
          "- **myelin_log** \u2014 Record important decisions, findings, errors, and observations. These feed future consolidation into the graph.",
          "- **myelin_show** \u2014 Inspect a specific node and its connections. Use after finding a node via query to explore its edges.",
          "- **myelin_stats** \u2014 Check graph health: node/edge counts, type distribution, embedding coverage."
        );
        const healthGraph = getGraph();
        if (healthGraph) {
          try {
            const healthStats = healthGraph.stats();
            if (healthStats.nodeCount === 0) {
              contextParts.push("", "\u{1F4A1} Graph is empty \u2014 run `myelin parse ./your-repo` to index code");
            } else {
              const embStats = healthGraph.embeddingStats();
              if (!embStats.vecAvailable || embStats.embeddedNodes === 0) {
                contextParts.push("", "\u2139\uFE0F Search uses FTS5 keywords. Run `myelin embed` to add optional semantic boost.");
              }
            }
          } catch {
          } finally {
            healthGraph.close();
          }
        }
        await session.log(
          `Auto-boot complete: agent=${detectedAgent ?? "generic"}, context injected`
        );
        return {
          additionalContext: contextParts.join("\n")
        };
      } catch (e) {
        await session.log(`Myelin boot error: ${e.message}`, { level: "error" });
      }
    },
    onSessionEnd: async (input, _invocation) => {
      try {
        const agent = sessionAgent || resolveAgent() || "default";
        const summary = input.finalMessage ? input.finalMessage.slice(0, 200) : "Session ended (no final message)";
        appendStructuredLog(agent, "handover", summary, {
          tags: ["auto-session-end"]
        });
      } catch {
      }
    },
    onErrorOccurred: async (input, _invocation) => {
      if (input.recoverable && input.errorContext === "model_call") {
        return { errorHandling: "retry", retryCount: 2 };
      }
    }
  },
  tools: [
    {
      name: "myelin_query",
      description: "Search the knowledge graph by meaning. Use for conceptual questions (how, why, who), past decisions, cross-domain relationships, and historical context. Prefer grep/glob for exact text or file searches in code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 10)" },
          ceiling: { type: "number", description: "Max sensitivity level 0-3 (default: 1). Filters out nodes above this level." }
        },
        required: ["query"]
      },
      handler: async (args) => {
        const graph = getGraph();
        if (!graph) return "No graph database found. Run `myelin init` first.";
        try {
          const limit = args.limit || 10;
          const ceiling = args.ceiling ?? 1;
          const ftsResults = graph.queryByKeyword(args.query, limit, ceiling);
          if (ftsResults.length >= limit) {
            const lines2 = ftsResults.map(
              (r) => `[${r.score.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) \u2014 ${r.node.description?.slice(0, 100)}`
            );
            return `Search: '${args.query}' (${ftsResults.length} results, ceiling=${ceiling})
${lines2.join("\n")}`;
          }
          let semanticResults = [];
          try {
            const queryEmbedding = await getEmbedding(args.query);
            if (queryEmbedding.length > 0) {
              const vecResults = graph.semanticSearch(queryEmbedding, limit, void 0, void 0, ceiling);
              semanticResults = vecResults.map((r) => ({
                node: r.node,
                score: 1 / (1 + r.distance)
              }));
            }
          } catch {
          }
          const merged = /* @__PURE__ */ new Map();
          for (const r of ftsResults) {
            merged.set(r.node.id, r);
          }
          for (const r of semanticResults) {
            const existing = merged.get(r.node.id);
            if (!existing || r.score > existing.score) {
              merged.set(r.node.id, r);
            }
          }
          const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
          if (results.length === 0) return `No results for '${args.query}'`;
          const searchType = semanticResults.length > 0 ? "Hybrid search" : "Search";
          const lines = results.map(
            (r) => `[${r.score.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) \u2014 ${r.node.description?.slice(0, 100)}`
          );
          return `${searchType}: '${args.query}' (${results.length} results, ceiling=${ceiling})
${lines.join("\n")}`;
        } catch (e) {
          await session.log(`myelin_query error: ${e.message}`, { level: "error" });
          return `Error: ${e.message}`;
        } finally {
          graph.close();
        }
      }
    },
    {
      name: "myelin_boot",
      description: "Load domain-specific knowledge from the graph for a named agent. Call once at session start with your agent name for a richer briefing than auto-boot provides.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Your agent name \u2014 used to load agent-specific graph context" }
        },
        required: ["agent"]
      },
      handler: async (args) => {
        try {
          sessionAgent = args.agent;
          return getBootContext(args.agent, { dbPath: DB_PATH });
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }
    },
    {
      name: "myelin_log",
      description: "Log a structured event to an agent's knowledge log. Use to record decisions, findings, errors, and observations worth remembering across sessions. These logs feed into consolidation \u2014 important events become graph knowledge.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name" },
          type: {
            type: "string",
            description: "Event type",
            enum: ["decision", "action", "finding", "error", "handover", "observation"]
          },
          summary: { type: "string", description: "One-line summary" },
          detail: { type: "string", description: "Extended detail or context for richer log entries" },
          tags: { type: "string", description: "Comma-separated tags" },
          sensitivity: { type: "number", description: "Sensitivity level 0-3 (default: 0). Controls visibility during consolidation." },
          sensitivity_reason: { type: "string", description: "Why this entry has elevated sensitivity (e.g., 'contains credentials', 'internal architecture')" }
        },
        required: ["agent", "type", "summary"]
      },
      handler: async (args) => {
        try {
          const tags = args.tags ? args.tags.split(",").map((t) => t.trim()) : void 0;
          const context = {};
          if (args.sensitivity !== void 0) context.sensitivity = args.sensitivity;
          if (args.sensitivity_reason) context.sensitivityReason = args.sensitivity_reason;
          appendStructuredLog(args.agent, args.type, args.summary, {
            tags,
            detail: args.detail,
            context: Object.keys(context).length > 0 ? context : void 0
          });
          return `\u2705 ${args.agent}: ${args.summary}`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }
    },
    {
      name: "myelin_show",
      description: "Show a knowledge graph node and its connections. Use after finding a node via myelin_query to explore its edges, related entities, and tags.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Node name or partial name" }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const graph = getGraph();
        if (!graph) return "No graph database found.";
        try {
          const nodes = graph.searchNodes(args.name, 1);
          if (nodes.length === 0) return `No node matching '${args.name}'`;
          const node = nodes[0];
          const edges = graph.getEdges(node.id);
          const tags = graph.getTags(node.id);
          let result = `${node.type} | ${node.name}
`;
          result += `Salience: ${node.salience.toFixed(2)} | Agent: ${node.sourceAgent}
`;
          result += `Description: ${node.description}
`;
          if (tags.length > 0) result += `Tags: ${tags.join(", ")}
`;
          if (edges.length > 0) {
            result += `
Connections (${edges.length}):
`;
            for (const e of edges) {
              const target = e.sourceId === node.id ? e.targetId : e.sourceId;
              const dir = e.sourceId === node.id ? "\u2192" : "\u2190";
              const other = graph.getNode(target);
              result += `  ${dir} ${e.relationship}: ${other?.name ?? target}
`;
            }
          }
          return result;
        } finally {
          graph.close();
        }
      }
    },
    {
      name: "myelin_stats",
      description: "Show knowledge graph statistics: node/edge counts, type distribution, and embedding coverage. Use to check graph health or verify indexing worked.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const graph = getGraph();
        if (!graph) return "No graph database found.";
        try {
          const stats = graph.stats();
          const embStats = graph.embeddingStats();
          return [
            `Nodes: ${stats.nodeCount}`,
            `Edges: ${stats.edgeCount}`,
            `Avg salience: ${stats.avgSalience}`,
            `Embedded: ${embStats.embeddedNodes}/${embStats.totalNodes} (${embStats.coveragePct.toFixed(1)}%)`,
            `Type distribution:`,
            ...Object.entries(stats.typeDistribution).map(([t, c]) => `  ${t}: ${c}`)
          ].join("\n");
        } finally {
          graph.close();
        }
      }
    },
    {
      name: "myelin_consolidate",
      description: "Run LLM-driven memory consolidation. Use mode 'prepare' to read pending agent logs and get extraction schema, 'ingest' to write LLM extraction results to the graph, 'complete' to run decay/prune cleanup.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["prepare", "ingest", "complete"],
            description: "prepare: read logs + get schema, ingest: write extractions to graph, complete: REM decay/prune"
          },
          agent: {
            type: "string",
            description: "Agent name (required for prepare mode)"
          },
          extractions: {
            type: "array",
            items: { type: "string" },
            description: "JSON extraction results from LLM (required for ingest mode)"
          }
        },
        required: ["mode"]
      },
      handler: async (args) => {
        if (args.mode === "prepare") {
          const agent = args.agent || sessionAgent || "default";
          try {
            const result = prepareConsolidation(agent, { dbPath: DB_PATH });
            if (result.totalEntries === 0) {
              return `No pending log entries for agent '${agent}'.`;
            }
            const chunkSummaries = result.chunks.map(
              (c, i) => `--- Chunk ${i + 1} (${c.entryCount} entries) ---
${c.text}`
            ).join("\n\n");
            return [
              `Consolidation prepared for '${agent}': ${result.totalEntries} entries in ${result.chunks.length} chunks.`,
              "",
              "## Extraction Schema",
              "",
              result.extractionPrompt,
              "",
              "## Log Chunks",
              "",
              chunkSummaries,
              "",
              "Instructions: For each chunk above, extract entities and relationships using the schema. Then call myelin_consolidate with mode='ingest' and pass the JSON extractions array."
            ].join("\n");
          } catch (e) {
            return `Error preparing consolidation: ${e.message}`;
          }
        }
        if (args.mode === "ingest") {
          if (!args.extractions || !Array.isArray(args.extractions) || args.extractions.length === 0) {
            return "Error: 'extractions' array is required for ingest mode.";
          }
          const graph = getGraph();
          if (!graph) return "No graph database found. Run `myelin init` first.";
          try {
            const agent = args.agent || sessionAgent || "default";
            const result = ingestExtractions(graph, args.extractions, agent);
            const lines = [
              `Ingestion complete:`,
              `  Nodes added: ${result.nodesAdded}`,
              `  Nodes reinforced: ${result.nodesReinforced}`,
              `  Edges added: ${result.edgesAdded}`
            ];
            if (result.errors.length > 0) {
              lines.push(`  Errors (${result.errors.length}):`);
              for (const err of result.errors) {
                lines.push(`    - ${err}`);
              }
            }
            return lines.join("\n");
          } catch (e) {
            return `Error ingesting extractions: ${e.message}`;
          } finally {
            graph.close();
          }
        }
        if (args.mode === "complete") {
          const graph = getGraph();
          if (!graph) return "No graph database found. Run `myelin init` first.";
          try {
            const rem = remRefine(graph);
            const integrity = runIntegrityChecks(graph);
            return [
              `REM refinement complete:`,
              `  Nodes decayed: ${rem.nodesDecayed}`,
              `  Nodes pruned: ${rem.nodesPruned}`,
              `  Edges pruned: ${rem.edgesPruned}`,
              `Integrity checks:`,
              `  Orphan edges removed: ${integrity.orphanEdgesRemoved}`,
              `  Salience values clamped: ${integrity.salienceClamped}`
            ].join("\n");
          } catch (e) {
            return `Error in REM refinement: ${e.message}`;
          } finally {
            graph.close();
          }
        }
        return `Unknown mode '${args.mode}'. Use 'prepare', 'ingest', or 'complete'.`;
      }
    }
  ]
});
