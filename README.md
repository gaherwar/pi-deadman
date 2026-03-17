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

## Development

```bash
npm install
npm test
```

## License

MIT
