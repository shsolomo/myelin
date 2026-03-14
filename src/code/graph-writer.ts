/**
 * Graph writer -- writes parsed code entities to graph.db.
 * Ported from cortex/code/graph_writer.py
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedFile, ParsedEntity } from './models.js';

const DEFAULT_DB_PATH = join(homedir(), '.copilot', '.working-memory', 'graph.db');

function nowIso(): string {
  return new Date().toISOString();
}

function makeNodeId(filePath: string, entityType: string, fqn: string): string {
  return `code:${filePath}:${entityType}:${fqn}`;
}

function writeParsedFile(
  db: Database.Database,
  parsed: ParsedFile,
): { nodes: number; edges: number } {
  const now = nowIso();
  const fp = parsed.filePath;
  let nodeCount = 0;
  let edgeCount = 0;

  // Delete existing nodes for this file (clean re-index)
  db.prepare('DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file_path = ?)').run(fp);
  db.prepare('DELETE FROM edges WHERE target_id IN (SELECT id FROM nodes WHERE file_path = ?)').run(fp);
  db.prepare('DELETE FROM nodes WHERE file_path = ?').run(fp);

  // Create file node
  const fileNodeId = makeNodeId(fp, 'file', fp);
  const fileName = fp.includes('/') ? fp.split('/').pop()! : fp;
  db.prepare(`
    INSERT OR REPLACE INTO nodes
    (id, type, name, description, salience, confidence, source_agent,
     created_at, last_reinforced, category, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fileNodeId, 'File', fileName, `Source file: ${fp}`,
    1.0, 1.0, 'code-graph', now, now, 'code', fp);
  nodeCount++;

  // Flatten all entities (including nested members)
  const allEntities: ParsedEntity[] = [];
  for (const entity of parsed.entities) {
    allEntities.push(entity);
    for (const member of entity.members) {
      allEntities.push(member);
      if (['class', 'interface', 'struct', 'enum'].includes(member.entityType)) {
        for (const sub of member.members) {
          allEntities.push(sub);
        }
      }
    }
  }

  // Create entity nodes
  const insertNode = db.prepare(`
    INSERT OR REPLACE INTO nodes
    (id, type, name, description, salience, confidence, source_agent,
     created_at, last_reinforced, category, file_path, line_start, line_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entity of allEntities) {
    const nodeId = makeNodeId(fp, entity.entityType, entity.fullyQualifiedName);
    const typeLabel = entity.entityType.charAt(0).toUpperCase() + entity.entityType.slice(1);
    const descParts: string[] = [];
    if (entity.modifiers.length > 0) {
      descParts.push(entity.modifiers.join(' '));
    }
    descParts.push(`${entity.entityType} ${entity.name}`);
    if (entity.baseTypes.length > 0) {
      descParts.push(`extends ${entity.baseTypes.join(', ')}`);
    }
    const description = descParts.join(' ');

    insertNode.run(
      nodeId, typeLabel, entity.name, description,
      1.0, 1.0, 'code-graph', now, now, 'code', fp,
      entity.lineStart, entity.lineEnd,
    );
    nodeCount++;
  }

  // Create edges (FK OFF -- edges may reference external types)
  const insertEdge = db.prepare(`
    INSERT OR REPLACE INTO edges
    (source_id, target_id, relationship, weight, description,
     source_agent, created_at, last_reinforced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const edge of parsed.edges) {
    try {
      insertEdge.run(
        edge.sourceName, edge.targetName, edge.relationship,
        1.0, '', 'code-graph', now, now,
      );
      edgeCount++;
    } catch {
      // Ignore integrity errors for external type references
    }
  }

  return { nodes: nodeCount, edges: edgeCount };
}

export function writeToGraph(
  parsedFiles: ParsedFile[],
  dbPath?: string,
  namespace?: string,
  allFilePaths?: string[],
): { nodes: number; edges: number; files: number; staleNodesRemoved: number } {
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  // FK OFF for code-graph: edges may reference external types/namespaces
  db.pragma('foreign_keys = OFF');

  // Set namespace on nodes if column exists
  const cols = new Set(
    (db.pragma('table_info(nodes)') as Array<{ name: string }>).map(r => r.name),
  );
  const hasNamespace = cols.has('namespace');

  const totals = { nodes: 0, edges: 0, files: 0, staleNodesRemoved: 0 };

  try {
    for (const pf of parsedFiles) {
      const txn = db.transaction(() => {
        const counts = writeParsedFile(db, pf);
        totals.nodes += counts.nodes;
        totals.edges += counts.edges;
        totals.files++;
      });
      txn();
    }

    // Tag all code nodes with namespace
    if (hasNamespace && namespace) {
      db.prepare(
        `UPDATE nodes SET namespace = ? WHERE category = 'code' AND (namespace IS NULL OR namespace = 'personal' OR namespace = 'unclassified')`,
      ).run(namespace);
    }

    // Clean stale nodes: files no longer in the repo for this namespace
    if (allFilePaths && namespace && hasNamespace) {
      const staleNodes = db.prepare(
        `SELECT id, file_path FROM nodes
         WHERE namespace = ? AND category = 'code' AND file_path IS NOT NULL
         AND file_path NOT IN (${allFilePaths.map(() => '?').join(',')})`,
      ).all(namespace, ...allFilePaths) as Array<{ id: string; file_path: string }>;

      if (staleNodes.length > 0) {
        const staleIds = staleNodes.map(n => n.id);
        const placeholders = staleIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM edges WHERE source_id IN (${placeholders})`).run(...staleIds);
        db.prepare(`DELETE FROM edges WHERE target_id IN (${placeholders})`).run(...staleIds);
        db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...staleIds);
        totals.staleNodesRemoved = staleNodes.length;
      }
    }
  } finally {
    db.close();
  }

  return totals;
}
