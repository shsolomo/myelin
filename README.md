# Myelin

Knowledge graph memory system for AI agents. Named after the neural sheath that makes signals travel faster the more a path is used — that's what this tool does for agent memory.

Myelin gives AI agents persistent, searchable memory across sessions. It combines local NLP models (zero API calls) with a graph database to extract entities, classify relationships, and build a navigable knowledge structure from code, notes, and agent activity.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              INPUT SOURCES                                  │
│                                                                              │
│   Code Repos          Text Documents          Agent Logs                     │
│   (C#, TS, Py,        (markdown, notes,       (JSONL structured              │
│    Go, YAML...)        meeting recaps)          events per agent)             │
│       │                      │                       │                       │
│       ▼                      ▼                       ▼                       │
│  ┌─────────┐         ┌──────────────┐        ┌──────────────┐               │
│  │  parse   │         │   ingest     │        │ consolidate  │               │
│  │ (code)   │         │ (documents)  │        │ (NREM/REM)   │               │
│  └────┬─────┘         └──────┬───────┘        └──────┬───────┘               │
│       │                      │                       │                       │
└───────┼──────────────────────┼───────────────────────┼───────────────────────┘
        │                      │                       │
        ▼                      ▼                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          LOCAL NLP MODELS                                    │
│                      (no API calls, fully offline)                           │
│                                                                              │
│   Tree-sitter             GLiNER (ONNX)          all-MiniLM-L6-v2           │
│   AST parsing             Zero-shot NER          Sentence embeddings         │
│   9 languages             Entity extraction      384-dim vectors             │
│                           8 entity types         Cosine similarity           │
│                                │                       │                     │
│                                ▼                       ▼                     │
│                     ┌──────────────────────────────────────┐                 │
│                     │   Embedding-based RE                 │                 │
│                     │   Context between entity pairs       │                 │
│                     │   compared against 37 prototype      │                 │
│                     │   sentences → 9 relationship types   │                 │
│                     └──────────────────────────────────────┘                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
        │                      │                       │
        ▼                      ▼                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        KNOWLEDGE GRAPH                                      │
│                   (SQLite + FTS5 + sqlite-vec)                              │
│                                                                              │
│   Nodes                    Edges                    Search                   │
│   ─────                    ─────                    ──────                   │
│   person, tool,            authored_by,             Semantic: KNN via        │
│   decision, bug,           belongs_to,              sqlite-vec embeddings    │
│   pattern, initiative,     depends_on,                                       │
│   meeting, rule,           mentioned_in,            Keyword: FTS5            │
│   concept, convention      blocked_by,              full-text search         │
│                            supersedes,                                       │
│   Code: Class, Method,     evolved_into,            Hybrid: semantic first,  │
│   Interface, Function,     learned_from,            FTS5 fallback            │
│   Config, File, Enum       conflicts_with                                   │
│                                                                              │
│   Salience Scoring         Homeostatic Decay        Reinforcement            │
│   importance × 0.7         Exponential forgetting   Idempotent upsert:       │
│   + novelty × 0.3          curve with temporal      boost existing nodes     │
│                            kernel                   instead of duplicating   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         AGENT INTERFACE                                     │
│                                                                              │
│   CLI Commands              Extension Tools           Lifecycle Hooks        │
│   ────────────              ───────────────           ───────────────        │
│   myelin query              myelin_query              onSessionStart         │
│   myelin parse              myelin_boot               onUserPromptSubmitted  │
│   myelin ingest             myelin_log                onSessionEnd           │
│   myelin consolidate        myelin_show                                      │
│   myelin viz                myelin_stats                                     │
│   myelin agent boot/log                                                      │
│   myelin vault                                                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Three Pipelines

### `myelin parse` — Code Indexing
Extracts structural entities from source code using **tree-sitter** AST parsing. Creates nodes for classes, methods, interfaces, functions, and edges for inheritance, containment, and imports.

**Languages:** C#, TypeScript/TSX, Python, Go, JSON, YAML, Dockerfile, PowerShell, Bicep

### `myelin ingest` — Document Ingestion
General-purpose pipeline for any text file. Chunks documents, runs **GLiNER** NER to extract entities, then uses **all-MiniLM-L6-v2** embeddings to classify relationships between entity pairs by comparing context against prototype sentences.

**Fully local — zero API calls.** Produces 9 distinct relationship types instead of generic "relates_to".

### `myelin consolidate` — Memory Consolidation (NREM/REM)
Brain-inspired two-phase consolidation of agent activity logs:

- **NREM** (Replay → Extract → Score → Transfer): Read agent logs, extract entities via NER, score salience using dual-signal model (importance + novelty), transfer to graph
- **REM** (Decay → Prune → Refine): Apply temporal decay, remove stale nodes/edges, evolve associations

## Install

```bash
npm install -g github:shsolomo/myelin
myelin init
myelin setup-extension    # Install Copilot CLI extension
```

See [INSTALL.md](INSTALL.md) for detailed setup instructions.

## Quick Start

```bash
# Index a codebase
myelin parse ./my-project

# Ingest text documents (notes, meeting recaps, etc.)
myelin ingest ./my-notes

# Log agent observations
myelin agent log myagent finding "Auth module uses JWT with 24h expiry" --tag security

# Consolidate agent logs into the graph
myelin consolidate --agent myagent

# Generate embeddings for semantic search
myelin embed

# Search
myelin query "how does authentication work"

# Inspect a node and its connections
myelin show "authentication"

# Visualize in browser
myelin viz

# Boot an agent with graph context
myelin agent boot myagent
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `myelin init` | Initialize graph database |
| `myelin parse <path>` | Index code repo (tree-sitter AST) |
| `myelin ingest <path>` | Ingest text documents (NER + embedding RE) |
| `myelin ingest <path> --fast` | Ingest with proximity-only edges (no embeddings) |
| `myelin vault <path>` | Index IDEA vault structure |
| `myelin query <text>` | Semantic + keyword search |
| `myelin show <name>` | Show node and connections |
| `myelin stats` | Graph statistics |
| `myelin nodes` | List nodes with filters |
| `myelin embed` | Generate/update embeddings |
| `myelin consolidate` | Run NREM/REM consolidation |
| `myelin agent boot <name>` | Load agent context from graph |
| `myelin agent log <name> <type> <summary>` | Log structured event |
| `myelin viz` | D3.js graph visualization |
| `myelin setup-extension` | Install Copilot CLI extension |

## As a Copilot CLI Extension

After running `myelin setup-extension`, every Copilot agent gets native access to:

**Tools:** `myelin_query`, `myelin_boot`, `myelin_log`, `myelin_show`, `myelin_stats`

**Lifecycle hooks:**
- `onSessionStart` — graph context auto-injected
- `onUserPromptSubmitted` — relevant context added per message
- `onSessionEnd` — session summary auto-logged

## Local Models

| Model | Purpose | Size | Runtime |
|-------|---------|------|---------|
| GLiNER (gliner_small-v2.1) | Zero-shot NER — 8 entity types | ~600MB ONNX | onnxruntime-node |
| all-MiniLM-L6-v2 | Sentence embeddings — 384-dim vectors | ~80MB | @huggingface/transformers |
| Tree-sitter grammars | AST parsing — 9 languages | ~5MB each | tree-sitter native |

All models run locally. No data leaves your machine.

## License

MIT
