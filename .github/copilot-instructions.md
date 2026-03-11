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
