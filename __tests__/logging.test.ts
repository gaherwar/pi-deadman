// __tests__/logging.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Logger } from "../extensions/logging";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Logger", () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadman-log-test-"));
    logger = new Logger(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- system.jsonl ---
  it("appends system poll to system.jsonl", () => {
    logger.logSystem({ ts: Date.now(), zone: "GREEN", canary_ms: 8.0 });
    const lines = fs.readFileSync(path.join(tmpDir, "system.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.zone).toBe("GREEN");
  });

  it("appends multiple system entries", () => {
    logger.logSystem({ ts: 1, zone: "GREEN" });
    logger.logSystem({ ts: 2, zone: "YELLOW" });
    logger.logSystem({ ts: 3, zone: "ORANGE" });
    const lines = fs.readFileSync(path.join(tmpDir, "system.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  // --- processes.jsonl ---
  it("appends process snapshot to processes.jsonl", () => {
    logger.logProcesses({ ts: Date.now(), processes: [{ pid: 1, name: "test", footprint_mb: 100 }] });
    const lines = fs.readFileSync(path.join(tmpDir, "processes.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  // --- tool_impact.jsonl ---
  it("appends tool impact to tool_impact.jsonl", () => {
    logger.logToolImpact({
      ts: Date.now(),
      command: "npm install",
      tier: 3,
      memory_before_mb: 500,
      memory_after_mb: 700,
      delta_mb: 200,
      duration_ms: 30000,
    });
    const lines = fs.readFileSync(path.join(tmpDir, "tool_impact.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.command).toBe("npm install");
    expect(entry.delta_mb).toBe(200);
  });

  // --- decisions.jsonl ---
  it("appends decision to decisions.jsonl", () => {
    logger.logDecision({
      ts: Date.now(),
      command: "docker build .",
      tier: 3,
      zone: "ORANGE",
      action: "block",
      reason: "System in ORANGE, tier 3 command blocked",
    });
    const lines = fs.readFileSync(path.join(tmpDir, "decisions.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("block");
  });

  it("logs pass decisions too", () => {
    logger.logDecision({
      ts: Date.now(),
      command: "cat file.txt",
      tier: 1,
      zone: "GREEN",
      action: "pass",
    });
    const lines = fs.readFileSync(path.join(tmpDir, "decisions.jsonl"), "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("pass");
  });

  // --- GC ---
  it("gc removes entries older than retention days", () => {
    const oldTs = Date.now() / 1000 - 86400 * 15; // 15 days ago
    const newTs = Date.now() / 1000; // now
    logger.logSystem({ ts: oldTs, zone: "GREEN" });
    logger.logSystem({ ts: newTs, zone: "YELLOW" });
    logger.gc(10); // 10-day retention
    const lines = fs.readFileSync(path.join(tmpDir, "system.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).zone).toBe("YELLOW");
  });

  it("gc runs across all 4 files", () => {
    const oldTs = Date.now() / 1000 - 86400 * 15;
    logger.logSystem({ ts: oldTs, zone: "OLD" });
    logger.logProcesses({ ts: oldTs, processes: [] });
    logger.logToolImpact({ ts: oldTs, command: "old" });
    logger.logDecision({ ts: oldTs, command: "old", action: "pass" });
    logger.gc(10);
    for (const file of ["system.jsonl", "processes.jsonl", "tool_impact.jsonl", "decisions.jsonl"]) {
      const content = fs.readFileSync(path.join(tmpDir, file), "utf-8").trim();
      expect(content).toBe("");
    }
  });

  // --- Resilience ---
  it("handles corrupted lines during read", () => {
    fs.writeFileSync(path.join(tmpDir, "system.jsonl"), '{"ts":1}\nnot json\n{"ts":2}\n');
    expect(() => logger.gc(10)).not.toThrow();
  });

  it("creates log files on first write", () => {
    expect(fs.existsSync(path.join(tmpDir, "system.jsonl"))).toBe(false);
    logger.logSystem({ ts: 1 });
    expect(fs.existsSync(path.join(tmpDir, "system.jsonl"))).toBe(true);
  });
});
