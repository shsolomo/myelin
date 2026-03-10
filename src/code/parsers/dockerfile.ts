/**
 * Dockerfile parser — regex-based (no tree-sitter grammar).
 * Ported from cortex/code/parsers/dockerfile.py
 */

import type { ParsedEdge, ParsedEntity, ParsedFile } from '../models.js';
import { makeEntity, makeEdge, makeParsedFile } from '../models.js';
import { BaseParser } from './base.js';

const FROM_RE = /^FROM\s+(?:--platform=[^\s]+\s+)?(?<image>[^\s]+?)(?:\s+AS\s+(?<stage>[^\s]+))?$/i;
const COPY_FROM_RE = /^COPY\s+--from=(?<stage>[^\s]+)/i;
const EXPOSE_RE = /^EXPOSE\s+(?<ports>.+)$/i;
const CMD_RE = /^CMD\s+(?<cmd>.+)$/i;
const ENTRYPOINT_RE = /^ENTRYPOINT\s+(?<ep>.+)$/i;

function parseDockerfile(source: Buffer, relativePath: string): ParsedEntity[] {
  let text: string;
  try {
    text = source.toString('utf-8');
  } catch {
    return [];
  }

  const entities: ParsedEntity[] = [];
  const namespace = relativePath.replace(/\\/g, '/');
  let stageCount = 0;

  const lines = text.split('\n');
  // Join continuation lines (ending with \)
  const joined: Array<[number, string]> = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    const startLine = i + 1;
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + ' ' + lines[i + 1].trim();
      i++;
    }
    joined.push([startLine, line]);
    i++;
  }

  for (const [lineno, instruction] of joined) {
    const stripped = instruction.trim();
    if (!stripped || stripped.startsWith('#')) continue;

    let m = FROM_RE.exec(stripped);
    if (m) {
      const image = m.groups!.image;
      const stageName = m.groups!.stage;

      if (stageName) {
        entities.push(makeEntity({
          entityType: 'stage',
          name: stageName,
          fullyQualifiedName: `${namespace}/stage/${stageName}`,
          filePath: relativePath,
          lineStart: lineno,
          lineEnd: lineno,
          baseTypes: [image],
        }));
      } else {
        const label = stageCount > 0 ? `stage${stageCount}` : 'base';
        entities.push(makeEntity({
          entityType: stageCount > 0 ? 'stage' : 'image',
          name: label,
          fullyQualifiedName: `${namespace}/stage/${label}`,
          filePath: relativePath,
          lineStart: lineno,
          lineEnd: lineno,
          baseTypes: [image],
        }));
      }
      stageCount++;
      continue;
    }

    m = COPY_FROM_RE.exec(stripped);
    if (m) {
      const refStage = m.groups!.stage;
      if (entities.length > 0) {
        const last = entities[entities.length - 1];
        const mod = `copy_from:${refStage}`;
        if (!last.modifiers.includes(mod)) {
          last.modifiers.push(mod);
        }
      }
      continue;
    }

    m = EXPOSE_RE.exec(stripped);
    if (m) {
      if (entities.length > 0) {
        entities[entities.length - 1].modifiers.push(`expose:${m.groups!.ports.trim()}`);
      }
      continue;
    }

    m = CMD_RE.exec(stripped);
    if (m) {
      if (entities.length > 0) {
        entities[entities.length - 1].modifiers.push(`cmd:${m.groups!.cmd.trim()}`);
      }
      continue;
    }

    m = ENTRYPOINT_RE.exec(stripped);
    if (m) {
      if (entities.length > 0) {
        entities[entities.length - 1].modifiers.push(`entrypoint:${m.groups!.ep.trim()}`);
      }
      continue;
    }
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

    // Each stage depends on its base image
    for (const base of entity.baseTypes) {
      edges.push(makeEdge({
        sourceName: eid,
        targetName: base,
        relationship: 'depends_on',
        sourceFile: fp,
      }));
    }

    // COPY --from=stage creates depends_on edges between stages
    for (const mod of entity.modifiers) {
      if (mod.startsWith('copy_from:')) {
        const ref = mod.slice('copy_from:'.length);
        const refFqn = `${fp.replace(/\\/g, '/')}/stage/${ref}`;
        edges.push(makeEdge({
          sourceName: eid,
          targetName: `code:${fp}:stage:${refFqn}`,
          relationship: 'depends_on',
          sourceFile: fp,
          targetFile: fp,
        }));
      }
    }
  }

  return edges;
}

export class DockerfileParser extends BaseParser {
  parseFile(filePath: string, source: Buffer, relativePath: string): ParsedFile {
    const namespace = relativePath.replace(/\\/g, '/');
    const entities = parseDockerfile(source, relativePath);

    const parsed = makeParsedFile({
      filePath: relativePath,
      language: 'dockerfile',
      namespace,
      entities,
    });
    parsed.edges = buildEdges(parsed);
    return parsed;
  }
}
