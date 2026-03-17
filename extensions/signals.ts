// signals.ts — macOS kernel memory metrics: sysctl, vm_stat, memory_pressure

import { execSync } from "child_process";

// Module-level state for rate computation
let previousVmStat: Record<string, number> | null = null;
let previousTimestamp: number | null = null;

export interface SystemSignals {
  swapout_rate: number;     // swapouts/sec delta from previous call, 0 on first call
  swapin_rate: number;      // swapins/sec delta
  decomp_rate: number;      // decompressions/sec delta
  pressure_level: number;   // 1, 2, or 4 from memory_pressure command
  memorystatus_level: number; // 0-100 from sysctl kern.memorystatus_level
  swap_used_mb: number;     // from sysctl vm.swapusage
  swap_free_mb: number;     // from sysctl vm.swapusage
  compression_ratio: number; // pages_stored / compressor_page_count, min 1.0
}

export async function collectSignals(): Promise<SystemSignals> {
  const timestamp = Date.now() / 1000; // Convert to seconds
  
  // Initialize with safe defaults
  let swapout_rate = 0;
  let swapin_rate = 0;
  let decomp_rate = 0;
  let pressure_level = 1;
  let memorystatus_level = 0;
  let swap_used_mb = 0;
  let swap_free_mb = 0;
  let compression_ratio = 1.0;

  // Get current vm_stat data
  const currentVmStat = getVmStat();

  // Compute delta-based rates if we have previous data
  if (previousVmStat !== null && previousTimestamp !== null) {
    const timeDelta = timestamp - previousTimestamp;
    if (timeDelta > 0) {
      // Swapout rate: pages written to swap per second
      const prevPageouts = previousVmStat.swapouts || 0;
      const currPageouts = currentVmStat.swapouts || 0;
      swapout_rate = Math.max(0, (currPageouts - prevPageouts) / timeDelta);

      // Swapin rate: pages read from swap per second (swapins)
      const prevPageins = previousVmStat.swapins || 0;
      const currPageins = currentVmStat.swapins || 0;
      swapin_rate = Math.max(0, (currPageins - prevPageins) / timeDelta);

      // Decompression rate: pages decompressed per second
      const prevDecomp = previousVmStat.decompressions || 0;
      const currDecomp = currentVmStat.decompressions || 0;
      decomp_rate = Math.max(0, (currDecomp - prevDecomp) / timeDelta);
    }
  }

  // Store current state for next call
  previousVmStat = currentVmStat;
  previousTimestamp = timestamp;

  // Get point-in-time signals
  pressure_level = getPressureLevel();
  memorystatus_level = getMemorystatusLevel();
  [swap_used_mb, swap_free_mb] = getSwapUsage();
  compression_ratio = getCompressionRatio(currentVmStat);

  return {
    swapout_rate,
    swapin_rate,
    decomp_rate,
    pressure_level,
    memorystatus_level,
    swap_used_mb,
    swap_free_mb,
    compression_ratio
  };
}

// Read macOS virtual memory page statistics (pages paged in/out, compressed, etc.)
function getVmStat(): Record<string, number> {
  try {
    const output = execSync("vm_stat", { encoding: "utf8", timeout: 5000 });
    const data: Record<string, number> = {};
    
    for (const line of output.trim().split("\n")) {
      if (line.includes(":")) {
        const [key, valueStr] = line.split(":");
        const value = valueStr.trim().replace(/\.$/, ""); // Remove trailing period
        const numValue = parseInt(value, 10);
        if (!isNaN(numValue)) {
          data[key.trim().toLowerCase()] = numValue;
        }
      }
    }
    
    return data;
  } catch {
    return {};
  }
}

// Read macOS memory pressure level: 1=normal, 2=warn, 4=critical
function getPressureLevel(): number {
  try {
    const output = execSync("sysctl -n kern.memorystatus_vm_pressure_level", { 
      encoding: "utf8", 
      timeout: 5000 
    });
    const level = parseInt(output.trim(), 10);
    if ([1, 2, 4].includes(level)) {
      return level;
    }
    return 1; // Default to normal
  } catch {
    return 1;
  }
}

// Read macOS memorystatus percentage (0-100, higher = more available)
function getMemorystatusLevel(): number {
  try {
    const output = execSync("sysctl -n kern.memorystatus_level", { 
      encoding: "utf8", 
      timeout: 5000 
    });
    const level = parseInt(output.trim(), 10);
    return isNaN(level) ? 0 : Math.max(0, Math.min(100, level));
  } catch {
    return 0;
  }
}

// Read macOS swap usage: total and used bytes
function getSwapUsage(): [number, number] {
  try {
    const output = execSync("sysctl -n vm.swapusage", { 
      encoding: "utf8", 
      timeout: 5000 
    });
    
    let usedMb = 0;
    let freeMb = 0;
    
    // Parse "used = X.XXM  free = Y.YYM"
    const parts = output.trim().split(/\s+/);
    for (let i = 0; i < parts.length - 2; i++) {
      if (parts[i] === "used" && parts[i + 1] === "=") {
        const value = parseFloat(parts[i + 2].replace("M", ""));
        if (!isNaN(value)) usedMb = value;
      } else if (parts[i] === "free" && parts[i + 1] === "=") {
        const value = parseFloat(parts[i + 2].replace("M", ""));
        if (!isNaN(value)) freeMb = value;
      }
    }
    
    return [usedMb, freeMb];
  } catch {
    return [0, 0];
  }
}

function getCompressionRatio(vmData: Record<string, number>): number {
  try {
    const compressorPageCount = vmData["pages occupied by compressor"] || 0;
    const pagesStoredInCompressor = vmData["pages stored in compressor"] || 0;
    
    if (compressorPageCount > 0 && pagesStoredInCompressor > 0) {
      const ratio = pagesStoredInCompressor / compressorPageCount;
      return Math.max(1.0, ratio);
    }
    
    return 1.0;
  } catch {
    return 1.0;
  }
}
