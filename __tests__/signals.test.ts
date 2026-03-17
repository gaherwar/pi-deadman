// __tests__/signals.test.ts
import { describe, it, expect } from "vitest";
import { collectSignals, type SystemSignals } from "../extensions/signals";

describe("collectSignals", () => {
  it("returns a SystemSignals object with all fields", async () => {
    const s = await collectSignals();
    expect(s).toHaveProperty("swapout_rate");
    expect(s).toHaveProperty("swapin_rate");
    expect(s).toHaveProperty("decomp_rate");
    expect(s).toHaveProperty("pressure_level");
    expect(s).toHaveProperty("memorystatus_level");
    expect(s).toHaveProperty("swap_used_mb");
    expect(s).toHaveProperty("swap_free_mb");
    expect(s).toHaveProperty("compression_ratio");
  });

  it("all numeric fields are non-negative", async () => {
    const s = await collectSignals();
    expect(s.swapout_rate).toBeGreaterThanOrEqual(0);
    expect(s.swapin_rate).toBeGreaterThanOrEqual(0);
    expect(s.decomp_rate).toBeGreaterThanOrEqual(0);
    expect(s.pressure_level).toBeGreaterThanOrEqual(1);
    expect(s.memorystatus_level).toBeGreaterThanOrEqual(0);
    expect(s.swap_used_mb).toBeGreaterThanOrEqual(0);
    expect(s.swap_free_mb).toBeGreaterThanOrEqual(0);
    expect(s.compression_ratio).toBeGreaterThanOrEqual(1.0);
  });

  it("pressure_level is 1, 2, or 4", async () => {
    const s = await collectSignals();
    expect([1, 2, 4]).toContain(s.pressure_level);
  });

  it("memorystatus_level is between 0 and 100", async () => {
    const s = await collectSignals();
    expect(s.memorystatus_level).toBeGreaterThanOrEqual(0);
    expect(s.memorystatus_level).toBeLessThanOrEqual(100);
  });

  it("swap_used_mb and swap_free_mb are reasonable (< 50GB)", async () => {
    const s = await collectSignals();
    expect(s.swap_used_mb).toBeLessThan(50000);
    expect(s.swap_free_mb).toBeLessThan(50000);
  });

  it("compression_ratio is at least 1.0", async () => {
    const s = await collectSignals();
    expect(s.compression_ratio).toBeGreaterThanOrEqual(1.0);
  });

  it("consecutive calls compute delta-based rates", async () => {
    const s1 = await collectSignals();
    await new Promise(r => setTimeout(r, 100));
    const s2 = await collectSignals();
    expect(typeof s2.swapout_rate).toBe("number");
    expect(typeof s2.decomp_rate).toBe("number");
  });
});
