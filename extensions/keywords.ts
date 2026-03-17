// keywords.ts — command tier classification: keyword map, substring matching

/**
 * Maps keywords to cost tiers for bash command classification.
 * Higher tiers indicate more expensive/resource-intensive operations.
 */
export const KEYWORD_TIERS: Record<string, number> = {
  // Tier 4 (Destructive): Process killing, force removal
  kill: 4,
  pkill: 4,
  killall: 4,
  "rm -rf": 4,

  // Tier 3 (Heavy): Build, install, compile operations
  install: 3,
  build: 3,
  docker: 3,
  webpack: 3,
  compile: 3,
  package: 3,
  brew: 3,
  make: 3,

  // Tier 2 (Medium): Test runners, servers, process spawning
  pytest: 2,
  jest: 2,
  test: 2,
  mocha: 2,
  vitest: 2,
  server: 2,
  serve: 2,
  uvicorn: 2,
  gunicorn: 2,
  agent: 2,
  spawn: 2,

  // Tier 1 (Light): File operations, version control, simple utilities
  grep: 1,
  git: 1,
  ls: 1,
  cat: 1,
  find: 1,
  rg: 1,
  sed: 1,
  awk: 1,
  curl: 1,
  echo: 1,

  // Tier 0 (Trivial): Basic I/O operations
  read: 0,
  write: 0,
  open: 0,
};

/**
 * Classifies a bash command by scanning for keywords and returning the highest tier found.
 * Uses case-insensitive substring matching.
 * 
 * @param command - The bash command string to classify
 * @returns The highest tier number found (0-3), or 0 for no match/empty/undefined
 */
export function classifyTier(command?: string): number {
  if (!command || command.trim() === "") {
    return 0;
  }

  const lowerCommand = command.toLowerCase();
  let maxTier = 0;

  for (const [keyword, tier] of Object.entries(KEYWORD_TIERS)) {
    if (lowerCommand.includes(keyword)) {
      maxTier = Math.max(maxTier, tier);
    }
  }

  return maxTier;
}
