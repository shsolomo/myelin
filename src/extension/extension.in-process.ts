/**
 * Myelin — Copilot CLI Extension
 *
 * This is the SOURCE file that gets bundled by esbuild into a single extension.mjs.
 * It imports myelin's graph library directly — no subprocess spawning.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats
 * Hooks: onSessionStart (boot prompt + tool guidance), onSessionEnd (auto-log),
 *        onErrorOccurred (resilience)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { KnowledgeGraph } from "../memory/graph.js";
import { getBootContext, resolveAgent, appendStructuredLog } from "../memory/agents.js";
import { getEmbedding } from "../memory/embeddings.js";

const WORKING_MEMORY = join(homedir(), ".copilot", ".working-memory");
const DB_PATH = join(WORKING_MEMORY, "graph.db");
declare const __MYELIN_VERSION__: string;
const MYELIN_VERSION = __MYELIN_VERSION__;

// Session-level agent identity — set when myelin_boot is called
let sessionAgent: string | null = null;

/** Get a graph instance, or null if db doesn't exist. */
function getGraph(): KnowledgeGraph | null {
  if (!existsSync(DB_PATH)) return null;
  return new KnowledgeGraph(DB_PATH);
}


const session = await joinSession({
  onPermissionRequest: approveAll,

  hooks: {
    onSessionStart: async (_input: any, _invocation: any) => {
      try {
        await session.log(`Myelin v${MYELIN_VERSION} loaded — 5 tools, 3 hooks`);

        if (!existsSync(DB_PATH)) {
          await session.log("No graph database found. Run `myelin init` to create one.", { level: "warning" });
          return;
        }

        // Auto-detect agent name and boot graph context
        const detectedAgent = resolveAgent();
        if (detectedAgent) {
          sessionAgent = detectedAgent;
        }

        let briefing: string;
        try {
          briefing = getBootContext(detectedAgent, { dbPath: DB_PATH });
        } catch (bootErr: any) {
          await session.log(`Graph boot failed: ${bootErr.message}`, { level: "warning" });
          briefing = "";
        }

        const contextParts: string[] = [];

        if (briefing) {
          contextParts.push(briefing);
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
          "- **myelin_log** — Record important decisions, findings, errors, and observations. These feed future consolidation into the graph.",
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
            // Silent — don't break boot for health check
          } finally {
            healthGraph.close();
          }
        }

        await session.log(
          `Auto-boot complete: agent=${detectedAgent ?? "generic"}, context injected`,
        );

        return {
          additionalContext: contextParts.join("\n"),
        };
      } catch (e: any) {
        await session.log(`Myelin boot error: ${e.message}`, { level: "error" });
      }
    },

    onSessionEnd: async (input: any, _invocation: any) => {
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
        "Log a structured event to an agent's knowledge log. Use to record decisions, findings, errors, and observations worth remembering across sessions. These logs feed into consolidation — important events become graph knowledge.",
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
          sensitivity: { type: "number", description: "Sensitivity level 0-3 (default: 0). Controls visibility during consolidation." },
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
  ],
});
