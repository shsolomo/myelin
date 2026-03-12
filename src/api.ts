/**
 * Stateless NER extraction API server.
 *
 * Exposes myelin's NER pipeline over HTTP for real-time entity extraction
 * from text streams (e.g., meeting transcription). Returns structured
 * entities and co-occurrence relationships — no graph storage required.
 *
 * Endpoints:
 *   POST /api/extract  — Extract entities and relationships from text
 *   GET  /api/health   — Check model readiness
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { extractEntities, isAvailable, type NEREntity } from "./memory/ner.js";
import { RELATIONSHIP_PATTERNS } from "./memory/vocabulary.js";

// ── Request / Response types ─────────────────────────────────────────────────

export interface ExtractRequest {
  text: string;
  labels?: string[];
  threshold?: number;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  relationship: string;
  weight: number;
  evidence: string;
}

export interface ExtractResponse {
  entities: NEREntity[];
  relationships: ExtractedRelationship[];
  processingMs: number;
}

export interface HealthResponse {
  status: "ready" | "model_unavailable";
  modelLoaded: boolean;
}

// ── Co-occurrence relationship detection ─────────────────────────────────────

const CO_OCCURRENCE_PROXIMITY = 300;
const CO_OCCURRENCE_RATIO = 0.4;

/**
 * Detect co-occurrence relationships between NER entities based on proximity
 * and signal phrase matching. Stateless — no graph or LogEntry required.
 *
 * Uses the same proximity + signal-phrase algorithm as the consolidation
 * pipeline but returns lightweight relationship objects instead of Edge nodes.
 */
export function detectRelationships(
  text: string,
  entities: NEREntity[],
): ExtractedRelationship[] {
  if (entities.length < 2) return [];

  const maxDist = Math.min(
    CO_OCCURRENCE_PROXIMITY,
    Math.floor(text.length * CO_OCCURRENCE_RATIO),
  );

  const relationships: ExtractedRelationship[] = [];
  const seenEdges = new Set<string>();

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];

      // Proximity check: gap between entity spans
      const gap =
        a.end <= b.start
          ? b.start - a.end
          : b.end <= a.start
            ? a.start - b.end
            : 0; // overlapping spans → distance 0

      if (gap > maxDist) continue;

      // Canonical key (alphabetical by text) to prevent duplicates
      const [src, tgt] = a.text < b.text ? [a, b] : [b, a];
      const key = `${src.text}::${tgt.text}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);

      // Signal phrase matching — scan text between entities for relationship cues
      const spanStart = Math.min(a.start, b.start);
      const spanEnd = Math.max(a.end, b.end);
      const textBetween = text.slice(spanStart, spanEnd).toLowerCase();

      let relType = "relates_to";
      let evidence = "";

      for (const pattern of RELATIONSHIP_PATTERNS) {
        if (pattern.relationship === "relates_to") continue;

        for (const phrase of pattern.signalPhrases) {
          if (textBetween.includes(phrase)) {
            relType = pattern.relationship;
            evidence = phrase;
            break;
          }
        }
        if (relType !== "relates_to") break;
      }

      // Weight scales inversely with distance: closer = stronger signal
      const weight =
        maxDist > 0
          ? Math.max(0.3, 1.0 - (gap / maxDist) * 0.7)
          : 1.0;

      relationships.push({
        source: src.text,
        target: tgt.text,
        sourceLabel: src.label,
        targetLabel: tgt.label,
        relationship: relType,
        weight: Math.round(weight * 1000) / 1000,
        evidence: evidence || `co-mentioned within ${gap} chars`,
      });
    }
  }

  return relationships;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleExtract(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let request: ExtractRequest;
  try {
    request = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!request.text || typeof request.text !== "string") {
    sendJson(res, 400, { error: 'Missing or invalid "text" field' });
    return;
  }

  const start = performance.now();
  const entities = await extractEntities(
    request.text,
    request.labels,
    request.threshold ?? 0.3,
  );
  const relationships = detectRelationships(request.text, entities);
  const processingMs = Math.round(performance.now() - start);

  const response: ExtractResponse = { entities, relationships, processingMs };
  sendJson(res, 200, response);
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const response: HealthResponse = {
    status: isAvailable() ? "ready" : "model_unavailable",
    modelLoaded: isAvailable(),
  };
  sendJson(res, 200, response);
}

// ── Server ───────────────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number;
  host?: string;
}

export async function startApiServer(
  options: ServeOptions = {},
): Promise<Server> {
  const port = options.port ?? 3000;
  const host = options.host ?? "127.0.0.1";

  // Warm up NER model so first real request isn't slow
  console.log("Loading NER model...");
  await extractEntities("warmup", undefined, 0.9);
  console.log(
    isAvailable()
      ? "✅ NER model loaded."
      : "⚠️  NER model unavailable — will return empty results.",
  );

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    try {
      if (url.pathname === "/api/extract" && req.method === "POST") {
        await handleExtract(req, res);
      } else if (url.pathname === "/api/health" && req.method === "GET") {
        handleHealth(req, res);
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (err) {
      console.error("Request error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`\nMyelin NER API listening on http://${host}:${port}`);
      console.log("Endpoints:");
      console.log("  POST /api/extract  — Extract entities from text");
      console.log("  GET  /api/health   — Check server status");
      console.log("\nExample:");
      console.log(
        `  curl -X POST http://${host}:${port}/api/extract \\`,
      );
      console.log(
        `    -H "Content-Type: application/json" \\`,
      );
      console.log(
        `    -d '{"text": "We need an epic for TLS rotation", "labels": ["epic", "feature", "team"]}'`,
      );
      resolve(server);
    });
  });
}
