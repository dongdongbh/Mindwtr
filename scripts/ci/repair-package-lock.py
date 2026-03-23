#!/usr/bin/env python3
import json
import pathlib
import sys
import urllib.parse
import urllib.request


def package_name_from_path(package_path: str) -> str | None:
    parts = pathlib.PurePosixPath(package_path).parts
    last_name = None
    i = 0
    while i < len(parts):
        if parts[i] != "node_modules":
            i += 1
            continue
        i += 1
        if i >= len(parts):
            break
        name = parts[i]
        if name.startswith("@") and i + 1 < len(parts):
            name = f"{name}/{parts[i + 1]}"
            i += 1
        last_name = name
        i += 1
    return last_name


def fetch_dist(package_name: str, version: str, cache: dict[tuple[str, str], dict[str, str | None]]) -> dict[str, str | None]:
    key = (package_name, version)
    cached = cache.get(key)
    if cached is not None:
        return cached

    encoded_name = urllib.parse.quote(package_name, safe="")
    encoded_version = urllib.parse.quote(version, safe="")
    url = f"https://registry.npmjs.org/{encoded_name}/{encoded_version}"
    with urllib.request.urlopen(url) as response:
        payload = json.load(response)
    dist = payload.get("dist") or {}
    cached = {
        "resolved": dist.get("tarball"),
        "integrity": dist.get("integrity"),
    }
    cache[key] = cached
    return cached


def repair_lock(lock_path: pathlib.Path) -> tuple[int, list[tuple[str, str]]]:
    lock = json.loads(lock_path.read_text())
    missing: list[tuple[str, str]] = []
    dist_cache: dict[tuple[str, str], dict[str, str | None]] = {}
    changed = 0

    for package_path, meta in lock.get("packages", {}).items():
        if not isinstance(meta, dict):
            continue
        if not package_path.startswith("node_modules/") or meta.get("link") or "version" not in meta:
            continue

        resolved = meta.get("resolved")
        integrity = meta.get("integrity")
        if not resolved or not integrity:
            package_name = package_name_from_path(package_path)
            version = meta.get("version")
            if package_name and version:
                dist = fetch_dist(package_name, version, dist_cache)
                if not resolved and dist.get("resolved"):
                    meta["resolved"] = dist["resolved"]
                    resolved = meta["resolved"]
                    changed += 1
                if not integrity and dist.get("integrity"):
                    meta["integrity"] = dist["integrity"]
                    integrity = meta["integrity"]
                    changed += 1

        if not resolved and not integrity:
            missing.append((package_path, "resolved and integrity"))
        elif resolved and not integrity:
            missing.append((package_path, "integrity"))
        elif integrity and not resolved:
            missing.append((package_path, "resolved"))

    if missing:
        return changed, missing

    if changed:
        lock_path.write_text(json.dumps(lock, indent=2) + "\n")
    return changed, []


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {pathlib.Path(sys.argv[0]).name} <package-lock.json>", file=sys.stderr)
        return 1

    lock_path = pathlib.Path(sys.argv[1])
    if not lock_path.is_file():
        print(f"Package-lock file not found: {lock_path}", file=sys.stderr)
        return 1

    changed, missing = repair_lock(lock_path)
    if missing:
        details = "\n".join(f"  - {package_path} is missing {field}" for package_path, field in missing)
        print(
            "Desktop package-lock.json has incomplete npm metadata required for Flathub node source generation:\n"
            + details,
            file=sys.stderr,
        )
        return 1

    if changed:
        print(f"Repaired {changed} package-lock metadata fields in {lock_path}")
    else:
        print(f"Package-lock metadata already complete: {lock_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
