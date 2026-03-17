export interface SnapshotProcess {
  pid: number;
  name: string;
  footprint_mb: number;
  age_seconds: number | null;
}

export interface GrowingProcess extends SnapshotProcess {
  delta_mb: number;
}

// Format age in seconds to human-readable string
export function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return "unknown";
  }
  
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  // >= 3600 (1 hour or more)
  const hours = Math.floor(seconds / 3600);
  const remainingMinutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Parse ps etime format to seconds.
 * Formats: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
 * Returns null on parse failure.
 */
export function parseEtime(etime: string): number | null {
  const trimmed = etime.trim();
  if (!trimmed) return null;

  try {
    let days = 0;
    let timePart = trimmed;

    if (timePart.includes("-")) {
      const [dayStr, rest] = timePart.split("-", 2);
      days = parseInt(dayStr, 10);
      if (isNaN(days)) return null;
      timePart = rest;
    }

    const parts = timePart.split(":").map(p => parseInt(p, 10));
    if (parts.some(isNaN)) return null;

    let seconds = days * 86400;
    if (parts.length === 3) {
      seconds += parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds += parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      seconds += parts[0];
    } else {
      return null;
    }

    return seconds;
  } catch {
    return null;
  }
}

// Natural language description of a process
export function describeProcess(proc: SnapshotProcess): string {
  const age = formatAge(proc.age_seconds);
  return `${proc.name} [PID ${proc.pid}] (${proc.footprint_mb} MB, running ${age})`;
}

// Find processes in current that don't exist in previous (by PID)
export function findNewProcesses(
  previous: SnapshotProcess[],
  current: SnapshotProcess[],
): SnapshotProcess[] {
  const previousPids = new Set(previous.map(p => p.pid));
  return current.filter(proc => !previousPids.has(proc.pid));
}

/**
 * Find processes with sustained growth across a snapshot history.
 *
 * "Growing" = present in at least 3 snapshots, footprint increased between
 * consecutive pairs in at least 3 of those transitions, AND total delta
 * (newest - oldest observed footprint) >= thresholdMb.
 *
 * This is resilient to momentary plateaus — a process that grows, holds,
 * then grows again still qualifies as long as 3+ transitions show increases.
 *
 * @param snapshotHistory - ring buffer of snapshots, oldest first (max ~10).
 * @param currentChildren - current process list (used to filter to eligible PIDs only)
 * @param thresholdMb - minimum total delta from oldest to newest (default 200)
 * @param minGrowthIntervals - minimum number of intervals showing growth (default 3)
 */
export function findGrowingProcesses(
  snapshotHistory: SnapshotProcess[][],
  currentChildren: SnapshotProcess[],
  thresholdMb: number = 200,
  minGrowthIntervals: number = 3,
): GrowingProcess[] {
  // Need at least 3 snapshots to have 2 intervals
  if (snapshotHistory.length < 3) {
    return [];
  }

  const eligiblePids = new Set(currentChildren.map(p => p.pid));
  const growing: GrowingProcess[] = [];

  for (const pid of eligiblePids) {
    // Collect footprint values for this PID across all snapshots (skip gaps)
    const footprints: number[] = [];
    for (const snapshot of snapshotHistory) {
      const proc = snapshot.find(p => p.pid === pid);
      if (proc) {
        footprints.push(proc.footprint_mb);
      }
      // Missing from a snapshot is OK — we just skip it
    }

    // Need the PID present in at least 3 snapshots
    if (footprints.length < 3) continue;

    // Count intervals where footprint increased
    let growthIntervals = 0;
    for (let i = 1; i < footprints.length; i++) {
      if (footprints[i] > footprints[i - 1]) {
        growthIntervals++;
      }
    }

    if (growthIntervals < minGrowthIntervals) continue;

    // Check total delta meets threshold (newest - oldest observed)
    const totalDelta = footprints[footprints.length - 1] - footprints[0];
    if (totalDelta < thresholdMb) continue;

    const currentProc = currentChildren.find(p => p.pid === pid)!;
    growing.push({
      ...currentProc,
      delta_mb: totalDelta,
    });
  }

  // Sort by total delta descending
  return growing.sort((a, b) => b.delta_mb - a.delta_mb);
}

// Find the largest group of processes with the same name (>= 2 members)
// Returns the group, or empty array if no group has >= 2 members
export function findSimilarGroup(processes: SnapshotProcess[]): SnapshotProcess[] {
  // Group processes by name
  const groups = new Map<string, SnapshotProcess[]>();
  
  for (const proc of processes) {
    if (!groups.has(proc.name)) {
      groups.set(proc.name, []);
    }
    groups.get(proc.name)!.push(proc);
  }
  
  // Find the largest group with >= 2 members
  let largestGroup: SnapshotProcess[] = [];
  
  for (const group of groups.values()) {
    if (group.length >= 2 && group.length > largestGroup.length) {
      largestGroup = group;
    }
  }
  
  return largestGroup;
}

/**
 * Find the heaviest swarm of same-name processes.
 *
 * A "swarm" is >= minCount processes with the same name whose combined
 * footprint >= minCombinedMb. Returns the group with the highest combined
 * footprint, sorted by individual footprint descending.
 *
 * Use case: 7 vitest workers each at 500 MB = 3.5 GB swarm.
 */
export function findSwarm(
  processes: SnapshotProcess[],
  minCount: number = 3,
  minCombinedMb: number = 500,
): SnapshotProcess[] {
  const groups = new Map<string, SnapshotProcess[]>();

  for (const proc of processes) {
    if (!groups.has(proc.name)) {
      groups.set(proc.name, []);
    }
    groups.get(proc.name)!.push(proc);
  }

  let bestGroup: SnapshotProcess[] = [];
  let bestCombined = 0;

  for (const group of groups.values()) {
    if (group.length < minCount) continue;
    const combined = group.reduce((sum, p) => sum + p.footprint_mb, 0);
    if (combined >= minCombinedMb && combined > bestCombined) {
      bestGroup = group;
      bestCombined = combined;
    }
  }

  return bestGroup.sort((a, b) => b.footprint_mb - a.footprint_mb);
}
