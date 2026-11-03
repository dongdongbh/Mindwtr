import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-apple-outputs.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name).resolve()
        self.workspace = self.home / "runner/work/repo"
        self.temporary = self.home / "runner/temp"
        self.version = b"Xcode 27.0\nBuild version 18A123\n"
        self.cache = self.home / "Library/Caches/MindwtrNativeCI" / hashlib.sha256(self.version).hexdigest()[:16]
        for path in (self.workspace, self.temporary, self.cache):
            path.mkdir(parents=True)
        self.environment = patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted",
            "MINDWTR_EVIDENCE_UPLOADED": "true", "HOME": str(self.home),
            "GITHUB_WORKSPACE": str(self.workspace), "RUNNER_TEMP": str(self.temporary),
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

    def test_swiftui_removes_products_preserves_dependencies_logs_and_unknown(self):
        removed = [self.file("apps/ios-native/.build/" + name + "/fixture")
                   for name in ("out", "tmp", "DerivedData/Build", "DerivedData/Index.noindex")]
        kept = [self.file("apps/ios-native/.build/" + name + "/fixture")
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
        with self.assertRaises(OSError):
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
        output = self.file("apps/ios-native/.build/out/fixture")
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
        output = self.file("apps/ios-native/.build/out/fixture")
        outside = self.home / "preserved"
        outside.mkdir()
        late = self.workspace / "apps/ios-native/.build/DerivedData/CompilationCache.noindex"
        late.parent.mkdir()
        late.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(cleanup.Refused):
            cleanup.cleanup("swiftui")
        self.assertTrue(output.exists())

    def test_symlink_parent_refused_before_deletion(self):
        output = self.file("apps/ios-native/.build/out/fixture")
        outside = self.home / "preserved"
        outside.mkdir()
        (output.parent.parent / "DerivedData").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            cleanup.cleanup("swiftui")
        self.assertTrue(output.exists())

    def test_nested_symlink_is_unlinked_without_following(self):
        output = self.file("apps/ios-native/.build/out/fixture")
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
        with self.assertRaises(OSError):
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
        output = self.file("apps/ios-native/.build/out/fixture")
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


if __name__ == "__main__":
    unittest.main()
