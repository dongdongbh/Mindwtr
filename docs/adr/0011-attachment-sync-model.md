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
3. `localStatus` tracks local availability and transfer state; it is persisted locally but excluded from remote comparison.
4. Attachment deletes use soft-delete metadata first, then background cleanup removes orphaned local and remote files.
5. Task editors may copy bytes into app-managed storage before Save, but draft settlement is planned in core from the baseline, draft, and actually committed records. Platform adapters may delete a candidate only after proving that its URI is the attachment-id-named file inside their managed attachments directory.

The transfer contract is:

1. Structured data sync can converge without downloading every attachment first.
2. Attachment upload/download is backend-specific but must update local metadata through the same task/project records.
3. Merge logic must preserve a usable local URI when two devices have different valid local paths for the same attachment.
4. Remote deletes are retried through attachment cleanup state rather than blocking the main sync cycle indefinitely.
5. Before a new or changed backend becomes active, its activation probe must account for every live file attachment. The backend must verify the remote object or upload a local copy; an object key from another backend does not prove availability.
6. Activation probes merge the candidate document first, then run attachment transfer against a clone of that merged snapshot immediately before the candidate write. This accounts for candidate-remote-only attachments as well as local ones, and prevents a newer remote metadata row from replacing a key that the probe just proved. The probe can publish proven attachment metadata to the candidate remote, but it does not persist that metadata into the local store until the candidate configuration passes and a normal sync completes.
7. The first durable sync after activation treats the live attachment keys in that proven candidate document as authoritative for the new destination while preserving local file URIs and availability.

## Consequences

- Main sync remains fast and deterministic for task data.
- Device-local paths and transient transfer state do not create false conflicts.
- Users can see whether an attachment is available, missing, uploading, or downloading on the current device.
- Backends need attachment-specific validation and cleanup code.
- Saving, discarding, externally closing, or switching an attachment draft cannot silently leak newly copied files; user-owned paths remain outside the cleanup boundary.
- A backend switch fails closed when Mindwtr cannot prove one of the live attachments at the candidate destination.
- Future attachment work should preserve the metadata-vs-bytes split unless a new storage architecture replaces snapshot sync entirely.
