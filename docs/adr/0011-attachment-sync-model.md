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

The transfer contract is:

1. Structured data sync can converge without downloading every attachment first.
2. Attachment upload/download is backend-specific but must update local metadata through the same task/project records.
3. Merge logic must preserve a usable local URI when two devices have different valid local paths for the same attachment.
4. Remote deletes are retried through attachment cleanup state rather than blocking the main sync cycle indefinitely.

## Consequences

- Main sync remains fast and deterministic for task data.
- Device-local paths and transient transfer state do not create false conflicts.
- Users can see whether an attachment is available, missing, uploading, or downloading on the current device.
- Backends need attachment-specific validation and cleanup code.
- Future attachment work should preserve the metadata-vs-bytes split unless a new storage architecture replaces snapshot sync entirely.
