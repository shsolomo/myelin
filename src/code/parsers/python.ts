/**
 * Python parser using web-tree-sitter (WASM).
 * Ported from cortex/code/parsers/python_parser.py
 */

import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';
import { createParser } from './wasm-init.js';
import type { Parser, SyntaxNode } from './wasm-init.js';

let cachedParser: Parser | null = null;

function nodeText(node: SyntaxNode, source: Buffer): string {
  return source.subarray(node.startIndex, node.endIndex).toString('utf-8');
}

function findChild(node: SyntaxNode, typeName: string): SyntaxNode | null {
  return node.children.find((c: SyntaxNode) => c.type === typeName) ?? null;
}

function getName(node: SyntaxNode, source: Buffer): string {
  const nameNode = findChild(node, 'identifier');
  return nameNode ? nodeText(nameNode, source) : '';
}

function extractImports(root: SyntaxNode, source: Buffer): string[] {
  const imports: string[] = [];
  for (const child of root.children) {
    if (child.type === 'import_statement') {
      for (const c of child.children) {
        if (c.type === 'dotted_name') {
          imports.push(nodeText(c, source));
        } else if (c.type === 'aliased_import') {
          const dn = findChild(c, 'dotted_name');
          if (dn) imports.push(nodeText(dn, source));
        }
      }
    } else if (child.type === 'import_from_statement') {
      const moduleName = findChild(child, 'dotted_name') ?? findChild(child, 'relative_import');
      if (moduleName) imports.push(nodeText(moduleName, source));
    }
  }
  return imports;
}

function deriveNamespace(relativePath: string): string {
  let norm = relativePath.replace(/\\/g, '/');
  if (norm.endsWith('.py')) norm = norm.slice(0, -3);
  if (norm.endsWith('/__init__')) norm = norm.slice(0, -9);
  return norm.replace(/\//g, '.');
}

function getBaseClasses(node: SyntaxNode, source: Buffer): string[] {
  const argList = findChild(node, 'argument_list');
  if (!argList) return [];
  const bases: string[] = [];
  for (const c of argList.children) {
    if (c.type === 'identifier' || c.type === 'attribute') {
      bases.push(nodeText(c, source));
    }
  }
  return bases;
}

function getDecorators(node: SyntaxNode, source: Buffer): string[] {
  const decorators: string[] = [];
  for (const c of node.children) {
    if (c.type === 'decorator') {
      const decText = nodeText(c, source).replace(/^@/, '').split('(')[0].trim();
      decorators.push(decText);
    }
  }
  return decorators;
}

function extractEntities(
  root: SyntaxNode,
  source: Buffer,
  namespace: string,
  filePath: string,
  parentFqn = '',
  insideClass = false,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const child of root.children) {
    let decorators: string[] = [];
    let node = child;
    if (child.type === 'decorated_definition') {
      decorators = getDecorators(child, source);
      for (let i = child.children.length - 1; i >= 0; i--) {
        const inner = child.children[i];
        if (inner.type === 'class_definition' || inner.type === 'function_definition') {
          node = inner;
          break;
        }
      }
    }

    if (node.type === 'class_definition') {
      const name = getName(node, source);
      if (!name) continue;
      const fqn = parentFqn
        ? `${parentFqn}.${name}`
        : namespace
          ? `${namespace}.${name}`
          : name;
      const baseTypes = getBaseClasses(node, source);

      const entity = makeEntity({
        entityType: 'class',
        name,
        fullyQualifiedName: fqn,
        filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        baseTypes,
        modifiers: decorators,
      });

      const body = findChild(node, 'block');
      if (body) {
        for (const nested of extractEntities(body, source, namespace, filePath, fqn, true)) {
          entity.members.push(nested);
        }
      }

      entities.push(entity);
    } else if (node.type === 'function_definition') {
      const name = getName(node, source);
      if (!name) continue;
      const entityType = insideClass ? 'method' : 'function';
      const fqn = parentFqn
        ? `${parentFqn}.${name}`
        : namespace
          ? `${namespace}.${name}`
          : name;

      entities.push(makeEntity({
        entityType,
        name,
        fullyQualifiedName: fqn,
        filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        modifiers: decorators,
      }));
    }
  }

  return entities;
}

function buildEdges(parsed: ParsedFile): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const fp = parsed.filePath;
  const fileNodeId = `code:${fp}:file:${fp}`;

  for (const imp of parsed.usingDirectives) {
    edges.push(makeEdge({
      sourceName: fileNodeId,
      targetName: imp,
      relationship: 'imports',
      sourceFile: fp,
    }));
  }

  for (const entity of parsed.entities) {
    const eid = `code:${fp}:${entity.entityType}:${entity.fullyQualifiedName}`;

    edges.push(makeEdge({
      sourceName: fileNodeId,
      targetName: eid,
      relationship: 'defines',
      sourceFile: fp,
      targetFile: fp,
    }));

    if (parsed.namespace) {
      edges.push(makeEdge({
        sourceName: eid,
        targetName: parsed.namespace,
        relationship: 'belongs_to',
        sourceFile: fp,
      }));
    }

    for (const bt of entity.baseTypes) {
      const btClean = bt.trim();
      if (btClean && btClean !== 'object') {
        edges.push(makeEdge({
          sourceName: eid,
          targetName: btClean,
          relationship: 'inherits',
          sourceFile: fp,
        }));
      }
    }

    for (const member of entity.members) {
      const mid = `code:${fp}:${member.entityType}:${member.fullyQualifiedName}`;
      edges.push(makeEdge({
        sourceName: eid,
        targetName: mid,
        relationship: 'contains',
        sourceFile: fp,
        targetFile: fp,
      }));

      for (const subMember of member.members) {
        const subMid = `code:${fp}:${subMember.entityType}:${subMember.fullyQualifiedName}`;
        edges.push(makeEdge({
          sourceName: mid,
          targetName: subMid,
          relationship: 'contains',
          sourceFile: fp,
          targetFile: fp,
        }));
      }
    }
  }

  return edges;
}

export class PythonParser extends BaseParser {
  constructor() {
    super();
  }

  async parseFile(filePath: string, source: Buffer, relativePath: string): Promise<ParsedFile> {
    if (!cachedParser) {
      cachedParser = await createParser('tree-sitter-python.wasm');
    }

    const tree = cachedParser.parse(source.toString('utf-8'));
    const root = tree.rootNode;

    const namespace = deriveNamespace(relativePath);
    const imports = extractImports(root, source);
    const entities = extractEntities(root, source, namespace, relativePath);

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'python',
      namespace,
      entities,
      usingDirectives: imports,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
