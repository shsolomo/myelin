/**
 * JSON parser using tree-sitter.
 * Ported from cortex/code/parsers/json_parser.py
 */

import Parser from 'tree-sitter';
import Json from 'tree-sitter-json';
import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

function getParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(Json as unknown as Parser.Language);
  return parser;
}

function nodeText(node: Parser.SyntaxNode, source: Buffer): string {
  return source.subarray(node.startIndex, node.endIndex).toString('utf-8');
}

function findChild(node: Parser.SyntaxNode, typeName: string): Parser.SyntaxNode | null {
  return node.children.find((c) => c.type === typeName) ?? null;
}

function stringValue(node: Parser.SyntaxNode, source: Buffer): string {
  const text = nodeText(node, source);
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text.slice(1, -1);
  }
  return text;
}

function getRootObject(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of root.children) {
    if (child.type === 'object') return child;
    if (child.type === 'document') {
      const obj = findChild(child, 'object');
      if (obj) return obj;
    }
  }
  return null;
}

function getTopLevelPairs(obj: Parser.SyntaxNode, source: Buffer): Array<[string, Parser.SyntaxNode]> {
  const pairs: Array<[string, Parser.SyntaxNode]> = [];
  for (const child of obj.children) {
    if (child.type === 'pair') {
      const keyNode = child.children[0] ?? null;
      const valNode = child.children.length > 1 ? child.children[child.children.length - 1] : null;
      if (keyNode && valNode && keyNode.type === 'string') {
        pairs.push([stringValue(keyNode, source), valNode]);
      }
    }
  }
  return pairs;
}

function topLevelKeys(obj: Parser.SyntaxNode, source: Buffer): Set<string> {
  return new Set(getTopLevelPairs(obj, source).map(([k]) => k));
}

function isGrafana(keys: Set<string>): boolean {
  return keys.has('panels') || keys.has('dashboard') || keys.has('annotations');
}

function isArmTemplate(obj: Parser.SyntaxNode, source: Buffer): boolean {
  for (const [k, v] of getTopLevelPairs(obj, source)) {
    if (k === '$schema') {
      const schemaText = nodeText(v, source);
      return schemaText.includes('deploymentTemplate') || schemaText.includes('subscriptionDeploymentTemplate');
    }
  }
  return false;
}

function extractGrafanaEntities(
  obj: Parser.SyntaxNode,
  source: Buffer,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  for (const [key, valNode] of getTopLevelPairs(obj, source)) {
    if (key === 'panels' && valNode.type === 'array') {
      for (const item of valNode.children) {
        if (item.type === 'object') {
          for (const [pk, pv] of getTopLevelPairs(item, source)) {
            if (pk === 'title') {
              const title = pv.type === 'string' ? stringValue(pv, source) : nodeText(pv, source);
              entities.push(makeEntity({
                entityType: 'panel',
                name: title,
                fullyQualifiedName: `${namespace}/panel/${title}`,
                filePath,
                lineStart: item.startPosition.row + 1,
                lineEnd: item.endPosition.row + 1,
              }));
            }
          }
        }
      }
    } else if (key === 'title') {
      const title = valNode.type === 'string' ? stringValue(valNode, source) : nodeText(valNode, source);
      entities.push(makeEntity({
        entityType: 'config',
        name: title,
        fullyQualifiedName: `${namespace}/dashboard/${title}`,
        filePath,
        lineStart: obj.startPosition.row + 1,
        lineEnd: obj.endPosition.row + 1,
      }));
    }
  }
  return entities;
}

function extractArmEntities(
  obj: Parser.SyntaxNode,
  source: Buffer,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  for (const [key, valNode] of getTopLevelPairs(obj, source)) {
    if (key === 'resources' && valNode.type === 'array') {
      for (const item of valNode.children) {
        if (item.type === 'object') {
          let resourceType = '';
          let resourceName = '';
          for (const [rk, rv] of getTopLevelPairs(item, source)) {
            if (rk === 'type') resourceType = rv.type === 'string' ? stringValue(rv, source) : '';
            else if (rk === 'name') resourceName = rv.type === 'string' ? stringValue(rv, source) : '';
          }
          if (resourceType || resourceName) {
            const label = resourceType || resourceName;
            entities.push(makeEntity({
              entityType: 'resource',
              name: label,
              fullyQualifiedName: `${namespace}/resource/${label}`,
              filePath,
              lineStart: item.startPosition.row + 1,
              lineEnd: item.endPosition.row + 1,
            }));
          }
        }
      }
    }
  }
  return entities;
}

function extractGenericEntities(
  obj: Parser.SyntaxNode,
  source: Buffer,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  for (const [key, valNode] of getTopLevelPairs(obj, source)) {
    entities.push(makeEntity({
      entityType: 'config',
      name: key,
      fullyQualifiedName: `${namespace}/${key}`,
      filePath,
      lineStart: valNode.startPosition.row + 1,
      lineEnd: valNode.endPosition.row + 1,
    }));
  }
  return entities;
}

function buildEdges(parsed: ParsedFile): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const fp = parsed.filePath;
  const fileNodeId = `code:${fp}:file:${fp}`;

  for (const entity of parsed.entities) {
    const eid = `code:${fp}:${entity.entityType}:${entity.fullyQualifiedName}`;
    edges.push(makeEdge({
      sourceName: fileNodeId,
      targetName: eid,
      relationship: 'defines',
      sourceFile: fp,
      targetFile: fp,
    }));
  }

  return edges;
}

export class JsonParser extends BaseParser {
  private parser: Parser;

  constructor() {
    super();
    this.parser = getParser();
  }

  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const tree = this.parser.parse(source.toString('utf-8'));
    const root = tree.rootNode;

    const namespace = relativePath.replace(/\\/g, '/');
    const obj = getRootObject(root);

    let entities: ParsedEntity[] = [];
    if (obj) {
      const keys = topLevelKeys(obj, source);
      if (isArmTemplate(obj, source)) {
        entities = extractArmEntities(obj, source, relativePath, namespace);
        if (entities.length === 0) {
          entities = extractGenericEntities(obj, source, relativePath, namespace);
        }
      } else if (isGrafana(keys)) {
        entities = extractGrafanaEntities(obj, source, relativePath, namespace);
        if (entities.length === 0) {
          entities = extractGenericEntities(obj, source, relativePath, namespace);
        }
      } else {
        entities = extractGenericEntities(obj, source, relativePath, namespace);
      }
    }

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'json',
      namespace,
      entities,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
