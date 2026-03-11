/**
 * General document ingestion pipeline — local-only, no LLM API calls.
 *
 * Architecture:
 *   1. Read any text file, chunk into ~500 char windows
 *   2. Run GLiNER (local ONNX) for entity extraction per chunk
 *   3. For entity pairs in same chunk, classify relationship type using
 *      embedding similarity against prototype vectors
 *   4. Cross-document entity linking: same entity across files gets connected
 *   5. Write nodes + typed edges to graph
 *
 * This is the "Tier 3+" approach: NER + embedding-based relationship
 * extraction, fully local. Uses only models already shipped with myelin:
 *   - GLiNER (onnxruntime-node) for NER
 *   - all-MiniLM-L6-v2 (@huggingface/transformers) for embeddings
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import {
  KnowledgeGraph,
  NodeType,
  RelationshipType,
  type Node,
  type Edge,
} from './graph.js';
import { RELATIONSHIP_PATTERNS, type RelationshipPattern } from './vocabulary.js';
import { LABEL_TO_NODE_TYPE, nameToId, isLikelyPerson } from './extractors.js';
import * as ner from './ner.js';
import { getEmbedding, getEmbeddings, isAvailable as embeddingsAvailable } from './embeddings.js';

// ── Configuration ────────────────────────────────────────────────────────────

/** Target chunk size in characters. Chunks split on paragraph boundaries. */
const CHUNK_SIZE = 600;
/** Minimum entities in a chunk to consider it graph-worthy. */
const MIN_ENTITIES_PER_CHUNK = 2;
/** Maximum character gap for co-occurrence edges when embeddings unavailable. */
const MAX_PROXIMITY = 300;
/** Cosine similarity threshold: below this, use generic RelatesTo. */
const RELATIONSHIP_THRESHOLD = 0.30;

// ── Types ────────────────────────────────────────────────────────────────────

interface TextChunk {
  text: string;
  startOffset: number;
  sourceFile: string;
}

interface ExtractedEntity {
  id: string;
  name: string;
  type: NodeType;
  start: number;
  end: number;
  chunkIndex: number;
}

export interface IngestResult {
  filesProcessed: number;
  chunksProcessed: number;
  chunksWithEntities: number;
  entitiesExtracted: number;
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  relationshipTypes: Record<string, number>;
}

// ── Prototype embeddings for relationship classification ─────────────────────

interface RelPrototype {
  relationship: RelationshipType;
  embedding: number[] | null;
  phrase: string;
}

let _prototypes: RelPrototype[] | null = null;

/**
 * Build prototype embeddings for each relationship type.
 * Uses descriptive exemplar sentences (not bare signal phrases)
 * so the embedding model has enough semantic context.
 */
async function getPrototypes(): Promise<RelPrototype[]> {
  if (_prototypes !== null) return _prototypes;

  // Descriptive exemplar sentences for each relationship type.
  // These capture how the relationship appears in natural text.
  const exemplars: Array<{ relationship: RelationshipType; sentences: string[] }> = [
    {
      relationship: RelationshipType.DependsOn,
      sentences: [
        'this feature depends on the authentication service being available',
        'the deployment requires the database migration to complete first',
        'blocked by the upstream API not being ready yet',
        'this component needs the config module to function correctly',
        'waiting for the infrastructure team to provision the resources',
      ],
    },
    {
      relationship: RelationshipType.Supersedes,
      sentences: [
        'the new implementation replaces the old authentication module',
        'this approach supersedes the previous design we discussed',
        'we are no longer using the legacy service, switched to the new one',
        'the updated policy obsoletes the original security guidelines',
      ],
    },
    {
      relationship: RelationshipType.LearnedFrom,
      sentences: [
        'we discovered this pattern during the incident review meeting',
        'learned from debugging the production outage last week',
        'this insight came from analyzing the performance metrics',
        'found during the code review of the authentication module',
      ],
    },
    {
      relationship: RelationshipType.BelongsTo,
      sentences: [
        'this task is part of the larger migration initiative',
        'the component belongs to the infrastructure layer',
        'this work falls under the security improvement project',
        'included within the sprint deliverables for this milestone',
      ],
    },
    {
      relationship: RelationshipType.AuthoredBy,
      sentences: [
        'Kevin created the initial design document for this feature',
        'the script was built by Shane to automate the deployment',
        'Ian designed the architecture for the new authentication system',
        'Josh wrote the provisioning workflow automation',
      ],
    },
    {
      relationship: RelationshipType.MentionedIn,
      sentences: [
        'this topic was discussed at the weekly sync meeting',
        'the issue came up during the standup this morning',
        'raised during the architecture review session last Friday',
        'mentioned in the sprint planning discussion',
      ],
    },
    {
      relationship: RelationshipType.EvolvedInto,
      sentences: [
        'the prototype evolved into a production-ready service',
        'the initial concept led to the current architecture design',
        'this experiment resulted in the new feature implementation',
        'grew from a simple script into a full automation pipeline',
      ],
    },
    {
      relationship: RelationshipType.ConflictsWith,
      sentences: [
        'this approach conflicts with the existing security policy',
        'the new requirement contradicts the original design decision',
        'these two configurations are incompatible with each other',
        'the proposed change clashes with the current deployment strategy',
      ],
    },
    {
      relationship: RelationshipType.BlockedBy,
      sentences: [
        'progress is blocked by the pending approval from leadership',
        'cannot proceed until the dependency is resolved',
        'stuck waiting for the external team to deliver their component',
        'the release is held up by the failing integration tests',
      ],
    },
  ];

  const protos: RelPrototype[] = [];

  for (const group of exemplars) {
    for (const sentence of group.sentences) {
      const embedding = await getEmbedding(sentence);
      if (embedding.length > 0) {
        protos.push({
          relationship: group.relationship,
          embedding,
          phrase: sentence.slice(0, 60),
        });
      }
    }
  }

  _prototypes = protos;
  return protos;
}

/** Cosine similarity between two L2-normalized vectors. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // vectors are already L2-normalized
}

/**
 * Classify the relationship between two entities based on the
 * context text between them. Returns the best matching relationship
 * type and a confidence score.
 */
async function classifyRelationship(
  contextText: string,
  prototypes: RelPrototype[],
): Promise<{ relationship: RelationshipType; confidence: number }> {
  const contextEmbedding = await getEmbedding(contextText);
  if (contextEmbedding.length === 0) {
    return { relationship: RelationshipType.RelatesTo, confidence: 0 };
  }

  let bestRel = RelationshipType.RelatesTo;
  let bestSim = RELATIONSHIP_THRESHOLD;

  for (const proto of prototypes) {
    if (!proto.embedding) continue;
    const sim = cosineSim(contextEmbedding, proto.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestRel = proto.relationship;
    }
  }

  return { relationship: bestRel, confidence: bestSim };
}

// ── Text chunking ────────────────────────────────────────────────────────────

/** Split text into chunks at paragraph boundaries, targeting CHUNK_SIZE chars. */
function chunkText(text: string, sourceFile: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const paragraphs = text.split(/\n\s*\n/);

  let current = '';
  let currentStart = 0;
  let offset = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      offset += para.length + 2; // account for \n\n
      continue;
    }

    if (current.length + trimmed.length > CHUNK_SIZE && current.length > 0) {
      chunks.push({ text: current.trim(), startOffset: currentStart, sourceFile });
      current = trimmed;
      currentStart = offset;
    } else {
      if (current.length === 0) currentStart = offset;
      current += (current ? '\n\n' : '') + trimmed;
    }

    offset += para.length + 2;
  }

  if (current.trim()) {
    chunks.push({ text: current.trim(), startOffset: currentStart, sourceFile });
  }

  return chunks;
}

// ── Entity filtering ─────────────────────────────────────────────────────────

const GARBAGE_ENTITIES = new Set([
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

function isValidEntity(name: string, nodeType: NodeType): boolean {
  const lower = name.toLowerCase().trim();
  if (lower.length <= 2) return false;
  if (GARBAGE_ENTITIES.has(lower)) return false;
  if (/^[a-z]{1,4}$/.test(lower) && ['ts', 'js', 'py', 'go', 'md', 'cs', 'sh'].includes(lower)) return false;
  if (/[\/+&@#$%^*(){}[\]<>|\\]/.test(name)) return false;
  if (nodeType === NodeType.Person && !isLikelyPerson(name)) return false;
  return true;
}

// ── Safe graph operations ────────────────────────────────────────────────────

function safeAddNode(
  graph: KnowledgeGraph,
  node: Partial<Node> & { name: string; id: string },
  result: IngestResult,
): void {
  const existing = graph.getNode(node.id);
  if (existing) {
    graph.reinforceNode(node.id, 0.1);
    result.nodesReinforced++;
  } else {
    try {
      graph.addNode(node);
      result.nodesAdded++;
    } catch {
      graph.reinforceNode(node.id, 0.1);
      result.nodesReinforced++;
    }
  }
}

function safeAddEdge(
  graph: KnowledgeGraph,
  sourceId: string,
  targetId: string,
  relationship: RelationshipType,
  weight: number,
  description: string,
  sourceAgent: string,
  result: IngestResult,
): void {
  try {
    graph.addEdge({
      sourceId, targetId, relationship, weight, description, sourceAgent,
    });
    result.edgesAdded++;
    result.relationshipTypes[relationship] = (result.relationshipTypes[relationship] || 0) + 1;
  } catch {
    graph.reinforceEdge(sourceId, targetId, relationship);
    result.edgesAdded++;
    result.relationshipTypes[relationship] = (result.relationshipTypes[relationship] || 0) + 1;
  }
}

// ── File discovery ───────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.markdown', '.rst', '.org', '.adoc',
  '.log', '.jsonl', '.csv',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.vs', 'obj', 'bin', 'vendor', '.terraform', 'processed',
]);

/** Recursively find text files in a directory. */
function findTextFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.') && entry !== '.md') continue;
      const full = join(d, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full);
      } else if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) {
        if (stat.size > 0 && stat.size < 500_000) { // Skip empty and huge files
          files.push(full);
        }
      }
    }
  }

  walk(dir);
  return files;
}

// ── Main ingest pipeline ─────────────────────────────────────────────────────

/**
 * Ingest text files from a directory into the knowledge graph.
 *
 * Pipeline per chunk:
 *   1. GLiNER NER → entities
 *   2. Filter garbage entities
 *   3. If < MIN_ENTITIES_PER_CHUNK, skip (not graph-worthy)
 *   4. For each entity pair, extract context between them
 *   5. Classify relationship via embedding similarity
 *   6. Create nodes + typed, weighted edges
 *
 * After all files: cross-document entity linking.
 */
export async function ingestDirectory(
  graph: KnowledgeGraph,
  dirPath: string,
  options: {
    namespace?: string;
    sourceAgent?: string;
    fast?: boolean; // Skip embedding-based RE, use proximity only
  } = {},
): Promise<IngestResult> {
  const namespace = options.namespace ?? basename(dirPath);
  const sourceAgent = options.sourceAgent ?? 'ingest';
  const fast = options.fast ?? false;

  const result: IngestResult = {
    filesProcessed: 0,
    chunksProcessed: 0,
    chunksWithEntities: 0,
    entitiesExtracted: 0,
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    relationshipTypes: {},
  };

  graph.extendForCode();

  // Check NER availability by attempting a test extraction
  const nerTest = await ner.extractEntities('test');
  const nerAvailable = ner.isAvailable();
  if (!nerAvailable) {
    console.error('GLiNER NER model not available — cannot extract entities.');
    return result;
  }

  // Load relationship prototypes (embedding-based classification)
  let prototypes: RelPrototype[] = [];
  if (!fast) {
    const embAvailable = await embeddingsAvailable();
    if (embAvailable) {
      prototypes = await getPrototypes();
      console.log(`  Loaded ${prototypes.length} relationship prototypes`);
    } else {
      console.log('  Embeddings unavailable — falling back to proximity-based edges');
    }
  }

  // Discover files
  const files = existsSync(dirPath) && statSync(dirPath).isDirectory()
    ? findTextFiles(dirPath)
    : [dirPath]; // Single file mode

  console.log(`  Found ${files.length} text file(s)`);

  // Track all entities across files for cross-document linking
  const globalEntities = new Map<string, { nodeId: string; files: Set<string> }>();

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const relPath = relative(dirPath, filePath);
    result.filesProcessed++;

    const chunks = chunkText(content, relPath);

    for (const chunk of chunks) {
      result.chunksProcessed++;

      // Step 1: NER extraction
      const nerEntities = await ner.extractEntities(chunk.text);

      // Step 2: Filter and deduplicate
      const entities: ExtractedEntity[] = [];
      const seenIds = new Set<string>();

      for (const ent of nerEntities) {
        const nodeType = LABEL_TO_NODE_TYPE[ent.label];
        if (nodeType === undefined) continue;

        const name = ent.text.trim();
        if (!name || !isValidEntity(name, nodeType)) continue;

        const id = nameToId(name);
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        entities.push({
          id,
          name,
          type: nodeType,
          start: ent.start,
          end: ent.end,
          chunkIndex: result.chunksProcessed,
        });
      }

      // Step 3: Skip low-signal chunks
      if (entities.length < MIN_ENTITIES_PER_CHUNK) continue;

      result.chunksWithEntities++;
      result.entitiesExtracted += entities.length;

      // Step 4: Create nodes
      for (const entity of entities) {
        safeAddNode(graph, {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          description: chunk.text.slice(0, 200),
          salience: 0.6,
          confidence: 1.0,
          sourceAgent,
          tags: ['ingest', entity.type],
          category: 'knowledge',
          namespace,
        }, result);

        // Track for cross-document linking
        const existing = globalEntities.get(entity.id);
        if (existing) {
          existing.files.add(relPath);
        } else {
          globalEntities.set(entity.id, { nodeId: entity.id, files: new Set([relPath]) });
        }
      }

      // Step 5: Create edges between entity pairs
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const a = entities[i];
          const b = entities[j];

          // Skip person-to-person (low signal)
          if (a.type === NodeType.Person && b.type === NodeType.Person) continue;

          // Extract context between the two entities
          const spanStart = Math.min(a.start, b.start);
          const spanEnd = Math.max(a.end, b.end);
          const gap = Math.max(0,
            a.end <= b.start ? b.start - a.end :
            b.end <= a.start ? a.start - b.end : 0,
          );

          if (gap > MAX_PROXIMITY) continue;

          const contextText = chunk.text.slice(spanStart, spanEnd);

          // Classify relationship
          let relType = RelationshipType.RelatesTo;
          let confidence = 0.5;

          if (!fast && prototypes.length > 0) {
            const classification = await classifyRelationship(contextText, prototypes);
            relType = classification.relationship;
            confidence = classification.confidence;
          }

          // Weight: combination of proximity and classification confidence
          const proximityWeight = MAX_PROXIMITY > 0
            ? Math.max(0.3, 1.0 - (gap / MAX_PROXIMITY) * 0.7)
            : 1.0;
          const weight = fast ? proximityWeight : Math.max(0.3, (proximityWeight + confidence) / 2);

          // Canonical ordering
          const [src, tgt] = a.id < b.id ? [a, b] : [b, a];

          safeAddEdge(
            graph, src.id, tgt.id, relType, weight,
            `${contextText.slice(0, 100)}`,
            sourceAgent, result,
          );
        }
      }
    }
  }

  // Step 6: Cross-document entity linking
  // Entities appearing in 2+ files likely have a real relationship
  const multiFileEntities = [...globalEntities.entries()]
    .filter(([_, v]) => v.files.size >= 2);

  if (multiFileEntities.length >= 2) {
    console.log(`  Cross-document linking: ${multiFileEntities.length} entities appear in multiple files`);

    for (let i = 0; i < multiFileEntities.length; i++) {
      for (let j = i + 1; j < multiFileEntities.length; j++) {
        const [idA, infoA] = multiFileEntities[i];
        const [idB, infoB] = multiFileEntities[j];

        // Find shared files
        const shared = [...infoA.files].filter((f) => infoB.files.has(f));
        if (shared.length === 0) continue;

        // Entities co-occurring across multiple files have a real relationship
        const weight = Math.min(1.0, 0.4 + shared.length * 0.15);

        safeAddEdge(
          graph, idA, idB, RelationshipType.RelatesTo, weight,
          `Co-occur in ${shared.length} file(s): ${shared.slice(0, 3).join(', ')}`,
          sourceAgent, result,
        );
      }
    }
  }

  return result;
}
