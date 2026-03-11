/**
 * Tests for code/models.ts — parsed code entity factories.
 *
 * Covers: makeEntity, makeEdge, makeParsedFile defaults and overrides
 */

import { describe, it, expect } from 'vitest';
import { makeEntity, makeEdge, makeParsedFile } from '../../src/code/models.js';

// ---------------------------------------------------------------------------
// makeEntity
// ---------------------------------------------------------------------------

describe('makeEntity', () => {
  it('creates an entity with required fields', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'MyClass',
      fullyQualifiedName: 'MyNamespace.MyClass',
      filePath: 'src/my-class.ts',
      lineStart: 10,
      lineEnd: 50,
    });
    expect(entity.entityType).toBe('class');
    expect(entity.name).toBe('MyClass');
    expect(entity.fullyQualifiedName).toBe('MyNamespace.MyClass');
    expect(entity.filePath).toBe('src/my-class.ts');
    expect(entity.lineStart).toBe(10);
    expect(entity.lineEnd).toBe(50);
  });

  it('defaults modifiers to empty array', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'X',
      fullyQualifiedName: 'X',
      filePath: 'x.ts',
      lineStart: 1,
      lineEnd: 1,
    });
    expect(entity.modifiers).toEqual([]);
  });

  it('defaults baseTypes to empty array', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'X',
      fullyQualifiedName: 'X',
      filePath: 'x.ts',
      lineStart: 1,
      lineEnd: 1,
    });
    expect(entity.baseTypes).toEqual([]);
  });

  it('defaults members to empty array', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'X',
      fullyQualifiedName: 'X',
      filePath: 'x.ts',
      lineStart: 1,
      lineEnd: 1,
    });
    expect(entity.members).toEqual([]);
  });

  it('allows overriding defaults', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'MyClass',
      fullyQualifiedName: 'MyClass',
      filePath: 'src/my-class.ts',
      lineStart: 1,
      lineEnd: 50,
      modifiers: ['public', 'abstract'],
      baseTypes: ['BaseClass', 'IInterface'],
      members: [
        makeEntity({
          entityType: 'method',
          name: 'doStuff',
          fullyQualifiedName: 'MyClass.doStuff',
          filePath: 'src/my-class.ts',
          lineStart: 10,
          lineEnd: 20,
        }),
      ],
    });
    expect(entity.modifiers).toEqual(['public', 'abstract']);
    expect(entity.baseTypes).toEqual(['BaseClass', 'IInterface']);
    expect(entity.members).toHaveLength(1);
    expect(entity.members[0].name).toBe('doStuff');
  });
});

// ---------------------------------------------------------------------------
// makeEdge
// ---------------------------------------------------------------------------

describe('makeEdge', () => {
  it('creates an edge with required fields', () => {
    const edge = makeEdge({
      sourceName: 'ClassA',
      targetName: 'ClassB',
      relationship: 'inherits',
    });
    expect(edge.sourceName).toBe('ClassA');
    expect(edge.targetName).toBe('ClassB');
    expect(edge.relationship).toBe('inherits');
  });

  it('defaults sourceFile and targetFile to empty string', () => {
    const edge = makeEdge({
      sourceName: 'A',
      targetName: 'B',
      relationship: 'uses',
    });
    expect(edge.sourceFile).toBe('');
    expect(edge.targetFile).toBe('');
  });

  it('allows overriding file paths', () => {
    const edge = makeEdge({
      sourceName: 'A',
      targetName: 'B',
      relationship: 'uses',
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
    });
    expect(edge.sourceFile).toBe('a.ts');
    expect(edge.targetFile).toBe('b.ts');
  });
});

// ---------------------------------------------------------------------------
// makeParsedFile
// ---------------------------------------------------------------------------

describe('makeParsedFile', () => {
  it('creates a parsed file with required fields', () => {
    const pf = makeParsedFile({
      filePath: 'src/main.ts',
      language: 'typescript',
    });
    expect(pf.filePath).toBe('src/main.ts');
    expect(pf.language).toBe('typescript');
  });

  it('defaults namespace to empty string', () => {
    const pf = makeParsedFile({ filePath: 'x.ts', language: 'typescript' });
    expect(pf.namespace).toBe('');
  });

  it('defaults entities to empty array', () => {
    const pf = makeParsedFile({ filePath: 'x.ts', language: 'typescript' });
    expect(pf.entities).toEqual([]);
  });

  it('defaults usingDirectives to empty array', () => {
    const pf = makeParsedFile({ filePath: 'x.ts', language: 'typescript' });
    expect(pf.usingDirectives).toEqual([]);
  });

  it('defaults edges to empty array', () => {
    const pf = makeParsedFile({ filePath: 'x.ts', language: 'typescript' });
    expect(pf.edges).toEqual([]);
  });

  it('allows overriding all fields', () => {
    const entity = makeEntity({
      entityType: 'class',
      name: 'Main',
      fullyQualifiedName: 'Main',
      filePath: 'src/main.ts',
      lineStart: 1,
      lineEnd: 100,
    });
    const pf = makeParsedFile({
      filePath: 'src/main.ts',
      language: 'typescript',
      namespace: 'MyApp',
      entities: [entity],
      usingDirectives: ['fs', 'path'],
      edges: [makeEdge({ sourceName: 'Main', targetName: 'Util', relationship: 'uses' })],
    });
    expect(pf.namespace).toBe('MyApp');
    expect(pf.entities).toHaveLength(1);
    expect(pf.usingDirectives).toEqual(['fs', 'path']);
    expect(pf.edges).toHaveLength(1);
  });
});
