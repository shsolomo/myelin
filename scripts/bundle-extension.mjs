/**
 * Bundle the Myelin extension into a single .mjs file for Copilot CLI.
 *
 * Usage: node scripts/bundle-extension.mjs
 *
 * Native modules (better-sqlite3, sqlite-vec, etc.) are converted from
 * static imports to require() calls so they resolve from the extension's
 * node_modules directory, not the Copilot CLI process cwd.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

// Packages that need require() instead of import (native addons + Copilot SDK)
const requirePackages = [
  "better-sqlite3",
  "sqlite-vec",
  "onnxruntime-node",
  "@huggingface/transformers",
  "@github/copilot-sdk",
  "@github/copilot-sdk/extension",
];

// Plugin: rewrite external imports to require() calls
const requireExternals = {
  name: "require-externals",
  setup(build) {
    for (const pkg of requirePackages) {
      const filter = new RegExp(`^${pkg.replace("/", "\\/")}(\\/.*)?$`);
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "require-external",
      }));
    }
    build.onLoad({ filter: /.*/, namespace: "require-external" }, (args) => ({
      contents: `module.exports = globalThis.require("${args.path}");`,
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [join(root, "src/extension/extension.in-process.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(root, "dist/extension/extension.mjs"),
  plugins: [requireExternals],
  define: {
    "__MYELIN_VERSION__": JSON.stringify(pkg.version),
  },
  banner: {
    js: `
import { createRequire as __createRequire } from "node:module";
if (!globalThis.require) { globalThis.require = __createRequire(import.meta.url); }
`.trim(),
  },
  target: "node20",
  sourcemap: false,
  minify: false,
});

console.log("✅ Extension bundled to dist/extension/extension.mjs");
