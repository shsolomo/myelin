/**
 * Shared WASM tree-sitter initialization.
 *
 * web-tree-sitter requires Parser.init() to be called once before use.
 * This module provides a singleton initializer and a language cache to
 * avoid re-loading .wasm files across parser instances.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// web-tree-sitter ships as CJS — use createRequire to load it in ESM
const require = createRequire(import.meta.url);
const TreeSitterModule = require('web-tree-sitter');
const TreeSitterParser = TreeSitterModule.Parser;
const TreeSitterLanguage = TreeSitterModule.Language;

// Re-export types for convenience
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Parser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyntaxNode = any;

let initPromise: Promise<void> | null = null;

/**
 * Initialize the web-tree-sitter runtime (singleton — safe to call multiple times).
 */
export async function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = TreeSitterParser.init();
  }
  await initPromise;
}

const languageCache = new Map<string, unknown>();

/**
 * Load a language grammar WASM file (cached after first load).
 *
 * @param wasmFileName - Filename in @vscode/tree-sitter-wasm/wasm/, e.g. "tree-sitter-typescript.wasm"
 * @returns The loaded Language object
 */
export async function loadLanguage(wasmFileName: string): Promise<unknown> {
  const cached = languageCache.get(wasmFileName);
  if (cached) return cached;

  await initParser();

  // Resolve the .wasm file from @vscode/tree-sitter-wasm package
  const wasmPath = require.resolve(`@vscode/tree-sitter-wasm/wasm/${wasmFileName}`);

  // Load the raw bytes and pass to Language.load for Node.js compatibility
  const wasmBytes = readFileSync(wasmPath);
  const language = await TreeSitterLanguage.load(wasmBytes);
  languageCache.set(wasmFileName, language);
  return language;
}

/**
 * Create a new Parser instance with the given language set.
 */
export async function createParser(wasmFileName: string): Promise<Parser> {
  await initParser();
  const language = await loadLanguage(wasmFileName);
  const parser = new TreeSitterParser();
  parser.setLanguage(language);
  return parser;
}
