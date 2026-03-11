/**
 * Vault parser — indexes IDEA vault notes into the knowledge graph.
 *
 * Reads the IDEA vault structure (Initiatives, Domains, Expertise, Archive)
 * and creates properly-typed nodes and edges:
 *
 * Structural edges (from directory layout):
 *   - Person BelongsTo Domain/Initiative
 *   - Domain/Initiative nodes from folder names
 *
 * Content edges (from markdown sections):
 *   - Person AuthoredBy action items (Next Steps)
 *   - Person MentionedIn domain/initiative entries
 *   - Decision/Pattern LearnedFrom domain
 *   - Cross-references between domains via file paths
 *
 * Signal phrase edges (from text analysis):
 *   - DependsOn, Supersedes, BlockedBy etc. via vocabulary patterns
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import {
  KnowledgeGraph,
  NodeType,
  RelationshipType,
  type Node,
  type Edge,
} from './graph.js';
import { RELATIONSHIP_PATTERNS } from './vocabulary.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Title-case a kebab/snake string: "josh-lane" → "Josh Lane" */
function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Section parsing ──────────────────────────────────────────────────────────

interface VaultSection {
  date: string | null;
  heading: string;
  notes: string[];
  decisions: string[];
  nextSteps: string[];
  rawContent: string;
}

/** Parse a vault markdown file into dated sections. */
function parseSections(content: string): VaultSection[] {
  const sections: VaultSection[] = [];
  const lines = content.split('\n');

  let current: VaultSection | null = null;
  let subsection: 'notes' | 'decisions' | 'nextSteps' | 'raw' = 'raw';

  const dateRe = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?/;

  for (const line of lines) {
    // New dated section
    const dateMatch = line.match(dateRe);
    if (dateMatch) {
      if (current) sections.push(current);
      current = {
        date: dateMatch[1],
        heading: line.replace(/^##\s+/, '').trim(),
        notes: [],
        decisions: [],
        nextSteps: [],
        rawContent: '',
      };
      subsection = 'raw';
      continue;
    }

    // Non-dated H2 section (Open, Done, etc.)
    if (/^##\s+/.test(line) && !dateMatch) {
      if (current) sections.push(current);
      current = {
        date: null,
        heading: line.replace(/^##\s+/, '').trim(),
        notes: [],
        decisions: [],
        nextSteps: [],
        rawContent: '',
      };
      subsection = 'raw';
      continue;
    }

    if (!current) continue;

    // Subsection headers
    const subLower = line.toLowerCase().trim();
    if (/^###\s+notes/i.test(line)) { subsection = 'notes'; continue; }
    if (/^###\s+decisions/i.test(line)) { subsection = 'decisions'; continue; }
    if (/^###\s+next\s+steps/i.test(line)) { subsection = 'nextSteps'; continue; }
    if (/^###\s+/.test(line)) { subsection = 'raw'; }

    // Collect bullet items
    const bulletMatch = line.match(/^\s*-\s+(.+)/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (subsection === 'notes') current.notes.push(text);
      else if (subsection === 'decisions') current.decisions.push(text);
      else if (subsection === 'nextSteps') current.nextSteps.push(text);
    }

    current.rawContent += line + '\n';
  }

  if (current) sections.push(current);
  return sections;
}

// ── Person extraction from action items ──────────────────────────────────────

interface ActionItem {
  person: string;
  action: string;
  completed: boolean;
}

/** Extract "Person: Action" patterns from Next Steps bullet items. */
function extractActions(items: string[]): ActionItem[] {
  const actions: ActionItem[] = [];
  // Match "Firstname Lastname: action" or "Firstname: action"
  const personActionRe = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*?)\s*:\s+(.+)/;
  // Multi-person: "Person + Person: action"
  const multiPersonRe = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*\+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*:\s+(.+)/;

  for (const item of items) {
    const completed = /^✅|^\(✅|\[x\]/i.test(item);
    const cleanItem = item.replace(/^✅\s*|^\(✅\s*\)\s*|\[x\]\s*/i, '');

    const multiMatch = cleanItem.match(multiPersonRe);
    if (multiMatch) {
      actions.push({ person: multiMatch[1].trim(), action: multiMatch[3].trim(), completed });
      actions.push({ person: multiMatch[2].trim(), action: multiMatch[3].trim(), completed });
      continue;
    }

    const match = cleanItem.match(personActionRe);
    if (match) {
      actions.push({ person: match[1].trim(), action: match[2].trim(), completed });
    }
  }

  return actions;
}

// ── Person name extraction from text ─────────────────────────────────────────

/** Known person names to match in text (built from vault/domains/people/). */
function extractMentionedPersons(text: string, knownPersons: Set<string>): string[] {
  const mentioned: string[] = [];
  for (const name of knownPersons) {
    // Match first name or full name
    const firstName = name.split(' ')[0];
    if (text.includes(name) || text.includes(firstName)) {
      mentioned.push(name);
    }
  }
  return mentioned;
}

// ── Signal phrase relationship detection ─────────────────────────────────────

interface DetectedRelationship {
  relationship: RelationshipType;
  phrase: string;
  context: string;
}

/** Scan text for signal phrases that indicate specific relationship types. */
function detectRelationships(text: string): DetectedRelationship[] {
  const detected: DetectedRelationship[] = [];
  const lower = text.toLowerCase();

  for (const pattern of RELATIONSHIP_PATTERNS) {
    for (const phrase of pattern.signalPhrases) {
      const idx = lower.indexOf(phrase);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + phrase.length + 60);
        detected.push({
          relationship: pattern.relationship,
          phrase,
          context: text.slice(start, end).trim(),
        });
      }
    }
  }

  return detected;
}

// ── Main vault indexer ───────────────────────────────────────────────────────

export interface VaultIndexResult {
  nodesAdded: number;
  nodesReinforced: number;
  edgesAdded: number;
  edgesSkipped: number;
  filesProcessed: number;
  peopleFound: string[];
  domainsFound: string[];
  initiativesFound: string[];
}

/** Safely add a node — reinforce if it already exists. */
function safeAddNode(
  graph: KnowledgeGraph,
  node: Partial<Node> & { name: string; id: string },
  result: VaultIndexResult,
): void {
  const existing = graph.getNode(node.id);
  if (existing) {
    graph.reinforceNode(node.id, 0.1);
    // Update description if new one is more detailed
    if (node.description && node.description.length > existing.description.length) {
      graph.updateNode(node.id, { description: node.description });
    }
    result.nodesReinforced++;
  } else {
    try {
      graph.addNode(node);
      result.nodesAdded++;
    } catch {
      // Unique constraint — reinforce instead
      graph.reinforceNode(node.id, 0.1);
      result.nodesReinforced++;
    }
  }
}

/** Safely add an edge — reinforce if it already exists. */
function safeAddEdge(
  graph: KnowledgeGraph,
  edge: Partial<Edge> & { sourceId: string; targetId: string; relationship: RelationshipType | string },
  result: VaultIndexResult,
): void {
  try {
    graph.addEdge(edge);
    result.edgesAdded++;
  } catch {
    graph.reinforceEdge(edge.sourceId, edge.targetId, edge.relationship);
    result.edgesAdded++;
  }
}

/**
 * Index an IDEA vault into the knowledge graph.
 *
 * Creates nodes for people, domains, initiatives, expertise areas,
 * and edges for all discovered relationships.
 */
export function indexVault(
  graph: KnowledgeGraph,
  vaultPath: string,
  options: { namespace?: string; sourceAgent?: string } = {},
): VaultIndexResult {
  const namespace = options.namespace ?? 'vault';
  const sourceAgent = options.sourceAgent ?? 'vault-parser';

  const result: VaultIndexResult = {
    nodesAdded: 0,
    nodesReinforced: 0,
    edgesAdded: 0,
    edgesSkipped: 0,
    filesProcessed: 0,
    peopleFound: [],
    domainsFound: [],
    initiativesFound: [],
  };

  // Ensure code-graph columns exist (for category, namespace, file_path)
  graph.extendForCode();

  // ── Phase 1: Discover structure ──────────────────────────────────────────

  const domainsDir = join(vaultPath, 'domains');
  const initiativesDir = join(vaultPath, 'initiatives');
  const expertiseDir = join(vaultPath, 'expertise');
  const peopleDir = join(vaultPath, 'domains', 'people');

  // Discover people from folder names
  const knownPersons = new Map<string, string>(); // displayName → nodeId
  if (existsSync(peopleDir)) {
    for (const entry of readdirSync(peopleDir)) {
      const full = join(peopleDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const displayName = titleCase(entry);
      // Try to match existing nodes: check plain name first, then prefixed
      const plainId = nameToId(entry);
      const existing = graph.getNode(plainId);
      const id = existing ? plainId : 'person-' + nameToId(entry);
      knownPersons.set(displayName, id);
      result.peopleFound.push(displayName);
    }
  }

  // Also build a map from first names to full person IDs
  // AND check for existing first-name-only nodes from NER
  const knownFirstNames = new Set<string>();
  const personIdByFirst = new Map<string, string>();
  for (const [name, id] of knownPersons) {
    const first = name.split(' ')[0];
    knownFirstNames.add(first);
    personIdByFirst.set(first, id);

    // If NER created a first-name node (e.g., "ian"), merge edges to our canonical ID
    const firstId = nameToId(first);
    if (firstId !== id && graph.getNode(firstId)) {
      // Create an alias edge so queries find both
      try {
        graph.addEdge({
          sourceId: firstId,
          targetId: id,
          relationship: RelationshipType.RelatesTo,
          weight: 1.0,
          description: `Alias: ${first} → ${name}`,
          sourceAgent,
        });
      } catch { /* edge already exists */ }
    }
  }

  // Discover domains
  const domainIds = new Map<string, string>(); // folderName → nodeId
  if (existsSync(domainsDir)) {
    for (const entry of readdirSync(domainsDir)) {
      if (entry === 'people') continue; // people is special
      const full = join(domainsDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const displayName = titleCase(entry);
      const id = 'domain-' + nameToId(entry);
      domainIds.set(entry, id);
      result.domainsFound.push(displayName);
    }
  }

  // Discover initiatives
  const initiativeIds = new Map<string, string>();
  if (existsSync(initiativesDir)) {
    for (const entry of readdirSync(initiativesDir)) {
      const full = join(initiativesDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const displayName = titleCase(entry);
      const id = 'initiative-' + nameToId(entry);
      initiativeIds.set(entry, id);
      result.initiativesFound.push(displayName);
    }
  }

  // ── Phase 2: Create structural nodes ─────────────────────────────────────

  // Create person nodes
  for (const [displayName, id] of knownPersons) {
    safeAddNode(graph, {
      id,
      name: displayName,
      type: NodeType.Person,
      description: `Person tracked in vault`,
      salience: 0.7,
      confidence: 1.0,
      sourceAgent,
      tags: ['vault', 'person'],
      category: 'knowledge',
      namespace,
    }, result);
  }

  // Create domain nodes
  for (const [folderName, id] of domainIds) {
    const displayName = titleCase(folderName);
    safeAddNode(graph, {
      id,
      name: displayName,
      type: NodeType.Concept,
      description: `Domain: ${displayName}`,
      salience: 0.8,
      confidence: 1.0,
      sourceAgent,
      tags: ['vault', 'domain'],
      category: 'knowledge',
      namespace,
    }, result);
  }

  // Create initiative nodes
  for (const [folderName, id] of initiativeIds) {
    const displayName = titleCase(folderName);
    safeAddNode(graph, {
      id,
      name: displayName,
      type: NodeType.Initiative,
      description: `Initiative: ${displayName}`,
      salience: 0.8,
      confidence: 1.0,
      sourceAgent,
      tags: ['vault', 'initiative'],
      category: 'knowledge',
      namespace,
    }, result);
  }

  // ── Phase 3: Process domain files ────────────────────────────────────────

  for (const [folderName, domainId] of domainIds) {
    const dir = join(domainsDir, folderName);
    processVaultDirectory(graph, dir, domainId, 'domain', knownPersons, personIdByFirst, sourceAgent, namespace, result);
  }

  // ── Phase 4: Process initiative files ────────────────────────────────────

  for (const [folderName, initId] of initiativeIds) {
    const dir = join(initiativesDir, folderName);
    processVaultDirectory(graph, dir, initId, 'initiative', knownPersons, personIdByFirst, sourceAgent, namespace, result);
  }

  // ── Phase 5: Process people files ────────────────────────────────────────

  if (existsSync(peopleDir)) {
    for (const [displayName, personId] of knownPersons) {
      const folderName = displayName.toLowerCase().replace(/\s+/g, '-');
      const personDir = join(peopleDir, folderName);
      if (!existsSync(personDir)) continue;

      // Process person notes — look for domain/initiative references
      const mdFiles = readdirSync(personDir).filter(
        (f) => f.endsWith('.md') && f !== 'next-actions.md',
      );

      for (const file of mdFiles) {
        const filePath = join(personDir, file);
        const content = readFileSync(filePath, 'utf-8');
        result.filesProcessed++;

        // Extract mentions of other persons
        for (const [otherName, otherId] of knownPersons) {
          if (otherId === personId) continue;
          const firstName = otherName.split(' ')[0];
          if (content.includes(otherName) || content.includes(firstName)) {
            safeAddEdge(graph, {
              sourceId: personId,
              targetId: otherId,
              relationship: RelationshipType.RelatesTo,
              weight: 0.6,
              description: `${displayName} mentions ${otherName} in notes`,
              sourceAgent,
            }, result);
          }
        }

        // Link person to domains/initiatives mentioned in their notes
        for (const [dFolder, dId] of domainIds) {
          const dName = titleCase(dFolder);
          if (content.toLowerCase().includes(dFolder.replace(/-/g, ' ')) ||
              content.toLowerCase().includes(dFolder)) {
            safeAddEdge(graph, {
              sourceId: personId,
              targetId: dId,
              relationship: RelationshipType.BelongsTo,
              weight: 0.7,
              description: `${displayName} involved in ${dName}`,
              sourceAgent,
            }, result);
          }
        }

        for (const [iFolder, iId] of initiativeIds) {
          const iName = titleCase(iFolder);
          if (content.toLowerCase().includes(iFolder.replace(/-/g, ' ')) ||
              content.toLowerCase().includes(iFolder)) {
            safeAddEdge(graph, {
              sourceId: personId,
              targetId: iId,
              relationship: RelationshipType.BelongsTo,
              weight: 0.7,
              description: `${displayName} involved in ${iName}`,
              sourceAgent,
            }, result);
          }
        }
      }

      // Process next-actions.md
      const nextActionsPath = join(personDir, 'next-actions.md');
      if (existsSync(nextActionsPath)) {
        processNextActions(graph, nextActionsPath, personId, displayName, sourceAgent, result);
        result.filesProcessed++;
      }
    }
  }

  // ── Phase 6: Process expertise files ─────────────────────────────────────

  if (existsSync(expertiseDir)) {
    for (const entry of readdirSync(expertiseDir)) {
      const full = join(expertiseDir, entry);
      if (statSync(full).isDirectory()) {
        const id = 'expertise-' + nameToId(entry);
        const displayName = titleCase(entry);
        safeAddNode(graph, {
          id,
          name: displayName,
          type: NodeType.Concept,
          description: `Expertise area: ${displayName}`,
          salience: 0.6,
          confidence: 1.0,
          sourceAgent,
          tags: ['vault', 'expertise'],
          category: 'knowledge',
          namespace,
        }, result);

        // Process files in expertise folder
        const mdFiles = readdirSync(full).filter((f) => f.endsWith('.md'));
        for (const file of mdFiles) {
          const content = readFileSync(join(full, file), 'utf-8');
          result.filesProcessed++;

          // Link expertise to mentioned people
          for (const [pName, pId] of knownPersons) {
            const firstName = pName.split(' ')[0];
            if (content.includes(pName) || content.includes(firstName)) {
              safeAddEdge(graph, {
                sourceId: pId,
                targetId: id,
                relationship: RelationshipType.LearnedFrom,
                weight: 0.5,
                description: `${pName} has expertise in ${displayName}`,
                sourceAgent,
              }, result);
            }
          }
        }
      } else if (entry.endsWith('.md')) {
        // Standalone expertise file
        result.filesProcessed++;
      }
    }
  }

  return result;
}

// ── Directory processor ──────────────────────────────────────────────────────

function processVaultDirectory(
  graph: KnowledgeGraph,
  dir: string,
  parentId: string,
  parentType: 'domain' | 'initiative',
  knownPersons: Map<string, string>,
  personIdByFirst: Map<string, string>,
  sourceAgent: string,
  namespace: string,
  result: VaultIndexResult,
): void {
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.md') && f !== '.gitkeep',
  );

  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    result.filesProcessed++;

    if (file === 'next-actions.md') {
      // Process next-actions — link actions to parent domain/initiative
      processNextActionsForParent(
        graph, filePath, parentId, parentType, personIdByFirst, sourceAgent, result,
      );
      continue;
    }

    const sections = parseSections(content);

    for (const section of sections) {
      // Extract person mentions from notes
      for (const note of section.notes) {
        for (const [firstName, personId] of personIdByFirst) {
          if (note.includes(firstName)) {
            safeAddEdge(graph, {
              sourceId: personId,
              targetId: parentId,
              relationship: RelationshipType.MentionedIn,
              weight: 0.6,
              description: `${firstName} mentioned in ${titleCase(basename(dir))} notes${section.date ? ` (${section.date})` : ''}`,
              sourceAgent,
            }, result);
          }
        }
      }

      // Extract decisions
      for (const decision of section.decisions) {
        if (decision.length < 10) continue;
        const decId = nameToId(decision.slice(0, 60));
        safeAddNode(graph, {
          id: decId,
          name: decision.length > 80 ? decision.slice(0, 77) + '...' : decision,
          type: NodeType.Decision,
          description: decision,
          salience: 0.7,
          confidence: 1.0,
          sourceAgent,
          tags: ['vault', parentType],
          category: 'knowledge',
          namespace,
        }, result);

        // Decision belongs to parent domain/initiative
        safeAddEdge(graph, {
          sourceId: decId,
          targetId: parentId,
          relationship: RelationshipType.BelongsTo,
          weight: 0.8,
          description: `Decision made in ${titleCase(basename(dir))}`,
          sourceAgent,
        }, result);

        // Link decision to mentioned people
        for (const [firstName, personId] of personIdByFirst) {
          if (decision.includes(firstName)) {
            safeAddEdge(graph, {
              sourceId: decId,
              targetId: personId,
              relationship: RelationshipType.AuthoredBy,
              weight: 0.6,
              description: `${firstName} involved in decision`,
              sourceAgent,
            }, result);
          }
        }
      }

      // Extract actions from Next Steps
      const actions = extractActions(section.nextSteps);
      for (const action of actions) {
        // Find person node
        const personId = personIdByFirst.get(action.person);
        if (!personId) continue;

        // Link person to parent via action ownership
        safeAddEdge(graph, {
          sourceId: personId,
          targetId: parentId,
          relationship: RelationshipType.BelongsTo,
          weight: 0.7,
          description: `${action.person} has action: ${action.action.slice(0, 60)}`,
          sourceAgent,
        }, result);
      }

      // Signal phrase detection in raw content
      const detected = detectRelationships(section.rawContent);
      for (const det of detected) {
        // These augment existing edges — if we find "depends on" between
        // two entities we already connected, upgrade the relationship type
        // For now, log as tags on the parent node for later processing
        if (det.relationship !== RelationshipType.RelatesTo) {
          graph.addTag(parentId, `signal:${det.relationship}`);
        }
      }
    }
  }
}

// ── Next-actions processor ───────────────────────────────────────────────────

function processNextActions(
  graph: KnowledgeGraph,
  filePath: string,
  ownerId: string,
  ownerName: string,
  sourceAgent: string,
  result: VaultIndexResult,
): void {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let section = 'unknown';

  for (const line of lines) {
    if (/^##\s+Open/i.test(line)) { section = 'open'; continue; }
    if (/^##\s+Done/i.test(line)) { section = 'done'; continue; }

    const bullet = line.match(/^\s*-\s+(.+)/);
    if (!bullet) continue;

    // Actions in a person's next-actions.md are assigned to that person
    // No need to create separate nodes — just reinforce the person node
    if (section === 'open') {
      graph.reinforceNode(ownerId, 0.05);
    }
  }
}

function processNextActionsForParent(
  graph: KnowledgeGraph,
  filePath: string,
  parentId: string,
  parentType: string,
  personIdByFirst: Map<string, string>,
  sourceAgent: string,
  result: VaultIndexResult,
): void {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let section = 'unknown';

  const personActionRe = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*?)\s*:\s+(.+)/;

  for (const line of lines) {
    if (/^##\s+Open/i.test(line)) { section = 'open'; continue; }
    if (/^##\s+Done/i.test(line)) { section = 'done'; continue; }

    const bullet = line.match(/^\s*-\s+(.+)/);
    if (!bullet) continue;
    const text = bullet[1].trim();

    const actionMatch = text.match(personActionRe);
    if (actionMatch) {
      const personId = personIdByFirst.get(actionMatch[1]);
      if (personId) {
        safeAddEdge(graph, {
          sourceId: personId,
          targetId: parentId,
          relationship: RelationshipType.BelongsTo,
          weight: section === 'open' ? 0.7 : 0.5,
          description: `${actionMatch[1]}: ${actionMatch[2].slice(0, 60)}`,
          sourceAgent,
        }, result);
      }
    }
  }
}
