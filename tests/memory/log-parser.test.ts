/**
 * Tests for log-parser.ts — the hippocampal log reader.
 *
 * Covers: parseLog, entriesByDate, entriesSince, makeEntry, classifyEntry behavior
 */

import { describe, it, expect } from 'vitest';
import { parseLog, entriesByDate, entriesSince, makeEntry } from '../../src/memory/log-parser.js';

// ---------------------------------------------------------------------------
// parseLog
// ---------------------------------------------------------------------------

describe('parseLog', () => {
  it('parses a simple log with one date and one section', () => {
    const log = `# Log
_Append-only_

## 2025-12-01

### First finding
Found a bug in the auth module.
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-12-01');
    expect(entries[0].heading).toBe('First finding');
    expect(entries[0].content).toBe('Found a bug in the auth module.');
  });

  it('parses multiple sections under one date', () => {
    const log = `## 2025-12-01

### Section A
Content A

### Section B
Content B
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(2);
    expect(entries[0].heading).toBe('Section A');
    expect(entries[1].heading).toBe('Section B');
    expect(entries[0].date).toBe('2025-12-01');
    expect(entries[1].date).toBe('2025-12-01');
  });

  it('parses multiple dates', () => {
    const log = `## 2025-12-01

### Day 1
Content 1

## 2025-12-02

### Day 2
Content 2
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe('2025-12-01');
    expect(entries[1].date).toBe('2025-12-02');
  });

  it('skips the file header lines', () => {
    const log = `# Log — Agent Memory
_Append-only episodic log._

## 2025-12-01

### Entry
Some content here.
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Some content here.');
  });

  it('skips horizontal rule separators', () => {
    const log = `## 2025-12-01

### Entry
Line one
---
Line two
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('Line one');
    expect(entries[0].content).toContain('Line two');
    expect(entries[0].content).not.toContain('---');
  });

  it('skips consolidated notes', () => {
    const log = `## 2025-12-01

### Entry
_Consolidated 2025-12-02._
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(0);
  });

  it('handles empty content sections', () => {
    const log = `## 2025-12-01

### Empty section

### Has content
Real content here.
`;
    const entries = parseLog(log);
    // Only the section with actual content should appear
    expect(entries.some(e => e.heading === 'Has content')).toBe(true);
  });

  it('handles content without a section heading', () => {
    const log = `## 2025-12-01

Orphan content line.
`;
    const entries = parseLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0].heading).toBe('');
    expect(entries[0].content).toBe('Orphan content line.');
  });

  it('returns empty array for empty input', () => {
    expect(parseLog('')).toHaveLength(0);
  });

  it('returns empty array for header-only input', () => {
    const log = `# Log
_Append-only_
`;
    expect(parseLog(log)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// classifyEntry (tested via parseLog's entryType assignment)
// ---------------------------------------------------------------------------

describe('entry classification', () => {
  it('classifies handover sections', () => {
    const log = `## 2025-12-01

### Session Handover
Pending items for next session.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('handover');
  });

  it('classifies decisions from heading/content', () => {
    const log = `## 2025-12-01

### Key choice
We decided to use SQLite for the graph store.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('decision');
  });

  it('classifies actions from content verbs', () => {
    const log = `## 2025-12-01

### Build work
Created the new parser module and deployed it to staging.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('action');
  });

  it('defaults to observation when no signals match', () => {
    const log = `## 2025-12-01

### Random note
The weather is nice today.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('observation');
  });

  it('prefers handover over decision markers', () => {
    const log = `## 2025-12-01

### Session Handover
We decided to stop here.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('handover');
  });

  it('prefers decision over action when both present', () => {
    const log = `## 2025-12-01

### Update
We decided to use the new approach and created a PR.
`;
    const entries = parseLog(log);
    expect(entries[0].entryType).toBe('decision');
  });
});

// ---------------------------------------------------------------------------
// makeEntry
// ---------------------------------------------------------------------------

describe('makeEntry', () => {
  it('creates an entry with all fields', () => {
    const entry = makeEntry('2025-12-01', 'My heading', 'Content here', 'decision', { key: 'val' });
    expect(entry.date).toBe('2025-12-01');
    expect(entry.heading).toBe('My heading');
    expect(entry.content).toBe('Content here');
    expect(entry.entryType).toBe('decision');
    expect(entry.metadata).toEqual({ key: 'val' });
  });

  it('provides fullText as heading + content', () => {
    const entry = makeEntry('2025-12-01', 'Heading', 'Content', 'observation');
    expect(entry.fullText).toBe('Heading\nContent');
  });

  it('provides fullText as content alone when heading is empty', () => {
    const entry = makeEntry('2025-12-01', '', 'Just content', 'observation');
    expect(entry.fullText).toBe('Just content');
  });

  it('defaults metadata to empty object', () => {
    const entry = makeEntry('2025-12-01', '', 'Content', 'observation');
    expect(entry.metadata).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// entriesByDate
// ---------------------------------------------------------------------------

describe('entriesByDate', () => {
  it('groups entries by their date field', () => {
    const entries = [
      makeEntry('2025-12-01', 'A', 'a', 'observation'),
      makeEntry('2025-12-01', 'B', 'b', 'observation'),
      makeEntry('2025-12-02', 'C', 'c', 'observation'),
    ];
    const grouped = entriesByDate(entries);
    expect(Object.keys(grouped)).toHaveLength(2);
    expect(grouped['2025-12-01']).toHaveLength(2);
    expect(grouped['2025-12-02']).toHaveLength(1);
  });

  it('returns empty object for empty input', () => {
    expect(entriesByDate([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// entriesSince
// ---------------------------------------------------------------------------

describe('entriesSince', () => {
  const entries = [
    makeEntry('2025-11-30', '', 'old', 'observation'),
    makeEntry('2025-12-01', '', 'boundary', 'observation'),
    makeEntry('2025-12-02', '', 'new', 'observation'),
  ];

  it('filters entries on or after the given date', () => {
    const result = entriesSince(entries, '2025-12-01');
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2025-12-01');
    expect(result[1].date).toBe('2025-12-02');
  });

  it('returns all entries when sinceDate is before all entries', () => {
    expect(entriesSince(entries, '2025-01-01')).toHaveLength(3);
  });

  it('returns empty when sinceDate is after all entries', () => {
    expect(entriesSince(entries, '2026-01-01')).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(entriesSince([], '2025-12-01')).toHaveLength(0);
  });
});
