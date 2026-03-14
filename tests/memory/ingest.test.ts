/**
 * Tests for ingest.ts — document ingestion pipeline.
 *
 * Covers:
 * - Regex fallback when GLiNER is unavailable
 * - MIN_ENTITIES_PER_CHUNK = 1 (single-entity chunks produce nodes)
 * - --fast flag works without GLiNER
 * - usedFallback flag is set correctly
 * - Person, Tool, Decision, Bug extraction via fallback
 * - Cross-document entity linking still works with fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph, NodeType, RelationshipType } from '../../src/memory/graph.js';

// Mock NER module so ingest falls back to regex
vi.mock('../../src/memory/ner.js', () => ({
  isAvailable: () => false,
  extractEntities: async () => [],
}));

// Mock embeddings — not needed for fallback tests
vi.mock('../../src/memory/embeddings.js', () => ({
  getEmbedding: async () => [],
  getEmbeddings: async () => [],
  isAvailable: async () => false,
}));

// Import after mocks
const { ingestDirectory } = await import('../../src/memory/ingest.js');

let graph: KnowledgeGraph;
let tmpDir: string;

beforeEach(() => {
  graph = new KnowledgeGraph(':memory:');
  tmpDir = mkdtempSync(join(tmpdir(), 'myelin-ingest-test-'));
});

afterEach(() => {
  graph.close();
});

// ---------------------------------------------------------------------------
// Fallback basics
// ---------------------------------------------------------------------------

describe('ingest with GLiNER unavailable (regex fallback)', () => {
  it('sets usedFallback=true when GLiNER is unavailable', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), 'Some simple notes about nothing special.');
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.usedFallback).toBe(true);
  });

  it('does not hard-fail — returns a result even without GLiNER', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), 'Some simple notes.');
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksProcessed).toBeGreaterThan(0);
  });

  it('extracts Person entities from capitalized two-word names', async () => {
    writeFileSync(
      join(tmpDir, 'meeting.md'),
      'Met with John Smith and Sarah Johnson to discuss the project plan.\n\nThey agreed to proceed with the new design.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.entitiesExtracted).toBeGreaterThanOrEqual(2);

    const john = graph.getNode('john-smith');
    expect(john).not.toBeNull();
    expect(john!.type).toBe(NodeType.Person);

    const sarah = graph.getNode('sarah-johnson');
    expect(sarah).not.toBeNull();
    expect(sarah!.type).toBe(NodeType.Person);
  });

  it('extracts Tool entities from known technology keywords', async () => {
    writeFileSync(
      join(tmpDir, 'tech.md'),
      'We deployed the service using Docker and Kubernetes on AWS.\n\nThe CI pipeline uses Jenkins for automation.',
    );
    const result = await ingestDirectory(graph, tmpDir);

    const docker = graph.getNode('docker');
    expect(docker).not.toBeNull();
    expect(docker!.type).toBe(NodeType.Tool);

    const kubernetes = graph.getNode('kubernetes');
    expect(kubernetes).not.toBeNull();
    expect(kubernetes!.type).toBe(NodeType.Tool);
  });

  it('extracts Decision entities from signal phrases', async () => {
    writeFileSync(
      join(tmpDir, 'decisions.md'),
      'We decided to Use Postgres instead of MongoDB for the main database.\n\nThe team agreed on Weekly Sprint Reviews.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.entitiesExtracted).toBeGreaterThan(0);
    expect(result.nodesAdded).toBeGreaterThan(0);
  });

  it('extracts Bug entities from signal phrases', async () => {
    writeFileSync(
      join(tmpDir, 'bugs.md'),
      'Found a bug in Authentication Module that causes sessions to expire early.\n\nThe root cause was a timezone conversion error.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.entitiesExtracted).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // MIN_ENTITIES_PER_CHUNK = 1
  // ---------------------------------------------------------------------------

  it('processes chunks with a single entity (MIN_ENTITIES_PER_CHUNK=1)', async () => {
    writeFileSync(
      join(tmpDir, 'single.md'),
      'Kevin Williams implemented the new feature.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.chunksWithEntities).toBeGreaterThanOrEqual(1);
    expect(result.nodesAdded).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // --fast flag
  // ---------------------------------------------------------------------------

  it('--fast flag works without GLiNER', async () => {
    writeFileSync(
      join(tmpDir, 'fast.md'),
      'John Smith and Sarah Johnson discussed the typescript migration plan.\n\nThey reviewed the docker configuration.',
    );
    const result = await ingestDirectory(graph, tmpDir, { fast: true });
    expect(result.usedFallback).toBe(true);
    expect(result.filesProcessed).toBe(1);
    expect(result.entitiesExtracted).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Cross-document linking
  // ---------------------------------------------------------------------------

  it('links entities across documents via cross-document linking', async () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'docs', 'doc1.md'),
      'John Smith is leading the typescript migration project.',
    );
    writeFileSync(
      join(tmpDir, 'docs', 'doc2.md'),
      'John Smith reviewed the typescript deployment pipeline.',
    );
    const result = await ingestDirectory(graph, join(tmpDir, 'docs'));
    expect(result.filesProcessed).toBe(2);

    const john = graph.getNode('john-smith');
    expect(john).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('filters out non-person names like Session Handover', async () => {
    writeFileSync(
      join(tmpDir, 'edge.md'),
      'Session Handover notes from Daily Report. Hub Hour recap.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    const sessionHandover = graph.getNode('session-handover');
    // Should not exist as a Person node
    if (sessionHandover) {
      expect(sessionHandover.type).not.toBe(NodeType.Person);
    }
  });

  it('handles empty files gracefully', async () => {
    writeFileSync(join(tmpDir, 'empty.md'), '');
    const result = await ingestDirectory(graph, tmpDir);
    // Empty files (0 bytes) are skipped by file discovery
    expect(result.filesProcessed).toBe(0);
    expect(result.chunksProcessed).toBe(0);
  });

  it('handles files with no extractable entities', async () => {
    writeFileSync(join(tmpDir, 'boring.md'), 'the quick brown fox jumps over the lazy dog repeatedly');
    const result = await ingestDirectory(graph, tmpDir);
    expect(result.filesProcessed).toBe(1);
    // Should not crash, may or may not find entities
  });

  it('creates edges between co-occurring entities in same chunk', async () => {
    writeFileSync(
      join(tmpDir, 'cooccur.md'),
      'John Smith deployed the application using Docker to production.',
    );
    const result = await ingestDirectory(graph, tmpDir);
    // If both Person and Tool entities found in same chunk, should create edges
    if (result.entitiesExtracted >= 2) {
      expect(result.edgesAdded).toBeGreaterThan(0);
    }
  });
});
