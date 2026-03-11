/**
 * NREM/REM Consolidation Pipeline — the core memory engine.
 *
 * NREM: Replay → Extract → Score → Transfer (hippocampus → cortex)
 * REM:  Decay → Prune → Refine (homeostatic maintenance)
 */

import { readFileSync, existsSync } from "node:fs";
import type { KnowledgeGraph, Node, Edge } from "./graph.js";
import type { LogEntry } from "./log-parser.js";
import { parseLogFile, entriesSince } from "./log-parser.js";
import { readLogEntries, toLogEntries, logFilePath } from "./structured-log.js";
import { extractFromEntry } from "./extractors.js";
import {
  parseLlmExtraction,
  loadExtractionToGraph,
} from "./extractors.js";
import { scoreEntry } from "./salience.js";

export interface NREMResult {
  entriesProcessed: number;
  entitiesExtracted: number;
  relationshipsExtracted: number;
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  entriesByType: Record<string, number>;
  highSalienceEntries: string[];
}

export interface REMResult {
  nodesDecayed: number;
  nodesPruned: number;
  edgesPruned: number;
  associationsCreated: number;
  abstractionsMade: number;
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
  if (logPath && existsSync(logPath)) {
    if (logPath.endsWith(".jsonl")) {
      const structured = readLogEntries(
        agentName,
        options.sinceDate ? { sinceDate: options.sinceDate } : undefined,
      );
      entries.push(...toLogEntries(structured));
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
    for (const jsonText of options.llmExtractions) {
      const extraction = parseLlmExtraction(jsonText, agentName);
      result.entitiesExtracted += extraction.entities.length;
      result.relationshipsExtracted += extraction.relationships.length;

      const stats = loadExtractionToGraph(graph, extraction, true, namespace);
      result.nodesAdded += stats.nodesAdded;
      result.nodesReinforced += stats.nodesReinforced;
      result.edgesAdded += stats.edgesAdded;
    }
  } else {
    for (const entry of entries) {
      const extraction = await extractFromEntry(entry, agentName);
      result.entitiesExtracted += extraction.entities.length;
      result.relationshipsExtracted += extraction.relationships.length;

      const stats = loadExtractionToGraph(graph, extraction, true, namespace);
      result.nodesAdded += stats.nodesAdded;
      result.nodesReinforced += stats.nodesReinforced;
      result.edgesAdded += stats.edgesAdded;
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
