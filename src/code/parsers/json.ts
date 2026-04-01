/**
 * JSON parser — uses JSON.parse() instead of tree-sitter.
 *
 * Extracts top-level keys, Grafana dashboard entities, and ARM template
 * resources using native JSON parsing. No native compilation required.
 * Ported from cortex/code/parsers/json_parser.py
 */

import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

/**
 * Find the 1-based line number where a key first appears in the JSON source.
 * Falls back to 1 if not found.
 */
function findKeyLine(text: string, key: string): number {
  // Search for "key": pattern
  const pattern = `"${key}"`;
  const idx = text.indexOf(pattern);
  if (idx === -1) return 1;
  // Count newlines before this index
  let lineNum = 1;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '\n') lineNum++;
  }
  return lineNum;
}

function isGrafana(obj: Record<string, unknown>): boolean {
  return 'panels' in obj || 'dashboard' in obj || 'annotations' in obj;
}

function isArmTemplate(obj: Record<string, unknown>): boolean {
  const schema = obj['$schema'];
  if (typeof schema !== 'string') return false;
  return schema.includes('deploymentTemplate') || schema.includes('subscriptionDeploymentTemplate');
}

function extractGrafanaEntities(
  obj: Record<string, unknown>,
  text: string,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  // Extract panels
  const panels = obj['panels'];
  if (Array.isArray(panels)) {
    for (const panel of panels) {
      if (panel && typeof panel === 'object' && 'title' in panel) {
        const title = String((panel as Record<string, unknown>)['title']);
        entities.push(makeEntity({
          entityType: 'panel',
          name: title,
          fullyQualifiedName: `${namespace}/panel/${title}`,
          filePath,
          lineStart: findKeyLine(text, 'title'),
          lineEnd: findKeyLine(text, 'title'),
        }));
      }
    }
  }

  // Extract dashboard title
  if ('title' in obj && typeof obj['title'] === 'string') {
    entities.push(makeEntity({
      entityType: 'config',
      name: obj['title'],
      fullyQualifiedName: `${namespace}/dashboard/${obj['title']}`,
      filePath,
      lineStart: 1,
      lineEnd: 1,
    }));
  }

  return entities;
}

function extractArmEntities(
  obj: Record<string, unknown>,
  text: string,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const resources = obj['resources'];
  if (!Array.isArray(resources)) return entities;

  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') continue;
    const r = resource as Record<string, unknown>;
    const resourceType = typeof r['type'] === 'string' ? r['type'] : '';
    const resourceName = typeof r['name'] === 'string' ? r['name'] : '';
    if (resourceType || resourceName) {
      const label = resourceType || resourceName;
      entities.push(makeEntity({
        entityType: 'resource',
        name: label,
        fullyQualifiedName: `${namespace}/resource/${label}`,
        filePath,
        lineStart: findKeyLine(text, resourceType || resourceName),
        lineEnd: findKeyLine(text, resourceType || resourceName),
      }));
    }
  }

  return entities;
}

function extractGenericEntities(
  obj: Record<string, unknown>,
  text: string,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  return Object.keys(obj).map((key) =>
    makeEntity({
      entityType: 'config',
      name: key,
      fullyQualifiedName: `${namespace}/${key}`,
      filePath,
      lineStart: findKeyLine(text, key),
      lineEnd: findKeyLine(text, key),
    }),
  );
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
  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const text = source.toString('utf-8');
    const namespace = relativePath.replace(/\\/g, '/');

    let obj: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — return empty parse result
    }

    let entities: ParsedEntity[] = [];
    if (obj) {
      if (isArmTemplate(obj)) {
        entities = extractArmEntities(obj, text, relativePath, namespace);
        if (entities.length === 0) {
          entities = extractGenericEntities(obj, text, relativePath, namespace);
        }
      } else if (isGrafana(obj)) {
        entities = extractGrafanaEntities(obj, text, relativePath, namespace);
        if (entities.length === 0) {
          entities = extractGenericEntities(obj, text, relativePath, namespace);
        }
      } else {
        entities = extractGenericEntities(obj, text, relativePath, namespace);
      }
    }

    const result = makeParsedFile({
      filePath: relativePath,
      language: 'json',
      namespace,
      entities,
    });
    result.edges = buildEdges(result);
    return result;
  }
}
