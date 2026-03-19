# Changelog

All notable changes to Myelin are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

For upgrade instructions and breaking change details, see [UPGRADE.md](UPGRADE.md).

## [0.10.6] — 2026-03-19

### Changed
- Migrated all lifecycle hooks to `session.on()` event listeners (boot, task_complete, shutdown)
- Hooks retained as diagnostic stubs only (except `onErrorOccurred` for retry)

### Fixed
- Boot context, session logging, and task-complete logging now reliably fire in multi-extension setups

### Workaround
- Bypasses Copilot CLI hook overwrite bug ([github/copilot-cli#2076](https://github.com/github/copilot-cli/issues/2076))

## [0.10.5] — 2026-03-19

### Changed
- Boot context injection moved from `onSessionStart` hook to `session.on("user.message")` one-shot listener
- Context built eagerly at module load, injected via `session.send()` on first user message

### Added
- Diagnostic hook logging to `myelin-hook-diagnostic.log`

## [0.10.4] — 2026-03-18

### Fixed
- `session` undefined during `joinSession` hook causing silent crash in `onSessionStart`
- ESM import for `@github/copilot-sdk` (was using `require()` incorrectly)

### Changed
- Extracted `buildBootContext()` with self-healing diagnostics and graceful fallback
- Boot context includes health hints and embedding coverage info

## [0.10.3] — 2026-03-18

### Fixed
- `resolveAgent()` now checks `COPILOT_AGENT` env var first (was only checking tool call patterns)
- Agent detection at session start now works reliably

## [0.10.2] — 2026-03-17

### Changed
- Extension distribution artifacts moved from `.github/extensions/myelin/` to `.github/package/myelin/`
- `sourcePath` support in packages skill for path remapping
- User-level install guidance for multi-agent environments

### Added
- `npm run deploy` dev workflow (tsc → bundle → deploy to `~/.copilot/extensions/myelin/`)

## [0.10.1] — 2026-03-16

### Fixed
- Genesis package bundle sync

## [0.10.0] — 2026-03-15

### Added
- `myelin sleep` as single memory command with parallel subprocess-based LLM extraction + REM maintenance
- Watermark-based resumable sleep — interrupted runs resume from last checkpoint
- Archive `.md` log support (reads both `log.jsonl` and `log.md`)
- `myelin_sleep` extension tool with prepare/ingest/complete modes
- Install & upgrade UAT CI workflows

### Changed
- `myelin consolidate` renamed to `myelin sleep` (old name kept as hidden alias)
- `myelin_consolidate` extension tool renamed to `myelin_sleep`
- Single extraction path: LLM-driven (regex extraction removed)
- Stricter person typing, specific relationship guidance, ID normalization

### Removed
- Regex-based entity extraction

## [0.9.0] — 2026-03-10

### Removed
- `onnxruntime-node` fully removed (not even optional)
- GLiNER NER model, local embedding inference, custom tokenizer module
- Code preserved on `archive/onnx-local-inference` branch

### Added
- `myelin_consolidate` extension tool with three-mode consolidation (prepare/ingest/complete)
- Dynamic version string from `package.json`
- Clear message when no embedding model available

### Changed
- LLM-driven consolidation is now the sole extraction engine

## [0.8.0] — 2026-03-05

### Removed
- `@huggingface/transformers` dependency

### Changed
- FTS5 keyword search is now the primary search engine
- `onnxruntime-node` moved to `optionalDependencies`
- Cron auto-registration removed from extension

### Added
- Custom pure-TypeScript tokenizer (WordPiece + Unigram)
- GitHub Actions CI pipeline (Linux, Windows, macOS × Node 20, 22)
- Genesis package integration for distribution

### Fixed
- GLiNER HuggingFace model ID corrected

## [0.7.3] — 2026-02-28

### Removed
- `@huggingface/transformers` dependency and `onnxruntime-web` override

### Added
- Custom tokenizer module for WordPiece and Unigram tokenization
- Embedding model auto-download from HuggingFace

### Changed
- Embedding model cache location: `~/.cache/huggingface/` → `~/.cache/myelin/models/embeddings/`

## [0.7.0] — 2026-02-20

### Added
- GLiNER auto-download from HuggingFace during `setup-extension`
- Pinned nodes (`myelin pin <name>`) — never decay, always load at boot
- NREM/REM cron jobs auto-created on session start
- Extension UAT test suite (54 tests)
- NORTH-STAR.md guiding principles document

### Removed
- `myelin viz` command (interactive D3.js visualization)

### Changed
- GLiNER model location: `<repo>/models/gliner/` → `~/.cache/myelin/models/gliner/`

## [0.6.0] — 2026-02-10

### Added
- `myelin sleep` — single command for full maintenance
- `myelin doctor` — health check with color-coded diagnostics
- Auto-boot — extension auto-detects agent name on session start
- `setup-extension` auto-initializes graph database
- Consolidation resilience (file locking, pre-NREM backups, integrity checks)
- INSTALL.md tiered onboarding

### Fixed
- Parse error reporting with per-file errors and stale node cleanup

## [0.5.0] — 2026-02-01

### Added
- Sensitivity classification (levels 0–3) on nodes
- Sensitivity ceilings on hooks and queries
- `myelin classify` CLI command
- FTS5 fallback when semantic search yields no results
- PRUNE/SKIP traversal modes for `querySubgraph`
- Heartbeat migration (GENESIS memory.md → graph)
- Auto-classification heuristics in NREM consolidation

## [0.4.0] — 2026-01-20

### Added
- NER extraction API server (`myelin serve`)
- Agent self-identification via tool call patterns
- Comprehensive test suite (274 tests, 12 files)
- Central extension integration as primary agent interface

### Changed
- License: MIT → Apache-2.0

## [0.3.1] — 2026-01-10

### Added
- Initial public release
- Core knowledge graph with typed nodes and weighted edges
- NER extraction, embeddings, consolidation pipeline
- Tree-sitter code parsing (10 languages)
- Copilot CLI extension with tools and hooks
- CLI commands for parse, ingest, query, and maintenance

[0.10.6]: https://github.com/shsolomo/myelin/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/shsolomo/myelin/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/shsolomo/myelin/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/shsolomo/myelin/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/shsolomo/myelin/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/shsolomo/myelin/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/shsolomo/myelin/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/shsolomo/myelin/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/shsolomo/myelin/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/shsolomo/myelin/compare/v0.7.0...v0.7.3
[0.7.0]: https://github.com/shsolomo/myelin/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/shsolomo/myelin/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/shsolomo/myelin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/shsolomo/myelin/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/shsolomo/myelin/releases/tag/v0.3.1
