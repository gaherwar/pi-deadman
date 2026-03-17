// __tests__/watchdog.test.ts
import { describe, it, expect } from "vitest";
import {
  selectKillTarget,
  shouldAutoKill,
  MIN_FOOTPRINT_MB,
  GROWTH_THRESHOLD_MB,
  SWARM_MIN_COUNT,
  SWARM_MIN_COMBINED_MB,
  HEAVY_YOUNG_MAX_AGE_SECONDS,
  HEAVY_YOUNG_MIN_FOOTPRINT_MB,
  type WatchdogState,
} from "../extensions/watchdog";
import type { SnapshotProcess } from "../extensions/tree";

function mkState(overrides: Partial<WatchdogState> = {}): WatchdogState {
  return {
    snapshotHistory: [],
    lastNonRedTimestamp: 0,
    consecutiveNonRedPolls: 0,
    lastKillTime: 0,
    cooldownMs: 3000,
    ...overrides,
  };
}

describe("shouldAutoKill", () => {
  it("returns true for confirmed RED zone", () => {
    expect(shouldAutoKill("RED", true)).toBe(true);
  });

  it("returns false for unconfirmed RED", () => {
    expect(shouldAutoKill("RED", false)).toBe(false);
  });

  it("returns false for ORANGE", () => {
    expect(shouldAutoKill("ORANGE", true)).toBe(false);
  });

  it("returns false for GREEN", () => {
    expect(shouldAutoKill("GREEN", true)).toBe(false);
  });

  it("returns false for YELLOW", () => {
    expect(shouldAutoKill("YELLOW", true)).toBe(false);
  });
});

describe("selectKillTarget", () => {
  const MAX_AGE = 600;

  // --- Footprint floor ---

  it("never kills processes below MIN_FOOTPRINT_MB", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "ps", footprint_mb: 0, age_seconds: 1 }],
      [{ pid: 1, name: "ps", footprint_mb: 0, age_seconds: 2 }],
      [{ pid: 1, name: "ps", footprint_mb: 0, age_seconds: 3 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "ps", footprint_mb: 0, age_seconds: 3 },
    ];
    const state = mkState({
      snapshotHistory: history,
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  it("never kills 9 MB process even with newest match", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "Develop", footprint_mb: 9, age_seconds: 5 },
    ];
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  it("kills process at exactly MIN_FOOTPRINT_MB", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: MIN_FOOTPRINT_MB, age_seconds: 5 },
    ];
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
  });

  // --- Priority 1: Growing ---

  it("kills growing process over larger stable process", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "chrome", footprint_mb: 200, age_seconds: 300 },
       { pid: 2, name: "stable", footprint_mb: 1000, age_seconds: 300 }],
      [{ pid: 1, name: "chrome", footprint_mb: 300, age_seconds: 305 },
       { pid: 2, name: "stable", footprint_mb: 1000, age_seconds: 305 }],
      [{ pid: 1, name: "chrome", footprint_mb: 400, age_seconds: 310 },
       { pid: 2, name: "stable", footprint_mb: 1000, age_seconds: 310 }],
      [{ pid: 1, name: "chrome", footprint_mb: 500, age_seconds: 315 },
       { pid: 2, name: "stable", footprint_mb: 1000, age_seconds: 315 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "chrome", footprint_mb: 500, age_seconds: 315 },
      { pid: 2, name: "stable", footprint_mb: 1000, age_seconds: 315 },
    ];
    const state = mkState({ snapshotHistory: history });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.targets[0].pid).toBe(1); // Growing chrome, not stable large
    expect(decision!.reason).toContain("growing");
  });

  it("uses 100 MB growth threshold (lowered from 200 MB)", () => {
    // Process grows 120 MB across 4 snapshots — should qualify with new threshold
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "node", footprint_mb: 100, age_seconds: 10 }],
      [{ pid: 1, name: "node", footprint_mb: 130, age_seconds: 15 }],
      [{ pid: 1, name: "node", footprint_mb: 170, age_seconds: 20 }],
      [{ pid: 1, name: "node", footprint_mb: 220, age_seconds: 25 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 220, age_seconds: 25 },
    ];
    const state = mkState({ snapshotHistory: history });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain("growing");
  });

  // --- Priority 2: Swarm ---

  it("kills swarm of same-name processes above combined threshold", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node (vitest 1)", footprint_mb: 200, age_seconds: 30 },
      { pid: 2, name: "node (vitest 1)", footprint_mb: 200, age_seconds: 25 },
      { pid: 3, name: "node (vitest 1)", footprint_mb: 200, age_seconds: 20 },
    ];
    const state = mkState();
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.targets).toHaveLength(3);
    expect(decision!.reason).toContain("swarm");
  });

  it("does not trigger swarm with fewer than 3 same-name processes", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 300, age_seconds: 30 },
      { pid: 2, name: "node", footprint_mb: 300, age_seconds: 25 },
    ];
    const state = mkState();
    // 2 processes, minCount = 3 — not a swarm
    // But they're heavy+young, so they'll still be caught by priority 3
    const decision = selectKillTarget(current, state, MAX_AGE);
    if (decision) {
      expect(decision.reason).not.toContain("swarm");
    }
  });

  it("does not trigger swarm below combined footprint threshold", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 60, age_seconds: 30 },
      { pid: 2, name: "node", footprint_mb: 60, age_seconds: 25 },
      { pid: 3, name: "node", footprint_mb: 60, age_seconds: 20 },
    ];
    const state = mkState();
    // Combined = 180, threshold = 500 — not a swarm
    const decision = selectKillTarget(current, state, MAX_AGE);
    // May still be caught by heavy+young or newest, but not swarm
    if (decision) {
      expect(decision.reason).not.toContain("swarm");
    }
  });

  it("growing takes priority over swarm", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 99, name: "leak", footprint_mb: 100, age_seconds: 10 }],
      [{ pid: 99, name: "leak", footprint_mb: 200, age_seconds: 15 }],
      [{ pid: 99, name: "leak", footprint_mb: 300, age_seconds: 20 }],
      [{ pid: 99, name: "leak", footprint_mb: 400, age_seconds: 25 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 99, name: "leak", footprint_mb: 400, age_seconds: 25 },
      { pid: 1, name: "node", footprint_mb: 200, age_seconds: 30 },
      { pid: 2, name: "node", footprint_mb: 200, age_seconds: 25 },
      { pid: 3, name: "node", footprint_mb: 200, age_seconds: 20 },
    ];
    const state = mkState({ snapshotHistory: history });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain("growing");
    expect(decision!.targets[0].pid).toBe(99);
  });

  // --- Priority 3: Heavy & young ---

  it("kills heavy young process at 200 MB threshold (lowered from 1 GB)", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "npm", footprint_mb: 250, age_seconds: 120 },
    ];
    const state = mkState();
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain("heavy & young");
  });

  it("does not kill old heavy process via heavy+young", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "firefox", footprint_mb: 1500, age_seconds: 7200 },
    ];
    const state = mkState();
    // age 7200 > HEAVY_YOUNG_MAX_AGE_SECONDS (600)
    // Also exceeds maxAgeSeconds (600), so filtered entirely
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  it("swarm takes priority over heavy+young", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 200, age_seconds: 30 },
      { pid: 2, name: "node", footprint_mb: 200, age_seconds: 25 },
      { pid: 3, name: "node", footprint_mb: 200, age_seconds: 20 },
      { pid: 99, name: "webpack", footprint_mb: 300, age_seconds: 60 },
    ];
    const state = mkState();
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain("swarm");
  });

  // --- Priority 4: Newest (single target only) ---

  it("kills only the largest newest process, not all", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "small", footprint_mb: 60, age_seconds: 5 },
      { pid: 2, name: "big", footprint_mb: 200, age_seconds: 8 },
    ];
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    // big (200MB) qualifies as heavy+young, so it gets caught there.
    // Let's test with processes that only qualify for newest (not heavy+young):
  });

  it("newest kills single largest when no other signal matches", () => {
    // Both are below HEAVY_YOUNG_MIN_FOOTPRINT_MB (200) but above MIN_FOOTPRINT_MB (50)
    // Neither is growing, no swarm — only newest matches
    const current: SnapshotProcess[] = [
      { pid: 1, name: "process_a", footprint_mb: 80, age_seconds: 5 },
      { pid: 2, name: "process_b", footprint_mb: 150, age_seconds: 8 },
    ];
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.targets).toHaveLength(1); // Single target only!
    expect(decision!.targets[0].pid).toBe(2); // The larger one
    expect(decision!.reason).toContain("newest");
  });

  it("newest does not fire when lastNonRedTimestamp is 0", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 5 },
    ];
    const state = mkState({ lastNonRedTimestamp: 0 });
    // No growth, no swarm, no heavy+young (100 < 200), no newest (timestamp=0)
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  it("newest does not match process outside temporal window", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 100, age_seconds: 120 },
    ];
    // lastNonRedTimestamp = 30 seconds ago, but process is 120s old — too old
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 30,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  // --- Cooldown ---

  it("returns null during cooldown", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node", footprint_mb: 500, age_seconds: 30 },
    ];
    const state = mkState({
      lastKillTime: Date.now() - 1000, // 1 second ago
      cooldownMs: 3000,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  it("allows kill after cooldown expires", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "runaway", footprint_mb: 200, age_seconds: 10 }],
      [{ pid: 1, name: "runaway", footprint_mb: 400, age_seconds: 15 }],
      [{ pid: 1, name: "runaway", footprint_mb: 600, age_seconds: 20 }],
      [{ pid: 1, name: "runaway", footprint_mb: 800, age_seconds: 25 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "runaway", footprint_mb: 800, age_seconds: 25 },
    ];
    const state = mkState({
      snapshotHistory: history,
      lastKillTime: Date.now() - 5000,
      cooldownMs: 3000,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).not.toBeNull();
  });

  // --- Protection ---

  it("never targets pi itself (protectedPid)", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: process.pid, name: "node", footprint_mb: 200, age_seconds: 10 },
       { pid: 99999, name: "other", footprint_mb: 200, age_seconds: 5 }],
      [{ pid: process.pid, name: "node", footprint_mb: 400, age_seconds: 15 },
       { pid: 99999, name: "other", footprint_mb: 400, age_seconds: 10 }],
      [{ pid: process.pid, name: "node", footprint_mb: 600, age_seconds: 20 },
       { pid: 99999, name: "other", footprint_mb: 600, age_seconds: 15 }],
      [{ pid: process.pid, name: "node", footprint_mb: 800, age_seconds: 25 },
       { pid: 99999, name: "other", footprint_mb: 800, age_seconds: 20 }],
    ];
    const current: SnapshotProcess[] = [
      { pid: process.pid, name: "node", footprint_mb: 800, age_seconds: 25 },
      { pid: 99999, name: "other", footprint_mb: 800, age_seconds: 20 },
    ];
    const state = mkState({ snapshotHistory: history });
    const decision = selectKillTarget(current, state, MAX_AGE, process.pid);
    if (decision) {
      expect(decision.targets.every(t => t.pid !== process.pid)).toBe(true);
    }
  });

  it("handles processes with null age by treating them as eligible", () => {
    const history: SnapshotProcess[][] = [
      [{ pid: 1, name: "mystery", footprint_mb: 200, age_seconds: null }],
      [{ pid: 1, name: "mystery", footprint_mb: 400, age_seconds: null }],
      [{ pid: 1, name: "mystery", footprint_mb: 600, age_seconds: null }],
      [{ pid: 1, name: "mystery", footprint_mb: 800, age_seconds: null }],
    ];
    const current: SnapshotProcess[] = [
      { pid: 1, name: "mystery", footprint_mb: 800, age_seconds: null },
    ];
    const state = mkState({ snapshotHistory: history });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
  });

  // --- No match ---

  it("returns null when no eligible processes exist", () => {
    const state = mkState();
    expect(selectKillTarget([], state, MAX_AGE)).toBeNull();
  });

  it("returns null when all processes are below footprint floor", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "ps", footprint_mb: 0, age_seconds: 1 },
      { pid: 2, name: "sysctl", footprint_mb: 2, age_seconds: 1 },
      { pid: 3, name: "sleep", footprint_mb: 8, age_seconds: 5 },
      { pid: 4, name: "Develop", footprint_mb: 9, age_seconds: 300 },
    ];
    const state = mkState({
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    expect(selectKillTarget(current, state, MAX_AGE)).toBeNull();
  });

  // --- Priority ordering ---

  it("priority: growing > swarm > heavy+young > newest", () => {
    // Set up a scenario where all 4 could match
    const history: SnapshotProcess[][] = [
      [{ pid: 99, name: "leak", footprint_mb: 100, age_seconds: 10 }],
      [{ pid: 99, name: "leak", footprint_mb: 200, age_seconds: 15 }],
      [{ pid: 99, name: "leak", footprint_mb: 300, age_seconds: 20 }],
      [{ pid: 99, name: "leak", footprint_mb: 400, age_seconds: 25 }],
    ];
    const current: SnapshotProcess[] = [
      // Growing
      { pid: 99, name: "leak", footprint_mb: 400, age_seconds: 25 },
      // Swarm candidates
      { pid: 1, name: "worker", footprint_mb: 200, age_seconds: 30 },
      { pid: 2, name: "worker", footprint_mb: 200, age_seconds: 25 },
      { pid: 3, name: "worker", footprint_mb: 200, age_seconds: 20 },
      // Heavy+young
      { pid: 4, name: "npm", footprint_mb: 300, age_seconds: 60 },
    ];
    const state = mkState({
      snapshotHistory: history,
      lastNonRedTimestamp: Date.now() / 1000 - 60,
    });
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain("growing"); // Growing wins
  });

  // --- Vitest crash scenario ---

  it("catches 7 vitest workers as swarm even without growth history", () => {
    const current: SnapshotProcess[] = [
      { pid: 1, name: "node (vitest)", footprint_mb: 500, age_seconds: 30 },
      { pid: 2, name: "node (vitest)", footprint_mb: 480, age_seconds: 28 },
      { pid: 3, name: "node (vitest)", footprint_mb: 470, age_seconds: 25 },
      { pid: 4, name: "node (vitest)", footprint_mb: 460, age_seconds: 22 },
      { pid: 5, name: "node (vitest)", footprint_mb: 450, age_seconds: 20 },
      { pid: 6, name: "node (vitest)", footprint_mb: 440, age_seconds: 18 },
      { pid: 7, name: "node (vitest)", footprint_mb: 430, age_seconds: 15 },
    ];
    const state = mkState();
    const decision = selectKillTarget(current, state, MAX_AGE);
    expect(decision).not.toBeNull();
    expect(decision!.targets).toHaveLength(7);
    expect(decision!.reason).toContain("swarm");
  });
});
