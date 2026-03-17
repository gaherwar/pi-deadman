// __tests__/processes.test.ts
import { describe, it, expect } from "vitest";
import { getTopProcesses, formatProcessList, type ProcessInfo } from "../extensions/processes";

describe("getTopProcesses", () => {
  it("returns an array of ProcessInfo objects", async () => {
    const procs = await getTopProcesses();
    expect(Array.isArray(procs)).toBe(true);
    expect(procs.length).toBeGreaterThan(0);
  });

  it("each process has pid, name, footprint_mb, rss_mb", async () => {
    const procs = await getTopProcesses();
    const first = procs[0];
    expect(first).toHaveProperty("pid");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("footprint_mb");
    expect(first).toHaveProperty("rss_mb");
    expect(typeof first.pid).toBe("number");
    expect(typeof first.name).toBe("string");
    expect(typeof first.footprint_mb).toBe("number");
    expect(typeof first.rss_mb).toBe("number");
  });

  it("is sorted by footprint_mb descending", async () => {
    const procs = await getTopProcesses();
    for (let i = 1; i < procs.length; i++) {
      expect(procs[i - 1].footprint_mb).toBeGreaterThanOrEqual(procs[i].footprint_mb);
    }
  });

  it("footprint_mb is larger than or equal to rss_mb for most processes", async () => {
    const procs = await getTopProcesses();
    expect(procs[0].footprint_mb).toBeGreaterThanOrEqual(procs[0].rss_mb);
  });

  it("completes in under 200ms", async () => {
    const start = performance.now();
    await getTopProcesses();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("returns at most 20 processes", async () => {
    const procs = await getTopProcesses();
    expect(procs.length).toBeLessThanOrEqual(20);
  });
});

describe("formatProcessList", () => {
  const mockProcesses: ProcessInfo[] = [
    { pid: 100, name: "firefox", footprint_mb: 800, rss_mb: 266 },
    { pid: 200, name: "claude", footprint_mb: 400, rss_mb: 150 },
    { pid: 300, name: "node", footprint_mb: 200, rss_mb: 80 },
  ];

  it("formats processes as selectable strings", () => {
    const formatted = formatProcessList(mockProcesses, 3);
    expect(formatted).toHaveLength(3);
    expect(formatted[0]).toContain("firefox");
    expect(formatted[0]).toContain("800");
    expect(formatted[1]).toContain("claude");
    expect(formatted[2]).toContain("node");
  });

  it("limits to requested count", () => {
    const formatted = formatProcessList(mockProcesses, 2);
    expect(formatted).toHaveLength(2);
  });

  it("handles empty array", () => {
    expect(formatProcessList([], 5)).toEqual([]);
  });
});
