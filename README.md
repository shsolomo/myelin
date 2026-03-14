# Myelin

Knowledge graph memory system for AI agents. Named after the neural sheath that makes signals travel faster the more a path is used — that's what this does for agent memory.

Myelin gives AI agents persistent, searchable memory across sessions. It uses brain-inspired consolidation (NREM/REM phases) to extract knowledge from agent activity, local NLP models for entity recognition and semantic search, and a graph database that reinforces what matters and forgets what doesn't.

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
  │ (tree-   │        │ (GLiNER NER  │       │ (NREM/REM    │
  │  sitter) │        │  + embed RE) │       │  phases)     │
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

That's it. `setup-extension` initializes the graph database, bundles the Copilot CLI extension, and downloads the NER + embedding models (~660MB one-time). Restart Copilot CLI and every agent has memory.

See [INSTALL.md](INSTALL.md) for detailed setup, troubleshooting, and advanced configuration.

## What Agents Get

After setup, every Copilot CLI agent automatically gets:

**5 tools:**

| Tool | What it does |
|------|-------------|
| `myelin_query` | Semantic + keyword search over the knowledge graph |
| `myelin_boot` | Load agent-specific context at session start |
| `myelin_log` | Log structured events (decision, finding, error, etc.) |
| `myelin_show` | Inspect a node and its connections |
| `myelin_stats` | Graph statistics and embedding coverage |

**4 lifecycle hooks** (automatic, no agent action needed):

| Hook | What it does |
|------|-------------|
| `onSessionStart` | Auto-detects agent, injects graph context |
| `onUserPromptSubmitted` | Surfaces relevant knowledge per message |
| `onSessionEnd` | Logs session summary automatically |
| `onErrorOccurred` | Retries on recoverable model errors |

## Quick Start

```bash
# Index a codebase
myelin parse ./my-project --namespace repo:my-project --embed

# Ingest text documents
myelin ingest ./my-notes --namespace docs:notes --embed

# Run a full maintenance cycle (consolidate + embed)
myelin sleep

# Search the graph
myelin query "how does authentication work"

# Health check
myelin doctor
```

Namespaces partition the graph by source, enabling filtered queries and future access controls. The `--embed` flag generates embeddings for semantic search (`myelin sleep` does this automatically).

## Three Pipelines

### `myelin parse` — Code Indexing
Extracts structural entities from source code using **tree-sitter** AST parsing. Creates nodes for classes, methods, interfaces, functions, and edges for inheritance, containment, and imports. Use `--namespace` to assign a namespace for graph partitioning (e.g., `--namespace repo:my-project`).

**Languages:** C#, TypeScript/TSX, JavaScript, Python, Go, JSON, YAML, Dockerfile, PowerShell, Bicep

### `myelin ingest` — Document Ingestion
General-purpose pipeline for any text file. Chunks documents, runs **GLiNER** zero-shot NER to extract entities, then uses **all-MiniLM-L6-v2** embeddings to classify relationships between entity pairs by comparing context against prototype sentences. Use `--namespace` to assign a namespace (e.g., `--namespace docs:notes`).

Produces 9 distinct relationship types instead of generic "relates_to". Use `--fast` for proximity-only edges without embeddings.

### `myelin sleep` — Memory Consolidation
Brain-inspired two-phase consolidation of agent activity logs:

- **NREM** (Replay → Extract → Score → Transfer): Reads agent logs, extracts entities via NER, scores salience using a dual-signal model (importance × 0.7 + novelty × 0.3), transfers to graph
- **REM** (Decay → Prune → Refine): Applies temporal decay, removes stale nodes/edges, homeostatic maintenance

Consolidation is idempotent — running it twice on the same logs reinforces existing nodes rather than creating duplicates.

## Knowledge Graph

Nodes are typed (Person, Tool, Decision, Pattern, Bug, Initiative, Meeting, Rule, Convention, Concept, plus code types like Class, Method, Interface) with salience scores, sensitivity levels, and optional pinning.

Edges are typed (RelatesTo, DependsOn, Supersedes, LearnedFrom, BelongsTo, AuthoredBy, EvolvedInto, etc.) with weights and reinforcement timestamps.

**Search** is hybrid: semantic search first (KNN via sqlite-vec on 384-dim embeddings), with FTS5 keyword fallback when embeddings are unavailable or results are poor.

**Decay** follows an exponential forgetting curve — recently reinforced nodes decay slower. Nodes below the salience threshold AND older than the age cutoff are pruned. Both conditions must hold to prevent premature forgetting.

**Pinned nodes** never decay and always load at boot — useful for constitutional knowledge that should never be forgotten.

## Local Models

All models run locally. No data leaves your machine. Both models download automatically during `myelin setup-extension`.

| Model | Purpose | Size |
|-------|---------|------|
| [GLiNER](https://huggingface.co/shsolomo/gliner-small-v2.1-onnx) (gliner_small-v2.1) | Zero-shot NER — entity extraction | ~583MB |
| all-MiniLM-L6-v2 | Sentence embeddings — 384-dim vectors for semantic search | ~80MB |
| Tree-sitter grammars | AST parsing — 10 languages | ~5MB each |

GLiNER uses a DeBERTa v2 backbone + span classifier via ONNX Runtime. If unavailable, NER falls back to regex/heuristic patterns — functional but lower precision.

## CLI Reference

| Command | Description |
|---------|-------------|
| `myelin init` | Initialize graph database |
| `myelin setup-extension` | Bundle extension, install deps, download models |
| `myelin doctor` | Health check with actionable diagnostics |
| `myelin sleep` | Full maintenance cycle (consolidate + embed all agents) |
| `myelin parse <path>` | Index code repo with tree-sitter (`--namespace`, `--embed`) |
| `myelin ingest <path>` | Ingest text documents with NER + embedding RE (`--namespace`, `--embed`) |
| `myelin vault <path>` | Index IDEA vault structure (`--namespace`, `--embed`) |
| `myelin consolidate` | Run NREM/REM consolidation |
| `myelin embed` | Generate/update embeddings |
| `myelin query <text>` | Semantic + keyword search |
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

Tests are **required** for all code changes. CI runs on every push and PR across Node 20/22 on Linux, Windows, and macOS (520+ tests).

Test files live in `tests/` mirroring `src/` structure. Use Vitest with in-memory SQLite for graph tests and mocked NER/embeddings for extraction tests.

## Design Principles

See [NORTH-STAR.md](NORTH-STAR.md) for the full architecture philosophy. Key principles:

1. **Brain-faithful** — every subsystem maps to a neuroscience concept
2. **Local-first** — works offline, no cloud APIs required
3. **Reinforcement over duplication** — boost existing knowledge, don't duplicate
4. **Single graph, many views** — one graph serves all agents and projects
5. **Progressive complexity** — 5-minute install to full semantic memory

## License

Apache-2.0
