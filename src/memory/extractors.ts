/**
 * Entity and relationship extraction from text.
 *
 * Three extraction modes:
 * 1. NER-based (GLiNER): Zero-shot named-entity recognition. Primary path.
 * 2. Rule-based: Fast, deterministic, uses vocabulary patterns. Fallback.
 * 3. LLM-based: Rich, contextual, uses the consolidation skill. Best judgment.
 *
 * The LLM extraction produces JSON that this module parses and loads into
 * the graph. The NER/rule-based extraction provides a fallback when LLM
 * isn't available.
 */

import {
  type Node,
  type Edge,
  NodeType,
  RelationshipType,
  KnowledgeGraph,
} from "./graph.js";
import type { LogEntry } from "./log-parser.js";
import { makeEntry } from "./log-parser.js";
import { scoreEntry } from "./salience.js";
import { ENTITY_PATTERNS, RELATIONSHIP_PATTERNS } from "./vocabulary.js";
import * as ner from "./ner.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Result of entity/relationship extraction from a log entry. */
export interface ExtractionResult {
  sourceEntry: LogEntry;
  entities: Node[];
  relationships: Edge[];
  salience: number;
}

/** Stats returned by loadExtractionToGraph. */
export interface ExtractionStats {
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  edgesSkipped: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps GLiNER label strings to NodeType enum values. */
export const LABEL_TO_NODE_TYPE: Record<string, NodeType> = {
  person: NodeType.Person,
  "software tool": NodeType.Tool,
  "architectural decision": NodeType.Decision,
  "bug or error": NodeType.Bug,
  "design pattern": NodeType.Pattern,
  "project or initiative": NodeType.Initiative,
  "meeting or ceremony": NodeType.Meeting,
  "operational rule": NodeType.Rule,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a display name to a kebab-case ID, max 40 chars. */
export function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Heuristic: is this capitalised text likely a person's name? */
export function isLikelyPerson(name: string): boolean {
  const NON_NAMES = new Set([
    "Red PI",
    "Hub Hour",
    "Mission Control",
    "Key Vault",
    "Service Bus",
    "Azure DevOps",
    "Private Link",
    "Teams MCP",
    "Daily Report",
    "Session Handover",
    "Phase 1",
    "Phase 2",
    "Phase 3",
    "Phase 4",
  ]);

  if (NON_NAMES.has(name)) return false;
  if (name.split(" ").length > 3) return false;

  const NON_PERSON_WORDS = new Set([
    "System",
    "Built",
    "Framework",
    "Decision",
    "Architecture",
    "Ecosystem",
    "Restructure",
    "Report",
    "Pipeline",
    "Integration",
    "Research",
    "Session",
    "Handover",
    "Vision",
    "Morning",
    "Evening",
    "Afternoon",
    "Night",
    "Memory",
    "Consolidation",
    "Heartbeat",
    "Domain",
    "Patching",
    "Lifecycle",
    "Description",
    "Feature",
    "Populated",
    "Diagnosed",
    "Fixed",
    "Expansion",
    "Recap",
    "Update",
    "Notes",
    "Audit",
    "Rewrite",
    "Connectivity",
    "Actions",
    "Patch",
    "Control",
    "Graph",
    "Sync",
    "Code",
    "Data",
    "Tool",
    "Skill",
    "Agent",
    "Rule",
    "Convention",
    "Pattern",
    "Bug",
    "Sprint",
    "Backlog",
    "Setup",
    "Config",
    "Status",
    "Deployment",
    "Orchestration",
    "Convergence",
    "Breakthough",
    "Day",
    "Refinement",
    "Established",
    "Analyzed",
    "Discovered",
    "Updated",
    "Created",
    "Calendar",
    "Channel",
    "Chat",
    "Message",
    "Personal",
    "Recurring",
    "Security",
    "Credential",
    "Geneva",
    "Private",
    "Instance",
    "Coast",
    "Pulse",
    "Time",
    "Dark",
    "Scheduler",
    "Task",
    "Windows",
    "Uses",
    "Setting",
    "Line",
    "Descriptions",
    "Multi",
    "Azure",
    "Connection",
    "Preview",
    "Public",
    "Key",
    "Value",
    "Table",
    "West",
    "East",
    "North",
    "South",
  ]);

  for (const word of name.split(" ")) {
    if (NON_PERSON_WORDS.has(word)) return false;
  }

  return true;
}

/** Extract a summary from text content (first meaningful line). */
export function extractSummary(text: string, maxLen = 200): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^- /, "");
    if (line && !line.startsWith("_") && line.length > 10) {
      return line.slice(0, maxLen);
    }
  }
  return text.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Internal: node / edge construction helpers
// ---------------------------------------------------------------------------

function buildNode(
  id: string,
  type: NodeType | string,
  name: string,
  description: string,
  salience: number,
  sourceAgent: string,
  tags: string[],
): Node {
  const now = new Date().toISOString();
  return {
    id,
    type,
    name,
    description,
    salience,
    confidence: 1.0,
    sourceAgent,
    createdAt: now,
    lastReinforced: now,
    tags,
  };
}

function buildEdge(
  sourceId: string,
  targetId: string,
  relationship: RelationshipType | string,
  description: string,
  sourceAgent: string,
): Edge {
  const now = new Date().toISOString();
  return {
    sourceId,
    targetId,
    relationship,
    weight: 1.0,
    description,
    sourceAgent,
    createdAt: now,
    lastReinforced: now,
  };
}

// ---------------------------------------------------------------------------
// Internal extraction paths
// ---------------------------------------------------------------------------

/** Known agent names that GLiNER may classify as persons. */
const AGENT_NAMES = new Set([
  "donna", "moneypenny", "monday", "skippy", "coco",
  "consolidator", "ado-analyst", "scribe", "scout",
  "vault-librarian", "researcher", "copilot",
]);

/** Filter out low-quality person matches from NER output. */
function isValidPersonEntity(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Reject agent names
  if (AGENT_NAMES.has(lower)) return false;

  // Reject pronouns and common words
  if (["he", "she", "they", "it", "we", "i", "me", "you"].includes(lower)) return false;

  // Reject single characters
  if (text.trim().length <= 2) return false;

  // Reject if it contains special chars (/, +, &, @)  these are compound references
  if (/[\/+&@]/.test(text)) return false;

  return true;
}

/** Reject generic/garbage entities that NER sometimes extracts. */
function isValidEntity(name: string, nodeType: NodeType): boolean {
  const lower = name.toLowerCase().trim();

  // Reject very short names (≤ 2 chars)
  if (lower.length <= 2) return false;

  // Reject if it's a generic node type word itself
  const GENERIC_WORDS = new Set([
    'person', 'people', 'bug', 'bugs', 'bugfix', 'tool', 'tools',
    'pattern', 'patterns', 'decision', 'decisions', 'rule', 'rules',
    'meeting', 'meetings', 'initiative', 'concept', 'convention',
    'open', 'closed', 'fixed', 'done', 'pending', 'blocked',
    'error', 'warning', 'issue', 'issues', 'feature', 'features',
    'code', 'data', 'file', 'files', 'config', 'setup', 'update',
    'system', 'module', 'service', 'api', 'cli', 'ui',
    'test', 'tests', 'build', 'deploy', 'run', 'start', 'stop',
    'true', 'false', 'null', 'undefined', 'none',
    'yes', 'no', 'ok', 'the', 'this', 'that',
    'real tools', 'reparse',
  ]);
  if (GENERIC_WORDS.has(lower)) return false;

  // Reject bare file extensions
  if (/^\.[a-z]+$/.test(lower) || /^[a-z]{1,4}$/.test(lower) && ['ts', 'js', 'py', 'go', 'md', 'cs', 'sh'].includes(lower)) return false;

  // Reject if contains special chars (except spaces and hyphens)
  if (/[\/+&@#$%^*(){}[\]<>|\\]/.test(name)) return false;

  return true;
}

/** Max character distance between two NER entities for a co-occurrence edge. */
// Uses both an absolute cap and a relative cap (40% of entry length) so that
// short entries don't degenerate into "everything connects".
const CO_OCCURRENCE_PROXIMITY = 300;
const CO_OCCURRENCE_RATIO = 0.4;

/** Primary extraction path using GLiNER zero-shot NER. */
async function extractWithNer(
  entry: LogEntry,
  salienceScore: number,
  sourceAgent: string,
): Promise<ExtractionResult> {
  const nerEntities = await ner.extractEntities(entry.fullText);

  const entities: Node[] = [];
  // Track NER positions alongside nodes for proximity-based edge filtering
  const entityPositions: Array<{ start: number; end: number }> = [];
  const seenIds = new Set<string>();

  for (const ent of nerEntities) {
    const nodeType = LABEL_TO_NODE_TYPE[ent.label];
    if (nodeType === undefined) continue;

    const name = ent.text.trim();
    if (!name) continue;

    // Person-specific filtering
    if (nodeType === NodeType.Person && !isValidPersonEntity(name)) continue;

    // General entity validation — reject garbage like "person", "ts", "open"
    if (!isValidEntity(name, nodeType)) continue;

    const id = nameToId(name);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    entities.push(
      buildNode(
        id,
        nodeType,
        name,
        nodeType === NodeType.Person
          ? `Mentioned in ${entry.date} log entry`
          : extractSummary(entry.content, 200),
        salienceScore,
        sourceAgent,
        [nodeType],
      ),
    );
    entityPositions.push({ start: ent.start, end: ent.end });
  }

  // Build co-occurrence edges using PROXIMITY FILTERING + SIGNAL PHRASE MATCHING.
  // Only create edges between entities that appear near each other in the text.
  //
  // Improvements over naive proximity:
  //  - Signal phrases classify relationship type (DependsOn, AuthoredBy, etc.)
  //  - Weight scales inversely with distance (closer = higher weight)
  //  - Skip person-to-person edges (low signal)
  //  - Deduplicate within same extraction
  const relationships: Edge[] = [];
  const seenEdges = new Set<string>();
  const maxDist = Math.min(
    CO_OCCURRENCE_PROXIMITY,
    Math.floor(entry.fullText.length * CO_OCCURRENCE_RATIO),
  );

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];

      // Skip person-to-person edges (low signal)
      if (a.type === NodeType.Person && b.type === NodeType.Person) continue;

      // Proximity check: gap between the two entity spans
      const posA = entityPositions[i];
      const posB = entityPositions[j];
      const gap =
        posA.end <= posB.start
          ? posB.start - posA.end
          : posB.end <= posA.start
            ? posA.start - posB.end
            : 0; // overlapping spans → distance 0

      if (gap > maxDist) continue;

      // Canonical edge key (alphabetical) to avoid duplicates
      const [src, tgt] = a.id < b.id ? [a, b] : [b, a];
      const key = src.id + ":" + tgt.id;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);

      // Signal phrase matching — scan the text between the two entities
      // to determine a more specific relationship type
      const spanStart = Math.min(posA.start, posB.start);
      const spanEnd = Math.max(posA.end, posB.end);
      const textBetween = entry.fullText.slice(spanStart, spanEnd).toLowerCase();

      let relType: RelationshipType = RelationshipType.RelatesTo;
      let relDescription = `Co-mentioned in ${entry.date}: ${entry.heading || entry.content.slice(0, 60)}`;

      for (const pattern of RELATIONSHIP_PATTERNS) {
        // Skip generic RelatesTo — we're trying to upgrade from that
        if (pattern.relationship === RelationshipType.RelatesTo) continue;

        // Check type constraints if specified
        if (pattern.targetType && tgt.type !== pattern.targetType) continue;
        if (pattern.sourceType && src.type !== pattern.sourceType) continue;

        for (const phrase of pattern.signalPhrases) {
          if (textBetween.includes(phrase)) {
            relType = pattern.relationship;
            relDescription = `"${phrase}" — ${entry.heading || entry.content.slice(0, 60)}`;
            break;
          }
        }
        if (relType !== RelationshipType.RelatesTo) break;
      }

      // Weight scales inversely with distance: closer = stronger signal
      const weight = maxDist > 0
        ? Math.max(0.3, 1.0 - (gap / maxDist) * 0.7)
        : 1.0;

      const now = new Date().toISOString();
      relationships.push({
        sourceId: src.id,
        targetId: tgt.id,
        relationship: relType,
        weight,
        description: relDescription,
        sourceAgent,
        createdAt: now,
        lastReinforced: now,
      });
    }
  }

  return {
    sourceEntry: entry,
    entities,
    relationships,
    salience: salienceScore,
  };
}

/** Fallback extraction using regex person detection + keyword matching. */
function extractWithRegex(
  entry: LogEntry,
  salienceScore: number,
  sourceAgent: string,
): ExtractionResult {
  const text = entry.fullText.toLowerCase();
  const entities: Node[] = [];
  const seenNames = new Set<string>();

  // Extract people (capitalised two-word names)
  const namePattern = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(entry.fullText)) !== null) {
    const name = match[1];
    if (!seenNames.has(name) && isLikelyPerson(name)) {
      seenNames.add(name);
      entities.push(
        buildNode(
          nameToId(name),
          NodeType.Person,
          name,
          `Mentioned in ${entry.date} log entry`,
          salienceScore,
          sourceAgent,
          ["person"],
        ),
      );
    }
  }

  // Extract entities by keyword matching
  for (const pattern of ENTITY_PATTERNS) {
    if (pattern.nodeType === ("person" as string)) continue; // Already handled above

    for (const keyword of pattern.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        if (entry.heading && !seenNames.has(entry.heading)) {
          seenNames.add(entry.heading);
          entities.push(
            buildNode(
              nameToId(entry.heading),
              pattern.nodeType,
              entry.heading,
              extractSummary(entry.content, 200),
              salienceScore,
              sourceAgent,
              [pattern.nodeType],
            ),
          );
        }
        break; // One match per pattern type per entry is enough
      }
    }
  }

  return {
    sourceEntry: entry,
    entities,
    relationships: [],
    salience: salienceScore,
  };
}

// ---------------------------------------------------------------------------
// Code index
// ---------------------------------------------------------------------------

/** Common words that happen to be code entity names — skip these. */
const GENERIC_NAMES = new Set([
  "service",
  "execute",
  "created",
  "domain",
  "output",
  "module",
  "resource",
  "config",
  "default",
  "common",
  "location",
  "result",
  "client",
  "context",
  "options",
  "request",
  "response",
  "handler",
  "provider",
  "factory",
  "builder",
  "helper",
  "manager",
  "worker",
  "monitor",
  "status",
  "source",
  "target",
  "deploy",
  "update",
  "delete",
  "create",
]);

/**
 * Build a name→nodeId index for code nodes.
 *
 * Only includes names long enough and specific enough to avoid false matches
 * against common English words in session text.
 */
export function buildCodeIndex(
  graph: KnowledgeGraph,
  minNameLength = 12,
): Record<string, string> {
  try {
    const rows = graph.db
      .prepare(
        `SELECT id, name FROM nodes
         WHERE category = 'code'
           AND type IN ('Class', 'Interface', 'Struct', 'Enum',
                        'Method', 'Function', 'Resource', 'Module')`,
      )
      .all() as Array<{ id: string; name: string }>;

    const index: Record<string, string> = {};
    for (const row of rows) {
      if (row.name.length < minNameLength) continue;
      if (GENERIC_NAMES.has(row.name.toLowerCase())) continue;
      index[row.name] = row.id;
    }
    return index;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract entities from a log entry using NER.
 *
 * With ONNX/GLiNER removed, this returns empty results.
 * Use the myelin_consolidate extension tool for LLM-based extraction.
 *
 * @deprecated Use myelin_consolidate tool in an agent session instead.
 */
export async function extractFromEntry(
  entry: LogEntry,
  sourceAgent = "donna",
): Promise<ExtractionResult> {
  const salience = scoreEntry(entry);

  return {
    sourceEntry: entry,
    entities: [],
    relationships: [],
    salience: salience.combined,
  };
}

/**
 * Parse LLM extraction output (JSON) into nodes and edges.
 *
 * The LLM returns JSON matching the schema from
 * vocabulary.getLlmExtractionPrompt(). This function validates and converts
 * it to graph objects.
 */
export function parseLlmExtraction(
  jsonText: string,
  sourceAgent = "donna",
  defaultSalience = 0.5,
): ExtractionResult {
  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    // Try to extract JSON from markdown code block
    const jsonMatch = /```(?:json)?\s*(\{.*?\})\s*```/s.exec(jsonText);
    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
      } catch {
        return {
          sourceEntry: makeEntry("", "llm-parse-error", jsonText, "observation"),
          entities: [],
          relationships: [],
          salience: 0,
        };
      }
    } else {
      return {
        sourceEntry: makeEntry("", "llm-parse-error", jsonText, "observation"),
        entities: [],
        relationships: [],
        salience: 0,
      };
    }
  }

  const nodeTypeValues = new Set<string>(Object.values(NodeType));
  const relTypeValues = new Set<string>(Object.values(RelationshipType));

  const entities: Node[] = [];
  for (const e of (data.entities ?? []) as any[]) {
    const rawType: string = (e.type as string) ?? "concept";
    const nodeType = nodeTypeValues.has(rawType)
      ? (rawType as NodeType)
      : NodeType.Concept;

    // Normalize ID: always run through nameToId for consistent kebab-case
    const rawId = (e.id as string) ?? "";
    const normalizedId = rawId ? nameToId(rawId) : nameToId((e.name as string) ?? "unknown");

    if (!normalizedId) continue; // skip empty IDs

    entities.push(
      buildNode(
        normalizedId,
        nodeType,
        (e.name as string) ?? "Unknown",
        (e.description as string) ?? "",
        Number(e.salience ?? defaultSalience),
        sourceAgent,
        (e.tags as string[]) ?? [],
      ),
    );
  }

  const relationships: Edge[] = [];
  for (const r of (data.relationships ?? []) as any[]) {
    const rawRel: string = (r.relationship as string) ?? "relates_to";
    const relType = relTypeValues.has(rawRel)
      ? (rawRel as RelationshipType)
      : RelationshipType.RelatesTo;

    // Normalize source/target IDs to match entity ID normalization
    const sourceId = nameToId((r.source as string) ?? "");
    const targetId = nameToId((r.target as string) ?? "");
    if (!sourceId || !targetId) continue; // skip edges with empty endpoints

    relationships.push(
      buildEdge(
        sourceId,
        targetId,
        relType,
        (r.description as string) ?? "",
        sourceAgent,
      ),
    );
  }

  const maxSalience =
    entities.length > 0 ? Math.max(...entities.map((e) => e.salience)) : 0;

  return {
    sourceEntry: makeEntry("", "llm-extraction", "", "observation"),
    entities,
    relationships,
    salience: maxSalience,
  };
}

/**
 * Load extraction results into the knowledge graph.
 *
 * If merge=true, existing nodes with the same ID get reinforced rather than
 * duplicated. Returns counts of operations performed.
 */
export function loadExtractionToGraph(
  graph: KnowledgeGraph,
  result: ExtractionResult,
  merge = true,
  namespace?: string,
): ExtractionStats {
  const stats: ExtractionStats = {
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    edgesSkipped: 0,
  };

  for (const node of result.entities) {
    const existing = graph.getNode(node.id);
    if (existing && merge) {
      // Reinforce existing node
      graph.reinforceNode(node.id, 0.1);
      // Update description if new one is longer/better
      if (node.description.length > existing.description.length) {
        graph.updateNode(node.id, { description: node.description });
      }
      stats.nodesReinforced++;
    } else if (!existing) {
      // Set namespace on new nodes if provided
      if (namespace) {
        node.namespace = namespace;
        node.category = 'knowledge';
      }
      graph.addNode(node);
      stats.nodesAdded++;
    }
  }

  for (const edge of result.relationships) {
    // Verify both nodes exist
    if (!graph.getNode(edge.sourceId) || !graph.getNode(edge.targetId)) {
      stats.edgesSkipped++;
      continue;
    }
    try {
      graph.addEdge(edge);
      stats.edgesAdded++;
    } catch {
      // Edge might already exist — reinforce it
      graph.reinforceEdge(edge.sourceId, edge.targetId, edge.relationship);
      stats.edgesAdded++;
    }
  }

  // Cross-domain edges: link knowledge nodes to referenced code nodes
  const crossEdges = resolveCodeReferences(graph, result);
  stats.edgesAdded += crossEdges;

  return stats;
}

/**
 * Create cross-domain edges from knowledge nodes to code nodes.
 *
 * Scans the entry text for code entity names (classes, methods, resources,
 * modules) and creates directional edges:
 *     knowledge_node  --relates_to-->  code_node
 *
 * Direction is enforced: knowledge → code only. Code nodes are source of
 * truth; knowledge nodes provide additional context.
 *
 * @param graph      The knowledge graph
 * @param result     Extraction result with entities and source entry
 * @param codeIndex  Pre-built name→id map (for testing/batching)
 * @returns          Number of cross-domain edges created
 */
export function resolveCodeReferences(
  graph: KnowledgeGraph,
  result: ExtractionResult,
  codeIndex?: Record<string, string>,
): number {
  if (result.entities.length === 0) return 0;

  const index = codeIndex ?? buildCodeIndex(graph);
  if (Object.keys(index).length === 0) return 0;

  const text = result.sourceEntry.fullText;
  let edgesCreated = 0;

  // Find all positions where each code name appears in the text
  const codePositions = new Map<string, number[]>();
  for (const [codeName, codeId] of Object.entries(index)) {
    const positions: number[] = [];
    let idx = text.indexOf(codeName);
    while (idx !== -1) {
      positions.push(idx);
      idx = text.indexOf(codeName, idx + 1);
    }
    if (positions.length > 0) {
      codePositions.set(codeId, positions);
    }
  }

  if (codePositions.size === 0) return 0;

  for (const entity of result.entities) {
    if (!graph.getNode(entity.id)) continue;

    // Find where this entity's name appears in the text
    const entityPositions: number[] = [];
    let eIdx = text.indexOf(entity.name);
    while (eIdx !== -1) {
      entityPositions.push(eIdx);
      eIdx = text.indexOf(entity.name, eIdx + 1);
    }
    if (entityPositions.length === 0) continue;

    // Only link to code nodes that appear near this entity
    for (const [codeId, codePositionList] of codePositions) {
      let nearby = false;
      for (const ep of entityPositions) {
        for (const cp of codePositionList) {
          if (Math.abs(ep - cp) <= CO_OCCURRENCE_PROXIMITY) {
            nearby = true;
            break;
          }
        }
        if (nearby) break;
      }
      if (!nearby) continue;

      try {
        graph.addEdge(
          buildEdge(
            entity.id,
            codeId,
            RelationshipType.RelatesTo,
            "Referenced in session log",
            "cross-domain",
          ),
        );
        edgesCreated++;
      } catch {
        try {
          graph.reinforceEdge(
            entity.id,
            codeId,
            RelationshipType.RelatesTo,
          );
        } catch {
          // Reinforcement also failed — skip
        }
      }
    }
  }

  return edgesCreated;
}
