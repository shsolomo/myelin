---
name: myelin-setup
description: Set up Myelin knowledge graph memory for any project. Use when asked to "set up myelin", "index my code", "index my notes", "add memory to my agent", or "install myelin".
---

# Myelin Setup

## Purpose

Guide users through installing and configuring Myelin — a knowledge graph memory system for AI agents. After setup, agents get persistent memory via semantic search, auto-injected context, automatic session logging, and graph-based briefings. No manual boot or logging steps required — the extension handles it.

## Required Configuration

This skill works without any pre-existing configuration. During setup, it creates the necessary infrastructure. If the user wants to index code repos or notes, they provide the paths interactively.

## Instructions

### Phase 1: Install & Initialize

1. Check if `myelin` CLI is already installed:
   ```bash
   myelin --version
   ```

2. If not installed, install from GitHub:
   ```bash
   npm install -g github:shsolomo/myelin
   ```
   Requires Node.js 24 (25+ is not yet supported). Native addons (better-sqlite3, sqlite-vec) compile during install — a C++ toolchain is required (Visual Studio Build Tools on Windows, Xcode on macOS, `build-essential` on Linux).

3. Set up the Copilot CLI extension (also initializes the graph database and downloads models):
   ```bash
   myelin setup-extension
   ```
   This bundles the extension, creates the graph DB at `~/.copilot/.working-memory/graph.db`, installs runtime dependencies, and downloads the GLiNER NER model + embedding model (~660MB one-time download).

4. Restart Copilot CLI (or run `/clear`) to load the extension.

5. Verify the installation:
   ```bash
   myelin doctor
   ```
   Should show ✅ for graph database, schema, and extension. Follow any ⚠️ or ❌ recommendations.

### Phase 2: Index Content

Ask the user what they want to index. There are three modes — any combination works:

#### Mode A: Code Repository

Index source code with tree-sitter. Supports C#, TypeScript, JavaScript, Python, Go, YAML, JSON, Bicep, PowerShell, and Dockerfile.

```bash
myelin parse /path/to/repo --namespace repo:my-project --embed
```

Namespaces partition the graph by source. Use a consistent naming convention: `repo:name` for code, `docs:name` for documents, `vault:name` for vaults. The `--embed` flag generates embeddings for semantic search.

Optional: specify a namespace to keep repos separate:
```bash
myelin parse /path/to/repo --namespace repo:my-project --embed
```

This creates `File`, `Class`, `Method`, `Interface`, `Function` nodes with `defines` and `contains` edges — the structural skeleton of the codebase.

To list indexed namespaces:
```bash
myelin namespaces
```

#### Mode B: Text Documents (Notes, Meeting Recaps, etc.)

Ingest text files with entity extraction and relationship edges:

```bash
myelin ingest /path/to/notes --namespace docs:notes --embed
```

Uses NER (GLiNER for high-precision zero-shot extraction, with regex/heuristic fallback if the model isn't available) to extract entities and create co-occurrence edges. GLiNER downloads automatically during `myelin setup-extension`.

Use `--fast` to skip embedding-based relationship classification (faster, proximity-only edges):
```bash
myelin ingest /path/to/notes --namespace docs:notes --fast
```

#### Mode C: IDEA Vault (Structured Notes)

For IDEA-method vaults (Initiatives, Domains, Expertise, Archive):

```bash
myelin vault /path/to/vault --namespace vault:main --embed
```

#### Mode D: Agent Memory (Structured Logs)

Agents log automatically via the extension's lifecycle hooks — no manual logging setup needed. The extension:
- Auto-detects the agent name on session start
- Auto-injects graph context before the first message
- Auto-logs a session summary on session end

For agents that want to log additional structured events during sessions, they can use the `myelin_log` tool or the CLI:
```bash
myelin agent log <agent-name> <type> "<summary>" --tag <topic>
```
Types: `decision`, `action`, `finding`, `error`, `observation`, `handover`

### Phase 3: Consolidate & Embed

Run a full maintenance cycle to process agent logs and generate embeddings:

```bash
myelin sleep
```

This single command:
1. Discovers all agents with logs
2. Runs NREM consolidation (replay logs → extract entities → score salience → write to graph)
3. Runs REM refinement (global decay → pruning)
4. Generates embeddings for all nodes (required for semantic search)

For per-agent or per-phase control:
```bash
myelin consolidate --agent <agent-name>              # consolidate one agent
myelin consolidate --agent <agent-name> --phase nrem  # NREM only
myelin embed                                          # embeddings only
```

Recommend scheduling `myelin sleep` nightly for ongoing maintenance.

### Phase 4: Verify

1. **Run diagnostics**:
   ```bash
   myelin doctor
   ```

2. **Check graph contents**:
   ```bash
   myelin stats
   ```

3. **Test semantic search**:
   ```bash
   myelin query "your search term here"
   ```

4. **Test agent boot** (what agents see at session start):
   ```bash
   myelin agent boot <agent-name>
   ```

### Phase 5: Agent Integration

The extension handles most integration automatically:
- **Auto-boot**: Graph context is injected on session start (no manual `myelin_boot` call needed)
- **Auto-log**: Session summaries are logged on session end
- **Per-message context**: Relevant knowledge is surfaced with each user message

To customize an agent's interaction with myelin, add instructions to the agent's definition file:
```bash
myelin agent instructions <agent-name>
```

This generates logging instructions you can paste into the agent definition.

## Constraints

- Do NOT delete log files. Consolidation reads logs but never removes them. Logs are the source of truth for graph rebuilds.
- Do NOT skip `myelin sleep` (or `myelin embed`) if the user wants semantic search — without embeddings, queries fall back to keyword-only FTS5 search.
- Native addon compilation requires a C++ toolchain (Visual Studio Build Tools on Windows, Xcode on macOS, build-essential on Linux).
- If `myelin doctor` reports issues, address those before troubleshooting other problems.

## Examples

### Full setup for a new project

```bash
# Install
npm install -g github:shsolomo/myelin

# Set up extension (auto-inits graph DB, downloads models)
myelin setup-extension

# Restart Copilot CLI, then:

# Index your codebase
myelin parse ./my-project --namespace repo:my-project --embed

# Ingest your notes
myelin ingest ./my-notes --namespace docs:notes --embed

# Consolidate + embed
myelin sleep

# Verify
myelin doctor
myelin query "cache performance"
```

### Index multiple repos

```bash
myelin parse ./frontend --namespace repo:frontend --embed
myelin parse ./backend --namespace repo:backend --embed
myelin parse ./infra --namespace repo:infra --embed
myelin namespaces  # shows all three
```

### Re-index after graph corruption

Logs are never deleted, so the graph can always be rebuilt:

```bash
rm ~/.copilot/.working-memory/graph.db
myelin init
myelin parse ./my-repo --namespace repo:my-repo --embed
myelin sleep
```
