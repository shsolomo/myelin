# Operating Myelin

This guide covers consolidation cadence, migration from flat-file memory systems, and operational best practices.

## Consolidation

### What It Does

`myelin consolidate` runs the brain-inspired two-phase memory cycle:

- **NREM phase**: Replays agent logs, extracts entities via NER, scores salience, writes to graph
- **REM phase**: Applies temporal decay, prunes low-salience nodes, refines edges

### Recommended Cadence

| Pattern | When to Use | How |
|---------|-------------|-----|
| **Per-commit** | Active development sessions | Add to your commit skill/hook: `myelin consolidate --agent <name> && myelin embed` |
| **Hourly cron** | Safety net for long sessions | Schedule `myelin consolidate` at `:00`, `myelin embed` at `:02` |
| **Daily** | Low-activity agents | Run once per day, e.g., end of workday or overnight |

**Recommendation**: Use per-commit as the primary trigger and hourly as the safety net. This mirrors how the brain consolidates - frequently during active learning, with a sweep during downtime.

### Consolidation Is Idempotent

Running `myelin consolidate` twice on the same logs is safe. It reinforces existing nodes (salience boost) without creating duplicates. You cannot over-consolidate.

### Embedding

`myelin embed` generates vector embeddings for nodes that don't have them yet. It is **incremental** - only processes new/changed nodes, not the entire graph. Cost is proportional to new nodes, not total graph size.

Run embed after consolidate to keep semantic search current:

```bash
myelin consolidate --agent <name> && myelin embed
```

### Log Archival

Consolidation reads from agent log files but **never deletes them**. Logs are append-only source material. After consolidation, the log content has been extracted into the graph.

**Best practice**: Archive processed logs after each consolidation run to keep log files manageable. Myelin processes both `.md` (legacy) and `.jsonl` (current) log formats. After the first consolidation of `.md` logs, you can archive the `.md` file.

### Concurrent Runs

**Do not run multiple `myelin consolidate` commands simultaneously.** SQLite handles concurrent reads fine (WAL mode), but concurrent consolidation writes can cause conflicts. If you have both a commit hook and a cron job, the cron should check for a lock file first.

> A proper locking mechanism is planned for a future release (#17).

## Migration from Flat-File Memory

If you are currently using `memory.md` or similar curated context files, here is the migration path.

### What Replaces What

| Old System | Myelin Replacement |
|------------|-------------------|
| `memory.md` (curated boot context) | `myelin agent boot <name>` - loads high-salience nodes from the graph |
| `log.md` (append-only observations) | `myelin_log` tool - structured logging with type, summary, tags |
| Manual context curation | Consolidation pipeline - automatic extraction, scoring, decay |
| Reading entire log at startup | Graph query - only relevant, high-salience nodes returned |

### Migration Steps

1. **Keep `rules.md`** - Operational rules stay as-is. They are constitutional knowledge that does not belong in the graph (yet - see pinned nodes roadmap #8).

2. **Run first consolidation on your existing logs**:
   ```bash
   myelin consolidate --agent <name>
   myelin embed
   ```
   This processes your `.md` and `.jsonl` logs and populates the graph.

3. **Switch logging to `myelin_log`**:
   - In your agent definition, use `myelin_log` instead of appending to `log.md`
   - Log types: `decision`, `action`, `finding`, `error`, `handover`, `observation`

4. **Update your boot sequence**:
   ```
   Old:
   1. Read memory.md
   2. Read log.md (last 7 days)

   New:
   1. Read rules.md (operational rules - stays)
   2. Run myelin_boot (graph context - replaces memory.md)
   3. Read recent myelin logs (replaces reading log.md)
   ```

5. **Archive `memory.md`** - After verifying `myelin_boot` gives good context, archive `memory.md`. The graph is now your memory.

### What About Constitutional Knowledge?

Things like "always use UTC timestamps" or "never commit secrets" - these are rules, not memories. They belong in `rules.md` or in your agent definition, not in the graph.

A future release will add **pinned nodes** (#8) - graph nodes that never decay and always load at boot. This will be the graph-native replacement for `memory.md` content that is too important to decay.

## CLI Quick Reference

```bash
# Graph management
myelin init                    # Create graph database
myelin stats                   # Node/edge counts, embedding coverage
myelin nodes                   # List all nodes
myelin nodes --type Decision   # Filter by type
myelin show <name>             # Inspect a node and its connections

# Feeding the graph
myelin consolidate --agent <n> # Run NREM/REM consolidation cycle
myelin embed                   # Generate embeddings for new nodes
myelin parse ./repo            # Index code via tree-sitter
myelin ingest ./notes          # Index documents via NER
myelin vault ./vault           # Index IDEA-structured notes

# Agent integration
myelin agent boot <name>       # Generate graph briefing for agent
myelin agent log <name> <type> "<summary>"  # Log structured event

# Search
myelin query "search terms"    # Hybrid semantic + keyword search

# Visualization
myelin viz                     # Open graph visualization in browser
```
