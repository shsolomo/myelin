/**
 * Myelin — Copilot CLI Extension
 *
 * This is the SOURCE file that gets bundled by esbuild into a single extension.mjs.
 * It imports myelin's graph library directly — no subprocess spawning.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats
 * Hooks: onSessionStart (boot prompt), onSessionEnd (auto-log),
 *        onUserPromptSubmitted (context injection), onErrorOccurred (resilience)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { KnowledgeGraph } from "../memory/graph.js";
import { getBootContext, resolveAgent, appendStructuredLog } from "../memory/agents.js";
import { readLogEntries } from "../memory/structured-log.js";
import { getEmbedding } from "../memory/embeddings.js";

const WORKING_MEMORY = join(homedir(), ".copilot", ".working-memory");
const DB_PATH = join(WORKING_MEMORY, "graph.db");
const MYELIN_VERSION = "0.3.1";

// Session-level agent identity — set when myelin_boot is called
let sessionAgent: string | null = null;

/** Get a graph instance, or null if db doesn't exist. */
function getGraph(): KnowledgeGraph | null {
  if (!existsSync(DB_PATH)) return null;
  return new KnowledgeGraph(DB_PATH);
}

// detectAgentName is now resolveAgent() in agents.ts — imported above

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "this", "that", "these", "those",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "into", "about", "between", "through", "after", "before", "above",
  "and", "or", "but", "not", "no", "nor", "so", "if", "then", "than",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "all", "each", "every", "both", "few", "more", "most", "some", "any",
  "just", "also", "very", "too", "only", "still", "already", "even",
  "here", "there", "up", "out", "over", "now", "get", "make", "like",
  "know", "think", "see", "come", "go", "want", "use", "find", "tell",
]);

/** Extract meaningful keywords from a prompt for FTS5 search. */
function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
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

        // Always include tool availability docs
        contextParts.push(
          "",
          "## Myelin Tools Available",
          "You have access to a persistent knowledge graph via Myelin tools:",
          "- **myelin_query** — Semantic search across graph nodes",
          "- **myelin_boot** — Load deeper agent-specific context (call with your agent name for richer results)",
          "- **myelin_log** — Record decisions, findings, actions, and observations during your session",
          "- **myelin_show** — Inspect a specific node and its connections",
          "- **myelin_stats** — Show graph statistics",
        );

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

    onUserPromptSubmitted: async (input: any, _invocation: any) => {
      try {
        const graph = getGraph();
        if (!graph) return;

        try {
          // Try semantic search first
          let context: string | null = null;
          let searchMethod = "semantic";

          try {
            const queryEmbedding = await getEmbedding(input.prompt);
            if (queryEmbedding.length > 0) {
              const results = graph.semanticSearch(queryEmbedding, 5, "knowledge", undefined, 2);
              const relevant = results.filter((r: any) => r.distance < 1.2);
              if (relevant.length > 0) {
                context = relevant
                  .map((r: any) => `- **${r.node.name}** (${r.node.type}): ${r.node.description?.slice(0, 150)}`)
                  .join("\n");
              }
            }
          } catch {
            // Embedding unavailable — fall through to FTS5
          }

          // FTS5 fallback when semantic search yields nothing
          if (!context) {
            const keywords = extractKeywords(input.prompt);
            if (keywords.length > 0) {
              const ftsQuery = keywords.join(" OR ");
              const nodes = graph.searchNodes(ftsQuery, 10)
                .filter((n: any) => (n.sensitivity ?? 0) <= 2)
                .slice(0, 5);
              if (nodes.length > 0) {
                searchMethod = "keyword";
                context = nodes
                  .map((n: any) => `- **${n.name}** (${n.type}): ${n.description?.slice(0, 150)}`)
                  .join("\n");
              }
            }
          }

          if (!context) return;

          await session.log(`Myelin context injected (${searchMethod} search)`);
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
        "Search the knowledge graph semantically. Finds nodes by meaning, not just keywords.",
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

          // Try semantic search first
          const queryEmbedding = await getEmbedding(args.query);
          if (queryEmbedding.length > 0) {
            const results = graph.semanticSearch(queryEmbedding, limit, undefined, undefined, ceiling);
            if (results.length > 0) {
              const lines = results.map((r: any) =>
                `[${r.distance.toFixed(3)}] ${r.node.type} | ${r.node.name} (${r.node.salience.toFixed(2)}) — ${r.node.description?.slice(0, 100)}`
              );
              return `Semantic search: '${args.query}' (ceiling=${ceiling})\n${lines.join("\n")}`;
            }
          }

          // Fallback to FTS5 with client-side ceiling filter
          const nodes = graph.searchNodes(args.query, limit * 2)
            .filter((n: any) => (n.sensitivity ?? 0) <= ceiling)
            .slice(0, limit);
          if (nodes.length === 0) return `No results for '${args.query}'`;
          const lines = nodes.map((n: any) =>
            `${n.type} | ${n.name} (${n.salience.toFixed(2)}) — ${n.description?.slice(0, 100)}`
          );
          return `FTS5 search: '${args.query}' (ceiling=${ceiling})\n${lines.join("\n")}`;
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
