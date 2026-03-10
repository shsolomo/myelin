/**
 * SQLite-backed knowledge graph for agent memory consolidation.
 *
 * The graph is the "cortex" — slow-write semantic memory with massive capacity,
 * structured storage, and associative querying.  Each node represents a concept,
 * person, decision, pattern, or other entity.  Edges represent relationships
 * between entities.  Salience scores determine what gets surfaced at boot time.
 */

import Database from 'better-sqlite3';
import { initSchema, extendSchemaForCode } from './schema.js';

// ── Enums ────────────────────────────────────────────────────────────────────

export enum NodeType {
  Concept = 'concept',
  Person = 'person',
  Decision = 'decision',
  Pattern = 'pattern',
  Bug = 'bug',
  Convention = 'convention',
  Initiative = 'initiative',
  Tool = 'tool',
  Meeting = 'meeting',
  Rule = 'rule',
}

export enum RelationshipType {
  RelatesTo = 'relates_to',
  DependsOn = 'depends_on',
  Supersedes = 'supersedes',
  LearnedFrom = 'learned_from',
  BelongsTo = 'belongs_to',
  AuthoredBy = 'authored_by',
  BlockedBy = 'blocked_by',
  MentionedIn = 'mentioned_in',
  EvolvedInto = 'evolved_into',
  ConflictsWith = 'conflicts_with',
}

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface Node {
  id: string;
  type: NodeType | string;
  name: string;
  description: string;
  salience: number;
  confidence: number;
  sourceAgent: string;
  createdAt: string;
  lastReinforced: string;
  tags: string[];
  category?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface Edge {
  sourceId: string;
  targetId: string;
  relationship: RelationshipType | string;
  weight: number;
  description: string;
  sourceAgent: string;
  createdAt: string;
  lastReinforced: string;
}

export interface FindNodesFilters {
  type?: NodeType | string;
  sourceAgent?: string;
  tag?: string;
  minSalience?: number;
  limit?: number;
}

export interface SubgraphFilters {
  agent?: string;
  tag?: string;
  minSalience?: number;
  depth?: number;
  limit?: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  tagCount: number;
  typeDistribution: Record<string, number>;
  avgSalience: number;
}

export interface EmbeddingStats {
  totalNodes: number;
  embeddedNodes: number;
  coveragePct: number;
  vecAvailable: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

/** Convert a name to a kebab-case ID, truncated to 40 chars. */
function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Generate a short random hex id (8 chars). */
function shortId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Row types (internal) ─────────────────────────────────────────────────────

interface NodeRow {
  id: string;
  type: string;
  name: string;
  description: string;
  salience: number;
  confidence: number;
  source_agent: string;
  created_at: string;
  last_reinforced: string;
  category?: string;
  file_path?: string;
  line_start?: number;
  line_end?: number;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  relationship: string;
  weight: number;
  description: string;
  source_agent: string;
  created_at: string;
  last_reinforced: string;
}

// ── KnowledgeGraph ───────────────────────────────────────────────────────────

export class KnowledgeGraph {
  /** Underlying database handle. Prefer class methods for most operations. */
  readonly db: Database.Database;
  private vecAvailable = false;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    initSchema(this.db);
    this.initVecExtension();
  }

  // ── Schema helpers ───────────────────────────────────────────────────────

  /** Extend core schema with code-graph columns (idempotent). */
  extendForCode(): void {
    extendSchemaForCode(this.db);
  }

  private initVecExtension(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec') as {
        load: (db: Database.Database) => void;
      };
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
      // sqlite-vec not installed or failed to load — vector search disabled
    }
  }

  // ── Node Operations ──────────────────────────────────────────────────────

  addNode(node: Partial<Node> & { name: string }): Node {
    const now = isoNow();
    const id = node.id || nameToId(node.name) || shortId();
    const full: Node = {
      id,
      type: node.type ?? NodeType.Concept,
      name: node.name,
      description: node.description ?? '',
      salience: node.salience ?? 0.5,
      confidence: node.confidence ?? 1.0,
      sourceAgent: node.sourceAgent ?? '',
      createdAt: node.createdAt ?? now,
      lastReinforced: node.lastReinforced ?? now,
      tags: node.tags ?? [],
      category: node.category,
      filePath: node.filePath,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
    };

    this.db
      .prepare(
        `INSERT INTO nodes (id, type, name, description, salience, confidence,
         source_agent, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.type,
        full.name,
        full.description,
        full.salience,
        full.confidence,
        full.sourceAgent,
        full.createdAt,
        full.lastReinforced,
      );

    const tagStmt = this.db.prepare(
      'INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)',
    );
    for (const tag of full.tags) {
      tagStmt.run(full.id, tag);
    }

    return full;
  }

  getNode(id: string): Node | null {
    const row = this.db
      .prepare('SELECT * FROM nodes WHERE id = ?')
      .get(id) as NodeRow | undefined;
    if (!row) return null;
    return this.rowToNode(row);
  }

  findNodes(filters: FindNodesFilters = {}): Node[] {
    const {
      type,
      sourceAgent,
      tag,
      minSalience = 0.0,
      limit = 50,
    } = filters;

    let query = 'SELECT DISTINCT n.* FROM nodes n';
    const conditions: string[] = ['n.salience >= ?'];
    const params: unknown[] = [minSalience];

    if (tag) {
      query += ' JOIN node_tags nt ON n.id = nt.node_id';
      conditions.push('nt.tag = ?');
      params.push(tag);
    }

    if (type) {
      conditions.push('n.type = ?');
      params.push(type);
    }

    if (sourceAgent) {
      conditions.push('n.source_agent = ?');
      params.push(sourceAgent);
    }

    query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY n.salience DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as NodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  searchNodes(query: string, limit = 20): Node[] {
    // Try FTS5 first
    try {
      const rows = this.db
        .prepare(
          `SELECT n.* FROM nodes n
           JOIN node_fts fts ON n.rowid = fts.rowid
           WHERE node_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, limit) as NodeRow[];
      if (rows.length > 0) {
        return rows.map((r) => this.rowToNode(r));
      }
    } catch {
      // FTS5 match failed — fall through to LIKE
    }

    // Fallback: LIKE search
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE name LIKE ? OR description LIKE ?
         ORDER BY salience DESC
         LIMIT ?`,
      )
      .all(like, like, limit) as NodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  updateNode(
    id: string,
    fields: Partial<
      Pick<
        Node,
        | 'name'
        | 'description'
        | 'salience'
        | 'confidence'
        | 'sourceAgent'
        | 'lastReinforced'
      >
    >,
  ): boolean {
    const allowed: Record<string, string> = {
      name: 'name',
      description: 'description',
      salience: 'salience',
      confidence: 'confidence',
      sourceAgent: 'source_agent',
      lastReinforced: 'last_reinforced',
    };

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const [jsKey, dbCol] of Object.entries(allowed)) {
      const val = fields[jsKey as keyof typeof fields];
      if (val !== undefined) {
        sets.push(`${dbCol} = ?`);
        vals.push(val);
      }
    }

    if (sets.length === 0) return false;

    vals.push(id);
    const result = this.db
      .prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
    return result.changes > 0;
  }

  deleteNode(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM nodes WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  reinforceNode(id: string, boost = 0.1): number | null {
    const now = isoNow();
    const row = this.db
      .prepare('SELECT salience FROM nodes WHERE id = ?')
      .get(id) as { salience: number } | undefined;
    if (!row) return null;

    const newSalience = Math.min(1.0, row.salience + boost);
    this.db
      .prepare(
        'UPDATE nodes SET salience = ?, last_reinforced = ? WHERE id = ?',
      )
      .run(newSalience, now, id);
    return newSalience;
  }

  // ── Edge Operations ──────────────────────────────────────────────────────

  addEdge(edge: Partial<Edge> & { sourceId: string; targetId: string; relationship: RelationshipType | string }): Edge {
    const now = isoNow();
    const full: Edge = {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationship: edge.relationship,
      weight: edge.weight ?? 1.0,
      description: edge.description ?? '',
      sourceAgent: edge.sourceAgent ?? '',
      createdAt: edge.createdAt ?? now,
      lastReinforced: edge.lastReinforced ?? now,
    };

    this.db
      .prepare(
        `INSERT INTO edges (source_id, target_id, relationship, weight,
         description, source_agent, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.sourceId,
        full.targetId,
        full.relationship,
        full.weight,
        full.description,
        full.sourceAgent,
        full.createdAt,
        full.lastReinforced,
      );

    return full;
  }

  getEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    relationship?: RelationshipType | string,
  ): Edge[] {
    const edges: Edge[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      let query = 'SELECT * FROM edges WHERE source_id = ?';
      const params: unknown[] = [nodeId];
      if (relationship) {
        query += ' AND relationship = ?';
        params.push(relationship);
      }
      const rows = this.db.prepare(query).all(...params) as EdgeRow[];
      edges.push(...rows.map((r) => this.rowToEdge(r)));
    }

    if (direction === 'incoming' || direction === 'both') {
      let query = 'SELECT * FROM edges WHERE target_id = ?';
      const params: unknown[] = [nodeId];
      if (relationship) {
        query += ' AND relationship = ?';
        params.push(relationship);
      }
      const rows = this.db.prepare(query).all(...params) as EdgeRow[];
      edges.push(...rows.map((r) => this.rowToEdge(r)));
    }

    return edges;
  }

  reinforceEdge(
    sourceId: string,
    targetId: string,
    relationship: RelationshipType | string,
    boost = 0.1,
  ): boolean {
    const now = isoNow();
    const result = this.db
      .prepare(
        `UPDATE edges SET weight = MIN(1.0, weight + ?), last_reinforced = ?
         WHERE source_id = ? AND target_id = ? AND relationship = ?`,
      )
      .run(boost, now, sourceId, targetId, relationship);
    return result.changes > 0;
  }

  // ── Tag Operations ───────────────────────────────────────────────────────

  addTag(nodeId: string, tag: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)')
      .run(nodeId, tag);
  }

  getTags(nodeId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM node_tags WHERE node_id = ?')
      .all(nodeId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  // ── Property Operations ──────────────────────────────────────────────────

  setProperty(nodeId: string, key: string, value: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO properties (node_id, key, value) VALUES (?, ?, ?)',
      )
      .run(nodeId, key, value);
  }

  getProperty(nodeId: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM properties WHERE node_id = ? AND key = ?')
      .get(nodeId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getProperties(nodeId: string): Record<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM properties WHERE node_id = ?')
      .all(nodeId) as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  // ── Subgraph Queries ─────────────────────────────────────────────────────

  querySubgraph(
    filters: SubgraphFilters = {},
  ): { nodes: Node[]; edges: Edge[] } {
    const {
      agent,
      tag,
      minSalience = 0.0,
      depth = 1,
      limit = 50,
    } = filters;

    const nodes = this.findNodes({
      sourceAgent: agent,
      tag,
      minSalience,
      limit,
    });
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Expand by depth
    for (let d = 0; d < depth; d++) {
      const newIds = new Set<string>();
      for (const nid of nodeIds) {
        for (const e of this.getEdges(nid)) {
          newIds.add(e.sourceId);
          newIds.add(e.targetId);
        }
      }
      for (const nid of newIds) {
        if (!nodeIds.has(nid)) {
          const node = this.getNode(nid);
          if (node && node.salience >= minSalience) {
            nodes.push(node);
          }
          nodeIds.add(nid);
        }
      }
    }

    // Collect outgoing edges between nodes in the subgraph
    const edges: Edge[] = [];
    for (const nid of nodeIds) {
      for (const e of this.getEdges(nid, 'outgoing')) {
        if (nodeIds.has(e.targetId)) {
          edges.push(e);
        }
      }
    }

    nodes.sort((a, b) => b.salience - a.salience);

    return { nodes: nodes.slice(0, limit), edges };
  }

  // ── Homeostatic Operations ───────────────────────────────────────────────

  decayAll(decayRate = 0.05): number {
    const now = Date.now();

    const rows = this.db
      .prepare(
        'SELECT id, salience, last_reinforced FROM nodes WHERE salience > 0',
      )
      .all() as Array<{
      id: string;
      salience: number;
      last_reinforced: string;
    }>;

    let count = 0;
    const updateStmt = this.db.prepare(
      'UPDATE nodes SET salience = ? WHERE id = ?',
    );

    for (const row of rows) {
      const lastReinforced = new Date(row.last_reinforced).getTime();
      const daysSince = (now - lastReinforced) / 86_400_000;

      // Recently reinforced nodes decay slower
      const effectiveDecay = decayRate * Math.min(1.0, daysSince / 7.0);
      const newSalience = Math.max(0.0, row.salience - effectiveDecay);

      if (newSalience !== row.salience) {
        updateStmt.run(newSalience, row.id);
        count++;
      }
    }

    return count;
  }

  prune(minSalience = 0.05, minAgeDays = 30): number {
    const cutoffMs = Date.now() - minAgeDays * 86_400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const result = this.db
      .prepare(
        'DELETE FROM nodes WHERE salience < ? AND last_reinforced < ?',
      )
      .run(minSalience, cutoffIso);
    return result.changes;
  }

  // ── Statistics ───────────────────────────────────────────────────────────

  stats(): GraphStats {
    const nodeCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }
    ).c;
    const edgeCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }
    ).c;
    const tagCount = (
      this.db.prepare('SELECT COUNT(DISTINCT tag) as c FROM node_tags').get() as {
        c: number;
      }
    ).c;

    const typeDistribution: Record<string, number> = {};
    const typeDist = this.db
      .prepare('SELECT type, COUNT(*) as c FROM nodes GROUP BY type')
      .all() as Array<{ type: string; c: number }>;
    for (const row of typeDist) {
      typeDistribution[row.type] = row.c;
    }

    const avgRow = this.db
      .prepare('SELECT AVG(salience) as a FROM nodes')
      .get() as { a: number | null };
    const avgSalience = avgRow.a != null ? Math.round(avgRow.a * 1000) / 1000 : 0;

    return {
      nodeCount,
      edgeCount,
      tagCount,
      typeDistribution,
      avgSalience,
    };
  }

  // ── Vector Embedding Operations ──────────────────────────────────────────

  private hasVecTable(): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='node_embeddings'",
      )
      .get() as { c: number };
    return row.c > 0;
  }

  semanticSearch(
    queryEmbedding: number[],
    limit = 20,
    category?: string,
  ): Array<{ node: Node; distance: number }> {
    if (!this.hasVecTable()) return [];

    try {
      const queryVec = new Float32Array(queryEmbedding).buffer;

      let rows: Array<NodeRow & { distance: number }>;

      if (category) {
        // Check if category column exists
        const cols = new Set(
          (this.db.pragma('table_info(nodes)') as Array<{ name: string }>).map(
            (r) => r.name,
          ),
        );
        if (cols.has('category')) {
          rows = this.db
            .prepare(
              `SELECT n.*, e.distance FROM nodes n
               JOIN node_embeddings e ON n.id = e.node_id
               WHERE e.embedding MATCH ? AND k = ? AND n.category = ?
               ORDER BY e.distance`,
            )
            .all(
              Buffer.from(queryVec),
              limit,
              category,
            ) as Array<NodeRow & { distance: number }>;
        } else {
          rows = this.db
            .prepare(
              `SELECT n.*, e.distance FROM nodes n
               JOIN node_embeddings e ON n.id = e.node_id
               WHERE e.embedding MATCH ? AND k = ?
               ORDER BY e.distance`,
            )
            .all(Buffer.from(queryVec), limit) as Array<
            NodeRow & { distance: number }
          >;
        }
      } else {
        rows = this.db
          .prepare(
            `SELECT n.*, e.distance FROM nodes n
             JOIN node_embeddings e ON n.id = e.node_id
             WHERE e.embedding MATCH ? AND k = ?
             ORDER BY e.distance`,
          )
          .all(Buffer.from(queryVec), limit) as Array<
          NodeRow & { distance: number }
        >;
      }

      return rows.map((r) => ({ node: this.rowToNode(r), distance: r.distance }));
    } catch {
      return [];
    }
  }

  upsertEmbedding(nodeId: string, embedding: number[]): void {
    if (!this.hasVecTable()) return;

    try {
      const vec = Buffer.from(new Float32Array(embedding).buffer);
      // vec0 doesn't support ON CONFLICT — delete then insert
      this.db
        .prepare('DELETE FROM node_embeddings WHERE node_id = ?')
        .run(nodeId);
      this.db
        .prepare(
          'INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)',
        )
        .run(nodeId, vec);
    } catch {
      // sqlite-vec not available
    }
  }

  hasEmbedding(nodeId: string): boolean {
    if (!this.hasVecTable()) return false;

    const row = this.db
      .prepare(
        'SELECT COUNT(*) as c FROM node_embeddings WHERE node_id = ?',
      )
      .get(nodeId) as { c: number };
    return row.c > 0;
  }

  embeddingStats(): EmbeddingStats {
    const totalNodes = (
      this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }
    ).c;

    if (!this.hasVecTable()) {
      return {
        totalNodes,
        embeddedNodes: 0,
        coveragePct: 0,
        vecAvailable: false,
      };
    }

    const embeddedNodes = (
      this.db.prepare('SELECT COUNT(*) as c FROM node_embeddings').get() as {
        c: number;
      }
    ).c;

    const coveragePct =
      totalNodes > 0
        ? Math.round((embeddedNodes / totalNodes) * 1000) / 10
        : 0;

    return {
      totalNodes,
      embeddedNodes,
      coveragePct,
      vecAvailable: true,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private rowToNode(row: NodeRow): Node {
    const tags = this.getTags(row.id);
    return {
      id: row.id,
      type: (Object.values(NodeType) as string[]).includes(row.type)
        ? (row.type as NodeType)
        : row.type,
      name: row.name,
      description: row.description,
      salience: row.salience,
      confidence: row.confidence,
      sourceAgent: row.source_agent,
      createdAt: row.created_at,
      lastReinforced: row.last_reinforced,
      tags,
      category: row.category ?? undefined,
      filePath: row.file_path ?? undefined,
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      sourceId: row.source_id,
      targetId: row.target_id,
      relationship: (Object.values(RelationshipType) as string[]).includes(
        row.relationship,
      )
        ? (row.relationship as RelationshipType)
        : row.relationship,
      weight: row.weight,
      description: row.description,
      sourceAgent: row.source_agent,
      createdAt: row.created_at,
      lastReinforced: row.last_reinforced,
    };
  }
}
