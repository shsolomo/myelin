/**
 * NREM/REM Sleep Pipeline — the core memory engine.
 *
 * NREM: Replay → Extract → Score → Transfer (hippocampus → cortex)
 * REM:  Decay → Prune → Refine (homeostatic maintenance)
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import type { Node, Edge } from "./graph.js";
import { KnowledgeGraph, NodeType } from "./graph.js";
import type { LogEntry } from "./log-parser.js";
import { parseLogFile, entriesSince } from "./log-parser.js";
import { toLogEntries, readLogEntries } from "./structured-log.js";
import type { StructuredLogEntry } from "./structured-log.js";
import { extractFromEntry } from "./extractors.js";
import {
  parseLlmExtraction,
  loadExtractionToGraph,
} from "./extractors.js";
import { getLlmExtractionPrompt } from "./vocabulary.js";
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
 * Acquire an exclusive lock for sleep cycle.
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
          message: `Sleep cycle already in progress (lock age: ${Math.round(age / 1000)}s). Aborting.`,
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

/** Release the sleep cycle lock. */
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
 * Create a timestamped backup of graph.db before sleep writes.
 * Keeps the latest MAX_BACKUPS copies and removes older ones.
 * @deprecated Use backupGraph(dbPath) for new code — supports date-dedup and time-based rotation.
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
  rotateByCount(dir, base);
  return backupPath;
}

/** Keep only the latest MAX_BACKUPS backup files (legacy count-based rotation). */
function rotateByCount(dir: string, dbBase: string): void {
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

// ── Backup (v2 — date-dedup + time-based rotation) ─────────────────────

/** Format a Date as YYYYMMDDHHmmss for backup filenames. */
function formatBackupTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Parse a YYYYMMDDHHmmss timestamp from a backup filename suffix. */
function parseBackupTimestamp(ts: string): Date | null {
  if (ts.length < 14) return null;
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1;
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const minute = parseInt(ts.slice(10, 12), 10);
  const second = parseInt(ts.slice(12, 14), 10);
  const d = new Date(year, month, day, hour, minute, second);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Create a timestamped backup of graph.db before sleep cycle.
 *
 * Filename format: `{dbPath}.backup-{YYYYMMDDHHmmss}`
 *
 * Skips (returns null) when:
 * - The database file doesn't exist (first run)
 * - A backup with today's date already exists (at most one backup per day)
 *
 * @returns The backup file path, or null if skipped.
 */
export function backupGraph(dbPath: string): string | null {
  if (!dbPath || !existsSync(dbPath)) return null;

  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const now = new Date();
  const tsStr = formatBackupTimestamp(now);
  const todayPrefix = tsStr.slice(0, 8); // YYYYMMDD

  // Skip if a backup with today's date already exists
  const prefix = `${base}.backup-`;
  try {
    const existing = readdirSync(dir).filter(f => f.startsWith(prefix));
    if (existing.some(f => f.startsWith(`${prefix}${todayPrefix}`))) return null;
  } catch { /* can't list directory — proceed with backup */ }

  const backupPath = join(dir, `${prefix}${tsStr}`);
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

/**
 * Delete backup files older than maxAgeDays.
 *
 * Scans for files matching `{dbPath}.backup-{YYYYMMDDHHmmss}`, parses the
 * embedded timestamp, and removes any whose age exceeds the threshold.
 *
 * @returns Count of deleted backup files.
 */
export function rotateBackups(dbPath: string, maxAgeDays: number = 7): number {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const prefix = `${base}.backup-`;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const files = readdirSync(dir).filter(f => f.startsWith(prefix));
    let deleted = 0;

    for (const f of files) {
      const tsStr = f.slice(prefix.length);
      const ts = parseBackupTimestamp(tsStr);
      if (!ts) continue; // skip files with unparseable timestamps (e.g. legacy ISO backups)

      if (now - ts.getTime() > maxAgeMs) {
        try {
          unlinkSync(join(dir, f));
          deleted++;
        } catch { /* best effort */ }
      }
    }

    return deleted;
  } catch {
    return 0;
  }
}

// ── LLM-driven sleep helpers ──────────────────────────────────────────────

export interface SleepChunk {
  text: string;
  entryCount: number;
}

/** @deprecated Use SleepChunk */
export type ConsolidationChunk = SleepChunk;

export interface SleepPrepareResult {
  agentName: string;
  totalEntries: number;
  chunks: SleepChunk[];
  extractionPrompt: string;
  watermark: string | null;
}

/** @deprecated Use SleepPrepareResult */
export type ConsolidationPrepareResult = SleepPrepareResult;

export interface IngestResult {
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  errors: string[];
}

// ── Watermark-based sleep state ───────────────────────────────────────────

/**
 * Read the last consolidated timestamp for an agent.
 * Returns null if the agent has never been through a sleep cycle.
 */
export function getWatermark(graph: KnowledgeGraph, agent: string): string | null {
  try {
    const row = graph.db
      .prepare('SELECT last_consolidated_ts FROM consolidation_state WHERE agent = ?')
      .get(agent) as { last_consolidated_ts: string } | undefined;
    return row?.last_consolidated_ts ?? null;
  } catch {
    return null;
  }
}

/**
 * Set the sleep watermark for an agent.
 * Upserts the timestamp and cumulative entry count.
 */
export function setWatermark(
  graph: KnowledgeGraph,
  agent: string,
  ts: string,
  entriesProcessed: number,
): void {
  graph.db
    .prepare(
      `INSERT INTO consolidation_state (agent, last_consolidated_ts, last_run_ts, entries_processed)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         last_consolidated_ts = excluded.last_consolidated_ts,
         last_run_ts = excluded.last_run_ts,
         entries_processed = consolidation_state.entries_processed + excluded.entries_processed`,
    )
    .run(agent, ts, new Date().toISOString(), entriesProcessed);
}

/**
 * Read an agent's pending logs and return them as text chunks
 * with the extraction schema for LLM-driven sleep cycle.
 *
 * Reads both .jsonl and .md log files. Filters by watermark if no
 * explicit sinceDate is provided and dbPath is set.
 */
export function prepareSleep(
  agentName: string,
  options?: {
    sinceDate?: string;
    chunkSize?: number;
    chunkIndex?: number;
    dbPath?: string;
    logsDir?: string;
  },
): SleepPrepareResult {
  const chunkSize = options?.chunkSize ?? 8;
  const AGENT_LOGS_DIR = options?.logsDir ?? join(homedir(), '.copilot', '.working-memory', 'agents');

  // Determine the effective sinceDate from watermark or explicit override
  let watermark: string | null = null;
  let effectiveSinceDate = options?.sinceDate;

  if (!effectiveSinceDate && options?.dbPath && existsSync(options.dbPath)) {
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
      // Graph not accessible — process all entries
    }
  }

  // Read JSONL entries via structured-log
  const jsonlEntries = readLogEntries(agentName, {
    sinceDate: effectiveSinceDate,
  });

  // Read .md entries via log-parser
  const mdLogPath = join(AGENT_LOGS_DIR, agentName, 'log.md');
  let mdEntries: LogEntry[] = [];
  if (existsSync(mdLogPath)) {
    try {
      const allMdEntries = parseLogFile(mdLogPath);
      if (effectiveSinceDate) {
        mdEntries = entriesSince(allMdEntries, effectiveSinceDate);
      } else {
        mdEntries = allMdEntries;
      }
    } catch {
      // .md parse failed — skip
    }
  }

  // Convert all entries to a common text format
  interface TextEntry {
    sortKey: string;
    text: string;
  }

  const textEntries: TextEntry[] = [];

  for (const e of jsonlEntries) {
    // Filter entries AT the watermark (only entries strictly after)
    if (watermark && e.ts <= watermark) continue;

    const parts = [`[${e.ts}] ${e.type}: ${e.summary}`];
    if (e.detail) parts.push(e.detail);
    if (e.tags.length > 0) parts.push(`Tags: ${e.tags.join(', ')}`);
    textEntries.push({ sortKey: e.ts, text: parts.join('\n') });
  }

  for (const e of mdEntries) {
    // Filter entries AT the watermark
    if (watermark && e.date <= watermark) continue;

    const parts = [`[${e.date}] ${e.entryType}: ${e.heading}`];
    if (e.content) parts.push(e.content);
    textEntries.push({ sortKey: e.date, text: parts.join('\n') });
  }

  // Sort by timestamp
  textEntries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  if (textEntries.length === 0) {
    return {
      agentName,
      totalEntries: 0,
      chunks: [],
      extractionPrompt: '',
      watermark,
    };
  }

  // Chunk entries into batches
  const allChunks: SleepChunk[] = [];
  for (let i = 0; i < textEntries.length; i += chunkSize) {
    const batch = textEntries.slice(i, i + chunkSize);
    const text = batch.map((e) => e.text).join('\n\n---\n\n');
    allChunks.push({ text, entryCount: batch.length });
  }

  // If chunkIndex is specified, return only that chunk
  const chunks =
    options?.chunkIndex !== undefined
      ? allChunks.slice(options.chunkIndex, options.chunkIndex + 1)
      : allChunks;

  // Get existing entity names from graph for linking context
  let existingEntities: string[] = [];
  if (options?.dbPath && existsSync(options.dbPath)) {
    try {
      const graph = new KnowledgeGraph(options.dbPath);
      try {
        const nodes = graph.findNodes({ limit: 200, minSalience: 0.3 });
        existingEntities = nodes.map((n: Node) => `${n.name} (${n.type})`);
      } finally {
        graph.close();
      }
    } catch {
      // Graph not accessible — skip entity context
    }
  }

  // Generate extraction prompt (schema only — caller combines with chunk text)
  const extractionPrompt = getLlmExtractionPrompt(
    '',
    existingEntities.length > 0 ? existingEntities : undefined,
  );

  return {
    agentName,
    totalEntries: textEntries.length,
    chunks,
    extractionPrompt,
    watermark,
  };
}

/** @deprecated Use prepareSleep */
export const prepareConsolidation = prepareSleep;

/**
 * Ingest LLM extraction results into the knowledge graph.
 * Thin wrapper around parseLlmExtraction + loadExtractionToGraph + applySensitivity.
 */
export function ingestExtractions(
  graph: KnowledgeGraph,
  extractions: string[],
  agentName: string,
): IngestResult {
  const result: IngestResult = {
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    errors: [],
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
        `extraction[${i}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ── Integrity checks ─────────────────────────────────────────────────────

/**
 * Post-sleep integrity check:
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
 * Run the NREM sleep phase on an agent's log.
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

  // Backup before graph writes
  const dbName = graph.db.name;
  if (dbName && dbName !== ':memory:') {
    backupGraph(dbName);
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
  // Backup before graph writes
  const dbName = graph.db.name;
  if (dbName && dbName !== ':memory:') {
    backupGraph(dbName);
  }

  const decayRate = options.decayRate ?? 0.05;
  const pruneThreshold = options.pruneThreshold ?? 0.05;
  const pruneMinAgeDays = options.pruneMinAgeDays ?? 30;

  const nodesDecayed = graph.decayAll(decayRate);
  const nodesPruned = graph.prune(pruneThreshold, pruneMinAgeDays);
  const edgesPruned = pruneOrphanEdges(graph);

  // Prune orphan knowledge nodes (no edges, low salience)
  // These are entities the LLM extracted but couldn't connect to anything meaningful
  const orphansPruned = graph.db
    .prepare(
      `DELETE FROM nodes WHERE
       category IN ('knowledge', 'nrem')
       AND salience < 0.5
       AND id NOT IN (SELECT source_id FROM edges)
       AND id NOT IN (SELECT target_id FROM edges)`,
    )
    .run();

  // Clean orphan embeddings (table may not exist)
  try {
    graph.db
      .prepare('DELETE FROM node_embeddings WHERE node_id NOT IN (SELECT id FROM nodes)')
      .run();
  } catch { /* node_embeddings table might not exist */ }

  return {
    nodesDecayed,
    nodesPruned: nodesPruned + orphansPruned.changes,
    edgesPruned,
    associationsCreated: 0,
    abstractionsMade: 0,
  };
}

/**
 * Run a full sleep cycle (NREM + REM).
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

  // Rotate old backups after successful sleep cycle
  const dbName = graph.db.name;
  if (dbName && dbName !== ':memory:') {
    rotateBackups(dbName);
  }

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
