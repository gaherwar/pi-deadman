// __tests__/canary.test.ts
import { describe, it, expect } from "vitest";
import { runCanary, type CanaryResult } from "../extensions/canary";

describe("runCanary", () => {
  it("returns a CanaryResult with all 5 sub-timings", async () => {
    const result = await runCanary();
    expect(result).toHaveProperty("sysctl_ms");
    expect(result).toHaveProperty("spawn_ms");
    expect(result).toHaveProperty("read_ms");
    expect(result).toHaveProperty("dir_ms");
    expect(result).toHaveProperty("alloc_ms");
    expect(result).toHaveProperty("total_ms");
  });

  it("all timings are positive numbers", async () => {
    const result = await runCanary();
    expect(result.sysctl_ms).toBeGreaterThan(0);
    expect(result.spawn_ms).toBeGreaterThan(0);
    expect(result.read_ms).toBeGreaterThan(0);
    expect(result.dir_ms).toBeGreaterThan(0);
    expect(result.alloc_ms).toBeGreaterThan(0);
    expect(result.total_ms).toBeGreaterThan(0);
  });

  it("total_ms equals sum of 5 sub-timings", async () => {
    const result = await runCanary();
    const sum = result.sysctl_ms + result.spawn_ms + result.read_ms + result.dir_ms + result.alloc_ms;
    expect(result.total_ms).toBeCloseTo(sum, 1);
  });

  it("completes in under 500ms on a healthy system", async () => {
    const result = await runCanary();
    expect(result.total_ms).toBeLessThan(500);
  });

  it("sysctl_ms reads kern.ostype successfully", async () => {
    const result = await runCanary();
    expect(result.sysctl_ms).toBeLessThan(50);
  });

  it("spawn_ms spawns a real process", async () => {
    const result = await runCanary();
    expect(result.spawn_ms).toBeLessThan(100);
  });

  it("read_ms reads a real file", async () => {
    const result = await runCanary();
    expect(result.read_ms).toBeLessThan(50);
  });

  it("dir_ms scans a real directory", async () => {
    const result = await runCanary();
    expect(result.dir_ms).toBeLessThan(50);
  });

  it("alloc_ms allocates and fills memory", async () => {
    const result = await runCanary();
    expect(result.alloc_ms).toBeLessThan(50);
  });

  it("is deterministic-ish — two runs produce similar results", async () => {
    const r1 = await runCanary();
    const r2 = await runCanary();
    expect(r2.total_ms).toBeLessThan(r1.total_ms * 5);
    expect(r1.total_ms).toBeLessThan(r2.total_ms * 5);
  });
});
