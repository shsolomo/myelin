/**
 * Heartbeat memory.md migration tool.
 *
 * Parses GENESIS heartbeat memory.md files and imports entries
 * into the myelin knowledge graph. Handles two section types:
 *
 *   ## Corrected  → Rule/Convention nodes (high salience, 0.9+)
 *   ## Learned    → Knowledge nodes (salience based on age/recency)
 *
 * Entry format:
 *   - Entry text - *corrected: YYYY-MM-DD*
 *   - Entry text - *learned: YYYY-MM-DD, reinforced: YYYY-MM-DD*
 */

import { KnowledgeGraph, NodeType } from './graph.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatEntry {
  text: string;
  kind: 'corrected' | 'learned';
  date: string;            // ISO date (YYYY-MM-DD)
  reinforcedDate?: string; // ISO date, only for learned entries
}

export interface MigrationResult {
  imported: number;
  skipped: number;
  entries: HeartbeatEntry[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a heartbeat memory.md string into structured entries.
 *
 * Expects markdown with ## Corrected and ## Learned sections.
 * Each bullet under a section is one entry.
 */
export function parseHeartbeatMemory(content: string): HeartbeatEntry[] {
  const entries: HeartbeatEntry[] = [];
  let currentKind: 'corrected' | 'learned' | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Section headers
    if (/^##\s+Corrected\b/i.test(line)) {
      currentKind = 'corrected';
      continue;
    }
    if (/^##\s+Learned\b/i.test(line)) {
      currentKind = 'learned';
      continue;
    }
    // Any other ## heading ends the current section
    if (/^##\s+/.test(line)) {
      currentKind = null;
      continue;
    }

    if (!currentKind) continue;
    if (!line.startsWith('-')) continue;

    const entry = parseBulletLine(line, currentKind);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Parse a single bullet line into a HeartbeatEntry.
 *
 * Formats:
 *   - Text here - *corrected: 2026-03-11*
 *   - Text here - *learned: 2026-03-04*
 *   - Text here - *learned: 2026-03-04, reinforced: 2026-03-11*
 */
function parseBulletLine(line: string, kind: 'corrected' | 'learned'): HeartbeatEntry | null {
  // Strip leading "- "
  const body = line.replace(/^-\s*/, '');

  // Match the metadata suffix: *kind: YYYY-MM-DD[, reinforced: YYYY-MM-DD]*
  const metaPattern = /\s*-\s*\*(?:corrected|learned):\s*(\d{4}-\d{2}-\d{2})(?:,\s*reinforced:\s*(\d{4}-\d{2}-\d{2}))?\s*\*\s*$/;
  const match = body.match(metaPattern);

  if (!match) {
    // Try without the trailing asterisk format — bare date
    const barePattern = /\s*-\s*(?:corrected|learned):\s*(\d{4}-\d{2}-\d{2})(?:,\s*reinforced:\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
    const bareMatch = body.match(barePattern);
    if (bareMatch) {
      const text = body.slice(0, bareMatch.index!).trim();
      if (!text) return null;
      return {
        text,
        kind,
        date: bareMatch[1],
        reinforcedDate: bareMatch[2] || undefined,
      };
    }

    // No date found — use the whole line as text with today's date
    const text = body.trim();
    if (!text) return null;
    return {
      text,
      kind,
      date: new Date().toISOString().slice(0, 10),
    };
  }

  const text = body.slice(0, match.index!).trim();
  if (!text) return null;

  return {
    text,
    kind,
    date: match[1],
    reinforcedDate: match[2] || undefined,
  };
}

// ---------------------------------------------------------------------------
// Node ID generation
// ---------------------------------------------------------------------------

/** Convert entry text to a kebab-case ID, max 40 chars. */
export function entryToId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Salience calculation
// ---------------------------------------------------------------------------

/**
 * Calculate salience for a learned entry based on age.
 * Newer entries get higher salience. Base 0.7, max 0.9.
 * Reinforced entries get a 0.05 bonus.
 */
export function learnedSalience(dateStr: string, reinforcedDate?: string): number {
  const entryDate = new Date(dateStr + 'T00:00:00.000Z');
  const now = new Date();
  const todayMs = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();
  const ageDays = Math.max(0, (todayMs - entryDate.getTime()) / (1000 * 60 * 60 * 24));

  // Base 0.7, decay by 0.01 per 7 days, floor at 0.5
  const base = Math.max(0.5, 0.7 - (ageDays / 7) * 0.01);
  const bonus = reinforcedDate ? 0.05 : 0;

  return Math.min(0.9, base + bonus);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Import heartbeat memory.md entries into the knowledge graph.
 *
 * - Corrected entries → Rule/Convention nodes, salience 0.9+
 * - Learned entries → Knowledge nodes, salience based on age
 * - Skips duplicates (same node ID already exists)
 */
export function migrateHeartbeatToGraph(
  graph: KnowledgeGraph,
  content: string,
  options: {
    sourceAgent?: string;
    namespace?: string;
  } = {},
): MigrationResult {
  const sourceAgent = options.sourceAgent ?? 'heartbeat-migration';
  const namespace = options.namespace ?? 'heartbeat';
  const entries = parseHeartbeatMemory(content);

  let imported = 0;
  let skipped = 0;

  graph.extendForCode(); // Ensure extended columns exist

  for (const entry of entries) {
    const id = entryToId(entry.text);

    // Duplicate detection
    const existing = graph.getNode(id);
    if (existing) {
      skipped++;
      continue;
    }

    const nodeType = entry.kind === 'corrected' ? NodeType.Rule : NodeType.Concept;
    const salience = entry.kind === 'corrected' ? 0.9 : learnedSalience(entry.date, entry.reinforcedDate);
    const lastReinforced = entry.reinforcedDate ?? entry.date;

    try {
      graph.addNode({
        id,
        name: entry.text.slice(0, 80),
        type: nodeType,
        description: entry.text,
        salience,
        confidence: 1.0,
        sourceAgent,
        tags: ['heartbeat', entry.kind],
        createdAt: `${entry.date}T00:00:00.000Z`,
        lastReinforced: `${lastReinforced}T00:00:00.000Z`,
        category: 'knowledge',
        namespace,
        sensitivity: 0,
      });
      imported++;
    } catch {
      // If addNode fails (e.g. race condition), try reinforcing
      graph.reinforceNode(id, 0.1);
      skipped++;
    }
  }

  return { imported, skipped, entries };
}
