/**
 * Agent integration — boot context, structured logging, persona evolution.
 *
 * Connects the knowledge graph to the agent lifecycle:
 * 1. BOOT: Generate a domain briefing from the graph for agent startup
 * 2. LOG: Append structured session observations per agent
 * 3. EVOLVE: Generate persona update suggestions from graph knowledge
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph, NodeType } from "./graph.js";
import type { Node } from "./graph.js";
import { writeLogEntry } from "./structured-log.js";

const COPILOT_ROOT = join(homedir(), ".copilot");
const AGENTS_DIR = join(COPILOT_ROOT, "agents");
const AGENT_LOGS_DIR = join(COPILOT_ROOT, ".working-memory", "agents");
const DEFAULT_DB = join(COPILOT_ROOT, ".working-memory", "graph.db");

/**
 * Generate a domain briefing for an agent's boot sequence.
 * Queries graph for high-salience nodes relevant to this agent.
 */
export function getBootContext(
  agentName: string,
  options: { dbPath?: string; minSalience?: number; limit?: number } = {},
): string {
  const dbPath = options.dbPath ?? DEFAULT_DB;
  const minSalience = options.minSalience ?? 0.3;
  const limit = options.limit ?? 30;

  const graph = new KnowledgeGraph(dbPath);
  try {
    // Get nodes this agent contributed
    const ownNodes = graph.findNodes({
      sourceAgent: agentName,
      minSalience,
      limit,
      ceiling: 1,
    });

    // Get nodes tagged with this agent's domain
    const taggedNodes = graph.findNodes({
      tag: agentName,
      minSalience,
      limit,
      ceiling: 1,
    });

    // Merge and deduplicate
    const seen = new Set<string>();
    const allNodes: Node[] = [];
    for (const node of [...ownNodes, ...taggedNodes]) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        allNodes.push(node);
      }
    }

    // Sort by salience descending, limit
    allNodes.sort((a, b) => b.salience - a.salience);
    const nodes = allNodes.slice(0, limit);

    if (nodes.length === 0) {
      return `# Graph Briefing — ${agentName}\n\nNo graph nodes found for this agent yet. The graph will populate as consolidation cycles run.\n`;
    }

    const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const lines: string[] = [
      `# Graph Briefing — ${agentName}`,
      `_Generated ${now}_`,
      `_${nodes.length} nodes, sorted by salience_`,
      "",
    ];

    // Group by type
    const byType = new Map<string, Node[]>();
    for (const node of nodes) {
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }

    for (const [nodeType, typeNodes] of [...byType.entries()].sort()) {
      const title = nodeType.charAt(0).toUpperCase() + nodeType.slice(1) + "s";
      lines.push(`## ${title}`);
      for (const node of typeNodes) {
        const marker =
          node.salience >= 0.8
            ? "🔴"
            : node.salience >= 0.5
              ? "🟡"
              : "⚪";
        lines.push(
          `- ${marker} **${node.name}** (${node.salience.toFixed(2)}): ${node.description.slice(0, 120)}`,
        );
        // Get outgoing relationships
        const edges = graph.getEdges(node.id, "outgoing");
        for (const edge of edges.slice(0, 3)) {
          const target = graph.getNode(edge.targetId);
          if (target) {
            lines.push(`  → ${edge.relationship}: ${target.name}`);
          }
        }
      }
      lines.push("");
    }

    // Stats
    const stats = graph.stats();
    lines.push("---");
    lines.push(
      `_Graph total: ${stats.nodeCount} nodes, ${stats.edgeCount} edges, avg salience ${stats.avgSalience}_`,
    );

    return lines.join("\n");
  } finally {
    graph.close();
  }
}

/**
 * Write a structured log entry for an agent (JSONL format).
 */
export function appendStructuredLog(
  agentName: string,
  entryType: string,
  summary: string,
  options: {
    detail?: string;
    sessionId?: string;
    tags?: string[];
    context?: Record<string, unknown>;
  } = {},
): string {
  return writeLogEntry(agentName, entryType, summary, options);
}

/**
 * Generate persona evolution suggestions from graph knowledge.
 */
export function generatePersonaDiff(
  agentName: string,
  options: { dbPath?: string; minSalience?: number } = {},
): string {
  const dbPath = options.dbPath ?? DEFAULT_DB;
  const minSalience = options.minSalience ?? 0.6;

  const graph = new KnowledgeGraph(dbPath);
  try {
    const ownNodes = graph.findNodes({
      sourceAgent: agentName,
      minSalience,
      limit: 50,
    });
    const taggedNodes = graph.findNodes({
      tag: agentName,
      minSalience,
      limit: 50,
    });

    const seen = new Set<string>();
    const allNodes: Node[] = [];
    for (const node of [...ownNodes, ...taggedNodes]) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        allNodes.push(node);
      }
    }

    if (allNodes.length === 0) {
      return `No high-salience graph nodes for ${agentName}. Run consolidation first.\n`;
    }

    // Read current persona
    const personaFile = join(AGENTS_DIR, `${agentName}.agent.md`);
    const currentPersona = existsSync(personaFile)
      ? readFileSync(personaFile, "utf-8")
      : "";

    const lines: string[] = [
      `# Persona Evolution — ${agentName}`,
      `_Based on ${allNodes.length} high-salience graph nodes_`,
      "",
      "## Knowledge the agent has accumulated",
      "",
    ];

    // Patterns and conventions
    const patterns = allNodes.filter((n) =>
      [NodeType.Pattern, NodeType.Convention, NodeType.Rule].includes(
        n.type as NodeType,
      ),
    );
    if (patterns.length > 0) {
      lines.push("### Patterns & Conventions");
      for (const p of patterns) {
        const inPersona = currentPersona
          .toLowerCase()
          .includes(p.name.toLowerCase());
        const marker = inPersona ? "✅" : "🆕";
        lines.push(
          `- ${marker} **${p.name}** (${p.salience.toFixed(2)}): ${p.description.slice(0, 150)}`,
        );
      }
      lines.push("");
    }

    // Decisions
    const decisions = allNodes.filter((n) => n.type === NodeType.Decision);
    if (decisions.length > 0) {
      lines.push("### Decisions");
      for (const d of decisions) {
        const inPersona = currentPersona
          .toLowerCase()
          .includes(d.name.toLowerCase());
        const marker = inPersona ? "✅" : "🆕";
        lines.push(
          `- ${marker} **${d.name}** (${d.salience.toFixed(2)}): ${d.description.slice(0, 150)}`,
        );
      }
      lines.push("");
    }

    // Bugs
    const bugs = allNodes.filter((n) => n.type === NodeType.Bug);
    if (bugs.length > 0) {
      lines.push("### Bugs & Workarounds");
      for (const b of bugs) {
        const inPersona = currentPersona
          .toLowerCase()
          .includes(b.name.toLowerCase());
        const marker = inPersona ? "✅" : "🆕";
        lines.push(
          `- ${marker} **${b.name}** (${b.salience.toFixed(2)}): ${b.description.slice(0, 150)}`,
        );
      }
      lines.push("");
    }

    // People
    const people = allNodes.filter((n) => n.type === NodeType.Person);
    if (people.length > 0) {
      lines.push("### Key People");
      for (const p of people) {
        const inPersona = currentPersona
          .toLowerCase()
          .includes(p.name.toLowerCase());
        const marker = inPersona ? "✅" : "🆕";
        lines.push(`- ${marker} **${p.name}** (${p.salience.toFixed(2)})`);
      }
      lines.push("");
    }

    // Summary
    const newCount = lines.filter((l) => l.includes("🆕")).length;
    const existingCount = lines.filter((l) => l.includes("✅")).length;
    lines.push("---");
    lines.push("✅ = already in persona | 🆕 = candidate for addition");
    lines.push(
      `**${newCount} new items** could enrich this persona. ${existingCount} already captured.`,
    );

    return lines.join("\n");
  } finally {
    graph.close();
  }
}

/**
 * Get the structured log instructions text to embed in agent definitions.
 */
export function getAgentLogInstructions(agentName: string): string {
  return `Log key events using the myelin CLI:

\`\`\`bash
myelin agent log ${agentName} decision "Description" --tag topic
myelin agent log ${agentName} action "What was done" --detail "Context"
myelin agent log ${agentName} finding "What was discovered" --tag source
myelin agent log ${agentName} error "What went wrong"
myelin agent log ${agentName} observation "Pattern noticed"
myelin agent log ${agentName} handover "Session ending — pending items"
\`\`\`

Event types: \`decision\`, \`action\`, \`finding\`, \`error\`, \`handover\`, \`observation\``;
}
