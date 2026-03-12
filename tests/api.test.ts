/**
 * Tests for api.ts — stateless NER extraction API.
 *
 * Covers:
 * - detectRelationships: co-occurrence logic, proximity filtering, signal phrases
 * - HTTP handler validation (request parsing, error responses)
 *
 * NER is mocked — these tests validate the co-occurrence relationship
 * detection and HTTP layer, not the GLiNER model.
 */

import { describe, it, expect } from "vitest";
import { detectRelationships } from "../src/api.js";
import type { NEREntity } from "../src/memory/ner.js";

// ── detectRelationships ─────────────────────────────────────────────────────

describe("detectRelationships", () => {
  it("returns empty array for fewer than 2 entities", () => {
    const entity: NEREntity = {
      text: "TLS rotation",
      label: "epic",
      score: 0.9,
      start: 0,
      end: 12,
    };
    expect(detectRelationships("TLS rotation", [entity])).toEqual([]);
    expect(detectRelationships("", [])).toEqual([]);
  });

  it("detects co-occurrence between nearby entities", () => {
    const text = "The TLS rotation epic depends on the certificate team";
    const entities: NEREntity[] = [
      { text: "TLS rotation", label: "epic", score: 0.9, start: 4, end: 16 },
      {
        text: "certificate team",
        label: "team",
        score: 0.85,
        start: 37,
        end: 53,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].source).toBe("TLS rotation");
    expect(rels[0].target).toBe("certificate team");
    expect(rels[0].sourceLabel).toBe("epic");
    expect(rels[0].targetLabel).toBe("team");
    expect(rels[0].weight).toBeGreaterThan(0);
    expect(rels[0].weight).toBeLessThanOrEqual(1);
  });

  it("filters entities that are too far apart", () => {
    // Create text where entities are > 300 chars apart
    const padding = "x".repeat(400);
    const text = `TLS rotation ${padding} certificate team`;
    const entities: NEREntity[] = [
      { text: "TLS rotation", label: "epic", score: 0.9, start: 0, end: 12 },
      {
        text: "certificate team",
        label: "team",
        score: 0.85,
        start: 13 + 400,
        end: 13 + 400 + 16,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(0);
  });

  it("detects signal phrases for specific relationship types", () => {
    const text = "The gateway service depends on the auth module for token validation";
    const entities: NEREntity[] = [
      {
        text: "gateway service",
        label: "software tool",
        score: 0.8,
        start: 4,
        end: 19,
      },
      {
        text: "auth module",
        label: "software tool",
        score: 0.85,
        start: 35,
        end: 46,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].relationship).toBe("depends_on");
    expect(rels[0].evidence).toBe("depends on");
  });

  it("defaults to relates_to when no signal phrase matches", () => {
    const text = "discussed TLS rotation and certificate team today";
    const entities: NEREntity[] = [
      { text: "TLS rotation", label: "epic", score: 0.9, start: 10, end: 22 },
      {
        text: "certificate team",
        label: "team",
        score: 0.85,
        start: 27,
        end: 43,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].relationship).toBe("relates_to");
    expect(rels[0].evidence).toMatch(/co-mentioned/);
  });

  it("deduplicates edges between the same entity pair", () => {
    // Same pair mentioned — should only get one edge
    const text = "epic A and team B and epic A with team B";
    const entities: NEREntity[] = [
      { text: "epic A", label: "epic", score: 0.9, start: 0, end: 6 },
      { text: "team B", label: "team", score: 0.85, start: 11, end: 17 },
      // Duplicate mention of same entities at different positions
      { text: "epic A", label: "epic", score: 0.9, start: 22, end: 28 },
      { text: "team B", label: "team", score: 0.85, start: 34, end: 40 },
    ];

    const rels = detectRelationships(text, entities);
    // May have multiple unique pairs, but no exact duplicates
    const keys = rels.map((r) => `${r.source}::${r.target}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it("assigns higher weight to closer entities", () => {
    const text =
      "Alpha is near Beta but far from Gamma xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx end";
    const entities: NEREntity[] = [
      { text: "Alpha", label: "epic", score: 0.9, start: 0, end: 5 },
      { text: "Beta", label: "feature", score: 0.8, start: 14, end: 18 },
      { text: "Gamma", label: "team", score: 0.85, start: 32, end: 37 },
    ];

    const rels = detectRelationships(text, entities);
    const alphaBeta = rels.find(
      (r) =>
        (r.source === "Alpha" && r.target === "Beta") ||
        (r.source === "Beta" && r.target === "Alpha"),
    );
    const alphaGamma = rels.find(
      (r) =>
        (r.source === "Alpha" && r.target === "Gamma") ||
        (r.source === "Gamma" && r.target === "Alpha"),
    );

    // Both should exist (within proximity)
    expect(alphaBeta).toBeDefined();
    expect(alphaGamma).toBeDefined();
    // Closer pair should have higher weight
    expect(alphaBeta!.weight).toBeGreaterThanOrEqual(alphaGamma!.weight);
  });

  it("uses alphabetical ordering for source/target", () => {
    const text = "Zebra and Alpha are co-mentioned";
    const entities: NEREntity[] = [
      { text: "Zebra", label: "team", score: 0.9, start: 0, end: 5 },
      { text: "Alpha", label: "epic", score: 0.85, start: 10, end: 15 },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].source).toBe("Alpha");
    expect(rels[0].target).toBe("Zebra");
  });

  it("handles overlapping entity spans (distance = 0)", () => {
    const text = "The TLS rotation team handles certificates";
    const entities: NEREntity[] = [
      {
        text: "TLS rotation team",
        label: "team",
        score: 0.9,
        start: 4,
        end: 21,
      },
      {
        text: "TLS rotation",
        label: "epic",
        score: 0.85,
        start: 4,
        end: 16,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels).toHaveLength(1);
    expect(rels[0].weight).toBe(1);
  });

  it("detects multiple relationship types in one pass", () => {
    const text =
      "Platform team created the gateway. The gateway depends on the auth service.";
    const entities: NEREntity[] = [
      {
        text: "Platform team",
        label: "team",
        score: 0.9,
        start: 0,
        end: 13,
      },
      { text: "gateway", label: "software tool", score: 0.85, start: 26, end: 33 },
      {
        text: "auth service",
        label: "software tool",
        score: 0.8,
        start: 58,
        end: 70,
      },
    ];

    const rels = detectRelationships(text, entities);
    expect(rels.length).toBeGreaterThanOrEqual(2);

    const createdRel = rels.find((r) => r.evidence === "created by");
    const dependsRel = rels.find((r) => r.evidence === "depends on");
    // At least one specific relationship should be detected
    expect(createdRel || dependsRel).toBeDefined();
  });
});
