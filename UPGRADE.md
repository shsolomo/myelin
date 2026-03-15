# Upgrading Myelin

How to upgrade between versions and what changed. Agents: use this doc to guide users through upgrades.

## How to Upgrade

### npm global install (most users)

```bash
myelin update
```

This single command:
1. Pulls the latest version from GitHub
2. Rebuilds the Copilot CLI extension
3. Downloads any new models (if applicable)

Restart Copilot CLI (or `/clear`) after upgrading.

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
myelin parse ./your-repo --namespace repo:my-project --embed
myelin sleep
```

### Node.js version
Myelin requires Node.js >= 20. Version 22+ is recommended. Native addons (better-sqlite3, tree-sitter) recompile during install for your Node version. If you upgrade Node, re-run `myelin setup-extension` to recompile.
