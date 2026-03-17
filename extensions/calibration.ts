// calibration.ts — baseline establishment, persistence to disk, loading across sessions

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Calibrated canary baseline.
 */
export interface Baseline {
  canary_ms: number;
  calibrated_at: string;
  source: "calibrated" | "default";
}

/**
 * Conservative default baseline for when calibration can't complete.
 * Deliberately high (10ms) so the system errs toward being more sensitive.
 */
export const DEFAULT_BASELINE_MS = 10.0;

/**
 * Save baseline to JSON file, creating parent dirs if needed.
 */
export function saveBaseline(baseline: Baseline, filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (parentDir) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2));
}

/**
 * Load baseline from JSON file.
 * 
 * Returns null if file is missing, corrupted, or has unexpected format.
 * Backward-compatible: old baselines without a 'source' field default
 * to "calibrated" (which is what they were).
 */
export function loadBaseline(filePath: string): Baseline | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(content);
    
    // Validate required fields
    if (typeof data.canary_ms !== "number" || typeof data.calibrated_at !== "string") {
      return null;
    }
    
    // Backward compatibility: old baselines don't have 'source'
    if (!data.source) {
      data.source = "calibrated";
    }
    
    return {
      canary_ms: data.canary_ms,
      calibrated_at: data.calibrated_at,
      source: data.source,
    };
  } catch {
    return null;
  }
}
