// index.ts — Pi extension entry point: background monitor lifecycle, /breaker command, auto-kill notifications

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Monitor } from "./monitor.js";
import { Zone } from "./zones.js";
import { formatProcessList } from "./processes.js";
import { collectSignals } from "./signals.js";
import { Logger } from "./logging.js";

// --- Stats persistence ---

interface Stats {
  kills_total: number;
  first_active: string; // ISO date
}

const STATS_FILE = path.join(os.homedir(), ".pi", "breaker", "stats.json");

export function loadStats(): Stats {
  try {
    const content = fs.readFileSync(STATS_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { kills_total: 0, first_active: new Date().toISOString() };
  }
}

export function saveStats(stats: Stats): void {
  const dir = path.dirname(STATS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

export function incrementKills(count: number): Stats {
  const stats = loadStats();
  stats.kills_total += count;
  saveStats(stats);
  return stats;
}

// --- Quick memory snapshot (for tool impact tracking) ---

export async function getQuickMemorySnapshot(): Promise<{ swap_used_mb: number; memorystatus_level: number }> {
  const signals = await collectSignals();
  return {
    swap_used_mb: signals.swap_used_mb,
    memorystatus_level: signals.memorystatus_level,
  };
}

// Pi extension entry point (default export)
export default function (pi: any) {
  // macOS only — sysctl, vm_stat, memory_pressure are Darwin-specific
  if (process.platform !== "darwin") {
    return;
  }

  const DATA_DIR = path.join(os.homedir(), ".pi", "breaker");
  const monitor = new Monitor({
    baselinePath: path.join(DATA_DIR, "baseline.json"),
    logDir: path.join(DATA_DIR, "logs"),
  });

  let logger: Logger | null = null;

  // Hook into session lifecycle
  pi.on("session_start", async (_event: any, ctx: any) => {
    monitor.start();
    logger = new Logger(path.join(DATA_DIR, "logs"));

    // Ensure stats file exists on first run
    const stats = loadStats();
    saveStats(stats);

    // Register auto-kill notification — friendly, no emoji
    monitor.onAutoKill((decision: any) => {
      const names = decision.targets.map((t: any) => `${t.name} (${t.footprint_mb} MB)`).join(", ");
      const updatedStats = incrementKills(decision.targets.length);
      ctx.ui.notify(
        `pi-breaker killed ${names} for overstepping memory consumption. (${updatedStats.kills_total} crashes prevented so far)`,
        "warning",
      );
    });
  });

  pi.on("session_shutdown", () => {
    monitor.stop();
  });

  // Track pre-execution memory snapshots for impact logging
  const preSnapshots = new Map<string, { swap_used_mb: number; memorystatus_level: number; timestamp: number }>();

  // tool_call hook — logging only, no blocking
  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input?.command || "";

    // Take pre-execution memory snapshot for impact tracking
    const memSnap = await getQuickMemorySnapshot();
    preSnapshots.set(event.toolCallId, { ...memSnap, timestamp: Date.now() });

    // Log the pass decision
    if (logger) {
      logger.logDecision({
        ts: Date.now() / 1000,
        action: "pass",
        command,
        zone: monitor.currentZone,
        reason: "Passive mode — no blocking",
      });
    }

    return undefined; // always pass through
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

    return undefined;
  });

  // Register /breaker command — shows crashes prevented
  pi.registerCommand("breaker", {
    description: "Show pi-breaker status",
    handler: async (_args: any, ctx: any) => {
      const snap = monitor.getSnapshot();
      const stats = loadStats();
      const since = new Date(stats.first_active).toLocaleDateString();
      const lines = [
        `Zone: ${snap.zone}${snap.confirmed ? " (confirmed)" : ""}`,
        `Crashes prevented: ${stats.kills_total} since ${since}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
