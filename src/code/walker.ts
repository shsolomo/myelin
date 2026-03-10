/**
 * File walker -- discovers source files in a git repository.
 * Ported from cortex/code/walker.py
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const EXTENSION_MAP: Record<string, string> = {
  '.cs': 'csharp',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.bicep': 'bicep',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
};

const DOCKERFILE_NAMES = new Set(['Dockerfile', 'dockerfile']);
const DOCKERFILE_SUFFIXES = ['.dockerfile'];

const DEFAULT_EXCLUDES: string[] = [
  '(^|/)obj/',
  '(^|/)bin/',
  '(^|/)\\.vs/',
  '\\.Designer\\.cs$',
  'AssemblyInfo\\.cs$',
  '\\.g\\.cs$',
  '(^|/)node_modules/',
  '(^|/)__pycache__/',
  '\\.pyc$',
  '\\.min\\.js$',
  '\\.min\\.css$',
  '(^|/)package-lock\\.json$',
  '(^|/)yarn\\.lock$',
  '(^|/)\\.terraform/',
  '(^|/)\\.git/',
  '(^|/)vendor/',
  '(^|/)dist/',
  '(^|/)\\.vscode/',
];

function isGitRepo(repoRoot: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function walkFs(dir: string, rootDir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkFs(fullPath, rootDir));
    } else {
      const rel = fullPath
        .slice(rootDir.length)
        .replace(/\\/g, '/');
      results.push(rel.startsWith('/') ? rel.slice(1) : rel);
    }
  }
  return results;
}

export function walkRepo(
  repoRoot: string,
  extensions?: Set<string>,
  excludePatterns?: string[],
): Array<{ filePath: string; language: string }> {
  const exts = extensions ?? new Set(Object.keys(EXTENSION_MAP));
  const patterns = excludePatterns ?? DEFAULT_EXCLUDES;
  const compiledExcludes = patterns.map((p) => new RegExp(p));

  let relPaths: string[];

  if (isGitRepo(repoRoot)) {
    const output = execSync('git ls-files', {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    relPaths = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/\\/g, '/'));
  } else {
    relPaths = walkFs(repoRoot, repoRoot);
  }

  const files: Array<{ filePath: string; language: string }> = [];

  for (const relPath of relPaths) {
    if (compiledExcludes.some((pat) => pat.test(relPath))) {
      continue;
    }

    const base = relPath.includes('/') ? relPath.split('/').pop()! : relPath;
    const ext = extname(base).toLowerCase();

    // Check Dockerfile by name or suffix
    if (
      DOCKERFILE_NAMES.has(base) ||
      DOCKERFILE_SUFFIXES.some((s) => base.toLowerCase().endsWith(s))
    ) {
      files.push({ filePath: relPath, language: 'dockerfile' });
      continue;
    }

    if (!exts.has(ext)) {
      continue;
    }

    const language = EXTENSION_MAP[ext];
    if (language) {
      files.push({ filePath: relPath, language });
    }
  }

  return files;
}
