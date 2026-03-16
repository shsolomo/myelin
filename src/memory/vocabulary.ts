/**
 * Entity and relationship type vocabulary for the knowledge graph.
 *
 * Defines what types of entities we extract from logs and how they relate.
 * This is the shared vocabulary that both LLM-based and rule-based extractors use.
 */

import { NodeType, RelationshipType } from "./graph.js";
export { NodeType, RelationshipType };

// --- Interfaces ---

export interface EntityPattern {
  nodeType: NodeType;
  keywords: string[];
  description: string;
}

export interface RelationshipPattern {
  relationship: RelationshipType;
  signalPhrases: string[];
  sourceType?: NodeType;
  targetType?: NodeType;
}

// --- GLiNER zero-shot NER labels ---

export const NER_LABELS: string[] = [
  'person',
  'software tool',
  'architectural decision',
  'bug or error',
  'design pattern',
  'project or initiative',
  'meeting or ceremony',
  'operational rule',
];

// --- Entity patterns (keyword-based fallback) ---

export const ENTITY_PATTERNS: EntityPattern[] = [
  {
    nodeType: NodeType.Person,
    keywords: ['mentioned', 'said', 'asked', 'responded', 'messaged', 'posted', 'reviewed'],
    description: 'People referenced in log entries',
  },
  {
    nodeType: NodeType.Decision,
    keywords: ['decided', 'agreed', 'chose', 'approved', 'settled on', 'going with', "won't"],
    description: 'Decisions made during sessions',
  },
  {
    nodeType: NodeType.Bug,
    keywords: ['bug', 'broken', 'fix', 'error', 'crash', 'regression', 'root cause', 'workaround'],
    description: 'Bugs found, fixed, or worked around',
  },
  {
    nodeType: NodeType.Pattern,
    keywords: ['pattern', 'convention', 'best practice', 'anti-pattern', 'always', 'never', 'should'],
    description: 'Code or workflow patterns discovered',
  },
  {
    nodeType: NodeType.Concept,
    keywords: ['architecture', 'system', 'framework', 'model', 'approach', 'strategy'],
    description: 'Technical concepts and architectural ideas',
  },
  {
    nodeType: NodeType.Initiative,
    keywords: ['initiative', 'project', 'feature', 'epic', 'story', 'sprint', 'milestone'],
    description: 'Work initiatives and project tracking',
  },
  {
    nodeType: NodeType.Tool,
    keywords: ['tool', 'CLI', 'MCP', 'skill', 'agent', 'plugin', 'extension', 'library'],
    description: 'Tools, skills, and infrastructure',
  },
  {
    nodeType: NodeType.Meeting,
    keywords: ['meeting', 'standup', 'sync', 'review', 'demo', 'retrospective', 'hub hour'],
    description: 'Meetings and recurring ceremonies',
  },
  {
    nodeType: NodeType.Rule,
    keywords: ['rule', 'constraint', 'must not', 'always use', 'never use', 'workaround'],
    description: 'Operational rules and constraints',
  },
  {
    nodeType: NodeType.Convention,
    keywords: ['naming', 'format', 'style', 'convention', 'standard', 'template'],
    description: 'Naming conventions, formatting standards',
  },
];

// --- Relationship patterns ---

export const RELATIONSHIP_PATTERNS: RelationshipPattern[] = [
  {
    relationship: RelationshipType.DependsOn,
    signalPhrases: ['depends on', 'requires', 'needs', 'blocked by', 'waiting for'],
  },
  {
    relationship: RelationshipType.RelatesTo,
    signalPhrases: ['related to', 'connects to', 'similar to', 'see also', 'cf.'],
  },
  {
    relationship: RelationshipType.Supersedes,
    signalPhrases: ['replaces', 'supersedes', 'obsoletes', 'instead of', 'no longer'],
  },
  {
    relationship: RelationshipType.LearnedFrom,
    signalPhrases: ['learned from', 'discovered in', 'found during', 'came from'],
  },
  {
    relationship: RelationshipType.BelongsTo,
    signalPhrases: ['part of', 'belongs to', 'under', 'within', 'inside'],
  },
  {
    relationship: RelationshipType.AuthoredBy,
    signalPhrases: ['created by', 'authored by', 'built by', 'designed by', 'wrote'],
    targetType: NodeType.Person,
  },
  {
    relationship: RelationshipType.MentionedIn,
    signalPhrases: ['mentioned in', 'discussed at', 'came up in', 'raised during'],
    targetType: NodeType.Meeting,
  },
  {
    relationship: RelationshipType.EvolvedInto,
    signalPhrases: ['evolved into', 'became', 'grew into', 'led to', 'resulted in'],
  },
  {
    relationship: RelationshipType.ConflictsWith,
    signalPhrases: ['conflicts with', 'contradicts', 'incompatible with', 'clashes with'],
  },
];

// --- All values (for prompt generation) ---

const ALL_NODE_TYPES = Object.values(NodeType);
const ALL_RELATIONSHIP_TYPES = Object.values(RelationshipType);

// --- Public API ---

/**
 * Generate a prompt for LLM-based entity/relationship extraction.
 *
 * This is the prompt sent to the sleep tool's LLM layer.
 * The LLM handles judgment — what matters, what connects, what's novel.
 */
export function getLlmExtractionPrompt(
  text: string,
  existingEntities?: string[],
): string {
  const entityTypes = ALL_NODE_TYPES.join(', ');
  const relTypes = ALL_RELATIONSHIP_TYPES.join(', ');

  let existingContext = '';
  if (existingEntities && existingEntities.length > 0) {
    const list = existingEntities.map((e) => `- ${e}`).join('\n');
    existingContext = `\n\nExisting entities in the graph (link to these when relevant):\n${list}`;
  }

  return `Extract entities and relationships from this log text.

ENTITY TYPES: ${entityTypes}
RELATIONSHIP TYPES: ${relTypes}
${existingContext}

TEXT:
${text}

Return JSON with this structure:
{
  "entities": [
    {"id": "short-kebab-id", "type": "concept|person|...", "name": "Display Name", "description": "One-line description", "salience": 0.0-1.0, "tags": ["domain1"]}
  ],
  "relationships": [
    {"source": "entity-id", "target": "entity-id", "relationship": "relates_to|depends_on|...", "description": "Why this relationship exists"}
  ]
}

RULES:
1. PERSON type is ONLY for real human names (first + last name like "Jeff West", "Ian Philpot"). Never classify project names, concepts, agent names, events, meetings, or abstract nouns as person.
2. Use SPECIFIC relationship types — avoid "relates_to" when a more precise type fits:
   - depends_on: X requires Y to work, X is blocked by Y
   - belongs_to: X is part of Y, X is a component of Y
   - authored_by: X was created/built/designed by person Y
   - learned_from: X was discovered/informed by experience Y
   - evolved_into: X became Y, X was replaced by Y
   - mentioned_in: X was discussed at meeting Y
   - supersedes: X replaces/obsoletes Y
   - blocked_by: X is blocked/prevented by Y
   - conflicts_with: X contradicts/is incompatible with Y
3. Every entity MUST have at least one relationship. If you can't connect it, it's probably not meaningful enough to extract.
4. Use consistent IDs: lowercase kebab-case, descriptive, max 40 chars. For the same concept across chunks, use the same ID (e.g. always "myelin-v090" not sometimes "v090-release").

SALIENCE GUIDE:
- 1.0: Critical decision, blocking bug, architectural change
- 0.7-0.9: Important pattern, key person interaction, initiative progress
- 0.4-0.6: Standard meeting outcome, routine update
- 0.1-0.3: Minor mention, context detail

Only extract entities that are MEANINGFUL — skip filler, transient details, and routine status updates.
`;
}
