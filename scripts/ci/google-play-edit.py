#!/usr/bin/env python3
"""Validated Google Play edit transactions for Android release workflows."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
import tempfile
import urllib.parse
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

API_HOST = "androidpublisher.googleapis.com"
TRANSPORT_TIMEOUT_SECONDS = 300
MAX_RESPONSE_BYTES = 1_048_576
PACKAGE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$")
EDIT_ID_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
TRACK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
LOCALE_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,8})?$")
IMAGE_TYPES = {
    "featureGraphic",
    "icon",
    "phoneScreenshots",
    "sevenInchScreenshots",
    "tenInchScreenshots",
    "tvBanner",
    "tvScreenshots",
    "wearScreenshots",
}
RELEASE_STATUSES = {"completed", "draft", "halted", "inProgress"}
MAX_VERSION_CODE = 2_100_000_000


class GooglePlayApiError(RuntimeError):
    """The Android Publisher API rejected a known request."""


class CommitOutcomeUnknown(RuntimeError):
    """A commit request lost its response, so retrying could duplicate publication."""


def _redact_secrets(text: str, token: str | None = None) -> str:
    secret = token if token is not None else os.environ.get("GOOGLE_PLAY_ACCESS_TOKEN", "")
    return text.replace(secret, "[REDACTED]") if secret else text


class Transport(Protocol):
    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: object | None = None,
        data_path: Path | None = None,
        content_type: str | None = None,
    ) -> object: ...


class GooglePlayTransport:
    """Fixed-origin Android Publisher transport with environment-only auth."""

    def __init__(self) -> None:
        token = os.environ.get("GOOGLE_PLAY_ACCESS_TOKEN", "")
        if not token:
            raise ValueError("GOOGLE_PLAY_ACCESS_TOKEN is required")
        self._token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: object | None = None,
        data_path: Path | None = None,
        content_type: str | None = None,
    ) -> object:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Google Play request paths must be origin-relative")
        if json_body is not None and data_path is not None:
            raise ValueError("A request cannot contain both JSON and binary data")

        body: object | None = None
        opened_file = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "Mindwtr-Google-Play-Release/1",
        }
        if json_body is not None:
            body = json.dumps(json_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif data_path is not None:
            content_length = data_path.stat().st_size
            opened_file = data_path.open("rb")
            body = opened_file
            headers["Content-Length"] = str(content_length)
        if content_type is not None:
            headers["Content-Type"] = content_type

        connection = None
        try:
            connection = http.client.HTTPSConnection(
                API_HOST,
                timeout=TRANSPORT_TIMEOUT_SECONDS,
            )
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            try:
                status = response.status
                reason = str(response.reason or "").strip()
                response_body = response.read(MAX_RESPONSE_BYTES + 1)
            finally:
                response.close()

            if len(response_body) > MAX_RESPONSE_BYTES:
                raise GooglePlayApiError(
                    f"Google Play API {method} {path} response exceeded "
                    f"{MAX_RESPONSE_BYTES} bytes"
                )
            if not 200 <= status < 300:
                detail = response_body.decode("utf-8", errors="replace").strip()
                status_text = f"HTTP {status}" + (f" {reason}" if reason else "")
                suffix = f": {detail}" if detail else ""
                raise GooglePlayApiError(
                    _redact_secrets(
                        f"Google Play API {method} {path} failed with "
                        f"{status_text}{suffix}",
                        self._token,
                    )
                )
        finally:
            if opened_file is not None:
                opened_file.close()
            if connection is not None:
                connection.close()

        if not response_body:
            return {}
        try:
            return json.loads(response_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GooglePlayApiError(
                f"Google Play API {method} {path} returned invalid JSON"
            ) from error


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _sequence(value: object, label: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(f"{label} must be a JSON array")
    return value


def _string(value: object, label: str, *, maximum: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if maximum is not None and len(normalized) > maximum:
        raise ValueError(f"{label} exceeds {maximum} characters")
    return normalized


def _package_name(value: object) -> str:
    package_name = _string(value, "package", maximum=255)
    if not PACKAGE_RE.fullmatch(package_name):
        raise ValueError(f"Invalid Google Play package name: {package_name}")
    return package_name


def _version_code(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
    elif isinstance(value, int):
        parsed = value
    else:
        raise ValueError(f"{label} must be an integer")
    if parsed < 1 or parsed > MAX_VERSION_CODE:
        raise ValueError(f"{label} must be between 1 and {MAX_VERSION_CODE}")
    return parsed


def _locale(value: object, label: str) -> str:
    locale = _string(value, label, maximum=32)
    if not LOCALE_RE.fullmatch(locale):
        raise ValueError(f"Invalid Google Play locale: {locale}")
    return locale


def _regular_nonempty_file(value: object, label: str) -> Path:
    path = Path(_string(value, label))
    if not path.is_file():
        raise ValueError(f"Missing {label}: {path}")
    if path.stat().st_size == 0:
        raise ValueError(f"Empty {label}: {path}")
    return path


def _validate_release_notes(value: object, label: str) -> list[dict[str, str]]:
    if value is None:
        return []
    notes = []
    seen_locales: set[str] = set()
    for index, item in enumerate(_sequence(value, label)):
        note = _mapping(item, f"{label}[{index}]")
        language = _locale(note.get("language"), f"{label}[{index}].language")
        text = _string(note.get("text"), f"{label}[{index}].text", maximum=500)
        if language in seen_locales:
            raise ValueError(f"Duplicate release-note locale: {language}")
        seen_locales.add(language)
        notes.append({"language": language, "text": text})
    return notes


def _validate_tracks(value: object) -> list[dict[str, object]]:
    tracks = []
    seen_tracks: set[str] = set()
    for index, item in enumerate(_sequence(value, "tracks")):
        track_plan = _mapping(item, f"tracks[{index}]")
        track = _string(track_plan.get("track"), f"tracks[{index}].track", maximum=100)
        if not TRACK_RE.fullmatch(track) or track == "none":
            raise ValueError(f"Invalid Google Play track name: {track}")
        if track in seen_tracks:
            raise ValueError(f"Duplicate Google Play track: {track}")
        seen_tracks.add(track)

        name = _string(track_plan.get("name"), f"tracks[{index}].name", maximum=100)
        status = _string(track_plan.get("status"), f"tracks[{index}].status")
        if status not in RELEASE_STATUSES:
            raise ValueError(f"Invalid Google Play release status: {status}")

        release: dict[str, object] = {"name": name, "status": status}
        fraction = track_plan.get("userFraction")
        if fraction is not None:
            if isinstance(fraction, bool) or not isinstance(fraction, (int, float)):
                raise ValueError(f"tracks[{index}].userFraction must be a number")
            if not 0 < float(fraction) < 1:
                raise ValueError(f"tracks[{index}].userFraction must be between 0 and 1")
            release["userFraction"] = fraction
        elif status == "inProgress":
            raise ValueError(f"tracks[{index}].userFraction is required for inProgress")

        release_notes = _validate_release_notes(
            track_plan.get("releaseNotes"), f"tracks[{index}].releaseNotes"
        )
        if release_notes:
            release["releaseNotes"] = release_notes
        tracks.append({"track": track, "release": release})

    if not tracks:
        raise ValueError("At least one Google Play track is required")
    return tracks


def _validate_assets(value: object) -> list[dict[str, object]]:
    if value is None:
        return []
    assets = []
    for index, item in enumerate(_sequence(value, "listingAssets")):
        asset = _mapping(item, f"listingAssets[{index}]")
        language = _locale(asset.get("language"), f"listingAssets[{index}].language")
        image_type = _string(
            asset.get("imageType"), f"listingAssets[{index}].imageType", maximum=64
        )
        if image_type not in IMAGE_TYPES:
            raise ValueError(f"Invalid Google Play image type: {image_type}")
        path = _regular_nonempty_file(asset.get("path"), "Google Play listing asset")
        extension = path.suffix.lower()
        if extension not in {".png", ".jpg", ".jpeg"}:
            raise ValueError(f"Unsupported Google Play listing asset type: {path}")
        assets.append(
            {
                "language": language,
                "imageType": image_type,
                "path": path,
                "contentType": "image/png" if extension == ".png" else "image/jpeg",
            }
        )
    return assets


def _validate_listings(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    listings = []
    seen_locales: set[str] = set()
    for index, item in enumerate(_sequence(value, "listings")):
        listing = _mapping(item, f"listings[{index}]")
        language = _locale(listing.get("language"), f"listings[{index}].language")
        if language in seen_locales:
            raise ValueError(f"Duplicate Google Play listing locale: {language}")
        seen_locales.add(language)
        listings.append(
            {
                "language": language,
                "title": _string(listing.get("title"), f"listings[{index}].title", maximum=30),
                "shortDescription": _string(
                    listing.get("shortDescription"),
                    f"listings[{index}].shortDescription",
                    maximum=80,
                ),
                "fullDescription": _string(
                    listing.get("fullDescription"),
                    f"listings[{index}].fullDescription",
                    maximum=4000,
                ),
            }
        )
    return listings


def _validated_plan(value: object) -> dict[str, object]:
    plan = _mapping(value, "publish plan")
    return {
        "package": _package_name(plan.get("package")),
        "artifactPath": _regular_nonempty_file(plan.get("artifactPath"), "AAB artifact"),
        "expectedVersionCode": _version_code(
            plan.get("expectedVersionCode"), "expectedVersionCode"
        ),
        "tracks": _validate_tracks(plan.get("tracks")),
        "listingAssets": _validate_assets(plan.get("listingAssets")),
        "listings": _validate_listings(plan.get("listings")),
    }


def _component(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _edit_root(package_name: str, edit_id: str | None = None) -> str:
    root = f"/androidpublisher/v3/applications/{_component(package_name)}/edits"
    return root if edit_id is None else f"{root}/{_component(edit_id)}"


def _edit_id(response: object) -> str:
    edit_id = _string(_mapping(response, "edit response").get("id"), "edit id", maximum=255)
    if not EDIT_ID_RE.fullmatch(edit_id):
        raise GooglePlayApiError("Google Play returned an invalid edit id")
    return edit_id


def _cleanup_edit(package_name: str, edit_id: str, transport: Transport) -> None:
    transport.request("DELETE", _edit_root(package_name, edit_id))


def _cleanup_after_failure(
    package_name: str,
    edit_id: str,
    transport: Transport,
    primary: BaseException,
) -> None:
    try:
        _cleanup_edit(package_name, edit_id, transport)
    except Exception as cleanup_error:
        primary.add_note(
            _redact_secrets(
                f"Google Play edit cleanup also failed: {cleanup_error}"
            )
        )


def read_max_version_code(package_name: str, transport: Transport) -> int:
    """Return the highest version code visible across all tracks."""

    validated_package = _package_name(package_name)
    edit_id = _edit_id(transport.request("POST", _edit_root(validated_package), json_body={}))
    try:
        response = _mapping(
            transport.request("GET", f"{_edit_root(validated_package, edit_id)}/tracks"),
            "tracks response",
        )
        maximum = 0
        for track_index, track_value in enumerate(_sequence(response.get("tracks", []), "tracks")):
            track = _mapping(track_value, f"tracks[{track_index}]")
            for release_index, release_value in enumerate(
                _sequence(track.get("releases", []), f"tracks[{track_index}].releases")
            ):
                release = _mapping(
                    release_value, f"tracks[{track_index}].releases[{release_index}]"
                )
                for code_index, code in enumerate(
                    _sequence(
                        release.get("versionCodes", []),
                        f"tracks[{track_index}].releases[{release_index}].versionCodes",
                    )
                ):
                    maximum = max(
                        maximum,
                        _version_code(
                            code,
                            f"tracks[{track_index}].releases[{release_index}].versionCodes[{code_index}]",
                        ),
                    )
    except Exception as primary:
        _cleanup_after_failure(validated_package, edit_id, transport, primary)
        raise

    _cleanup_edit(validated_package, edit_id, transport)
    return maximum


def publish_release(plan: object, transport: Transport) -> dict[str, object]:
    """Validate and publish one AAB and all requested mutations in one edit."""

    validated = _validated_plan(plan)
    package_name = str(validated["package"])
    artifact_path = validated["artifactPath"]
    expected_version_code = int(validated["expectedVersionCode"])
    tracks = validated["tracks"]
    assets = validated["listingAssets"]
    listings = validated["listings"]

    edit_id = _edit_id(transport.request("POST", _edit_root(package_name), json_body={}))
    try:
        upload_path = (
            f"/upload/androidpublisher/v3/applications/{_component(package_name)}"
            f"/edits/{_component(edit_id)}/bundles?uploadType=media"
        )
        upload_response = _mapping(
            transport.request(
                "POST",
                upload_path,
                data_path=artifact_path,
                content_type="application/octet-stream",
            ),
            "bundle upload response",
        )
        version_code = _version_code(upload_response.get("versionCode"), "uploaded versionCode")
        if version_code != expected_version_code:
            raise GooglePlayApiError(
                "Google Play uploaded versionCode "
                f"{version_code}, expected {expected_version_code}"
            )

        cleared_asset_groups: set[tuple[str, str]] = set()
        for asset in assets:
            language = str(asset["language"])
            image_type = str(asset["imageType"])
            group = (language, image_type)
            listing_path = (
                f"{_edit_root(package_name, edit_id)}/listings/"
                f"{_component(language)}/{_component(image_type)}"
            )
            if group not in cleared_asset_groups:
                transport.request("DELETE", listing_path)
                cleared_asset_groups.add(group)
            transport.request(
                "POST",
                "/upload" + listing_path + "?uploadType=media",
                data_path=asset["path"],
                content_type=str(asset["contentType"]),
            )

        for listing in listings:
            language = listing["language"]
            transport.request(
                "PUT",
                f"{_edit_root(package_name, edit_id)}/listings/{_component(language)}",
                json_body=listing,
            )

        published_tracks = []
        for track_plan in tracks:
            track = str(track_plan["track"])
            release = dict(track_plan["release"])
            release["versionCodes"] = [str(version_code)]
            transport.request(
                "PUT",
                f"{_edit_root(package_name, edit_id)}/tracks/{_component(track)}",
                json_body={"track": track, "releases": [release]},
            )
            published_tracks.append(track)

        try:
            transport.request("POST", f"{_edit_root(package_name, edit_id)}:commit")
        except GooglePlayApiError:
            raise
        except (OSError, http.client.HTTPException) as error:
            raise CommitOutcomeUnknown(
                "Google Play edit commit outcome is unknown; do not retry automatically"
            ) from error
    except Exception as primary:
        _cleanup_after_failure(package_name, edit_id, transport, primary)
        raise

    return {
        "package": package_name,
        "editId": edit_id,
        "versionCode": version_code,
        "tracks": published_tracks,
        "committed": True,
    }


def _load_json(path: Path, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"Unable to read {label} {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {label} {path}: {error}") from error


def _write_result(path: Path, result: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            json.dump(result, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    maximum = subparsers.add_parser("max-version-code")
    maximum.add_argument("--package", required=True)
    maximum.add_argument("--result", required=True, type=Path)

    publish = subparsers.add_parser("publish")
    publish.add_argument("--plan", required=True, type=Path)
    publish.add_argument("--result", required=True, type=Path)
    return parser


def _format_error(error: BaseException) -> str:
    lines = [str(error)]
    lines.extend(
        f"Secondary: {note}"
        for note in getattr(error, "__notes__", [])
    )
    return _redact_secrets("\n".join(lines))


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if not os.environ.get("GOOGLE_PLAY_ACCESS_TOKEN"):
            raise ValueError("GOOGLE_PLAY_ACCESS_TOKEN is required")
        transport = GooglePlayTransport()
        if args.command == "max-version-code":
            maximum = read_max_version_code(args.package, transport)
            result = {"package": args.package, "maxVersionCode": maximum}
        else:
            result = publish_release(_load_json(args.plan, "publish plan"), transport)
    except Exception as error:
        print(f"Google Play release failed: {_format_error(error)}", file=sys.stderr)
        return 1

    try:
        _write_result(args.result, result)
    except Exception as error:
        completed_operation = (
            "publication" if args.command == "publish" else "version lookup"
        )
        print(
            f"Google Play {completed_operation} succeeded, but recording the local "
            f"result failed: {_format_error(error)}",
            file=sys.stderr,
        )
        return 1

    if args.command == "max-version-code":
        print(f"Highest Google Play versionCode: {result['maxVersionCode']}")
    else:
        print(
            f"Published versionCode {result['versionCode']} to "
            f"{', '.join(result['tracks'])}."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
