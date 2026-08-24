#!/usr/bin/env python3
"""Validate every tracked Apple property list as XML or binary plist data."""

from __future__ import annotations

import plistlib
import subprocess
from pathlib import Path


def tracked_plists() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "*.plist"],
        check=True,
        capture_output=True,
    )
    return [Path(raw) for raw in result.stdout.decode().split("\0") if raw]


def main() -> int:
    failures: list[str] = []
    paths = tracked_plists()
    for path in paths:
        try:
            plistlib.loads(path.read_bytes())
        except (OSError, plistlib.InvalidFileException, ValueError) as error:
            failures.append(f"{path}: {error}")

    if failures:
        print("Invalid Apple property lists:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"Validated {len(paths)} tracked Apple property lists.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
