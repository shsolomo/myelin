# Myelin

Knowledge graph memory system for AI agents. Semantic search, NER extraction, brain-inspired consolidation.

Named after the neural sheath that makes signals travel faster the more a path is used — that's what this tool does for agent memory.

## Install

```bash
npm install -g myelin
```

## Quick Start

```bash
# Initialize the knowledge graph
myelin init

# Index a codebase
myelin parse ./my-project

# Search semantically
myelin query "how does authentication work"

# Log agent observations
myelin agent log donna finding "Discovered a race condition in the auth flow" --tag security

# Boot an agent with graph context
myelin agent boot donna

# Run consolidation (NREM + REM cycle)
myelin consolidate --agent donna
```

## As a Copilot CLI Extension

Copy the extension to your Copilot config:

```bash
cp -r node_modules/myelin/dist/extension ~/.copilot/extensions/myelin
```

This gives every Copilot agent native access to:
- `myelin_query` — semantic search over the knowledge graph
- `myelin_boot` — load agent-specific context from the graph
- `myelin_log` — structured event logging
- `myelin_show` — inspect nodes and relationships
- `myelin_stats` — graph statistics

Plus lifecycle hooks:
- `onSessionStart` — auto-injects graph context before the first message
- `onSessionEnd` — auto-logs session summary

## Architecture

```
Graph (SQLite + FTS5 + sqlite-vec)
  ├── Knowledge nodes — decisions, patterns, people, bugs, tools
  ├── Code nodes — classes, methods, interfaces (via tree-sitter)
  ├── Cross-domain edges — knowledge ↔ code connections
  └── Embeddings — semantic vectors for similarity search

Consolidation (brain-inspired NREM/REM cycle)
  ├── NREM: Parse logs → Extract entities (GLiNER NER) → Score salience → Transfer to graph
  └── REM: Decay old nodes → Prune stale edges → Evolve agent personas

Search
  ├── Semantic: sentence-transformers embeddings + sqlite-vec KNN
  └── Keyword: FTS5 full-text search (fast fallback)
```

## License

MIT
