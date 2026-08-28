# ADR 0011: Attachment Sync Model

Date: 2026-04-24
Status: Accepted

## Context

Tasks and projects can reference attachments, but attachment bytes have different constraints from structured GTD data:

- files can be much larger than the JSON snapshot
- local file URIs are device-specific
- remote object paths must survive sync across devices
- upload/download progress is useful locally but should not create remote churn
- deletes need tombstone-style cleanup so remote orphan files do not accumulate

Mixing binary attachment transfer directly into the main JSON snapshot would make ordinary task sync slower and harder to recover.

## Decision

Mindwtr treats attachment metadata as part of task/project data and attachment bytes as a separate transfer stream.

The metadata contract is:

1. `cloudKey`, `mimeType`, `size`, and `fileHash` can sync because they describe the remote object.
2. `uri` is local-device state and is excluded from remote comparison.
3. `localStatus` tracks local availability and transfer state. `pendingContentUpload` is the durable local retry marker for a byte replacement that has not reached its remote object yet. Both are persisted locally but excluded from remote comparison.
4. Attachment deletes use soft-delete metadata first, then background cleanup removes orphaned local files and remotely versioned WebDAV/Cloud objects. File Sync generations are retained as described below.
5. Task editors may copy bytes into app-managed storage before Save, but draft settlement is planned in core from the baseline, draft, and actually committed records. Platform adapters may delete a candidate only after proving that its URI is the attachment-id-named file inside their managed attachments directory.

The transfer contract is:

1. Structured data sync can converge without downloading every attachment first.
2. Attachment upload/download is backend-specific but must update local metadata through the same task/project records.
3. Merge logic must preserve a usable local URI when two devices have different valid local paths for the same attachment.
4. Versioned remote deletes are retried through attachment cleanup state rather than blocking the main sync cycle indefinitely.
5. Before a new or changed backend becomes active, its activation probe must account for every live file attachment. The backend must verify the remote object or upload a local copy; an object key from another backend does not prove availability.
6. Activation probes merge the candidate document first, then run attachment transfer against a clone of that merged snapshot immediately before the candidate write. This accounts for candidate-remote-only attachments as well as local ones, and prevents a newer remote metadata row from replacing a key that the probe just proved. The probe can publish proven attachment metadata to the candidate remote, but it does not persist that metadata into the local store until the candidate configuration passes and a normal sync completes.
7. The first durable sync after activation treats the live attachment keys in that proven candidate document as authoritative for the new destination while preserving local file URIs and availability.
8. Downloads publish only through a generation-bound native install: stage in app-private storage, validate the exact plaintext hash, then compare-and-swap against the expected absent or present local generation. The installer journals before displacing a file and preserves every distinct conflicting or interrupted generation.
9. File Sync uploads publish immutable, digest-qualified generation keys with create-no-replace semantics. A collision is reused only after its plaintext digest is verified; an invalid or unreadable target is preserved and the upload fails closed. Mindwtr does not physically delete those generations: the folder lock is local to one device, and another peer can reselect any existing generation between its existence check and its authoritative data-document compare-and-swap. A raw folder inventory or a single authoritative reread cannot prove a generation globally dead.
10. File Sync cleanup clears deleted attachment metadata and local bookkeeping while retaining shared-folder bytes. Upload code may remove only scratch, staging, or provider objects whose ownership was established by that invocation before they become an authoritative generation. Automatic generation reclamation requires a future replicated GC tombstone/epoch protocol that every writer checks before publishing metadata.
11. Desktop File Sync durably journals an exact, lease-bound scratch path before returning it to the renderer. Mobile path File Sync on Android and iOS records the exact scratch path in device-local state before creating it in the shared folder. Recovery runs after acquiring the same folder lease and removes only that journal-owned regular file; it never scans the shared folder by filename pattern. Native path publication then uses create-no-replace without placing managed-local installer journals or quarantine files in the shared folder. Generic Android SAF cannot atomically create and fill a document, so a process death during that provider operation can leave a corrupt target; later runs preserve it and fail closed rather than overwrite it.

## Consequences

- Main sync remains fast and deterministic for task data.
- Device-local paths and transient transfer state do not create false conflicts.
- Users can see whether an attachment is available, missing, uploading, or downloading on the current device.
- Backends need attachment-specific validation and cleanup code.
- Saving, discarding, externally closing, or switching an attachment draft cannot silently leak newly copied files; user-owned paths remain outside the cleanup boundary.
- A backend switch fails closed when Mindwtr cannot prove one of the live attachments at the candidate destination.
- A download racing a local create or edit cannot overwrite it; the staged download and displaced local generation remain recoverable until the caller resolves the conflict.
- File Sync content edits do not overwrite a peer's winning bytes. Superseded or losing immutable generations can consume unbounded shared-folder space, trading storage reclamation for cross-device data safety until a distributed GC protocol exists.
- A corrupt File Sync generation may require manual recovery, especially with SAF providers that cannot publish atomically. Automatic repair must not overwrite bytes another peer may still reference.
- Future attachment work should preserve the metadata-vs-bytes split unless a new storage architecture replaces snapshot sync entirely.
