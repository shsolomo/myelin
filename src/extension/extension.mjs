/**
 * Myelin — Copilot CLI Extension
 *
 * Registers knowledge graph tools and lifecycle hooks with the Copilot CLI.
 * This is the primary distribution path — agents get graph-powered memory
 * as native tools without any configuration.
 *
 * Tools: myelin_query, myelin_boot, myelin_log, myelin_show, myelin_stats
 * Hooks: onSessionStart (auto-boot), onSessionEnd (auto-log)
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

const MYELIN_BIN = "myelin"; // assumes myelin is on PATH via npm install -g

/** Run a myelin CLI command and return stdout. */
function runMyelin(args) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "cmd" : MYELIN_BIN;
    const cmdArgs = isWindows ? ["/c", MYELIN_BIN, ...args] : args;

    execFile(cmd, cmdArgs, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve(`Error: ${stderr || err.message}`);
      else resolve(stdout);
    });
  });
}

const session = await joinSession({
  onPermissionRequest: approveAll,

  hooks: {
    onSessionStart: async (input) => {
      // Auto-inject graph context for the current agent
      try {
        const context = await runMyelin(["agent", "boot", "donna"]);
        if (context && !context.startsWith("Error:")) {
          return {
            additionalContext: `## Graph Knowledge (auto-loaded by Myelin)\n${context}`,
          };
        }
      } catch {
        // Silent — graph may not exist yet
      }
    },

    onSessionEnd: async (input) => {
      // Auto-log session summary if available
      if (input.finalMessage) {
        try {
          await runMyelin([
            "agent",
            "log",
            "donna",
            "handover",
            input.finalMessage.slice(0, 200),
            "--tag",
            "auto-session-end",
          ]);
        } catch {
          // Silent
        }
      }
    },
  },

  tools: [
    {
      name: "myelin_query",
      description:
        "Search the knowledge graph semantically. Finds nodes by meaning, not just keywords. Use this to find relevant context, people, decisions, patterns, or tools.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 10)",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const limit = args.limit || 10;
        return await runMyelin([
          "query",
          args.query,
          "--limit",
          String(limit),
        ]);
      },
    },
    {
      name: "myelin_boot",
      description:
        "Load domain-specific knowledge from the graph for a named agent. Returns high-salience nodes and relationships relevant to that agent.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Agent name (e.g., donna, researcher, ado-analyst)",
          },
        },
        required: ["agent"],
      },
      handler: async (args) => {
        return await runMyelin(["agent", "boot", args.agent]);
      },
    },
    {
      name: "myelin_log",
      description:
        "Log a structured event to an agent's knowledge log. Use for decisions, findings, errors, observations.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Agent name",
          },
          type: {
            type: "string",
            description:
              "Event type: decision, action, finding, error, handover, observation",
            enum: [
              "decision",
              "action",
              "finding",
              "error",
              "handover",
              "observation",
            ],
          },
          summary: {
            type: "string",
            description: "One-line summary of the event",
          },
          tags: {
            type: "string",
            description: "Comma-separated tags",
          },
        },
        required: ["agent", "type", "summary"],
      },
      handler: async (args) => {
        const cmdArgs = ["agent", "log", args.agent, args.type, args.summary];
        if (args.tags) {
          for (const tag of args.tags.split(",")) {
            cmdArgs.push("--tag", tag.trim());
          }
        }
        return await runMyelin(cmdArgs);
      },
    },
    {
      name: "myelin_show",
      description:
        "Show details about a specific knowledge graph node including its connections to other nodes.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Node name or partial name to search for",
          },
        },
        required: ["name"],
      },
      handler: async (args) => {
        return await runMyelin(["show", args.name]);
      },
    },
    {
      name: "myelin_stats",
      description:
        "Show knowledge graph statistics — node counts, edge counts, type distribution, embedding coverage.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        return await runMyelin(["stats"]);
      },
    },
  ],
});

session.on("tool.execution_complete", (event) => {
  // Could track tool usage for graph enrichment in the future
});
