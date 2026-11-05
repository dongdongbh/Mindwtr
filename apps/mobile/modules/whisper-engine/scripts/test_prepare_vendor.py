import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_vendor


class PreparationTests(unittest.TestCase):
    def setUp(self):
        root = prepare_vendor.PACKAGE_ROOT / ".tests-tmp"
        root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "installed"
        self.source.mkdir()
        (self.source / "package.json").write_text(json.dumps({"name": "whisper.rn", "version": "0.5.4"}))
        (self.source / "LICENSE").write_text("MIT License\nfixture")
        self.framework = self.source / "ios/rnwhisper.xcframework"
        hashes = {}
        for name in prepare_vendor.KNOWN_HASHES:
            target = self.framework / name
            target.parent.mkdir(parents=True, exist_ok=True)
            content = name.encode()
            target.write_bytes(content)
            hashes[name] = hashlib.sha256(content).hexdigest()
        (self.framework / "ios-arm64_x86_64-simulator/rnwhisper.framework/Headers").mkdir()
        (self.framework / "ios-arm64_x86_64-simulator/rnwhisper.framework/Headers/whisper.h").write_text("fixture")
        self.hashes = patch.object(prepare_vendor, "KNOWN_HASHES", hashes)
        self.hashes.start(); self.addCleanup(self.hashes.stop)
        self.destination = self.root / "Vendor"

    def test_prepares_once_and_reuses_only_exact_verified_content(self):
        first = prepare_vendor.prepare(self.source, self.destination)
        self.assertEqual(first[1], "prepared")
        self.assertEqual(prepare_vendor.prepare(self.source, self.destination), (first[0], "verified reuse"))
        module = self.destination / "rnwhisper.xcframework/ios-arm64/rnwhisper.framework/Modules/module.modulemap"
        self.assertEqual(module.read_bytes(), prepare_vendor.MODULE_MAP)
        module.write_text("changed")
        with self.assertRaisesRegex(ValueError, "refusing replacement"):
            prepare_vendor.prepare(self.source, self.destination)
        self.assertEqual(module.read_text(), "changed")

    def test_rejects_wrong_version_wrong_hash_symlink_and_unowned_destination(self):
        metadata = self.source / "package.json"
        original = metadata.read_text(); metadata.write_text('{"name":"whisper.rn","version":"0.5.5"}')
        with self.assertRaisesRegex(ValueError, "locked"):
            prepare_vendor.prepare(self.source, self.destination)
        metadata.write_text(original)
        binary = self.framework / next(iter(prepare_vendor.KNOWN_HASHES))
        original_binary = binary.read_bytes(); binary.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "hash"):
            prepare_vendor.prepare(self.source, self.destination)
        binary.write_bytes(original_binary)
        (self.framework / "unexpected-link").symlink_to(binary)
        with self.assertRaisesRegex(ValueError, "regular"):
            prepare_vendor.prepare(self.source, self.destination)
        (self.framework / "unexpected-link").unlink()
        self.destination.mkdir(); marker = self.destination / "keep"; marker.write_text("untouched")
        with self.assertRaisesRegex(ValueError, "refusing replacement"):
            prepare_vendor.prepare(self.source, self.destination)
        self.assertEqual(marker.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
