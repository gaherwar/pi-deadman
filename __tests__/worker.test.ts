// __tests__/worker.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { FootprintWorker } from "../extensions/worker";

describe("FootprintWorker", () => {
  let worker: FootprintWorker;

  afterEach(async () => {
    if (worker) {
      await worker.shutdown();
    }
  });

  it("starts and reports ready", async () => {
    worker = new FootprintWorker();
    await worker.start();
    expect(worker.isAlive()).toBe(true);
  });

  it("responds to PING", async () => {
    worker = new FootprintWorker();
    await worker.start();
    const result = await worker.ping();
    expect(result).toBe(true);
  });

  it("returns process tree for current process", async () => {
    worker = new FootprintWorker();
    await worker.start();
    const tree = await worker.getProcessTree(process.pid);
    expect(Array.isArray(tree)).toBe(true);
    // The worker itself is a child of this process
    // Each entry should have pid, name, footprint_mb, age_seconds
    if (tree.length > 0) {
      expect(tree[0]).toHaveProperty("pid");
      expect(tree[0]).toHaveProperty("name");
      expect(tree[0]).toHaveProperty("footprint_mb");
      expect(tree[0]).toHaveProperty("age_seconds");
    }
  });

  it("returns footprint for specific PIDs", async () => {
    worker = new FootprintWorker();
    await worker.start();
    const result = await worker.getFootprintForPids([process.pid]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].pid).toBe(process.pid);
    expect(typeof result[0].footprint_mb).toBe("number");
  });

  it("returns sorted by footprint descending", async () => {
    worker = new FootprintWorker();
    await worker.start();
    const tree = await worker.getProcessTree(process.pid);
    if (tree.length >= 2) {
      expect(tree[0].footprint_mb).toBeGreaterThanOrEqual(tree[1].footprint_mb);
    }
  });

  it("shuts down cleanly", async () => {
    worker = new FootprintWorker();
    await worker.start();
    await worker.shutdown();
    expect(worker.isAlive()).toBe(false);
  });

  it("handles shutdown when not started", async () => {
    worker = new FootprintWorker();
    await worker.shutdown(); // should not throw
    expect(worker.isAlive()).toBe(false);
  });

  it("reports not alive before start", () => {
    worker = new FootprintWorker();
    expect(worker.isAlive()).toBe(false);
  });

  it("times out if worker is unresponsive", async () => {
    worker = new FootprintWorker();
    // Don't start — any command should fail/timeout
    const result = await worker.ping();
    expect(result).toBe(false);
  });
});
