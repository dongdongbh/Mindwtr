#!/usr/bin/env python3
from __future__ import annotations
COMMAND_DESCRIPTION = """Conservatively retire clean, merged, inactive registered worktrees."""


import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from typing import Callable
import uuid


ARCHIVE_RESERVE_BYTES = 512 * 1024 * 1024
DEFAULT_MIN_FREE_GB = 60
DEFAULT_LOCK_PATH = Path.home() / ".local" / "state" / "mindwtr-worktree-cleanup.lock"
GIT_TIMEOUT_SECONDS = 120
PROBE_TIMEOUT_SECONDS = 60
UNSTATTABLE_MOUNT_WARNING = re.compile(
    rb"lsof: WARNING: can't stat\(\) [^\n]* file system ([^\n]+)\n      Output information may be incomplete\.\n")
PROTECTED_NAMES = {"native-ios-foundation", "ios-editor-draft-recovery", "apple-ui-wda"}
GENERATED_PREFIXES = (
    ("apps", "ios-native", ".build"),
    ("apps", "desktop", "src-tauri", "target"),
    ("apps", "mobile", "android", ".gradle"),
    ("apps", "mobile", "android", "build"),
    ("apps", "mobile", "android", "app", "build"),
    ("apps", "android-native", ".gradle"),
    ("apps", "android-native", "build"),
    ("apps", "android-native", "app", "build"),
    ("apps", "android-native", "android", ".gradle"),
    ("apps", "android-native", "android", ".kotlin"),
    ("apps", "android-native", "android", "build"),
    ("apps", "android-native", "android", "app", "build"),
    ("apps", "android-native", "android", "app", ".cxx"),
    ("apps", "android-native", "android", "widget", "build"),
    ("apps", "android-native", "android", "app", "src", "main", "assets", "core-host.js"),
    ("apps", "ios-native", "Resources", "core-host.js"),
    ("apps", "ios-native", "Resources", "label-keys.json"),
    ("apps", "ios-native", "Sources", "MindwtrNativeCore", "Resources", "sandbox-host.js"),
    ("apps", "mobile", ".expo"),
    ("apps", "mobile", "expo-env.d.ts"),
    ("apps", "mobile", "modules", "whisper-engine", ".tests-tmp"),
    ("apps", "desktop", "dist"),
    ("apps", "desktop", "src-tauri", "gen", "schemas"),
    (".gradle",),
    (".venv-comments",),
    ("coverage",),
)
PACKAGE_GENERATED_NAMES = ("node_modules", "coverage")


class SafetyError(Exception):
    pass


def sha256_stream(source) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def checked_path(value: str | Path, *, must_exist: bool = True) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise SafetyError("path_must_be_absolute_without_parent_traversal")

    for ancestor in [*reversed(path.parents), path]:
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            if must_exist:
                raise SafetyError("path_missing") from None
            continue
        except OSError:
            raise SafetyError("path_unreadable") from None
        if stat.S_ISLNK(info.st_mode):
            raise SafetyError("symlinked_path")
    return path


def inside(path: Path, parent: Path) -> bool:
    for ancestor in [path, *path.parents]:
        try:
            if ancestor.samefile(parent):
                return True
        except FileNotFoundError:
            continue
        except OSError:
            raise SafetyError("path_unreadable") from None
    return False


def run_git(repo: Path, *args: str, accepted: tuple[int, ...] = (0,), input: bytes | None = None) -> bytes:
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1", GIT_LITERAL_PATHSPECS="1")
    try:
        result = subprocess.run(
            ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c",
             "core.untrackedCache=false", "-C", str(repo), *args],
            input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_TIMEOUT_SECONDS,
            check=False, env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SafetyError("git_unavailable_or_timed_out") from None
    if result.returncode not in accepted:
        raise SafetyError("git_operation_failed")
    return result.stdout


def registrations(repo: Path) -> list[dict]:
    records: list[dict] = []
    current: dict = {}
    for field in run_git(repo, "worktree", "list", "--porcelain", "-z").split(b"\0"):
        if not field:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = os.fsdecode(field).partition(" ")
        if key == "worktree":
            current["path"] = value
        elif key in ("HEAD", "branch"):
            current[key.lower()] = value
        elif key in ("locked", "prunable"):
            current[key] = True
        elif key == "detached":
            current["detached"] = True
    if current:
        records.append(current)
    if not records or any("path" not in item for item in records):
        raise SafetyError("registration_unreadable")
    return records


def generated_group(relative: str) -> str | None:
    parts = PurePosixPath(relative).parts
    if not parts or any(part in ("..", ".") for part in parts):
        return None
    if re.fullmatch(r"\.build-task[0-9]+", parts[0]):
        return parts[0]
    if parts[0] == "node_modules":
        return "node_modules"
    if len(parts) >= 3 and parts[0] in ("apps", "packages") and parts[2] in PACKAGE_GENERATED_NAMES:
        return "/".join(parts[:3])
    if "__pycache__" in parts[:-1]:
        return "/".join(parts[:parts.index("__pycache__") + 1])
    for prefix in GENERATED_PREFIXES:
        if parts[:len(prefix)] == prefix:
            return "/".join(prefix)
    return None


def ignored_inventory(path: Path) -> tuple[list[str], bool]:
    groups: set[str] = set()
    evidence = False
    for raw in run_git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z").split(b"\0"):
        if not raw:
            continue
        relative = os.fsdecode(raw)
        parts = PurePosixPath(relative).parts
        if parts and parts[0] == ".orchestrator":
            evidence = True
            continue
        group = generated_group(relative)
        if group is None:
            raise SafetyError("unknown_ignored_content")
        groups.add(group)
    for group in groups:
        if run_git(path, "ls-files", "-z", "--", group):
            raise SafetyError("generated_path_contains_tracked_source")
    return sorted(groups), evidence


def status_changes(path: Path) -> list[tuple[str, str]]:
    output = run_git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all",
                     "--ignore-submodules=none", "--no-renames")
    return [(os.fsdecode(field[:2]), os.fsdecode(field[3:])) for field in output.split(b"\0") if field]


def tree_entries(repo: Path, commit: str) -> dict[str, tuple[str, str]]:
    entries: dict[str, tuple[str, str]] = {}
    for field in run_git(repo, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if field:
            meta, _, name = field.partition(b"\t")
            mode, _, object_id = os.fsdecode(meta).split()
            entries[os.fsdecode(name)] = (mode, object_id)
    return entries


def single_sided_change(code: str) -> bool:
    return code == "??" or (code[0] in "MAD" and code[1] == " ") or (code[0] == " " and code[1] in "MD")


def path_signature(path: Path, relative: str) -> tuple[int, int, int, int] | None:
    try:
        info = (path / relative).lstat()
    except FileNotFoundError:
        return None
    return info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode


def matches_tree_entry(path: Path, relative: str, entries: dict[str, tuple[str, str]],
                       signature: tuple[int, int, int, int] | None) -> bool:
    expected = entries.get(relative)
    if signature is None or expected is None:
        return signature is None and expected is None
    if not stat.S_ISREG(signature[3]) or expected[0] != ("100755" if signature[3] & stat.S_IXUSR else "100644"):
        return False
    try:
        with open_evidence_file(path, relative) as source:
            data = source.read()
    except SafetyError:
        return False
    return os.fsdecode(run_git(path, "hash-object", "--no-filters", "--stdin", input=data)).strip() == expected[1]


def proven_signature(path: Path, relative: str,
                     entries: dict[str, tuple[str, str]]) -> tuple[bool, tuple[int, int, int, int] | None]:
    before = path_signature(path, relative)
    equal = matches_tree_entry(path, relative, entries, before)
    return equal and path_signature(path, relative) == before, before


def has_unreachable_reflog_commit(path: Path, origin_head: str) -> bool:
    commits = sorted(set(os.fsdecode(run_git(path, "reflog", "show", "--format=%H", "HEAD")).split()))
    if not commits:
        return False
    return bool(run_git(path, "rev-list", "-n", "1", *commits, "--not", "--branches", "--tags", origin_head))


def internal_tracked_links(path: Path) -> set[str]:
    links: set[str] = set()
    for field in run_git(path, "ls-files", "-s", "-z").split(b"\0"):
        meta, _, name = field.partition(b"\t")
        if not meta.startswith(b"120000 "):
            continue
        relative = os.fsdecode(name)
        try:
            target = os.readlink(path / relative)
        except OSError:
            continue
        resolved = os.path.normpath(os.path.join(os.path.dirname(relative), target))
        if not os.path.isabs(target) and resolved != ".." and not resolved.startswith("../"):
            links.add(relative)
    return links


def activity_mtime(path: Path, allowed_generated_groups: list[str] | None = None,
                   allowed_links: set[str] | None = None) -> int:
    newest = 0
    pending = [path]
    try:
        while pending:
            directory = pending.pop()
            newest = max(newest, directory.lstat().st_mtime_ns)
            with os.scandir(directory) as entries:
                for entry in entries:
                    if directory == path and entry.name == ".git":
                        continue
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        relative = Path(entry.path).relative_to(path).as_posix()
                        group = generated_group(relative)
                        generated = group is not None and group in (allowed_generated_groups or [])
                        if not generated and relative not in (allowed_links or set()):
                            raise SafetyError("symlinked_worktree_content")


                        newest = max(newest, info.st_mtime_ns)
                        continue
                    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                        raise SafetyError("unsupported_worktree_content")
                    newest = max(newest, info.st_mtime_ns)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(entry.path))
    except OSError:
        raise SafetyError("activity_scan_failed") from None
    return newest


def only_unrelated_mount_warnings(stderr: bytes, path: Path) -> bool:
    mounts = [Path(os.fsdecode(mount)) for mount in UNSTATTABLE_MOUNT_WARNING.findall(stderr)]
    return UNSTATTABLE_MOUNT_WARNING.sub(b"", stderr) == b"" and all(
        mount.is_absolute() and mount != path and mount not in path.parents and path not in mount.parents
        for mount in mounts)


def process_active(path: Path) -> bool:


    try:
        result = subprocess.run(
            ["lsof", "-n", "-P", "-F0p", "+D", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=PROBE_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SafetyError("process_probe_unavailable") from None
    if (result.stderr and not only_unrelated_mount_warnings(result.stderr, path)) or result.returncode not in (0, 1):
        raise SafetyError("process_probe_failed")
    if result.stdout:
        return True
    if result.returncode == 0:
        raise SafetyError("process_probe_failed")
    return False


def open_evidence_file(root: Path, relative: str):
    descriptors: list[int] = []
    try:
        descriptors.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        parts = PurePosixPath(relative).parts
        for component in parts[:-1]:
            descriptors.append(os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                       dir_fd=descriptors[-1]))
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptors[-1])
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            os.close(descriptor)
            raise SafetyError("unsupported_evidence_content")
        return os.fdopen(descriptor, "rb")
    except OSError:
        raise SafetyError("evidence_read_failed") from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def evidence_manifest(root: Path) -> list[dict]:
    if not root.exists() and not root.is_symlink():
        return []
    checked_path(root)
    if not root.is_dir():
        raise SafetyError("unsupported_evidence_content")
    result: list[dict] = []
    pending = [root]
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    relative = Path(entry.path).relative_to(root).as_posix()
                    item = {"path": relative, "mode": stat.S_IMODE(info.st_mode),
                            "mtime_ns": info.st_mtime_ns}
                    if stat.S_ISDIR(info.st_mode):
                        item["kind"] = "directory"
                        pending.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode):
                        with open_evidence_file(root, relative) as source:
                            before = os.fstat(source.fileno())
                            digest = sha256_stream(source)
                            after = os.fstat(source.fileno())
                        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
                        if signature(info) != signature(before) or signature(before) != signature(after):
                            raise SafetyError("evidence_changed")
                        item.update(kind="file", size=info.st_size, sha256=digest)
                    else:
                        raise SafetyError("unsupported_evidence_content")
                    result.append(item)
    except OSError:
        raise SafetyError("evidence_read_failed") from None
    return sorted(result, key=lambda item: item["path"])


def verify_archive(archive: Path, manifest: list[dict]) -> None:
    expected = {".orchestrator/" + item["path"]: item for item in manifest}
    found: set[str] = set()
    try:
        with tarfile.open(archive, "r:gz") as source:
            for member in source:
                item = expected.get(member.name)
                if item is None or member.name in found or member.mode != item["mode"]:
                    raise SafetyError("archive_verification_failed")
                found.add(member.name)
                if item["kind"] == "directory":
                    if not member.isdir():
                        raise SafetyError("archive_verification_failed")
                else:
                    if not member.isfile() or member.size != item["size"]:
                        raise SafetyError("archive_verification_failed")
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise SafetyError("archive_verification_failed")
                    with extracted:
                        if sha256_stream(extracted) != item["sha256"]:
                            raise SafetyError("archive_verification_failed")
        if found != set(expected):
            raise SafetyError("archive_verification_failed")
    except (OSError, tarfile.TarError, EOFError):
        raise SafetyError("archive_verification_failed") from None


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path: Path, value: dict, *, replace: bool = False) -> None:
    checked_path(path, must_exist=False)
    temporary = path.parent / (".partial-" + uuid.uuid4().hex)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=True, sort_keys=True, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
            temporary.unlink()
        fsync_directory(path.parent)
    except OSError:
        raise SafetyError("report_write_failed") from None
    finally:
        temporary.unlink(missing_ok=True)


def validate_report_path(path: Path, archive_root: Path, *, apply: bool) -> None:
    checked_path(path, must_exist=False)
    designated_name = "latest-apply.json" if apply else "latest-preview.json"
    if path.name != designated_name or path.parent != archive_root:
        raise SafetyError("report_path_not_designated")
    if archive_root.exists():
        info = archive_root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise SafetyError("archive_root_must_be_private_owned_directory")
    elif not apply:
        raise SafetyError("report_parent_missing")
    if not path.exists():
        return


    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16 * 1024 * 1024:
        raise SafetyError("report_existing_content_not_report")
    try:
        with path.open("rb") as source:
            previous = json.loads(source.read(16 * 1024 * 1024 + 1))
    except (OSError, ValueError, UnicodeError):
        raise SafetyError("report_existing_content_not_report") from None
    required = {"version", "mode", "older_than_days", "observed_at_utc", "origin_main_freshly_fetched", "worktrees"}
    allowed = required | {"origin_main_head", "ref_freshness", "error"}
    if not isinstance(previous, dict) or not required <= previous.keys() or not previous.keys() <= allowed:
        raise SafetyError("report_existing_content_not_report")
    if previous["version"] != 1 or previous["mode"] != ("apply" if apply else "dry-run") or not isinstance(previous["worktrees"], list):
        raise SafetyError("report_existing_content_not_report")


class Cleanup:
    def __init__(self, repo: Path, worktree_root: Path, archive_root: Path, *,
                 older_than_days: int = 10, protect: list[Path] | None = None,
                 now: Callable[[], float] = time.time,
                 probe: Callable[[Path], bool] = process_active,
                 free_bytes: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free,
                 lock_path: Path = DEFAULT_LOCK_PATH, min_free_gb: float = DEFAULT_MIN_FREE_GB):
        self.repo = checked_path(repo)
        self.worktree_root = checked_path(worktree_root)
        self.archive_root = checked_path(archive_root, must_exist=False)
        if not self.repo.is_dir() or not self.worktree_root.is_dir():
            raise SafetyError("configured_root_not_directory")
        if inside(self.archive_root, self.worktree_root) or inside(self.archive_root, self.repo):
            raise SafetyError("archive_root_inside_source")
        if older_than_days < 1:
            raise SafetyError("invalid_age")
        if not (math.isfinite(min_free_gb) and min_free_gb >= 0):
            raise SafetyError("invalid_min_free")
        self.lock_path = checked_path(lock_path, must_exist=False)
        self.min_free_bytes = int(min_free_gb * 1024**3)
        self.origin_entries: dict[str, tuple[str, str]] | None = None
        self.proven_changes: dict[str, list[tuple[str, str, tuple[int, int, int, int] | None]]] = {}
        self.protect = [checked_path(path, must_exist=False) for path in (protect or [])]
        self.now, self.probe, self.free_bytes = now, probe, free_bytes
        self.older_than_days = older_than_days
        self.origin_head = ""
        self.lock_descriptor: int | None = None
        common = Path(os.fsdecode(run_git(self.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip())
        gitdir = Path(os.fsdecode(run_git(self.repo, "rev-parse", "--absolute-git-dir")).strip())
        top = Path(os.fsdecode(run_git(self.repo, "rev-parse", "--show-toplevel")).strip())
        checked_path(common)
        if not top.samefile(self.repo) or not common.samefile(gitdir) or common != self.repo / ".git":
            raise SafetyError("repo_must_be_primary_checkout")

    def lock(self) -> None:
        checked_path(self.archive_root, must_exist=False)
        if not self.archive_root.exists():
            self.archive_root.mkdir(mode=0o700, parents=False)
        info = self.archive_root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise SafetyError("archive_root_must_be_private_owned_directory")
        checked_path(self.lock_path, must_exist=False)
        try:
            descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except OSError:
            raise SafetyError("cleanup_lock_unavailable") from None
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise SafetyError("cleanup_lock_unsafe")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SafetyError("cleanup_already_running") from None
            self.lock_descriptor = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def changes_on_origin_main(self, path: Path,
                               changes: list[tuple[str, str]]) -> list[tuple[str, str, tuple[int, int, int, int] | None]] | None:
        if not all(single_sided_change(code) for code, _ in changes):
            return None
        if self.origin_entries is None:
            self.origin_entries = tree_entries(self.repo, self.origin_head)
        proven = []
        for code, relative in changes:
            equal, signature = proven_signature(path, relative, self.origin_entries)
            if not equal:
                return None
            proven.append((code, relative, signature))
        return proven

    def assess(self, record: dict) -> dict:
        result = {"path": record["path"], "head": record.get("head"),
                  "branch": record.get("branch"), "decision": "skip"}
        self.proven_changes.pop(record["path"], None)
        try:
            path = checked_path(record["path"])
            if path.samefile(self.repo):
                raise SafetyError("primary_checkout")
            if not path.parent.samefile(self.worktree_root):
                raise SafetyError("outside_direct_worktree_root")
            if path.name in PROTECTED_NAMES:
                raise SafetyError("protected")
            if record.get("locked") or record.get("prunable"):
                raise SafetyError("locked_or_prunable")
            for protected in self.protect:
                if path == protected or (protected.exists() and path.samefile(protected)):
                    raise SafetyError("protected")
            checked_path(path / ".git")
            top = Path(os.fsdecode(run_git(path, "rev-parse", "--show-toplevel")).strip())
            common = Path(os.fsdecode(run_git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip())
            checked_path(common)
            if not top.samefile(path) or not common.samefile(self.repo / ".git"):
                raise SafetyError("registration_metadata_mismatch")
            head = os.fsdecode(run_git(path, "rev-parse", "HEAD")).strip()
            if head != record.get("head") or not re.fullmatch(r"[0-9a-f]{40,64}", head):
                raise SafetyError("head_changed_or_invalid")
            result["head"] = head
            if subprocess_ancestor(self.repo, head, self.origin_head) is False:
                raise SafetyError("not_merged_into_origin_main")
            if has_unreachable_reflog_commit(path, self.origin_head):
                raise SafetyError("unreachable_reflog_commit")
            for entry in run_git(path, "ls-files", "-v", "-z").split(b"\0"):
                if entry and (entry[:1] == b"S" or entry[0] in b"abcdefghijklmnopqrstuvwxyz"):
                    raise SafetyError("hidden_index_flags")
            changes = status_changes(path)
            proven = self.changes_on_origin_main(path, changes) if changes else []
            if proven is None:
                raise SafetyError("dirty_or_untracked")
            groups, evidence = ignored_inventory(path)
            newest = activity_mtime(path, groups, internal_tracked_links(path))
            result.update(newest_activity_utc=dt.datetime.fromtimestamp(newest / 1e9, dt.timezone.utc).isoformat(),
                          generated_group_count=len(groups), evidence_present=evidence)
            if newest > int((self.now() - self.older_than_days * 86400) * 1e9):
                raise SafetyError("recent_activity")
            if self.probe(path):
                raise SafetyError("active_process")
            if proven:
                self.proven_changes[str(path)] = proven
                result.update(decision="eligible", reason="merged_inactive_changes_on_origin_main",
                              changed_path_count=len(proven))
            else:
                result.update(decision="eligible", reason="clean_merged_inactive")
        except SafetyError as error:
            result["reason"] = str(error)
        except OSError:
            result["reason"] = "filesystem_probe_failed"
        return result

    def archive(self, worktree: Path, head: str, manifest: list[dict]) -> tuple[Path | None, str | None]:
        if not any(item["kind"] == "file" for item in manifest):
            return None, None


        total = 10240 + sum(1024 + ((item.get("size", 0) + 511) // 512) * 512 for item in manifest)
        estimate = total + (total + 99) // 100
        budget = estimate + max(ARCHIVE_RESERVE_BYTES, (estimate + 9) // 10) + self.min_free_bytes
        try:
            if self.free_bytes(self.archive_root) < budget:
                raise SafetyError("low_disk")
        except OSError:
            raise SafetyError("archive_space_probe_failed") from None
        name = worktree.name + "-" + head[:12] + "-" + uuid.uuid4().hex
        temporary = self.archive_root / (".partial-" + name + ".tar.gz")
        final = self.archive_root / (name + ".tar.gz")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                with tarfile.open(fileobj=output, mode="w:gz") as archive:
                    for item in manifest:
                        member = tarfile.TarInfo(".orchestrator/" + item["path"])
                        member.mode = item["mode"]
                        member.mtime = item["mtime_ns"] / 1e9
                        if item["kind"] == "directory":
                            member.type = tarfile.DIRTYPE
                            archive.addfile(member)
                        else:
                            member.size = item["size"]
                            with open_evidence_file(worktree / ".orchestrator", item["path"]) as source:
                                archive.addfile(member, source)
                output.flush()
                os.fsync(output.fileno())
            verify_archive(temporary, manifest)
            if evidence_manifest(worktree / ".orchestrator") != manifest:
                raise SafetyError("evidence_changed")
            with temporary.open("rb") as source:
                digest = sha256_stream(source)


            os.link(temporary, final)
            temporary.unlink()
            fsync_directory(self.archive_root)
            return final, digest
        except (OSError, tarfile.TarError):
            raise SafetyError("archive_write_failed") from None
        finally:
            temporary.unlink(missing_ok=True)

    def discard_changes_on_origin_main(self, path: Path) -> None:
        proven = self.proven_changes.get(str(path), [])
        if not proven:
            return
        if status_changes(path) != [(code, relative) for code, relative, _ in proven]:
            raise SafetyError("changed_before_discard")
        for code, relative, signature in proven:
            equal, current = proven_signature(path, relative, self.origin_entries or {})
            if not equal or current != signature:
                raise SafetyError("changed_before_discard")
            if code == "??":
                checked_path(path / relative).unlink()
            else:
                run_git(path, "restore", "--source=HEAD", "--staged", "--worktree", "--", relative)

    def retire(self, initial: dict) -> dict:
        result = dict(initial)
        path = Path(initial["path"])
        try:
            manifest = evidence_manifest(path / ".orchestrator")
            archive, digest = self.archive(path, initial["head"], manifest)
            result.update(archive=str(archive) if archive else None, archive_sha256=digest)
            receipt_path = self.archive_root / ("retirement-" + uuid.uuid4().hex + ".json")
            receipt = {"version": 1, "status": "prepared", "path": str(path), "head": initial["head"],
                       "branch": initial.get("branch"), "archive": result["archive"], "archive_sha256": digest,
                       "evidence_manifest": manifest,
                       "prepared_at_utc": dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).isoformat()}
            atomic_json(receipt_path, receipt)
            result["receipt"] = str(receipt_path)


            current = next((item for item in registrations(self.repo) if item["path"] == str(path)), None)
            if current is None:
                raise SafetyError("registration_changed")
            if evidence_manifest(path / ".orchestrator") != manifest:
                raise SafetyError("evidence_changed")
            checked = self.assess(current)
            if checked["decision"] != "eligible":
                raise SafetyError("recheck_" + checked.get("reason", "head_changed"))
            if checked["head"] != initial["head"]:
                raise SafetyError("recheck_head_changed")
            self.discard_changes_on_origin_main(path)
            run_git(self.repo, "worktree", "remove", "--", str(path))
            result.update(decision="removed", reason="retired")
            receipt.update(status="removed", removed_at_utc=dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).isoformat())
            try:
                atomic_json(receipt_path, receipt, replace=True)
            except SafetyError:
                result["reason"] = "removed_receipt_completion_failed"
        except SafetyError as error:
            result.update(decision="skip", reason=str(error))
        except OSError:
            result.update(decision="skip", reason="filesystem_operation_failed")
        return result

    def run(self, *, apply: bool = False, report_path: Path | None = None) -> dict:
        report = {"version": 1, "mode": "apply" if apply else "dry-run", "older_than_days": self.older_than_days,
                  "observed_at_utc": dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).isoformat(),
                  "origin_main_freshly_fetched": False, "worktrees": []}
        try:
            self.assess_all(report, apply)
            if report_path is not None and (not apply or self.lock_descriptor is not None):
                validate_report_path(report_path, self.archive_root, apply=apply)
                atomic_json(report_path, report, replace=True)
        finally:
            if self.lock_descriptor is not None:
                os.close(self.lock_descriptor)
                self.lock_descriptor = None
        return report

    def assess_all(self, report: dict, apply: bool) -> None:
        try:
            if apply:
                self.lock()
                try:
                    run_git(self.repo, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
                except SafetyError:
                    raise SafetyError("origin_main_fetch_failed") from None
                report["origin_main_freshly_fetched"] = True
            self.origin_head = os.fsdecode(run_git(self.repo, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}")).strip()
            report["origin_main_head"] = self.origin_head
            self.origin_entries = None
            if not apply:
                report["ref_freshness"] = "cached_ref_only_not_verified"
            for record in registrations(self.repo):
                assessment = self.assess(record)
                if apply and assessment["decision"] == "eligible":
                    assessment = self.retire(assessment)
                report["worktrees"].append(assessment)
        except SafetyError as error:
            report["error"] = str(error)
        except OSError:
            report["error"] = "filesystem_operation_failed"


def subprocess_ancestor(repo: Path, head: str, origin_head: str) -> bool:

    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1")
    try:
        result = subprocess.run(["git", "--no-optional-locks", "-C", str(repo), "merge-base", "--is-ancestor", head, origin_head],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_TIMEOUT_SECONDS, env=env)
    except (OSError, subprocess.TimeoutExpired):
        raise SafetyError("git_unavailable_or_timed_out") from None
    if result.returncode not in (0, 1):
        raise SafetyError("git_operation_failed")
    return result.returncode == 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=COMMAND_DESCRIPTION)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--worktree-root", required=True, type=Path)
    parser.add_argument("--archive-root", required=True, type=Path)
    parser.add_argument("--older-than-days", type=int, default=10)
    parser.add_argument("--protect", type=Path, action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK_PATH)
    parser.add_argument("--min-free-gb", type=float, default=DEFAULT_MIN_FREE_GB)
    args = parser.parse_args(argv)
    try:
        cleanup = Cleanup(args.repo, args.worktree_root, args.archive_root,
                          older_than_days=args.older_than_days, protect=args.protect,
                          lock_path=args.lock, min_free_gb=args.min_free_gb)
        if args.report:
            validate_report_path(args.report, cleanup.archive_root, apply=args.apply)
        report = cleanup.run(apply=args.apply, report_path=args.report)
    except SafetyError as error:
        report = {"version": 1, "mode": "apply" if args.apply else "dry-run", "error": str(error), "worktrees": []}
    except OSError:
        report = {"version": 1, "mode": "apply" if args.apply else "dry-run", "error": "filesystem_operation_failed", "worktrees": []}
    print(json.dumps(report, ensure_ascii=True, sort_keys=True, indent=2))
    return 1 if report.get("error") or any(item.get("reason") == "removed_receipt_completion_failed" for item in report["worktrees"]) else 0


if __name__ == "__main__":
    sys.exit(main())
