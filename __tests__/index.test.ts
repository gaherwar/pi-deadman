// __tests__/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getQuickMemorySnapshot,
  loadStats,
  saveStats,
  incrementKills,
} from "../extensions/index";

describe("getQuickMemorySnapshot", () => {
  it("returns swap_used_mb and memorystatus_level", async () => {
    const snap = await getQuickMemorySnapshot();
    expect(snap).toHaveProperty("swap_used_mb");
    expect(snap).toHaveProperty("memorystatus_level");
    expect(typeof snap.swap_used_mb).toBe("number");
    expect(typeof snap.memorystatus_level).toBe("number");
  });
});

describe("Stats persistence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-stats-"));
  const originalHome = process.env.HOME;

  beforeEach(() => {
    // Stats file reads from ~/.pi/breaker/stats.json — we test the functions directly
  });

  it("loadStats returns defaults when no file exists", () => {
    // loadStats catches file-not-found and returns defaults
    const stats = loadStats();
    expect(stats).toHaveProperty("kills_total");
    expect(stats).toHaveProperty("first_active");
    expect(typeof stats.kills_total).toBe("number");
  });

  it("saveStats and loadStats round-trip", () => {
    const stats = { kills_total: 5, first_active: "2026-01-01T00:00:00.000Z" };
    saveStats(stats);
    const loaded = loadStats();
    expect(loaded.kills_total).toBe(5);
    expect(loaded.first_active).toBe("2026-01-01T00:00:00.000Z");
  });

  it("incrementKills adds to the counter", () => {
    const before = loadStats();
    const after = incrementKills(3);
    expect(after.kills_total).toBe(before.kills_total + 3);
  });
});
