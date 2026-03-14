/**
 * Tests for backupGraph / rotateBackups (#37).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupGraph, rotateBackups } from "../../src/memory/replay.js";

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "myelin-backup-test-"));
  dbPath = join(tempDir, "graph.db");
});

afterEach(() => {
  // Clean up temp directory
  try {
    for (const f of readdirSync(tempDir)) {
      unlinkSync(join(tempDir, f));
    }
    rmdirSync(tempDir);
  } catch { /* best effort */ }
});

// ── backupGraph ──────────────────────────────────────────────────────────

describe("backupGraph", () => {
  it("creates a backup file with correct naming convention", () => {
    writeFileSync(dbPath, "fake-db-content");

    const result = backupGraph(dbPath);

    expect(result).not.toBeNull();
    expect(result).toContain("graph.db.backup-");
    expect(existsSync(result!)).toBe(true);

    // Verify timestamp format: YYYYMMDDHHmmss (14 digits)
    const backupName = result!.split("graph.db.backup-")[1];
    expect(backupName).toMatch(/^\d{14}$/);
  });

  it("skips if a backup with today's date already exists", () => {
    writeFileSync(dbPath, "fake-db-content");

    // Create a fake backup with today's date
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const fakeBackup = join(tempDir, `graph.db.backup-${today}120000`);
    writeFileSync(fakeBackup, "existing-backup");

    const result = backupGraph(dbPath);

    expect(result).toBeNull();

    // Verify no additional backup was created (only the fake one + original db)
    const backups = readdirSync(tempDir).filter(f => f.startsWith("graph.db.backup-"));
    expect(backups).toHaveLength(1);
  });

  it("returns null when database file doesn't exist (first run)", () => {
    // dbPath not created — simulates first run
    const result = backupGraph(dbPath);
    expect(result).toBeNull();
  });

  it("returns null for empty dbPath", () => {
    const result = backupGraph("");
    expect(result).toBeNull();
  });

  it("copies file content faithfully", () => {
    const content = "sqlite3-binary-data-here";
    writeFileSync(dbPath, content);

    const result = backupGraph(dbPath);
    expect(result).not.toBeNull();

    const backupContent = readFileSync(result!, "utf-8");
    expect(backupContent).toBe(content);
  });
});

// ── rotateBackups ────────────────────────────────────────────────────────

describe("rotateBackups", () => {
  it("deletes backups older than maxAgeDays", () => {
    writeFileSync(dbPath, "db");

    // Create a backup from 10 days ago
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const oldTs =
      `${oldDate.getFullYear()}${pad(oldDate.getMonth() + 1)}${pad(oldDate.getDate())}` +
      `${pad(oldDate.getHours())}${pad(oldDate.getMinutes())}${pad(oldDate.getSeconds())}`;
    const oldBackup = join(tempDir, `graph.db.backup-${oldTs}`);
    writeFileSync(oldBackup, "old-backup");

    // Create a backup from 2 days ago (should survive)
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const recentTs =
      `${recentDate.getFullYear()}${pad(recentDate.getMonth() + 1)}${pad(recentDate.getDate())}` +
      `${pad(recentDate.getHours())}${pad(recentDate.getMinutes())}${pad(recentDate.getSeconds())}`;
    const recentBackup = join(tempDir, `graph.db.backup-${recentTs}`);
    writeFileSync(recentBackup, "recent-backup");

    const deleted = rotateBackups(dbPath, 7);

    expect(deleted).toBe(1);
    expect(existsSync(oldBackup)).toBe(false);
    expect(existsSync(recentBackup)).toBe(true);
  });

  it("keeps all backups when none exceed maxAgeDays", () => {
    writeFileSync(dbPath, "db");

    // Create backups from 1 and 3 days ago
    const pad = (n: number) => String(n).padStart(2, "0");
    for (const daysAgo of [1, 3]) {
      const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const ts =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      writeFileSync(join(tempDir, `graph.db.backup-${ts}`), "backup");
    }

    const deleted = rotateBackups(dbPath, 7);

    expect(deleted).toBe(0);
    const backups = readdirSync(tempDir).filter(f => f.startsWith("graph.db.backup-"));
    expect(backups).toHaveLength(2);
  });

  it("returns 0 when no backup files exist", () => {
    writeFileSync(dbPath, "db");
    const deleted = rotateBackups(dbPath);
    expect(deleted).toBe(0);
  });

  it("skips legacy ISO-formatted backups it can't parse", () => {
    writeFileSync(dbPath, "db");

    // Legacy ISO format backup (from old backupDatabase)
    writeFileSync(
      join(tempDir, "graph.db.backup-2025-01-01T12-00-00-000Z"),
      "legacy",
    );

    // Valid old backup that should be deleted
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const oldTs =
      `${oldDate.getFullYear()}${pad(oldDate.getMonth() + 1)}${pad(oldDate.getDate())}` +
      `${pad(oldDate.getHours())}${pad(oldDate.getMinutes())}${pad(oldDate.getSeconds())}`;
    writeFileSync(join(tempDir, `graph.db.backup-${oldTs}`), "old");

    const deleted = rotateBackups(dbPath, 7);

    // Only the parseable old backup is deleted; legacy ISO one is untouched
    expect(deleted).toBe(1);
    expect(existsSync(join(tempDir, "graph.db.backup-2025-01-01T12-00-00-000Z"))).toBe(true);
  });

  it("respects custom maxAgeDays", () => {
    writeFileSync(dbPath, "db");

    // Create a backup from 2 days ago
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    writeFileSync(join(tempDir, `graph.db.backup-${ts}`), "backup");

    // With maxAgeDays=1, a 2-day-old backup should be deleted
    const deleted = rotateBackups(dbPath, 1);
    expect(deleted).toBe(1);
  });
});
