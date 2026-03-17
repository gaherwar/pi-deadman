// __tests__/fast-watchdog.test.ts — integration test for the fast watchdog loop
// Spawns a real child process, seeds growth evidence, forces RED, verifies kill

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Monitor } from "../extensions/monitor";
import { Zone } from "../extensions/zones";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Fast Watchdog Integration", () => {
  let tmpDir: string;
  let baselinePath: string;
  let logDir: string;
  let monitor: Monitor;
  let childProc: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadman-watchdog-int-"));
    baselinePath = path.join(tmpDir, "baseline.json");
    logDir = path.join(tmpDir, "logs");

    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({
      canary_ms: 5.0,
      calibrated_at: new Date().toISOString(),
      source: "test",
    }));

    monitor = new Monitor({ baselinePath, logDir });
  });

  afterEach(() => {
    monitor.stop();
    if (childProc && !childProc.killed) {
      childProc.kill("SIGKILL");
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed the watchdog's snapshot history with fake growth data for a PID.
   * This simulates the monitor having observed the process growing over time.
   */
  function seedGrowthHistory(pid: number, name: string) {
    const state = monitor.getWatchdogState();
    state.snapshotHistory = [
      [{ pid, name, footprint_mb: 200, age_seconds: 10 }],
      [{ pid, name, footprint_mb: 400, age_seconds: 15 }],
      [{ pid, name, footprint_mb: 600, age_seconds: 20 }],
      [{ pid, name, footprint_mb: 800, age_seconds: 25 }],
    ];
  }

  it("kills a growing child process within 6 seconds of confirmed RED", async () => {
    childProc = spawn("sleep", ["60"], { stdio: "ignore" });
    const childPid = childProc.pid!;
    expect(childPid).toBeGreaterThan(0);

    const kills: any[] = [];
    monitor.onAutoKill((decision) => {
      kills.push(decision);
    });

    monitor.start();
    await new Promise(r => setTimeout(r, 1500));

    // Seed growth evidence for the child — simulates monitor having tracked it
    seedGrowthHistory(childPid, "sleep");

    // Force RED confirmed
    monitor._forceZone(Zone.RED, true);

    // Wait up to 6 seconds for the fast watchdog to fire
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      try {
        process.kill(childPid, 0);
      } catch {
        break;
      }
    }

    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }

    expect(alive).toBe(false);
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(kills[0].targets.some((t: any) => t.pid === childPid)).toBe(true);

    // Verify decision log
    const decisionsPath = path.join(logDir, "decisions.jsonl");
    expect(fs.existsSync(decisionsPath)).toBe(true);
    const entries = fs.readFileSync(decisionsPath, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    const killEntry = entries.find((e: any) => e.action === "auto_kill_fast");
    expect(killEntry).toBeDefined();
    expect(killEntry.targets.some((t: any) => t.pid === childPid)).toBe(true);
  });

  it("does NOT kill when zone is GREEN even with growth evidence", async () => {
    childProc = spawn("sleep", ["60"], { stdio: "ignore" });
    const childPid = childProc.pid!;

    const kills: any[] = [];
    monitor.onAutoKill((decision) => {
      kills.push(decision);
    });

    monitor.start();
    await new Promise(r => setTimeout(r, 200));

    seedGrowthHistory(childPid, "sleep");

    // Zone stays GREEN
    expect(monitor.currentZone).toBe(Zone.GREEN);

    await new Promise(r => setTimeout(r, 3000));

    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
    expect(kills).toHaveLength(0);
  });

  it("kills newest process in RED even without growth evidence", async () => {
    // The "newest" filter catches processes that appeared after the last
    // non-RED snapshot. Since the child spawned during warm-up (when system
    // was GREEN), forcing RED should trigger "newest" detection.
    // We seed a cached snapshot with non-zero footprint so the process
    // passes the footprint_mb > 0 guard (0 MB processes are infrastructure noise).
    childProc = spawn("sleep", ["60"], { stdio: "ignore" });
    const childPid = childProc.pid!;

    const kills: any[] = [];
    monitor.onAutoKill((decision) => {
      kills.push(decision);
    });

    monitor.start();
    await new Promise(r => setTimeout(r, 1500));

    // Seed a single snapshot with meaningful footprint (no growth pattern,
    // just proves the process exists with real memory usage).
    // Also set lastNonRedTimestamp explicitly — with hysteresis, the warm-up
    // period (1.5s) isn't long enough for 3 consecutive non-RED polls.
    const state = monitor.getWatchdogState();
    state.snapshotHistory = [
      [{ pid: childPid, name: "sleep", footprint_mb: 150, age_seconds: 3 }],
    ];
    state.lastNonRedTimestamp = Date.now() / 1000 - 5; // system was healthy 5s ago

    monitor._forceZone(Zone.RED, true);

    // Wait for the fast watchdog to fire
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      try {
        process.kill(childPid, 0);
      } catch {
        break;
      }
    }

    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(kills.length).toBeGreaterThanOrEqual(1);
  });

  // Cooldown is tested at the unit level in watchdog.test.ts.
  // Integration testing cooldown with real processes is timing-sensitive
  // and flaky — the unit test covers the logic reliably.
});
