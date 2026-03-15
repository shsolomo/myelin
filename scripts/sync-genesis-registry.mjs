#!/usr/bin/env node
// sync-genesis-registry.mjs — sync version from package.json to .github/registry.json

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const pkgPath = join(root, "package.json");
const registryPath = join(root, ".github", "registry.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const registry = JSON.parse(readFileSync(registryPath, "utf-8"));

const version = pkg.version;
let changed = false;

if (registry.version !== version) {
  console.log(`registry.version: ${registry.version} → ${version}`);
  registry.version = version;
  changed = true;
}

if (registry.extensions?.myelin?.version !== version) {
  console.log(`extensions.myelin.version: ${registry.extensions?.myelin?.version} → ${version}`);
  registry.extensions.myelin.version = version;
  changed = true;
}

if (changed) {
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  console.log("registry.json updated.");
} else {
  console.log("already in sync");
}

process.exit(0);
