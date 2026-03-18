/**
 * Copy the bundled extension to the user-level Copilot extensions directory.
 * This is a dev-only convenience — not part of the build or distribution pipeline.
 * Skips silently if the directory doesn't exist.
 */

import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = join(__dirname, "..", "dist", "extension", "extension.mjs");
const target = join(homedir(), ".copilot", "extensions", "myelin", "extension.mjs");

if (!existsSync(dirname(target))) {
  console.log("ℹ️  User extension dir not found — skipping local deploy");
  process.exit(0);
}

copyFileSync(source, target);
console.log(`✅ Extension deployed to ${target} (restart CLI to pick up)`);
