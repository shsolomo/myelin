# Installing Myelin

Myelin is a knowledge graph memory system for AI agents. It provides semantic search, NER extraction, and brain-inspired consolidation as native Copilot CLI tools.

## Prerequisites

- Node.js >= 20
- npm
- Copilot CLI with extensions enabled (experimental feature)

## Step 1: Install Myelin globally

```bash
npm install -g myelin
```

This installs the `myelin` CLI and all dependencies including semantic search models.

## Step 2: Initialize the knowledge graph

```bash
myelin init
```

This creates the graph database at `~/.copilot/.working-memory/graph.db`.

## Step 3: Install the Copilot CLI extension

```bash
myelin setup-extension
```

This bundles Myelin into a single extension file and installs it at `~/.copilot/extensions/myelin/` with all native dependencies. The extension runs in-process with the Copilot agent — no subprocess spawning.

## Step 4: Reload Copilot CLI

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

## Optional: Index a codebase

```bash
myelin parse ./path/to/repo
```

This uses tree-sitter to parse source code (C#, TypeScript, Python, Go, JSON, YAML, Dockerfile) into the knowledge graph. Code nodes connect to knowledge nodes via cross-domain edges.

## Optional: Embed nodes for semantic search

```bash
myelin embed --category knowledge
```

This generates sentence embeddings for all knowledge nodes. The embedding model downloads on first run (~80MB) and is cached locally at `~/.cache/huggingface/`.

## Verify

After reloading Copilot CLI, ask the agent: "What myelin tools do you have?" It should list all 5 tools.

Or from the CLI:
```bash
myelin stats
myelin query "test query"
```
