#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_LANGUAGE = "en-US"
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg"}
GOOGLE_PLAY_IMAGE_CONSTRAINTS = {
    "tenInchScreenshots": {
        "min_side": 1080,
        "max_side": 7680,
        "max_aspect_ratio": 2.3,
    },
}
TYPE_ALIASES = {
    "phone": ("phoneScreenshots",),
    "phones": ("phoneScreenshots",),
    "phonescreenshots": "phoneScreenshots",
    "phone-screenshots": "phoneScreenshots",
    "phone_screenshots": "phoneScreenshots",
    "pad": ("sevenInchScreenshots",),
    "pads": ("sevenInchScreenshots",),
    "tablet": ("sevenInchScreenshots",),
    "tablets": ("sevenInchScreenshots",),
    "seveninchscreenshots": "sevenInchScreenshots",
    "seven-inch-screenshots": "sevenInchScreenshots",
    "seven_inch_screenshots": "sevenInchScreenshots",
    "teninchscreenshots": "tenInchScreenshots",
    "ten-inch-screenshots": "tenInchScreenshots",
    "ten_inch_screenshots": "tenInchScreenshots",
    "tvscreenshots": "tvScreenshots",
    "tv-screenshots": "tvScreenshots",
    "tv_screenshots": "tvScreenshots",
    "wearscreenshots": "wearScreenshots",
    "wear-screenshots": "wearScreenshots",
    "wear_screenshots": "wearScreenshots",
    "icon": "icon",
    "featuregraphic": "featureGraphic",
    "feature-graphic": "featureGraphic",
    "feature_graphic": "featureGraphic",
    "tvbanner": "tvBanner",
    "tv-banner": "tvBanner",
    "tv_banner": "tvBanner",
}


def normalize_image_types(name: str) -> tuple[str, ...]:
    image_types = TYPE_ALIASES.get(name.strip().lower())
    if image_types is None:
        return ()
    if isinstance(image_types, str):
        return (image_types,)
    return image_types


def image_files(path: Path) -> list[Path]:
    return sorted(
        file
        for file in path.iterdir()
        if file.is_file() and file.suffix.lower() in ALLOWED_EXTENSIONS
    )


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    png_signature = b"\x89PNG\r\n\x1a\n"
    if not data.startswith(png_signature):
        return None
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return width, height


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None

    offset = 2
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }

    while offset < len(data):
        while offset < len(data) and data[offset] != 0xFF:
            offset += 1
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None

        marker = data[offset]
        offset += 1
        if marker in {0x01, *range(0xD0, 0xD9)}:
            continue
        if marker in {0xD9, 0xDA}:
            return None
        if offset + 2 > len(data):
            return None

        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2:
            return None
        segment_start = offset + 2
        segment_end = offset + segment_length
        if segment_end > len(data):
            return None

        if marker in sof_markers:
            if segment_start + 5 > segment_end:
                return None
            height = int.from_bytes(data[segment_start + 1 : segment_start + 3], "big")
            width = int.from_bytes(data[segment_start + 3 : segment_start + 5], "big")
            return width, height

        offset = segment_end

    return None


def image_dimensions(file: Path) -> tuple[int, int] | None:
    data = file.read_bytes()
    return png_dimensions(data) or jpeg_dimensions(data)


def satisfies_google_play_constraints(dimensions: tuple[int, int], constraints: dict[str, float]) -> bool:
    width, height = dimensions
    min_side = min(width, height)
    max_side = max(width, height)
    aspect_ratio = max_side / min_side
    return (
        min_side >= constraints["min_side"]
        and max_side <= constraints["max_side"]
        and aspect_ratio <= constraints["max_aspect_ratio"]
    )


def prepared_google_play_asset(
    file: Path,
    image_type: str,
) -> Path | None:
    constraints = GOOGLE_PLAY_IMAGE_CONSTRAINTS.get(image_type)
    if constraints is None:
        return file

    dimensions = image_dimensions(file)
    if dimensions is None:
        print(f"Skipping {file}: unable to read dimensions for {image_type}", file=sys.stderr)
        return None

    if satisfies_google_play_constraints(dimensions, constraints):
        return file

    width, height = dimensions
    aspect_ratio = max(width, height) / min(width, height)
    if aspect_ratio > constraints["max_aspect_ratio"]:
        print(
            f"Skipping {file} for {image_type}: {width}x{height} outside Google Play limits",
            file=sys.stderr,
        )
        return None

    print(
        f"Skipping {file} for {image_type}: {width}x{height} outside Google Play limits",
        file=sys.stderr,
    )
    return None


def add_assets(
    assets: list[dict[str, str]],
    language: str,
    image_type: str,
    files: list[Path],
) -> None:
    for file in files:
        asset_path = prepared_google_play_asset(file, image_type)
        if asset_path is None:
            continue
        assets.append(
            {
                "language": language,
                "imageType": image_type,
                "path": asset_path.as_posix(),
            }
        )


def collect_assets(root: Path) -> list[dict[str, str]]:
    if not root.is_dir():
        return []

    assets: list[dict[str, str]] = []

    direct_root_files = image_files(root)
    if direct_root_files:
        add_assets(assets, DEFAULT_LANGUAGE, "phoneScreenshots", direct_root_files)

    for child in sorted(path for path in root.iterdir() if path.is_dir()):
        root_image_types = normalize_image_types(child.name)
        if root_image_types:
            files = image_files(child)
            for root_image_type in root_image_types:
                add_assets(assets, DEFAULT_LANGUAGE, root_image_type, files)
            continue

        locale = child.name
        locale_root_files = image_files(child)
        if locale_root_files:
            add_assets(assets, locale, "phoneScreenshots", locale_root_files)

        for grandchild in sorted(path for path in child.iterdir() if path.is_dir()):
            image_types = normalize_image_types(grandchild.name)
            if image_types:
                files = image_files(grandchild)
                for image_type in image_types:
                    add_assets(assets, locale, image_type, files)

    return assets


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "Usage: prepare-google-play-listing-assets.py <source-dir> <output-json>",
            file=sys.stderr,
        )
        return 1

    source_dir = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    assets = collect_assets(source_dir)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(assets, indent=2) + "\n", encoding="utf-8")

    if assets:
        grouped: dict[tuple[str, str], int] = {}
        for asset in assets:
            key = (asset["language"], asset["imageType"])
            grouped[key] = grouped.get(key, 0) + 1
        for (language, image_type), count in sorted(grouped.items()):
            print(f"{language} {image_type}: {count}")
    else:
        print("No Google Play listing assets found.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
