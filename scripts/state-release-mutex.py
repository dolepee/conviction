#!/usr/bin/env python3
"""Hold an owner-local advisory mutex until the parent closes stdin.

The JSON release intent is the crash-recovery record; this kernel lock only
serializes contenders so a stale intent can never be removed by two processes
at once. The OS releases the flock automatically if either process dies.
"""

import fcntl
import os
import stat
import sys


def main() -> int:
    if len(sys.argv) != 2:
        return 64
    path = sys.argv[1]
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            return 77
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.stdout.write("BUSY\n")
            sys.stdout.flush()
            return 75
        sys.stdout.write("LOCKED\n")
        sys.stdout.flush()
        sys.stdin.buffer.read(1)
        return 0
    finally:
        os.close(fd)


if __name__ == "__main__":
    raise SystemExit(main())
