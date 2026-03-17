// index.ts — Pi extension entry point: tool_call gate, background monitor lifecycle, /deadman command

import * as path from "node:path";
import * as os from "node:os";
import { Monitor } from "./monitor.js";
import { classifyTier } from "./keywords.js";
import { shouldBlock, Zone } from "./zones.js";
import { formatProcessList, killProcess } from "./processes.js";
import { collectSignals } from "./signals.js";
import { Logger } from "./logging.js";
import { describeProcess, type SnapshotProcess } from "./tree.js";

// Testable utility functions (exported for tests)
export function buildBlockReason(zone: Zone, command: string, tier: number): string {
  if (zone === Zone.RED) {
    return `🔴 System in critical RED zone. \`${command}\` blocked. System is critically low on memory — close applications before continuing.`;
  }
  
  if (zone === Zone.ORANGE && tier === 3) {
    return `⛔ System in ORANGE zone. \`${command}\` is a heavy operation that could push the system to critical. Free memory first.`;
  }
  
  // This shouldn't happen based on shouldBlock logic, but handle it gracefully
  return `System memory constraints detected. \`${command}\` may be risky to run.`;
}

// Build select options: pi children first (ranked by footprint), then external app option
export function buildProcessOptions(piChildren: SnapshotProcess[], limit: number): string[] {
  const sorted = [...piChildren].sort((a, b) => b.footprint_mb - a.footprint_mb);
  const top = sorted.slice(0, limit);
  const options = top.map(proc => `Kill: ${describeProcess(proc)}`);
  options.push("Kill an external app instead");
  return options;
}

export async function getQuickMemorySnapshot(): Promise<{ swap_used_mb: number; memorystatus_level: number }> {
  const signals = await collectSignals();
  return {
    swap_used_mb: signals.swap_used_mb,
    memorystatus_level: signals.memorystatus_level,
  };
}

// Helper: show kill menu with pi children first, then external apps
async function showKillMenu(
  monitor: any,
  logger: Logger | null,
  ctx: any,
  title: string,
  extraOptions?: string[],
): Promise<{ killed: boolean; selectedExternal: boolean; forceRun: boolean }> {
  // Get pi's process tree via worker
  const worker = monitor.getWorker();
  let piChildren: SnapshotProcess[] = [];
  if (worker.isAlive()) {
    try {
      piChildren = await worker.getProcessTree(process.pid);
    } catch {
      // Worker failed, fall back to empty
    }
  }

  const options = buildProcessOptions(piChildren, 5);
  if (extraOptions) {
    options.push(...extraOptions);
  }

  const choice = await ctx.ui.select(title, options);

  if (!choice) {
    return { killed: false, selectedExternal: false, forceRun: false };
  }

  if (choice === "Kill an external app instead") {
    return { killed: false, selectedExternal: true, forceRun: false };
  }

  if (choice.startsWith("⚠️ Force run")) {
    return { killed: false, selectedExternal: false, forceRun: true };
  }

  if (choice.startsWith("Kill: ")) {
    // Find the process to kill — match by position in options
    const killIndex = options.indexOf(choice);
    const sorted = [...piChildren].sort((a, b) => b.footprint_mb - a.footprint_mb);
    const target = sorted[killIndex];
    if (target) {
      killProcess(target.pid);
      if (logger) {
        logger.logDecision({ ts: Date.now() / 1000, action: "user_kill", target: { pid: target.pid, name: target.name, footprint_mb: target.footprint_mb }, zone: monitor.currentZone });
      }
      await new Promise(r => setTimeout(r, 2000));
      return { killed: true, selectedExternal: false, forceRun: false };
    }
  }

  return { killed: false, selectedExternal: false, forceRun: false };
}

// Helper: show external app kill menu (existing flow)
async function showExternalKillMenu(
  monitor: any,
  logger: Logger | null,
  ctx: any,
): Promise<boolean> {
  const processes = monitor.getLatestProcesses();
  const formatted = formatProcessList(processes, 5);
  const options = formatted.length > 0
    ? [...formatted.map((f: string) => `Kill: ${f}`), "Done"]
    : ["No processes found"];

  const choice = await ctx.ui.select("Kill an external app:", options);

  if (!choice || choice === "Done" || choice.startsWith("No processes")) {
    return false;
  }

  const selectedIndex = options.indexOf(choice);
  const selectedProcess = processes[selectedIndex];
  if (selectedProcess) {
    killProcess(selectedProcess.pid);
    if (logger) {
      logger.logDecision({ ts: Date.now() / 1000, action: "user_kill_external", target: { pid: selectedProcess.pid, name: selectedProcess.name, footprint_mb: selectedProcess.footprint_mb }, zone: monitor.currentZone });
    }
    await new Promise(r => setTimeout(r, 2000));
    return true;
  }
  return false;
}

// Interactive blocking flow
// ORANGE: user can "Run anyway" or "Free memory first"
// RED: user must "Free memory first" (no bypass)
async function handleBlockingFlow(
  zone: Zone,
  tier: number,
  command: string,
  monitor: any,
  logger: Logger | null,
  ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
  const reason = buildBlockReason(zone, command, tier);

  // RED zone: must free memory, but user can force-run after first attempt
  if (zone === Zone.RED) {
    let loopCount = 0;
    while (true) {
      loopCount++;
      const extraOptions = loopCount > 1
        ? ["⚠️ Force run (I know the risks)"]
        : undefined;

      const { killed, selectedExternal, forceRun } = await showKillMenu(
        monitor, logger, ctx,
        `🔴 ${reason}\n\nKill a process to free memory:`,
        extraOptions,
      );

      if (forceRun) {
        if (logger) {
          logger.logDecision({ ts: Date.now() / 1000, action: "pass_force_run", command, tier, zone: "RED", reason: "User forced run despite RED zone" });
        }
        return undefined;
      }

      if (selectedExternal) {
        await showExternalKillMenu(monitor, logger, ctx);
      }

      if (!killed && !selectedExternal) {
        // User pressed Escape — hard block
        if (logger) {
          logger.logDecision({ ts: Date.now() / 1000, action: "block", command, tier, zone: "RED", reason: "User cancelled — still RED" });
        }
        return { block: true, reason };
      }

      // Re-check zone
      const snap = monitor.getSnapshot();
      if (snap.zone !== Zone.RED) {
        if (logger) {
          logger.logDecision({ ts: Date.now() / 1000, action: "pass_after_kill", command, tier, zone: snap.zone, reason: `Zone improved from RED to ${snap.zone}` });
        }
        return undefined;
      }
      // Still RED — loop back (next iteration shows force-run option)
    }
  }

  // ORANGE zone: user gets a choice
  const choice = await ctx.ui.select(
    `⛔ ${reason}`,
    ["Run anyway", "Free memory first"],
  );

  if (choice === "Run anyway") {
    if (logger) {
      logger.logDecision({ ts: Date.now() / 1000, action: "pass_override", command, tier, zone: "ORANGE", reason: "User chose to run anyway" });
    }
    return undefined;
  }

  if (choice === "Free memory first") {
    while (true) {
      const { killed, selectedExternal } = await showKillMenu(
        monitor, logger, ctx,
        "Kill a process to free memory:",
        ["Done — run the command"],
      );

      if (selectedExternal) {
        await showExternalKillMenu(monitor, logger, ctx);
        continue;
      }

      if (!killed) {
        // User selected "Done" or Escape — let command through
        if (logger) {
          logger.logDecision({ ts: Date.now() / 1000, action: "pass_after_kill", command, tier, zone: "ORANGE", reason: "User finished freeing memory" });
        }
        return undefined;
      }
      // Killed something — loop to show updated list
    }
  }

  // User pressed Escape — block
  if (logger) {
    logger.logDecision({ ts: Date.now() / 1000, action: "block", command, tier, zone: "ORANGE", reason: "User dismissed prompt" });
  }
  return { block: true, reason };
}

// Pi extension entry point (default export)
export default function (pi: any) {
  // macOS only — sysctl, vm_stat, memory_pressure are Darwin-specific
  if (process.platform !== "darwin") {
    return;
  }

  const DATA_DIR = path.join(os.homedir(), ".pi", "deadman");
  const monitor = new Monitor({
    baselinePath: path.join(DATA_DIR, "baseline.json"),
    logDir: path.join(DATA_DIR, "logs"),
  });

  let logger: Logger | null = null;

  // Hook into session lifecycle
  pi.on("session_start", async (_event: any, ctx: any) => {
    monitor.start();
    logger = new Logger(path.join(DATA_DIR, "logs"));

    // Register auto-kill notification
    monitor.onAutoKill((decision: any) => {
      const names = decision.targets.map((t: any) => `${t.name} (${t.footprint_mb} MB)`).join(", ");
      ctx.ui.notify(`⚠️ Auto-killed: ${names} — system was in critical RED zone. Reason: ${decision.reason}`, "warning");
    });
  });

  pi.on("session_shutdown", () => {
    monitor.stop();
  });

  // Track pre-execution memory snapshots
  const preSnapshots = new Map<string, { swap_used_mb: number; memorystatus_level: number; timestamp: number }>();

  // Hook into tool_call for bash commands
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input?.command || "";
    const tier = classifyTier(command);
    const zone = monitor.currentZone;

    // Take pre-execution memory snapshot
    const memSnap = await getQuickMemorySnapshot();
    preSnapshots.set(event.toolCallId, { ...memSnap, timestamp: Date.now() });

    // Check if we should block
    if (shouldBlock(zone, tier)) {
      // Log the block decision
      if (logger) {
        logger.logDecision({
          ts: Date.now() / 1000,
          action: "block_prompted",
          command,
          tier,
          zone,
          reason: buildBlockReason(zone, command, tier),
        });
      }

      // Interactive blocking flow
      const result = await handleBlockingFlow(zone, tier, command, monitor, logger, ctx);
      return result;
    }

    // Log pass decision
    if (logger) {
      logger.logDecision({
        ts: Date.now() / 1000,
        action: "pass",
        command,
        tier,
        zone,
        reason: "Command allowed to proceed",
      });
    }

    return undefined; // pass through
  });

  // Hook into tool_result for memory impact tracking
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "bash") return undefined;

    const preSnap = preSnapshots.get(event.toolCallId);
    if (preSnap) {
      preSnapshots.delete(event.toolCallId);
      const postSnap = await getQuickMemorySnapshot();
      const duration = Date.now() - preSnap.timestamp;
      
      // Log to tool_impact.jsonl via logger
      if (logger) {
        logger.logToolImpact({
          ts: Date.now() / 1000,
          tool_call_id: event.toolCallId,
          command: event.input?.command || "",
          duration_ms: duration,
          pre_swap_mb: preSnap.swap_used_mb,
          post_swap_mb: postSnap.swap_used_mb,
          pre_memorystatus: preSnap.memorystatus_level,
          post_memorystatus: postSnap.memorystatus_level,
          swap_delta_mb: postSnap.swap_used_mb - preSnap.swap_used_mb,
          memorystatus_delta: postSnap.memorystatus_level - preSnap.memorystatus_level,
        });
      }
    }

    return undefined; // don't modify result
  });

  // Register /deadman command
  pi.registerCommand("deadman", {
    description: "Show pi-deadman system health status",
    handler: async (args: any, ctx: any) => {
      const snap = monitor.getSnapshot();
      const procs = monitor.getLatestProcesses();
      const lines = [
        `Zone: ${snap.zone}`,
        `Trend: ${snap.trend}`,
        `Confirmed: ${snap.confirmed}`,
        `Calibrated: ${snap.isCalibrated}`,
        `Baseline: ${snap.baseline ? snap.baseline.canary_ms.toFixed(1) + "ms" : "not yet"}`,
        "",
        "Top 5 consumers:",
        ...formatProcessList(procs, 5),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
