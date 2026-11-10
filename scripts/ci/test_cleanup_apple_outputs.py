import hashlib
import importlib.util
import os
from pathlib import Path
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-apple-outputs.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
require_devssd = cleanup.storage.require_devssd


class StorageFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name).resolve()
        self.workspace = self.home / "runner/work/repo"
        self.runner_temporary = self.home / "runner/temp"
        self.volume = self.home / "volume"
        self.namespace = self.volume / "ci/mindwtr-ci"
        self.temporary = self.namespace / "jobs/1-1-test"
        self.version = b"Xcode 27.0\nBuild version 18A123\n"
        self.cache = self.namespace / "caches" / hashlib.sha256(self.version).hexdigest()[:16]
        for path in (self.workspace, self.runner_temporary, self.temporary, self.cache):
            path.mkdir(parents=True)
        self.namespace.chmod(0o700)
        for target, attribute, value in ((cleanup.storage, "DEVSSD", self.volume),
                (cleanup.storage.pwd, "getpwuid", lambda uid: SimpleNamespace(pw_name="mindwtr-ci", pw_dir=str(self.home))),
                (cleanup.storage.pwd, "getpwnam", lambda name: SimpleNamespace(pw_uid=os.getuid())),
                (cleanup.storage, "require_devssd", lambda: None)):
            replacement = patch.object(target, attribute, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.environment = patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted",
            "MINDWTR_EVIDENCE_UPLOADED": "true", "HOME": str(self.home),
            "GITHUB_WORKSPACE": str(self.workspace), "RUNNER_TEMP": str(self.runner_temporary),
            "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "test",
            "MINDWTR_APPLE_TEMP": str(self.temporary), "TMPDIR": str(self.temporary / "tmp"),
            "MINDWTR_SWIFT_CACHE": str(self.cache / "swift"), "MINDWTR_SWIFTUI_BUILD": str(self.cache / "swiftui"),
            "MINDWTR_NATIVE_CACHE": str(self.cache),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.xcode = patch.object(cleanup.subprocess, "run")
        self.xcode.start().return_value.stdout = self.version
        self.addCleanup(self.xcode.stop)

    def file(self, relative, root=None):
        path = (root or self.workspace) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
        return path


class CleanupTests(StorageFixture):

    def test_swiftui_removes_products_preserves_dependencies_logs_and_unknown(self):
        removed = [self.file("swiftui/" + name + "/fixture", self.cache)
                   for name in ("out", "tmp", "DerivedData/Build", "DerivedData/Index.noindex")]
        kept = [self.file("swiftui/" + name + "/fixture", self.cache)
                for name in ("checkouts", "repositories", "artifacts", "DerivedData/SourcePackages", "DerivedData/Logs", "unknown")]
        result = cleanup.cleanup("swiftui")
        self.assertEqual(result["removed"], 4)
        self.assertTrue(all(not path.exists() for path in removed))
        self.assertTrue(all(path.exists() for path in kept))
        self.assertEqual(cleanup.cleanup("swiftui")["removed"], 0)

    def test_ios_removes_only_known_outputs(self):
        removed = [self.file(name + "/fixture", self.cache) for name in (
            "simulator/Build", "archive/Build", "watch/products", "watch/intermediates",
            "swift/attachment-file-installer/out", "swift/cloudkit-sync/out")]
        removed += [self.file("apps/mobile/ios/build/fixture"),
                    self.file("ios27-artifacts/Mindwtr-unsigned.xcarchive/fixture", self.temporary)]
        kept = [self.file(name + "/fixture", self.cache) for name in (
            "simulator/Logs", "archive/SourcePackages", "swift/cloudkit-sync/checkouts",
            "swift/unknown/out", "unknown")]
        kept += [self.file("apps/mobile/ios/Pods/fixture"), self.file("node_modules/fixture"),
                 self.file("ios27-artifacts/archive.log", self.temporary),
                 self.file("older-generation/archive/Build/fixture", self.cache.parent)]
        self.assertEqual(cleanup.cleanup("ios")["removed"], len(removed))
        self.assertTrue(all(not path.exists() for path in removed))
        self.assertTrue(all(path.exists() for path in kept))

    def test_pre_archive_retires_completed_outputs_preserves_archive_inputs_and_evidence(self):
        removed = [self.file("simulator/" + child + "/fixture", self.cache)
                   for child in cleanup.DERIVED_OUTPUTS]
        removed += [self.file("watch/" + child + "/fixture", self.cache)
                    for child in ("products", "intermediates")]
        removed += [self.file("swift/" + package + "/out/fixture", self.cache)
                    for package in cleanup.SWIFT_PACKAGES]
        kept = [self.file("archive/" + child + "/fixture", self.cache)
                for child in cleanup.DERIVED_OUTPUTS]
        kept += [self.file(name + "/fixture", self.cache) for name in (
            "simulator/Logs", "simulator/SourcePackages", "archive/Logs", "archive/SourcePackages",
            "swift/watch/checkouts", "swift/watch/repositories", "swift/watch/artifacts",
            "swift/unknown/out", "watch/unknown", "unknown")]
        kept += [self.file("apps/mobile/ios/build/generated/source"),
                 self.file("apps/mobile/ios/Pods/dependency"), self.file("node_modules/dependency"),
                 self.file("ios27-artifacts/Mindwtr-unsigned.xcarchive/app", self.temporary),
                 self.file("ios27-artifacts/release-simulator-build.log", self.temporary),
                 self.file("ios27-artifacts/cold-link-screen.png", self.temporary),
                 self.file("older-generation/simulator/Build/fixture", self.cache.parent)]
        original = [(path.stat().st_ino, path.read_bytes()) for path in kept]
        result = cleanup.cleanup("ios-pre-archive")
        self.assertEqual(result["kind"], "ios-pre-archive")
        self.assertEqual(result["removed"], len(removed))
        self.assertTrue(all(not path.exists() for path in removed))
        self.assertEqual([(path.stat().st_ino, path.read_bytes()) for path in kept], original)
        self.assertIn("beforeAvailableBytes", result)
        self.assertIn("afterAvailableBytes", result)
        self.assertEqual(cleanup.cleanup("ios-pre-archive")["removed"], 0)

    def test_pre_archive_requires_upload_actions_and_current_compiler(self):
        output = self.file("simulator/Build/fixture", self.cache)
        for environment in ({"MINDWTR_EVIDENCE_UPLOADED": "false"}, {"GITHUB_ACTIONS": "false"},
                            {"MINDWTR_NATIVE_CACHE": str(self.cache.parent / "different")}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment):
                with self.assertRaises(cleanup.Refused):
                    cleanup.cleanup("ios-pre-archive")
                self.assertEqual(output.read_text(), "fixture")
        with patch.dict(os.environ, {"RUNNER_ENVIRONMENT": "github-hosted", "HOME": "invalid"}):
            self.assertEqual(cleanup.cleanup("ios-pre-archive")["skipped"], "hosted-runner")
        self.assertEqual(output.read_text(), "fixture")

    def test_pre_archive_late_symlink_preserves_all_earlier_candidates(self):
        earlier = [self.file("simulator/Build/fixture", self.cache),
                   self.file("watch/products/fixture", self.cache)]
        preserved = self.file("preserved/fixture", self.home)
        late = self.cache / "swift/watch/out"
        late.parent.mkdir(parents=True)
        late.symlink_to(preserved.parent, target_is_directory=True)
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("ios-pre-archive")
        self.assertTrue(all(path.read_text() == "fixture" for path in earlier))
        self.assertEqual(preserved.read_text(), "fixture")
        self.assertTrue(late.is_symlink())

    def test_pre_archive_parent_symlink_cannot_delete_earlier_output_or_target(self):
        output = self.file("simulator/Build/fixture", self.cache)
        preserved = self.file("preserved/products/fixture", self.home)
        (self.cache / "watch").symlink_to(preserved.parent.parent, target_is_directory=True)
        with self.assertRaises((OSError, cleanup.Refused)):
            cleanup.cleanup("ios-pre-archive")
        self.assertEqual(output.read_text(), "fixture")
        self.assertEqual(preserved.read_text(), "fixture")

    def test_pre_archive_replaced_candidate_is_retained(self):
        output = self.file("simulator/Build/fixture", self.cache)
        original = cleanup.candidate_identity
        count = 0
        def replace_before_removal(path):
            nonlocal count
            if path == output.parent:
                count += 1
                if count == 2:
                    path.rename(path.with_name("retained-original"))
                    path.mkdir()
                    (path / "new").write_text("replacement")
            return original(path)
        with patch.object(cleanup, "candidate_identity", side_effect=replace_before_removal):
            with self.assertRaises(cleanup.Refused):
                cleanup.cleanup("ios-pre-archive")
        self.assertEqual((output.parent / "new").read_text(), "replacement")
        self.assertEqual((output.parent.with_name("retained-original") / "fixture").read_text(), "fixture")

    def test_upload_failure_preserves_everything(self):
        output = self.file("swiftui/out/fixture", self.cache)
        os.environ["MINDWTR_EVIDENCE_UPLOADED"] = "false"
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("swiftui")
        self.assertTrue(output.exists())

    def test_hosted_runner_is_noop(self):
        os.environ["RUNNER_ENVIRONMENT"] = "github-hosted"
        os.environ["HOME"] = "invalid"
        self.assertEqual(cleanup.cleanup("ios")["skipped"], "hosted-runner")

    def test_non_actions_refused(self):
        os.environ["GITHUB_ACTIONS"] = "false"
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("ios")

    def test_other_compiler_cache_refused(self):
        os.environ["MINDWTR_NATIVE_CACHE"] = str(self.cache.parent / "different")
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("ios")

    def test_late_symlink_preflight_preserves_earlier_output(self):
        output = self.file("swiftui/out/fixture", self.cache)
        outside = self.home / "preserved"
        outside.mkdir()
        late = self.cache / "swiftui/DerivedData/CompilationCache.noindex"
        late.parent.mkdir(parents=True, exist_ok=True)
        late.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("swiftui")
        self.assertTrue(output.exists())

    def test_symlink_parent_refused_before_deletion(self):
        output = self.file("swiftui/out/fixture", self.cache)
        outside = self.home / "preserved"
        outside.mkdir()
        (output.parent.parent / "DerivedData").symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, cleanup.Refused)):
            cleanup.cleanup("swiftui")
        self.assertTrue(output.exists())

    def test_nested_symlink_is_unlinked_without_following(self):
        output = self.file("swiftui/out/fixture", self.cache)
        preserved = self.file("preserved/fixture", self.home)
        (output.parent / "link").symlink_to(preserved.parent, target_is_directory=True)
        cleanup.cleanup("swiftui")
        self.assertTrue(preserved.exists())

    def test_symlink_home_alias_with_trailing_slashes_refused(self):
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        os.environ["HOME"] = str(alias) + "////"
        os.environ["GITHUB_WORKSPACE"] = str(alias / "runner/work/repo")
        os.environ["RUNNER_TEMP"] = str(alias / "runner/temp")
        os.environ["MINDWTR_NATIVE_CACHE"] = str(alias / self.cache.relative_to(self.home))
        with self.assertRaises((OSError, cleanup.Refused)):
            cleanup.cleanup("ios")

    def test_workflow_requires_real_uploaded_artifact_and_runs_after_failure(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/native-platform-ci.yml").read_text()
        for label, evidence, scope in (("SwiftUI", "swiftui_evidence", "swiftui"), ("iOS", "ios27_evidence", "ios")):
            step = workflow.split("- name: Retire completed " + label + " build outputs", 1)[1].split("\n      - name:", 1)[0]
            self.assertIn("always()", step)
            self.assertIn("runner.environment == 'self-hosted'", step)
            self.assertIn("steps.apple_cache.outcome == 'success'", step)
            self.assertIn("steps." + evidence + ".outcome == 'success'", step)
            self.assertIn("steps." + evidence + ".outputs.artifact-id != ''", step)
            self.assertIn("cleanup-apple-outputs.py " + scope, step)
            self.assertLess(workflow.index("id: " + evidence), workflow.index("- name: Retire completed " + label))
        self.assertIn('SYMROOT="$MINDWTR_NATIVE_CACHE/watch/products"', workflow)
        self.assertIn('OBJROOT="$MINDWTR_NATIVE_CACHE/watch/intermediates"', workflow)

    def test_candidate_replacement_is_not_removed(self):
        output = self.file("swiftui/out/fixture", self.cache)
        original = cleanup.candidate_identity
        count = 0
        def replace_before_removal(path):
            nonlocal count
            if path == output.parent:
                count += 1
                if count == 2:
                    path.rename(path.with_name("retained-original"))
                    path.mkdir()
                    (path / "new").write_text("replacement")
            return original(path)
        with patch.object(cleanup, "candidate_identity", side_effect=replace_before_removal):
            with self.assertRaises(cleanup.Refused):
                cleanup.cleanup("swiftui")
        self.assertTrue((output.parent / "new").exists())
        self.assertTrue((output.parent.with_name("retained-original") / "fixture").exists())


class StorageTests(StorageFixture):
    def test_prepare_exports_ssd_paths_without_overriding_runner_temp(self):
        environment = self.home / "github-env"
        environment.write_text("")
        legacy = self.file("Library/Caches/MindwtrNativeCI/aaaaaaaaaaaaaaaa/swift/ios-widget/out/fixture", self.home)
        with patch.dict(os.environ, {"GITHUB_ENV": str(environment)}), \
                patch.object(cleanup.storage, "available_bytes", return_value=100 * 1024**3):
            cleanup.storage.prepare("startup")
        values = dict(line.split("=", 1) for line in environment.read_text().splitlines())
        self.assertEqual(values["MINDWTR_NATIVE_CACHE"], str(self.cache))
        self.assertEqual(values["MINDWTR_APPLE_TEMP"], str(self.temporary))
        self.assertEqual(values["MINDWTR_SWIFTUI_BUILD"], str(self.cache / "swiftui"))
        self.assertEqual(values["TMPDIR"], str(self.temporary / "tmp") + "/")
        self.assertNotIn("RUNNER_TEMP", values)
        self.assertTrue((self.temporary / "ios27-artifacts").is_dir())
        self.assertEqual(os.environ["RUNNER_TEMP"], str(self.runner_temporary))
        self.assertEqual(legacy.read_text(), "fixture")

    def test_internal_and_archive_headroom_use_their_actual_volumes(self):
        for phase in ("startup", "before-archive"):
            for internal, external, passes in ((12, 20, True), (12, 19.99, False), (11.99, 100, False)):
                with self.subTest(phase=phase, internal=internal, external=external):
                    def available(path):
                        return int((internal if path == self.home else external) * 1024**3)
                    with patch.object(cleanup.storage, "available_bytes", side_effect=available), \
                            patch.dict(os.environ, {"GITHUB_ENV": str(self.home / "github-env")}):
                        if passes:
                            cleanup.storage.prepare(phase)
                        else:
                            with self.assertRaises(cleanup.Refused):
                                cleanup.storage.prepare(phase)

    def test_legacy_low_space_cleanup_preserves_logs_dependencies_and_archive_evidence(self):
        legacy = self.home / "Library/Caches/MindwtrNativeCI" / ("a" * 16)
        removed = [self.file(name + "/fixture", legacy) for name in (
            "simulator/Build", "archive/Build", "watch/products", "swift/ios-widget/out")]
        kept = [self.file(name + "/fixture", legacy) for name in (
            "simulator/Logs", "archive/Logs", "swift/ios-widget/checkouts", "swift/unknown/out", "unknown")]
        archive = self.file("ios27-artifacts/Mindwtr-unsigned.xcarchive/evidence", self.runner_temporary)
        with patch.object(cleanup.storage, "available_bytes", side_effect=[11 * 1024**3, 12 * 1024**3, 100 * 1024**3]), \
                patch.dict(os.environ, {"GITHUB_ENV": str(self.home / "github-env")}):
            cleanup.storage.prepare("startup")
        self.assertTrue(all(not path.exists() for path in removed))
        self.assertTrue(all(path.read_text() == "fixture" for path in kept + [archive]))

    def test_legacy_late_symlink_preserves_all_candidates(self):
        legacy = self.home / "Library/Caches/MindwtrNativeCI" / ("a" * 16)
        earlier = self.file("simulator/Build/fixture", legacy)
        target = self.file("preserved/fixture", self.home)
        (legacy / "watch").symlink_to(target.parent, target_is_directory=True)
        with self.assertRaises((OSError, cleanup.Refused)):
            cleanup.storage.legacy_generated_cleanup(self.home)
        self.assertEqual(earlier.read_text(), "fixture")
        self.assertEqual(target.read_text(), "fixture")

    def test_missing_namespace_never_creates_a_replacement(self):
        saved = self.namespace.with_name("saved")
        self.namespace.rename(saved)
        with self.assertRaises(OSError):
            cleanup.storage.checked_paths(configured=False)
        self.assertFalse(self.namespace.exists())

    def test_untrusted_namespace_and_descendant_permissions_are_refused(self):
        for path, mode in ((self.namespace, 0o750), (self.namespace.parent, 0o777),
                           (self.cache.parent, 0o777), (self.cache, 0o777)):
            with self.subTest(path=path):
                original = path.stat().st_mode & 0o777
                path.chmod(mode)
                try:
                    with self.assertRaises(cleanup.Refused):
                        cleanup.storage.checked_paths()
                finally:
                    path.chmod(original)
        with patch.object(cleanup.storage.os, "access", return_value=False):
            with self.assertRaises(cleanup.Refused):
                cleanup.storage.checked_paths()

    def test_wrong_account_and_foreign_output_ownership_are_refused(self):
        with patch.object(cleanup.storage.pwd, "getpwuid", return_value=SimpleNamespace(pw_name="dd")):
            with self.assertRaises(cleanup.Refused):
                cleanup.storage.checked_paths()
        original = cleanup.storage.os.fstat
        def foreign(descriptor):
            info = original(descriptor)
            return SimpleNamespace(st_uid=os.getuid() + 100, st_mode=info.st_mode)
        with patch.object(cleanup.storage.os, "fstat", side_effect=foreign):
            with self.assertRaises(cleanup.Refused):
                cleanup.storage.checked_paths()

    def test_all_consumer_overrides_and_invalid_job_identity_fail_before_cleanup(self):
        output = self.file("simulator/Build/fixture", self.cache)
        for name in ("MINDWTR_NATIVE_CACHE", "MINDWTR_APPLE_TEMP", "MINDWTR_SWIFT_CACHE", "MINDWTR_SWIFTUI_BUILD", "TMPDIR"):
            for value in (str(self.home), str(self.cache) + "/../outside", ""):
                with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}):
                    with self.assertRaises(cleanup.Refused):
                        cleanup.cleanup("ios")
        for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB"):
            with patch.dict(os.environ, {name: "../other"}):
                with self.assertRaises(cleanup.Refused):
                    cleanup.storage.checked_paths()
        self.assertEqual(output.read_text(), "fixture")

    def test_absent_wrong_or_readonly_volume_never_authorizes_cleanup(self):
        output = self.file("simulator/Build/fixture", self.cache)
        for message in ("absent", "wrong UUID", "readonly"):
            with patch.object(cleanup.storage, "require_devssd", side_effect=cleanup.Refused(message)):
                with self.assertRaises(cleanup.Refused):
                    cleanup.cleanup("ios")
        self.assertEqual(output.read_text(), "fixture")

    def test_namespace_ancestor_and_output_symlinks_are_refused(self):
        for path in (self.namespace, self.cache.parent, self.cache, self.temporary, self.cache / "swift/ios-widget",
                     self.cache / "swift/ios-widget/out", self.cache / "swiftui/out",
                     self.temporary / "ios27-artifacts/Mindwtr-unsigned.xcarchive"):
            with self.subTest(path=path):
                saved = path.with_name(path.name + "-saved")
                existed = path.exists()
                if existed:
                    path.rename(saved)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(saved, target_is_directory=True)
                try:
                    with patch.object(cleanup.storage.sys, "argv", ["storage", "run", "script.sh"]), \
                            patch.object(cleanup.storage.os, "execv") as execute:
                        with self.assertRaises((OSError, cleanup.Refused)):
                            cleanup.storage.main()
                        execute.assert_not_called()
                finally:
                    path.unlink()
                    if existed:
                        saved.rename(path)

    def test_compiler_failure_prevents_cleanup_and_hosted_launch_stays_unchanged(self):
        output = self.file("simulator/Build/fixture", self.cache)
        with patch.object(cleanup.storage, "capture", side_effect=cleanup.subprocess.CalledProcessError(1, "xcodebuild")):
            with self.assertRaises(cleanup.subprocess.SubprocessError):
                cleanup.cleanup("ios")
        self.assertEqual(output.read_text(), "fixture")
        with patch.dict(os.environ, {"RUNNER_ENVIRONMENT": "github-hosted", "HOME": "invalid"}), \
                patch.object(cleanup.storage.sys, "argv", ["storage", "run", "script.sh"]), \
                patch.object(cleanup.storage.os, "execv") as execute:
            cleanup.storage.main()
            execute.assert_called_once_with("/bin/bash", ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "script.sh"])

    def test_real_volume_parser_checks_disk_identity_and_mount_table(self):
        valid = dict(MountPoint=str(self.volume), VolumeUUID=cleanup.storage.DEVSSD_UUID,
                     FilesystemType="apfs", Internal=False, GlobalPermissionsEnabled=True, DeviceNode="/dev/disk8s1")
        original = Path.stat
        def mounted(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if path == self.volume:
                return SimpleNamespace(st_mode=value.st_mode, st_dev=value.st_dev + 1)
            return value
        options = "apfs, local, nodev, nosuid, journaled"
        def capture(arguments):
            if arguments[0] == "/usr/sbin/diskutil":
                return plistlib.dumps(valid)
            return f"/dev/disk8s1 on {self.volume} ({options})\n".encode()
        with patch.object(cleanup.storage.os.path, "ismount", return_value=True), \
                patch.object(Path, "stat", mounted), patch.object(cleanup.storage, "capture", side_effect=capture):
            require_devssd()
            for name, value in (("VolumeUUID", "wrong"), ("MountPoint", "/wrong"), ("FilesystemType", "hfs"),
                                ("Internal", True), ("GlobalPermissionsEnabled", False), ("Mounted", False), ("DeviceNode", "missing")):
                prior = valid.get(name)
                valid[name] = value
                try:
                    with self.subTest(field=name), self.assertRaises(cleanup.Refused):
                        require_devssd()
                finally:
                    if prior is None:
                        del valid[name]
                    else:
                        valid[name] = prior
            for options in ("apfs, read-only", "apfs, noowners", "hfs", ""):
                with self.subTest(options=options), self.assertRaises(cleanup.Refused):
                    require_devssd()
            with patch.object(cleanup.storage.os.path, "ismount", return_value=False):
                with self.assertRaises(cleanup.Refused):
                    require_devssd()


if __name__ == "__main__":
    unittest.main()
