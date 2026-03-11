/**
 * Tests for code/walker.ts — repository file discovery.
 *
 * Uses temp directories with known file structures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkRepo } from '../../src/code/walker.js';

const TEST_DIR = join(tmpdir(), `myelin-walker-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createFile(relPath: string, content = ''): void {
  const fullPath = join(TEST_DIR, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

// ---------------------------------------------------------------------------
// walkRepo (non-git mode — uses fs walk)
// ---------------------------------------------------------------------------

describe('walkRepo', () => {
  it('discovers TypeScript files', () => {
    createFile('src/index.ts');
    createFile('src/utils.ts');
    const files = walkRepo(TEST_DIR);
    const tsFiles = files.filter(f => f.language === 'typescript');
    expect(tsFiles).toHaveLength(2);
  });

  it('discovers Python files', () => {
    createFile('main.py');
    const files = walkRepo(TEST_DIR);
    expect(files.some(f => f.language === 'python')).toBe(true);
  });

  it('discovers Go files', () => {
    createFile('main.go');
    const files = walkRepo(TEST_DIR);
    expect(files.some(f => f.language === 'go')).toBe(true);
  });

  it('discovers C# files', () => {
    createFile('Program.cs');
    const files = walkRepo(TEST_DIR);
    expect(files.some(f => f.language === 'csharp')).toBe(true);
  });

  it('discovers Dockerfiles', () => {
    createFile('Dockerfile');
    const files = walkRepo(TEST_DIR);
    expect(files.some(f => f.language === 'dockerfile')).toBe(true);
  });

  it('discovers YAML files', () => {
    createFile('config.yaml');
    createFile('other.yml');
    const files = walkRepo(TEST_DIR);
    const yamlFiles = files.filter(f => f.language === 'yaml');
    expect(yamlFiles).toHaveLength(2);
  });

  it('discovers JSON files', () => {
    createFile('package.json');
    const files = walkRepo(TEST_DIR);
    expect(files.some(f => f.language === 'json')).toBe(true);
  });

  it('ignores unsupported extensions', () => {
    createFile('readme.md');
    createFile('image.png');
    createFile('data.csv');
    const files = walkRepo(TEST_DIR);
    expect(files).toHaveLength(0);
  });

  it('excludes node_modules by default', () => {
    createFile('node_modules/dep/index.js');
    createFile('src/index.ts');
    const files = walkRepo(TEST_DIR);
    expect(files.every(f => !f.filePath.includes('node_modules'))).toBe(true);
  });

  it('excludes dist by default', () => {
    createFile('dist/index.js');
    createFile('src/index.ts');
    const files = walkRepo(TEST_DIR);
    expect(files.every(f => !f.filePath.includes('dist/'))).toBe(true);
  });

  it('returns relative paths', () => {
    createFile('src/deep/nested/file.ts');
    const files = walkRepo(TEST_DIR);
    expect(files[0].filePath).toMatch(/^src/);
    expect(files[0].filePath).not.toContain(TEST_DIR);
  });

  it('handles empty directory', () => {
    const files = walkRepo(TEST_DIR);
    expect(files).toHaveLength(0);
  });

  it('maps file extensions to correct languages', () => {
    createFile('a.ts');
    createFile('b.tsx');
    createFile('c.js');
    createFile('d.jsx');
    createFile('e.ps1');
    const files = walkRepo(TEST_DIR);
    expect(files.find(f => f.filePath.includes('a.ts'))?.language).toBe('typescript');
    expect(files.find(f => f.filePath.includes('b.tsx'))?.language).toBe('typescript');
    expect(files.find(f => f.filePath.includes('c.js'))?.language).toBe('javascript');
    expect(files.find(f => f.filePath.includes('d.jsx'))?.language).toBe('javascript');
    expect(files.find(f => f.filePath.includes('e.ps1'))?.language).toBe('powershell');
  });
});
