#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


DERIVED_OUTPUTS = ("Build", "Index.noindex", "ModuleCache.noindex",
                   "SDKStatCaches.noindex", "SDKExplicitPrecompiledModules",
                   "CompilationCache.noindex")
SWIFT_PACKAGES = ("attachment-file-installer", "sync-file-lock", "cloudkit-sync",
                  "watch-connectivity", "ios-widget", "ios-siri-actions",
                  "apple-foundation-models", "apple-task-search", "apple-image-capture", "watch")


class Refused(Exception):
    pass


def path_from_environment(name):
    value = os.environ.get(name, "")
    if not value.startswith("/") or "\0" in value or ".." in Path(value).parts:
        raise Refused("Invalid configured output root")
    return Path(value)


def open_directory(path):
    if not path.is_absolute() or ".." in path.parts:
        raise Refused("Invalid output path")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def identity(info):
    return info.st_dev, info.st_ino


def candidate_identity(path):
    try:
        parent = open_directory(path.parent)
    except FileNotFoundError:
        return None
    try:
        try:
            info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(info.st_mode):
            raise Refused("Refusing non-directory generated output")
        return identity(info)
    finally:
        os.close(parent)


def remove_tree_at(parent, name, expected):
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        if identity(os.fstat(child)) != expected:
            raise Refused("Generated output changed before cleanup")
        for entry in os.listdir(child):
            info = os.stat(entry, dir_fd=child, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                remove_tree_at(child, entry, identity(info))
            else:

                os.unlink(entry, dir_fd=child)
        if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected:
            raise Refused("Generated output changed during cleanup")
        os.rmdir(name, dir_fd=parent)
    finally:
        os.close(child)


def cleanup(kind):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise Refused("Cleanup is restricted to GitHub Actions")
    if os.environ.get("RUNNER_ENVIRONMENT") != "self-hosted":
        return {"kind": kind, "removed": 0, "skipped": "hosted-runner"}
    if os.environ.get("MINDWTR_EVIDENCE_UPLOADED") != "true":
        raise Refused("Preserving outputs until evidence upload succeeds")
    home = path_from_environment("HOME")
    workspace = path_from_environment("GITHUB_WORKSPACE")
    temporary = path_from_environment("RUNNER_TEMP")
    cache = path_from_environment("MINDWTR_NATIVE_CACHE")
    if workspace == home or home not in workspace.parents or temporary == home or home not in temporary.parents:
        raise Refused("CI workspace and temporary roots must belong to this account")
    version = subprocess.run(["xcodebuild", "-version"], check=True, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL).stdout
    expected_cache = home / "Library/Caches/MindwtrNativeCI" / hashlib.sha256(version).hexdigest()[:16]
    if cache != expected_cache:
        raise Refused("Refusing a cache outside the current compiler generation")
    for root in (home, workspace, temporary, cache):
        descriptor = open_directory(root)
        os.close(descriptor)

    candidates = []
    if kind == "swiftui":
        build = workspace / "apps/ios-native/.build"
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


    plan = [(path, candidate_identity(path)) for path in candidates]
    before = os.statvfs(home).f_bavail * os.statvfs(home).f_frsize
    removed = 0
    for path, expected in plan:
        if expected is None:
            continue
        if candidate_identity(path) != expected:
            raise Refused("Generated output changed before cleanup")
        parent = open_directory(path.parent)
        try:
            remove_tree_at(parent, path.name, expected)
            os.fsync(parent)
            removed += 1
        finally:
            os.close(parent)
    after = os.statvfs(home).f_bavail * os.statvfs(home).f_frsize
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
    except (OSError, subprocess.SubprocessError):
        print("cleanup-apple-outputs: Safe output cleanup unavailable; remaining files preserved", file=sys.stderr)
        sys.exit(1)
