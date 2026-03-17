#!/usr/bin/env python3
"""Persistent footprint worker — reads commands from stdin, writes JSON to stdout.

Protocol:
  PING                    → {"status": "PONG"}
  TREE <pid>              → {"processes": [...]} — full tree under pid with footprint
  PIDS <pid1>,<pid2>,...  → {"processes": [...]} — footprint for specific PIDs
  QUIT                    → exits

Each response is one JSON line terminated by \n.
Stays alive for the entire session. Spawned once at session_start.
"""
import ctypes
import ctypes.util
import json
import os
import subprocess
import sys

libc = ctypes.CDLL(ctypes.util.find_library("c"))

RUSAGE_BUF_SIZE = 1024
PHYS_FOOTPRINT_OFFSET = 72  # byte offset of ri_phys_footprint in rusage_info_v2


def get_footprint(pid):
    """Get physical footprint in bytes for a PID, or None on failure."""
    buf = ctypes.create_string_buffer(RUSAGE_BUF_SIZE)
    ret = libc.proc_pid_rusage(pid, 2, buf)
    if ret != 0:
        return None
    return ctypes.c_uint64.from_buffer_copy(buf, PHYS_FOOTPRINT_OFFSET).value


def get_process_info(pid):
    """Get process name and elapsed time for a PID."""
    try:
        out = subprocess.run(
            ["ps", "-o", "comm=,etime=", "-p", str(pid)],
            capture_output=True, text=True, timeout=2,
        )
        line = out.stdout.strip()
        if not line:
            return None, None
        parts = line.rsplit(None, 1)
        if len(parts) == 2:
            comm, etime = parts
            return os.path.basename(comm), parse_etime(etime)
        return os.path.basename(parts[0]), None
    except Exception:
        return None, None


def parse_etime(etime_str):
    """Parse ps etime format (DD-HH:MM:SS or HH:MM:SS or MM:SS or SS) to seconds."""
    try:
        etime_str = etime_str.strip()
        days = 0
        if "-" in etime_str:
            day_part, etime_str = etime_str.split("-", 1)
            days = int(day_part)
        parts = etime_str.split(":")
        parts = [int(p) for p in parts]
        if len(parts) == 3:
            return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
        elif len(parts) == 2:
            return days * 86400 + parts[0] * 60 + parts[1]
        elif len(parts) == 1:
            return days * 86400 + parts[0]
        return None
    except Exception:
        return None



# Infrastructure process names that pi-deadman itself spawns — must never be kill targets
# or pollute the snapshot ring buffer. Kept in sync with INFRA_NAMES in monitor.ts.
INFRA_NAMES = frozenset([
    "ps", "grep", "awk", "sed", "cut", "head", "tail", "wc",
    "sh", "bash", "zsh",
    "Python", "python3", "python",
    "footprint_worker.py",
    # pi-deadman's own monitoring subprocesses
    "sysctl", "vm_stat", "true", "memory_pressure",
])


def walk_tree(root_pid):
    """Walk full process tree under root_pid. Returns list of process dicts."""
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid,ppid"],
            capture_output=True, text=True, timeout=3,
        )
    except Exception:
        return []

    # Build parent→children map
    children_map = {}
    for line in out.stdout.strip().split("\n")[1:]:
        parts = line.split()
        if len(parts) >= 2:
            try:
                pid = int(parts[0])
                ppid = int(parts[1])
                children_map.setdefault(ppid, []).append(pid)
            except ValueError:
                continue

    # BFS from root
    result = []
    queue = list(children_map.get(root_pid, []))
    visited = set()

    while queue:
        pid = queue.pop(0)
        if pid in visited or pid == root_pid:
            continue
        visited.add(pid)

        fp = get_footprint(pid)
        name, age_seconds = get_process_info(pid)

        if name is not None:
            # Skip infrastructure processes — never include our own monitoring tools
            if name in INFRA_NAMES:
                # Still walk their children (a shell might parent a real process)
                for child in children_map.get(pid, []):
                    queue.append(child)
                continue
            result.append({
                "pid": pid,
                "name": name,
                "footprint_mb": fp // (1024 * 1024) if fp is not None else 0,
                "age_seconds": age_seconds,
            })

        # Add children of this pid
        for child in children_map.get(pid, []):
            queue.append(child)

    # Sort by footprint descending
    result.sort(key=lambda x: -x["footprint_mb"])
    return result


def get_pids_footprint(pids):
    """Get footprint for specific PIDs."""
    result = []
    for pid in pids:
        fp = get_footprint(pid)
        name, age_seconds = get_process_info(pid)
        if name is not None:
            result.append({
                "pid": pid,
                "name": name,
                "footprint_mb": fp // (1024 * 1024) if fp is not None else 0,
                "age_seconds": age_seconds,
            })
    result.sort(key=lambda x: -x["footprint_mb"])
    return result


def respond(obj):
    """Write JSON response to stdout and flush."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    # Signal readiness
    respond({"status": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            parts = line.split(None, 1)
            cmd = parts[0].upper()

            if cmd == "PING":
                respond({"status": "PONG"})

            elif cmd == "TREE":
                if len(parts) < 2:
                    respond({"error": "TREE requires a PID"})
                    continue
                root_pid = int(parts[1])
                processes = walk_tree(root_pid)
                respond({"processes": processes})

            elif cmd == "PIDS":
                if len(parts) < 2:
                    respond({"error": "PIDS requires comma-separated PIDs"})
                    continue
                pids = [int(p.strip()) for p in parts[1].split(",") if p.strip()]
                processes = get_pids_footprint(pids)
                respond({"processes": processes})

            elif cmd == "QUIT":
                respond({"status": "bye"})
                break

            else:
                respond({"error": f"Unknown command: {cmd}"})

        except Exception as e:
            respond({"error": str(e)})


if __name__ == "__main__":
    main()
