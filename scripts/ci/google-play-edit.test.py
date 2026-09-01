#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

SCRIPT_PATH = Path(__file__).with_name("google-play-edit.py")
SPEC = importlib.util.spec_from_file_location("google_play_edit", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.fail_track = False
        self.fail_cleanup = False
        self.timeout_commit = False
        self.reject_commit = False
        self.uploaded_version_code = "42"
        self.cleanup_message = "cleanup failure"

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: object | None = None,
        data_path: Path | None = None,
        content_type: str | None = None,
    ) -> object:
        self.calls.append(
            {
                "method": method,
                "path": path,
                "json_body": json_body,
                "data_path": data_path,
                "content_type": content_type,
            }
        )
        if method == "POST" and path.endswith("/edits"):
            return {"id": "edit-1"}
        if method == "GET" and path.endswith("/tracks"):
            return {
                "tracks": [
                    {"releases": [{"versionCodes": ["7", "19"]}]},
                    {"releases": [{"versionCodes": ["11"]}]},
                ]
            }
        if method == "POST" and "/bundles?" in path:
            return {"versionCode": self.uploaded_version_code}
        if method == "PUT" and "/tracks/" in path:
            if self.fail_track:
                raise MODULE.GooglePlayApiError("primary track failure")
            return {"track": path.rsplit("/", 1)[-1]}
        if method == "POST" and path.endswith(":commit"):
            if self.timeout_commit:
                raise TimeoutError("commit timed out")
            if self.reject_commit:
                raise MODULE.GooglePlayApiError("commit rejected with HTTP 400")
            return {"id": "edit-1", "expiryTimeSeconds": "1"}
        if method == "DELETE" and path.endswith("/edit-1"):
            if self.fail_cleanup:
                raise MODULE.GooglePlayApiError(self.cleanup_message)
            return {}
        if method == "DELETE" and "/listings/" in path:
            return {}
        if method == "POST" and "/listings/" in path:
            return {"id": "image"}
        if method == "PUT" and "/listings/" in path:
            return json_body or {}
        raise AssertionError(f"Unexpected transport call: {method} {path}")


class FakeHttpResponse:
    def __init__(self, status: int = 200, body: bytes = b"{}", reason: str = "OK") -> None:
        self.status = status
        self.reason = reason
        self.body = body
        self.read_sizes: list[int | None] = []
        self.closed = False

    def read(self, size: int | None = None) -> bytes:
        self.read_sizes.append(size)
        if size is None:
            return self.body
        return self.body[:size]

    def close(self) -> None:
        self.closed = True


class FakeHttpsConnection:
    def __init__(self, response: FakeHttpResponse) -> None:
        self.response = response
        self.requests: list[dict[str, object]] = []
        self.closed = False

    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        recorded_body = body.read() if hasattr(body, "read") else body
        self.requests.append(
            {
                "method": method,
                "path": path,
                "body": recorded_body,
                "headers": headers or {},
            }
        )

    def getresponse(self) -> FakeHttpResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


def make_plan(root: Path) -> dict[str, object]:
    artifact = root / "mindwtr.aab"
    artifact.write_bytes(b"aab-bytes")
    image = root / "phone.png"
    image.write_bytes(b"png-bytes")
    return {
        "package": "tech.dongdongbh.mindwtr",
        "artifactPath": str(artifact),
        "expectedVersionCode": 42,
        "tracks": [
            {
                "track": "production",
                "name": "1.2.6",
                "status": "completed",
                "releaseNotes": [{"language": "en-US", "text": "Stable release"}],
            },
            {
                "track": "beta",
                "name": "1.2.6 stable beta",
                "status": "completed",
            },
        ],
        "listingAssets": [
            {
                "language": "en-US",
                "imageType": "phoneScreenshots",
                "path": str(image),
            }
        ],
        "listings": [
            {
                "language": "en-US",
                "title": "Mindwtr",
                "shortDescription": "A local-first GTD app",
                "fullDescription": "Capture and organize tasks locally.",
            }
        ],
    }


class GooglePlayEditTest(unittest.TestCase):
    def test_transport_uses_one_fixed_host_without_redirects_and_streams_auth_body(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = Path(temp_dir) / "artifact.aab"
            artifact.write_bytes(b"aab-bytes")
            response = FakeHttpResponse()
            connection = FakeHttpsConnection(response)
            with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
                with patch.object(
                    MODULE.http.client,
                    "HTTPSConnection",
                    return_value=connection,
                ) as connection_factory:
                    transport = MODULE.GooglePlayTransport()
                    transport.request(
                        "POST",
                        "/upload/androidpublisher/v3/example",
                        data_path=artifact,
                        content_type="application/octet-stream",
                    )

            request = connection.requests[0]

        self.assertEqual(
            connection_factory.call_args.args,
            ("androidpublisher.googleapis.com",),
        )
        self.assertEqual(connection_factory.call_args.kwargs, {"timeout": 300})
        self.assertEqual(request["path"], "/upload/androidpublisher/v3/example")
        self.assertEqual(request["headers"]["Authorization"], "Bearer top-secret")
        self.assertEqual(request["headers"]["Content-Length"], "9")
        self.assertEqual(request["body"], b"aab-bytes")
        self.assertTrue(connection.closed)
        self.assertTrue(response.closed)
        with self.assertRaisesRegex(ValueError, "origin-relative"):
            transport.request("GET", "https://example.com/not-allowed")

        redirect = FakeHttpResponse(
            status=302,
            body=b"redirect",
            reason="Found",
        )
        redirect_connection = FakeHttpsConnection(redirect)
        with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
            with patch.object(
                MODULE.http.client,
                "HTTPSConnection",
                return_value=redirect_connection,
            ) as redirect_factory:
                with self.assertRaisesRegex(MODULE.GooglePlayApiError, "HTTP 302"):
                    MODULE.GooglePlayTransport().request("GET", "/redirect")

        redirect_factory.assert_called_once_with(
            "androidpublisher.googleapis.com", timeout=300
        )
        self.assertEqual(len(redirect_connection.requests), 1)

    def test_transport_bounds_responses_and_redacts_echoed_tokens(self) -> None:
        oversized = FakeHttpResponse(
            body=b"x" * (MODULE.MAX_RESPONSE_BYTES + 2),
        )
        oversized_connection = FakeHttpsConnection(oversized)
        with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
            with patch.object(
                MODULE.http.client,
                "HTTPSConnection",
                return_value=oversized_connection,
            ):
                with self.assertRaisesRegex(MODULE.GooglePlayApiError, "exceeded"):
                    MODULE.GooglePlayTransport().request("GET", "/oversized")

        self.assertEqual(oversized.read_sizes, [MODULE.MAX_RESPONSE_BYTES + 1])

        echoed_token = FakeHttpResponse(
            status=400,
            body=b'{"error":"Bearer top-secret was rejected"}',
            reason="Bad Request",
        )
        token_connection = FakeHttpsConnection(echoed_token)
        with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
            with patch.object(
                MODULE.http.client,
                "HTTPSConnection",
                return_value=token_connection,
            ):
                with self.assertRaises(MODULE.GooglePlayApiError) as raised:
                    MODULE.GooglePlayTransport().request("GET", "/echo-token")

        message = str(raised.exception)
        self.assertNotIn("top-secret", message)
        self.assertIn("[REDACTED]", message)

    def test_transport_treats_invalid_successful_commit_responses_as_unknown(self) -> None:
        cases = (
            ("empty", b""),
            ("truncated", b'{"id":'),
            ("wrong shape", b"[]"),
            ("empty object", b"{}"),
            ("missing identity", b'{"expiryTimeSeconds":"1"}'),
            ("wrong identity", b'{"id":"edit-2","expiryTimeSeconds":"1"}'),
            ("non-string identity", b'{"id":1,"expiryTimeSeconds":"1"}'),
            ("oversized", b"x" * (MODULE.MAX_RESPONSE_BYTES + 2)),
        )
        for label, body in cases:
            with self.subTest(label=label):
                response = FakeHttpResponse(body=body)
                connection = FakeHttpsConnection(response)
                with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
                    with patch.object(
                        MODULE.http.client,
                        "HTTPSConnection",
                        return_value=connection,
                    ):
                        with self.assertRaisesRegex(
                            MODULE.CommitOutcomeUnknown,
                            "unknown; do not retry automatically",
                        ):
                            MODULE.GooglePlayTransport().request(
                                "POST",
                                "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1:commit",
                            )

                self.assertTrue(connection.closed)
                self.assertTrue(response.closed)

    def test_transport_accepts_commit_response_for_the_requested_edit(self) -> None:
        response = FakeHttpResponse(
            body=b'{"id":"edit-1","expiryTimeSeconds":"1"}',
        )
        connection = FakeHttpsConnection(response)
        with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
            with patch.object(
                MODULE.http.client,
                "HTTPSConnection",
                return_value=connection,
            ):
                result = MODULE.GooglePlayTransport().request(
                    "POST",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1:commit",
                )

        self.assertEqual(result["id"], "edit-1")

    def test_transport_keeps_verified_commit_rejections_definite(self) -> None:
        response = FakeHttpResponse(
            status=400,
            body=b'{"error":"commit rejected"}',
            reason="Bad Request",
        )
        connection = FakeHttpsConnection(response)
        with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
            with patch.object(
                MODULE.http.client,
                "HTTPSConnection",
                return_value=connection,
            ):
                with self.assertRaisesRegex(MODULE.GooglePlayApiError, "HTTP 400"):
                    MODULE.GooglePlayTransport().request(
                        "POST",
                        "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1:commit",
                    )

    def test_validates_every_local_input_before_creating_edit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = make_plan(Path(temp_dir))
            plan["listingAssets"][0]["path"] = str(Path(temp_dir) / "missing.png")
            transport = FakeTransport()

            with self.assertRaisesRegex(ValueError, "listing asset"):
                MODULE.publish_release(plan, transport)

        self.assertEqual(transport.calls, [])

    def test_mutations_are_ordered_and_stable_tracks_share_one_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            result = MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        operations = [(call["method"], call["path"]) for call in transport.calls]
        self.assertEqual(
            operations,
            [
                ("POST", "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits"),
                (
                    "POST",
                    "/upload/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/bundles?uploadType=media",
                ),
                (
                    "DELETE",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/listings/en-US/phoneScreenshots",
                ),
                (
                    "POST",
                    "/upload/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/listings/en-US/phoneScreenshots?uploadType=media",
                ),
                (
                    "PUT",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/listings/en-US",
                ),
                (
                    "PUT",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/tracks/production",
                ),
                (
                    "PUT",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1/tracks/beta",
                ),
                (
                    "POST",
                    "/androidpublisher/v3/applications/tech.dongdongbh.mindwtr/edits/edit-1:commit",
                ),
            ],
        )
        self.assertEqual(result["versionCode"], 42)
        self.assertEqual(result["tracks"], ["production", "beta"])
        self.assertTrue(result["committed"])

        track_calls = [
            call for call in transport.calls if call["method"] == "PUT" and "/tracks/" in call["path"]
        ]
        for call in track_calls:
            self.assertEqual(call["json_body"]["releases"][0]["versionCodes"], ["42"])
        listing_call = next(
            call
            for call in transport.calls
            if call["method"] == "PUT" and "/listings/en-US" in call["path"]
        )
        self.assertEqual(listing_call["json_body"]["language"], "en-US")

    def test_pre_commit_failure_deletes_the_edit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.fail_track = True

            with self.assertRaisesRegex(MODULE.GooglePlayApiError, "primary track failure"):
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertEqual(transport.calls[-1]["method"], "DELETE")
        self.assertTrue(str(transport.calls[-1]["path"]).endswith("/edit-1"))

    def test_uploaded_version_mismatch_deletes_the_edit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.uploaded_version_code = "41"

            with self.assertRaisesRegex(MODULE.GooglePlayApiError, "expected 42"):
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertEqual(transport.calls[-1]["method"], "DELETE")

    def test_confirmed_commit_http_rejection_deletes_the_edit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.reject_commit = True

            with self.assertRaisesRegex(MODULE.GooglePlayApiError, "HTTP 400"):
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertEqual(transport.calls[-2]["method"], "POST")
        self.assertTrue(str(transport.calls[-2]["path"]).endswith(":commit"))
        self.assertEqual(transport.calls[-1]["method"], "DELETE")

    def test_cleanup_failure_does_not_replace_the_primary_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.fail_track = True
            transport.fail_cleanup = True

            with self.assertRaisesRegex(MODULE.GooglePlayApiError, "primary track failure") as raised:
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertTrue(any("cleanup failure" in note for note in raised.exception.__notes__))

    def test_commit_timeout_preserves_unknown_outcome_and_attempts_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.timeout_commit = True

            with self.assertRaisesRegex(
                MODULE.CommitOutcomeUnknown,
                "unknown; do not retry automatically",
            ) as raised:
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertEqual(transport.calls[-2]["method"], "POST")
        self.assertTrue(str(transport.calls[-2]["path"]).endswith(":commit"))
        self.assertEqual(transport.calls[-1]["method"], "DELETE")
        self.assertNotIn("rollback", str(raised.exception).lower())

    def test_unknown_commit_cleanup_failure_is_a_secondary_note(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            transport = FakeTransport()
            transport.timeout_commit = True
            transport.fail_cleanup = True

            with self.assertRaises(MODULE.CommitOutcomeUnknown) as raised:
                MODULE.publish_release(make_plan(Path(temp_dir)), transport)

        self.assertIn("unknown", str(raised.exception))
        self.assertTrue(
            any("cleanup failure" in note for note in raised.exception.__notes__)
        )

    def test_reads_max_version_code_and_cleans_up_read_edit(self) -> None:
        transport = FakeTransport()

        maximum = MODULE.read_max_version_code("tech.dongdongbh.mindwtr", transport)

        self.assertEqual(maximum, 19)
        self.assertEqual(transport.calls[-1]["method"], "DELETE")

    def test_publish_cli_writes_a_non_secret_result_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            plan_path = root / "plan.json"
            result_path = root / "result.json"
            plan_path.write_text(json.dumps(make_plan(root)), encoding="utf-8")
            transport = FakeTransport()

            with patch.object(MODULE, "GooglePlayTransport", return_value=transport):
                with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
                    exit_code = MODULE.main(
                        ["publish", "--plan", str(plan_path), "--result", str(result_path)]
                    )

            result_text = result_path.read_text(encoding="utf-8")

        self.assertEqual(exit_code, 0)
        self.assertNotIn("top-secret", result_text)
        self.assertEqual(json.loads(result_text)["versionCode"], 42)

    def test_publish_cli_distinguishes_result_recording_failure_after_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            plan_path = root / "plan.json"
            result_path = root / "result.json"
            plan_path.write_text(json.dumps(make_plan(root)), encoding="utf-8")
            transport = FakeTransport()
            stderr = io.StringIO()

            with patch.object(MODULE, "GooglePlayTransport", return_value=transport):
                with patch.object(
                    MODULE,
                    "_write_result",
                    side_effect=OSError("disk full"),
                ):
                    with patch.dict(
                        os.environ,
                        {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"},
                    ):
                        with redirect_stderr(stderr):
                            exit_code = MODULE.main(
                                [
                                    "publish",
                                    "--plan",
                                    str(plan_path),
                                    "--result",
                                    str(result_path),
                                ]
                            )

        self.assertEqual(exit_code, 1)
        self.assertIn(
            "publication succeeded, but recording the local result failed",
            stderr.getvalue(),
        )
        self.assertIn("disk full", stderr.getvalue())
        self.assertEqual(transport.calls[-1]["method"], "POST")
        self.assertTrue(str(transport.calls[-1]["path"]).endswith(":commit"))

    def test_cli_prints_redacted_secondary_unknown_cleanup_notes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            plan_path = root / "plan.json"
            result_path = root / "result.json"
            plan_path.write_text(json.dumps(make_plan(root)), encoding="utf-8")
            transport = FakeTransport()
            transport.timeout_commit = True
            transport.fail_cleanup = True
            transport.cleanup_message = "cleanup echoed top-secret"
            stderr = io.StringIO()

            with patch.object(MODULE, "GooglePlayTransport", return_value=transport):
                with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
                    with redirect_stderr(stderr):
                        exit_code = MODULE.main(
                            [
                                "publish",
                                "--plan",
                                str(plan_path),
                                "--result",
                                str(result_path),
                            ]
                        )

        output = stderr.getvalue()
        self.assertEqual(exit_code, 1)
        self.assertIn("unknown; do not retry automatically", output)
        self.assertIn("cleanup also failed", output)
        self.assertIn("[REDACTED]", output)
        self.assertNotIn("top-secret", output)

    def test_max_version_code_cli_writes_its_result_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result_path = Path(temp_dir) / "result.json"
            transport = FakeTransport()

            with patch.object(MODULE, "GooglePlayTransport", return_value=transport):
                with patch.dict(os.environ, {"GOOGLE_PLAY_ACCESS_TOKEN": "top-secret"}):
                    exit_code = MODULE.main(
                        [
                            "max-version-code",
                            "--package",
                            "tech.dongdongbh.mindwtr",
                            "--result",
                            str(result_path),
                        ]
                    )

            result = json.loads(result_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(result["maxVersionCode"], 19)
        self.assertEqual(transport.calls[-1]["method"], "DELETE")


if __name__ == "__main__":
    unittest.main()
