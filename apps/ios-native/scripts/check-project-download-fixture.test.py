"""Synthetic preflight regression; creates no app/device state."""
import hashlib
from pathlib import Path
import runpy
import tempfile

check = runpy.run_path(str(Path(__file__).with_name("check-project-download-fixture.py")))["check"]
with tempfile.TemporaryDirectory(prefix="download-fixture-", dir=Path.home()) as directory:
    root = Path(directory)
    (root / "mindwtr.sqlite").touch()
    file = root / "attachment-files/documents/attachments/synthetic.txt"
    targets = {"documents/attachments/synthetic.txt": hashlib.sha256(b"synthetic").hexdigest()}
    request = {"method": "GET", "route": "/v1/attachments/:path"}
    assert check(root, "absent", targets, [], 0)["managedFiles"] == 0
    def refused(state="absent", requests=None):
        try:
            check(root, state, targets, requests or [], 0)
        except ValueError:
            return
        raise AssertionError("Invalid precondition accepted")
    refused(requests=[request])
    refused("cached")
    file.parent.mkdir(parents=True)
    file.write_bytes(b"synthetic")
    refused()  # Settings Save prefetch must invalidate an absent-file test.
    assert check(root, "cached", targets, [request], 1)["managedFiles"] == 1
    file.write_bytes(b"wrong")
    refused("cached")
    file.unlink()
    file.mkdir()
    refused()  # An unsafe directory is not proven file absence.
    file.rmdir()
    journal = root / "mindwtr.sqlite.pending.json"
    journal.write_text("{}")
    refused()
    journal.unlink()
    file.symlink_to(root / "mindwtr.sqlite")
    refused()
print("PASS: absent/cached bytes, prefetch, pending journal, network boundary, symlink refusal")
