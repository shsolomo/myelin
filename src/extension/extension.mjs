import { createRequire as __createRequire } from "node:module";
if (!globalThis.require) { globalThis.require = __createRequire(import.meta.url); }

import { execFile } from "node:child_process";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

function runMyelin(args) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "cmd" : "myelin";
    const cmdArgs = isWindows ? ["/c", "myelin", ...args] : args;
    execFile(cmd, cmdArgs, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve(`Error: ${stderr || err.message}`);
      else resolve(stdout);
    });
  });
}

// Structured log writer (no DB needed  direct JSONL file append)
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

function writeLog(agent, type, summary, tags) {
  const dir = join(homedir(), ".copilot", ".working-memory", "agents", agent);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    agent, type, summary, detail: "", session_id: "", tags: tags || [], context: {},
  });
  appendFileSync(join(dir, "log.jsonl"), entry + "\n");
}

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: {
    onSessionStart: async () => {
      try {
        const context = await runMyelin(["agent", "boot", "donna"]);
        if (context && !context.startsWith("Error:") && !context.includes("No graph nodes")) {
          return { additionalContext: "## Graph Knowledge (Myelin)\n\n" + context };
        }
      } catch {}
    },
    onUserPromptSubmitted: async (input) => {
      try {
        const result = await runMyelin(["query", input.prompt, "--limit", "3"]);
        if (result && !result.startsWith("Error:") && !result.includes("No results") && !result.includes("No nodes")) {
          return { additionalContext: "## Relevant Graph Context (Myelin)\n" + result };
        }
      } catch {}
    },
    onSessionEnd: async (input) => {
      if (input.finalMessage) {
        try {
          writeLog("donna", "handover", input.finalMessage.slice(0, 200), ["auto-session-end"]);
        } catch {}
      }
    },
    onPostToolUse: async (input) => {
      if (input.toolName === "task_complete") {
        return {
          additionalContext: "If you made any important decisions, discovered something unexpected, hit an error worth remembering, or noticed a pattern — log it with myelin_log before finishing. Skip routine or obvious outcomes.",
        };
      }
    },
  },
  tools: [
    {
      name: "myelin_query",
      description: "Search the knowledge graph semantically. Finds nodes by meaning, not just keywords.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
      handler: async (args) => await runMyelin(["query", args.query, "--limit", String(args.limit || 10)]),
    },
    {
      name: "myelin_boot",
      description: "Load domain-specific knowledge from the graph for a named agent.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name (e.g., donna, researcher)" },
        },
        required: ["agent"],
      },
      handler: async (args) => await runMyelin(["agent", "boot", args.agent]),
    },
    {
      name: "myelin_log",
      description: "Log a structured event to an agent's knowledge log.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name" },
          type: { type: "string", description: "Event type", enum: ["decision", "action", "finding", "error", "handover", "observation"] },
          summary: { type: "string", description: "One-line summary" },
          tags: { type: "string", description: "Comma-separated tags" },
        },
        required: ["agent", "type", "summary"],
      },
      handler: async (args) => {
        const cmdArgs = ["agent", "log", args.agent, args.type, args.summary];
        if (args.tags) args.tags.split(",").forEach(t => cmdArgs.push("--tag", t.trim()));
        return await runMyelin(cmdArgs);
      },
    },
    {
      name: "myelin_show",
      description: "Show a knowledge graph node and its connections.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Node name or partial name" } },
        required: ["name"],
      },
      handler: async (args) => await runMyelin(["show", args.name]),
    },
    {
      name: "myelin_stats",
      description: "Show knowledge graph statistics.",
      parameters: { type: "object", properties: {} },
      handler: async () => await runMyelin(["stats"]),
    },
  ],
});
