/**
 * Log parser — transforms raw log.md content into structured entries.
 *
 * The log is the "hippocampus" — fast episodic writes during sessions.
 * This module reads it and produces structured entries ready for extraction.
 */

import { readFileSync } from 'node:fs';

// --- Interfaces ---

export interface LogEntry {
  date: string;
  heading: string;
  content: string;
  entryType: string; // observation | handover | decision | action
  metadata: Record<string, string>;
  readonly fullText: string;
}

// --- Regex patterns ---

const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})/;
const SECTION_HEADING = /^### (.+)/;
const CONSOLIDATED_NOTE = /^_Consolidated .+\._$/;
const HANDOVER_HEADING = /^### Session Handover/;
const DECISION_MARKERS =
  /\b(decided|agreed|chose|going with|settled on|key decision|design decision)\b/i;
const ACTION_MARKERS =
  /\b(created|updated|built|implemented|fixed|deployed|published|posted|sent)\b/i;

// --- Internal helpers ---

function classifyEntry(heading: string, content: string): string {
  const combined = `${heading}\n${content}`;

  if (HANDOVER_HEADING.test(`### ${heading}`)) return 'handover';
  if (DECISION_MARKERS.test(combined)) return 'decision';
  if (ACTION_MARKERS.test(combined)) return 'action';
  return 'observation';
}

function makeEntry(
  date: string,
  heading: string,
  content: string,
  entryType: string,
  metadata: Record<string, string> = {},
): LogEntry {
  return {
    date,
    heading,
    content,
    entryType,
    metadata,
    get fullText(): string {
      return this.heading ? `${this.heading}\n${this.content}` : this.content;
    },
  };
}

// --- Public API ---

/**
 * Parse a log.md string into structured entries.
 *
 * Groups content by `## YYYY-MM-DD` date headings, then `### heading`
 * sub-headers. Each section becomes a separate LogEntry.
 */
export function parseLog(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = content.split('\n');

  let currentDate: string | null = null;
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (currentDate && currentLines.length > 0) {
      const text = currentLines.join('\n').trim();
      if (text && !CONSOLIDATED_NOTE.test(text)) {
        const entryType = classifyEntry(currentHeading ?? '', text);
        entries.push(
          makeEntry(currentDate, currentHeading ?? '', text, entryType),
        );
      }
    }
    currentLines = [];
  }

  for (const line of lines) {
    // Skip the file header
    if (line.startsWith('# Log') || line.startsWith('_Append-only')) {
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

    if (line.trim() === '---') {
      continue;
    }

    currentLines.push(line);
  }

  flush();
  return entries;
}

/** Parse a log.md file from disk. */
export function parseLogFile(path: string): LogEntry[] {
  const content = readFileSync(path, 'utf-8');
  return parseLog(content);
}

/** Group entries by date. */
export function entriesByDate(
  entries: LogEntry[],
): Record<string, LogEntry[]> {
  const grouped: Record<string, LogEntry[]> = {};
  for (const entry of entries) {
    if (!grouped[entry.date]) {
      grouped[entry.date] = [];
    }
    grouped[entry.date].push(entry);
  }
  return grouped;
}

/** Filter entries to only those on or after the given date (YYYY-MM-DD). */
export function entriesSince(
  entries: LogEntry[],
  sinceDate: string,
): LogEntry[] {
  return entries.filter((e) => e.date >= sinceDate);
}

// Re-export makeEntry for use by other modules that need to construct LogEntry
export { makeEntry };
