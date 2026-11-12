
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-merged-worktrees.py"))
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ.get("MINDWTR_MAINTENANCE_TEST_TMPDIR", str(Path.home() / ".cache" / "mindwtr-maintenance-tests")))
        base.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="task213 fixtures 名 ", dir=base)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repo = self.base / "main repo"
        self.root = self.base / "worktree root"
        self.archive_root = self.base / "private archives"
        self.origin = self.base / "origin.git"
        self.root.mkdir()
        self.repo.mkdir()
        self.git(self.repo, "init", "-b", "main")
        self.git(self.repo, "config", "user.name", "Fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "core.excludesFile", "/dev/null")
        (self.repo / ".gitignore").write_text("node_modules/\n.orchestrator/\n.env\n.build-task*/\napps/ios-native/.build/\napps/desktop/src-tauri/target/\napps/mobile/android/\napps/android-native/**/build/\n.gradle/\n.kotlin/\n.cxx/\ncoverage/\n__pycache__/\n.venv-comments/\napps/mobile/.expo/\napps/mobile/expo-env.d.ts\napps/mobile/modules/*/.tests-tmp/\napps/desktop/dist/\napps/desktop/src-tauri/gen/schemas/\napps/ios-native/Resources/*.js*\napps/ios-native/Sources/MindwtrNativeCore/Resources/sandbox-host.js\napps/android-native/android/app/src/main/assets/\n.perf/\n", encoding="utf-8")
        (self.repo / "source.txt").write_text("committed fixture\n", encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "initial fixture")
        self.git(self.base, "init", "--bare", str(self.origin))
        self.git(self.repo, "remote", "add", "origin", str(self.origin))
        self.git(self.repo, "push", "-u", "origin", "main")
        self.worktree = self.root / "merged topic 名 space"
        self.git(self.repo, "worktree", "add", "-b", "retained-topic", str(self.worktree))
        self.now = time.time()
        self.old = self.now - 11 * 86400
        self.age()

    def git(self, path, *args):
        result = subprocess.run(["git", "-C", str(path), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_OPTIONAL_LOCKS="0"), check=False)
        if result.returncode:
            self.fail("fixture Git operation failed")
        return result.stdout

    def age(self, path=None):
        path = path or self.worktree
        for directory, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                entry = Path(directory) / name
                if name != ".git":
                    os.utime(entry, (self.old, self.old), follow_symlinks=False)
            os.utime(directory, (self.old, self.old), follow_symlinks=False)

    def service(self, **kwargs):
        options = dict(now=lambda: self.now, probe=lambda path: False, free_bytes=lambda path: 100 * 1024**3,
                       lock_path=self.base / "machine cleanup.lock")
        options.update(kwargs)
        return cleanup.Cleanup(self.repo, self.root, self.archive_root, **options)

    def run_cleanup(self, *, apply=True, **kwargs):
        return self.service(**kwargs).run(apply=apply)

    def candidate(self, report):
        return next(item for item in report["worktrees"] if item["path"] == str(self.worktree))

    def assert_skip(self, reason, **kwargs):
        report = self.run_cleanup(**kwargs)
        item = self.candidate(report)
        self.assertEqual((item["decision"], item["reason"]), ("skip", reason))
        self.assertTrue(self.worktree.exists())
        return report

    def ignored_file(self, relative, data=b"generated fixture"):
        path = self.worktree / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.age()
        return path

    def test_dry_run_default_changes_nothing_and_reports_cached_ref(self):
        report = self.run_cleanup(apply=False)
        self.assertEqual(self.candidate(report)["decision"], "eligible")
        self.assertFalse(report["origin_main_freshly_fetched"])
        self.assertEqual(report["ref_freshness"], "cached_ref_only_not_verified")
        self.assertTrue(self.worktree.exists())
        self.assertFalse(self.archive_root.exists())

    def test_merged_clean_aged_apply_removes_worktree_retains_branch_and_receipt(self):
        report = self.run_cleanup()
        item = self.candidate(report)
        self.assertEqual(item["decision"], "removed")
        self.assertTrue(report["origin_main_freshly_fetched"])
        self.assertFalse(self.worktree.exists())
        self.assertEqual(self.git(self.repo, "rev-parse", "retained-topic"), self.git(self.repo, "rev-parse", "HEAD"))
        receipt = json.loads(Path(item["receipt"]).read_text())
        self.assertEqual(receipt["status"], "removed")
        self.assertEqual(receipt["head"], item["head"])
        self.assertIsNone(receipt["archive"])
        self.assertEqual(stat.S_IMODE(self.archive_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(Path(item["receipt"]).stat().st_mode), 0o600)

    def test_recent_source_skips(self):
        os.utime(self.worktree / "source.txt", (self.now, self.now))
        self.assert_skip("recent_activity")

    def test_recent_generated_file_skips_even_with_old_directory_mtimes(self):
        path = self.ignored_file("node_modules/pkg/index.js")
        os.utime(path, (self.now, self.now))
        self.assert_skip("recent_activity")

    def test_recent_evidence_skips(self):
        path = self.ignored_file(".orchestrator/result.md")
        os.utime(path, (self.now, self.now))
        self.assert_skip("recent_activity")

    def test_dirty_tracked_skips(self):
        (self.worktree / "source.txt").write_text("local change\n")
        self.age()
        self.assert_skip("dirty_or_untracked")

    def test_assume_unchanged_cannot_hide_modified_source(self):
        self.git(self.worktree, "update-index", "--assume-unchanged", "source.txt")
        (self.worktree / "source.txt").write_text("hidden local source modification")
        self.age()
        self.assertEqual(self.git(self.worktree, "status", "--porcelain"), b"")
        self.assert_skip("hidden_index_flags")
        self.assertEqual((self.worktree / "source.txt").read_text(), "hidden local source modification")

    def test_skip_worktree_cannot_hide_modified_source(self):
        self.git(self.worktree, "update-index", "--skip-worktree", "source.txt")
        (self.worktree / "source.txt").write_text("hidden sparse source modification")
        self.age()
        self.assertEqual(self.git(self.worktree, "status", "--porcelain"), b"")
        self.assert_skip("hidden_index_flags")
        self.assertEqual((self.worktree / "source.txt").read_text(), "hidden sparse source modification")

    def test_final_recheck_refuses_new_hidden_index_flags(self):
        service = self.service()
        archive = service.archive
        def archive_then_hide_change(*args):
            result = archive(*args)
            self.git(self.worktree, "update-index", "--assume-unchanged", "source.txt")
            (self.worktree / "source.txt").write_text("hidden concurrent modification")
            self.age()
            return result
        service.archive = archive_then_hide_change
        item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "recheck_hidden_index_flags")
        self.assertTrue(self.worktree.exists())

    def test_ordinary_untracked_skips(self):
        (self.worktree / "notes.txt").write_text("uncommitted\n")
        self.age()
        self.assert_skip("dirty_or_untracked")

    def test_untracked_evidence_is_not_discarded(self):
        self.git(self.worktree, "config", "--local", "core.excludesFile", "/dev/null")
        (self.worktree / ".orchestrator-untracked").mkdir()
        (self.worktree / ".orchestrator-untracked" / "result.md").write_text("local evidence")
        self.age()
        self.assert_skip("dirty_or_untracked")

    def test_locked_skips_without_exposing_lock_reason(self):
        self.git(self.repo, "worktree", "lock", "--reason", "private fixture reason", str(self.worktree))
        report = self.assert_skip("locked_or_prunable")
        self.assertNotIn("private fixture reason", json.dumps(report))

    def test_unmerged_commit_skips(self):
        (self.worktree / "source.txt").write_text("new commit\n")
        self.git(self.worktree, "commit", "-am", "not merged")
        self.age()
        self.assert_skip("not_merged_into_origin_main")

    def test_replace_refs_cannot_forge_remote_merge_proof(self):
        (self.worktree / "source.txt").write_text("unmerged change")
        self.git(self.worktree, "commit", "-am", "unmerged")
        topic = self.git(self.worktree, "rev-parse", "HEAD").decode().strip()
        self.git(self.repo, "replace", "--graft", "origin/main", topic)
        self.git(self.repo, "merge-base", "--is-ancestor", topic, "origin/main")
        self.age()
        self.assert_skip("not_merged_into_origin_main")

    def test_local_main_merge_is_insufficient_until_origin_has_commit(self):
        (self.worktree / "source.txt").write_text("new commit\n")
        self.git(self.worktree, "commit", "-am", "local only")
        self.git(self.repo, "merge", "--ff-only", "retained-topic")
        self.age()
        self.assert_skip("not_merged_into_origin_main")

    def test_fresh_fetch_accepts_commit_only_after_origin_updated(self):
        (self.worktree / "source.txt").write_text("new merged commit\n")
        self.git(self.worktree, "commit", "-am", "merged")
        self.git(self.repo, "merge", "--ff-only", "retained-topic")
        self.git(self.repo, "push", "origin", "main")
        self.age()
        self.assertEqual(self.candidate(self.run_cleanup())["decision"], "removed")

    def test_explicit_protection(self):
        self.assert_skip("protected", protect=[self.worktree])

    def test_known_protected_name(self):
        target = self.root / "native-ios-foundation"
        self.git(self.repo, "worktree", "move", str(self.worktree), str(target))
        self.worktree = target
        self.age()
        self.assert_skip("protected")

    def test_primary_checkout_always_skips(self):
        report = self.run_cleanup(apply=False)
        primary = next(item for item in report["worktrees"] if item["path"] == str(self.repo))
        self.assertEqual(primary["reason"], "primary_checkout")

    def test_registered_outside_root_and_nested_child_skip(self):
        for name, target in [("outside", self.base / "outside"), ("nested", self.root / "nested" / "child")]:
            target.parent.mkdir(exist_ok=True)
            self.git(self.repo, "worktree", "add", "-b", name, str(target))
            self.age(target)
        report = self.run_cleanup(apply=False)
        for item in report["worktrees"]:
            if item["path"] in (str(self.base / "outside"), str(self.root / "nested" / "child")):
                self.assertEqual(item["reason"], "outside_direct_worktree_root")

    def test_symlinked_root_with_multiple_trailing_slashes_rejected(self):
        alias = self.base / "root alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for slash in ("/", "//", "////"):
            with self.subTest(slash=slash), self.assertRaisesRegex(cleanup.SafetyError, "symlinked_path"):
                cleanup.Cleanup(self.repo, str(alias) + slash, self.archive_root)

    def test_symlinked_ancestor_rejected(self):
        alias = self.base / "parent alias"
        alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(cleanup.SafetyError, "symlinked_path"):
            cleanup.Cleanup(alias / "main repo", self.root, self.archive_root)

    def test_registered_target_symlink_skips(self):
        moved = self.base / "moved source"
        self.worktree.rename(moved)
        self.worktree.symlink_to(moved, target_is_directory=True)
        self.assert_skip("symlinked_path")

    def test_candidate_git_metadata_symlink_skips(self):
        original = self.worktree / ".git"
        metadata = self.base / "moved git pointer"
        original.rename(metadata)
        original.symlink_to(metadata)
        self.assert_skip("symlinked_path")

    def test_registration_metadata_must_belong_to_configured_repository(self):
        foreign = self.base / "foreign repository"
        self.git(self.base, "clone", str(self.origin), str(foreign))
        self.git(foreign, "checkout", "main")
        (self.worktree / ".git").write_text("gitdir: " + str(foreign / ".git") + "\n")
        self.assert_skip("registration_metadata_mismatch")

    def test_symlinked_evidence_skips(self):
        for relative in (".orchestrator/alias", ".orchestrator/regular-link"):
            with self.subTest(relative=relative):
                path = self.worktree / relative
                path.parent.mkdir(exist_ok=True)
                path.symlink_to(self.base, target_is_directory=True)
                self.age()
                self.assert_skip("symlinked_worktree_content")
                path.unlink()
                self.age()

    def test_generated_symlinks_are_unlinked_without_following_external_target(self):
        external = self.base / "external live data"
        external.mkdir()
        (external / "retained.txt").write_text("outside generated link target")
        for relative in ("node_modules/.bin/tool", "apps/ios-native/.build/debug"):
            path = self.worktree / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(external, target_is_directory=True)
        self.age()
        item = self.candidate(self.run_cleanup())
        self.assertEqual(item["decision"], "removed")
        self.assertTrue((external / "retained.txt").exists())

    def test_tracked_source_symlink_is_not_followed_or_retired(self):
        (self.worktree / "source-link").symlink_to(self.base, target_is_directory=True)
        self.git(self.worktree, "add", "source-link")
        self.git(self.worktree, "commit", "-m", "source symlink")
        self.git(self.repo, "merge", "--ff-only", "retained-topic")
        self.git(self.repo, "push", "origin", "main")
        self.age()
        self.assert_skip("symlinked_worktree_content")

    def test_unknown_ignored_configuration_skips_without_reading_content(self):
        self.ignored_file(".env", b"PRIVATE_FIXTURE_CONTENT")
        report = self.assert_skip("unknown_ignored_content")
        self.assertNotIn("PRIVATE_FIXTURE_CONTENT", json.dumps(report))

    def test_narrow_generated_allowlist(self):
        for path in ("node_modules/pkg/index.js", "apps/mobile/node_modules/pkg/index.js",
                     "apps/ios-native/.build/cache", ".build-task213/cache",
                     "apps/desktop/src-tauri/target/debug/cache", "apps/mobile/android/app/build/cache",
                     "apps/android-native/app/build/cache", ".gradle/cache",
                     "apps/android-native/android/.gradle/cache", "apps/android-native/android/.kotlin/sessions/s",
                     "apps/android-native/android/build/cache", "apps/android-native/android/app/build/cache",
                     "apps/android-native/android/app/.cxx/cache", "apps/android-native/android/widget/build/cache",
                     "apps/android-native/android/app/src/main/assets/core-host.js",
                     "apps/ios-native/Resources/core-host.js", "apps/ios-native/Resources/label-keys.json",
                     "apps/ios-native/Sources/MindwtrNativeCore/Resources/sandbox-host.js",
                     "apps/mobile/.expo/types/router.d.ts", "apps/mobile/expo-env.d.ts",
                     "apps/mobile/modules/whisper-engine/.tests-tmp/run/x", "apps/desktop/dist/index.html",
                     "apps/desktop/src-tauri/gen/schemas/desktop-schema.json", ".venv-comments/pyvenv.cfg",
                     "coverage/index.html", "apps/mobile/coverage/lcov.info", "packages/core/coverage/lcov.info",
                     "scripts/ci/__pycache__/check.cpython-314.pyc", "apps/ios-native/scripts/__pycache__/x.pyc"):
            self.ignored_file(path)
        item = self.candidate(self.run_cleanup())
        self.assertEqual(item["decision"], "removed")

    def test_generated_native_project_source_not_allowed(self):
        self.ignored_file("apps/mobile/android/app/src/main/Generated.java")
        self.assert_skip("unknown_ignored_content")

    def test_generated_lookalikes_not_allowed(self):
        for relative in ("apps/ios-native/Resources/other.json", "apps/android-native/android/app/src/main/assets/extra.json",
                         "apps/mobile/modules/other-module/.tests-tmp/x", "apps/other/.cxx/cache", "packages/core/.perf/run.json"):
            with self.subTest(relative=relative):
                path = self.ignored_file(relative)
                self.assert_skip("unknown_ignored_content")
                path.unlink()

    def test_unknown_root_build_task_suffix_not_allowed(self):
        self.ignored_file(".build-task213-personal/cache")
        self.assert_skip("unknown_ignored_content")

    def test_allowlisted_group_with_tracked_source_skips(self):
        self.ignored_file("apps/ios-native/.build/owned.swift")
        self.git(self.worktree, "add", "-f", "apps/ios-native/.build/owned.swift")
        self.git(self.worktree, "commit", "-m", "tracked source inside build path")
        self.git(self.repo, "merge", "--ff-only", "retained-topic")
        self.git(self.repo, "push", "origin", "main")
        self.ignored_file("apps/ios-native/.build/generated")
        self.assert_skip("generated_path_contains_tracked_source")

    def test_verified_evidence_archive_exact_private_and_retained(self):
        self.ignored_file(".orchestrator/task packet/result 名.md", b"binary evidence\x00\xff")
        (self.worktree / ".orchestrator" / "empty directory").mkdir()
        self.age()
        expected = cleanup.evidence_manifest(self.worktree / ".orchestrator")
        item = self.candidate(self.run_cleanup())
        self.assertEqual(item["decision"], "removed")
        archive = Path(item["archive"])
        self.assertTrue(archive.exists())
        self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o600)
        cleanup.verify_archive(archive, expected)
        with archive.open("rb") as source:
            self.assertEqual(cleanup.sha256_stream(source), item["archive_sha256"])
        receipt = json.loads(Path(item["receipt"]).read_text())
        self.assertEqual(receipt["evidence_manifest"], expected)
        self.run_cleanup()
        self.assertTrue(archive.exists())

    def test_empty_evidence_needs_no_archive(self):
        (self.worktree / ".orchestrator").mkdir()
        self.age()
        item = self.candidate(self.run_cleanup())
        self.assertEqual(item["decision"], "removed")
        self.assertIsNone(item["archive"])

    def test_archive_low_space_preserves_source(self):
        self.ignored_file(".orchestrator/result.md")
        self.assert_skip("low_disk", free_bytes=lambda path: cleanup.ARCHIVE_RESERVE_BYTES, min_free_gb=0)
        self.assertEqual(list(self.archive_root.glob("*.tar.gz")), [])

    def test_archive_refused_when_it_would_cross_free_space_floor(self):
        self.ignored_file(".orchestrator/result.md")
        floor = 60 * 1024**3
        self.assert_skip("low_disk", free_bytes=lambda path: floor + cleanup.ARCHIVE_RESERVE_BYTES)
        self.assertEqual(list(self.archive_root.glob("*.tar.gz")), [])
        roomy = floor + 2 * cleanup.ARCHIVE_RESERVE_BYTES
        self.assertEqual(self.candidate(self.run_cleanup(free_bytes=lambda path: roomy))["decision"], "removed")

    def test_free_space_floor_is_configurable_and_validated(self):
        self.ignored_file(".orchestrator/result.md")
        self.assert_skip("low_disk", free_bytes=lambda path: 9 * 1024**3, min_free_gb=10)
        self.assertEqual(self.candidate(self.run_cleanup(free_bytes=lambda path: 11 * 1024**3, min_free_gb=10))["decision"], "removed")
        with self.assertRaisesRegex(cleanup.SafetyError, "invalid_min_free"):
            self.service(min_free_gb=-1)

    def test_archive_space_probe_failure_preserves_source(self):
        self.ignored_file(".orchestrator/result.md")
        def unavailable(path):
            raise OSError("private fixture error")
        self.assert_skip("archive_space_probe_failed", free_bytes=unavailable)

    def test_archive_verification_failure_removes_only_own_partial(self):
        self.ignored_file(".orchestrator/result.md")
        self.archive_root.mkdir(mode=0o700)
        old_archive = self.archive_root / "prior.tar.gz"
        old_archive.write_bytes(b"prior retained archive")
        with patch.object(cleanup, "verify_archive", side_effect=cleanup.SafetyError("archive_verification_failed")):
            self.assert_skip("archive_verification_failed")
        self.assertTrue(old_archive.exists())
        self.assertEqual(list(self.archive_root.glob(".partial-*")), [])

    def test_evidence_change_during_copy_preserves_source(self):
        evidence = self.ignored_file(".orchestrator/result.md")
        verify = cleanup.verify_archive
        def verify_then_change(*args):
            verify(*args)
            evidence.write_bytes(b"changed during archive")
        with patch.object(cleanup, "verify_archive", side_effect=verify_then_change):
            self.assert_skip("evidence_changed")
        self.assertEqual(list(self.archive_root.glob("*.tar.gz")), [])

    def test_archive_write_failure_preserves_source(self):
        self.ignored_file(".orchestrator/result.md")
        with patch.object(cleanup.tarfile, "open", side_effect=OSError("private fixture error")):
            report = self.assert_skip("archive_write_failed")
        self.assertNotIn("private fixture error", json.dumps(report))

    def test_fetch_failure_fails_closed_before_assessment(self):
        original = cleanup.run_git
        def failing_fetch(repo, *args, **kwargs):
            if args[0] == "fetch":
                raise cleanup.SafetyError("git_operation_failed")
            return original(repo, *args, **kwargs)
        with patch.object(cleanup, "run_git", side_effect=failing_fetch):
            report = self.run_cleanup()
        self.assertEqual(report["error"], "origin_main_fetch_failed")
        self.assertEqual(report["worktrees"], [])
        self.assertTrue(self.worktree.exists())

    def test_unavailable_process_probe_fails_closed(self):
        def unavailable(path):
            raise cleanup.SafetyError("process_probe_unavailable")
        self.assert_skip("process_probe_unavailable", probe=unavailable)

    def test_active_process_skips(self):
        self.assert_skip("active_process", probe=lambda path: True)

    def test_recheck_active_process_preserves_verified_archive(self):
        self.ignored_file(".orchestrator/result.md")
        calls = []
        def later_active(path):
            calls.append(path)
            return len(calls) > 1
        report = self.assert_skip("recheck_active_process", probe=later_active)
        self.assertTrue(Path(self.candidate(report)["archive"]).exists())

    def test_recheck_new_untracked_change_prevents_removal(self):
        service = self.service()
        archive = service.archive
        def archive_then_change(*args):
            result = archive(*args)
            (self.worktree / "new source.txt").write_text("concurrent edit")
            return result
        service.archive = archive_then_change
        item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "recheck_dirty_or_untracked")
        self.assertTrue(self.worktree.exists())

    def test_recheck_lock_prevents_removal(self):
        service = self.service()
        archive = service.archive
        def archive_then_lock(*args):
            result = archive(*args)
            self.git(self.repo, "worktree", "lock", str(self.worktree))
            return result
        service.archive = archive_then_lock
        item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "recheck_locked_or_prunable")
        self.assertTrue(self.worktree.exists())

    def test_recheck_changed_head_prevents_removal(self):
        service = self.service()
        archive = service.archive
        def archive_then_commit(*args):
            result = archive(*args)
            (self.worktree / "source.txt").write_text("new commit during copy")
            self.git(self.worktree, "commit", "-am", "concurrent new commit")
            self.git(self.repo, "merge", "--ff-only", "retained-topic")
            self.git(self.repo, "push", "origin", "main")
            self.age()
            return result
        service.archive = archive_then_commit
        item = self.candidate(service.run(apply=True))

        self.assertEqual(item["reason"], "recheck_not_merged_into_origin_main")
        self.assertTrue(self.worktree.exists())

    def test_recheck_missing_registration_preserves_source(self):
        service = self.service()
        original = cleanup.registrations
        calls = []
        def changing_registration(repo):
            calls.append(repo)
            records = original(repo)
            if len(calls) > 1:
                return [item for item in records if item["path"] != str(self.worktree)]
            return records
        with patch.object(cleanup, "registrations", side_effect=changing_registration):
            item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "registration_changed")
        self.assertTrue(self.worktree.exists())

    def test_final_receipt_failure_keeps_prepared_receipt_and_reports_removed(self):
        original = cleanup.atomic_json
        def fail_completion(path, value, **kwargs):
            if value.get("status") == "removed":
                raise cleanup.SafetyError("report_write_failed")
            return original(path, value, **kwargs)
        with patch.object(cleanup, "atomic_json", side_effect=fail_completion):
            item = self.candidate(self.run_cleanup())
        self.assertEqual((item["decision"], item["reason"]), ("removed", "removed_receipt_completion_failed"))
        self.assertFalse(self.worktree.exists())
        self.assertEqual(json.loads(Path(item["receipt"]).read_text())["status"], "prepared")

    def test_evidence_created_during_receipt_write_is_rechecked_before_removal(self):
        self.ignored_file(".orchestrator/result.md")
        original = cleanup.atomic_json
        def receipt_then_new_evidence(path, value, **kwargs):
            result = original(path, value, **kwargs)
            if value.get("status") == "prepared":
                self.ignored_file(".orchestrator/new-after-receipt.md", b"new owned evidence")
            return result
        with patch.object(cleanup, "atomic_json", side_effect=receipt_then_new_evidence):
            report = self.assert_skip("evidence_changed")
        item = self.candidate(report)
        self.assertTrue((self.worktree / ".orchestrator/new-after-receipt.md").exists())
        self.assertTrue(Path(item["archive"]).exists())

    def test_recheck_evidence_bytes_not_just_old_mtime(self):
        evidence = self.ignored_file(".orchestrator/result.md")
        service = self.service()
        archive = service.archive
        def archive_then_change(*args):
            result = archive(*args)
            evidence.write_bytes(b"different evidence")
            self.age()
            return result
        service.archive = archive_then_change
        item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "evidence_changed")
        self.assertTrue(self.worktree.exists())
        self.assertTrue(Path(item["archive"]).exists())

    def test_duplicate_invocations_safe_and_global_lock_excludes_overlap(self):
        service = self.service()
        service.lock()
        try:
            report = self.run_cleanup()
            self.assertEqual(report["error"], "cleanup_already_running")
            self.assertTrue(self.worktree.exists())
        finally:
            os.close(service.lock_descriptor)
            service.lock_descriptor = None
        self.assertEqual(self.candidate(self.run_cleanup())["decision"], "removed")
        report = self.run_cleanup()
        self.assertNotIn(str(self.worktree), [item["path"] for item in report["worktrees"]])

    def test_machine_lock_is_shared_across_archive_roots(self):
        holder = cleanup.Cleanup(self.repo, self.root, self.base / "other archives", now=lambda: self.now,
                                 probe=lambda path: False, lock_path=self.base / "machine cleanup.lock")
        holder.lock()
        try:
            report = self.run_cleanup()
            self.assertEqual(report["error"], "cleanup_already_running")
            self.assertTrue(self.worktree.exists())
        finally:
            os.close(holder.lock_descriptor)
            holder.lock_descriptor = None
        self.assertEqual(self.candidate(self.run_cleanup())["decision"], "removed")

    def test_unavailable_or_unsafe_machine_lock_fails_closed(self):
        report = self.run_cleanup(lock_path=self.base / "missing parent" / "cleanup.lock")
        self.assertEqual(report["error"], "cleanup_lock_unavailable")
        shared = self.base / "machine cleanup.lock"
        shared.write_bytes(b"")
        shared.chmod(0o644)
        self.assertEqual(self.run_cleanup()["error"], "cleanup_lock_unsafe")
        self.assertTrue(self.worktree.exists())

    def test_default_lock_is_outside_any_archive_root(self):
        self.assertEqual(cleanup.DEFAULT_LOCK_PATH, Path.home() / ".local" / "state" / "mindwtr-worktree-cleanup.lock")
        self.assertEqual(self.service(lock_path=cleanup.DEFAULT_LOCK_PATH).lock_path, cleanup.DEFAULT_LOCK_PATH)

    def land_on_main(self, files):
        for relative, data in files.items():
            (self.repo / relative).write_bytes(data)
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "landed on main")
        self.git(self.repo, "push", "origin", "main")

    def test_dirty_changes_byte_equal_to_origin_main_are_retired(self):
        self.land_on_main({"source.txt": b"landed source\n", "landed.txt": b"landed new file\n", "staged.txt": b"staged\n"})
        (self.worktree / "source.txt").write_bytes(b"landed source\n")
        (self.worktree / "landed.txt").write_bytes(b"landed new file\n")
        (self.worktree / "staged.txt").write_bytes(b"staged\n")
        self.git(self.worktree, "add", "staged.txt")
        self.age()
        preview = self.candidate(self.run_cleanup(apply=False))
        self.assertEqual((preview["decision"], preview["reason"], preview["change_proof"], preview["changed_path_count"]),
                         ("eligible", "merged_inactive_changes_on_origin_main", "bytes_equal_origin_main", 3))
        self.assertEqual((self.worktree / "landed.txt").read_bytes(), b"landed new file\n")
        item = self.candidate(self.run_cleanup())
        self.assertEqual(item["decision"], "removed")
        self.assertFalse(self.worktree.exists())
        self.assertEqual(self.git(self.repo, "rev-parse", "retained-topic"), self.git(self.repo, "rev-parse", "HEAD~1"))

    def test_dirty_changes_that_differ_from_origin_main_skip(self):
        self.land_on_main({"source.txt": b"landed source\n", "landed.txt": b"landed new file\n"})
        for relative, data in (("landed.txt", b"landed new file, local edit\n"), ("source.txt", b"local only\n")):
            with self.subTest(relative=relative):
                (self.worktree / relative).write_bytes(data)
                self.age()
                self.assert_skip("dirty_or_untracked")
                self.assertEqual((self.worktree / relative).read_bytes(), data)
                self.git(self.worktree, "checkout", "--", "source.txt")
                (self.worktree / "landed.txt").unlink(missing_ok=True)

    def test_mode_change_not_on_origin_main_skips(self):
        (self.worktree / "source.txt").chmod(0o755)
        self.age()
        self.assert_skip("dirty_or_untracked")

    def test_dirty_diff_that_reverse_applies_to_origin_main_is_retired(self):
        lines = [b"line %d\n" % number for number in range(20)]
        self.land_on_main({"source.txt": b"".join(lines)})
        self.git(self.worktree, "merge", "--ff-only", "origin/main")
        topic_change = lines.copy()
        topic_change[2] = b"topic change\n"
        self.land_on_main({"source.txt": b"".join(topic_change[:-1] + [b"later main change\n"])})
        (self.worktree / "source.txt").write_bytes(b"".join(topic_change))
        self.age()
        item = self.candidate(self.run_cleanup(apply=False))
        self.assertEqual((item["decision"], item["change_proof"]), ("eligible", "diff_reverse_applies_to_origin_main"))
        self.assertEqual(self.candidate(self.run_cleanup())["decision"], "removed")
        self.assertFalse(self.worktree.exists())

    def test_change_made_after_proof_prevents_discard(self):
        self.land_on_main({"landed.txt": b"landed new file\n"})
        (self.worktree / "landed.txt").write_bytes(b"landed new file\n")
        self.age()
        service = self.service()
        archive = service.archive
        def archive_then_edit(*args):
            result = archive(*args)
            (self.worktree / "landed.txt").write_bytes(b"edited after proof\n")
            self.age()
            return result
        service.archive = archive_then_edit
        item = self.candidate(service.run(apply=True))
        self.assertEqual(item["reason"], "recheck_dirty_or_untracked")
        self.assertEqual((self.worktree / "landed.txt").read_bytes(), b"edited after proof\n")

    def test_git_remove_never_uses_force(self):
        commands = []
        original = cleanup.run_git
        def recording(repo, *args, **kwargs):
            commands.append(args)
            return original(repo, *args, **kwargs)
        with patch.object(cleanup, "run_git", side_effect=recording):
            self.run_cleanup()
        removals = [args for args in commands if args[:2] == ("worktree", "remove")]
        self.assertEqual(removals, [("worktree", "remove", "--", str(self.worktree))])
        self.assertFalse(any("--force" in args or "reset" in args or "clean" in args for args in commands))

    def test_archive_root_inside_source_or_nonprivate_rejected(self):
        with self.assertRaisesRegex(cleanup.SafetyError, "archive_root_inside_source"):
            cleanup.Cleanup(self.repo, self.root, self.worktree / "archives")
        self.archive_root.mkdir(mode=0o755)
        report = self.run_cleanup()
        self.assertEqual(report["error"], "archive_root_must_be_private_owned_directory")
        self.assertTrue(self.worktree.exists())

    def test_report_is_atomic_private_and_must_stay_outside_source(self):
        self.archive_root.mkdir(mode=0o700)
        report_path = self.archive_root / "latest-preview.json"
        with patch.object(cleanup, "Cleanup", return_value=self.service()), contextlib.redirect_stdout(io.StringIO()):
            result = cleanup.main(["--repo", str(self.repo), "--worktree-root", str(self.root),
                                   "--archive-root", str(self.archive_root), "--report", str(report_path)])
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(report_path.read_text())["mode"], "dry-run")
        self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
        output = io.StringIO()
        with patch.object(cleanup, "Cleanup", return_value=self.service()), contextlib.redirect_stdout(output):
            result = cleanup.main(["--repo", str(self.repo), "--worktree-root", str(self.root),
                                   "--archive-root", str(self.archive_root), "--apply", "--report", str(self.worktree / "report.json")])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["error"], "report_path_not_designated")
        self.assertTrue(self.worktree.exists())

    def test_report_cannot_overwrite_archive_receipt_or_lock_inside_or_outside_archive_root(self):
        self.archive_root.mkdir(mode=0o700)
        for target in (self.archive_root / "retained.tar.gz", self.archive_root / "retirement-prior.json",
                       self.archive_root / ".cleanup.lock", self.archive_root / ".partial-prior",
                       self.base / "retirement-external.json", self.base / "latest-apply.json"):
            with self.subTest(target=target.name):
                target.write_bytes(b"retained artifact")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = cleanup.main(["--repo", str(self.repo), "--worktree-root", str(self.root),
                                           "--archive-root", str(self.archive_root), "--apply", "--report", str(target)])
                self.assertEqual(result, 1)
                self.assertEqual(json.loads(output.getvalue())["error"], "report_path_not_designated")
                self.assertEqual(target.read_bytes(), b"retained artifact")
                self.assertTrue(self.worktree.exists())

    def test_designated_report_name_cannot_overwrite_renamed_non_report_data(self):
        self.archive_root.mkdir(mode=0o700)
        target = self.archive_root / "latest-apply.json"
        for data in (b"not JSON archive data", b'{"version":1,"status":"removed","path":"retained receipt"}'):
            with self.subTest(data=data):
                target.write_bytes(data)
                target.chmod(0o600)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = cleanup.main(["--repo", str(self.repo), "--worktree-root", str(self.root),
                                           "--archive-root", str(self.archive_root), "--apply", "--report", str(target)])
                self.assertEqual(result, 1)
                self.assertEqual(json.loads(output.getvalue())["error"], "report_existing_content_not_report")
                self.assertEqual(target.read_bytes(), data)
                self.assertTrue(self.worktree.exists())

    def test_lsof_no_match_active_and_uncertain_exit_contract(self):
        for code, stdout, stderr, expected in [(1, b"", b"", False), (0, b"p123\0", b"", True),
                                               (1, b"", b"warning", "process_probe_failed"),
                                               (2, b"", b"", "process_probe_failed")]:
            with self.subTest(code=code, stderr=stderr), patch.object(cleanup.subprocess, "run", return_value=subprocess.CompletedProcess([], code, stdout, stderr)):
                if isinstance(expected, bool):
                    self.assertEqual(cleanup.process_active(self.worktree), expected)
                else:
                    with self.assertRaisesRegex(cleanup.SafetyError, expected):
                        cleanup.process_active(self.worktree)


if __name__ == "__main__":
    unittest.main()
