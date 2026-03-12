/**
 * Tests for extractors.ts — entity and relationship extraction.
 *
 * Covers:
 * - Pure helpers: nameToId, isLikelyPerson, extractSummary
 * - Entity validation: isValidPersonEntity, isValidEntity (via extractFromEntry)
 * - LLM extraction parsing: parseLlmExtraction
 * - Graph loading: loadExtractionToGraph (merge, reinforcement, edge creation)
 * - Code index: buildCodeIndex
 * - Extraction pipeline: extractFromEntry (NER mocked to force regex fallback)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  nameToId,
  isLikelyPerson,
  extractSummary,
  LABEL_TO_NODE_TYPE,
  parseLlmExtraction,
  loadExtractionToGraph,
  buildCodeIndex,
  extractFromEntry,
} from '../../src/memory/extractors.js';
import { KnowledgeGraph, NodeType, RelationshipType } from '../../src/memory/graph.js';
import { makeEntry } from '../../src/memory/log-parser.js';

// Mock NER module so extractFromEntry falls back to regex
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

// ---------------------------------------------------------------------------
// nameToId
// ---------------------------------------------------------------------------

describe('nameToId', () => {
  it('converts name to kebab-case', () => {
    expect(nameToId('My Cool Node')).toBe('my-cool-node');
  });

  it('strips special characters', () => {
    expect(nameToId('hello@world!')).toBe('hello-world');
  });

  it('removes leading/trailing hyphens', () => {
    expect(nameToId('--test--')).toBe('test');
  });

  it('truncates to 40 characters', () => {
    const long = 'a '.repeat(30);
    expect(nameToId(long).length).toBeLessThanOrEqual(40);
  });

  it('handles empty string', () => {
    expect(nameToId('')).toBe('');
  });

  it('handles single word', () => {
    expect(nameToId('word')).toBe('word');
  });
});

// ---------------------------------------------------------------------------
// isLikelyPerson
// ---------------------------------------------------------------------------

describe('isLikelyPerson', () => {
  it('returns true for typical person names', () => {
    expect(isLikelyPerson('John Smith')).toBe(true);
    expect(isLikelyPerson('Jane Thompson')).toBe(true);
  });

  it('returns false for known non-person names', () => {
    expect(isLikelyPerson('Red PI')).toBe(false);
    expect(isLikelyPerson('Hub Hour')).toBe(false);
    expect(isLikelyPerson('Key Vault')).toBe(false);
  });

  it('returns false for names with >3 words', () => {
    expect(isLikelyPerson('A Very Long Name Indeed')).toBe(false);
  });

  it('returns false for names containing NON_PERSON_WORDS', () => {
    expect(isLikelyPerson('System Admin')).toBe(false);
    expect(isLikelyPerson('Pipeline Build')).toBe(false);
    expect(isLikelyPerson('Azure Service')).toBe(false);
  });

  it('returns true for single-word capitalized names', () => {
    expect(isLikelyPerson('Alice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractSummary
// ---------------------------------------------------------------------------

describe('extractSummary', () => {
  it('returns first meaningful line', () => {
    const text = '- Short note\nThis is a longer meaningful line about something.\nAnother line.';
    const summary = extractSummary(text);
    expect(summary).toBe('This is a longer meaningful line about something.');
  });

  it('skips lines starting with underscore', () => {
    const text = '_Consolidated 2025-12-01._\nReal content here.';
    expect(extractSummary(text)).toBe('Real content here.');
  });

  it('strips leading dash from list items', () => {
    const text = '- This is a list item that is long enough to count.';
    expect(extractSummary(text)).toBe('This is a list item that is long enough to count.');
  });

  it('skips short lines (<= 10 chars)', () => {
    const text = 'Short\nAlso short\nThis is definitely long enough to be a summary line.';
    expect(extractSummary(text)).toBe('This is definitely long enough to be a summary line.');
  });

  it('truncates to maxLen', () => {
    const text = 'A'.repeat(300);
    expect(extractSummary(text, 50).length).toBe(50);
  });

  it('falls back to first N chars of text when no suitable line found', () => {
    const text = 'abc';
    expect(extractSummary(text)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// LABEL_TO_NODE_TYPE
// ---------------------------------------------------------------------------

describe('LABEL_TO_NODE_TYPE', () => {
  it('maps all NER labels to NodeTypes', () => {
    expect(LABEL_TO_NODE_TYPE['person']).toBe(NodeType.Person);
    expect(LABEL_TO_NODE_TYPE['software tool']).toBe(NodeType.Tool);
    expect(LABEL_TO_NODE_TYPE['architectural decision']).toBe(NodeType.Decision);
    expect(LABEL_TO_NODE_TYPE['bug or error']).toBe(NodeType.Bug);
    expect(LABEL_TO_NODE_TYPE['design pattern']).toBe(NodeType.Pattern);
    expect(LABEL_TO_NODE_TYPE['project or initiative']).toBe(NodeType.Initiative);
    expect(LABEL_TO_NODE_TYPE['meeting or ceremony']).toBe(NodeType.Meeting);
    expect(LABEL_TO_NODE_TYPE['operational rule']).toBe(NodeType.Rule);
  });
});

// ---------------------------------------------------------------------------
// parseLlmExtraction
// ---------------------------------------------------------------------------

describe('parseLlmExtraction', () => {
  it('parses valid JSON with entities and relationships', () => {
    const json = JSON.stringify({
      entities: [
        { id: 'auth-module', type: 'tool', name: 'Auth Module', description: 'JWT auth', salience: 0.8, tags: ['security'] },
        { id: 'login-bug', type: 'bug', name: 'Login Bug', description: 'Fails on refresh', salience: 0.7, tags: [] },
      ],
      relationships: [
        { source: 'login-bug', target: 'auth-module', relationship: 'relates_to', description: 'Bug is in the auth module' },
      ],
    });

    const result = parseLlmExtraction(json);
    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
    expect(result.entities[0].name).toBe('Auth Module');
    expect(result.entities[0].type).toBe(NodeType.Tool);
    expect(result.entities[1].type).toBe(NodeType.Bug);
    expect(result.relationships[0].relationship).toBe(RelationshipType.RelatesTo);
  });

  it('handles JSON inside markdown code block', () => {
    const jsonBlock = '```json\n{"entities": [{"id": "x", "type": "concept", "name": "X"}], "relationships": []}\n```';
    const result = parseLlmExtraction(jsonBlock);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('X');
  });

  it('returns empty on invalid JSON', () => {
    const result = parseLlmExtraction('not json at all');
    expect(result.entities).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });

  it('maps unknown types to Concept', () => {
    const json = JSON.stringify({
      entities: [{ id: 'x', type: 'unknown_type', name: 'X' }],
      relationships: [],
    });
    const result = parseLlmExtraction(json);
    expect(result.entities[0].type).toBe(NodeType.Concept);
  });

  it('maps unknown relationship types to RelatesTo', () => {
    const json = JSON.stringify({
      entities: [],
      relationships: [{ source: 'a', target: 'b', relationship: 'unknown_rel' }],
    });
    const result = parseLlmExtraction(json);
    expect(result.relationships[0].relationship).toBe(RelationshipType.RelatesTo);
  });

  it('uses defaultSalience when entity has no salience', () => {
    const json = JSON.stringify({
      entities: [{ id: 'x', name: 'X' }],
      relationships: [],
    });
    const result = parseLlmExtraction(json, 'donna', 0.7);
    expect(result.entities[0].salience).toBe(0.7);
  });

  it('handles missing fields gracefully', () => {
    const json = JSON.stringify({ entities: [{}], relationships: [{}] });
    const result = parseLlmExtraction(json);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Unknown');
    expect(result.relationships).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadExtractionToGraph
// ---------------------------------------------------------------------------

describe('loadExtractionToGraph', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  afterEach(() => {
    graph.close();
  });

  it('adds new nodes to graph', () => {
    const result = parseLlmExtraction(JSON.stringify({
      entities: [
        { id: 'node-a', type: 'concept', name: 'Node A', salience: 0.8 },
        { id: 'node-b', type: 'tool', name: 'Node B', salience: 0.6 },
      ],
      relationships: [],
    }));

    const stats = loadExtractionToGraph(graph, result);
    expect(stats.nodesAdded).toBe(2);
    expect(stats.nodesReinforced).toBe(0);
    expect(graph.getNode('node-a')).not.toBeNull();
    expect(graph.getNode('node-b')).not.toBeNull();
  });

  it('reinforces existing nodes on merge', () => {
    graph.addNode({ id: 'existing', name: 'Existing', salience: 0.5 });

    const result = parseLlmExtraction(JSON.stringify({
      entities: [{ id: 'existing', type: 'concept', name: 'Existing', description: 'Updated desc' }],
      relationships: [],
    }));

    const stats = loadExtractionToGraph(graph, result);
    expect(stats.nodesReinforced).toBe(1);
    expect(stats.nodesAdded).toBe(0);
    // Salience should have been boosted
    expect(graph.getNode('existing')!.salience).toBeGreaterThan(0.5);
  });

  it('adds edges when both nodes exist', () => {
    const result = parseLlmExtraction(JSON.stringify({
      entities: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      relationships: [
        { source: 'a', target: 'b', relationship: 'depends_on' },
      ],
    }));

    const stats = loadExtractionToGraph(graph, result);
    expect(stats.edgesAdded).toBe(1);
    const edges = graph.getEdges('a', 'outgoing');
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe(RelationshipType.DependsOn);
  });

  it('skips edges when target node does not exist', () => {
    const result = parseLlmExtraction(JSON.stringify({
      entities: [{ id: 'a', name: 'A' }],
      relationships: [
        { source: 'a', target: 'nonexistent', relationship: 'relates_to' },
      ],
    }));

    const stats = loadExtractionToGraph(graph, result);
    expect(stats.edgesSkipped).toBe(1);
  });

  it('sets namespace on new nodes when provided', () => {
    graph.extendForCode();
    const result = parseLlmExtraction(JSON.stringify({
      entities: [{ id: 'ns-node', name: 'NS Node' }],
      relationships: [],
    }));

    loadExtractionToGraph(graph, result, true, 'agent-donna');
    const node = graph.getNode('ns-node')!;
    expect(node.namespace).toBe('agent-donna');
    expect(node.category).toBe('knowledge');
  });
});

// ---------------------------------------------------------------------------
// buildCodeIndex
// ---------------------------------------------------------------------------

describe('buildCodeIndex', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph(':memory:');
    graph.extendForCode();
  });

  afterEach(() => {
    graph.close();
  });

  it('indexes code entities with names >= minNameLength', () => {
    // Add a code node with sufficient name length
    graph.db.prepare(`
      INSERT INTO nodes (id, type, name, description, salience, confidence,
        source_agent, created_at, last_reinforced, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('code:class:BigClassName', 'Class', 'VeryLongClassName', 'A class', 1.0, 1.0, 'code-graph',
      new Date().toISOString(), new Date().toISOString(), 'code');

    const index = buildCodeIndex(graph);
    expect(index['VeryLongClassName']).toBe('code:class:BigClassName');
  });

  it('skips names shorter than minNameLength', () => {
    graph.db.prepare(`
      INSERT INTO nodes (id, type, name, description, salience, confidence,
        source_agent, created_at, last_reinforced, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('code:class:Short', 'Class', 'Short', 'A class', 1.0, 1.0, 'code-graph',
      new Date().toISOString(), new Date().toISOString(), 'code');

    const index = buildCodeIndex(graph);
    expect(index['Short']).toBeUndefined();
  });

  it('skips generic names like "service", "handler"', () => {
    const now = new Date().toISOString();
    graph.db.prepare(`
      INSERT INTO nodes (id, type, name, description, salience, confidence,
        source_agent, created_at, last_reinforced, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('code:class:svc', 'Class', 'service', 'A service', 1.0, 1.0, 'code-graph', now, now, 'code');

    const index = buildCodeIndex(graph, 3);
    expect(index['service']).toBeUndefined();
  });

  it('returns empty for graph with no code nodes', () => {
    expect(buildCodeIndex(graph)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractFromEntry (with NER mocked → regex fallback)
// ---------------------------------------------------------------------------

describe('extractFromEntry (regex fallback)', () => {
  it('extracts person names from capitalized two-word patterns', async () => {
    const entry = makeEntry('2025-12-01', 'Meeting notes', 'Talked with John Smith about the project.', 'observation');
    const result = await extractFromEntry(entry);
    expect(result.entities.some(e => e.name === 'John Smith')).toBe(true);
    expect(result.entities.find(e => e.name === 'John Smith')!.type).toBe(NodeType.Person);
  });

  it('extracts entities by keyword matching', async () => {
    const entry = makeEntry('2025-12-01', 'Bug found', 'Found a critical bug in the authentication module that causes a crash.', 'observation');
    const result = await extractFromEntry(entry);
    // Should extract an entity from the heading based on keyword match
    expect(result.entities.length).toBeGreaterThan(0);
  });

  it('includes salience score', async () => {
    const entry = makeEntry('2025-12-01', 'Security issue', 'Discovered a security vulnerability.', 'observation');
    const result = await extractFromEntry(entry);
    expect(result.salience).toBeGreaterThan(0);
  });

  it('handles empty content', async () => {
    const entry = makeEntry('2025-12-01', '', '', 'observation');
    const result = await extractFromEntry(entry);
    expect(result.entities).toHaveLength(0);
  });

  it('filters out non-person names like Session Handover', async () => {
    const entry = makeEntry('2025-12-01', 'Update', 'Session Handover notes from Daily Report.', 'handover');
    const result = await extractFromEntry(entry);
    const personNames = result.entities.filter(e => e.type === NodeType.Person).map(e => e.name);
    expect(personNames).not.toContain('Session Handover');
    expect(personNames).not.toContain('Daily Report');
  });
});
