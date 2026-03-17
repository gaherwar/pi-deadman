// __tests__/keywords.test.ts
import { describe, it, expect } from "vitest";
import { classifyTier, KEYWORD_TIERS } from "../extensions/keywords";

describe("classifyTier", () => {
  // Tier 4 — Destructive
  it("classifies 'kill -9 1234' as tier 4", () => {
    expect(classifyTier("kill -9 1234")).toBe(4);
  });
  it("classifies 'pkill node' as tier 4", () => {
    expect(classifyTier("pkill node")).toBe(4);
  });
  it("classifies 'killall Safari' as tier 4", () => {
    expect(classifyTier("killall Safari")).toBe(4);
  });
  it("classifies 'rm -rf /tmp/stuff' as tier 4", () => {
    expect(classifyTier("rm -rf /tmp/stuff")).toBe(4);
  });

  // Tier 3 — Heavy
  it("classifies 'npm install react' as tier 3", () => {
    expect(classifyTier("npm install react")).toBe(3);
  });
  it("classifies 'docker build .' as tier 3", () => {
    expect(classifyTier("docker build .")).toBe(3);
  });
  it("classifies 'npm run build' as tier 3", () => {
    expect(classifyTier("npm run build")).toBe(3);
  });
  it("classifies 'webpack --mode production' as tier 3", () => {
    expect(classifyTier("webpack --mode production")).toBe(3);
  });
  it("classifies 'cargo build --release' as tier 3", () => {
    expect(classifyTier("cargo build --release")).toBe(3);
  });
  it("classifies 'brew install node' as tier 3", () => {
    expect(classifyTier("brew install node")).toBe(3);
  });
  it("classifies 'pip install -r requirements.txt' as tier 3", () => {
    expect(classifyTier("pip install -r requirements.txt")).toBe(3);
  });
  it("classifies 'make all' as tier 3", () => {
    expect(classifyTier("make all")).toBe(3);
  });

  // Tier 2 — Medium
  it("classifies 'pytest tests/' as tier 2", () => {
    expect(classifyTier("pytest tests/")).toBe(2);
  });
  it("classifies 'npx jest --watch' as tier 2", () => {
    expect(classifyTier("npx jest --watch")).toBe(2);
  });
  it("classifies 'npx vitest run' as tier 2", () => {
    expect(classifyTier("npx vitest run")).toBe(2);
  });
  it("classifies 'uvicorn app:main' as tier 2", () => {
    expect(classifyTier("uvicorn app:main")).toBe(2);
  });
  it("classifies 'node server.js' as tier 2", () => {
    expect(classifyTier("node server.js")).toBe(2);
  });
  it("classifies 'cargo test' as tier 2", () => {
    expect(classifyTier("cargo test")).toBe(2);
  });

  // Tier 1 — Light
  it("classifies 'git status' as tier 1", () => {
    expect(classifyTier("git status")).toBe(1);
  });
  it("classifies 'grep -r TODO src/' as tier 1", () => {
    expect(classifyTier("grep -r TODO src/")).toBe(1);
  });
  it("classifies 'curl https://api.example.com' as tier 1", () => {
    expect(classifyTier("curl https://api.example.com")).toBe(1);
  });
  it("classifies 'cat file.txt' as tier 1", () => {
    expect(classifyTier("cat file.txt")).toBe(1);
  });
  it("classifies 'ls -la' as tier 1", () => {
    expect(classifyTier("ls -la")).toBe(1);
  });
  it("classifies 'rg pattern .' as tier 1", () => {
    expect(classifyTier("rg pattern .")).toBe(1);
  });

  // Tier 0 — Unknown / trivial
  it("classifies unknown commands as tier 0", () => {
    expect(classifyTier("whoami")).toBe(0);
  });
  it("classifies empty string as tier 0", () => {
    expect(classifyTier("")).toBe(0);
  });
  it("classifies undefined as tier 0", () => {
    expect(classifyTier(undefined)).toBe(0);
  });

  // Highest tier wins
  it("takes highest tier when multiple keywords match", () => {
    expect(classifyTier("npm install && pytest")).toBe(3);
  });
  it("npm install && cat → tier 3 (install wins)", () => {
    expect(classifyTier("npm install && cat package.json")).toBe(3);
  });

  // Known false positive — documented, safe failure mode
  it("cat package.json matches 'package' → tier 3 (known false positive)", () => {
    expect(classifyTier("cat package.json")).toBe(3);
  });

  // Case insensitive
  it("is case insensitive", () => {
    expect(classifyTier("NPM INSTALL")).toBe(3);
    expect(classifyTier("Docker Build")).toBe(3);
  });
});

describe("KEYWORD_TIERS", () => {
  it("has entries for all 5 tiers", () => {
    const tiers = new Set(Object.values(KEYWORD_TIERS));
    expect(tiers).toContain(0);
    expect(tiers).toContain(1);
    expect(tiers).toContain(2);
    expect(tiers).toContain(3);
    expect(tiers).toContain(4);
  });

  it("has at least 20 keywords", () => {
    expect(Object.keys(KEYWORD_TIERS).length).toBeGreaterThanOrEqual(20);
  });
});
