/**
 * Myelin — Copilot CLI Extension
 *
 * This is the SOURCE file that gets bundled by esbuild into a single extension.mjs.
 * It imports myelin's graph library directly — no subprocess spawning.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats
 * Hooks: onSessionStart (auto-boot), onSessionEnd (auto-log),
 *        onUserPromptSubmitted (context injection), onErrorOccurred (resilience)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { KnowledgeGraph } from "../memory/graph.js";
import { getBootContext, appendStructuredLog } from "../memory/agents.js";
import { readLogEntries } from "../memory/structured-log.js";
import { getEmbedding } from "../memory/embeddings.js";

const DB_PATH = join(homedir(), ".copilot", ".working-memory", "graph.db");
const MYELIN_VERSION = "0.3.1";

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
        await session.log(`Myelin v${MYELIN_VERSION} loaded — 5 tools, 4 hooks`);

        if (!existsSync(DB_PATH)) {
          await session.log("No graph database found. Run `myelin init` to create one.", { level: "warning" });
          return;
        }

        const context = getBootContext("donna", { dbPath: DB_PATH });
        if (context && !context.includes("No graph nodes found")) {
          return {
            additionalContext: `## Graph Knowledge (auto-loaded by Myelin)\n\n${context}`,
          };
        }
      } catch (e: any) {
        await session.log(`Myelin boot error: ${e.message}`, { level: "error" });
      }
    },

    onUserPromptSubmitted: async (input: any, _invocation: any) => {
      try {
        const graph = getGraph();
        if (!graph) return;

        try {
          const queryEmbedding = await getEmbedding(input.prompt);
          if (queryEmbedding.length === 0) return;

          const results = graph.semanticSearch(queryEmbedding, 5, "knowledge");
          if (results.length === 0) return;

          const relevant = results.filter((r: any) => r.distance < 1.2);
          if (relevant.length === 0) return;

          const context = relevant
            .map((r: any) => `- **${r.node.name}** (${r.node.type}): ${r.node.description?.slice(0, 150)}`)
            .join("\n");

          return {
            additionalContext: `## Relevant Graph Context (Myelin)\n${context}`,
          };
        } finally {
          graph.close();
        }
      } catch {
        // Silent — don't break the user's flow
      }
    },

    onSessionEnd: async (input: any, _invocation: any) => {
      if (input.finalMessage) {
        try {
          appendStructuredLog("donna", "handover", input.finalMessage.slice(0, 200), {
            tags: ["auto-session-end"],
          });
        } catch {
          // Silent
        }
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
        "Search the knowledge graph semantically. Finds nodes by meaning, not just keywords.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
      handler: async (args: any) => {
        const graph = getGraph();
        if (!graph) return "No graph database found. Run `myelin init` first.";

        try {
          const limit = args.limit || 10;

          // Try semantic search first
          const queryEmbedding = await getEmbedding(args.query);
          if (queryEmbedding.length > 0) {
            const results = graph.semanticSearch(queryEmbedding, limit);
            if (results.length > 0) {
              const lines = results.map((r: any) =>
                `[${r.distance.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) — ${r.node.description?.slice(0, 100)}`
              );
              return `Semantic search: '${args.query}'\n${lines.join("\n")}`;
            }
          }

          // Fallback to FTS5
          const nodes = graph.searchNodes(args.query, limit);
          if (nodes.length === 0) return `No results for '${args.query}'`;
          const lines = nodes.map((n: any) =>
            `${n.type} | ${n.name} (${n.salience.toFixed(2)}) — ${n.description?.slice(0, 100)}`
          );
          return `FTS5 search: '${args.query}'\n${lines.join("\n")}`;
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
        "Load domain-specific knowledge from the graph for a named agent.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name (e.g., donna, researcher)" },
        },
        required: ["agent"],
      },
      handler: async (args: any) => {
        try {
          return getBootContext(args.agent, { dbPath: DB_PATH });
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: "myelin_log",
      description:
        "Log a structured event to an agent's knowledge log.",
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
          tags: { type: "string", description: "Comma-separated tags" },
        },
        required: ["agent", "type", "summary"],
      },
      handler: async (args: any) => {
        try {
          const tags = args.tags ? args.tags.split(",").map((t: string) => t.trim()) : undefined;
          appendStructuredLog(args.agent, args.type, args.summary, { tags });
          return `✅ ${args.agent}: ${args.summary}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: "myelin_show",
      description: "Show a knowledge graph node and its connections.",
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
      description: "Show knowledge graph statistics.",
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
