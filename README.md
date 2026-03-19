# pi-breaker

Prevents macOS freezes during pi sessions. Auto-kills runaway processes when memory runs out.

## Install

```bash
pi install npm:pi-breaker
```

On first run, it calibrates a baseline for your machine (~10 seconds). After that, it runs silently in the background.

**macOS only.** Silent no-op on other platforms.

## How It Works

**Monitor** — Polls system health in the background. Classifies into GREEN, YELLOW, ORANGE, or RED.

**Watchdog** — In confirmed RED, automatically kills the process most likely causing the pressure. No prompts, no questions.

**Notification** — After a kill, you see a one-line message telling you what was killed and why. That's the only time you'll know it's there.

## Commands

| Command | Description |
|---|---|
| `/breaker` | Crashes prevented since install |

## Security & System Calls

pi-breaker makes **no network requests** and reads **no environment variables**. All system access is local and documented here:

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

**Filesystem writes** (scoped to `~/.pi/breaker/` only):
| What | File | Purpose |
|---|---|---|
| `~/.pi/breaker/baseline.json` | calibration.ts | Persisted canary baseline |
| `~/.pi/breaker/stats.json` | index.ts | Kill counter (crashes prevented) |
| `~/.pi/breaker/logs/*.jsonl` | logging.ts | Structured logs (auto-GC after 3 days) |

## Development

```bash
npm install
npm test
```

## License

MIT
