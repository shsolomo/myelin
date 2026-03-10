/**
 * C# parser using tree-sitter.
 * Ported from cortex/code/parsers/csharp.py
 */

import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp';
import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

function getParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(CSharp as unknown as Parser.Language);
  return parser;
}

function nodeText(node: Parser.SyntaxNode, source: Buffer): string {
  return source.subarray(node.startIndex, node.endIndex).toString('utf-8');
}

function findChildren(node: Parser.SyntaxNode, typeName: string): Parser.SyntaxNode[] {
  return node.children.filter((c) => c.type === typeName);
}

function findChild(node: Parser.SyntaxNode, typeName: string): Parser.SyntaxNode | null {
  return node.children.find((c) => c.type === typeName) ?? null;
}

function getName(node: Parser.SyntaxNode, source: Buffer): string {
  const nameNode = findChild(node, 'identifier') ?? findChild(node, 'name');
  return nameNode ? nodeText(nameNode, source) : '';
}

function getModifiers(node: Parser.SyntaxNode, source: Buffer): string[] {
  return node.children
    .filter((c) => c.type === 'modifier')
    .map((c) => nodeText(c, source));
}

function getBaseTypes(node: Parser.SyntaxNode, source: Buffer): string[] {
  const baseList = findChild(node, 'base_list');
  if (!baseList) return [];
  const types: string[] = [];
  for (const child of baseList.children) {
    if (['simple_base_type', 'identifier', 'generic_name', 'qualified_name', 'predefined_type'].includes(child.type)) {
      types.push(nodeText(child, source));
    } else if (child.type === ':' || child.type === ',' || child.type === 'type_argument_list') {
      continue;
    } else {
      const text = nodeText(child, source).trim();
      if (text && text !== ':' && text !== ',') {
        types.push(text);
      }
    }
  }
  return types;
}

function extractNamespace(root: Parser.SyntaxNode, source: Buffer): string {
  for (const child of root.children) {
    if (child.type === 'file_scoped_namespace_declaration' || child.type === 'namespace_declaration') {
      const nameNode = findChild(child, 'qualified_name') ?? findChild(child, 'identifier');
      if (nameNode) return nodeText(nameNode, source);
    }
  }
  return '';
}

function extractUsings(root: Parser.SyntaxNode, source: Buffer): string[] {
  const usings: string[] = [];
  for (const child of root.children) {
    if (child.type === 'using_directive') {
      for (const uc of child.children) {
        if (uc.type === 'qualified_name' || uc.type === 'identifier') {
          usings.push(nodeText(uc, source));
          break;
        }
      }
    }
  }
  return usings;
}

const TYPE_DECLS: Record<string, string> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  record_declaration: 'class',
};

const MEMBER_DECLS: Record<string, string> = {
  method_declaration: 'method',
  property_declaration: 'property',
  constructor_declaration: 'constructor',
};

function extractTypeEntities(
  node: Parser.SyntaxNode,
  source: Buffer,
  namespace: string,
  filePath: string,
  parentFqn = '',
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  for (const child of node.children) {
    const entityType = TYPE_DECLS[child.type];
    if (!entityType) {
      if (child.type === 'declaration_list') {
        entities.push(...extractTypeEntities(child, source, namespace, filePath, parentFqn));
      }
      continue;
    }

    const name = getName(child, source);
    if (!name) continue;

    let fqn: string;
    if (parentFqn) {
      fqn = `${parentFqn}.${name}`;
    } else if (namespace) {
      fqn = `${namespace}.${name}`;
    } else {
      fqn = name;
    }

    const modifiers = getModifiers(child, source);
    const baseTypes = getBaseTypes(child, source);

    const entity = makeEntity({
      entityType,
      name,
      fullyQualifiedName: fqn,
      filePath,
      lineStart: child.startPosition.row + 1,
      lineEnd: child.endPosition.row + 1,
      modifiers,
      baseTypes,
    });

    const body = findChild(child, 'declaration_list');
    if (body) {
      for (const memberChild of body.children) {
        let memberType = MEMBER_DECLS[memberChild.type];
        if (memberType) {
          let memberName = getName(memberChild, source);
          if (memberType === 'constructor') memberName = name;
          if (!memberName) continue;
          const memberFqn = `${fqn}.${memberName}`;
          entity.members.push(makeEntity({
            entityType: memberType,
            name: memberName,
            fullyQualifiedName: memberFqn,
            filePath,
            lineStart: memberChild.startPosition.row + 1,
            lineEnd: memberChild.endPosition.row + 1,
            modifiers: getModifiers(memberChild, source),
          }));
        }
      }
      // Nested type declarations
      const nested = extractTypeEntities(body, source, namespace, filePath, fqn);
      for (const ne of nested) {
        entity.members.push(ne);
      }
    }

    entities.push(entity);
  }
  return entities;
}

function buildEdges(parsed: ParsedFile): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const fp = parsed.filePath;
  const fileNodeId = `code:${fp}:file:${fp}`;

  for (const ns of parsed.usingDirectives) {
    edges.push(makeEdge({
      sourceName: fileNodeId,
      targetName: ns,
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
      const btClean = bt.split('<')[0].trim();
      const rel = btClean.length >= 2 && btClean[0] === 'I' && btClean[1] === btClean[1].toUpperCase() && btClean[1] !== btClean[1].toLowerCase()
        ? 'implements'
        : 'inherits';
      edges.push(makeEdge({
        sourceName: eid,
        targetName: btClean,
        relationship: rel,
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

      if (['class', 'interface', 'struct', 'enum'].includes(member.entityType)) {
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
  }

  return edges;
}

export class CSharpParser extends BaseParser {
  private parser: Parser;

  constructor() {
    super();
    this.parser = getParser();
  }

  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const tree = this.parser.parse(source.toString('utf-8'));
    const root = tree.rootNode;

    const namespace = extractNamespace(root, source);
    const usings = extractUsings(root, source);

    const entities: ParsedEntity[] = [];
    for (const child of root.children) {
      if (child.type === 'file_scoped_namespace_declaration') {
        entities.push(...extractTypeEntities(child, source, namespace, relativePath));
      } else if (child.type === 'namespace_declaration') {
        const body = findChild(child, 'declaration_list');
        if (body) {
          entities.push(...extractTypeEntities(body, source, namespace, relativePath));
        }
      } else if (child.type in TYPE_DECLS) {
        const name = getName(child, source);
        if (!name) continue;
        const fqn = namespace ? `${namespace}.${name}` : name;
        const entityType = TYPE_DECLS[child.type];
        const modifiers = getModifiers(child, source);
        const baseTypes = getBaseTypes(child, source);
        const entity = makeEntity({
          entityType,
          name,
          fullyQualifiedName: fqn,
          filePath: relativePath,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          modifiers,
          baseTypes,
        });
        const body = findChild(child, 'declaration_list');
        if (body) {
          for (const mc of body.children) {
            const mt = MEMBER_DECLS[mc.type];
            if (mt) {
              let mn = getName(mc, source);
              if (mt === 'constructor') mn = name;
              if (!mn) continue;
              entity.members.push(makeEntity({
                entityType: mt,
                name: mn,
                fullyQualifiedName: `${fqn}.${mn}`,
                filePath: relativePath,
                lineStart: mc.startPosition.row + 1,
                lineEnd: mc.endPosition.row + 1,
                modifiers: getModifiers(mc, source),
              }));
            }
          }
          const nested = extractTypeEntities(body, source, namespace, relativePath, fqn);
          for (const ne of nested) {
            entity.members.push(ne);
          }
        }
        entities.push(entity);
      }
    }

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'csharp',
      namespace,
      entities,
      usingDirectives: usings,
    });

    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
