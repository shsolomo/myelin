/**
 * TypeScript/TSX parser using tree-sitter.
 * Ported from cortex/code/parsers/typescript.py
 */

import Parser from 'tree-sitter';
import TreeSitterTS from 'tree-sitter-typescript';
import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

const { typescript: tsLang, tsx: tsxLang } = TreeSitterTS;

function getParser(language: unknown): Parser {
  const parser = new Parser();
  parser.setLanguage(language as Parser.Language);
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
  const nameNode =
    findChild(node, 'identifier') ??
    findChild(node, 'type_identifier') ??
    findChild(node, 'property_identifier');
  return nameNode ? nodeText(nameNode, source) : '';
}

function getStringValue(node: Parser.SyntaxNode, source: Buffer): string {
  const text = nodeText(node, source);
  return text.replace(/^["'`]|["'`]$/g, '');
}

function extractImports(root: Parser.SyntaxNode, source: Buffer): string[] {
  const imports: string[] = [];
  for (const child of root.children) {
    if (child.type === 'import_statement') {
      for (const c of child.children) {
        if (c.type === 'string') {
          imports.push(getStringValue(c, source));
        }
      }
    } else if (child.type === 'export_statement') {
      for (const c of child.children) {
        if (c.type === 'string') {
          imports.push(getStringValue(c, source));
        }
      }
    }
  }
  return imports;
}

function unwrapExport(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type === 'export_statement') {
    for (const child of node.children) {
      if (!['export', 'default', ';', 'comment'].includes(child.type)) {
        return child;
      }
    }
  }
  return node;
}

const TYPE_DECLS: Record<string, string> = {
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  function_declaration: 'function',
  generator_function_declaration: 'function',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

const MEMBER_DECLS: Record<string, string> = {
  method_definition: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  property_definition: 'property',
  public_field_definition: 'property',
  property_signature: 'property',
};

function getHeritage(node: Parser.SyntaxNode, source: Buffer): string[] {
  const baseTypes: string[] = [];
  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const hc of child.children) {
        if (hc.type === 'extends_clause' || hc.type === 'implements_clause') {
          for (const ec of hc.children) {
            if (ec.type === 'identifier' || ec.type === 'type_identifier') {
              baseTypes.push(nodeText(ec, source));
            } else if (ec.type === 'generic_type') {
              const inner = findChild(ec, 'type_identifier') ?? findChild(ec, 'identifier');
              if (inner) baseTypes.push(nodeText(inner, source));
            }
          }
        }
      }
    } else if (child.type === 'extends_clause' || child.type === 'implements_clause') {
      for (const ec of child.children) {
        if (ec.type === 'identifier' || ec.type === 'type_identifier') {
          baseTypes.push(nodeText(ec, source));
        }
      }
    }
  }
  return baseTypes;
}

function extractMembers(
  body: Parser.SyntaxNode,
  source: Buffer,
  parentFqn: string,
  filePath: string,
): ParsedEntity[] {
  const members: ParsedEntity[] = [];
  for (const child of body.children) {
    const memberType = MEMBER_DECLS[child.type];
    if (!memberType) continue;
    const memberName = getName(child, source);
    if (!memberName) continue;
    members.push(makeEntity({
      entityType: memberType,
      name: memberName,
      fullyQualifiedName: `${parentFqn}.${memberName}`,
      filePath,
      lineStart: child.startPosition.row + 1,
      lineEnd: child.endPosition.row + 1,
    }));
  }
  return members;
}

function processDeclarations(
  root: Parser.SyntaxNode,
  source: Buffer,
  namespace: string,
  filePath: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  for (const child of root.children) {
    const node = unwrapExport(child);

    // Arrow functions assigned to const/let/var
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const decl of findChildren(node, 'variable_declarator')) {
        const init =
          findChild(decl, 'arrow_function') ??
          findChild(decl, 'function_expression') ??
          findChild(decl, 'generator_function_expression');
        if (init) {
          const varName = getName(decl, source);
          if (!varName) continue;
          const fqn = namespace ? `${namespace}.${varName}` : varName;
          entities.push(makeEntity({
            entityType: 'function',
            name: varName,
            fullyQualifiedName: fqn,
            filePath,
            lineStart: decl.startPosition.row + 1,
            lineEnd: decl.endPosition.row + 1,
          }));
        }
      }
      continue;
    }

    const entityType = TYPE_DECLS[node.type];
    if (!entityType) continue;

    const name = getName(node, source);
    if (!name) continue;

    const fqn = namespace ? `${namespace}.${name}` : name;
    const baseTypes = getHeritage(node, source);

    const entity = makeEntity({
      entityType,
      name,
      fullyQualifiedName: fqn,
      filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      baseTypes,
    });

    const body =
      findChild(node, 'class_body') ??
      findChild(node, 'interface_body') ??
      findChild(node, 'object_type');
    if (body) {
      entity.members = extractMembers(body, source, fqn, filePath);
    }

    entities.push(entity);
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
      const btClean = bt.split('<')[0].trim();
      if (!btClean) continue;
      const rel =
        btClean.startsWith('I') && btClean.length > 1 && btClean[1] === btClean[1].toUpperCase() && btClean[1] !== btClean[1].toLowerCase()
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
    }
  }

  return edges;
}

function deriveNamespace(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : '';
}

export class TypeScriptParser extends BaseParser {
  private parser: Parser;
  private langName: string;

  constructor(useTsx = false) {
    super();
    const lang = useTsx ? tsxLang : tsLang;
    this.parser = getParser(lang);
    this.langName = useTsx ? 'tsx' : 'typescript';
  }

  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const tree = this.parser.parse(source.toString('utf-8'));
    const root = tree.rootNode;

    const namespace = deriveNamespace(relativePath);
    const imports = extractImports(root, source);
    const entities = processDeclarations(root, source, namespace, relativePath);

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: this.langName,
      namespace,
      entities,
      usingDirectives: imports,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
