/**
 * NREM/REM Consolidation Pipeline — the core memory engine.
 *
 * NREM: Replay → Extract → Score → Transfer (hippocampus → cortex)
 * REM:  Decay → Prune → Refine (homeostatic maintenance)
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { KnowledgeGraph, Node, Edge } from "./graph.js";
import { NodeType } from "./graph.js";
import type { LogEntry } from "./log-parser.js";
import { parseLogFile, entriesSince } from "./log-parser.js";
import { toLogEntries } from "./structured-log.js";
import type { StructuredLogEntry } from "./structured-log.js";
import { extractFromEntry } from "./extractors.js";
import {
  parseLlmExtraction,
  loadExtractionToGraph,
} from "./extractors.js";
import { scoreEntry } from "./salience.js";

export interface QuarantinedEntry {
  index: number;
  source: string;
  error: string;
}

export interface IntegrityResult {
  orphanEdgesRemoved: number;
  salienceClamped: number;
}

export interface NREMResult {
  entriesProcessed: number;
  entitiesExtracted: number;
  relationshipsExtracted: number;
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  entriesByType: Record<string, number>;
  highSalienceEntries: string[];
  quarantined: QuarantinedEntry[];
}

export interface REMResult {
  nodesDecayed: number;
  nodesPruned: number;
  edgesPruned: number;
  associationsCreated: number;
  abstractionsMade: number;
}

// ── Auto-classification heuristics ────────────────────────────────────────

const SOURCE_TAGS_LEVEL3 = ['1on1', '1:1', 'private', 'dm', 'direct-message'];
const SOURCE_TAGS_LEVEL2 = ['confidential', 'strategy', 'sensitive', 'security'];
const SOURCE_TAGS_LEVEL1 = ['observation', 'finding', 'internal'];

/**
 * Infer sensitivity level for a node based on two signals:
 * 1. Source channel floor — derived from log entry tags/metadata
 * 2. Entity type ceiling — derived from the node's entity type
 *
 * Final level = MAX(channelFloor, typeCeiling). Errs toward over-classification.
 */
export function inferSensitivity(
  entry: LogEntry,
  entityType: string,
): { level: number; reason: string } {
  // Signal 1: Source channel floor from tags/metadata
  const tagsRaw = entry.metadata?.tags ?? '';
  const tags = tagsRaw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  const entryContent = `${entry.heading} ${entry.content}`.toLowerCase();

  let channelFloor = 0;
  let channelReason = '';

  if (SOURCE_TAGS_LEVEL3.some(t => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 3;
    channelReason = 'source:private/1on1/dm';
  } else if (SOURCE_TAGS_LEVEL2.some(t => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 2;
    channelReason = 'source:confidential/strategy';
  } else if (SOURCE_TAGS_LEVEL1.some(t => tags.includes(t) || entryContent.includes(t))) {
    channelFloor = 1;
    channelReason = 'source:observation/finding';
  }

  // Signal 2: Entity type ceiling
  let typeCeiling = 0;
  let typeReason = '';
  const normalizedType = entityType.toLowerCase();

  if (normalizedType === NodeType.Person) {
    typeCeiling = 2;
    typeReason = 'type:person';
  } else if (normalizedType === NodeType.Decision || normalizedType === NodeType.Meeting) {
    typeCeiling = 1;
    typeReason = 'type:decision/meeting';
  }

  // MAX of both signals
  if (channelFloor >= typeCeiling) {
    return { level: channelFloor, reason: channelReason || 'source:public' };
  }
  return { level: typeCeiling, reason: typeReason };
}

/**
 * Apply sensitivity classification to extracted nodes based on the source entry.
 */
function applySensitivity(extraction: { entities: Node[]; sourceEntry: LogEntry }): void {
  for (const node of extraction.entities) {
    const { level, reason } = inferSensitivity(extraction.sourceEntry, node.type);
    if (level > 0) {
      node.sensitivity = level;
      node.sensitivityReason = reason;
    }
  }
}

// ── Exclusive locking ──────────────────────────────────────────────────────

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Resolve the lock file path for a given graph database. */
export function lockPathFor(graph: KnowledgeGraph): string {
  const dbName = graph.db.name;
  if (!dbName || dbName === ':memory:') return '';
  return join(dirname(dbName), 'myelin.lock');
}

/**
 * Acquire an exclusive lock for consolidation.
 * Returns true if acquired, false if a recent lock exists (abort).
 * Warns and proceeds if the lock is stale (> 10 min).
 */
export function acquireLock(graph: KnowledgeGraph): { acquired: boolean; message?: string } {
  const lockFile = lockPathFor(graph);
  if (!lockFile) return { acquired: true }; // in-memory DB — no locking needed

  if (existsSync(lockFile)) {
    try {
      const content = readFileSync(lockFile, 'utf-8');
      const lockTime = parseInt(content, 10);
      const age = Date.now() - lockTime;

      if (age < LOCK_STALE_MS) {
        return {
          acquired: false,
          message: `Consolidation already in progress (lock age: ${Math.round(age / 1000)}s). Aborting.`,
        };
      }
      // Stale lock — warn and proceed
      return {
        acquired: true,
        message: `Stale lock detected (age: ${Math.round(age / 60000)}min). Overriding.`,
      };
    } catch {
      // Can't read lock file — treat as stale
    }
  }

  writeFileSync(lockFile, String(Date.now()), 'utf-8');
  return { acquired: true };
}

/** Release the consolidation lock. */
export function releaseLock(graph: KnowledgeGraph): void {
  const lockFile = lockPathFor(graph);
  if (!lockFile) return;
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch { /* best effort */ }
}

// ── Backup ────────────────────────────────────────────────────────────────

const MAX_BACKUPS = 3;

/**
 * Create a timestamped backup of graph.db before consolidation writes.
 * Keeps the latest MAX_BACKUPS copies and removes older ones.
 */
export function backupDatabase(graph: KnowledgeGraph): string | null {
  const dbName = graph.db.name;
  if (!dbName || dbName === ':memory:') return null;
  if (!existsSync(dbName)) return null;

  const dir = dirname(dbName);
  const base = basename(dbName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${base}.backup-${timestamp}`;
  const backupPath = join(dir, backupName);

  copyFileSync(dbName, backupPath);
  rotateBackups(dir, base);
  return backupPath;
}

/** Keep only the latest MAX_BACKUPS backup files. */
function rotateBackups(dir: string, dbBase: string): void {
  const prefix = `${dbBase}.backup-`;
  try {
    const backups = readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    for (const old of backups.slice(MAX_BACKUPS)) {
      try { unlinkSync(join(dir, old.name)); } catch { /* best effort */ }
    }
  } catch { /* directory listing failed — skip rotation */ }
}

// ── Integrity checks ─────────────────────────────────────────────────────

/**
 * Post-consolidation integrity check:
 * 1. Remove orphan edges (edges referencing non-existent nodes)
 * 2. Clamp salience values to [0, 1] bounds
 */
export function runIntegrityChecks(graph: KnowledgeGraph): IntegrityResult {
  const orphanEdgesRemoved = pruneOrphanEdges(graph);

  // Clamp salience to valid bounds [0, 1]
  const clamped = graph.db
    .prepare(
      `UPDATE nodes SET salience = CASE
         WHEN salience < 0 THEN 0
         WHEN salience > 1 THEN 1
         ELSE salience
       END
       WHERE salience < 0 OR salience > 1`,
    )
    .run();

  return {
    orphanEdgesRemoved,
    salienceClamped: clamped.changes,
  };
}

/**
 * Run the NREM consolidation phase on an agent's log.
 */
export async function nremReplay(
  graph: KnowledgeGraph,
  logPath?: string,
  options: {
    agentName?: string;
    sinceDate?: string;
    llmExtractions?: string[];
  } = {},
): Promise<NREMResult> {
  const agentName = options.agentName ?? "donna";
  let entries: LogEntry[] = [];

  // Phase 1: REPLAY — Read log file
  const parseErrors: QuarantinedEntry[] = [];
  if (logPath && existsSync(logPath)) {
    if (logPath.endsWith(".jsonl")) {
      const raw = readFileSync(logPath, "utf-8").trim();
      if (raw) {
        const structured: StructuredLogEntry[] = [];
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line) as Record<string, unknown>;
            structured.push({
              ts: data.ts as string,
              agent: (data.agent as string) ?? agentName,
              type: data.type as string,
              summary: data.summary as string,
              detail: (data.detail as string) ?? "",
              sessionId: (data.sessionId as string) ?? (data.session_id as string) ?? "",
              tags: (data.tags as string[]) ?? [],
              context: (data.context as Record<string, unknown>) ?? {},
            });
          } catch (err) {
            parseErrors.push({
              index: i,
              source: `${logPath}:line${i + 1}`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (options.sinceDate) {
          const since = options.sinceDate;
          entries.push(...toLogEntries(structured.filter(e => e.ts.slice(0, 10) >= since)));
        } else {
          entries.push(...toLogEntries(structured));
        }
      }
    } else {
      entries.push(...parseLogFile(logPath));
    }
  }

  if (options.sinceDate) {
    entries = entriesSince(entries, options.sinceDate);
  }

  if (entries.length === 0) {
    return {
      entriesProcessed: 0,
      entitiesExtracted: 0,
      relationshipsExtracted: 0,
      nodesAdded: 0,
      nodesReinforced: 0,
      edgesAdded: 0,
      entriesByType: {},
      highSalienceEntries: [],
      quarantined: parseErrors,
    };
  }

  const result: NREMResult = {
    entriesProcessed: entries.length,
    entitiesExtracted: 0,
    relationshipsExtracted: 0,
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    entriesByType: {},
    highSalienceEntries: [],
    quarantined: [...parseErrors],
  };

  // Count entry types
  for (const entry of entries) {
    result.entriesByType[entry.entryType] =
      (result.entriesByType[entry.entryType] ?? 0) + 1;
  }

  // Track high-salience entries
  for (const entry of entries) {
    const salience = scoreEntry(entry);
    if (salience.combined >= 0.7) {
      result.highSalienceEntries.push(
        `[${salience.combined.toFixed(2)}] ${entry.date}: ${entry.heading || entry.content.slice(0, 60)}`,
      );
    }
  }

  // Phase 2 & 3: EXTRACT + SCORE
  const namespace = `agent-${agentName}`;

  if (options.llmExtractions) {
    for (let i = 0; i < options.llmExtractions.length; i++) {
      try {
        const jsonText = options.llmExtractions[i];
        const extraction = parseLlmExtraction(jsonText, agentName);
        applySensitivity(extraction);
        result.entitiesExtracted += extraction.entities.length;
        result.relationshipsExtracted += extraction.relationships.length;

        const stats = loadExtractionToGraph(graph, extraction, true, namespace);
        result.nodesAdded += stats.nodesAdded;
        result.nodesReinforced += stats.nodesReinforced;
        result.edgesAdded += stats.edgesAdded;
      } catch (err) {
        result.quarantined.push({
          index: i,
          source: `llmExtraction[${i}]`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    for (let i = 0; i < entries.length; i++) {
      try {
        const entry = entries[i];
        const extraction = await extractFromEntry(entry, agentName);
        applySensitivity(extraction);
        result.entitiesExtracted += extraction.entities.length;
        result.relationshipsExtracted += extraction.relationships.length;

        const stats = loadExtractionToGraph(graph, extraction, true, namespace);
        result.nodesAdded += stats.nodesAdded;
        result.nodesReinforced += stats.nodesReinforced;
        result.edgesAdded += stats.edgesAdded;
      } catch (err) {
        const entry = entries[i];
        result.quarantined.push({
          index: i,
          source: `${logPath ?? 'unknown'}:entry[${i}] ${entry.heading || entry.content.slice(0, 40)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/**
 * Run the REM refinement phase on the knowledge graph.
 */
export function remRefine(
  graph: KnowledgeGraph,
  options: {
    decayRate?: number;
    pruneThreshold?: number;
    pruneMinAgeDays?: number;
  } = {},
): REMResult {
  const decayRate = options.decayRate ?? 0.05;
  const pruneThreshold = options.pruneThreshold ?? 0.05;
  const pruneMinAgeDays = options.pruneMinAgeDays ?? 30;

  const nodesDecayed = graph.decayAll(decayRate);
  const nodesPruned = graph.prune(pruneThreshold, pruneMinAgeDays);
  const edgesPruned = pruneOrphanEdges(graph);

  return {
    nodesDecayed,
    nodesPruned,
    edgesPruned,
    associationsCreated: 0, // handled in NREM via resolveCodeReferences
    abstractionsMade: 0,
  };
}

/**
 * Run a full consolidation cycle (NREM + REM).
 */
export async function runFullCycle(
  graph: KnowledgeGraph,
  logPath?: string,
  options: {
    agentName?: string;
    sinceDate?: string;
    llmExtractions?: string[];
    decayRate?: number;
  } = {},
): Promise<{ nrem: NREMResult; rem: REMResult }> {
  const nrem = await nremReplay(graph, logPath, options);
  const rem = remRefine(graph, { decayRate: options.decayRate });
  return { nrem, rem };
}

function pruneOrphanEdges(graph: KnowledgeGraph): number {
  const result = graph.db
    .prepare(
      `DELETE FROM edges WHERE
       source_id NOT IN (SELECT id FROM nodes) OR
       target_id NOT IN (SELECT id FROM nodes)`,
    )
    .run();
  return result.changes;
}
