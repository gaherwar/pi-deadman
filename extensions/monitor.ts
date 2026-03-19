// monitor.ts — background polling loop: canary + signals + process snapshots, adaptive interval

import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { runCanary } from "./canary.js";
import { collectSignals } from "./signals.js";
import { loadBaseline, saveBaseline, DEFAULT_BASELINE_MS, type Baseline } from "./calibration.js";
import { Zone, ZoneClassifier, POLL_INTERVALS } from "./zones.js";
import { getTopProcesses, type ProcessInfo } from "./processes.js";
import { Logger } from "./logging.js";
import { FootprintWorker } from "./worker.js";
import { shouldAutoKill, selectKillTarget, type WatchdogState, type KillDecision } from "./watchdog.js";
import { parseEtime, type SnapshotProcess } from "./tree.js";


export interface MonitorSnapshot {
  zone: Zone;
  trend: string;
  confirmed: boolean;
  isCalibrated: boolean;
  baseline: Baseline | null;
}

export class Monitor {
  public currentZone: Zone = Zone.GREEN;
  public isCalibrated: boolean = false;
  public baseline: Baseline | null = null;
  public pollCount: number = 0;

  private baselinePath: string;
  private logDir: string;
  private intervalId: NodeJS.Timeout | null = null;
  private zoneClassifier: ZoneClassifier = new ZoneClassifier();
  private logger: Logger | null = null;
  private latestProcesses: ProcessInfo[] = [];
  private isCalibrating: boolean = false;
  private worker: FootprintWorker = new FootprintWorker();
  private static readonly MAX_SNAPSHOT_HISTORY = 10;
  private watchdogState: WatchdogState = {
    snapshotHistory: [],
    lastNonRedTimestamp: 0,
    consecutiveNonRedPolls: 0,
    lastKillTime: 0,
    cooldownMs: 3000,
  };
  private autoKillCallback: ((decision: KillDecision) => void) | null = null;
  private watchdogTimerId: NodeJS.Timeout | null = null;
  private gcTimerId: NodeJS.Timeout | null = null;
  private zoneLocked: boolean = false;  // testing: prevent poll from overriding forced zone

  constructor(options: { baselinePath: string; logDir: string }) {
    this.baselinePath = options.baselinePath;
    this.logDir = options.logDir;

    // Try to load existing baseline
    const loadedBaseline = loadBaseline(this.baselinePath);
    if (loadedBaseline) {
      this.baseline = loadedBaseline;
      this.isCalibrated = true;
    }
  }

  start(): void {
    // Create log directory
    fs.mkdirSync(this.logDir, { recursive: true });

    // Create logger
    this.logger = new Logger(this.logDir);

    // Start background calibration if not calibrated
    if (!this.isCalibrated && !this.isCalibrating) {
      this.startCalibration();
    }

    // Start the footprint worker (non-blocking)
    this.worker.start().catch(() => {
      // Worker failed to start, will use fallback
    });

    // Start polling loop with responsive first poll (1000ms), then adaptive intervals
    this.scheduleNextPoll(1000);

    // Start independent fast watchdog loop (2s interval)
    // This runs separately from the poll so it can act even when the poll is stuck
    this.startWatchdogLoop();

    // Run log GC on start and every 10 days (retain 3 days)
    this.logger.gc(3);
    this.gcTimerId = setInterval(() => {
      if (this.logger) this.logger.gc(3);
    }, 10 * 24 * 3600_000);
  }

  stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
    if (this.watchdogTimerId) {
      clearInterval(this.watchdogTimerId);
      this.watchdogTimerId = null;
    }
    if (this.gcTimerId) {
      clearInterval(this.gcTimerId);
      this.gcTimerId = null;
    }
    this.worker.shutdown().catch(() => {});
  }

  getSnapshot(): MonitorSnapshot {
    return {
      zone: this.currentZone,
      trend: this.zoneClassifier.trend,
      confirmed: this.zoneClassifier.confirmed,
      isCalibrated: this.isCalibrated,
      baseline: this.baseline,
    };
  }

  getLatestProcesses(): ProcessInfo[] {
    return this.latestProcesses;
  }

  getWorker(): FootprintWorker {
    return this.worker;
  }

  getWatchdogState(): WatchdogState {
    return this.watchdogState;
  }

  onAutoKill(callback: (decision: KillDecision) => void): void {
    this.autoKillCallback = callback;
  }

  /** Force zone + confirmed state — for testing only.
   *  Locks the zone so performPoll won't override it. */
  _forceZone(zone: Zone, confirmed: boolean): void {
    this.currentZone = zone;
    this.zoneClassifier.zone = zone;
    this.zoneClassifier.confirmed = confirmed;
    this.zoneLocked = true;
  }

  /** Push a snapshot into the ring buffer, capping at MAX_SNAPSHOT_HISTORY */
  private pushSnapshot(snapshot: SnapshotProcess[]): void {
    this.watchdogState.snapshotHistory.push(snapshot);
    while (this.watchdogState.snapshotHistory.length > Monitor.MAX_SNAPSHOT_HISTORY) {
      this.watchdogState.snapshotHistory.shift();
    }
  }

  async getMemorySnapshot(): Promise<{ swap_used_mb: number; memorystatus_level: number }> {
    const signals = await collectSignals();
    return {
      swap_used_mb: signals.swap_used_mb,
      memorystatus_level: signals.memorystatus_level,
    };
  }

  private scheduleNextPoll(delayMs?: number): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
    }

    const interval = delayMs || POLL_INTERVALS[this.currentZone];
    
    this.intervalId = setTimeout(async () => {
      await this.performPoll();
      
      // Schedule next poll if still running
      if (this.intervalId !== null) {
        this.scheduleNextPoll();
      }
    }, interval);
  }

  private async performPoll(): Promise<void> {
    try {
      // Run canary test
      const canary = await runCanary();
      
      // Collect system signals
      const signals = await collectSignals();
      
      // Get top processes
      this.latestProcesses = await getTopProcesses();

      // Update zone classification if calibrated (skip if zone is locked for testing)
      if (this.isCalibrated && this.baseline && !this.zoneLocked) {
        const ratio = canary.total_ms / this.baseline.canary_ms;
        this.zoneClassifier.update(ratio, signals);
        this.currentZone = this.zoneClassifier.zone;
      }

      // Log system data
      if (this.logger) {
        this.logger.logSystem({
          ts: Date.now() / 1000,
          zone: this.currentZone,
          canary_ms: canary.total_ms,
          baseline_ms: this.baseline?.canary_ms || null,
          ratio: this.baseline ? canary.total_ms / this.baseline.canary_ms : null,
          trend: this.zoneClassifier.trend,
          confirmed: this.zoneClassifier.confirmed,
          ...signals,
        });

        this.logger.logProcesses({
          ts: Date.now() / 1000,
          processes: this.latestProcesses.slice(0, 10), // Log top 10
        });
      }

      // Update process tree snapshot (ring buffer) — needed for both watchdog and future diffs
      if (this.worker.isAlive()) {
        try {
          const children = await this.worker.getProcessTree(process.pid);
          this.pushSnapshot(children);

          // Track when the system was last stably not in RED.
          // Hysteresis: only update after 3 consecutive non-RED polls.
          // Prevents rapid RED↔ORANGE oscillation from collapsing the
          // temporal window to near-zero (the vitest crash scenario).
          if (this.currentZone !== Zone.RED) {
            this.watchdogState.consecutiveNonRedPolls++;
            if (this.watchdogState.consecutiveNonRedPolls >= 3) {
              this.watchdogState.lastNonRedTimestamp = Date.now() / 1000;
            }
          } else {
            this.watchdogState.consecutiveNonRedPolls = 0;
          }

        } catch {
          // Worker failed, continue with stale data
        }
      }

      // Watchdog: auto-kill on confirmed RED
      if (shouldAutoKill(this.currentZone, this.zoneClassifier.confirmed)) {
        try {
          const latestSnapshot = this.watchdogState.snapshotHistory.length > 0
            ? this.watchdogState.snapshotHistory[this.watchdogState.snapshotHistory.length - 1]
            : [];

          const decision = selectKillTarget(
            latestSnapshot,
            this.watchdogState,
            600, // 10 minutes max age
            process.pid,
          );

          if (decision) {
            // Auto-kill: SIGKILL pi's own child processes in confirmed RED zone
            for (const target of decision.targets) {
              try {
                process.kill(target.pid, "SIGKILL");
              } catch {
                // Process may already be dead
              }
            }
            this.watchdogState.lastKillTime = Date.now();

            if (this.logger) {
              this.logger.logDecision({
                ts: Date.now() / 1000,
                action: "auto_kill",
                targets: decision.targets.map(t => ({ pid: t.pid, name: t.name, footprint_mb: t.footprint_mb })),
                reason: decision.reason,
                zone: this.currentZone,
              });
            }

            if (this.autoKillCallback) {
              this.autoKillCallback(decision);
            }
          }
        } catch {
          // Watchdog failed, continue polling
        }
      }

      // Increment poll count
      this.pollCount++;
      
    } catch (error) {
      // Log error but continue polling
      if (this.logger) {
        this.logger.logSystem({
          ts: Date.now() / 1000,
          error: String(error),
          poll_count: this.pollCount,
        });
      }
    }
  }

  private startWatchdogLoop(): void {
    // Independent 2-second loop that ONLY checks zone + kills if needed
    // Uses ps for PID list (17ms) — no Python, no heavy operations
    this.watchdogTimerId = setInterval(() => {
      this.fastWatchdogCheck();
    }, 2000);
  }

  private fastWatchdogCheck(): void {
    if (!shouldAutoKill(this.currentZone, this.zoneClassifier.confirmed)) {
      return;
    }

    // Check cooldown
    if (this.watchdogState.lastKillTime > 0 &&
        Date.now() - this.watchdogState.lastKillTime < this.watchdogState.cooldownMs) {
      return;
    }

    try {
      // Fast PID scan — ps is a tiny C binary, runs even during thrashing (~17ms)
      const psOutput = execSync("ps -eo pid,ppid,etime,comm", {
        encoding: "utf-8",
        timeout: 5000,
      });

      // Parse all processes from ps output
      const piPid = process.pid;
      const processMap = new Map<number, { pid: number; ppid: number; name: string; etime: string }>();

      for (const line of psOutput.trim().split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const pid = parseInt(parts[0]);
          const ppid = parseInt(parts[1]);
          const etime = parts[2];
          // Strip path and parentheses — ps wraps some names in () e.g. "(ps)"
          const rawName = parts.slice(3).join(" ").split("/").pop() || parts[3];
          const name = rawName.replace(/^\(|\)$/g, "");
          if (!isNaN(pid) && !isNaN(ppid)) {
            processMap.set(pid, { pid, ppid, name, etime });
          }
        }
      }

      // Find ALL pi instances (cross-session scope).
      // Walk children of every pi process, not just our own.
      const piPids = new Set<number>();
      for (const [pid, info] of processMap) {
        if (info.name === "pi") {
          piPids.add(pid);
        }
      }
      // Always include our own PID as a root (in case it's named differently)
      piPids.add(piPid);

      // BFS from all pi roots to find all descendants
      const childPids = new Set<number>();
      const queue = [...piPids];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        for (const [pid, info] of processMap) {
          if (info.ppid === parent && !piPids.has(pid) && !childPids.has(pid)) {
            childPids.add(pid);
            queue.push(pid);
          }
        }
      }

      if (childPids.size === 0) return;

      // Exclude transient infrastructure processes (our own tools, not runaway targets)
      // Includes everything pi-breaker itself spawns: canary.ts (sysctl, true),
      // signals.ts (sysctl, vm_stat), processes.ts (python3, ps), worker.ts (python3)
      const INFRA_NAMES = new Set([
        "ps", "grep", "awk", "sed", "cut", "head", "tail", "wc",
        "sh", "bash", "zsh",
        "Python", "python3", "python", "Python.app",
        "footprint_worker.py",
        // pi-breaker's own monitoring subprocesses — must never be kill targets
        "sysctl", "vm_stat", "true", "memory_pressure",
        // Zombie/defunct processes — already dead, killing them is useless
        "<defunct>",
      ]);

      // Build current children list using cached footprint + fresh etime from ps
      const latestCached = this.watchdogState.snapshotHistory.length > 0
        ? this.watchdogState.snapshotHistory[this.watchdogState.snapshotHistory.length - 1]
        : [];

      const currentChildren: SnapshotProcess[] = [];
      for (const pid of childPids) {
        const info = processMap.get(pid);
        if (!info) continue;
        // Skip infrastructure processes — never kill our own tools
        if (INFRA_NAMES.has(info.name)) continue;
        // Use fresh etime from ps, fall back to cached age
        const cached = latestCached.find(p => p.pid === pid);
        const freshAge = parseEtime(info.etime);
        currentChildren.push({
          pid,
          name: info.name,
          footprint_mb: cached?.footprint_mb ?? 0,
          age_seconds: freshAge ?? cached?.age_seconds ?? null,
        });
      }

      // selectKillTarget uses snapshotHistory from watchdogState.
      // Protect all pi PIDs from being killed (not just our own).
      const decision = selectKillTarget(
        currentChildren,
        this.watchdogState,
        600,
        piPid, // Primary protection — selectKillTarget filters this out
      );

      if (decision) {
        // Fast watchdog auto-kill: SIGKILL pi's child processes in confirmed RED
        for (const target of decision.targets) {
          try {
            process.kill(target.pid, "SIGKILL");
          } catch {
            // Process may already be dead
          }
        }
        this.watchdogState.lastKillTime = Date.now();

        if (this.logger) {
          this.logger.logDecision({
            ts: Date.now() / 1000,
            action: "auto_kill_fast",
            targets: decision.targets.map(t => ({ pid: t.pid, name: t.name, footprint_mb: t.footprint_mb })),
            reason: decision.reason,
            zone: this.currentZone,
          });
        }

        if (this.autoKillCallback) {
          this.autoKillCallback(decision);
        }
      }
    } catch {
      // ps failed or timed out — system is too far gone, nothing we can do
    }
  }

  private async startCalibration(): Promise<void> {
    this.isCalibrating = true;

    try {
      const readings: number[] = [];
      const startTime = Date.now();
      const timeout = 60000; // 60 seconds timeout

      while (readings.length < 10 && (Date.now() - startTime) < timeout) {
        // Collect signals to check swapout rate
        const signals = await collectSignals();
        
        // Only collect reading if swapout_rate is 0 (idle condition)
        if (signals.swapout_rate === 0) {
          const canary = await runCanary();
          readings.push(canary.total_ms);
        }

        // Wait 2 seconds before next attempt
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      let canaryMs: number;
      let source: "calibrated" | "default";

      if (readings.length >= 10) {
        // Use median of collected readings
        readings.sort((a, b) => a - b);
        const mid = Math.floor(readings.length / 2);
        canaryMs = readings.length % 2 === 0 
          ? (readings[mid - 1] + readings[mid]) / 2 
          : readings[mid];
        source = "calibrated";
      } else {
        // Fallback to default
        canaryMs = DEFAULT_BASELINE_MS;
        source = "default";
      }

      // Create and save baseline
      const newBaseline: Baseline = {
        canary_ms: canaryMs,
        calibrated_at: new Date().toISOString(),
        source,
      };

      saveBaseline(newBaseline, this.baselinePath);
      this.baseline = newBaseline;
      this.isCalibrated = true;

    } catch (error) {
      // Fallback to default baseline on error
      const fallbackBaseline: Baseline = {
        canary_ms: DEFAULT_BASELINE_MS,
        calibrated_at: new Date().toISOString(),
        source: "default",
      };

      try {
        saveBaseline(fallbackBaseline, this.baselinePath);
      } catch {
        // If we can't save, just set in memory
      }
      
      this.baseline = fallbackBaseline;
      this.isCalibrated = true;
    }

    this.isCalibrating = false;
  }
}
