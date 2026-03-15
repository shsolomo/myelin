# Myelin

Knowledge graph memory system for AI agents. Named after the neural sheath that makes signals travel faster the more a path is used — that's what this does for agent memory.

Myelin gives AI agents persistent, searchable memory across sessions. It uses brain-inspired consolidation (NREM/REM phases) to extract knowledge from agent activity, FTS5 keyword search over a graph database that reinforces what matters and forgets what doesn't.

**Fully local. Zero API calls. Your memory stays on your machine.**

## How It Works

```
  Code Repos          Text Documents          Agent Logs
  (10 languages)      (markdown, notes,       (JSONL structured
                       meeting recaps)         events per agent)
       │                     │                      │
       ▼                     ▼                      ▼
  ┌─────────┐        ┌──────────────┐       ┌──────────────┐
  │  parse   │        │   ingest     │       │ consolidate  │
  │ (tree-   │        │ (entity     │       │ (NREM/REM    │
  │  sitter) │        │  extraction) │       │  phases)     │
  └────┬─────┘        └──────┬───────┘       └──────┬───────┘
       │                     │                      │
       └─────────────────────┼──────────────────────┘
                             ▼
                   ┌──────────────────┐
                   │  Knowledge Graph  │
                   │  SQLite + FTS5   │
                   │  + sqlite-vec    │
                   └────────┬─────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         5 Tools       4 Hooks      CLI Commands
         (query,       (auto-boot,  (parse, ingest,
          boot,         context,     sleep, query,
          log...)       auto-log)    embed...)
```

## Install

```bash
npm install -g github:shsolomo/myelin
myelin setup-extension
```

That's it. `setup-extension` initializes the graph database, bundles the Copilot CLI extension, and installs native dependencies. Restart Copilot CLI and every agent has memory.

See [INSTALL.md](INSTALL.md) for detailed setup and troubleshooting. See [UPGRADE.md](UPGRADE.md) for upgrading between versions.

## What Agents Get

After setup, every Copilot CLI agent automatically gets:

**5 tools:**

| Tool | What it does |
|------|-------------|
| `myelin_query` | Keyword + semantic search over the knowledge graph |
| `myelin_boot` | Load agent-specific context at session start |
| `myelin_log` | Log structured events (decision, finding, error, etc.) |
| `myelin_show` | Inspect a node and its connections |
| `myelin_stats` | Graph statistics and embedding coverage |

**3 lifecycle hooks** (automatic, no agent action needed):

| Hook | What it does |
|------|-------------|
| `onSessionStart` | Auto-detects agent, injects graph context + tool guidance |
| `onSessionEnd` | Logs session summary automatically |
| `onErrorOccurred` | Retries on recoverable model errors |

## Quick Start

```bash
# Index a codebase
myelin parse ./my-project --namespace repo:my-project

# Ingest text documents
myelin ingest ./my-notes --namespace docs:notes

# Run a full maintenance cycle
myelin sleep

# Search the graph
myelin query "how does authentication work"

# Health check
myelin doctor
```

Namespaces partition the graph by source, enabling filtered queries and future access controls.

## Three Pipelines

### `myelin parse` — Code Indexing
Extracts structural entities from source code using **tree-sitter** AST parsing. Creates nodes for classes, methods, interfaces, functions, and edges for inheritance, containment, and imports. Use `--namespace` to assign a namespace for graph partitioning (e.g., `--namespace repo:my-project`).

**Languages:** C#, TypeScript/TSX, JavaScript, Python, Go, JSON, YAML, Dockerfile, PowerShell, Bicep

### `myelin ingest` — Document Ingestion
General-purpose pipeline for any text file. Chunks documents, extracts entities using regex/heuristic patterns (people, tools, decisions, projects), and creates relationship edges between co-occurring entities. Use `--namespace` to assign a namespace (e.g., `--namespace docs:notes`).

Use `--fast` for proximity-only edges.

### `myelin sleep` — Memory Consolidation
Brain-inspired two-phase consolidation of agent activity logs:

- **NREM** (Replay → Extract → Score → Transfer): Reads agent logs, extracts entities, scores salience using a dual-signal model (importance × 0.7 + novelty × 0.3), transfers to graph. Use `myelin_consolidate` tool for LLM-driven extraction.
- **REM** (Decay → Prune → Refine): Applies temporal decay, removes stale nodes/edges, homeostatic maintenance

Consolidation is idempotent — running it twice on the same logs reinforces existing nodes rather than creating duplicates.

## Knowledge Graph

Nodes are typed (Person, Tool, Decision, Pattern, Bug, Initiative, Meeting, Rule, Convention, Concept, plus code types like Class, Method, Interface) with salience scores, sensitivity levels, and optional pinning.

Edges are typed (RelatesTo, DependsOn, Supersedes, LearnedFrom, BelongsTo, AuthoredBy, EvolvedInto, etc.) with weights and reinforcement timestamps.

**Search** is FTS5 keyword-based, with optional semantic boost via sqlite-vec when embeddings are available.

**Decay** follows an exponential forgetting curve — recently reinforced nodes decay slower. Nodes below the salience threshold AND older than the age cutoff are pruned. Both conditions must hold to prevent premature forgetting.

**Pinned nodes** never decay and always load at boot — useful for constitutional knowledge that should never be forgotten.

## Dependencies

All processing runs locally. No data leaves your machine.

| Component | Purpose | Required? |
|-----------|---------|-----------|
| better-sqlite3 | Graph database storage | Yes |
| sqlite-vec | Vector search (optional semantic boost) | Included |
| Tree-sitter grammars | AST parsing — 10 languages | Included |

Entity extraction uses the host LLM via the `myelin_consolidate` tool — no local ML models needed.

## CLI Reference

| Command | Description |
|---------|-------------|
| `myelin init` | Initialize graph database |
| `myelin setup-extension` | Bundle extension, install deps |
| `myelin doctor` | Health check with actionable diagnostics |
| `myelin sleep` | Full maintenance cycle (consolidate all agents) |
| `myelin parse <path>` | Index code repo with tree-sitter (`--namespace`) |
| `myelin ingest <path>` | Ingest text documents with entity extraction (`--namespace`) |
| `myelin vault <path>` | Index IDEA vault structure (`--namespace`) |
| `myelin consolidate` | Run NREM/REM consolidation |
| `myelin query <text>` | Keyword + semantic search |
| `myelin show <name>` | Show node and connections |
| `myelin stats` | Graph statistics |
| `myelin nodes` | List nodes with filters |
| `myelin pin <name>` | Pin a node (never decays) |
| `myelin classify <name>` | Set sensitivity level on a node |
| `myelin agent boot <name>` | Generate agent briefing from graph |
| `myelin agent log <name> <type> <msg>` | Log structured event |
| `myelin agent log-show <name>` | View agent's log entries |
| `myelin agent instructions <name>` | Generate logging instructions for agent definition |
| `myelin namespaces` | List indexed namespaces |
| `myelin update` | Update myelin to latest version |

## Development

```bash
npm test              # vitest — all tests
npm run test:watch    # watch mode
npm run build         # TypeScript compile
npm run bundle-extension  # esbuild bundle for Copilot CLI
```

Tests are **required** for all code changes. CI runs on every push and PR across Node 20/22 on Linux, Windows, and macOS.

Test files live in `tests/` mirroring `src/` structure. Use Vitest with in-memory SQLite for graph tests.

## Design Principles

See [NORTH-STAR.md](NORTH-STAR.md) for the full architecture philosophy. Key principles:

1. **Brain-faithful** — every subsystem maps to a neuroscience concept
2. **Local-first** — works offline, no cloud APIs required
3. **Reinforcement over duplication** — boost existing knowledge, don't duplicate
4. **Single graph, many views** — one graph serves all agents and projects
5. **Progressive complexity** — 5-minute install to full semantic memory

## License

Apache-2.0
