# Apple CI output retention

The self-hosted Apple lanes write generated outputs to `/Volumes/DevSSD/ci/mindwtr-ci`. Compiler caches live in `caches/<Xcode fingerprint>`; evidence, unsigned archives and temporary files live in `jobs/<run>-<attempt>-<job>`. `MINDWTR_APPLE_TEMP` selects the job directory without overriding Actions' reserved `RUNNER_TEMP`. `TMPDIR`, Swift package scratch paths, SwiftUI DerivedData, Watch outputs and React Native simulator/archive DerivedData use that SSD namespace. GitHub-hosted lanes retain their existing paths.

`apple_ci_storage.py` checks the configured DevSSD UUID, APFS format, external status, enabled ownership, a real separate mount, and its writable mount-table entry. It requires an administrator-provisioned mode 0700 CI namespace, trusted prefix ownership, effective account access, and account-owned descendants without shared write access or symlinks. The existing named CI account ACL is supported. Missing or incorrect storage fails before directory creation; there is no internal fallback or automatic permission change. Both Apple jobs use this guard before every shell step, checking all exported build paths and known product/archive destinations again before execution. Cleanup revalidates storage before each generated directory removal.

The internal HOME volume must retain at least **12 GiB** at startup and before archive. The actual SSD archive volume must have at least **20 GiB**. If internal space is low at startup, only named legacy compiler products under the account's former `Library/Caches/MindwtrNativeCI/<fingerprint>` directories are eligible for cleanup. Legacy logs, dependency caches, unknown directories, other accounts, and existing archives remain. Device/runtime data, Xcode, credentials, Keychains, CocoaPods and node_modules stay in place.

Simulator screenshots use a unique temporary PNG in the internal `RUNNER_TEMP`, then the approved runner moves it into the SSD evidence directory. This avoids requiring the separate Simulator screenshot service to access removable storage. Failed captures remove their temporary file and preserve any previously published image.

The self-hosted Apple lanes retire generated build outputs after uploading their job evidence. Cleanup also runs after a failed build when artifact upload succeeds. If upload fails, the current outputs remain for diagnosis. Job-specific artifact paths keep evidence from different runs separate.

`scripts/ci/cleanup-apple-outputs.py` accepts `swiftui`, `ios`, or `ios-pre-archive` in GitHub Actions. It verifies the runner account roots, job identity and current Xcode cache fingerprint, refuses symlink roots or candidate directories, and validates all candidates before deleting any. It removes only named product/intermediate directories. Xcode 27 SwiftPM uses `<scratch>/out` (the `debug` symlink points to `out/Products/Debug`). Dependency checkouts, repositories, downloaded artifacts, CocoaPods, node_modules, build logs, unknown directories, and other compiler generations remain.

SwiftUI validation retains a combined log as a GitHub artifact for 14 days. The React Native lane uploads its simulator evidence before pre-archive product retirement, then uploads its build logs and new unsigned validation archive before retiring that local archive and build products. Watch products/intermediates have explicit dedicated paths. This helper does not migrate or delete existing archives, remove simulators, worktrees or branches, or restart the runner.

Run its isolated filesystem regressions with:

```sh
TMPDIR=/home/dd/scratch/apple-ci-ssd-tests python3 -m unittest discover -s scripts/ci -p test_cleanup_apple_outputs.py -v
```

A killed worker or full disk may prevent all final steps. Successful fixture tests prove guard and cleanup boundaries; the next self-hosted workflow run must separately confirm account ACL access, SSD output paths, upload and retirement, and the unsigned archive. Read-only mount verification does not establish that CI ran successfully.
