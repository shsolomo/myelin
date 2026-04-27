# Spike: Episodic Memory Harness — Chamber & DRI Copilot

> **Author:** Hebb | **Date:** 2026-04-27 | **Status:** Analysis complete
> **Question:** How do our `EpisodicSource` / episodic search interfaces map to Chamber and DRI Copilot's session data?

---

## 1. Our Interfaces (Myelin v2)

### EpisodicSource (ingestion)

```typescript
interface EpisodicSource {
  readSince(agent: string, watermark: string | null): LogEntry[];
}

interface LogEntry {
  timestamp: string;
  type: string;       // decision, action, finding, error, observation, handover
  agent: string;
  summary: string;
  detail?: string;
  tags?: string[];
  entities?: LogEntityRef[];        // pre-extracted
  relationships?: LogRelationshipRef[];  // pre-extracted
}
```

**Current implementation:** `LogFileSource` — reads `~/.copilot/.working-memory/agents/{agent}/log.jsonl`. One line per structured event. Watermark-based resume.

### Episodic Search (retrieval — not yet implemented)

Architecture spec (§4.4) defines the episodic store as one of three searchable layers:

| Layer | Content | Technology | Query Signals |
|-------|---------|-----------|---------------|
| **Episodic** | Raw session events | AI Search (cloud) / JSONL grep (local) | Temporal markers, verbatim |
| **Semantic** | Consolidated graph | FTS5 + vector KNN | Concept/pattern queries |
| **Procedural** | Rules + tasks | FTS5 + context-matching | How-to queries |

The episodic store answers: *"What exact command did we run yesterday?"* — time-bounded, verbatim, filterable by agent/session/file path.

### SessionFsProvider (Chamber streaming path)

Architecture spec (§7.2) describes the **real** Chamber integration:

```typescript
interface SessionFsProvider {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<SessionFsFileInfo>;
  mkdir(path: string, recursive: boolean): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, recursive: boolean, force: boolean): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
}
```

When myelin implements this, we **become the storage layer** and see every SDK session event as it's written. This eliminates batch log replay entirely.

---

## 2. Chamber Session Data Model

### Architecture

Chamber is an **Electron + React desktop app** using `@github/copilot-sdk`. Monorepo structure:

```
apps/desktop     — Electron main process
apps/web         — Vite + React renderer
apps/server      — Loopback HTTP + WS server
packages/shared  — Shared types (ChatMessage, ContentBlock)
packages/services — ChatService, ChatroomService, MindManager
```

### Session Lifecycle

| Component | Persistence | Format |
|-----------|------------|--------|
| **Single-agent chat** | ❌ Ephemeral (streamed, not stored) | ChatEvent union via IPC |
| **Chatroom** | ✅ `{userData}/chatroom.json` | ChatroomTranscript JSON |
| **Mind metadata** | ✅ `~/.chamber/config.json` | AppConfig v2 |
| **SDK sessions** | SDK-managed, recreated on stale errors | CopilotSession objects |

### ChatMessage (the canonical turn)

```typescript
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: ContentBlock[];           // ordered content units
  timestamp: number;                // Unix ms
  isStreaming?: boolean;
  sender?: { mindId: string; name: string };
}

type ContentBlock =
  | { type: 'text'; sdkMessageId?: string; content: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string;
      status: 'running' | 'done' | 'error';
      arguments?: Record<string, unknown>;
      output?: string; error?: string; parentToolCallId?: string }
  | { type: 'reasoning'; reasoningId: string; content: string }
  | { type: 'image'; name: string; mimeType: string; dataUrl: string };
```

### ChatroomMessage (multi-agent, persisted)

```typescript
interface ChatroomMessage extends ChatMessage {
  sender: { mindId: string; name: string };
  roundId: string;
  orchestrationMode?: OrchestrationMode;
}

interface ChatroomTranscript {
  version: 1;
  messages: ChatroomMessage[];       // max 500
  taskLedger?: TaskLedgerItem[];
}
```

### Streaming Events

```typescript
type ChatEvent =
  | { type: 'chunk'; sdkMessageId?: string; content: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_progress'; toolCallId: string; message: string }
  | { type: 'tool_output'; toolCallId: string; output: string }
  | { type: 'tool_done'; toolCallId: string; success: boolean; result?: string; error?: string }
  | { type: 'reasoning'; reasoningId: string; content: string }
  | { type: 'message_final'; sdkMessageId: string; content: string }
  | { type: 'reconnecting' | 'done' | 'error'; ... };
```

---

## 3. DRI Copilot Session Data Model

### Architecture

DRI Copilot is a **Python-based multi-agent system** deployed as an Azure ML Online Endpoint. Surfaces in Teams, M365, and web.

```
User Question → Agent Planner → Agent Executor → Skill Planner → Skill Executor → Final Chat → Response
```

### Session Lifecycle

| Component | Persistence | Format |
|-----------|------------|--------|
| **CurrentContext** | ❌ In-memory per request | Python object |
| **Chat History** | ✅ Passed by frontend each request | List[Dict] (round entries) |
| **Progressive Messages** | ✅ Azure Blob (`conversation-progressive-messages`) | JSON (ProgressiveMessageStore) |
| **Telemetry** | ✅ App Insights | Structured JSON |
| **Investigation Graph** | ✅ Cosmos DB (Gremlin API) | Graph nodes/edges |

### Chat History Round (the canonical unit)

```python
# Each round in chat_history:
{
  "inputs": {
    "question": "Tell me about incident 123"
  },
  "outputs": {
    "request_count": 0,           # which user question (0-indexed)
    "round_count": 0,             # agent execution order within request
    "answer": "Found incident...",
    "skill_data": {               # keyed by skill name
      "icm.get_icms": [...],
      "tsg.get_tsgs": [...]
    },
    "skills_wt_argument": [       # skill calls with args
      {"skill": "icm.get_icms", "args": {...}, "user_intent": "...", "goal": "..."}
    ],
    "agent_context": {            # which agent ran
      "agent_name": "ICMusingllm",
      "goal": "Investigate incident",
      "description": "..."
    },
    "additional_instruction_for_chat": {...},
    "additional_instruction_for_manager": "..."
  }
}
```

### Formatted History (prompt injection)

```xml
<Round>
  <Round Number>0</Round Number>
  <user>Tell me about incident 123</user>
  <Agent>
    <Agent Count>0</Agent Count>
    <Agent Definition>Name: ICMusingllm, Agent Goal: ...</Agent Definition>
    <tool call>
      Skill: icm.get_icms
      Arguments: {...}
      Result: {...}
      Retrieved Items: [...]
    </tool call>
    <assistant response>Found incident...</assistant response>
  </Agent>
</Round>
```

### CallerMetadata

```python
@dataclass
class CallerMetadata:
    user_id: str                           # email
    conversation_id: str                   # UUID
    back_channel_entry_location: str       # blob URL for progressive messages
    user_queues: List[str]                 # team queues
    is_conversation_saving_enabled: bool   # privacy flag
```

---

## 4. Mapping Analysis

### 4.1 Chamber → EpisodicSource

**Path A: SessionFsProvider (Phase 2 — target)**

This is the architecture-spec path. Myelin implements SessionFsProvider → we see every SDK I/O event as it happens. No mapping needed — we ARE the storage layer. Events flow through us in real-time.

- Eliminates watermark tracking (streaming, not batch)
- Eliminates log file parsing (direct event observation)
- Enables real-time extraction (NREM becomes streaming, not batch)

**Path B: ChatMessage scraping (Phase 1 bridge — if needed before SessionFsProvider)**

| Chamber Field | → LogEntry Field | Notes |
|---------------|-----------------|-------|
| `ChatMessage.timestamp` | `timestamp` | Unix ms → ISO string |
| `ChatMessage.role` | — | Implicit in `type` mapping |
| `blocks[type='text'].content` | `summary` | Main text content |
| `blocks[type='tool_call'].toolName` | `type = 'action'` | Tool executions → actions |
| `blocks[type='tool_call'].output` | `detail` | Tool output |
| `blocks[type='reasoning'].content` | `type = 'observation'` | Reasoning traces |
| `ChatroomMessage.sender.name` | `agent` | Mind/agent identity |
| `ChatroomMessage.roundId` | `tags: ['round:{id}']` | Conversation threading |
| `ChatroomMessage.orchestrationMode` | `tags: ['orch:{mode}']` | Orchestration context |

**Gap:** Single-agent chat is ephemeral — no persistence layer to read from. Only chatroom messages survive. For single-agent sessions, we'd need to either:
1. Hook into `ChatEvent` stream at the IPC level (invasive, fragile)
2. Wait for SessionFsProvider integration (correct path)

**Recommendation:** Skip Path B. Go straight to SessionFsProvider for Chamber. The bridge gap is acceptable because Chamber users can run NREM on CLI-side logs in the interim.

### 4.2 DRI Copilot → EpisodicSource

DRI Copilot's architecture is fundamentally different: **stateless per-request, frontend owns history.**

| DRI Field | → LogEntry Field | Notes |
|-----------|-----------------|-------|
| `outputs.answer` | `summary` | Final answer text |
| `inputs.question` | `detail` (or separate LogEntry with `type='observation'`) | User question |
| Chat round timestamp | `timestamp` | Must be synthesized (not in data model — frontend adds it) |
| `outputs.agent_context.agent_name` | `agent` | Which DRI agent ran |
| `outputs.skills_wt_argument[].skill` | `tags: ['skill:{name}']` | Skills invoked |
| `outputs.skill_data` | `entities` | Pre-extracted entities from skill outputs (ICMs, TSGs) |
| `outputs.agent_context.goal` | `tags: ['goal:{goal}']` | Agent intent |
| `caller_metadata.conversation_id` | `tags: ['session:{id}']` | Conversation threading |
| `caller_metadata.user_id` | `tags: ['user:{id}']` | User attribution |

**Key structural difference:** DRI Copilot's "round" is richer than a single LogEntry. One round contains:
- User question
- Agent selection decision
- Multiple skill calls with arguments + results
- Retrieved items (RAG context)
- Final answer

**Mapping strategy:** One DRI round → multiple LogEntries:

```
Round N →
  LogEntry(type='observation', summary=question)           # user intent
  LogEntry(type='decision', summary='Selected agent: {name}, goal: {goal}')  # agent selection
  LogEntry(type='action', summary='Skill: {name}', detail=JSON(result))      # per skill call
  LogEntry(type='finding', summary=answer)                 # final answer
```

**Entity extraction from skill_data:** DRI skill outputs are already structured — ICM incidents, TSGs, code snippets. These map to LogEntityRef:

```typescript
// ICM skill output → entity
{ id: 'icm-{icmId}', name: 'ICM {title}', type: 'entity', description: 'Incident...' }
// TSG skill output → entity  
{ id: 'tsg-{tsgId}', name: '{tsg_title}', type: 'knowledge', description: '...' }
```

**Ingestion path:** DRI Copilot is a cloud service — no local files to read. Options:
1. **Blob Storage adapter** — read progressive message blobs (async tasks only)
2. **App Insights adapter** — query telemetry for structured session data
3. **Frontend hook** — capture chat_history at the Teams/web frontend layer
4. **HTTP endpoint** — DRI exposes session data via API (requires them to add one)

**Recommendation:** App Insights adapter is the most pragmatic. Telemetry already captures every action with structured metadata. Write an `AppInsightsEpisodicSource` that queries Kusto-backed App Insights logs.

### 4.3 EpisodicSearchable — Interface Design

Neither repo has an episodic search API. This is new. Based on the architecture spec's three-layer search model:

```typescript
interface EpisodicSearchable {
  // Temporal search — "what happened yesterday?"
  searchByTime(params: {
    agent?: string;
    since?: string;          // ISO timestamp
    until?: string;
    limit?: number;
  }): EpisodicSearchResult[];

  // Verbatim search — "what exact command did we run for auth?"
  searchByContent(params: {
    query: string;           // keyword/phrase search
    agent?: string;
    sessionId?: string;      // scope to specific session
    limit?: number;
  }): EpisodicSearchResult[];

  // Provenance drill-down — "which sessions produced this graph node?"
  searchByNodeProvenance(params: {
    nodeId: string;          // graph node to trace back
    limit?: number;
  }): EpisodicSearchResult[];
}

interface EpisodicSearchResult {
  entry: LogEntry;
  sessionId: string;
  score: number;             // relevance score
  highlight?: string;        // matched snippet
}
```

**Implementation per platform:**

| Platform | searchByTime | searchByContent | searchByNodeProvenance |
|----------|-------------|----------------|----------------------|
| **CLI (local)** | JSONL grep with timestamp filter | FTS5 over indexed sessions (or grep) | Provenance table JOIN |
| **Chamber** | SessionFsProvider read + filter | AI Search (Phase 3) | Provenance table JOIN |
| **DRI Copilot** | App Insights KQL time filter | App Insights KQL text search | Not applicable (no myelin graph) |

---

## 5. Structural Comparison

| Dimension | Chamber | DRI Copilot | Myelin EpisodicSource |
|-----------|---------|-------------|----------------------|
| **Language** | TypeScript (ESM) | Python (Pydantic) | TypeScript (ESM) |
| **Session identity** | SDK CopilotSession (ephemeral) | conversation_id (UUID from frontend) | agent + watermark timestamp |
| **Turn identity** | ChatMessage.id (UUID) | request_count + round_count | LogEntry.timestamp |
| **Message shape** | ContentBlock union (text, tool_call, reasoning, image) | Round dict with inputs/outputs | LogEntry (flat: type, summary, detail) |
| **Agent identity** | MindId (directory path) | agent_name from YAML config | agent string |
| **Tool calls** | ContentBlock type='tool_call' | skills_wt_argument list | type='action' + entities |
| **Persistence** | Chatroom JSON (local file), single-chat ephemeral | Frontend-owned (stateless backend), blob for async | JSONL files (append-only) |
| **Search** | None (sessions not indexed) | App Insights KQL | None (planned: FTS5 + AI Search) |
| **Privacy** | Per-mind config | is_conversation_saving_enabled flag | privacy tier (private/team-eligible/team) |
| **Multi-agent** | Chatroom with orchestration modes | meta_plan with sequential agent execution | sourceAgent field on nodes |

---

## 6. Recommendations

### Immediate (Phase 1 — CLI mode)

1. **No changes needed for Chamber or DRI.** Current `LogFileSource` works for CLI mode. The extension shim logs structured events to JSONL. This path is proven and stable.

2. **Add `EpisodicSearchable` to StorageAdapter.** Extend the adapter interface with time-based and content-based search over indexed session data. Implementation: FTS5 virtual table over a new `session_events` table (mirrors LogEntry schema).

### Near-term (Phase 2 — Chamber integration)

3. **Implement `MyelinSessionFsProvider`.** This is the critical integration piece. When Chamber calls `writeFile`/`appendFile` through the SDK, myelin intercepts:
   - Writes session events to local SQLite `session_events` table
   - Feeds events into streaming NREM (extract as they arrive)
   - Supports `readFile`/`readdir` for session replay

4. **Map ChatMessage → LogEntry at the SessionFsProvider boundary.** The SDK writes JSON files with session state. Parse the SDK's file format (need to reverse-engineer what the SDK actually writes through SessionFsProvider — **this is open spike N2**).

5. **Skip the ChatMessage scraping bridge.** Going directly to SessionFsProvider is cleaner and architecturally correct.

### Medium-term (Phase 3 — cloud + DRI integration)

6. **Build `AppInsightsEpisodicSource` for DRI Copilot.** Queries App Insights telemetry via Kusto to reconstruct session data. The TelemetryEntry structure is rich enough to map to LogEntry. Requires DRI team to expose or share their App Insights workspace.

7. **Build Azure AI Search episodic index.** Both Chamber (via SessionFsProvider writes to blob) and DRI (via App Insights export) feed into a shared AI Search index. This enables the full three-layer search model.

### Open Questions (Need Ian + DRI team input)

- **N2 (SessionFsProvider wiring):** What exactly does the Copilot SDK write through SessionFsProvider? File paths, JSON schema, event types? Need to prototype with Ian.
- **DRI conversation persistence:** The DRI backend is stateless — does the Teams/web frontend persist chat_history anywhere queryable? Or is App Insights the only durable record?
- **Privacy alignment:** DRI's `is_conversation_saving_enabled` maps to our privacy tiers, but the mechanics differ. Need to align on what "private" means for cross-system episodic search.
- **Timestamp gap in DRI:** DRI round entries don't carry timestamps at the data model level (frontend adds them). For `searchByTime`, we'd need either frontend cooperation or App Insights timestamps.
