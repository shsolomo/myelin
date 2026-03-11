# Installing Myelin

Step-by-step guide to get myelin running. Takes about 5 minutes.

## Prerequisites

- **Node.js** >= 20 (Node.js 24+ recommended for Copilot CLI extension compatibility)
- **npm**
- **C++ build tools** for native addons:
  - Windows: Visual Studio Build Tools (Desktop C++ workload)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential` package
- **Python** >= 3.6 (required by node-gyp)

## Step 1: Install

```bash
npm install -g github:shsolomo/myelin
```

This installs the `myelin` CLI and compiles native dependencies (better-sqlite3, sqlite-vec, tree-sitter grammars). The GLiNER ONNX model (~600MB) is included in the package.

## Step 2: Initialize the Graph

```bash
myelin init
```

Creates the graph database at `~/.copilot/.working-memory/graph.db`.

## Step 3: Index Your Content

Pick any combination:

### Code repos

```bash
myelin parse ./path/to/repo
```

Tree-sitter AST parsing extracts classes, methods, interfaces, functions, and their relationships. Supports C#, TypeScript, Python, Go, JSON, YAML, Dockerfile, PowerShell, and Bicep.

### Text documents (notes, meeting recaps, etc.)

```bash
myelin ingest ./path/to/notes
```

Chunks text files, runs zero-shot NER (GLiNER) to find entities, then uses sentence embeddings to classify relationships between them. Produces 9 typed relationship types. Fully local — no API calls.

Use `--fast` to skip embedding-based relationship classification (faster, proximity-only edges):

```bash
myelin ingest ./path/to/notes --fast
```

### IDEA vault (structured notes)

If you use the IDEA method (Initiatives, Domains, Expertise, Archive):

```bash
myelin vault ./path/to/vault
```

Extracts structural relationships from the vault layout: people, domains, initiatives, decisions, action items.

### Agent activity logs

```bash
myelin agent log myagent finding "Auth uses JWT with 24h expiry" --tag security
myelin consolidate --agent myagent
```

Consolidation runs the brain-inspired NREM cycle: replay logs, extract entities, score salience, transfer to graph.

## Step 4: Generate Embeddings

```bash
myelin embed
```

Embeds all nodes using all-MiniLM-L6-v2 (384-dim vectors). First run downloads the model (~80MB). Required for semantic search.

## Step 5: Verify

```bash
myelin stats                            # Node/edge counts, type distribution
myelin query "your search term"         # Semantic search
myelin show "entity name"               # Inspect node and connections
myelin viz                              # Browser visualization
```

## Step 6: Install the Copilot CLI Extension (optional)

```bash
myelin setup-extension
```

Bundles myelin into a single extension file at `~/.copilot/extensions/myelin/`. Restart Copilot CLI or run `/clear` to load.

This gives every Copilot agent these tools:

| Tool | Description |
|------|-------------|
| `myelin_query` | Semantic search over the knowledge graph |
| `myelin_boot` | Load agent-specific context at session start |
| `myelin_log` | Log structured events (decision, finding, error, etc.) |
| `myelin_show` | Inspect a node and its connections |
| `myelin_stats` | Graph statistics and embedding coverage |

Plus automatic lifecycle hooks:
- **onSessionStart** — graph context injected before first message
- **onUserPromptSubmitted** — relevant context added per message
- **onSessionEnd** — session summary auto-logged

## Step 7: Install the Setup Skill (optional)

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
The extension's native modules must match the Copilot CLI's Node.js version. Re-run `myelin setup-extension` — it recompiles for the current Node.js.

### GLiNER model not found
The ONNX model files should be in `models/gliner/` relative to the myelin install. Run `npm install -g github:shsolomo/myelin` to reinstall with model files included.

### Embedding model slow on first run
The first call to `myelin embed` or `myelin ingest` downloads the all-MiniLM-L6-v2 model (~80MB). Subsequent runs use the cached model.
