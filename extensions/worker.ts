import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { fileURLToPath } from "url";
import { dirname, resolve } from "node:path";

export interface TreeProcess {
  pid: number;
  name: string;
  footprint_mb: number;
  age_seconds: number | null;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class FootprintWorker {
  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestQueue: PendingRequest[] = [];

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("Worker already started");
    }

    // Resolve the helper script path relative to this module
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const helperPath = resolve(currentDir, "..", "helpers", "footprint_worker.py");

    // Spawn the Python helper
    this.child = spawn("python3", [helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error("Failed to create child process pipes");
    }

    // Set up readline to read JSON lines from stdout
    this.readline = createInterface({
      input: this.child.stdout,
    });

    // Handle incoming messages
    this.readline.on("line", (line: string) => {
      try {
        const response = JSON.parse(line.trim());
        const request = this.requestQueue.shift();
        if (request) {
          request.resolve(response);
        }
      } catch (error) {
        const request = this.requestQueue.shift();
        if (request) {
          request.reject(new Error(`Failed to parse response: ${line}`));
        }
      }
    });

    // Wait for the ready signal
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
      
      const timeout = setTimeout(() => {
        const request = this.requestQueue.shift();
        if (request === this.requestQueue[0]) {
          reject(new Error("Timeout waiting for ready signal"));
        }
      }, 5000);

      this.requestQueue[this.requestQueue.length - 1].resolve = (response: any) => {
        clearTimeout(timeout);
        if (response.status === "ready") {
          resolve();
        } else {
          reject(new Error(`Unexpected ready response: ${JSON.stringify(response)}`));
        }
      };
    });
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return; // Already shut down or never started
    }

    if (this.isAlive()) {
      try {
        // Send QUIT command
        this.child.stdin?.write("QUIT\n");
        
        // Wait a moment for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Ignore write errors during shutdown
      }
    }

    // Force kill if still running
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }

    // Clean up
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    this.child = null;
    
    // Reject any pending requests
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (request) {
        request.reject(new Error("Worker shut down"));
      }
    }
  }

  isAlive(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  async ping(): Promise<boolean> {
    if (!this.isAlive()) {
      return false;
    }

    try {
      const response = await this.sendCommand("PING", 3000);
      return response.status === "PONG";
    } catch (error) {
      return false;
    }
  }

  async getProcessTree(rootPid: number): Promise<TreeProcess[]> {
    if (!this.isAlive()) {
      return [];
    }

    try {
      const response = await this.sendCommand(`TREE ${rootPid}`, 5000);
      return response.processes || [];
    } catch (error) {
      return [];
    }
  }

  async getFootprintForPids(pids: number[]): Promise<TreeProcess[]> {
    if (!this.isAlive()) {
      return [];
    }

    try {
      const pidString = pids.join(",");
      const response = await this.sendCommand(`PIDS ${pidString}`, 5000);
      return response.processes || [];
    } catch (error) {
      return [];
    }
  }

  private async sendCommand(command: string, timeoutMs: number): Promise<any> {
    if (!this.child || !this.child.stdin) {
      throw new Error("Worker not started");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Find and remove this request from the queue
        const index = this.requestQueue.findIndex(req => req.resolve === resolve);
        if (index >= 0) {
          this.requestQueue.splice(index, 1);
        }
        reject(new Error(`Command timeout: ${command}`));
      }, timeoutMs);

      const request: PendingRequest = {
        resolve: (response: any) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };

      this.requestQueue.push(request);
      
      try {
        this.child!.stdin!.write(command + "\n");
      } catch (error) {
        // Remove the request we just added
        const index = this.requestQueue.indexOf(request);
        if (index >= 0) {
          this.requestQueue.splice(index, 1);
        }
        clearTimeout(timeout);
        reject(new Error(`Failed to send command: ${error}`));
      }
    });
  }
}
