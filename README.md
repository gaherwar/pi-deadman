# pi-deadman

Dead man's switch for AI coding agents.

Monitors macOS memory pressure, gates heavy operations, and auto-kills runaway processes before your system locks up.

## Install

```bash
pi install npm:pi-deadman
```

On first run, it calibrates a baseline for your machine (~10 seconds). After that, it runs in the background — no configuration needed.

**macOS only.** Silent no-op on other platforms.

## How It Works

**Zones** — Polls system health and classifies into GREEN, YELLOW, ORANGE, or RED based on memory pressure signals.

**Gate** — Every `bash` tool call is checked against the current zone. Light commands always pass; heavy operations (builds, installs, docker) are blocked in ORANGE and RED.

**Watchdog** — In confirmed RED, automatically identifies and kills the process most likely causing the pressure. Runs independently so it works even when the system is thrashing.

## Commands

| Command | Description |
|---|---|
| `/deadman` | Show current zone and memory stats |

## Security & System Calls

pi-deadman makes **no network requests** and reads **no environment variables**. All system access is local and documented here:

**Shell commands** (all read-only queries, no mutations):
| Command | File | Purpose |
|---|---|---|
| `sysctl -n kern.ostype` | canary.ts | Canary timing benchmark |
| `/usr/bin/true` | canary.ts | Canary timing benchmark |
| `sysctl -n vm.swapusage` | signals.ts | Read swap usage stats |
| `sysctl -n kern.memorystatus_vm_pressure_level` | signals.ts | Read memory pressure level |
| `sysctl -n kern.memorystatus_level` | signals.ts | Read memorystatus level |
| `vm_stat` | signals.ts | Read VM page statistics |
| `ps -eo pid,rss,comm -r` | processes.ts | List processes by memory |
| `ps -eo pid,ppid,etime,comm` | monitor.ts | Process tree for watchdog |
| `python3 helpers/footprint.py` | processes.ts | Read process footprints via `proc_pid_rusage` |
| `python3 helpers/footprint_worker.py` | worker.ts | Persistent worker for fast footprint queries |

**Process kills** (only pi's own child processes, only in confirmed RED):
| Signal | File | Trigger |
|---|---|---|
| `SIGKILL` | monitor.ts | Watchdog auto-kill in confirmed RED zone |
| `SIGTERM` | processes.ts | User-initiated kill from interactive menu |

**Filesystem writes** (scoped to `~/.pi/deadman/` only):
| What | File | Purpose |
|---|---|---|
| `~/.pi/deadman/baseline.json` | calibration.ts | Persisted canary baseline |
| `~/.pi/deadman/logs/*.jsonl` | logging.ts | Structured decision/system logs (auto-GC after 3 days) |

## Development

```bash
npm install
npm test
```

## License

MIT
