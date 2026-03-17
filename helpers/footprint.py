#!/usr/bin/env python3
"""Get top processes by physical footprint via proc_pid_rusage.

Outputs JSON array to stdout: [{"pid": int, "name": str, "footprint_mb": int, "rss_mb": int}, ...]
Sorted by footprint_mb descending. Top 20 processes by RSS checked for real footprint.
No root required.
"""
import ctypes
import ctypes.util
import json
import subprocess
import os

libc = ctypes.CDLL(ctypes.util.find_library("c"))

# rusage_info_v2 has many fields. We allocate a buffer large enough (1024 bytes)
# and read ri_phys_footprint at its known offset (byte 64, uint64).
# This avoids defining the full struct and risking buffer overflows.
#
# Layout (first 72 bytes of rusage_info_v2):
#   offset  0: ri_uuid (16 bytes)
#   offset 16: ri_user_time (8 bytes)
#   offset 24: ri_system_time (8 bytes)
#   offset 32: ri_pkg_idle_wkups (8 bytes)
#   offset 40: ri_interrupt_wkups (8 bytes)
#   offset 48: ri_pageins (8 bytes)
#   offset 56: ri_wired_size (8 bytes)
#   offset 64: ri_resident_size (8 bytes)
#   offset 72: ri_phys_footprint (8 bytes)
RUSAGE_BUF_SIZE = 1024  # way more than needed, safe
PHYS_FOOTPRINT_OFFSET = 72  # byte offset of ri_phys_footprint

def get_footprint(pid: int):
    """Get physical footprint in bytes for a PID, or None on failure."""
    buf = ctypes.create_string_buffer(RUSAGE_BUF_SIZE)
    ret = libc.proc_pid_rusage(pid, 2, buf)
    if ret != 0:
        return None
    # Read ri_phys_footprint as uint64 at offset 72
    fp_bytes = ctypes.c_uint64.from_buffer_copy(buf, PHYS_FOOTPRINT_OFFSET).value
    return fp_bytes

def main():
    ps = subprocess.run(
        ["ps", "-eo", "pid,rss,comm", "-r"],
        capture_output=True, text=True, timeout=5,
    )
    out = []
    for line in ps.stdout.strip().split("\n")[1:21]:
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0])
            rss_kb = int(parts[1])
        except ValueError:
            continue
        comm = parts[2]
        name = os.path.basename(comm)
        fp = get_footprint(pid)
        fp_mb = fp // (1024 * 1024) if fp is not None else rss_kb // 1024
        out.append({
            "pid": pid,
            "name": name,
            "footprint_mb": fp_mb,
            "rss_mb": rss_kb // 1024,
        })
    out.sort(key=lambda x: -x["footprint_mb"])
    print(json.dumps(out))

if __name__ == "__main__":
    main()
