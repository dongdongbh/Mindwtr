#!/usr/bin/env python3
"""Exercise the real CI preparation command without touching host APT sources."""
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("prepare-ubuntu-apt.py")


class PrepareUbuntuAptTest(unittest.TestCase):
    def prepare(self, files):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for name, content in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            command = [sys.executable, str(SCRIPT), str(root)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            result = {name: (root / name).read_text() for name in files}
            subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(result, {name: (root / name).read_text() for name in files})
            return result

    def test_disables_vendor_entries_without_removing_ubuntu_from_mixed_list(self):
        ubuntu = "deb mirror+file:/etc/apt/apt-mirrors.txt noble main restricted\n"
        chrome = "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome-stable/deb/ stable main\n"
        microsoft = "deb-src https://packages.microsoft.com/repos/code stable main\n"
        original = ubuntu + chrome + microsoft
        actual = self.prepare({"sources.list": original})["sources.list"]
        self.assertEqual(actual, ubuntu + "# CI disabled unused vendor feed: " + chrome
                         + "# CI disabled unused vendor feed: " + microsoft)

    def test_preserves_comments_other_hosts_and_disabled_files(self):
        untouched = "# deb https://dl.google.com/linux/chrome/deb stable main\n" \
            "deb https://example.com/ubuntu noble main # packages.microsoft.com\n" \
            "deb https://packages.microsoft.com.example.org/ubuntu noble main\n"
        files = {"sources.list.d/other.list": untouched,
                 "sources.list.d/google.list.disabled": "deb https://dl.google.com/linux/chrome/deb stable main\n",
                 "apt-mirrors.txt": "http://azure.archive.ubuntu.com/ubuntu\n"}
        self.assertEqual(self.prepare(files), files)

    def test_disables_deb822_vendor_stanza_and_preserves_ubuntu_stanza(self):
        google = "Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\nSuites: stable\nComponents: main\nEnabled: yes\n"
        ubuntu = "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main\n"
        actual = self.prepare({"sources.list.d/mixed.sources": google + "\n" + ubuntu})
        self.assertEqual(actual["sources.list.d/mixed.sources"], google.replace("Enabled: yes", "Enabled: no") + "\n" + ubuntu)

    def test_handles_deb822_multiline_uris_without_disabling_retained_uri(self):
        original = "Types: deb\nURIs: https://packages.microsoft.com/ubuntu/24.04/prod\n https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main\n"
        actual = self.prepare({"sources.list.d/mixed.sources": original})
        self.assertEqual(actual["sources.list.d/mixed.sources"], "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main\n")

    def test_adds_enabled_no_without_existing_field_or_final_newline(self):
        original = "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb\nSuites: stable\nComponents: main"
        actual = self.prepare({"sources.list.d/google.sources": original})
        self.assertEqual(actual["sources.list.d/google.sources"], original + "\nEnabled: no\n")

    def test_empty_sources_is_noop(self):
        self.assertEqual(self.prepare({}), {})

    def test_ci_prepares_both_install_paths_and_runs_regressions(self):
        workflow = (SCRIPT.parents[2] / ".github/workflows/ci.yml").read_text()
        desktop = workflow.split("name: Desktop App (Tauri)", 1)[1].split("- name: Setup Rust", 1)[0]
        e2e = workflow.split("name: E2E (Web)", 1)[1].split("- name: Run E2E tests", 1)[0]
        for job in (desktop, e2e):
            self.assertIn("sudo python3 scripts/ci/prepare-ubuntu-apt.py", job)
        self.assertIn("python3 scripts/ci/prepare-ubuntu-apt.test.py", workflow)

    @unittest.skipUnless(shutil.which("apt-get"), "APT integration runs on Ubuntu CI")
    def test_apt_no_longer_requests_vendor_indexes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            sources = root / "sources.list.d"
            sources.mkdir()
            (root / "state/lists/partial").mkdir(parents=True)
            (root / "sources.list").write_text(
                "deb http://archive.ubuntu.com/ubuntu noble main\n"
                "deb https://dl.google.com/linux/chrome-stable/deb stable main\n")
            (sources / "microsoft.sources").write_text(
                "Types: deb\nURIs: https://packages.microsoft.com/ubuntu/24.04/prod\n"
                "Suites: noble\nComponents: main\n")
            # --print-uris uses APT's real parser without fetching or installing.
            command = ["apt-get", "-o", f"Dir::Etc::sourcelist={root / 'sources.list'}",
                       "-o", f"Dir::Etc::sourceparts={sources}",
                       "-o", f"Dir::State={root / 'state'}", "--print-uris", "update"]
            before = subprocess.run(command, check=True, capture_output=True, text=True).stdout
            self.assertIn("dl.google.com", before)
            self.assertIn("packages.microsoft.com", before)
            subprocess.run([sys.executable, str(SCRIPT), str(root)], check=True, capture_output=True)
            after = subprocess.run(command, check=True, capture_output=True, text=True).stdout
            self.assertNotIn("dl.google.com", after)
            self.assertNotIn("packages.microsoft.com", after)
            self.assertIn("archive.ubuntu.com", after)


if __name__ == "__main__":
    unittest.main()
