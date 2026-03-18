# Installing Myelin

Myelin gives your Copilot CLI agents persistent, searchable memory across sessions. Install it once, and every agent automatically gets graph-backed tools, context injection, and session logging — no configuration required.

**What you need:** Node.js >= 20 (22+ recommended) and `gh` CLI authenticated. That's it for the package install. The npm path also requires a C++ toolchain for native modules.

---

## Where to Install

Myelin can be installed at two scopes:

| Scope | Location | When to use |
|-------|----------|-------------|
| **User-level** | `~/.copilot/extensions/myelin/` | **Recommended.** Loads for every agent, every project, every session. All agents share one graph. |
| **Project-level** | `.github/extensions/myelin/` | Only loads when the CLI's working directory is that project. Useful for single-project setups. |

**If you run multiple agents** (or plan to), install at the user level. This way Donna, Hebb, Cajal — or whatever agents you build — all share the same knowledge graph and memory infrastructure. No per-project setup needed.

---

## Two Ways to Install

| Method | Best for | What happens |
|--------|----------|-------------|
| **Package install** | Copilot CLI agents | Downloads pre-built extension + native deps only |
| **npm global** | Multi-agent setups, CLI power users | Full npm install, user-level by default |

The package method is **recommended for getting started** — it's faster, avoids common Windows install issues, and supports version tracking with automatic update checks. It installs to the project level (`.github/extensions/`).

For multi-agent environments, **Method 2 (npm global)** is recommended — it installs to `~/.copilot/extensions/myelin/` by default, giving all agents shared memory.

---

## Method 1: Package Install (Recommended)

### Install

Your agent needs the `packages` skill to install myelin. If you already have it, skip to step 2.

**Step 1: Get the packages skill**

Download `packages.cjs` and `SKILL.md` from [`.github/skills/packages/`](https://github.com/shsolomo/myelin/tree/main/.github/skills/packages) into your agent's `.github/skills/packages/` directory:

```bash
# Create the directory and download the files
mkdir -p .github/skills/packages
cd .github/skills/packages
gh api repos/shsolomo/myelin/contents/.github/skills/packages/packages.cjs --jq '.content' | base64 -d > packages.cjs
gh api repos/shsolomo/myelin/contents/.github/skills/packages/SKILL.md --jq '.content' | base64 -d > SKILL.md
cd -
```

Or clone the myelin repo and copy `.github/skills/packages/` manually.

**Step 2: Install myelin**

Tell your agent:

```
> install shsolomo/myelin
```

That's it. Your agent now has memory.

### How it works under the hood

1. The packages skill fetches `.github/registry.json` from the myelin repo via `gh api`
2. It **downloads two files** — `extension.mjs` (pre-built bundle) + `package.json` (runtime deps) — via GitHub's git blob API. Not npm.
3. It runs `npm install --production` **inside the extension directory** — this installs only the native modules the extension needs: `better-sqlite3` and `sqlite-vec`
4. Your agent's local `.github/registry.json` is updated to track the installed version

### After install

Restart your Copilot CLI session. The extension loads automatically — 5 tools + 3 hooks, ready to go.

> **Multi-agent tip:** The package install lands at the project level (`.github/extensions/myelin/`). To share memory across all agents and projects, move it to user level:
> ```bash
> # Move from project to user level
> mkdir -p ~/.copilot/extensions/myelin
> cp .github/extensions/myelin/* ~/.copilot/extensions/myelin/
> cd ~/.copilot/extensions/myelin && npm install --omit=dev
> ```
> Or use Method 2 (npm global) which installs to user level by default.

### Checking for updates

```
> check for updates from shsolomo/myelin
```

The packages skill compares your installed version against the latest in the myelin repo and offers to upgrade. You can also install the `upgrade` skill from `.github/skills/upgrade/` for broader update management.

---

## Method 2: npm Global Install (Recommended for Multi-Agent)

This method installs myelin globally and sets up the extension at user level (`~/.copilot/extensions/myelin/`). All agents share the same extension and knowledge graph regardless of which project they're working in.

### 1. Install myelin

```bash
npm install -g github:shsolomo/myelin
```

Requires Node.js >= 20 (22+ recommended). Native addons (better-sqlite3, sqlite-vec) compile during install — a C++ toolchain is required (Visual Studio Build Tools on Windows, Xcode on macOS, `build-essential` on Linux).

> **Tip:** Add `--legacy-peer-deps` if you see peer dependency conflicts with tree-sitter-bicep.

### 2. Set up the extension

```bash
myelin setup-extension
```

This single command:
- Initializes the graph database (`~/.copilot/.working-memory/graph.db`) if it doesn't exist
- Bundles the extension into `~/.copilot/extensions/myelin/extension.mjs`
- Installs native dependencies for the extension runtime

### 3. Restart Copilot CLI

Start a new Copilot CLI session (or run `/clear`). The extension loads automatically.

### What you get immediately

**5 tools** available to every agent:

| Tool | What it does |
|------|-------------|
| `myelin_query` | Keyword + semantic search over the knowledge graph |
| `myelin_boot` | Load agent-specific context at session start |
| `myelin_log` | Log structured events (decision, finding, error, etc.) |
| `myelin_show` | Inspect a node and its connections |
| `myelin_stats` | Graph statistics and embedding coverage |

**3 automatic hooks** (no agent action needed):

| Hook | What it does |
|------|-------------|
| `onSessionStart` | Auto-detects the agent and injects graph context + tool guidance |
| `onSessionEnd` | Auto-logs a session summary |
| `onErrorOccurred` | Retries on recoverable model errors |

### 4. Index your code (optional but recommended)

```bash
myelin parse ./path/to/your-repo --namespace repo:my-project
```

The `--namespace` flag partitions your graph by source. Use a consistent naming convention like `repo:name` for code and `docs:name` for documents.

Extracts classes, methods, interfaces, functions, and their relationships using tree-sitter. Supports C#, TypeScript, JavaScript, Python, Go, JSON, YAML, Dockerfile, PowerShell, and Bicep.

### 5. Verify everything works

```bash
myelin doctor
```

Shows a color-coded health report: ✅ pass, ⚠️ warning, ❌ fail — with actionable suggestions for anything that needs attention.

**You're done.** Agents now have memory. Sessions are logged automatically, context is injected on start, and relevant knowledge surfaces per-message.

---

## Tier 2: Build Memory (10 minutes)

Grow the knowledge graph from documents and agent activity.

### Ingest documents

```bash
myelin ingest ./path/to/notes --namespace docs:notes
```

Chunks text files, extracts entities (people, tools, decisions, projects), and creates relationship edges. Works with markdown, plain text, meeting recaps — any text content.

Use `--fast` for proximity-only edges (faster):
```bash
myelin ingest ./path/to/notes --namespace docs:notes --fast
```

### Agent logging

Agents log automatically via the extension's `onSessionEnd` hook. You can also log manually during sessions:

```bash
myelin agent log myagent finding "Auth uses JWT with 24h expiry" --tag security
myelin agent log myagent decision "Switch from REST to gRPC for internal services" --tag architecture
```

Log types: `decision`, `action`, `finding`, `error`, `observation`, `handover`

### Consolidate + embed

```bash
myelin sleep
```

One command does it all:
1. Discovers all agents with logs
2. Runs NREM consolidation (replays logs → extracts entities → scores salience → writes to graph)
3. Runs REM refinement (global decay → pruning)

### Schedule nightly maintenance

Run `myelin sleep` on a schedule so memory consolidation happens automatically:

**Linux/macOS (cron):**
```bash
# Edit crontab
crontab -e
# Add this line (runs at 2 AM daily)
0 2 * * * /usr/local/bin/myelin sleep >> /tmp/myelin-sleep.log 2>&1
```

**Windows (Task Scheduler):**
```powershell
$action = New-ScheduledTaskAction -Execute "myelin" -Argument "sleep"
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "Myelin Sleep" -Action $action -Trigger $trigger -Description "Nightly myelin consolidation"
```

---

## Tier 3: Advanced

Optional configuration for power users who want more control.

### IDEA vault indexing

If you use the IDEA method (Initiatives, Domains, Expertise, Archive) for structured notes:

```bash
myelin vault ./path/to/vault
```

### NREM/REM phase control

Run consolidation phases independently for more control:

```bash
# NREM only — replay logs, extract entities, score salience
myelin consolidate --agent myagent --phase nrem

# Full consolidation for a specific agent
myelin consolidate --agent myagent
```

`myelin sleep` runs both phases for all agents. Use `myelin consolidate` when you want per-agent or per-phase control.

### Decay tuning

The REM phase applies salience decay to age out stale knowledge. Nodes below the salience threshold AND older than the age cutoff are pruned. Both conditions must be met — active nodes are never removed regardless of age.

### Sensitivity ceilings

Extension hooks apply default sensitivity ceilings to avoid injecting too much context. These are configurable in agent definitions.

### Index multiple repos

```bash
myelin parse ./frontend --namespace repo:frontend
myelin parse ./backend --namespace repo:backend
myelin parse ./infra --namespace repo:infra
myelin namespaces  # list all indexed namespaces
```

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `myelin init` | Create the graph database (also done by `setup-extension`) |
| `myelin setup-extension` | Bundle and install the Copilot CLI extension |
| `myelin doctor` | Health check with actionable diagnostics |
| `myelin parse <path>` | Index a code repo with tree-sitter (`--namespace`) |
| `myelin ingest <path>` | Ingest text documents with entity extraction (`--namespace`) |
| `myelin vault <path>` | Index an IDEA vault (`--namespace`) |
| `myelin sleep` | Full maintenance cycle (consolidate + embed all agents) |
| `myelin consolidate` | Run consolidation for a specific agent |
| `myelin embed` | Generate embeddings for semantic search |
| `myelin query "<term>"` | Semantic search over the graph |
| `myelin show "<name>"` | Inspect a node and its connections |
| `myelin stats` | Node/edge counts and type distribution |
| `myelin agent boot <name>` | Generate an agent briefing from the graph |
| `myelin agent log <name> <type> "<msg>"` | Log a structured event |
| `myelin agent log-show <name>` | View an agent's log entries |
| `myelin agent instructions <name>` | Generate logging instructions for an agent definition |
| `myelin namespaces` | List indexed namespaces |
| `myelin update` | Update myelin to the latest version |

---

## Optional: Install the Setup Skill

Copy the `myelin-setup` skill so your agent can guide setup interactively:

```bash
# macOS/Linux
cp -r $(npm root -g)/myelin/skills/myelin-setup ~/.copilot/skills/myelin-setup

# Windows (PowerShell)
Copy-Item -Recurse (Join-Path (npm root -g) myelin skills myelin-setup) "$env:USERPROFILE\.copilot\skills\myelin-setup"
```

Then ask your agent: **"set up myelin for this project"**

---

## Troubleshooting

### First step: run `myelin doctor`

```bash
myelin doctor
```

This checks your graph database, schema, node counts, and embedding coverage. Follow any ⚠️ or ❌ recommendations before investigating further.

### Common issues

#### Graph is empty (0 nodes)
You've initialized but haven't indexed anything yet. Run:
```bash
myelin parse ./your-repo --namespace repo:your-repo   # for code
myelin ingest ./your-notes --namespace docs:notes      # for documents
```

#### Extension not loaded
1. Verify the extension exists: check for `~/.copilot/extensions/myelin/extension.mjs`
2. Re-run `myelin setup-extension` if missing
3. Restart Copilot CLI (not just `/clear` — a full restart)

#### Extension fails with NODE_MODULE_VERSION mismatch
The extension's native modules must match the Copilot CLI's Node.js version. Re-run `myelin setup-extension` to recompile.

### Troubleshooting `npm install -g`

If `npm install -g github:shsolomo/myelin` fails, try these workarounds:

<details>
<summary>Common failure modes</summary>

#### Peer dependency conflict (tree-sitter-bicep)
```
npm error ERESOLVE could not resolve
npm error   peerOptional tree-sitter@"^0.22.1" from tree-sitter-bicep@1.1.0
```
**Workaround**: The project includes `.npmrc` with `legacy-peer-deps=true`. If installing manually, add `--legacy-peer-deps`.

#### Native build failures
Native addons (better-sqlite3, tree-sitter) require a C++ toolchain. If compilation fails:
- **Windows**: Install Visual Studio Build Tools (Desktop C++ workload)
- **macOS**: `xcode-select --install`
- **Linux**: `sudo apt install build-essential`

Then retry: `npm install -g github:shsolomo/myelin`

#### Alternative: clone + link
If the global install continues to fail, clone and link instead:
```bash
git clone https://github.com/shsolomo/myelin.git
cd myelin
npm install --legacy-peer-deps
npm run build
npm link
```

</details>

### Tree-sitter native build warnings

Tree-sitter grammars require C++ compilation. If some grammars fail to build, code parsing still works for most languages — only the specific grammar that failed will be unavailable. This is not a blocking issue.

**C++ build tools required:**
- Windows: Visual Studio Build Tools (Desktop C++ workload)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: `build-essential` package

### Node.js 24: tree-sitter C++20 build failure

Node.js 24's V8 headers require C++20, but tree-sitter@0.25.0 forces C++17. Myelin includes a postinstall script that patches this automatically. If you still see `C++20 or later required` errors:

```bash
npm rebuild
```

### Node.js 24 + Visual Studio 2026: node-gyp not recognized

node-gyp does not yet recognize VS 2026 (internal version 18.x):

```powershell
npm config set msvs_version 2022
```

Or if only VS 2026 is installed, patch node-gyp as described in [#7](https://github.com/shsolomo/myelin/issues/7).

### Re-index after graph corruption

Logs are never deleted, so the graph can always be rebuilt from scratch:

```bash
rm ~/.copilot/.working-memory/graph.db      # delete corrupted DB
myelin init                                  # create fresh DB
myelin parse ./your-repo --namespace repo:your-repo  # re-index code
myelin sleep                                 # replay all agent logs
```

