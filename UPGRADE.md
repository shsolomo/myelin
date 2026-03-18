# Upgrading Myelin

How to upgrade between versions and what changed. Agents: use this doc to guide users through upgrades.

## Where is Myelin Installed?

Before upgrading, know which scope you're updating:

| Scope | Location | How to check |
|-------|----------|-------------|
| **User-level** | `~/.copilot/extensions/myelin/` | `ls ~/.copilot/extensions/myelin/extension.mjs` |
| **Project-level** | `.github/extensions/myelin/` | `ls .github/extensions/myelin/extension.mjs` |

If you have both, the user-level install takes precedence. For multi-agent setups, upgrade the user-level install — that's what all your agents use.

## How to Upgrade

### npm global install (most users)

```bash
myelin update
```

This single command:
1. Pulls the latest version from GitHub
2. Rebuilds the Copilot CLI extension

Restart Copilot CLI (or `/clear`) after upgrading.

### Package install

Tell your agent:
```
> check for updates from shsolomo/myelin
```

The packages skill compares your installed version against the latest and offers to upgrade. This updates the project-level install. If you use a user-level install, also copy the updated extension:

```bash
cp .github/extensions/myelin/* ~/.copilot/extensions/myelin/
cd ~/.copilot/extensions/myelin && npm install --omit=dev
```

### Clone + link install

```bash
cd /path/to/myelin
git pull origin main
npm install --legacy-peer-deps
npm run build
myelin setup-extension
```

### Verify after upgrade

```bash
myelin --version    # confirm new version
myelin doctor       # check everything is healthy
```

---

## Version History

### v0.10.2 — Distribution & Multi-Agent Install

**Upgrade action:**
- **npm global users:** `myelin update`
- **Package install users:** Update your packages skill first, then update myelin:
  ```bash
  # Update the packages skill (one-time, needed for new sourcePath support)
  gh api repos/shsolomo/myelin/contents/.github/skills/packages/packages.cjs --jq '.content' | base64 -d > .github/skills/packages/packages.cjs
  gh api repos/shsolomo/myelin/contents/.github/skills/packages/SKILL.md --jq '.content' | base64 -d > .github/skills/packages/SKILL.md
  # Then tell your agent: "check for updates from shsolomo/myelin"
  ```

**What changed:**

- **Distribution path moved** — Extension distribution artifacts moved from `.github/extensions/myelin/` to `.github/package/myelin/` to prevent the Copilot CLI from auto-loading a duplicate extension when developing in the myelin repo.
- **`sourcePath` support in packages skill** — Registry entries now support a `sourcePath` field that tells the packages skill where to find files in the source repo when it differs from the install destination. Backward compatible — if omitted, `path` is used for both (existing behavior).
- **User-level install guidance** — INSTALL.md and UPGRADE.md now recommend installing at `~/.copilot/extensions/myelin/` for multi-agent environments so all agents share one graph.
- **`npm run deploy` workflow** — New dev command: `tsc → bundle → deploy to ~/.copilot/extensions/myelin/`. Separated from the shared `bundle-extension.mjs` so dev-only logic doesn't ship to consumers.

**Breaking changes:**
- Package install users must update their local `packages.cjs` before upgrading (see above). The old skill will fail to find files at the new distribution path. New installs are unaffected.

---

### v0.10.0 — Resumable Parallel Sleep

**Upgrade action:** Run `myelin update` (or `git pull && npm install --legacy-peer-deps && npm run build && myelin setup-extension`).

**What changed:**

- **`myelin sleep` is now the single memory command** (#65) — Parallel subprocess-based LLM extraction + REM maintenance in one command. Spawns `copilot -p` subprocesses to extract entities and relationships from agent logs. Supports `--agent`, `--all`, `--parallel N`, and `--status` flags.
- **Watermark-based resumable sleep** (#65) — Tracks `last_consolidated_ts` per agent in the graph. If a session dies mid-batch, the next run picks up where it left off. No re-processing.
- **Archive .md log support** (#65) — Reads both `log.jsonl` and `log.md` files, merges and deduplicates entries.
- **Regex extraction removed** — Single extraction path: LLM via `myelin_sleep` extension tool or `myelin sleep` CLI.
- **Extension tool renamed** — `myelin_consolidate` → `myelin_sleep` with the same three modes: `prepare`, `ingest`, `complete`.
- **Extraction quality improvements** — Stricter person typing (humans only), specific relationship type guidance, ID normalization for consistent dedup, orphan knowledge node pruning in REM.
- **Install & Upgrade UAT workflows** — CI tests fresh installs and upgrade paths across 3 OS × 2 Node versions.

**Breaking changes:**
- `myelin consolidate` renamed to `myelin sleep` (old name kept as hidden alias)
- `myelin_consolidate` extension tool renamed to `myelin_sleep`
- `myelin sleep` requires `copilot` CLI to be installed (used as the LLM subprocess)

---

### v0.9.0 — Zero ML Dependencies

**Upgrade action:** Run `myelin update` (or `git pull && npm install --legacy-peer-deps && npm run build && myelin setup-extension`).

**What changed:**

- **ONNX runtime fully removed** (#62) — `onnxruntime-node` is no longer a dependency (not even optional). GLiNER NER model, local embedding inference, and the custom tokenizer module are all removed. Code preserved on `archive/onnx-local-inference` branch.
- **LLM-driven consolidation** (#59) — New `myelin_consolidate` extension tool with three modes: `prepare` (read logs), `ingest` (write LLM extraction results to graph), `complete` (REM decay/prune). The host LLM is now the extraction engine.
- **Version string fixed** — `myelin --version` now reads from `package.json` dynamically instead of showing a hardcoded value.
- **Embed skip message** — `myelin embed` now prints a clear message when no embedding model is available, confirming FTS5 is active.

**Breaking changes:**
- `onnxruntime-node` is gone entirely — no `--with-models` flag, no local NER, no local embeddings
- Users who had local models installed will need to rely on FTS5 search and LLM consolidation
- Future: optional local ONNX inference and configurable embedding APIs planned for Phase 4 (#63)

**Consolidation migration:**
- NREM cron jobs should be updated from command type (running `myelin consolidate`) to prompt type (invoking the agent with the `myelin_consolidate` tool). The CLI `myelin sleep` command still works but uses basic regex extraction as a fallback.
- The `nightly-embed` cron job can be disabled — local embeddings have been removed.
- REM cron jobs (`rem-global`) continue to work unchanged — they're pure graph operations.

---

### v0.8.0 — LLM-First Architecture

**Upgrade action:** Run `myelin update` (or `git pull && npm install --legacy-peer-deps && npm run build && myelin setup-extension`).

**What changed:**

- **@huggingface/transformers removed** (#55) — Replaced with a custom pure-TypeScript tokenizer (WordPiece + Unigram) and direct onnxruntime-node inference. Eliminates the onnxruntime-web/sharp dependency chain that caused Windows install failures.
- **FTS5 keyword search is now primary** (#58) — `myelin_query` uses FTS5 first, with semantic vector search as an optional boost when embeddings are available. The graph works fully without embeddings.
- **onnxruntime-node is now optional** (#61) — Moved to `optionalDependencies`. Install no longer requires a C++ toolchain for ONNX. Model downloads are opt-in via `myelin setup-extension --with-models`.
- **GLiNER model ID fixed** — Corrected HuggingFace model ID from `shsolomo` to `shsolo`.
- **Cron auto-registration removed** (#54) — Extension no longer auto-creates NREM/REM cron jobs on session start. Cron setup is managed externally.
- **CI automation** (#57) — GitHub Actions pipeline with cross-platform testing (Linux, Windows, macOS × Node 20, 22). Genesis package integration for distribution.

**Breaking changes:**
- `myelin setup-extension` no longer downloads models by default. Use `--with-models` to download GLiNER and embedding models.
- Users who relied on automatic semantic search will need to explicitly download models or accept FTS5 keyword search.

**Install size reduced:** Default install no longer requires ~700MB of model downloads.

---

### v0.7.3 — Drop @huggingface/transformers

**Upgrade action:** Run `myelin update` (or `git pull && npm run build && myelin setup-extension`). The embedding model will re-download to a new cache location (`~/.cache/myelin/models/embeddings/`) on first use.

**What changed:**

- **Removed `@huggingface/transformers` dependency** — This package dragged in `onnxruntime-web` which caused Windows install failures (symlinks, WebGPU directory structures breaking tar extraction). Myelin now uses `onnxruntime-node` directly for both NER and embedding inference.
- **Custom tokenizer module** — Pure TypeScript implementation of WordPiece (for embeddings) and Unigram (for NER) tokenization. Reads the standard HuggingFace `tokenizer.json` format. No external tokenizer dependencies.
- **Embedding model auto-downloads** — The all-MiniLM-L6-v2 ONNX model now downloads from HuggingFace on first use, cached at `~/.cache/myelin/models/embeddings/`. Same pattern as GLiNER model download.
- **Removed `overrides` workaround** — The `onnxruntime-web → onnxruntime-node` override in `package.json` is no longer needed and has been removed.
- **Simpler extension package** — The extension's `package.json` no longer needs `@huggingface/transformers` or the `overrides` section.

**Breaking changes:**
- Embedding model cache location changed from `~/.cache/huggingface/` to `~/.cache/myelin/models/embeddings/` (auto-downloaded, no manual action needed)

---

### v0.7.0 — Model Auto-Download & Cleanup

**Upgrade action:** Run `myelin update` (or `git pull && npm run build && myelin setup-extension`). Re-running `setup-extension` downloads the new models automatically (~660MB one-time).

**What changed:**

- **GLiNER auto-downloads from HuggingFace** — The NER model now downloads automatically during `setup-extension` and on first use. No more Python export or manual file copying. Model hosted at [shsolo/gliner-small-v2.1-onnx](https://huggingface.co/shsolo/gliner-small-v2.1-onnx).
- **Embedding model downloads during setup** — The all-MiniLM-L6-v2 embedding model also downloads eagerly during `setup-extension` instead of on first use.
- **`myelin viz` removed** — The interactive D3.js visualization command has been removed. If you have scripts referencing `myelin viz`, remove them.
- **Extension bugs fixed** — Version string, `getMindRoot()`, and cron job paths corrected for global installs.
- **Pinned nodes** — Nodes can be pinned (`myelin pin <name>`) to prevent decay and ensure they always load at boot.
- **NREM/REM cron jobs auto-created** — Consolidation cron jobs are registered automatically on session start.
- **Extension UAT test suite** — 54 new tests covering bundle validation, tool handlers, and lifecycle hooks.
- **NORTH-STAR.md** — Guiding principles document added to the repo.

**Breaking changes:**
- `myelin viz` no longer exists
- GLiNER model location changed from `<repo>/models/gliner/` to `~/.cache/myelin/models/gliner/` (auto-downloaded, no manual action needed)

---

### v0.6.0 — Onboarding & Resilience

**Upgrade action:** Run `myelin update`.

**What changed:**

- **`myelin sleep`** — Single command for full maintenance (consolidation + embedding for all agents)
- **`myelin doctor`** — Health check with color-coded diagnostics and actionable suggestions
- **Auto-boot** — Extension auto-detects agent name and injects graph context on session start (no manual `myelin_boot` needed)
- **`setup-extension` auto-inits** — Automatically creates the graph database if it doesn't exist
- **Consolidation resilience** — File locking, pre-NREM backups with 7-day rotation, integrity checks, quarantine for corrupted entries
- **Parse error reporting** — `myelin parse` reports per-file errors and cleans stale nodes from renamed/deleted files
- **INSTALL.md rewrite** — Tiered onboarding (Tier 1: 5 min, Tier 2: 10 min, Tier 3: optional)

**Breaking changes:** None.

---

### v0.5.0 — Classification & Traversal

**Upgrade action:** Run `myelin update`.

**What changed:**

- **Sensitivity classification** — Nodes have sensitivity levels (0–3) controlling visibility during queries and context injection
- **Sensitivity ceilings on hooks** — Extension hooks filter results by sensitivity to avoid injecting sensitive content
- **`myelin classify`** — CLI command to set sensitivity levels on nodes
- **FTS5 fallback** — Keyword search fallback when semantic search yields no results
- **PRUNE/SKIP traversal modes** — `querySubgraph` supports pruning or skipping nodes by criteria
- **Heartbeat migration** — Import GENESIS heartbeat memory.md files into the graph
- **Auto-classification heuristics** — NREM consolidation auto-assigns sensitivity based on content signals

**Breaking changes:** None.

---

### v0.4.0 — NER API & Extension

**Upgrade action:** Run `myelin update`.

**What changed:**

- **NER extraction API server** — `myelin serve` starts an HTTP API for real-time entity extraction
- **Agent self-identification** — Extension detects which agent is running via tool call patterns
- **Apache-2.0 license** — Changed from MIT to Apache-2.0
- **Comprehensive test suite** — 274 tests across 12 files
- **Central extension integration** — Copilot CLI extension became the primary agent interface

**Breaking changes:**
- License changed from MIT to Apache-2.0

---

### v0.3.1 — Initial Public Release

First tagged release. Core graph, NER, embeddings, consolidation, and CLI in place.

---

## Compatibility Notes

### Graph database
The graph database (`~/.copilot/.working-memory/graph.db`) is forward-compatible — new versions add tables/columns without breaking existing data. No migration steps needed.

### Agent logs
Logs are append-only and never deleted. If the graph is corrupted, it can always be rebuilt from logs:
```bash
rm ~/.copilot/.working-memory/graph.db
myelin init
myelin parse ./your-repo --namespace repo:my-project
myelin sleep
```

### Node.js version
Myelin requires Node.js >= 20. Version 22+ is recommended. Native addons (better-sqlite3, tree-sitter) recompile during install for your Node version. If you upgrade Node, re-run `myelin setup-extension` to recompile.
