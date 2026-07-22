#!/usr/bin/env python3

"""Test-only state mutex helper with deterministic crash and delay modes."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()
    raise SystemExit(code)


if len(sys.argv) != 3:
    fail("usage: state-mutex-adversary.py MUTEX_FILE STATE_DIRECTORY")

mutex_path = Path(sys.argv[1])
state_directory = Path(sys.argv[2]).resolve(strict=True)
mutex_path.parent.mkdir(parents=True, exist_ok=True)
descriptor = os.open(mutex_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.stdout.write("BUSY\n")
        sys.stdout.flush()
        raise SystemExit(75)
    os.fchmod(descriptor, 0o600)
    sys.stdout.write("LOCKED\n")
    sys.stdout.flush()
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = request["id"]
            if request.get("op") != "unlink_exact":
                emit({"id": request_id, "ok": False, "code": "invalid_unlink_request"})
                continue
            candidate = Path(request["path"])
            candidate_parent = candidate.parent.resolve(strict=True)
            if candidate_parent != state_directory or candidate.name in ("", ".", ".."):
                emit({"id": request_id, "ok": False, "code": "unsafe_state_path"})
                continue
            link_stat = os.lstat(candidate)
            if stat.S_ISLNK(link_stat.st_mode) or not stat.S_ISREG(link_stat.st_mode):
                emit({"id": request_id, "ok": False, "code": "unsafe_state_file"})
                continue
            mode_file = state_directory / "mutex-helper-mode.txt"
            mode = mode_file.read_text(encoding="utf-8").strip() if mode_file.exists() else "normal"
            if mode == "die-before-unlink":
                os._exit(91)
            if mode == "delay-unlink":
                (state_directory / "mutex-helper.ready").write_text("ready\n", encoding="utf-8")
                while not (state_directory / "mutex-helper.go").exists():
                    time.sleep(0.005)
            contents = candidate.read_bytes()
            if hashlib.sha256(contents).hexdigest() != request.get("sha256"):
                emit({"id": request_id, "ok": False, "code": "exact_unlink_mismatch", "removed": False})
                continue
            candidate.unlink()
            if mode == "die-after-unlink":
                os._exit(92)
            emit({"id": request_id, "ok": True, "removed": True})
        except FileNotFoundError:
            emit({"id": request.get("id"), "ok": False, "code": "exact_unlink_missing", "removed": False})
        except Exception as error:  # pragma: no cover - returned to the Node harness
            emit({"id": request.get("id") if isinstance(request, dict) else None,
                  "ok": False, "code": "test_helper_failed", "message": str(error)})
finally:
    os.close(descriptor)
