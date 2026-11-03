import importlib.util
import datetime
import hashlib
import os
import pathlib
import plistlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('watch_bundle', pathlib.Path(__file__).with_name('validate-watch-bundle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WatchBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = pathlib.Path(self.temp.name) / 'Mindwtr.app'
        self.host = dict(CFBundleIdentifier='tech.example.mindwtr', CFBundleVersion='42', CFBundleShortVersionString='1.2.9', MindwtrWatchEnabled=False)
        self.write(self.app, self.host)

    def write(self, path, info):
        path.mkdir(parents=True, exist_ok=True)
        (path / 'Info.plist').write_bytes(plistlib.dumps(info))

    def enable(self):
        self.host['MindwtrWatchEnabled'] = True
        self.write(self.app, self.host)
        self.watch_path = self.app / 'Watch/MindwtrWatch.app'
        self.watch = dict(self.host, CFBundleIdentifier='tech.example.mindwtr.watchkitapp', WKCompanionAppBundleIdentifier='tech.example.mindwtr')
        self.widget = dict(self.host, CFBundleIdentifier='tech.example.mindwtr.watchkitapp.widgets')
        self.write(self.watch_path, self.watch)
        self.write(self.watch_path / 'PlugIns/MindwtrWatchWidgets.appex', self.widget)

    def test_stable_without_watch(self):
        module.validate(self.app, False)

    def test_beta_requires_both_targets(self):
        with self.assertRaises(ValueError):
                module.validate(self.app, True)
        self.enable()
        module.validate(self.app, True)
        (self.watch_path / 'PlugIns/MindwtrWatchWidgets.appex/Info.plist').unlink()
        with self.assertRaises(OSError):
            module.validate(self.app, True)

    def test_stable_rejects_embedded_watch(self):
        self.enable()
        with self.assertRaises(ValueError):
            module.validate(self.app, False)

    def test_beta_rejects_mismatched_companion_and_versions(self):
        self.enable()
        for field, value in [('WKCompanionAppBundleIdentifier', 'other'), ('CFBundleVersion', '41'), ('CFBundleIdentifier', 'other'), ('WKRunsIndependentlyOfCompanionApp', True)]:
            with self.subTest(field=field):
                self.write(self.watch_path, dict(self.watch, **{field: value}))
                with self.assertRaises(ValueError):
                    module.validate(self.app, True)
        self.write(self.watch_path, self.watch)
        self.write(self.watch_path / 'PlugIns/MindwtrWatchWidgets.appex', dict(self.widget, CFBundleShortVersionString='1.2.8'))
        with self.assertRaises(ValueError):
            module.validate(self.app, True)


class WatchProfileCertificateTests(unittest.TestCase):
    def run_installer(self, certificates, identity='Apple Distribution: Fixture', duplicate=False):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            expected = hashlib.sha1(b'ci-certificate').hexdigest().upper()
            security = root / 'security'
            lines = f'  1) {expected} "Apple Distribution: Fixture"\n'
            if duplicate:
                lines += f'  2) {"A" * 40} "Apple Distribution: Fixture"\n'
            security.write_text('#!/usr/bin/env python3\nprint(' + repr(lines) + ')\n')
            security.chmod(0o755)
            profile = root / 'profile.plist'
            profile.write_bytes(plistlib.dumps({
                'DeveloperCertificates': certificates,
                'TeamIdentifier': ['TEAM'],
                'Entitlements': {
                    'application-identifier': 'TEAM.example.watch',
                    'com.apple.security.application-groups': ['group.example.watch'],
                },
                'ExpirationDate': datetime.datetime(2099, 1, 1),
                'UUID': 'fixture-profile', 'Name': 'Fixture Watch',
            }))

            script = pathlib.Path(__file__).with_name('install-watch-profiles.sh').read_text()
            python = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
            result = subprocess.run(
                ['python3', '-', str(profile), 'example.watch', 'WATCH', str(profile)],
                input=python, text=True, capture_output=True,
                env={**os.environ, 'HOME': str(root), 'PATH': f'{root}:{os.environ["PATH"]}',
                     'IOS_SIGNING_IDENTITY': identity, 'KEYCHAIN_PATH': 'fixture',
                     'EXPECTED_TEAM_ID': 'TEAM', 'EXPECTED_WATCH_APP_GROUP': 'group.example.watch',
                     'GITHUB_ENV': str(root / 'github-env')},
            )
            installed = (root / 'Library/MobileDevice/Provisioning Profiles/fixture-profile.mobileprovision').exists()
            return result, installed

    def test_matching_ci_certificate_is_required_before_installation(self):
        result, installed = self.run_installer([b'wrong-certificate'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('profile does not include the CI signing certificate', result.stderr)
        self.assertFalse(installed)

    def test_matching_certificate_by_name_or_fingerprint(self):
        for identity in ['Apple Distribution: Fixture', hashlib.sha1(b'ci-certificate').hexdigest()]:
            with self.subTest(identity=identity):
                result, installed = self.run_installer([b'other-certificate', b'ci-certificate'], identity)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(installed)

    def test_missing_or_ambiguous_identity_is_rejected(self):
        for identity, duplicate in [('not-installed', False), ('Apple Distribution: Fixture', True)]:
            with self.subTest(identity=identity, duplicate=duplicate):
                result, installed = self.run_installer([b'ci-certificate'], identity, duplicate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('could not uniquely resolve', result.stderr)
                self.assertFalse(installed)


if __name__ == '__main__':
    unittest.main()
