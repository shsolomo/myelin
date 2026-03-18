/**
 * Myelin — Copilot CLI Extension
 *
 * This is the SOURCE file that gets bundled by esbuild into a single extension.mjs.
 * It imports myelin's graph library directly — no subprocess spawning.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats, myelin_sleep
 * Hooks: onSessionStart (boot context build), onUserPromptSubmitted (inject boot context),
 *        onPostToolUse (auto-log task_complete), onSessionEnd (auto-log fallback),
 *        onErrorOccurred (resilience)
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
// Boot context is built eagerly in onSessionStart, injected via onUserPromptSubmitted
// because the CLI ignores additionalContext from onSessionStart (fire-and-forget).
let pendingBootContext: string | null = null;

/** Get a graph instance, or null if db doesn't exist. */
function getGraph(): KnowledgeGraph | null {
  if (!existsSync(DB_PATH)) return null;
  return new KnowledgeGraph(DB_PATH);
}


const session = await joinSession({
  onPermissionRequest: approveAll,

  hooks: {
    // Build boot context eagerly but DON'T return additionalContext — the Copilot CLI
    // v1.0.8 ignores the return value from onSessionStart hooks (fire-and-forget).
    // Context is cached in pendingBootContext and injected via onUserPromptSubmitted.
    onSessionStart: async (_input: any, _invocation: any) => {
      try {
        hookLog(`onSessionStart fired — v${MYELIN_VERSION}`);
        console.error(`[myelin] v${MYELIN_VERSION} loaded — 6 tools, 4 hooks`);

        if (!existsSync(DB_PATH)) {
          console.error("[myelin] No graph database found. Run `myelin init` to create one.");
          return;
        }

        // Auto-detect agent name and boot graph context
        const detectedAgent = resolveAgent();
        if (detectedAgent) {
          sessionAgent = detectedAgent;
        }

        const contextParts: string[] = [];

        // Graph briefing
        let briefingNodeCount = 0;
        try {
          const briefing = getBootContext(detectedAgent, { dbPath: DB_PATH });
          const nodeMatch = briefing.match(/_(\d+) nodes/);
          if (nodeMatch) briefingNodeCount = parseInt(nodeMatch[1], 10);
          if (briefing) contextParts.push(briefing);
        } catch (bootErr: any) {
          console.error(`[myelin] Graph boot failed: ${bootErr.message}`);
        }

        // Unconsolidated agent activity logs (entries past the watermark)
        let logCount = 0;
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
            } catch { /* graph not accessible — load recent entries */ }

            const recentLogs = readLogEntries(detectedAgent, {
              ...(watermark ? { sinceTimestamp: watermark } : {}),
              limit: 15,
            });
            logCount = recentLogs.length;
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

        // Tool guidance: when to use myelin vs other tools
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

        // Health hints + graph totals for boot summary
        let graphTotal = "";
        const healthGraph = getGraph();
        if (healthGraph) {
          try {
            const healthStats = healthGraph.stats();
            if (healthStats.nodeCount === 0) {
              contextParts.push("", "💡 Graph is empty — run `myelin parse ./your-repo` to index code");
            } else {
              graphTotal = `, graph: ${healthStats.nodeCount} nodes / ${healthStats.edgeCount} edges`;
              const embStats = healthGraph.embeddingStats();
              if (!embStats.vecAvailable || embStats.embeddedNodes === 0) {
                contextParts.push("", "ℹ️ Search uses FTS5 keywords. Run `myelin embed` to add optional semantic boost.");
              }
            }
          } catch {
            // Silent — don't break boot for health check
          } finally {
            healthGraph.close();
          }
        }

        const agentLabel = detectedAgent ?? "generic";
        const parts = [`agent=${agentLabel}`];
        if (briefingNodeCount > 0) parts.push(`${briefingNodeCount} knowledge nodes`);
        if (logCount > 0) parts.push(`${logCount} recent logs`);
        console.error(`[myelin] Auto-boot: ${parts.join(", ")}${graphTotal}`);

        // Cache context for injection via onUserPromptSubmitted
        if (contextParts.length > 0) {
          pendingBootContext = contextParts.join("\n");
          hookLog(`onSessionStart built context: ${pendingBootContext.length} chars`);
        } else {
          hookLog(`onSessionStart: no context parts built`);
        }
      } catch (e: any) {
        hookLog(`onSessionStart error: ${e.message}`);
        console.error(`[myelin] Boot error: ${e.message}`);
      }
    },

    // Inject boot context on the first user prompt via modifiedPrompt.
    // The CLI reads modifiedPrompt from this hook (unlike onSessionStart's additionalContext).
    // Filed github/copilot-cli#2142 for the additionalContext bug.
    onUserPromptSubmitted: async (input: any, _invocation: any) => {
      hookLog(`onUserPromptSubmitted fired — pendingBootContext: ${pendingBootContext ? pendingBootContext.length + ' chars' : 'null'}`);
      if (!pendingBootContext) return;
      const context = pendingBootContext;
      pendingBootContext = null; // inject once only
      hookLog(`onUserPromptSubmitted injecting modifiedPrompt (${context.length} chars)`);
      return {
        modifiedPrompt: `<myelin_boot_context>\n${context}\n</myelin_boot_context>\n\n${input.prompt}`,
      };
    },

    onSessionEnd: async (input: any, _invocation: any) => {
      if (taskCompleteLogged) return; // Already logged via onPostToolUse
      try {
        const agent = sessionAgent || resolveAgent() || 'default';
        const summary = input.finalMessage
          ? input.finalMessage.slice(0, 200)
          : 'Session ended (no final message)';
        appendStructuredLog(agent, 'handover', summary, {
          tags: ['auto-session-end'],
        });
      } catch {
        // Silent
      }
    },

    onErrorOccurred: async (input: any, _invocation: any) => {
      if (input.recoverable && input.errorContext === "model_call") {
        return { errorHandling: "retry" as const, retryCount: 2 };
      }
    },

    onPostToolUse: async (input: any) => {
      if (input.toolName === 'task_complete') {
        const summary = input.toolArgs?.summary;
        const agent = sessionAgent || resolveAgent() || 'default';
        if (summary) {
          try {
            appendStructuredLog(agent, 'action', summary, {
              tags: ['auto-task-complete'],
            });
            taskCompleteLogged = true;
          } catch {
            // Non-fatal — don't break session end
          }
        }
        if (!summary) {
          return {
            additionalContext: 'You completed a task without a summary. Consider calling myelin_log to record what was accomplished.',
          };
        }
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
