/**
 * Go parser using web-tree-sitter (WASM).
 * Ported from cortex/code/parsers/go_parser.py
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

function findChildren(node: SyntaxNode, typeName: string): SyntaxNode[] {
  return node.children.filter((c: SyntaxNode) => c.type === typeName);
}

function findChild(node: SyntaxNode, typeName: string): SyntaxNode | null {
  return node.children.find((c: SyntaxNode) => c.type === typeName) ?? null;
}

function getName(node: SyntaxNode, source: Buffer): string {
  const nameNode = findChild(node, 'identifier') ?? findChild(node, 'field_identifier');
  return nameNode ? nodeText(nameNode, source) : '';
}

function extractPackage(root: SyntaxNode, source: Buffer): string {
  for (const child of root.children) {
    if (child.type === 'package_clause') {
      const nameNode = findChild(child, 'package_identifier') ?? findChild(child, 'identifier');
      if (nameNode) return nodeText(nameNode, source);
    }
  }
  return '';
}

function extractImports(root: SyntaxNode, source: Buffer): string[] {
  const imports: string[] = [];
  for (const child of root.children) {
    if (child.type === 'import_declaration') {
      for (const specList of findChildren(child, 'import_spec_list')) {
        for (const spec of findChildren(specList, 'import_spec')) {
          const pathNode =
            findChild(spec, 'interpreted_string_literal') ??
            findChild(spec, 'raw_string_literal');
          if (pathNode) {
            imports.push(nodeText(pathNode, source).replace(/["`\s]/g, ''));
          }
        }
      }
      for (const spec of findChildren(child, 'import_spec')) {
        const pathNode =
          findChild(spec, 'interpreted_string_literal') ??
          findChild(spec, 'raw_string_literal');
        if (pathNode) {
          imports.push(nodeText(pathNode, source).replace(/["`\s]/g, ''));
        }
      }
    }
  }
  return imports;
}

function getMethodReceiverType(node: SyntaxNode, source: Buffer): string {
  const paramList = findChild(node, 'parameter_list');
  if (paramList) {
    for (const param of findChildren(paramList, 'parameter_declaration')) {
      for (const c of param.children) {
        if (c.type === 'type_identifier') {
          return nodeText(c, source);
        } else if (c.type === 'pointer_type') {
          const inner = findChild(c, 'type_identifier');
          if (inner) return nodeText(inner, source);
        }
      }
    }
  }
  return '';
}

function extractEntities(
  root: SyntaxNode,
  source: Buffer,
  pkg: string,
  filePath: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  for (const child of root.children) {
    if (child.type === 'function_declaration') {
      const name = getName(child, source);
      if (!name) continue;
      const fqn = pkg ? `${pkg}.${name}` : name;
      entities.push(makeEntity({
        entityType: 'function',
        name,
        fullyQualifiedName: fqn,
        filePath,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      }));
    } else if (child.type === 'method_declaration') {
      const receiverType = getMethodReceiverType(child, source);
      const name = getName(child, source);
      if (!name) continue;
      let fqn: string;
      let methodName: string;
      if (receiverType) {
        fqn = pkg ? `${pkg}.${receiverType}.${name}` : `${receiverType}.${name}`;
        methodName = `${receiverType}.${name}`;
      } else {
        fqn = pkg ? `${pkg}.${name}` : name;
        methodName = name;
      }
      entities.push(makeEntity({
        entityType: 'method',
        name: methodName,
        fullyQualifiedName: fqn,
        filePath,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      }));
    } else if (child.type === 'type_declaration') {
      for (const spec of findChildren(child, 'type_spec')) {
        const typeNameNode = findChild(spec, 'type_identifier') ?? findChild(spec, 'identifier');
        if (!typeNameNode) continue;
        const typeName = nodeText(typeNameNode, source);
        const fqn = pkg ? `${pkg}.${typeName}` : typeName;

        let entityType = 'type';
        for (const bodyChild of spec.children) {
          if (bodyChild.type === 'struct_type') {
            entityType = 'struct';
            break;
          } else if (bodyChild.type === 'interface_type') {
            entityType = 'interface';
            break;
          }
        }

        const entity = makeEntity({
          entityType,
          name: typeName,
          fullyQualifiedName: fqn,
          filePath,
          lineStart: spec.startPosition.row + 1,
          lineEnd: spec.endPosition.row + 1,
        });

        // Extract interface methods as members
        if (entityType === 'interface') {
          for (const bodyChild of spec.children) {
            if (bodyChild.type === 'interface_type') {
              for (const methodElem of bodyChild.children) {
                if (methodElem.type === 'method_elem') {
                  const mName = getName(methodElem, source);
                  if (mName) {
                    entity.members.push(makeEntity({
                      entityType: 'method',
                      name: mName,
                      fullyQualifiedName: `${fqn}.${mName}`,
                      filePath,
                      lineStart: methodElem.startPosition.row + 1,
                      lineEnd: methodElem.endPosition.row + 1,
                    }));
                  }
                }
              }
            }
          }
        }

        entities.push(entity);
      }
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

    for (const member of entity.members) {
      const mid = `code:${fp}:${member.entityType}:${member.fullyQualifiedName}`;
      edges.push(makeEdge({
        sourceName: eid,
        targetName: mid,
        relationship: 'contains',
        sourceFile: fp,
        targetFile: fp,
      }));
    }
  }

  return edges;
}

export class GoParser extends BaseParser {
  constructor() {
    super();
  }

  async parseFile(filePath: string, source: Buffer, relativePath: string): Promise<ParsedFile> {
    if (!cachedParser) {
      cachedParser = await createParser('tree-sitter-go.wasm');
    }

    const tree = cachedParser.parse(source.toString('utf-8'));
    const root = tree.rootNode;

    const pkg = extractPackage(root, source);
    const imports = extractImports(root, source);
    const entities = extractEntities(root, source, pkg, relativePath);

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'go',
      namespace: pkg,
      entities,
      usingDirectives: imports,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
