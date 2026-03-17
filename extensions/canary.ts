// canary.ts — 5 micro-operations timed in sequence for system degradation detection
import { execSync, spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';

export interface CanaryResult {
  sysctl_ms: number;
  spawn_ms: number;
  read_ms: number;
  dir_ms: number;
  alloc_ms: number;
  total_ms: number;
}

export async function runCanary(): Promise<CanaryResult> {
  // sysctl_ms: Run `sysctl -n kern.ostype` via `execSync` and time it
  const sysctl_start = performance.now();
  execSync('sysctl -n kern.ostype');
  const sysctl_ms = performance.now() - sysctl_start;

  // spawn_ms: Run `/usr/bin/true` via `spawnSync` and time it
  const spawn_start = performance.now();
  spawnSync('/usr/bin/true');
  const spawn_ms = performance.now() - spawn_start;

  // read_ms: Read `/etc/hosts` via `fs.readFileSync` and time it
  const read_start = performance.now();
  readFileSync('/etc/hosts');
  const read_ms = performance.now() - read_start;

  // dir_ms: Read `/tmp` directory via `fs.readdirSync` and time it
  const dir_start = performance.now();
  readdirSync('/tmp');
  const dir_ms = performance.now() - dir_start;

  // alloc_ms: Allocate 1MB buffer and fill with zeros via `Buffer.alloc(1024*1024).fill(0)` and time it
  const alloc_start = performance.now();
  Buffer.alloc(1024 * 1024).fill(0);
  const alloc_ms = performance.now() - alloc_start;

  // total_ms: Sum of all 5
  const total_ms = sysctl_ms + spawn_ms + read_ms + dir_ms + alloc_ms;

  return {
    sysctl_ms,
    spawn_ms,
    read_ms,
    dir_ms,
    alloc_ms,
    total_ms,
  };
}
