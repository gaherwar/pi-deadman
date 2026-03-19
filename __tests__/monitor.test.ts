// __tests__/monitor.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Monitor } from "../extensions/monitor";
import { Zone } from "../extensions/zones";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Monitor", () => {
  let tmpDir: string;
  let baselinePath: string;
  let logDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-monitor-test-"));
    baselinePath = path.join(tmpDir, "baseline.json");
    logDir = path.join(tmpDir, "logs");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts in GREEN with default zone", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    expect(monitor.currentZone).toBe(Zone.GREEN);
  });

  it("reports not calibrated before calibration", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    expect(monitor.isCalibrated).toBe(false);
  });

  it("loads persisted baseline on construction", () => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({
      canary_ms: 7.5,
      calibrated_at: "2026-02-28T10:00:00.000Z",
      source: "calibrated",
    }));
    const monitor = new Monitor({ baselinePath, logDir });
    expect(monitor.isCalibrated).toBe(true);
    expect(monitor.baseline?.canary_ms).toBe(7.5);
  });

  it("getSnapshot returns current state", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    const snap = monitor.getSnapshot();
    expect(snap).toHaveProperty("zone");
    expect(snap).toHaveProperty("trend");
    expect(snap).toHaveProperty("confirmed");
    expect(snap).toHaveProperty("isCalibrated");
    expect(snap).toHaveProperty("baseline");
  });

  it("start and stop control the polling loop", async () => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({
      canary_ms: 8.0,
      calibrated_at: "2026-02-28T10:00:00.000Z",
      source: "calibrated",
    }));

    const monitor = new Monitor({ baselinePath, logDir });
    monitor.start();

    // Wait for at least one poll
    await new Promise(r => setTimeout(r, 1500));
    expect(monitor.pollCount).toBeGreaterThanOrEqual(1);

    monitor.stop();
    const countAfterStop = monitor.pollCount;

    // Wait and confirm no more polls
    await new Promise(r => setTimeout(r, 1500));
    expect(monitor.pollCount).toBe(countAfterStop);
  });

  it("creates log directory on start", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    monitor.start();
    expect(fs.existsSync(logDir)).toBe(true);
    monitor.stop();
  });

  // --- New tests for watchdog integration ---

  it("exposes worker for external use", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    // Worker should be accessible (may not be started yet)
    expect(monitor.getWorker()).toBeDefined();
  });

  it("has watchdog state with defaults", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    const state = monitor.getWatchdogState();
    expect(state).toHaveProperty("snapshotHistory");
    expect(state).toHaveProperty("lastNonRedTimestamp");
    expect(state).toHaveProperty("consecutiveNonRedPolls");
    expect(state).toHaveProperty("lastKillTime");
    expect(state).toHaveProperty("cooldownMs");
    expect(state.lastKillTime).toBe(0);
    expect(state.consecutiveNonRedPolls).toBe(0);
  });

  it("exposes onAutoKill callback setter", () => {
    const monitor = new Monitor({ baselinePath, logDir });
    const kills: any[] = [];
    monitor.onAutoKill((decision) => {
      kills.push(decision);
    });
    // Just verifying the API exists, no kill will fire in GREEN
    expect(kills).toHaveLength(0);
  });
});
