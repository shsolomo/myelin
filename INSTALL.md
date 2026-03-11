# Installing Myelin

Myelin gives your Copilot CLI agents persistent, searchable memory across sessions. The primary integration is as a **Copilot CLI extension** — once installed, every agent automatically gets graph-backed tools and context injection.

## Quick Start (Copilot CLI Extension)

Three steps to give your agents memory:

### 1. Install myelin

```bash
npm install -g github:shsolomo/myelin
```

Compiles native dependencies (better-sqlite3, sqlite-vec, tree-sitter grammars). Requires Node.js >= 20 and C++ build tools.

### 2. Initialize the graph

```bash
myelin init
```

Creates the knowledge graph at `~/.copilot/.working-memory/graph.db`.

### 3. Install the extension

```bash
myelin setup-extension
```

Bundles myelin into `~/.copilot/extensions/myelin/extension.mjs`. Restart Copilot CLI or run `/clear` to load.

**That's it.** Your agents now have:

| Tool | What it does |
|------|-------------|
| `myelin_query` | Semantic search over the knowledge graph |
| `myelin_boot` | Load agent-specific context at session start |
| `myelin_log` | Log structured events (decision, finding, error, etc.) |
| `myelin_show` | Inspect a node and its connections |
| `myelin_stats` | Graph statistics and embedding coverage |

Plus automatic lifecycle hooks:
- **onSessionStart** — graph context injected before first message
- **onUserPromptSubmitted** — relevant context added per message via semantic search
- **onSessionEnd** — session summary auto-logged
- **onErrorOccurred** — automatic retry on recoverable model errors

## Feeding the Graph

The graph starts empty. Feed it with any combination of sources:

### Code repos

```bash
myelin parse ./path/to/repo
```

Tree-sitter AST parsing extracts classes, methods, interfaces, functions, and their relationships. Supports C#, TypeScript, Python, Go, JSON, YAML, Dockerfile, PowerShell, and Bicep.

### Text documents (notes, meeting recaps, etc.)

```bash
myelin ingest ./path/to/notes
```

Chunks text files, runs zero-shot NER (GLiNER) to find entities, then uses sentence embeddings to classify relationships. Fully local — no API calls.

Use `--fast` to skip embedding-based relationship classification (faster, proximity-only edges):

```bash
myelin ingest ./path/to/notes --fast
```

### IDEA vault (structured notes)

If you use the IDEA method (Initiatives, Domains, Expertise, Archive):

```bash
myelin vault ./path/to/vault
```

### Agent activity logs

```bash
myelin agent log myagent finding "Auth uses JWT with 24h expiry" --tag security
myelin consolidate --agent myagent
```

Consolidation runs the brain-inspired NREM cycle: replay logs, extract entities, score salience, transfer to graph.

### Generate embeddings

```bash
myelin embed
```

Embeds all nodes using all-MiniLM-L6-v2 (384-dim vectors). First run downloads the model (~80MB). Required for semantic search in the extension.

## CLI Usage (standalone)

The `myelin` CLI works independently of the Copilot extension:

```bash
myelin stats                            # Node/edge counts, type distribution
myelin query "your search term"         # Semantic search
myelin show "entity name"               # Inspect node and connections
myelin viz                              # Browser visualization
myelin agent boot myagent               # Generate agent briefing
```

## Prerequisites

- **Node.js** >= 20 (Node.js 22+ recommended)
- **npm**
- **C++ build tools** for native addons:
  - Windows: Visual Studio Build Tools (Desktop C++ workload)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential` package
- **Python** >= 3.6 (required by node-gyp)

## Optional: Install the Setup Skill

Copy the `myelin-setup` skill so your agent can guide setup interactively:

```bash
# Global (all repos)
cp -r $(npm root -g)/myelin/skills/myelin-setup ~/.copilot/skills/myelin-setup
```

Windows:
```powershell
Copy-Item -Recurse (Join-Path (npm root -g) myelin skills myelin-setup) "$env:USERPROFILE\.copilot\skills\myelin-setup"
```

Then ask your agent: **"set up myelin for this project"**

## Troubleshooting

### `npm install` fails with node-gyp errors
Ensure C++ build tools and Python are installed. On Windows, run `npm install --global windows-build-tools` from an admin terminal.

### Extension fails with NODE_MODULE_VERSION mismatch
The extension's native modules must match the Copilot CLI's Node.js version. Re-run `myelin setup-extension` to recompile.

### GLiNER model not found
The ONNX model files should be in `models/gliner/` relative to the myelin install. Run `npm install -g github:shsolomo/myelin` to reinstall with model files included.

### Embedding model slow on first run
The first call to `myelin embed` or `myelin ingest` downloads the all-MiniLM-L6-v2 model (~80MB). Subsequent runs use the cached model.
