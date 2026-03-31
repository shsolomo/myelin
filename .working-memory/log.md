# Working Memory — Log

## 2026-03-31
- nodejs: Node.js 25 fails on macOS — native module compilation breaks. Pinned requirement to Node.js 24 (>=24.0.0 <25.0.0).
- ci: Removed Node 20 and 22 from CI matrices — only testing Node 24 now. If older versions need support later, reintroduce to matrix.
- docs: Version requirement was scattered across 6 files (INSTALL.md, UPGRADE.md, package.json, 2x SKILL.md, 4x CI workflows). Grep sweep confirmed all updated.
