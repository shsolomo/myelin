# Installing Myelin

Myelin is a knowledge graph memory system for AI agents. It provides semantic search, NER extraction, and brain-inspired consolidation as native Copilot CLI tools.

## Prerequisites

- Node.js >= 20 (Node.js 24+ recommended for best compatibility with Copilot CLI)
- npm
- C++ toolchain for native addons (Visual Studio Build Tools on Windows, Xcode on macOS, build-essential on Linux)
- Python >= 3.6 (required by node-gyp for building native modules)
- Copilot CLI with extensions enabled (experimental feature)

## Step 1: Install Myelin globally

```bash
npm install -g github:shsolomo/myelin
```

This installs the `myelin` CLI and compiles native dependencies (better-sqlite3, sqlite-vec, tree-sitter).

## Step 2: Initialize the knowledge graph

```bash
myelin init
```

This creates the graph database at `~/.copilot/.working-memory/graph.db`.

## Step 3: Install the setup skill

Copy the `myelin-setup` skill into your Copilot skills directory so your agent knows how to help you index code, notes, and set up agent memory:

```bash
# For global skills (available in all repos)
cp -r /path/to/myelin/skills/myelin-setup ~/.copilot/skills/myelin-setup

# Or for a specific repo
cp -r /path/to/myelin/skills/myelin-setup .github/skills/myelin-setup
```

On Windows:
```powershell
Copy-Item -Recurse (Join-Path (npm root -g) myelin skills myelin-setup) "$env:USERPROFILE\.copilot\skills\myelin-setup"
```

Once installed, ask your agent to "set up myelin" or "index my code" — the skill guides the full setup interactively.

## Step 4: Install the Copilot CLI extension

```bash
myelin setup-extension
```

This bundles Myelin into a single extension file and installs it at `~/.copilot/extensions/myelin/` with all native dependencies. The extension runs in-process with the Copilot agent — no subprocess spawning.

## Step 5: Reload Copilot CLI

Restart Copilot CLI or run `/clear` in an active session to load the extension.

## What You Get

### Tools (agent calls directly)
- `myelin_query` — semantic search over the knowledge graph
- `myelin_boot` — load agent-specific context from the graph
- `myelin_log` — structured event logging per agent
- `myelin_show` — inspect nodes and their connections
- `myelin_stats` — graph statistics and embedding coverage

### Lifecycle Hooks (automatic)
- `onSessionStart` — graph context auto-injected before the first message
- `onUserPromptSubmitted` — relevant context silently added on every message
- `onSessionEnd` — session summary auto-logged

### Copilot Skill
- `myelin-setup` — interactive guide for indexing code repos, notes, and agent memory

## Quick Start

After installation, index your first content:

```bash
# Index a codebase (C#, TypeScript, Python, Go, JSON, YAML, Dockerfile, Bicep, PowerShell)
myelin code parse ./path/to/repo

# Start logging agent observations
myelin agent log myagent decision "Use event-driven architecture" --tag architecture

# Consolidate logs into the knowledge graph
myelin consolidate --agent myagent

# Generate embeddings for semantic search
myelin embed --category knowledge

# Verify
myelin stats
myelin query "your search term"
myelin agent boot myagent

# Visualize the graph
myelin viz
```

Or just ask your agent: **"set up myelin for this project"** — the skill handles it.
