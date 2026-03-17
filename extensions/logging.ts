import * as fs from "node:fs";
import * as path from "node:path";

export class Logger {
  private logDir: string;
  private readonly fileNames = {
    system: "system.jsonl",
    processes: "processes.jsonl",
    toolImpact: "tool_impact.jsonl",
    decisions: "decisions.jsonl"
  };

  constructor(logDir: string) {
    this.logDir = logDir;
    // Create logDir if it doesn't exist
    fs.mkdirSync(logDir, { recursive: true });
  }

  logSystem(data: Record<string, unknown>): void {
    this.appendToFile(this.fileNames.system, data);
  }

  logProcesses(data: Record<string, unknown>): void {
    this.appendToFile(this.fileNames.processes, data);
  }

  logToolImpact(data: Record<string, unknown>): void {
    this.appendToFile(this.fileNames.toolImpact, data);
  }

  logDecision(data: Record<string, unknown>): void {
    this.appendToFile(this.fileNames.decisions, data);
  }

  private appendToFile(fileName: string, data: Record<string, unknown>): void {
    const filePath = path.join(this.logDir, fileName);
    const line = JSON.stringify(data) + "\n";
    fs.appendFileSync(filePath, line);
  }

  gc(retentionDays: number): void {
    const cutoff = Date.now() / 1000 - retentionDays * 86400;
    
    for (const fileName of Object.values(this.fileNames)) {
      this.gcFile(fileName, cutoff);
    }
  }

  private gcFile(fileName: string, cutoff: number): void {
    const filePath = path.join(this.logDir, fileName);
    
    // Skip if file doesn't exist
    if (!fs.existsSync(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim() !== "");
    
    const keptLines: string[] = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Keep entries without ts field or entries newer than cutoff
        if (entry.ts === undefined || entry.ts >= cutoff) {
          keptLines.push(line);
        }
      } catch {
        // Skip corrupted JSON lines silently
        continue;
      }
    }
    
    // Rewrite the file with kept lines
    if (keptLines.length > 0) {
      fs.writeFileSync(filePath, keptLines.join("\n") + "\n");
    } else {
      fs.writeFileSync(filePath, "");
    }
  }
}
