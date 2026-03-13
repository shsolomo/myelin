# Myelin — Copilot Instructions

## Testing Rule

**All code changes must ship with tests unless impractical.**

"Impractical" means: CLI command wiring (Commander glue), visualization servers (HTTP/WebSocket), or code that requires external services (model downloads, ONNX runtime) that can't be mocked.

Everything else — graph operations, extraction logic, parsers, consolidation, structured logging, factories, scoring — must have corresponding tests in `tests/`.

### How to Test

```bash
npm test              # vitest run — all tests
npm run test:watch    # vitest — watch mode
```

### Test Conventions

- Mirror `src/` structure in `tests/` (e.g., `src/memory/graph.ts` → `tests/memory/graph.test.ts`)
- Use `:memory:` SQLite databases for graph tests (no temp files needed)
- Mock `ner.ts` with `vi.mock()` to avoid ONNX dependency in unit tests
- Use `os.tmpdir()` for tests that need filesystem operations
- Import from source (`../../src/...`) not from `dist/`

### CI

Tests run on every push and PR via GitHub Actions. The pipeline tests across:
- **OS**: ubuntu-latest, windows-latest, macos-latest
- **Node**: 20, 22

Tests are unconditional — they always run. If tests fail, the build fails.

## Project Structure

### Team
- **Shane Solomon**  Owner
- **Hebb**  Myelin Lead (architecture, research, product direction)
- **Cajal**  Myelin Engineer (implementation, bugs, testing, CI)

Cajal reports to Hebb. Hebb reports to Shane. For architectural decisions, Cajal defers to Hebb. For routine coding, Cajal has full autonomy.

### Tracking

- **Issues**: GitHub Issues on `shsolomo/myelin`
- **Milestones**: Phase 1 (Stabilize)  Phase 2 (Procedural Memory)  Phase 3 (Intelligence)  Phase 4 (Scale)
- **Pillar labels**: `pillar:foundation`, `pillar:procedural-memory`, `pillar:intelligence`, `pillar:scale`
- **Beta label**: `beta-reported` for issues from Myelin Beta channel testers
- **Roadmap**: `vault/initiatives/myelin/next-actions.md` is the source of truth

### Process: Idea  Ship

1. **Capture**: New idea surfaces (beta chat, session, research)  file a GitHub Issue with appropriate `pillar:*` label
2. **Triage**: Hebb reviews for architectural fit and assigns to a milestone (phase)
3. **Design**: For non-trivial features, Hebb writes a design spec or architecture note (vault or issue comments)
4. **Implement**: Cajal builds from the spec. All code changes require tests (see Testing Rule above).
5. **Review**: Hebb reviews for architectural consistency. Shane approves.
6. **Ship**: Merge, tag if releasing, update roadmap.

New issues that don't fit an existing milestone go to **Backlog** (no milestone assigned) until the next planning session.

### Conventions

- **Branch naming**: `feature/<issue-number>-short-desc` or `fix/<issue-number>-short-desc`
- **Commit messages**: Reference the issue number (e.g., `Add pinned node support (#8)`)
- **Research notes**: Go in `vault/expertise/shared-knowledge-graph/research/`
- **Architecture decisions**: Logged via `myelin_log` with type `decision`
