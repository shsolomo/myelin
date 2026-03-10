/**
 * YAML parser — regex-based fallback.
 *
 * tree-sitter-yaml 0.5.x uses legacy NAN bindings incompatible with
 * tree-sitter >= 0.25.  This parser extracts top-level mapping keys
 * and pipeline entities using simple line parsing, matching the same
 * entity output as the tree-sitter version in cortex.
 * Ported from cortex/code/parsers/yaml_parser.py
 */

import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

// Matches a top-level YAML key (no leading whitespace, followed by ":")
const TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)?$/;
// Matches an indented key (for pipeline items)
const INDENTED_KEY_RE = /^(\s+)-?\s*([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)?$/;

function isPipelineFile(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/').toLowerCase();
  return (
    norm.includes('.pipelines/') ||
    norm.includes('azure-pipeline') ||
    (norm.includes('pipeline') && (norm.endsWith('.yml') || norm.endsWith('.yaml')))
  );
}

interface TopPair {
  key: string;
  lineStart: number;
}

function extractTopLevelKeys(text: string): TopPair[] {
  const pairs: TopPair[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#') || !line.trim()) continue;
    const m = TOP_KEY_RE.exec(line);
    if (m) {
      pairs.push({ key: m[1], lineStart: i + 1 });
    }
  }
  return pairs;
}

function extractPipelineEntities(
  text: string,
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const pipelineKeys = new Set(['stages', 'jobs', 'steps']);
  const itemKeywords = new Set(['stage', 'job', 'name', 'task', 'script', 'bash', 'powershell', 'displayName']);
  const lines = text.split('\n');

  let currentSection = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topMatch = TOP_KEY_RE.exec(line);
    if (topMatch) {
      currentSection = topMatch[1];
      continue;
    }
    if (!pipelineKeys.has(currentSection)) continue;

    const indentMatch = INDENTED_KEY_RE.exec(line);
    if (indentMatch) {
      const itemKey = indentMatch[2];
      const itemValue = (indentMatch[3] ?? '').trim();
      if (itemKeywords.has(itemKey) && itemValue) {
        const entityType = currentSection.replace(/s$/, '');
        entities.push(makeEntity({
          entityType,
          name: itemValue,
          fullyQualifiedName: `${namespace}/${currentSection}/${itemValue}`,
          filePath,
          lineStart: i + 1,
          lineEnd: i + 1,
        }));
      }
    }
  }
  return entities;
}

function extractGenericEntities(
  topPairs: TopPair[],
  filePath: string,
  namespace: string,
): ParsedEntity[] {
  return topPairs.map((p) =>
    makeEntity({
      entityType: 'config',
      name: p.key,
      fullyQualifiedName: `${namespace}/${p.key}`,
      filePath,
      lineStart: p.lineStart,
      lineEnd: p.lineStart,
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

export class YamlParser extends BaseParser {
  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const text = source.toString('utf-8');
    const namespace = relativePath.replace(/\\/g, '/');
    const topPairs = extractTopLevelKeys(text);

    let entities: ParsedEntity[];
    if (isPipelineFile(relativePath)) {
      entities = extractPipelineEntities(text, relativePath, namespace);
      if (entities.length === 0) {
        entities = extractGenericEntities(topPairs, relativePath, namespace);
      }
    } else {
      entities = extractGenericEntities(topPairs, relativePath, namespace);
    }

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'yaml',
      namespace,
      entities,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
