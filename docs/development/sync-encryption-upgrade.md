# Sync encryption format upgrade

The v1.3.9 upgrade changes the authenticated container version to 2. The `MWENC1` magic and header layout remain unchanged. The associated data is the header followed by UTF-8 `mindwtr-sync:2`, a NUL separator, the role, another NUL separator, and the logical identity. Primitive callers must supply the context explicitly.

| Role | Logical identity |
| --- | --- |
| `document` | `data.json`, including its backup and recovery generations |
| `attachment` | Canonical relative `attachments/...` cloud key |
| `recovery` | Stable original relative artifact name for retained transition generations, opaque keyed archive identifier, or `legacy-inventory` for the recovery inventory |

Normal readers reject version 1 and reject plaintext attachments while encryption is enabled. The explicit upgrade is the only legacy-decryption path. It uses a durable canonical local library, compares the remote document against that library without adopting remote data, and verifies referenced attachment bytes against trusted local hashes. A plaintext attachment can be upgraded only after that hash check. Missing, unreadable, fallback or mismatched sources stop the operation.

The desktop source reader opens canonical SQLite read-only without initialization, migration or JSON/backup fallback. Mobile source readers use their canonical SQLite adapter. File Sync keeps its existing lease through the operation; other transports retain conditional-write and mutation-fence checks. Publication of the new canonical document follows attachment verification and preservation of the old artifacts. An incomplete upgrade can be retried; ordinary sync cannot bypass its transition journal.

This upgrade requires an encrypted canonical document matching the trusted local library. It does not automatically repair older incomplete enable or passphrase-change operations, mixed-key histories, or a partially enabled location with only a plaintext canonical document and legacy encrypted attachments. Those states refuse without deleting bytes and require assisted reconciliation from trusted local copies and retained artifacts. Retrying an old transition is not permission to bypass version-1 rejection.

## Retained recovery material

The upgrade preserves the exact original bytes inside encrypted recovery containers. This includes original encrypted bytes, which are wrapped again rather than reinterpreted. Plaintext originals are never left as plaintext recovery archives.

- `.mindwtr-legacy-<archive-id>.bin` authenticates with recovery identity `<archive-id>` and unwraps to the exact original artifact bytes.
- `.mindwtr-legacy-inventory-<inventory-id>.json.enc` authenticates with recovery identity `legacy-inventory`. Its decrypted JSON maps the stable original relative name to `preservedName`, `sourceSha256` and `encoding=recovery-v2`.
- Archive and inventory identifiers use domain-separated HMAC-SHA256 under the upgrade key. Unkeyed original content hashes remain inside the encrypted inventory, so filenames do not expose dictionary-testable plaintext fingerprints. Existing archive and inventory names are verified, never overwritten. Ephemeral provider handles are not recovery names.
- Normal sync, cleanup, recovery discovery, passphrase changes and encryption disabling exclude these reserved historical files. Retain the passphrase used for the upgrade even after changing the active passphrase.

## Assisted recovery

Work on a separate copy of the complete sync folder with automatic sync stopped. Never restore directly over the active canonical document.

Use `inspectSyncArtifact` and `deriveSyncKeyMaterial` from `packages/core/src/sync-crypto.ts` with the upgrade passphrase and the retained container's own salt/KDF parameters. Authenticate the inventory with `decryptSyncArtifact` using its recovery context, and verify its keyed inventory identifier using the format’s domain-separated HMAC. For each selected entry, authenticate the archive with its opaque archive identifier as the recovery identity and verify the recovered bytes against `sourceSha256`.

Treat recovered names and contents as untrusted historical evidence. Validate names as relative paths without traversal, device paths or absolute prefixes before writing them into a separate empty recovery directory. Unwrapping restores the original bytes, which may still be encrypted under their original historical format/passphrase. It does not certify those historical documents as safe to merge. Inspect and reconcile them against trusted local copies before any import or publication. No automatic restore or legacy-format fallback is provided.

The provider's own version history is separate and remains subject to its original encryption and retention rules. The archives require additional storage; transport capacity checks must include the recovery wrapper and encrypted inventory before mutation.
