#!/usr/bin/env python3
import json
import os
import subprocess
import sys


import apple_ci_storage as storage
from apple_ci_storage import DERIVED_OUTPUTS, SWIFT_PACKAGES, Refused, path_from_environment, open_directory, candidate_identity


def cleanup(kind):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise Refused("Cleanup is restricted to GitHub Actions")
    if os.environ.get("RUNNER_ENVIRONMENT") != "self-hosted":
        return {"kind": kind, "removed": 0, "skipped": "hosted-runner"}
    if os.environ.get("MINDWTR_EVIDENCE_UPLOADED") != "true":
        raise Refused("Preserving outputs until evidence upload succeeds")
    home = storage.account_home()
    workspace = path_from_environment("GITHUB_WORKSPACE")
    runner_temporary = path_from_environment("RUNNER_TEMP")
    _, cache, temporary, _ = storage.checked_paths()
    if workspace == home or home not in workspace.parents or runner_temporary == home or home not in runner_temporary.parents:
        raise Refused("CI workspace and temporary roots must belong to this account")
    for root in (home, workspace, runner_temporary, temporary, cache):
        descriptor = open_directory(root)
        os.close(descriptor)

    candidates = []
    if kind == "swiftui":
        build = cache / "swiftui"
        candidates.extend(build / child for child in ("out", "tmp"))
        candidates.extend(build / "DerivedData" / child for child in DERIVED_OUTPUTS)
    else:
        generations = ("simulator",) if kind == "ios-pre-archive" else ("simulator", "archive")
        for generation in generations:
            candidates.extend(cache / generation / child for child in DERIVED_OUTPUTS)
        candidates.extend(cache / "watch" / child for child in ("products", "intermediates"))
        candidates.extend(cache / "swift" / package / "out" for package in SWIFT_PACKAGES)
        if kind != "ios-pre-archive":
            candidates.append(workspace / "apps/mobile/ios/build")
            candidates.append(temporary / "ios27-artifacts/Mindwtr-unsigned.xcarchive")


    before = storage.available_bytes(cache)
    storage.checked_paths()
    removed = storage.retire_candidates(candidates, identify=candidate_identity, validate=storage.checked_paths)
    after = storage.available_bytes(cache)
    return {"kind": kind, "removed": removed, "beforeAvailableBytes": before,
            "afterAvailableBytes": after}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("swiftui", "ios", "ios-pre-archive"):
            raise Refused("Expected swiftui, ios or ios-pre-archive cleanup scope")
        print(json.dumps(cleanup(sys.argv[1]), sort_keys=True))
    except Refused as error:
        print("cleanup-apple-outputs: " + str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError):
        print("cleanup-apple-outputs: Safe output cleanup unavailable; remaining files preserved", file=sys.stderr)
        sys.exit(1)
