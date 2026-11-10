#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import stat
import subprocess
import sys


DEVSSD = Path("/Volumes/DevSSD")
DEVSSD_UUID = "D17C16FD-9411-4521-BFD6-4B5ED03B3FC5"
INTERNAL_MINIMUM = 12 * 1024**3
ARCHIVE_MINIMUM = 20 * 1024**3


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


def retire_candidates(candidates, identify=candidate_identity, validate=None):
    plan = [(path, identify(path)) for path in candidates]
    removed = 0
    for path, expected in plan:
        if expected is None:
            continue
        if validate is not None:
            validate()
        if identify(path) != expected:
            raise Refused("Generated output changed before cleanup")
        parent = open_directory(path.parent)
        try:
            remove_tree_at(parent, path.name, expected)
            os.fsync(parent)
            removed += 1
        finally:
            os.close(parent)
    return removed


def capture(arguments):
    return subprocess.run(arguments, check=True, stdout=subprocess.PIPE).stdout


def require_devssd():
    if DEVSSD.is_symlink() or not DEVSSD.is_dir() or not os.path.ismount(DEVSSD):
        raise Refused("DevSSD is not mounted; refusing external output creation")
    info = DEVSSD.stat()
    if info.st_dev == DEVSSD.parent.stat().st_dev or stat.S_IMODE(info.st_mode) & 0o022:
        raise Refused("DevSSD must be a separate mount without shared write access")
    volume = plistlib.loads(capture(["/usr/sbin/diskutil", "info", "-plist", str(DEVSSD)]))
    if not (isinstance(volume, dict) and volume.get("Mounted", True) is True
            and volume.get("MountPoint") == str(DEVSSD)
            and str(volume.get("VolumeUUID", "")).upper() == DEVSSD_UUID
            and volume.get("FilesystemType") == "apfs" and volume.get("Internal") is False
            and volume.get("GlobalPermissionsEnabled") is True):
        raise Refused("DevSSD identity/APFS/external/ownership verification failed")
    device = volume.get("DeviceNode", "")
    if not isinstance(device, str) or not re.fullmatch(r"/dev/disk\d+s\d+", device):
        raise Refused("DevSSD device identity is missing")
    rows = [line for line in capture(["/sbin/mount"]).decode().splitlines()
            if line.startswith(f"{device} on {DEVSSD} (") and line.endswith(")")]
    options = rows[0].split(" (", 1)[1][:-1].split(", ") if len(rows) == 1 else []
    if "apfs" not in options or "noowners" in options or "read-only" in options:
        raise Refused("DevSSD mount table must match its writable owned APFS volume")


def compiler_id():
    return hashlib.sha256(capture(["xcodebuild", "-version"])).hexdigest()[:16]


def output_paths():
    if os.getuid() != os.geteuid() or pwd.getpwuid(os.getuid()).pw_name != "mindwtr-ci":
        raise Refused("Self-hosted Apple CI requires the mindwtr-ci account")
    parts = [os.environ.get(name, "") for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")]
    if not all(re.fullmatch(pattern, value) for pattern, value in zip((r"[0-9]+", r"[0-9]+", r"[A-Za-z0-9_-]+"), parts)):
        raise Refused("Missing or invalid Actions job identity")
    namespace = DEVSSD / "ci/mindwtr-ci"
    cache = namespace / "caches" / compiler_id()
    temporary = namespace / "jobs" / "-".join(parts)
    return namespace, cache, temporary


def account_home():
    home = path_from_environment("HOME")
    if home != Path(pwd.getpwuid(os.getuid()).pw_dir):
        raise Refused("HOME must match the runner account home")
    descriptor = open_directory(home)
    os.close(descriptor)
    return home


def validate_outputs(namespace, paths):
    require_devssd()
    trusted = {0, os.getuid(), pwd.getpwnam("dd").pw_uid}
    for prefix in (DEVSSD, DEVSSD / "ci", namespace):
        descriptor = open_directory(prefix)
        try:
            info = os.fstat(descriptor)
            if info.st_uid not in trusted or stat.S_IMODE(info.st_mode) & 0o022:
                raise Refused("External namespace prefix needs trusted ownership without shared writes")
            if prefix == namespace and (stat.S_IMODE(info.st_mode) != 0o700
                    or info.st_uid not in {os.getuid(), pwd.getpwnam("dd").pw_uid}
                    or not os.access(prefix, os.R_OK | os.W_OK | os.X_OK)):
                raise Refused("CI namespace must be provisioned mode 0700 with effective account access")
        finally:
            os.close(descriptor)
    for path in paths:
        if namespace not in path.parents or ".." in path.parts:
            raise Refused("Output is outside the CI account namespace")
        for child in reversed([path, *path.parents]):
            if namespace not in child.parents:
                continue
            try:
                info = child.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise Refused("Output descendants must be owned directories without symlinks or shared writes")


def checked_paths(configured=True):
    namespace, cache, temporary = output_paths()
    paths = [cache, temporary, temporary / "tmp", temporary / "ios27-artifacts", temporary / "ios-swiftui-artifacts",
             cache / "swiftui", cache / "swiftui/tmp", cache / "swiftui/DerivedData",
             cache / "watch/products", cache / "watch/intermediates"]
    paths.extend(cache / "swift" / package for package in SWIFT_PACKAGES)
    paths.extend(cache / "swift" / package / "out" for package in SWIFT_PACKAGES)
    paths.extend([cache / "modules", cache / "swiftui/out", temporary / "ios27-artifacts/Mindwtr-unsigned.xcarchive",
                  temporary / "mindwtr-apple-api"])
    paths.extend(cache / family for family in ("simulator", "archive"))
    paths.extend(cache / family / child for family in ("simulator", "archive", "swiftui/DerivedData")
                 for child in DERIVED_OUTPUTS)
    validate_outputs(namespace, paths)
    if configured:
        expected = dict(MINDWTR_NATIVE_CACHE=cache, MINDWTR_APPLE_TEMP=temporary,
                        MINDWTR_SWIFT_CACHE=cache / "swift", MINDWTR_SWIFTUI_BUILD=cache / "swiftui",
                        TMPDIR=temporary / "tmp")
        if any(path_from_environment(name) != path for name, path in expected.items()):
            raise Refused("Configured outputs do not match this compiler and Actions job")
    return namespace, cache, temporary, paths


def available_bytes(path):
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def legacy_generated_cleanup(home):
    legacy = home / "Library/Caches/MindwtrNativeCI"
    if not legacy.exists() and not legacy.is_symlink():
        return 0
    descriptor = open_directory(legacy)
    os.close(descriptor)
    candidates = []
    for generation in legacy.iterdir():
        if not re.fullmatch(r"[0-9a-f]{16}", generation.name):
            continue
        descriptor = open_directory(generation)
        if os.fstat(descriptor).st_uid != os.getuid():
            os.close(descriptor)
            raise Refused("Legacy compiler output must belong to this account")
        os.close(descriptor)
        candidates.extend(generation / family / child for family in ("simulator", "archive") for child in DERIVED_OUTPUTS)
        candidates.extend(generation / "watch" / child for child in ("products", "intermediates"))
        candidates.extend(generation / "swift" / package / "out" for package in SWIFT_PACKAGES)
    for path in candidates:
        for parent in [path, *path.parents]:
            if parent != home and home not in parent.parents:
                break
            try:
                info = parent.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise Refused("Legacy generated output ancestors must be owned directories without shared writes")
    return retire_candidates(candidates, validate=lambda: checked_paths(configured=False))


def prepare(phase):
    namespace, cache, temporary, paths = checked_paths(configured=phase == "before-archive")
    home = account_home()
    before = available_bytes(home)
    removed = legacy_generated_cleanup(home) if phase == "startup" and before < INTERNAL_MINIMUM else 0
    internal = available_bytes(home)
    if internal < INTERNAL_MINIMUM:
        raise Refused("At least 12 GiB available on the internal HOME volume is required")
    external = available_bytes(namespace)
    if external < ARCHIVE_MINIMUM:
        raise Refused("At least 20 GiB available on the actual SSD archive volume is required")
    print(json.dumps(dict(internalAvailableBytes=internal, archiveAvailableBytes=external, legacyGeneratedRemoved=removed)))
    if phase == "before-archive":
        return
    directories = [cache / name for name in ("swift", "modules", "simulator", "archive", "swiftui/tmp", "watch/products", "watch/intermediates")]
    directories.extend(temporary / name for name in ("tmp", "ios27-artifacts", "ios-swiftui-artifacts"))
    for path in directories:
        validate_outputs(namespace, [path])
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    checked_paths(configured=False)
    values = dict(MINDWTR_NATIVE_CACHE=cache, MINDWTR_SWIFT_CACHE=cache / "swift",
                  MINDWTR_SWIFTUI_BUILD=cache / "swiftui", MINDWTR_APPLE_TEMP=temporary, TMPDIR=str(temporary / "tmp") + "/")
    with path_from_environment("GITHUB_ENV").open("a") as output:
        for name, value in values.items():
            output.write(f"{name}={value}\n")


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "run" and len(sys.argv) == 3:
        if os.environ.get("RUNNER_ENVIRONMENT") == "self-hosted" and os.environ.get("MINDWTR_NATIVE_CACHE"):
            checked_paths()
        return os.execv("/bin/bash", ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", sys.argv[2]])
    if len(sys.argv) != 2 or sys.argv[1] not in ("startup", "before-archive") or os.environ.get("GITHUB_ACTIONS") != "true":
        raise Refused("Expected an Actions startup or before-archive phase")
    prepare(sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, subprocess.SubprocessError) as error:
        print("apple-ci-storage: " + str(error), file=sys.stderr)
        sys.exit(1)

