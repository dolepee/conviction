#!/usr/bin/env python3
"""Hold an owner-local advisory mutex until the parent closes stdin.

The JSON release intent is the crash-recovery record; this kernel lock only
serializes contenders so a stale intent can never be removed by two processes
at once. The OS releases the flock automatically if either process dies.
"""

import fcntl
import hashlib
import json
import os
import stat
import sys


def _reply(request_id, *, ok, **fields):
    body = {"id": request_id, "ok": ok, **fields}
    sys.stdout.write(json.dumps(body, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _unlink_exact(command, state_directory):
    request_id = command.get("id")
    path = command.get("path")
    expected_sha256 = command.get("sha256")
    if (
        not isinstance(request_id, str)
        or not isinstance(path, str)
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
    ):
        _reply(request_id, ok=False, code="invalid_unlink_request")
        return

    parent = os.path.realpath(os.path.dirname(path))
    if parent != state_directory or os.path.dirname(path) != state_directory:
        _reply(request_id, ok=False, code="unsafe_unlink_path")
        return
    name = os.path.basename(path)
    if not name or name in (".", ".."):
        _reply(request_id, ok=False, code="unsafe_unlink_path")
        return

    directory_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    directory_fd = os.open(state_directory, directory_flags)
    try:
        directory_info = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or directory_info.st_uid != os.getuid()
            or directory_info.st_mode & 0o077
        ):
            _reply(request_id, ok=False, code="unsafe_state_directory")
            return

        file_flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            file_flags |= os.O_NOFOLLOW
        try:
            file_fd = os.open(name, file_flags, dir_fd=directory_fd)
        except FileNotFoundError:
            _reply(request_id, ok=False, code="ENOENT")
            return
        except OSError as error:
            _reply(request_id, ok=False, code="unsafe_state_file", errno=error.errno)
            return
        try:
            info = os.fstat(file_fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                _reply(request_id, ok=False, code="unsafe_state_file")
                return
            digest = hashlib.sha256()
            while True:
                chunk = os.read(file_fd, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if digest.hexdigest() != expected_sha256:
                _reply(request_id, ok=False, code="lock_generation_mismatch")
                return
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if (
                not stat.S_ISREG(current.st_mode)
                or current.st_dev != info.st_dev
                or current.st_ino != info.st_ino
            ):
                _reply(request_id, ok=False, code="lock_generation_mismatch")
                return
            os.unlink(name, dir_fd=directory_fd)
            os.fsync(directory_fd)
            _reply(request_id, ok=True, removed=True)
        finally:
            os.close(file_fd)
    finally:
        os.close(directory_fd)


def main() -> int:
    if len(sys.argv) != 3:
        return 64
    path = sys.argv[1]
    state_directory = os.path.realpath(sys.argv[2])
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
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                _reply(None, ok=False, code="invalid_mutex_command")
                continue
            if command.get("op") == "unlink_exact":
                try:
                    _unlink_exact(command, state_directory)
                except Exception as error:  # fail closed; keep the flock held
                    _reply(command.get("id"), ok=False, code="exact_unlink_failed", detail=type(error).__name__)
                continue
            _reply(command.get("id"), ok=False, code="invalid_mutex_command")
        return 0
    finally:
        os.close(fd)


if __name__ == "__main__":
    raise SystemExit(main())
