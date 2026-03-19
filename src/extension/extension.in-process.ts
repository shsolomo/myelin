/**
 * Myelin — Copilot CLI Extension
 *
 * This is the SOURCE file that gets bundled by esbuild into a single extension.mjs.
 * It imports myelin's graph library directly — no subprocess spawning.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats, myelin_sleep
 * Hooks: Diagnostic-only (CLI v1.0.8 #2076 overwrites them in multi-extension setups)
 * Events: session.on("user.message") for boot, session.on("session.task_complete") for
 *         auto-logging, session.on("session.shutdown") for session-end fallback
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, appendFileSync } from "node:fs";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { KnowledgeGraph } from "../memory/graph.js";
import { getBootContext, resolveAgent, appendStructuredLog } from "../memory/agents.js";
import { readLogEntries } from "../memory/structured-log.js";
import { getEmbedding } from "../memory/embeddings.js";
import { prepareSleep, ingestExtractions, remRefine, runIntegrityChecks, getWatermark } from "../memory/replay.js";

const WORKING_MEMORY = join(homedir(), ".copilot", ".working-memory");
const DB_PATH = join(WORKING_MEMORY, "graph.db");
const HOOK_LOG = join(WORKING_MEMORY, "myelin-hook-diagnostic.log");
declare const __MYELIN_VERSION__: string;
const MYELIN_VERSION = __MYELIN_VERSION__;

function hookLog(msg: string) {
  try {
    appendFileSync(HOOK_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore write failures */ }
}

// Session-level agent identity — set when myelin_boot is called
let sessionAgent: string | null = null;
let taskCompleteLogged = false;
// Build boot context eagerly at module load time.
// CLI v1.0.8 has a bug where multiple extensions with hooks overwrite each other
// (last extension to resume wins — updateOptions does this.hooks = e.hooks, not merge).
// So hooks are unreliable. Instead, we inject context via session.send() on first
// user.message event, which uses the event listener API and is not affected by the bug.
let eagerBootContext: string | null = null;
try {
  eagerBootContext = buildBootContext();
  const agentLabel = sessionAgent ?? resolveAgent() ?? "generic";
  console.error(`[myelin] v${MYELIN_VERSION} loaded — 6 tools. agent=${agentLabel}, context=${eagerBootContext ? eagerBootContext.length + ' chars' : 'none'}`);
} catch (e: any) {
  console.error(`[myelin] Boot context build failed: ${e.message}`);
}

/** Get a graph instance, or null if db doesn't exist. */
function getGraph(): KnowledgeGraph | null {
  if (!existsSync(DB_PATH)) return null;
  return new KnowledgeGraph(DB_PATH);
}

/** Build the boot context string — graph briefing, recent logs, tool guidance, health hints. */
function buildBootContext(): string | null {
  if (!existsSync(DB_PATH)) return null;

  const detectedAgent = sessionAgent || resolveAgent();
  if (detectedAgent && !sessionAgent) {
    sessionAgent = detectedAgent;
  }

  const contextParts: string[] = [];

  // Graph briefing
  try {
    const briefing = getBootContext(detectedAgent, { dbPath: DB_PATH });
    if (briefing) contextParts.push(briefing);
  } catch (bootErr: any) {
    hookLog(`buildBootContext: graph boot failed: ${bootErr.message}`);
  }

  // Unconsolidated agent activity logs
  if (detectedAgent) {
    try {
      let watermark: string | null = null;
      try {
        const graph = new KnowledgeGraph(DB_PATH);
        try {
          watermark = getWatermark(graph, detectedAgent);
        } finally {
          graph.close();
        }
      } catch { /* graph not accessible */ }

      const recentLogs = readLogEntries(detectedAgent, {
        ...(watermark ? { sinceTimestamp: watermark } : {}),
        limit: 15,
      });
      if (recentLogs.length > 0) {
        const logLines: string[] = [
          "",
          `## Recent Activity — ${detectedAgent}`,
          watermark
            ? `_${recentLogs.length} unconsolidated entries (since ${watermark.slice(0, 16)}Z) — older activity is in the graph_`
            : `_Last ${recentLogs.length} entries (no watermark — run \`myelin sleep\` to consolidate)_`,
          "",
          "| Time | Type | Summary |",
          "|------|------|---------|",
        ];
        for (const entry of recentLogs) {
          const time = entry.ts.slice(0, 16).replace("T", " ");
          const summary = entry.summary.slice(0, 80);
          logLines.push(`| ${time} | ${entry.type} | ${summary} |`);
        }
        contextParts.push(logLines.join("\n"));
      }
    } catch {
      // Silent — don't break boot for log read failure
    }
  }

  // Tool guidance
  contextParts.push(
    "",
    "## Myelin — When to Use These Tools",
    "",
    "You have a persistent knowledge graph with extracted entities, relationships, and agent history.",
    "Use myelin tools for **conceptual, historical, and cross-domain** questions. Use grep/glob/view for **textual and file-level** searches.",
    "",
    "| Question type | Use | Why |",
    "|---|---|---|",
    "| Find a specific string in code | `grep` | Exact text match, line-level results |",
    "| Find a file by name/pattern | `glob` | Pattern matching on file paths |",
    "| Read a known file | `view` | Direct file access |",
    "| How does auth work? | `myelin_query` | Conceptual — finds relationships across code, docs, and agent history |",
    "| What did we decide about caching? | `myelin_query` | Historical — past decisions logged by agents over time |",
    "| Who worked on the API? | `myelin_query` | Cross-domain — connects people to code to decisions |",
    "| What's this node connected to? | `myelin_show` | Graph exploration — follow edges and relationships |",
    "",
    "**Tool reference:**",
    "- **myelin_query** — Search by meaning across all knowledge (code, people, decisions, patterns). Use for 'how', 'why', 'who', and conceptual questions.",
    "- **myelin_boot** — Load agent-specific context. Call with your agent name for a richer domain briefing.",
    "- **myelin_log** — Record important decisions, findings, errors, and observations. These feed future sleep cycles into the graph.",
    "- **myelin_show** — Inspect a specific node and its connections. Use after finding a node via query to explore its edges.",
    "- **myelin_stats** — Check graph health: node/edge counts, type distribution, embedding coverage.",
  );

  // Health hints
  const healthGraph = getGraph();
  if (healthGraph) {
    try {
      const healthStats = healthGraph.stats();
      if (healthStats.nodeCount === 0) {
        contextParts.push("", "💡 Graph is empty — run `myelin parse ./your-repo` to index code");
      } else {
        const embStats = healthGraph.embeddingStats();
        if (!embStats.vecAvailable || embStats.embeddedNodes === 0) {
          contextParts.push("", "ℹ️ Search uses FTS5 keywords. Run `myelin embed` to add optional semantic boost.");
        }
      }
    } catch {
      // Silent
    } finally {
      healthGraph.close();
    }
  }

  return contextParts.length > 0 ? contextParts.join("\n") : null;
}


const session = await joinSession({
  onPermissionRequest: approveAll,

  hooks: {
    onSessionStart: async () => { hookLog(`onSessionStart fired — v${MYELIN_VERSION}`); },
    onUserPromptSubmitted: async () => {},
    onSessionEnd: async () => { hookLog('onSessionEnd fired'); },
    onPostToolUse: async () => { hookLog('onPostToolUse fired'); },
    onErrorOccurred: async (input: any) => {
      hookLog('onErrorOccurred fired');
      // Keep retry as best-effort — needs return value, can't do from events
      if (input.recoverable && input.errorContext === "model_call") {
        return { errorHandling: "retry" as const, retryCount: 2 };
      }
    },
  },

  tools: [
    {
      name: "myelin_query",
      description:
        "Search the knowledge graph by meaning. Use for conceptual questions (how, why, who), past decisions, cross-domain relationships, and historical context. Prefer grep/glob for exact text or file searches in code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 10)" },
          ceiling: { type: "number", description: "Max sensitivity level 0-3 (default: 1). Filters out nodes above this level." },
        },
        required: ["query"],
      },
      handler: async (args: any) => {
        const graph = getGraph();
        if (!graph) return "No graph database found. Run `myelin init` first.";

        try {
          const limit = args.limit || 10;
          const ceiling = args.ceiling ?? 1;

          // Primary path: FTS5 keyword search (always available)
          const ftsResults = graph.queryByKeyword(args.query, limit, ceiling);

          // If FTS5 returned enough results, skip semantic search for speed
          if (ftsResults.length >= limit) {
            const lines = ftsResults.map((r: any) =>
              `[${r.score.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) — ${r.node.description?.slice(0, 100)}`
            );
            return `Search: '${args.query}' (${ftsResults.length} results, ceiling=${ceiling})\n${lines.join("\n")}`;
          }

          // Optional boost: semantic search when embeddings available
          let semanticResults: Array<{ node: any; score: number }> = [];
          try {
            const queryEmbedding = await getEmbedding(args.query);
            if (queryEmbedding.length > 0) {
              const vecResults = graph.semanticSearch(queryEmbedding, limit, undefined, undefined, ceiling);
              semanticResults = vecResults.map((r: any) => ({
                node: r.node,
                score: 1 / (1 + r.distance),
              }));
            }
          } catch {
            // Embeddings not available — that's fine
          }

          // Merge: dedup by node ID, prefer higher score
          const merged = new Map<string, { node: any; score: number }>();
          for (const r of ftsResults) {
            merged.set(r.node.id, r);
          }
          for (const r of semanticResults) {
            const existing = merged.get(r.node.id);
            if (!existing || r.score > existing.score) {
              merged.set(r.node.id, r);
            }
          }

          const results = [...merged.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          if (results.length === 0) return `No results for '${args.query}'`;

          const searchType = semanticResults.length > 0 ? 'Hybrid search' : 'Search';
          const lines = results.map((r: any) =>
            `[${r.score.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) — ${r.node.description?.slice(0, 100)}`
          );
          return `${searchType}: '${args.query}' (${results.length} results, ceiling=${ceiling})\n${lines.join("\n")}`;
        } catch (e: any) {
          await session.log(`myelin_query error: ${e.message}`, { level: "error" });
          return `Error: ${e.message}`;
        } finally {
          graph.close();
        }
      },
    },
    {
      name: "myelin_boot",
      description:
        "Load domain-specific knowledge from the graph for a named agent. Call once at session start with your agent name for a richer briefing than auto-boot provides.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Your agent name — used to load agent-specific graph context" },
        },
        required: ["agent"],
      },
      handler: async (args: any) => {
        try {
          sessionAgent = args.agent;
          return getBootContext(args.agent, { dbPath: DB_PATH });
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: "myelin_log",
      description:
        "Log a structured event to an agent's knowledge log. Use to record decisions, findings, errors, and observations worth remembering across sessions. These logs feed into sleep cycles — important events become graph knowledge.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name" },
          type: {
            type: "string",
            description: "Event type",
            enum: ["decision", "action", "finding", "error", "handover", "observation"],
          },
          summary: { type: "string", description: "One-line summary" },
          detail: { type: "string", description: "Extended detail or context for richer log entries" },
          tags: { type: "string", description: "Comma-separated tags" },
          sensitivity: { type: "number", description: "Sensitivity level 0-3 (default: 0). Controls visibility during sleep cycles." },
          sensitivity_reason: { type: "string", description: "Why this entry has elevated sensitivity (e.g., 'contains credentials', 'internal architecture')" },
        },
        required: ["agent", "type", "summary"],
      },
      handler: async (args: any) => {
        try {
          const tags = args.tags ? args.tags.split(",").map((t: string) => t.trim()) : undefined;
          const context: Record<string, unknown> = {};
          if (args.sensitivity !== undefined) context.sensitivity = args.sensitivity;
          if (args.sensitivity_reason) context.sensitivityReason = args.sensitivity_reason;
          appendStructuredLog(args.agent, args.type, args.summary, {
            tags,
            detail: args.detail,
            context: Object.keys(context).length > 0 ? context : undefined,
          });
          return `✅ ${args.agent}: ${args.summary}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: "myelin_show",
      description: "Show a knowledge graph node and its connections. Use after finding a node via myelin_query to explore its edges, related entities, and tags.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Node name or partial name" },
        },
        required: ["name"],
      },
      handler: async (args: any) => {
        const graph = getGraph();
        if (!graph) return "No graph database found.";

        try {
          const nodes = graph.searchNodes(args.name, 1);
          if (nodes.length === 0) return `No node matching '${args.name}'`;

          const node = nodes[0];
          const edges = graph.getEdges(node.id);
          const tags = graph.getTags(node.id);

          let result = `${node.type} | ${node.name}\n`;
          result += `Salience: ${node.salience.toFixed(2)} | Agent: ${node.sourceAgent}\n`;
          result += `Description: ${node.description}\n`;
          if (tags.length > 0) result += `Tags: ${tags.join(", ")}\n`;
          if (edges.length > 0) {
            result += `\nConnections (${edges.length}):\n`;
            for (const e of edges) {
              const target = e.sourceId === node.id ? e.targetId : e.sourceId;
              const dir = e.sourceId === node.id ? "→" : "←";
              const other = graph.getNode(target);
              result += `  ${dir} ${e.relationship}: ${other?.name ?? target}\n`;
            }
          }
          return result;
        } finally {
          graph.close();
        }
      },
    },
    {
      name: "myelin_stats",
      description: "Show knowledge graph statistics: node/edge counts, type distribution, and embedding coverage. Use to check graph health or verify indexing worked.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const graph = getGraph();
        if (!graph) return "No graph database found.";

        try {
          const stats = graph.stats();
          const embStats = graph.embeddingStats();
          return [
            `Nodes: ${stats.nodeCount}`,
            `Edges: ${stats.edgeCount}`,
            `Avg salience: ${stats.avgSalience}`,
            `Embedded: ${embStats.embeddedNodes}/${embStats.totalNodes} (${embStats.coveragePct.toFixed(1)}%)`,
            `Type distribution:`,
            ...Object.entries(stats.typeDistribution).map(([t, c]) => `  ${t}: ${c}`),
          ].join("\n");
        } finally {
          graph.close();
        }
      },
    },
    {
      name: "myelin_sleep",
      description:
        "Run LLM-driven memory sleep cycle. Use mode 'prepare' to read pending agent logs and get extraction schema, 'ingest' to write LLM extraction results to the graph, 'complete' to run decay/prune cleanup.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["prepare", "ingest", "complete"],
            description: "prepare: read logs + get schema, ingest: write extractions to graph, complete: REM decay/prune",
          },
          agent: {
            type: "string",
            description: "Agent name (required for prepare mode)",
          },
          extractions: {
            type: "array",
            items: { type: "string" },
            description: "JSON extraction results from LLM (required for ingest mode)",
          },
        },
        required: ["mode"],
      },
      handler: async (args: any) => {
        if (args.mode === "prepare") {
          const agent = args.agent || sessionAgent || "default";
          try {
            const result = prepareSleep(agent, { dbPath: DB_PATH });
            if (result.totalEntries === 0) {
              return `No pending log entries for agent '${agent}'.`;
            }
            const chunkSummaries = result.chunks.map((c: any, i: number) =>
              `--- Chunk ${i + 1} (${c.entryCount} entries) ---\n${c.text}`
            ).join("\n\n");
            return [
              `Sleep prepared for '${agent}': ${result.totalEntries} entries in ${result.chunks.length} chunks.`,
              "",
              "## Extraction Schema",
              "",
              result.extractionPrompt,
              "",
              "## Log Chunks",
              "",
              chunkSummaries,
              "",
              "Instructions: For each chunk above, extract entities and relationships using the schema. Then call myelin_sleep with mode='ingest' and pass the JSON extractions array.",
            ].join("\n");
          } catch (e: any) {
            return `Error preparing sleep cycle: ${e.message}`;
          }
        }

        if (args.mode === "ingest") {
          if (!args.extractions || !Array.isArray(args.extractions) || args.extractions.length === 0) {
            return "Error: 'extractions' array is required for ingest mode.";
          }
          const graph = getGraph();
          if (!graph) return "No graph database found. Run `myelin init` first.";

          try {
            const agent = args.agent || sessionAgent || "default";
            const result = ingestExtractions(graph, args.extractions, agent);
            const lines = [
              `Ingestion complete:`,
              `  Nodes added: ${result.nodesAdded}`,
              `  Nodes reinforced: ${result.nodesReinforced}`,
              `  Edges added: ${result.edgesAdded}`,
            ];
            if (result.errors.length > 0) {
              lines.push(`  Errors (${result.errors.length}):`);
              for (const err of result.errors) {
                lines.push(`    - ${err}`);
              }
            }
            return lines.join("\n");
          } catch (e: any) {
            return `Error ingesting extractions: ${e.message}`;
          } finally {
            graph.close();
          }
        }

        if (args.mode === "complete") {
          const graph = getGraph();
          if (!graph) return "No graph database found. Run `myelin init` first.";

          try {
            const rem = remRefine(graph);
            const integrity = runIntegrityChecks(graph);
            return [
              `REM refinement complete:`,
              `  Nodes decayed: ${rem.nodesDecayed}`,
              `  Nodes pruned: ${rem.nodesPruned}`,
              `  Edges pruned: ${rem.edgesPruned}`,
              `Integrity checks:`,
              `  Orphan edges removed: ${integrity.orphanEdgesRemoved}`,
              `  Salience values clamped: ${integrity.salienceClamped}`,
            ].join("\n");
          } catch (e: any) {
            return `Error in REM refinement: ${e.message}`;
          } finally {
            graph.close();
          }
        }

        return `Unknown mode '${args.mode}'. Use 'prepare', 'ingest', or 'complete'.`;
      },
    },
  ],
});

// Inject boot context via session.send() on first user message.
// This bypasses the CLI hook overwrite bug where only the last
// extension's hooks survive (github/copilot-cli#2142).
if (eagerBootContext) {
  const bootContext = eagerBootContext;
  eagerBootContext = null;

  const unsub = session.on("user.message", () => {
    unsub(); // One-shot — unsubscribe immediately
    hookLog(`session.on("user.message") injecting boot context (${bootContext.length} chars)`);
    session.send({
      prompt: `<myelin_boot_context>\n${bootContext}\n</myelin_boot_context>\n\nContinue with the user's request. The above is injected context from myelin's knowledge graph — do not repeat it to the user.`,
    });
  });
}

// Auto-log task_complete summaries via event listener.
// Bypasses CLI hook overwrite bug — session.on() is per-connection.
session.on("session.task_complete", (event: any) => {
  if (taskCompleteLogged) return;
  taskCompleteLogged = true;
  const summary = event.data?.summary;
  const agent = sessionAgent || resolveAgent() || 'default';
  if (summary) {
    try {
      appendStructuredLog(agent, 'action', summary, {
        tags: ['auto-task-complete'],
      });
      hookLog(`session.task_complete logged: ${summary.slice(0, 80)}`);
    } catch { /* non-fatal */ }
  }
});

// Auto-log session end as fallback if task_complete wasn't called.
session.on("session.shutdown", (event: any) => {
  if (taskCompleteLogged) return;
  const agent = sessionAgent || resolveAgent() || 'default';
  const shutdownType = event.data?.shutdownType || 'routine';
  try {
    appendStructuredLog(agent, 'handover', `Session ended (${shutdownType})`, {
      tags: ['auto-session-end'],
    });
    hookLog(`session.shutdown logged: ${shutdownType}`);
  } catch { /* silent */ }
});

// Log errors via event listener (retry logic stays in hook as best-effort).
session.on("session.error", (event: any) => {
  hookLog(`session.error: ${event.data?.errorType} — ${event.data?.message}`);
});
