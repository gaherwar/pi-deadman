// processes.ts — process listing via ps + footprint helper, kill via SIGTERM
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

export interface ProcessInfo {
  pid: number;
  name: string;
  footprint_mb: number;
  rss_mb: number;
}

export async function getTopProcesses(limit: number = 20): Promise<ProcessInfo[]> {
  try {
    // Get the directory of the current module
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const helperPath = path.join(__dirname, "..", "helpers", "footprint.py");
    
    // Execute the Python helper
    const output = execSync(`python3 "${helperPath}"`, { 
      encoding: "utf-8",
      timeout: 5000
    });
    
    const processes = JSON.parse(output) as ProcessInfo[];
    
    // Ensure it's sorted by footprint_mb descending (helper should already do this)
    processes.sort((a, b) => b.footprint_mb - a.footprint_mb);
    
    // Return at most 'limit' processes
    return processes.slice(0, limit);
  } catch (error) {
    // Fallback: parse ps output directly
    return getPsProcesses(limit);
  }
}

function getPsProcesses(limit: number): ProcessInfo[] {
  try {
    const output = execSync("ps -eo pid,rss,comm -r", { 
      encoding: "utf-8",
      timeout: 5000
    });
    
    const lines = output.trim().split("\n").slice(1); // Skip header
    const processes: ProcessInfo[] = [];
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const pid = parseInt(parts[0]);
        const rssKb = parseInt(parts[1]);
        const comm = parts.slice(2).join(" ");
        
        if (!isNaN(pid) && !isNaN(rssKb)) {
          const rssMb = Math.floor(rssKb / 1024);
          processes.push({
            pid,
            name: path.basename(comm),
            footprint_mb: rssMb, // Use RSS for both since we don't have footprint data
            rss_mb: rssMb
          });
        }
      }
    }
    
    // Sort by footprint_mb (which is RSS in this fallback) descending
    processes.sort((a, b) => b.footprint_mb - a.footprint_mb);
    
    return processes.slice(0, limit);
  } catch (error) {
    return [];
  }
}

export function formatProcessList(processes: ProcessInfo[], limit: number): string[] {
  if (processes.length === 0) {
    return [];
  }
  
  return processes
    .slice(0, limit)
    .map(proc => `${proc.name} (PID ${proc.pid}) — ${proc.footprint_mb} MB`);
}

// User-initiated kill from interactive menu — graceful SIGTERM
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error) {
    return false;
  }
}
