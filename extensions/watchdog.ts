import type { SnapshotProcess } from "./tree";
import { findGrowingProcesses, findSwarm } from "./tree";

export interface WatchdogState {
  /** Ring buffer of recent snapshots (oldest first, max 10). Each entry is pi's child process list. */
  snapshotHistory: SnapshotProcess[][];
  /** Epoch seconds of the last snapshot taken while system was stably non-RED. */
  lastNonRedTimestamp: number;
  /** Count of consecutive non-RED polls. Used for hysteresis on lastNonRedTimestamp. */
  consecutiveNonRedPolls: number;
  lastKillTime: number;  // Date.now() of last kill, 0 if never
  cooldownMs: number;    // minimum ms between kills
}

export interface KillDecision {
  targets: SnapshotProcess[];  // processes to kill
  reason: string;              // human-readable reason
}

// Should we auto-kill? Only on confirmed RED.
export function shouldAutoKill(zone: string, confirmed: boolean): boolean {
  return zone === "RED" && confirmed === true;
}

/** Minimum footprint to be considered a kill candidate. Filters infrastructure noise. */
export const MIN_FOOTPRINT_MB = 50;

/** Thresholds for growth detection */
export const GROWTH_THRESHOLD_MB = 100;

/** Thresholds for swarm detection */
export const SWARM_MIN_COUNT = 3;
export const SWARM_MIN_COMBINED_MB = 500;

/** Thresholds for "heavy & young" detection */
export const HEAVY_YOUNG_MAX_AGE_SECONDS = 600;  // 10 minutes
export const HEAVY_YOUNG_MIN_FOOTPRINT_MB = 200;  // 200 MB (was 1 GB)

/**
 * Select what to kill from process list.
 *
 * Priority chain:
 *   Floor: processes with footprint < 50 MB are never kill candidates
 *   1. Growing — sustained delta ≥100 MB across 3+ of last 10 snapshots → kill ALL
 *   2. Swarm — ≥3 same-name processes, combined footprint ≥500 MB → kill ALL in swarm
 *   3. Heavy & young — age < 10 min AND footprint ≥ 200 MB → kill ALL, largest first
 *   4. Newest — appeared after last stable non-RED state → kill LARGEST ONLY (not batch)
 *   5. No match → don't kill, block commands and wait
 *
 * Returns null if nothing should be killed (no evidence, cooldown, empty).
 */
export function selectKillTarget(
  currentChildren: SnapshotProcess[],
  state: WatchdogState,
  maxAgeSeconds: number,
  protectedPid?: number,
): KillDecision | null {
  // 1. Check cooldown
  if (state.lastKillTime > 0 && Date.now() - state.lastKillTime < state.cooldownMs) {
    return null;
  }

  // 2. Apply footprint floor + age filter + protected PID
  let eligible = currentChildren.filter(proc =>
    proc.footprint_mb >= MIN_FOOTPRINT_MB &&
    (proc.age_seconds === null || proc.age_seconds <= maxAgeSeconds)
  );

  if (protectedPid !== undefined) {
    eligible = eligible.filter(proc => proc.pid !== protectedPid);
  }

  if (eligible.length === 0) {
    return null;
  }

  // Priority 1: Growing — kill ALL processes with sustained growth
  if (state.snapshotHistory.length >= 3) {
    const growing = findGrowingProcesses(state.snapshotHistory, eligible, GROWTH_THRESHOLD_MB);
    if (growing.length > 0) {
      return {
        targets: growing,
        reason: `Killing ${growing.length} growing process(es): ${growing.map(p => `${p.name}(+${p.delta_mb}MB)`).join(", ")}`,
      };
    }
  }

  // Priority 2: Swarm — kill ALL in the heaviest same-name cluster
  const swarm = findSwarm(eligible, SWARM_MIN_COUNT, SWARM_MIN_COMBINED_MB);
  if (swarm.length > 0) {
    const combined = swarm.reduce((sum, p) => sum + p.footprint_mb, 0);
    return {
      targets: swarm,
      reason: `Killing swarm of ${swarm.length} ${swarm[0].name} processes (combined ${combined}MB): ${swarm.map(p => `${p.name}(${p.footprint_mb}MB)`).join(", ")}`,
    };
  }

  // Priority 3: Heavy & young — kill ALL recently started heavy processes
  const heavyYoung = eligible
    .filter(proc =>
      proc.age_seconds !== null &&
      proc.age_seconds <= HEAVY_YOUNG_MAX_AGE_SECONDS &&
      proc.footprint_mb >= HEAVY_YOUNG_MIN_FOOTPRINT_MB
    )
    .sort((a, b) => b.footprint_mb - a.footprint_mb);

  if (heavyYoung.length > 0) {
    return {
      targets: heavyYoung,
      reason: `Killing ${heavyYoung.length} heavy & young process(es): ${heavyYoung.map(p => `${p.name}(${p.footprint_mb}MB, age ${p.age_seconds}s)`).join(", ")}`,
    };
  }

  // Priority 4: Newest — kill ONLY the single largest process that appeared
  // after the system was last stably non-RED. Not batch — weakest signal.
  if (state.lastNonRedTimestamp > 0) {
    const secondsSinceHealthy = (Date.now() / 1000) - state.lastNonRedTimestamp;

    const newest = eligible
      .filter(proc =>
        proc.age_seconds !== null &&
        proc.age_seconds <= secondsSinceHealthy
      )
      .sort((a, b) => b.footprint_mb - a.footprint_mb);

    if (newest.length > 0) {
      // Only kill the single largest — temporal correlation alone is weak evidence
      const target = newest[0];
      return {
        targets: [target],
        reason: `Killing newest heavy process (appeared after last stable state ${Math.round(secondsSinceHealthy)}s ago): ${target.name}(${target.footprint_mb}MB, age ${target.age_seconds}s)`,
      };
    }
  }

  // No evidence — don't kill. Caller should block commands and wait.
  return null;
}
