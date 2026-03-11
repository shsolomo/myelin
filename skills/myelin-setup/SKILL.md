---
name: myelin-setup
description: Set up Myelin knowledge graph memory for any project. Use when asked to "set up myelin", "index my code", "index my notes", "add memory to my agent", or "install myelin".
---

# Myelin Setup

## Purpose

Guide users through installing and configuring Myelin — a knowledge graph memory system for AI agents. Covers three indexing modes: agent memory (structured logs → graph), code repos (tree-sitter AST → graph), and notes/documents (manual or log-based ingestion). After setup, agents get persistent memory via semantic search, auto-injected context, and graph-based briefings.

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
   Requires Node.js >= 20. Native addons (better-sqlite3, sqlite-vec) compile during install.

3. Initialize the knowledge graph database:
   ```bash
   myelin init
   ```
   Creates `~/.copilot/.working-memory/graph.db` with full schema (nodes, edges, FTS5, triggers).

4. Verify with:
   ```bash
   myelin stats
   ```
   Should show 0 nodes, 0 edges on a fresh install.

### Phase 2: Index Content

Ask the user what they want to index. There are three modes — any combination works:

#### Mode A: Code Repository

Index source code with tree-sitter. Supports C#, TypeScript, JavaScript, Python, Go, YAML, JSON, Bicep, PowerShell, and Dockerfile.

```bash
myelin code parse /path/to/repo
```

Optional: specify a namespace to keep repos separate:
```bash
myelin code parse /path/to/repo --namespace repo:my-project
```

This creates `File`, `Class`, `Method`, `Interface`, `Function` nodes with `defines` and `contains` edges — the structural skeleton of the codebase.

To list what namespaces exist after indexing:
```bash
myelin code namespaces
```

#### Mode B: Agent Memory (Structured Logs)

This is the primary memory pipeline. Agents log observations during sessions, then consolidation extracts entities and relationships into the graph.

1. **Log events** (agents do this during normal work):
   ```bash
   myelin agent log <agent-name> <type> "<summary>" --tag <topic>
   ```
   Types: `decision`, `action`, `finding`, `error`, `observation`, `handover`

2. **View logged events**:
   ```bash
   myelin agent log-show <agent-name>
   ```

3. **Consolidate** logs into the graph (NREM extracts entities, REM applies decay):
   ```bash
   myelin consolidate --agent <agent-name>
   ```
   This runs NER (GLiNER zero-shot) to extract people, tools, decisions, bugs, patterns, initiatives, and meetings from log text. Entities within 300 characters of each other get co-occurrence edges.

#### Mode C: Notes / Documents

For IDEA-method vaults or markdown note collections, there is no direct indexer yet. Two approaches:

**Approach 1 — Manual node creation** for key concepts:
```bash
myelin add-node --type initiative --name "Project Alpha" --description "Q2 shipping goal" --salience 0.8
```

**Approach 2 — Log-based ingestion** (recommended): Create log entries summarizing key notes, then consolidate. This lets NER extract entities naturally:
```bash
myelin agent log <agent> finding "Project Alpha targets Q2 launch with React frontend and PostgreSQL backend" --tag project
myelin consolidate --agent <agent> --phase nrem
```

### Phase 3: Embeddings

Generate vector embeddings for semantic search (required for `myelin query` and the extension's per-message context injection):

```bash
myelin embed --category knowledge
```

For code nodes too:
```bash
myelin embed --category code
```

The embedding model (all-MiniLM-L6-v2, ~80MB) downloads on first run and is cached at `~/.cache/huggingface/`.

### Phase 4: Verify

1. **Check graph contents**:
   ```bash
   myelin stats
   myelin types
   ```

2. **Test semantic search**:
   ```bash
   myelin query "your search term here"
   ```

3. **Test agent boot** (what agents see at session start):
   ```bash
   myelin agent boot <agent-name>
   ```

4. **Visualize** the graph in browser:
   ```bash
   myelin viz --category knowledge
   ```
   Type checkboxes let you toggle node types. Salience slider filters by importance. Click nodes to highlight connections.

### Phase 5: Install Copilot Extension

This makes myelin tools available inside Copilot CLI sessions automatically:

```bash
myelin setup-extension
```

Then restart Copilot CLI or run `/clear` to load it.

After reload, 5 tools are available to agents: `myelin_query`, `myelin_boot`, `myelin_log`, `myelin_show`, `myelin_stats`.

Three auto-hooks fire without agent action:
- `onSessionStart` — injects graph briefing
- `onUserPromptSubmitted` — adds relevant context per message
- `onSessionEnd` — auto-logs session summary

### Phase 6: Agent Integration

To make an agent use myelin memory, add these instructions to the agent's definition file:

1. **Boot on start**: At session start, run `myelin agent boot <agent-name>` to load graph context.
2. **Log during work**: Use `myelin agent log <agent-name> <type> "<summary>"` to record decisions, findings, and errors.
3. **Consolidate periodically**: Run `myelin consolidate --agent <agent-name>` to transfer logs into the graph (typically nightly or weekly).

To generate the exact logging instructions to paste into an agent definition:
```bash
myelin agent instructions <agent-name>
```

## Constraints

- Do NOT delete log files. Consolidation reads logs but never removes them.
- Do NOT run consolidation on agents with no log file — it exits gracefully but wastes time.
- Do NOT skip `myelin embed` if the user wants semantic search — without embeddings, queries fall back to keyword-only FTS5.
- The extension currently hardcodes "donna" for `onSessionStart` boot context. Other agents get tools but not auto-boot.
- Native addon compilation requires a C++ toolchain (Visual Studio Build Tools on Windows, Xcode on macOS, build-essential on Linux).

## Examples

### Full setup for a new project

```bash
# Install
npm install -g github:shsolomo/myelin

# Initialize
myelin init

# Index your codebase
myelin code parse ./my-project

# Start logging agent observations
myelin agent log myagent decision "Use event-driven architecture for notifications" --tag architecture
myelin agent log myagent finding "Redis cache hit rate is only 40% on cold starts" --tag performance

# Consolidate logs into graph
myelin consolidate --agent myagent

# Generate embeddings
myelin embed --category knowledge

# Verify
myelin stats
myelin query "cache performance"
myelin agent boot myagent

# Visualize
myelin viz

# Install extension for Copilot CLI
myelin setup-extension
```

### Index multiple repos

```bash
myelin code parse ./frontend --namespace repo:frontend
myelin code parse ./backend --namespace repo:backend
myelin code parse ./infra --namespace repo:infra
myelin code namespaces  # shows all three
```

### Re-index after graph corruption

If `graph.db` gets corrupted, delete it and rebuild from logs + code:

```bash
rm ~/.copilot/.working-memory/graph.db
myelin init
myelin code parse ./my-repo
myelin consolidate --agent myagent
myelin embed --category knowledge
```

Logs are never deleted, so the graph can always be rebuilt.
