/**
 * Bundle the Myelin extension into a single .mjs file for Copilot CLI.
 *
 * Usage: node scripts/bundle-extension.mjs
 *
 * Outputs to dist/extension/extension.mjs with native modules marked external.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await build({
  entryPoints: [join(root, "src/extension/extension.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(root, "dist/extension/extension.mjs"),
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "onnxruntime-node",
    "@huggingface/transformers",
    "@github/copilot-sdk",
    "@github/copilot-sdk/extension",
  ],
  banner: {
    js: `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
`.trim(),
  },
  target: "node20",
  sourcemap: false,
  minify: false,
});

console.log("✅ Extension bundled to dist/extension/extension.mjs");
