# pi-deadman

Dead man's switch for AI coding agents.

Monitors macOS memory pressure, gates heavy operations, and auto-kills runaway processes before your system locks up.

## The Problem

AI coding agents run builds, tests, installs, and browser automation with no awareness of system memory state. On an 8 GB Mac, this regularly pushes the system into swap thrashing — minutes of lag, system freezes, sometimes requiring a hard reboot.

## Install

```bash
pi install git:github.com/gaherwar/pi-deadman
```

On first run, pi-deadman calibrates a baseline for your machine (~10 seconds of canary tests). After that, it runs in the background — no configuration needed.

**macOS only.** Silent no-op on other platforms.

## How It Works

### Pre-Execution Gate

Every `bash` tool call goes through a tier × zone matrix:

| | GREEN | YELLOW | ORANGE | RED |
|---|---|---|---|---|
| **Tier 0–1** (read-only: ls, cat, grep) | ✅ | ✅ | ✅ | ❌ |
| **Tier 2** (medium: test, server, spawn) | ✅ | ✅ | ✅ | ❌ |
| **Tier 3** (heavy: npm install, docker, build) | ✅ | ✅ | ❌ | ❌ |
| **Tier 4** (destructive: kill, pkill, rm -rf) | ✅ | ✅ | ❌ | ❌ |

When blocked in **ORANGE**, you choose: run anyway or free memory first.
When blocked in **RED**, you must kill a process to proceed — or force-run after the first attempt.

### Background Monitor

Polls system health at adaptive intervals (5s in GREEN → 1s in RED):

- **Canary test** — micro-ops (array sort, Map ops, regex, JSON parse, Buffer alloc) timed via `performance.now()`. Slowdown ratio vs baseline determines zone.
- **System signals** — swap usage, swap in/out rates, compression ratio, memorystatus level via `sysctl` and `vm_stat`.
- **Process snapshots** — footprint (true memory) via `proc_pid_rusage` Python helper, stored in a ring buffer of 10 snapshots.

### Watchdog (Confirmed RED)

When the system enters confirmed RED (3 consecutive RED polls), the watchdog auto-kills processes across **all pi sessions**. Processes with < 50 MB footprint are never kill candidates.

| Priority | Signal | Catches |
|---|---|---|
| 1. **Growing** | ≥100 MB delta across 3+ of 10 snapshots | Memory leaks, sawtooth patterns |
| 2. **Swarm** | ≥3 same-name processes, combined ≥500 MB | Worker pools (vitest ×7, webpack workers) |
| 3. **Heavy & young** | Age < 10 min AND footprint ≥ 200 MB | Burst allocators |
| 4. **Newest** | Appeared after last stable non-RED state | Temporal correlation (largest only) |
| 5. **No match** | Block commands, wait | Pressure from outside pi's tree |

Two execution paths:
- **Slow poll** — full canary + signals + footprint worker. Populates snapshot ring buffer.
- **Fast watchdog** — independent 2s loop using `ps` (~17ms). Parses fresh `etime` for age. Walks children of ALL pi instances (cross-session). Acts even when the slow poll is stuck during system thrashing.

## Commands

| Command | Description |
|---|---|
| `/deadman` | Show current zone, memory stats, recent kills |

## Files

```
pi-deadman/
├── extensions/
│   ├── index.ts          — Entry point: tool_call gate, /deadman command
│   ├── monitor.ts        — Background polling, adaptive intervals, watchdog
│   ├── canary.ts         — Performance micro-ops timing
│   ├── signals.ts        — macOS kernel metrics (sysctl, vm_stat)
│   ├── zones.ts          — Zone classification (GREEN/YELLOW/ORANGE/RED)
│   ├── calibration.ts    — Baseline persistence
│   ├── keywords.ts       — Command tier classification (25+ keywords, 5 tiers)
│   ├── processes.ts      — System-wide process list (footprint.py)
│   ├── watchdog.ts       — Kill target selection
│   ├── tree.ts           — Snapshot diffing, growth detection, swarm detection
│   ├── worker.ts         — Persistent Python worker for fast footprint queries
│   └── logging.ts        — JSONL structured logs (GC after 3 days)
├── helpers/
│   ├── footprint.py        — proc_pid_rusage footprint extraction
│   └── footprint_worker.py — Persistent worker process
└── __tests__/              — 202 tests across 13 files
```

## Logs

Stored in `~/.pi/deadman/logs/`:

- `system.jsonl` — zone, canary, swap, signals per poll
- `decisions.jsonl` — pass/block/kill per tool call
- `processes.jsonl` — top process snapshots
- `tool_impact.jsonl` — swap delta per command

## Development

```bash
cd pi-deadman
npm install
npm test              # 202 tests across 13 files
npx vitest --watch    # watch mode
```

## License

MIT
