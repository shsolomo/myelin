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
import { ENTITY_PATTERNS } from "./vocabulary.js";
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

/** Primary extraction path using GLiNER zero-shot NER. */
async function extractWithNer(
  entry: LogEntry,
  salienceScore: number,
  sourceAgent: string,
): Promise<ExtractionResult> {
  const nerEntities = await ner.extractEntities(entry.fullText);

  const entities: Node[] = [];
  const seenNames = new Set<string>();
  // Track which non-person types we've already emitted (one per type per entry)
  const seenTypes = new Set<string>();

  for (const ent of nerEntities) {
    const nodeType = LABEL_TO_NODE_TYPE[ent.label];
    if (nodeType === undefined) continue;

    if (nodeType === NodeType.Person) {
      const name = ent.text.trim();
      if (name && !seenNames.has(name)) {
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
    } else {
      // Non-person: use entry heading as node name, NER match determines type
      if (seenTypes.has(nodeType)) continue;
      if (!entry.heading || seenNames.has(entry.heading)) continue;
      seenTypes.add(nodeType);
      seenNames.add(entry.heading);
      entities.push(
        buildNode(
          nameToId(entry.heading),
          nodeType,
          entry.heading,
          extractSummary(entry.content, 200),
          salienceScore,
          sourceAgent,
          [nodeType],
        ),
      );
    }
  }

  return {
    sourceEntry: entry,
    entities,
    relationships: [],
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
 * Extract entities from a log entry using GLiNER (preferred) or regex
 * fallback.
 *
 * GLiNER path:
 *   1. Run zero-shot NER on the full entry text.
 *   2. Map GLiNER labels → NodeType via LABEL_TO_NODE_TYPE.
 *   3. For person entities, use the entity text as the node name.
 *   4. For non-person entities, use the entry heading as the node name
 *      (GLiNER match determines the *type*).
 *
 * Fallback path (GLiNER unavailable):
 *   Regex person detection + keyword matching.
 */
export async function extractFromEntry(
  entry: LogEntry,
  sourceAgent = "donna",
): Promise<ExtractionResult> {
  const salience = scoreEntry(entry);

  if (ner.isAvailable()) {
    return extractWithNer(entry, salience.combined, sourceAgent);
  }

  return extractWithRegex(entry, salience.combined, sourceAgent);
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

    entities.push(
      buildNode(
        (e.id as string) ?? nameToId((e.name as string) ?? "unknown"),
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

    relationships.push(
      buildEdge(
        (r.source as string) ?? "",
        (r.target as string) ?? "",
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

  for (const entity of result.entities) {
    // Only create edges FROM knowledge nodes that exist in the graph
    if (!graph.getNode(entity.id)) continue;

    // Find code node names mentioned in the entry text
    const matchedCodeIds = new Set<string>();
    for (const [codeName, codeId] of Object.entries(index)) {
      if (text.includes(codeName)) {
        matchedCodeIds.add(codeId);
      }
    }

    // Create directional edges: knowledge → code
    for (const codeId of matchedCodeIds) {
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
        // Edge already exists — reinforce it
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
