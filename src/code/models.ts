/**
 * Data models for parsed code entities.
 * Ported from cortex/code/models.py
 */

export interface ParsedEntity {
  entityType: string;
  name: string;
  fullyQualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  modifiers: string[];
  baseTypes: string[];
  members: ParsedEntity[];
}

export interface ParsedEdge {
  sourceName: string;
  targetName: string;
  relationship: string;
  sourceFile: string;
  targetFile: string;
}

export interface ParsedFile {
  filePath: string;
  language: string;
  namespace: string;
  entities: ParsedEntity[];
  usingDirectives: string[];
  edges: ParsedEdge[];
}

export function makeEntity(partial: Partial<ParsedEntity> & Pick<ParsedEntity, 'entityType' | 'name' | 'fullyQualifiedName' | 'filePath' | 'lineStart' | 'lineEnd'>): ParsedEntity {
  return {
    modifiers: [],
    baseTypes: [],
    members: [],
    ...partial,
  };
}

export function makeEdge(partial: Partial<ParsedEdge> & Pick<ParsedEdge, 'sourceName' | 'targetName' | 'relationship'>): ParsedEdge {
  return {
    sourceFile: '',
    targetFile: '',
    ...partial,
  };
}

export function makeParsedFile(partial: Partial<ParsedFile> & Pick<ParsedFile, 'filePath' | 'language'>): ParsedFile {
  return {
    namespace: '',
    entities: [],
    usingDirectives: [],
    edges: [],
    ...partial,
  };
}
