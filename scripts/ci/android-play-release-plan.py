#!/usr/bin/env python3
from __future__ import annotations
COMMAND_DESCRIPTION = """Resolve Android Play tracks and build a single-artifact publication plan."""


import argparse
import json
import math
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

TRACK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
STABLE_TRACKS = ("production", "beta", "internal")
ROLLOUT_MODES = {"staged", "immediate"}


def resolve_rollout(
    rollout_mode: str,
    rollout_percentage: float,
) -> tuple[str, float | None]:

    mode = rollout_mode.strip().lower()
    if mode not in ROLLOUT_MODES:
        raise ValueError("Google Play rollout mode must be staged or immediate")
    if mode == "immediate":
        return mode, None
    if isinstance(rollout_percentage, bool) or not isinstance(
        rollout_percentage, (int, float)
    ):
        raise ValueError("Google Play rollout percentage must be a number")
    percentage = float(rollout_percentage)
    if not math.isfinite(percentage):
        raise ValueError("Google Play rollout percentage must be finite")
    if not 0 < percentage < 100:
        raise ValueError("Google Play staged rollout percentage must be between 0 and 100")
    return mode, percentage / 100


def resolve_tracks(
    play_tracks: str,
    *,
    internal_test_release: bool,
    stable_production_tag: bool,
) -> list[str]:

    if internal_test_release:
        return ["internal"]

    requested = play_tracks.strip() or "production"
    tracks: list[str] = []
    for raw_track in requested.split(","):
        track = raw_track.strip()
        if not track:
            continue
        if not TRACK_RE.fullmatch(track):
            raise ValueError(f"Invalid Google Play track: {track!r}")
        if track not in tracks:
            tracks.append(track)

    if not tracks:
        raise ValueError("At least one Google Play track or none is required")
    if "none" in tracks:
        if tracks != ["none"]:
            raise ValueError("Google Play track none cannot be combined with other tracks")
        return []
    if "production" in tracks and tracks != ["production"]:
        raise ValueError(
            "Google Play production cannot be combined with testing tracks; "
            "stable tag publication expands production automatically"
        )
    if stable_production_tag and tracks == ["production"]:
        return list(STABLE_TRACKS)
    return tracks


def _read_json_array(path_value: str | None) -> list[object]:
    if not path_value:
        return []
    path = Path(path_value)
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"Expected a JSON array in {path}")
    return value


def _read_release_notes(directory: str | None) -> list[dict[str, str]]:
    if not directory:
        return []
    notes_path = Path(directory)
    if not notes_path.is_dir():
        return []
    notes = []
    for path in sorted(notes_path.glob("whatsnew-*")):
        text = path.read_text(encoding="utf-8").strip()
        if text:
            notes.append(
                {
                    "language": path.name.replace("whatsnew-", "", 1),
                    "text": text,
                }
            )
    return notes


def build_plan(
    *,
    package: str,
    artifact_path: str,
    expected_version_code: int,
    version: str,
    tracks: Sequence[str],
    stable_production: bool,
    rollout_mode: str = "staged",
    rollout_percentage: float = 5,
    testing_release_notes: str = "",
    stable_release_notes_directory: str | None = None,
    listing_assets_file: str | None = None,
    listings_file: str | None = None,
) -> dict[str, Any]:

    normalized_rollout_mode, rollout_fraction = resolve_rollout(
        rollout_mode,
        rollout_percentage,
    )

    unique_tracks = list(dict.fromkeys(tracks))
    if not unique_tracks:
        raise ValueError("No Google Play tracks were configured")
    for track in unique_tracks:
        if not TRACK_RE.fullmatch(track) or track == "none":
            raise ValueError(f"Invalid Google Play publication track: {track!r}")

    if stable_production:
        if unique_tracks != list(STABLE_TRACKS):
            raise ValueError(
                "Stable production publication must target production,beta,internal"
            )
    elif "production" in unique_tracks:
        raise ValueError("Production requires a stable tagged publication")

    releases: list[dict[str, object]] = []
    stable_notes = _read_release_notes(stable_release_notes_directory)
    for track in unique_tracks:
        if stable_production:
            suffix = "" if track == "production" else f" stable {track}"
            release: dict[str, object] = {
                "track": track,
                "name": f"{version}{suffix}",
                "status": "completed",
            }
            if track == "production" and normalized_rollout_mode == "staged":
                release["status"] = "inProgress"
                release["userFraction"] = rollout_fraction
            if track == "production" and stable_notes:
                release["releaseNotes"] = stable_notes
        else:
            release = {
                "track": track,
                "name": f"{version} testing",
                "status": "completed",
            }
            notes = testing_release_notes.strip()
            if notes:
                release["releaseNotes"] = [{"language": "en-US", "text": notes}]
        releases.append(release)

    plan: dict[str, Any] = {
        "package": package,
        "artifactPath": artifact_path,
        "expectedVersionCode": expected_version_code,
        "tracks": releases,
    }
    if stable_production:
        plan["listingAssets"] = _read_json_array(listing_assets_file)
        plan["listings"] = _read_json_array(listings_file)
    return plan


def _parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    raise argparse.ArgumentTypeError(f"Expected a boolean, got {value!r}")


def _resolve_command(args: argparse.Namespace) -> int:
    rollout_mode, _ = resolve_rollout(
        args.rollout_mode,
        args.rollout_percentage,
    )
    tracks = resolve_tracks(
        args.play_tracks,
        internal_test_release=args.internal_test_release,
        stable_production_tag=args.stable_production_tag,
    )
    rendered = ",".join(tracks) if tracks else "none"
    output = Path(args.github_output)
    with output.open("a", encoding="utf-8") as stream:
        stream.write(f"play_tracks={rendered}\n")
        stream.write(f"has_internal={'true' if 'internal' in tracks else 'false'}\n")
        stream.write(f"publishes_production={'true' if 'production' in tracks else 'false'}\n")
        stream.write(
            f"stable_production_tag={'true' if args.stable_production_tag else 'false'}\n"
        )
        stream.write(f"rollout_mode={rollout_mode}\n")
        stream.write(f"rollout_percentage={args.rollout_percentage:g}\n")
    print(f"Google Play track(s): {rendered}")
    return 0


def _plan_command(args: argparse.Namespace) -> int:
    tracks = [track.strip() for track in args.tracks.split(",") if track.strip()]
    plan = build_plan(
        package=args.package,
        artifact_path=args.artifact,
        expected_version_code=args.expected_version_code,
        version=args.version,
        tracks=tracks,
        stable_production=args.stable_production,
        rollout_mode=args.rollout_mode,
        rollout_percentage=args.rollout_percentage,
        testing_release_notes=args.testing_release_notes,
        stable_release_notes_directory=args.stable_release_notes_directory,
        listing_assets_file=args.listing_assets_file,
        listings_file=args.listings_file,
    )
    Path(args.output).write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=COMMAND_DESCRIPTION)
    commands = parser.add_subparsers(dest="command", required=True)

    resolve = commands.add_parser("resolve-tracks")
    resolve.add_argument("--play-tracks", default="production")
    resolve.add_argument("--internal-test-release", type=_parse_bool, default=False)
    resolve.add_argument("--stable-production-tag", type=_parse_bool, default=False)
    resolve.add_argument("--rollout-mode", default="staged")
    resolve.add_argument("--rollout-percentage", type=float, default=5)
    resolve.add_argument("--github-output", required=True)
    resolve.set_defaults(handler=_resolve_command)

    plan = commands.add_parser("create-plan")
    plan.add_argument("--output", required=True)
    plan.add_argument("--package", required=True)
    plan.add_argument("--artifact", required=True)
    plan.add_argument("--expected-version-code", required=True, type=int)
    plan.add_argument("--version", required=True)
    plan.add_argument("--tracks", required=True)
    plan.add_argument("--stable-production", action="store_true")
    plan.add_argument("--rollout-mode", default="staged")
    plan.add_argument("--rollout-percentage", type=float, default=5)
    plan.add_argument("--testing-release-notes", default="")
    plan.add_argument("--stable-release-notes-directory")
    plan.add_argument("--listing-assets-file")
    plan.add_argument("--listings-file")
    plan.set_defaults(handler=_plan_command)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return args.handler(args)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    raise SystemExit(main())
