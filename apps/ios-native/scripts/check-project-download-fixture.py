#!/usr/bin/env python3
"""Read-only preflight of a stopped app's fresh capture and scoped HTTP evidence."""
import argparse
import hashlib
import json
from pathlib import Path


def check(capture, state, targets, requests, expected_gets):
    if state not in ("absent", "cached") or not targets or expected_gets < 0:
        raise ValueError("Explicit fixture state, targets and nonnegative GET count required")
    if not (capture / "mindwtr.sqlite").is_file():
        raise ValueError("Missing captured SQLite library")
    if (capture / "mindwtr.sqlite.pending.json").exists():
        raise ValueError("Fixture already has a pending write")
    files = capture / "attachment-files"
    if capture.is_symlink() or any(path.is_symlink() for path in capture.rglob("*")):
        raise ValueError("Fixture capture must not contain symlinks")
    actual = {path.relative_to(files).as_posix() for path in files.rglob("*")
              if path.is_file() and path.name != ".mindwtr-attachment-installer.lock"}
    expected = set()
    for name, digest in targets.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid fixture target or SHA-256")
        expected.add(path.as_posix())
        if state == "absent" and (files / path).exists():
            raise ValueError("Expected target already exists")
        if state == "cached" and (not (files / path).is_file()
                or hashlib.sha256((files / path).read_bytes()).hexdigest() != digest):
            raise ValueError("Cached target missing or has unexpected bytes")
    if actual != (expected if state == "cached" else set()):
        raise ValueError("Managed files do not match the intended fixture state")
    if not isinstance(requests, list) or any(not isinstance(row, dict)
            or not isinstance(row.get("method"), str) or not isinstance(row.get("route"), str)
            for row in requests):
        raise ValueError("Expected scoped HTTP request evidence")
    gets = sum(row["method"] == "GET" and row["route"] == "/v1/attachments/:path" for row in requests)
    if gets != expected_gets:
        raise ValueError("Unexpected attachment GET count before action")
    return {"state": state, "managedFiles": len(actual), "attachmentGETs": gets, "pendingWrite": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--state", required=True, choices=("absent", "cached"))
    parser.add_argument("--targets", required=True, type=Path, help="JSON mapping of attachment-files relative paths to SHA-256")
    parser.add_argument("--requests", required=True, type=Path, help="JSON array of requests since this fixture's server boundary")
    parser.add_argument("--expected-gets", required=True, type=int)
    args = parser.parse_args()
    print(json.dumps(check(args.capture, args.state, json.loads(args.targets.read_text()),
                           json.loads(args.requests.read_text()), args.expected_gets)))
