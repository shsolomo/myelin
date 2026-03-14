# Myelin — North Star

_The decision filter. Every feature, design, and priority gets evaluated against these principles._

## What Myelin Is

Myelin is a **personal knowledge graph memory system** for AI agents. It gives agents the ability to learn from experience, remember across sessions, and build understanding over time — the way biological memory works.

The name comes from the neural sheath that speeds electrical signals the more a pathway is used. In myelin, knowledge that gets reinforced becomes faster to retrieve and harder to forget.

## The Core Problem

AI agents forget everything when a session ends. Context windows are large but ephemeral. When a new session starts, the agent knows nothing about what happened before — not the decisions made, not the patterns discovered, not the bugs hit, not the people involved.

Flat markdown files don't scale. They're unmaintainable, unsearchable, and require manual curation.

## The Solution Model

**Brain-inspired memory consolidation.** Not bigger context windows. Not RAG over documents. A living knowledge graph that grows, decays, and self-organizes through automated cycles modeled on how biological memory works:

- **NREM consolidation**: Replay → Extract → Score → Transfer (hippocampus to cortex)
- **REM refinement**: Decay → Prune → Associate (homeostatic maintenance)
- **Procedural graduation**: Knowledge that survives enough cycles becomes permanent (declarative → procedural)

## Ownership Principles

### Memory is personal

Your myelin graph is **yours**. It reflects your experiences, your agents' discoveries, your decisions across all your projects. It's personal infrastructure — like your brain, not like a shared document.

- The graph lives on your machine: `~/.copilot/.working-memory/graph.db`
- The extension installs globally: `~/.copilot/extensions/myelin/`
- Every agent you run contributes to and draws from the same personal graph

### The extension is infrastructure, not content

The myelin extension is like installing a browser — you do it once, it works everywhere. You don't commit it to repos. You don't share it with teammates. It's the synaptic interface between your agents and your memory.

**Install once. Works in every repo. Available to every agent.**

### Sharing comes through shared knowledge, not shared tooling

Teams don't share myelin extensions. Teams share **knowledge graphs**. When we build remote/shared graph support (Phase 4), the model is:

- Your personal graph stays personal (local, always available)
- Team graphs are remote (shared, access-controlled)
- Your extension connects to both, merging personal and team knowledge at query time
- Sensitivity classification ensures the right knowledge reaches the right context

This means: **repo-local extension installs are an anti-pattern.** They confuse "sharing the tool" with "sharing the knowledge." The tool is personal. The knowledge is what gets shared.

## Architectural Principles

### 1. Brain-faithful design

Every major subsystem maps to a neuroscience concept with cited research. This isn't decoration — it's the design constraint that keeps the architecture coherent.

| Subsystem | Brain Analog | Citation |
|-----------|-------------|----------|
| NREM consolidation | Hippocampus → cortex transfer | Park & Kim (2025) |
| REM refinement | Synaptic homeostasis, pruning | PLOS Comp Bio (2025) |
| Salience scoring | Dopamine (importance) + norepinephrine (novelty) | Dual-signal model |
| Procedural graduation | Declarative → nondeclarative transition | Squire & Zola (1996) |
| Decay curve | Ebbinghaus forgetting curve | Exponential temporal kernel |

If a feature doesn't have a brain analog, it needs a very strong justification.

### 2. Local-first, remote-optional

Everything works offline. No cloud APIs required for core functionality. The graph, NER, embeddings, consolidation — all local. Remote features (shared graphs, cloud embedding APIs) are additive, never required.

### 3. Reinforcement over duplication

If knowledge already exists in the graph, boost its salience — don't create a duplicate. This is the idempotent upsert pattern. It mirrors biological memory: seeing the same thing again doesn't create a new memory, it strengthens the existing one.

### 4. Single graph, many views

One knowledge graph serves all agents and all projects. Cross-domain edges are where intelligence lives — a PR links code to work items, a person links to expertise domains. Per-agent silos would destroy this cross-pollination.

Different agents see different views of the same graph through sensitivity ceilings and domain-relevant weighting — not through separate storage.

### 5. Progressive complexity

- **Tier 1** (5 min): Install, run `setup-extension`, restart CLI. Agents have memory.
- **Tier 2** (10 min): Index code, ingest docs, run consolidation. Memory grows.
- **Tier 3** (optional): GLiNER models, decay tuning, visualization. Power users.

Every tier must work independently. Tier 1 users should never need to understand Tier 3 concepts.

### 6. Engine is tool-agnostic

The myelin engine (graph, NER, consolidation, embeddings, CLI) has zero dependency on any AI coding tool. Copilot CLI, Claude Code, Cursor, Windsurf — the engine doesn't care. Thin adapter layers connect the engine to each tool's extension API.

Today only the Copilot CLI adapter exists. The engine is already portable.

## What We Build vs. What We Don't

### We build

- Knowledge extraction from any text (agent logs, code, documents, meeting transcripts)
- Brain-inspired consolidation with salience scoring and temporal decay
- Semantic + keyword search over a typed knowledge graph
- Procedural memory graduation (stable knowledge becomes permanent)
- Sensitivity classification for access control
- Remote/shared graphs for team knowledge (future)
- Adapters for multiple AI coding tools (future)

### We don't build

- **Document storage** — Myelin stores extracted knowledge, not source documents. Logs are append-only input; the graph is the derived artifact.
- **RAG pipeline** — We're not chunking documents for retrieval. We're extracting entities and relationships into a graph. Different architecture, different purpose.
- **Per-repo extensions** — The extension is personal infrastructure. Don't commit it to repos.
- **Agent definitions** — Myelin provides memory tools. Agent personality, instructions, and behavior are defined elsewhere (e.g., `.agent.md` files). Memory is decoupled from identity.
- **Real-time collaboration** — Shared graphs are eventually consistent, not real-time. This is memory consolidation, not Google Docs.

## Feature Evaluation Filter

When evaluating a proposed feature, ask:

1. **Does it align with the ownership model?** Memory is personal. Sharing comes through shared graphs, not shared tooling.
2. **Does it have a brain analog?** If not, is there a very strong justification?
3. **Does it work local-first?** Can it function with zero network connectivity?
4. **Does it reinforce or duplicate?** Prefer strengthening existing knowledge over creating new entries.
5. **Which tier does it belong to?** Does it increase complexity for Tier 1 users?
6. **Is it engine or adapter?** Engine features are tool-agnostic. Adapter features are tool-specific.

If a feature fails questions 1-3, it's a **no** unless there's exceptional justification.
If it fails 4-6, it needs redesign but the intent may be valid.

## Phases

| Phase | Theme | North Star Feature |
|-------|-------|-------------------|
| 1. Stabilize | Bulletproof the foundation | Reliable install, resilient consolidation |
| 2. Procedural Memory | THE differentiator | Knowledge that graduates to permanent memory |
| 3. Intelligence | Smarter extraction & retrieval | Hybrid NER+LLM, perspective-aware queries |
| 4. Scale | Multi-user & security | Remote graphs, sensitivity enforcement, audit |
