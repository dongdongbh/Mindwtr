#!/usr/bin/env python3
"""Check actual resolved Nano dependencies and the merged app manifest."""
import argparse
import re
from pathlib import Path
import xml.etree.ElementTree as ET


def validate(mode: str, dependencies: str, min_sdk: int) -> None:
    if "FAILED" in dependencies:
        raise ValueError("Dependency resolution failed")
    resolved = re.findall(r"com\.google\.mlkit:genai-prompt:([^\s]+)(?: -> ([^\s]+))?", dependencies)
    has_sdk = bool(resolved) and all((replacement or requested) == "1.0.0-beta4" for requested, replacement in resolved)
    has_genai = "com.google.mlkit:genai-" in dependencies
    if mode == "enabled":
        if not has_sdk or min_sdk != 26:
            raise ValueError("Evaluation must resolve the pinned Prompt API and require API 26")
    elif has_genai or min_sdk != 24:
        raise ValueError("Default/FOSS builds must omit GenAI and retain API 24")


def validate_runtime(dependencies: str) -> None:
    for artifact, expected in [
        ("org.jetbrains.kotlin:kotlin-stdlib", "2.3.21"),
        ("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm", "1.11.0"),
        ("org.jetbrains.kotlinx:kotlinx-coroutines-android", "1.11.0"),
        ("org.jetbrains.kotlinx:kotlinx-coroutines-guava", "1.11.0"),
    ]:
        versions = re.findall(re.escape(artifact) + r":(\{[^}]+\}|[^\s]+)(?: -> ([^\s]+))?", dependencies)
        if not versions or any((replacement or requested) != expected for requested, replacement in versions):
            raise ValueError(f"Evaluation app must resolve {artifact}:{expected} for SDK runtime compatibility")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["enabled", "disabled"], required=True)
    parser.add_argument("--dependencies", type=Path, required=True)
    parser.add_argument("--app-dependencies", type=Path, required=True)
    parser.add_argument("--android-dir", type=Path, required=True)
    args = parser.parse_args()
    manifests = list((args.android_dir / "app/build/intermediates/merged_manifest").glob("debug/**/AndroidManifest.xml"))
    if len(manifests) != 1:
        raise ValueError(f"Expected one merged debug app manifest, found {len(manifests)}")
    uses_sdk = ET.parse(manifests[0]).getroot().find("uses-sdk")
    if uses_sdk is None:
        raise ValueError("Merged manifest has no SDK declaration")
    min_sdk = int(uses_sdk.attrib["{http://schemas.android.com/apk/res/android}minSdkVersion"])
    validate(args.mode, args.dependencies.read_text(), min_sdk)
    app_dependencies = args.app_dependencies.read_text()
    validate(args.mode, app_dependencies, min_sdk)
    if args.mode == "enabled":
        validate_runtime(app_dependencies)
    print(f"Nano {args.mode}: resolved dependency boundary and minSdk {min_sdk} passed")


if __name__ == "__main__":
    main()
