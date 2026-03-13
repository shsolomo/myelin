/**
 * Postinstall script — patches tree-sitter binding.gyp for Node.js 24+.
 *
 * Node 24's V8 headers require C++20, but tree-sitter@0.25.0 hardcodes
 * /std:c++17. This script patches binding.gyp to use c++20 when running
 * on Node >= 24. See: https://github.com/shsolomo/myelin/issues/7
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);

if (nodeMajor < 24) {
  // No patch needed for Node < 24
  process.exit(0);
}

const bindingGyp = join(__dirname, '..', 'node_modules', 'tree-sitter', 'binding.gyp');

if (!existsSync(bindingGyp)) {
  // tree-sitter not installed yet (might be called during initial install before deps)
  process.exit(0);
}

const original = readFileSync(bindingGyp, 'utf8');

if (!original.includes('c++17')) {
  // Already patched or using a newer version
  process.exit(0);
}

const patched = original.replace(/c\+\+17/g, 'c++20');
writeFileSync(bindingGyp, patched, 'utf8');

const count = (original.match(/c\+\+17/g) || []).length;
console.log(`postinstall: patched tree-sitter binding.gyp (${count} occurrences of c++17 → c++20 for Node ${nodeMajor})`);
