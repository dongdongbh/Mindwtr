#!/usr/bin/env python3

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
    plists: dict[Path, object] = {}
    for path in paths:
        try:
            plists[path] = plistlib.loads(path.read_bytes())
        except (OSError, plistlib.InvalidFileException, ValueError) as error:
            failures.append(f"{path}: {error}")

    required_values = {
        Path("apps/desktop/src-tauri/Info.plist"): {
            "NSMicrophoneUsageDescription": str,
        },
        Path("apps/desktop/src-tauri/Info.appstore.plist"): {
            "NSMicrophoneUsageDescription": str,
        },
        Path("apps/desktop/src-tauri/Entitlements.mas.plist"): {
            "com.apple.security.device.audio-input": True,
            "com.apple.security.device.microphone": True,
        },
        Path("apps/desktop/src-tauri/Entitlements.mac.plist"): {
            "com.apple.security.device.audio-input": True,
        },
    }
    for path, requirements in required_values.items():
        plist = plists.get(path)
        if not isinstance(plist, dict):
            continue
        for key, expected in requirements.items():
            value = plist.get(key)
            valid = (
                isinstance(value, expected) and bool(value)
                if expected is str
                else value is expected
            )
            if not valid:
                failures.append(f"{path}: missing or invalid {key}")

    if failures:
        print("Invalid Apple property lists:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"Validated {len(paths)} tracked Apple property lists.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
