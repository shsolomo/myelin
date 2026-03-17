/**
 * Tests for structured-log.ts — JSONL agent logging.
 *
 * Covers: writeLogEntry, readLogEntries, toLogEntries, entryCount, logFilePath
 * Uses OS temp directory to avoid polluting real agent logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock the paths before importing the module
const TEST_DIR = join(tmpdir(), `myelin-test-${Date.now()}`);
const MOCK_AGENT_LOGS_DIR = join(TEST_DIR, '.copilot', '.working-memory', 'agents');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    homedir: () => TEST_DIR,
  };
});

// Now import the module (will use mocked homedir)
const structuredLog = await import('../../src/memory/structured-log.js');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// writeLogEntry
// ---------------------------------------------------------------------------

describe('writeLogEntry', () => {
  it('creates log file and returns path', () => {
    const path = structuredLog.writeLogEntry('test-agent', 'observation', 'Test summary');
    expect(path).toContain('test-agent');
    expect(path).toContain('log.jsonl');
    expect(existsSync(path)).toBe(true);
  });

  it('appends multiple entries to the same file', () => {
    structuredLog.writeLogEntry('test-agent', 'observation', 'Entry 1');
    structuredLog.writeLogEntry('test-agent', 'action', 'Entry 2');
    structuredLog.writeLogEntry('test-agent', 'decision', 'Entry 3');

    const entries = structuredLog.readLogEntries('test-agent');
    expect(entries).toHaveLength(3);
  });

  it('includes all fields in the JSONL entry', () => {
    structuredLog.writeLogEntry('test-agent', 'finding', 'Found something', {
      detail: 'More details here',
      sessionId: 'session-123',
      tags: ['alpha', 'beta'],
      context: { key: 'value' },
    });

    const entries = structuredLog.readLogEntries('test-agent');
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.agent).toBe('test-agent');
    expect(entry.type).toBe('finding');
    expect(entry.summary).toBe('Found something');
    expect(entry.detail).toBe('More details here');
    expect(entry.sessionId).toBe('session-123');
    expect(entry.tags).toEqual(['alpha', 'beta']);
    expect(entry.context).toEqual({ key: 'value' });
  });

  it('generates ISO timestamp', () => {
    structuredLog.writeLogEntry('test-agent', 'observation', 'Test');
    const entries = structuredLog.readLogEntries('test-agent');
    expect(entries[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// readLogEntries
// ---------------------------------------------------------------------------

describe('readLogEntries', () => {
  it('returns empty array for non-existent agent', () => {
    const entries = structuredLog.readLogEntries('nonexistent-agent');
    expect(entries).toEqual([]);
  });

  it('filters by sinceDate', () => {
    // Write entries manually with controlled timestamps
    const dir = join(MOCK_AGENT_LOGS_DIR, 'date-agent');
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, 'log.jsonl');

    appendFileSync(logFile, JSON.stringify({ ts: '2025-12-01T10:00:00Z', agent: 'date-agent', type: 'observation', summary: 'Old' }) + '\n');
    appendFileSync(logFile, JSON.stringify({ ts: '2025-12-15T10:00:00Z', agent: 'date-agent', type: 'observation', summary: 'New' }) + '\n');

    const all = structuredLog.readLogEntries('date-agent');
    expect(all).toHaveLength(2);

    const filtered = structuredLog.readLogEntries('date-agent', { sinceDate: '2025-12-10' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].summary).toBe('New');
  });

  it('filters by entryType', () => {
    structuredLog.writeLogEntry('type-agent', 'observation', 'Obs 1');
    structuredLog.writeLogEntry('type-agent', 'decision', 'Dec 1');
    structuredLog.writeLogEntry('type-agent', 'observation', 'Obs 2');

    const decisions = structuredLog.readLogEntries('type-agent', { entryType: 'decision' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].summary).toBe('Dec 1');
  });

  it('respects limit (takes last N entries)', () => {
    for (let i = 0; i < 5; i++) {
      structuredLog.writeLogEntry('limit-agent', 'observation', `Entry ${i}`);
    }
    const limited = structuredLog.readLogEntries('limit-agent', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].summary).toBe('Entry 3');
    expect(limited[1].summary).toBe('Entry 4');
  });

  it('filters by sinceTimestamp with full ISO precision', () => {
    const dir = join(MOCK_AGENT_LOGS_DIR, 'ts-agent');
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, 'log.jsonl');

    appendFileSync(logFile, JSON.stringify({ ts: '2026-03-15T10:00:00Z', agent: 'ts-agent', type: 'action', summary: 'Before watermark' }) + '\n');
    appendFileSync(logFile, JSON.stringify({ ts: '2026-03-15T12:00:00Z', agent: 'ts-agent', type: 'action', summary: 'At watermark' }) + '\n');
    appendFileSync(logFile, JSON.stringify({ ts: '2026-03-15T14:00:00Z', agent: 'ts-agent', type: 'finding', summary: 'After watermark' }) + '\n');

    const filtered = structuredLog.readLogEntries('ts-agent', { sinceTimestamp: '2026-03-15T12:00:00Z' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].summary).toBe('After watermark');
  });
});

// ---------------------------------------------------------------------------
// toLogEntries
// ---------------------------------------------------------------------------

describe('toLogEntries', () => {
  it('converts structured entries to LogEntry objects', () => {
    structuredLog.writeLogEntry('conv-agent', 'decision', 'Made a choice', {
      detail: 'Chose option A',
      tags: ['architecture'],
    });

    const structured = structuredLog.readLogEntries('conv-agent');
    const logEntries = structuredLog.toLogEntries(structured);

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].entryType).toBe('decision');
    expect(logEntries[0].heading).toBe('Made a choice');
    expect(logEntries[0].content).toContain('Chose option A');
    expect(logEntries[0].content).toContain('architecture');
    expect(logEntries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses summary as content when no detail/tags/context', () => {
    structuredLog.writeLogEntry('simple-agent', 'observation', 'Simple note');

    const structured = structuredLog.readLogEntries('simple-agent');
    const logEntries = structuredLog.toLogEntries(structured);

    expect(logEntries[0].content).toBe('Simple note');
  });

  it('includes metadata.agent', () => {
    structuredLog.writeLogEntry('meta-agent', 'action', 'Did something');
    const structured = structuredLog.readLogEntries('meta-agent');
    const logEntries = structuredLog.toLogEntries(structured);
    expect(logEntries[0].metadata.agent).toBe('meta-agent');
  });

  it('handles empty input', () => {
    expect(structuredLog.toLogEntries([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// entryCount
// ---------------------------------------------------------------------------

describe('entryCount', () => {
  it('returns 0 for non-existent agent', () => {
    expect(structuredLog.entryCount('ghost-agent')).toBe(0);
  });

  it('counts entries correctly', () => {
    structuredLog.writeLogEntry('count-agent', 'observation', 'One');
    structuredLog.writeLogEntry('count-agent', 'action', 'Two');
    expect(structuredLog.entryCount('count-agent')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// logFilePath
// ---------------------------------------------------------------------------

describe('logFilePath', () => {
  it('returns expected path format', () => {
    const path = structuredLog.logFilePath('my-agent');
    expect(path).toContain('my-agent');
    expect(path).toContain('log.jsonl');
  });
});
