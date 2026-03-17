// __tests__/calibration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveBaseline, loadBaseline, type Baseline, DEFAULT_BASELINE_MS } from "../extensions/calibration";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Baseline persistence", () => {
  let tmpDir: string;
  let baselinePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadman-test-"));
    baselinePath = path.join(tmpDir, "baseline.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a baseline", () => {
    const baseline: Baseline = {
      canary_ms: 7.5,
      calibrated_at: "2026-02-28T10:00:00.000Z",
      source: "calibrated",
    };
    saveBaseline(baseline, baselinePath);
    const loaded = loadBaseline(baselinePath);
    expect(loaded).toEqual(baseline);
  });

  it("returns null for missing file", () => {
    expect(loadBaseline("/nonexistent/path/baseline.json")).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    fs.writeFileSync(baselinePath, "not json{{{");
    expect(loadBaseline(baselinePath)).toBeNull();
  });

  it("returns null for incomplete data", () => {
    fs.writeFileSync(baselinePath, JSON.stringify({ canary_ms: 5 }));
    expect(loadBaseline(baselinePath)).toBeNull();
  });

  it("creates parent directories if needed", () => {
    const deepPath = path.join(tmpDir, "a", "b", "c", "baseline.json");
    const baseline: Baseline = {
      canary_ms: 8.0,
      calibrated_at: "2026-02-28T10:00:00.000Z",
      source: "calibrated",
    };
    saveBaseline(baseline, deepPath);
    const loaded = loadBaseline(deepPath);
    expect(loaded).toEqual(baseline);
  });

  it("default baseline backward-compatible with missing source field", () => {
    fs.writeFileSync(baselinePath, JSON.stringify({
      canary_ms: 9.0,
      calibrated_at: "2026-02-28T10:00:00.000Z",
    }));
    const loaded = loadBaseline(baselinePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.source).toBe("calibrated");
  });
});

describe("DEFAULT_BASELINE_MS", () => {
  it("is 10ms (conservative default)", () => {
    expect(DEFAULT_BASELINE_MS).toBe(10.0);
  });
});
