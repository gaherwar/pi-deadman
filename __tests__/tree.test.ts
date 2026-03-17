// __tests__/tree.test.ts
import { describe, it, expect } from "vitest";
import {
  describeProcess,
  formatAge,
  parseEtime,
  findNewProcesses,
  findGrowingProcesses,
  findSimilarGroup,
  findSwarm,
  type SnapshotProcess,
} from "../extensions/tree";

describe("formatAge", () => {
  it("formats seconds under a minute", () => {
    expect(formatAge(30)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(formatAge(150)).toBe("2m 30s");
  });

  it("formats hours", () => {
    expect(formatAge(7200)).toBe("2h 0m");
  });

  it("returns unknown for null", () => {
    expect(formatAge(null)).toBe("unknown");
  });
});

describe("describeProcess", () => {
  it("includes name and footprint", () => {
    const desc = describeProcess({ pid: 123, name: "npm", footprint_mb: 340, age_seconds: 12 });
    expect(desc).toContain("npm");
    expect(desc).toContain("340");
  });

  it("includes human-readable age", () => {
    const desc = describeProcess({ pid: 123, name: "node", footprint_mb: 100, age_seconds: 150 });
    expect(desc).toContain("2m");
  });

  it("handles null age", () => {
    const desc = describeProcess({ pid: 123, name: "python3", footprint_mb: 50, age_seconds: null });
    expect(desc).toContain("python3");
    expect(desc).toContain("50");
  });
});

describe("findNewProcesses", () => {
  it("returns PIDs in current but not in previous snapshot", () => {
    const previous: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 60 },
      { pid: 2, name: "b", footprint_mb: 200, age_seconds: 120 },
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 65 },
      { pid: 3, name: "c", footprint_mb: 300, age_seconds: 5 },
    ];
    const newProcs = findNewProcesses(previous, current);
    expect(newProcs).toHaveLength(1);
    expect(newProcs[0].pid).toBe(3);
  });

  it("returns empty when no new processes", () => {
    const previous: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 60 },
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 65 },
    ];
    expect(findNewProcesses(previous, current)).toHaveLength(0);
  });

  it("handles empty previous snapshot", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 100, age_seconds: 5 },
    ];
    const newProcs = findNewProcesses([], current);
    expect(newProcs).toHaveLength(1);
  });
});

describe("findGrowingProcesses", () => {
  it("detects sustained growth across 3+ snapshots", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "chrome", footprint_mb: 200, age_seconds: 60 },
       { pid: 2, name: "node", footprint_mb: 100, age_seconds: 120 }],
      [{ pid: 1, name: "chrome", footprint_mb: 400, age_seconds: 65 },
       { pid: 2, name: "node", footprint_mb: 105, age_seconds: 125 }],
      [{ pid: 1, name: "chrome", footprint_mb: 600, age_seconds: 70 },
       { pid: 2, name: "node", footprint_mb: 110, age_seconds: 130 }],
      [{ pid: 1, name: "chrome", footprint_mb: 800, age_seconds: 75 },
       { pid: 2, name: "node", footprint_mb: 112, age_seconds: 135 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "chrome", footprint_mb: 800, age_seconds: 75 },
      { pid: 2, name: "node", footprint_mb: 112, age_seconds: 135 },
    ];
    // chrome: 200 → 400 → 600 → 800 = 3 growth intervals, delta 600 MB
    // node: 100 → 105 → 110 → 112 = 3 growth intervals, but delta only 12 MB
    const growing = findGrowingProcesses(history, current, 200);
    expect(growing).toHaveLength(1);
    expect(growing[0].pid).toBe(1);
    expect(growing[0].delta_mb).toBe(600);
  });

  it("returns empty with fewer than 3 snapshots", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 60 }],
      [{ pid: 1, name: "a", footprint_mb: 500, age_seconds: 65 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 500, age_seconds: 65 },
    ];
    expect(findGrowingProcesses(history, current, 200)).toHaveLength(0);
  });

  it("returns empty when growth count < minGrowthIntervals", () => {
    // Only 2 growth intervals, need 3
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 60 }],
      [{ pid: 1, name: "a", footprint_mb: 300, age_seconds: 65 }],
      [{ pid: 1, name: "a", footprint_mb: 400, age_seconds: 70 }],
      [{ pid: 1, name: "a", footprint_mb: 400, age_seconds: 75 }], // plateau
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 400, age_seconds: 75 },
    ];
    expect(findGrowingProcesses(history, current, 200)).toHaveLength(0);
  });

  it("tolerates plateaus if enough growth intervals exist", () => {
    // 200 → 350 → 350 → 500 → 500 → 600 = growth at intervals 0→1, 2→3, 4→5 = 3 intervals
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 60 }],
      [{ pid: 1, name: "a", footprint_mb: 350, age_seconds: 65 }],
      [{ pid: 1, name: "a", footprint_mb: 350, age_seconds: 70 }],
      [{ pid: 1, name: "a", footprint_mb: 500, age_seconds: 75 }],
      [{ pid: 1, name: "a", footprint_mb: 500, age_seconds: 80 }],
      [{ pid: 1, name: "a", footprint_mb: 600, age_seconds: 85 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 600, age_seconds: 85 },
    ];
    const growing = findGrowingProcesses(history, current, 200);
    expect(growing).toHaveLength(1);
    expect(growing[0].delta_mb).toBe(400);
  });

  it("returns empty when total delta below threshold", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 60 }],
      [{ pid: 1, name: "a", footprint_mb: 250, age_seconds: 65 }],
      [{ pid: 1, name: "a", footprint_mb: 300, age_seconds: 70 }],
      [{ pid: 1, name: "a", footprint_mb: 350, age_seconds: 75 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 350, age_seconds: 75 },
    ];
    // 3 growth intervals but total delta only 150 MB < 200 MB threshold
    expect(findGrowingProcesses(history, current, 200)).toHaveLength(0);
  });

  it("sorts by total delta descending", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 100, age_seconds: 60 },
       { pid: 2, name: "b", footprint_mb: 100, age_seconds: 60 }],
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 65 },
       { pid: 2, name: "b", footprint_mb: 300, age_seconds: 65 }],
      [{ pid: 1, name: "a", footprint_mb: 300, age_seconds: 70 },
       { pid: 2, name: "b", footprint_mb: 500, age_seconds: 70 }],
      [{ pid: 1, name: "a", footprint_mb: 400, age_seconds: 75 },
       { pid: 2, name: "b", footprint_mb: 700, age_seconds: 75 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 400, age_seconds: 75 },
      { pid: 2, name: "b", footprint_mb: 700, age_seconds: 75 },
    ];
    const growing = findGrowingProcesses(history, current, 200);
    expect(growing).toHaveLength(2);
    expect(growing[0].pid).toBe(2); // delta 600
    expect(growing[1].pid).toBe(1); // delta 300
  });

  it("skips PIDs missing from some snapshots without breaking", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "a", footprint_mb: 200, age_seconds: 60 }],
      // pid 1 missing from this snapshot
      [{ pid: 2, name: "b", footprint_mb: 100, age_seconds: 65 }],
      [{ pid: 1, name: "a", footprint_mb: 500, age_seconds: 70 },
       { pid: 2, name: "b", footprint_mb: 300, age_seconds: 70 }],
      [{ pid: 1, name: "a", footprint_mb: 700, age_seconds: 75 },
       { pid: 2, name: "b", footprint_mb: 500, age_seconds: 75 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 700, age_seconds: 75 },
      { pid: 2, name: "b", footprint_mb: 500, age_seconds: 75 },
    ];
    // pid 1: only present in 3 snapshots (0, 2, 3), but finds 2 footprints since we skip missing
    // pid 2: present in 3 snapshots (1, 2, 3), 2 growth intervals, delta 400
    const growing = findGrowingProcesses(history, current, 200);
    // pid 2 has 2 growth intervals (not enough for default minGrowthIntervals=3)
    // pid 1 has only 2 data points with gaps — likely not enough
    // Both should fail the minGrowthIntervals=3 check
    expect(growing).toHaveLength(0);
  });
});

describe("findSimilarGroup", () => {
  it("groups processes with same base name", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 },
      { pid: 2, name: "node", footprint_mb: 200, age_seconds: 15 },
      { pid: 3, name: "python3", footprint_mb: 150, age_seconds: 20 },
      { pid: 4, name: "node", footprint_mb: 300, age_seconds: 5 },
    ];
    const group = findSimilarGroup(processes);
    // Should find the "node" group (3 members) as the largest similar group
    expect(group).toHaveLength(3);
    expect(group.every(p => p.name === "node")).toBe(true);
  });

  it("returns empty for all different names", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 },
      { pid: 2, name: "python3", footprint_mb: 200, age_seconds: 15 },
      { pid: 3, name: "ruby", footprint_mb: 150, age_seconds: 20 },
    ];
    // No group has more than 1 — return empty (no "similar" group)
    expect(findSimilarGroup(processes)).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    expect(findSimilarGroup([])).toHaveLength(0);
  });
});

describe("parseEtime", () => {
  it("parses seconds only", () => {
    expect(parseEtime("05")).toBe(5);
  });

  it("parses MM:SS", () => {
    expect(parseEtime("02:30")).toBe(150);
  });

  it("parses HH:MM:SS", () => {
    expect(parseEtime("01:02:30")).toBe(3750);
  });

  it("parses DD-HH:MM:SS", () => {
    expect(parseEtime("1-00:00:00")).toBe(86400);
  });

  it("returns null for empty string", () => {
    expect(parseEtime("")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseEtime("abc")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseEtime("  02:30  ")).toBe(150);
  });
});

describe("findSwarm", () => {
  it("detects 3+ same-name processes above combined threshold", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 200, age_seconds: 10 },
      { pid: 2, name: "node", footprint_mb: 200, age_seconds: 15 },
      { pid: 3, name: "node", footprint_mb: 200, age_seconds: 20 },
    ];
    const swarm = findSwarm(processes, 3, 500);
    expect(swarm).toHaveLength(3);
    expect(swarm.every(p => p.name === "node")).toBe(true);
  });

  it("returns empty when below combined footprint threshold", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 50, age_seconds: 10 },
      { pid: 2, name: "node", footprint_mb: 50, age_seconds: 15 },
      { pid: 3, name: "node", footprint_mb: 50, age_seconds: 20 },
    ];
    // Combined = 150, threshold = 500
    expect(findSwarm(processes, 3, 500)).toHaveLength(0);
  });

  it("returns empty when fewer than minCount same-name processes", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 500, age_seconds: 10 },
      { pid: 2, name: "node", footprint_mb: 500, age_seconds: 15 },
    ];
    // Only 2, minCount = 3
    expect(findSwarm(processes, 3, 500)).toHaveLength(0);
  });

  it("picks the group with highest combined footprint", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 },
      { pid: 2, name: "node", footprint_mb: 100, age_seconds: 15 },
      { pid: 3, name: "node", footprint_mb: 100, age_seconds: 20 },
      { pid: 4, name: "python", footprint_mb: 300, age_seconds: 5 },
      { pid: 5, name: "python", footprint_mb: 300, age_seconds: 8 },
      { pid: 6, name: "python", footprint_mb: 300, age_seconds: 12 },
    ];
    const swarm = findSwarm(processes, 3, 500);
    expect(swarm).toHaveLength(3);
    expect(swarm[0].name).toBe("python"); // python group = 900 > node group = 300
  });

  it("returns empty for empty input", () => {
    expect(findSwarm([], 3, 500)).toHaveLength(0);
  });

  it("ignores groups of different names", () => {
    const processes: SnapshotProcess[] = [
      { pid: 1, name: "a", footprint_mb: 200, age_seconds: 10 },
      { pid: 2, name: "b", footprint_mb: 200, age_seconds: 15 },
      { pid: 3, name: "c", footprint_mb: 200, age_seconds: 20 },
    ];
    expect(findSwarm(processes, 3, 500)).toHaveLength(0);
  });
});
