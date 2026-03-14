import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const BUNDLE_PATH = join(ROOT, "dist", "extension", "extension.mjs");

describe("extension bundle", () => {
  let bundleContent: string;

  beforeAll(() => {
    execSync("node scripts/bundle-extension.mjs", {
      cwd: ROOT,
      stdio: "pipe",
    });
    bundleContent = readFileSync(BUNDLE_PATH, "utf-8");
  });

  it("bundle script executes without error", () => {
    // If we got here, beforeAll succeeded — the script ran without throwing
    expect(bundleContent).toBeDefined();
  });

  it("dist/extension/extension.mjs exists after bundling", () => {
    expect(bundleContent.length).toBeGreaterThan(0);
  });

  it("output starts with the createRequire banner", () => {
    expect(bundleContent).toMatch(
      /^import\s*\{\s*createRequire\s+as\s+__createRequire\s*\}\s*from\s*"node:module"/,
    );
  });

  it("contains all 5 tool name strings", () => {
    for (const tool of [
      "myelin_query",
      "myelin_boot",
      "myelin_log",
      "myelin_show",
      "myelin_stats",
    ]) {
      expect(bundleContent).toContain(tool);
    }
  });

  it("contains all 3 hook registration strings", () => {
    for (const hook of [
      "onSessionStart",
      "onSessionEnd",
      "onErrorOccurred",
    ]) {
      expect(bundleContent).toContain(hook);
    }
  });

  it("has the createRequire shim banner", () => {
    expect(bundleContent).toContain("globalThis.require");
    expect(bundleContent).toContain("__createRequire");
  });

  it("bundle size is between 1KB and 200KB", () => {
    const sizeBytes = Buffer.byteLength(bundleContent, "utf-8");
    expect(sizeBytes).toBeGreaterThan(1024);
    expect(sizeBytes).toBeLessThan(200 * 1024);
  });

  it("does not contain hardcoded personal paths", () => {
    expect(bundleContent).not.toContain("C:\\Users\\");
    expect(bundleContent).not.toContain("shsolomo");
  });
});
