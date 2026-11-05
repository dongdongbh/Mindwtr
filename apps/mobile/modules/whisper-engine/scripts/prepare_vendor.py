#!/usr/bin/env python3
"""Stage the installed, locked Whisper binary without fetching or replacing data."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.5.4"
KNOWN_HASHES = {
    "ios-arm64/rnwhisper.framework/rnwhisper": "8c75cb6807780de7047b256e12bd9a5dedb04d18b22d82aafc2b3c2dd845fd96",
    "ios-arm64_x86_64-simulator/rnwhisper.framework/rnwhisper": "fb853d73f2c3b526a371bb8fb8291f94e00d3d97eb95ef197fcec850507fb44a",
    "ios-arm64/rnwhisper.framework/Headers/whisper.h": "b9d85a5bb758dd1b5fba0cc28af6e4f98298bb00fb62b7a6df8a26cc7be3ef1c",
    "ios-arm64/rnwhisper.framework/ggml-metal.metal": "a1eca77b83f69c5ce8b3e01ecb3f9c12674f60d24058992f6b04eed5861af1e4",
}
MODULE_MAP = b'framework module rnwhisper {\n    header "whisper.h"\n    export *\n    link framework "rnwhisper"\n}\n'


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def manifest(root, exclude=()):
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative in exclude:
            continue
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Whisper inputs must contain only regular files and directories")
        result[relative] = {"sha256": digest(path), "bytes": path.stat().st_size} if path.is_file() else {"directory": True}
    return result


def prepare(installed, destination):
    installed = installed.resolve(strict=True)
    package_file = installed / "package.json"
    package = json.loads(package_file.read_text())
    if package.get("name") != "whisper.rn" or package.get("version") != VERSION:
        raise ValueError("Expected the locked whisper.rn@0.5.4 package")
    framework = installed / "ios/rnwhisper.xcframework"
    inputs = manifest(framework)
    for name, expected in KNOWN_HASHES.items():
        if inputs.get(name, {}).get("sha256") != expected:
            raise ValueError("Whisper binary/header/resource hash does not match the pinned input: " + name)
    if any(name.endswith(".modulemap") for name in inputs):
        raise ValueError("Pinned Whisper input unexpectedly already has a module map")
    license_file = installed / "LICENSE"
    if license_file.is_symlink() or not license_file.is_file() or b"MIT License" not in license_file.read_bytes():
        raise ValueError("Whisper package MIT license is missing")
    package_hash, license_hash = digest(package_file), digest(license_file)
    stage = Path(tempfile.mkdtemp(prefix=".vendor-stage-", dir=destination.parent))
    try:
        copied = stage / "rnwhisper.xcframework"
        shutil.copytree(framework, copied)
        shutil.copyfile(license_file, stage / "LICENSE.whisper.rn")
        if manifest(copied) != inputs or digest(stage / "LICENSE.whisper.rn") != license_hash or digest(package_file) != package_hash:
            raise ValueError("Whisper input changed while staging")
        frameworks = sorted(copied.glob("*/rnwhisper.framework"))
        if not frameworks:
            raise ValueError("Whisper input has no framework slices")
        for bundle in frameworks:
            if not (bundle / "Headers/whisper.h").is_file():
                raise ValueError("Whisper slice is missing its public C header")
            modules = bundle / "Modules"
            modules.mkdir()
            (modules / "module.modulemap").write_bytes(MODULE_MAP)
        provenance = {
            "schemaVersion": 1,
            "sourcePackage": "whisper.rn@" + VERSION,
            "sourcePackageJSONSHA256": package_hash,
            "sourceLicenseSHA256": license_hash,
            "inputFramework": inputs,
            "transformation": "Copy complete framework and MIT license; add only the C whisper.h framework module map to every slice.",
            "output": manifest(stage),
        }
        encoded = (json.dumps(provenance, indent=2, sort_keys=True) + "\n").encode()
        (stage / "provenance.json").write_bytes(encoded)
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or not destination.is_dir() or (destination / "provenance.json").is_symlink():
                raise ValueError("Existing Vendor is not a verified directory; refusing replacement")
            if not (destination / "provenance.json").is_file() or (destination / "provenance.json").read_bytes() != encoded:
                raise ValueError("Existing Vendor provenance differs; refusing replacement")
            if manifest(destination, exclude=("provenance.json",)) != provenance["output"]:
                raise ValueError("Existing Vendor content differs; refusing replacement")
            return hashlib.sha256(encoded).hexdigest(), "verified reuse"
        stage.rename(destination)
        return hashlib.sha256(encoded).hexdigest(), "prepared"
    finally:
        # Only the unique staging directory created by this invocation is disposable.
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed_package", type=Path)
    args = parser.parse_args()
    try:
        with (PACKAGE_ROOT / ".prepare.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            sha256, outcome = prepare(args.installed_package, PACKAGE_ROOT / "Vendor")
        print(f"{outcome}: Vendor/rnwhisper.xcframework; provenance SHA256={sha256}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Whisper preparation refused: {error}\n")


if __name__ == "__main__":
    main()
