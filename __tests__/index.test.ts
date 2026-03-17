// __tests__/index.test.ts
import { describe, it, expect } from "vitest";
import {
  buildBlockReason,
  getQuickMemorySnapshot,
  buildProcessOptions,
} from "../extensions/index";
import { Zone } from "../extensions/zones";
import type { SnapshotProcess } from "../extensions/tree";

describe("buildBlockReason", () => {
  it("includes zone in the message", () => {
    const reason = buildBlockReason(Zone.RED, "npm install", 3);
    expect(reason).toContain("RED");
  });

  it("includes the command in the message", () => {
    const reason = buildBlockReason(Zone.ORANGE, "docker build .", 3);
    expect(reason).toContain("docker build .");
  });

  it("includes tier context for ORANGE + tier 3", () => {
    const reason = buildBlockReason(Zone.ORANGE, "npm run build", 3);
    expect(reason).toContain("heavy");
  });

  it("RED blocks everything — message reflects that", () => {
    const reason = buildBlockReason(Zone.RED, "cat file.txt", 0);
    expect(reason).toContain("RED");
    expect(reason).toContain("critical");
  });

  it("ORANGE message suggests freeing memory", () => {
    const reason = buildBlockReason(Zone.ORANGE, "npm install", 3);
    expect(reason).toContain("Free memory");
  });

  it("RED message mentions close applications", () => {
    const reason = buildBlockReason(Zone.RED, "ls", 1);
    expect(reason).toContain("close applications");
  });
});

describe("getQuickMemorySnapshot", () => {
  it("returns swap_used_mb and memorystatus_level", async () => {
    const snap = await getQuickMemorySnapshot();
    expect(snap).toHaveProperty("swap_used_mb");
    expect(snap).toHaveProperty("memorystatus_level");
    expect(typeof snap.swap_used_mb).toBe("number");
    expect(typeof snap.memorystatus_level).toBe("number");
  });
});

describe("buildProcessOptions", () => {
  it("returns pi children first, sorted by footprint descending", () => {
    const piChildren: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 },
      { pid: 2, name: "python3", footprint_mb: 300, age_seconds: 20 },
      { pid: 3, name: "bash", footprint_mb: 50, age_seconds: 5 },
    ];
    const options = buildProcessOptions(piChildren, 5);
    // Should be sorted: python3 (300), node (100), bash (50)
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(options[0]).toContain("python3");
    expect(options[0]).toContain("300");
    expect(options[1]).toContain("node");
  });

  it("limits to top N", () => {
    const piChildren: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 10 },
      { pid: 2, name: "b", footprint_mb: 200, age_seconds: 20 },
      { pid: 3, name: "c", footprint_mb: 300, age_seconds: 30 },
    ];
    const options = buildProcessOptions(piChildren, 2);
    // 2 process options + "Kill an external app"
    expect(options.filter(o => !o.startsWith("Kill an external"))).toHaveLength(2);
  });

  it("includes 'Kill an external app' as last option", () => {
    const piChildren: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 },
    ];
    const options = buildProcessOptions(piChildren, 5);
    expect(options[options.length - 1]).toContain("external");
  });

  it("shows only 'Kill an external app' when no pi children", () => {
    const options = buildProcessOptions([], 5);
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("external");
  });

  it("uses natural language descriptions with name, MB, and age", () => {
    const piChildren: SnapshotProcess[] = [
      { pid: 1, name: "npm", footprint_mb: 340, age_seconds: 12 },
    ];
    const options = buildProcessOptions(piChildren, 5);
    expect(options[0]).toContain("npm");
    expect(options[0]).toContain("340");
    expect(options[0]).toContain("12s");
  });
});
