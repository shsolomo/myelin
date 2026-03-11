/**
 * Tests for vocabulary.ts — entity and relationship type vocabulary.
 *
 * Covers: NER_LABELS, ENTITY_PATTERNS, RELATIONSHIP_PATTERNS, getLlmExtractionPrompt
 */

import { describe, it, expect } from 'vitest';
import {
  NER_LABELS,
  ENTITY_PATTERNS,
  RELATIONSHIP_PATTERNS,
  getLlmExtractionPrompt,
  NodeType,
  RelationshipType,
} from '../../src/memory/vocabulary.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('NER_LABELS', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(NER_LABELS)).toBe(true);
    expect(NER_LABELS.length).toBeGreaterThan(0);
    for (const label of NER_LABELS) {
      expect(typeof label).toBe('string');
    }
  });

  it('includes core entity labels', () => {
    expect(NER_LABELS).toContain('person');
    expect(NER_LABELS).toContain('software tool');
    expect(NER_LABELS).toContain('architectural decision');
    expect(NER_LABELS).toContain('bug or error');
  });
});

describe('ENTITY_PATTERNS', () => {
  it('has patterns for all core NodeTypes', () => {
    const coveredTypes = new Set(ENTITY_PATTERNS.map(p => p.nodeType));
    expect(coveredTypes.has(NodeType.Person)).toBe(true);
    expect(coveredTypes.has(NodeType.Decision)).toBe(true);
    expect(coveredTypes.has(NodeType.Bug)).toBe(true);
    expect(coveredTypes.has(NodeType.Pattern)).toBe(true);
    expect(coveredTypes.has(NodeType.Tool)).toBe(true);
  });

  it('each pattern has non-empty keywords array', () => {
    for (const pattern of ENTITY_PATTERNS) {
      expect(pattern.keywords.length, `${pattern.nodeType}`).toBeGreaterThan(0);
    }
  });

  it('each pattern has a description', () => {
    for (const pattern of ENTITY_PATTERNS) {
      expect(pattern.description.length, `${pattern.nodeType}`).toBeGreaterThan(0);
    }
  });
});

describe('RELATIONSHIP_PATTERNS', () => {
  it('has patterns for core relationship types', () => {
    const coveredTypes = new Set(RELATIONSHIP_PATTERNS.map(p => p.relationship));
    expect(coveredTypes.has(RelationshipType.DependsOn)).toBe(true);
    expect(coveredTypes.has(RelationshipType.RelatesTo)).toBe(true);
    expect(coveredTypes.has(RelationshipType.Supersedes)).toBe(true);
    expect(coveredTypes.has(RelationshipType.AuthoredBy)).toBe(true);
  });

  it('each pattern has non-empty signalPhrases', () => {
    for (const pattern of RELATIONSHIP_PATTERNS) {
      expect(pattern.signalPhrases.length, `${pattern.relationship}`).toBeGreaterThan(0);
    }
  });

  it('AuthoredBy targets Person type', () => {
    const authored = RELATIONSHIP_PATTERNS.find(p => p.relationship === RelationshipType.AuthoredBy);
    expect(authored).toBeDefined();
    expect(authored!.targetType).toBe(NodeType.Person);
  });

  it('MentionedIn targets Meeting type', () => {
    const mentioned = RELATIONSHIP_PATTERNS.find(p => p.relationship === RelationshipType.MentionedIn);
    expect(mentioned).toBeDefined();
    expect(mentioned!.targetType).toBe(NodeType.Meeting);
  });
});

// ---------------------------------------------------------------------------
// getLlmExtractionPrompt
// ---------------------------------------------------------------------------

describe('getLlmExtractionPrompt', () => {
  it('includes the text in the prompt', () => {
    const prompt = getLlmExtractionPrompt('My test text about bugs.');
    expect(prompt).toContain('My test text about bugs.');
  });

  it('includes all NodeType values', () => {
    const prompt = getLlmExtractionPrompt('test');
    for (const nodeType of Object.values(NodeType)) {
      expect(prompt).toContain(nodeType);
    }
  });

  it('includes all RelationshipType values', () => {
    const prompt = getLlmExtractionPrompt('test');
    for (const relType of Object.values(RelationshipType)) {
      expect(prompt).toContain(relType);
    }
  });

  it('includes existing entities when provided', () => {
    const prompt = getLlmExtractionPrompt('test', ['auth-module', 'user-service']);
    expect(prompt).toContain('auth-module');
    expect(prompt).toContain('user-service');
    expect(prompt).toContain('Existing entities');
  });

  it('does not include existing entities section when none provided', () => {
    const prompt = getLlmExtractionPrompt('test');
    expect(prompt).not.toContain('Existing entities');
  });

  it('includes JSON schema guidance', () => {
    const prompt = getLlmExtractionPrompt('test');
    expect(prompt).toContain('"entities"');
    expect(prompt).toContain('"relationships"');
    expect(prompt).toContain('"salience"');
  });

  it('includes salience guide', () => {
    const prompt = getLlmExtractionPrompt('test');
    expect(prompt).toContain('SALIENCE GUIDE');
  });
});
