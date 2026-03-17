/**
 * Structured agent logging — JSONL-based deterministic log entries.
 *
 * Replaces freeform markdown logging with machine-parseable JSONL format.
 * Each line in log.jsonl is a self-contained JSON object with a fixed schema.
 * Entries feed into the NREM consolidation pipeline via toLogEntries().
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { LogEntry } from './log-parser.js';
import { makeEntry } from './log-parser.js';

// --- Paths ---

const COPILOT_ROOT = join(homedir(), '.copilot');
const AGENT_LOGS_DIR = join(COPILOT_ROOT, '.working-memory', 'agents');

// --- Interfaces ---

export interface StructuredLogEntry {
  ts: string; // ISO 8601 UTC timestamp
  agent: string; // Agent name
  type: string; // Event type: decision, action, finding, error, handover, observation
  summary: string; // One-line summary
  detail: string; // Optional extended detail
  sessionId: string; // Optional Copilot session ID
  tags: string[]; // Optional tags
  context: Record<string, unknown>; // Optional structured context
}

export interface WriteLogOptions {
  detail?: string;
  sessionId?: string;
  tags?: string[];
  context?: Record<string, unknown>;
}

export interface ReadLogOptions {
  sinceDate?: string;
  sinceTimestamp?: string; // Full ISO 8601 timestamp — entries at or before this are excluded
  entryType?: string;
  limit?: number;
}

// --- Public API ---

/**
 * Append a JSONL line to an agent's log.jsonl file.
 * Returns the log file path.
 */
export function writeLogEntry(
  agentName: string,
  entryType: string,
  summary: string,
  options: WriteLogOptions = {},
): string {
  const logDir = join(AGENT_LOGS_DIR, agentName);
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'log.jsonl');

  const entry: StructuredLogEntry = {
    ts: new Date().toISOString(),
    agent: agentName,
    type: entryType,
    summary,
    detail: options.detail ?? '',
    sessionId: options.sessionId ?? '',
    tags: options.tags ?? [],
    context: options.context ?? {},
  };

  appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
  return logFile;
}

/**
 * Read and filter entries from an agent's JSONL log file.
 */
export function readLogEntries(
  agentName: string,
  options: ReadLogOptions = {},
): StructuredLogEntry[] {
  const logFile = join(AGENT_LOGS_DIR, agentName, 'log.jsonl');
  if (!existsSync(logFile)) return [];

  const raw = readFileSync(logFile, 'utf-8').trim();
  if (!raw) return [];

  let entries: StructuredLogEntry[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const data = JSON.parse(line) as Record<string, unknown>;

    const entry: StructuredLogEntry = {
      ts: data.ts as string,
      agent: data.agent as string,
      type: data.type as string,
      summary: data.summary as string,
      detail: (data.detail as string) ?? '',
      sessionId: (data.sessionId as string) ?? (data.session_id as string) ?? '',
      tags: (data.tags as string[]) ?? [],
      context: (data.context as Record<string, unknown>) ?? {},
    };

    if (options.sinceDate && entry.ts.slice(0, 10) < options.sinceDate) continue;
    if (options.sinceTimestamp && entry.ts <= options.sinceTimestamp) continue;
    if (options.entryType && entry.type !== options.entryType) continue;

    entries.push(entry);
  }

  if (options.limit !== undefined) {
    entries = entries.slice(-options.limit);
  }

  return entries;
}

/**
 * Convert structured entries to LogEntry objects for the NREM pipeline.
 *
 * Maps fields so structured log entries can feed directly into the
 * existing consolidation pipeline (extractors, salience scoring, etc.).
 */
export function toLogEntries(entries: StructuredLogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];

  for (const e of entries) {
    const contentParts: string[] = [];
    if (e.detail) contentParts.push(e.detail);
    if (e.tags.length > 0) contentParts.push(`Tags: ${e.tags.join(', ')}`);
    if (Object.keys(e.context).length > 0)
      contentParts.push(`Context: ${JSON.stringify(e.context)}`);

    const content =
      contentParts.length > 0 ? contentParts.join('\n') : e.summary;

    const metadata: Record<string, string> = { agent: e.agent };
    if (e.sessionId) metadata.sessionId = e.sessionId;
    if (e.tags.length > 0) metadata.tags = e.tags.join(', ');

    result.push(makeEntry(e.ts.slice(0, 10), e.summary, content, e.type, metadata));
  }

  return result;
}

/** Return the path to an agent's log.jsonl file. */
export function logFilePath(agentName: string): string {
  return join(AGENT_LOGS_DIR, agentName, 'log.jsonl');
}

/** Count of entries in an agent's log file. */
export function entryCount(agentName: string): number {
  const logFile = join(AGENT_LOGS_DIR, agentName, 'log.jsonl');
  if (!existsSync(logFile)) return 0;

  const raw = readFileSync(logFile, 'utf-8').trim();
  if (!raw) return 0;

  return raw.split('\n').filter((line) => line.trim()).length;
}
