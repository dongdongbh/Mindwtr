# 25. No encryption of the server-merged sync payload; passphrase-encrypted blob backends are first-party

Date: 2026-08-06

## Status

Accepted; amended 2026-08-22.

Settled in discussion #1001. Dated to when the stance was decided, not to when
this record was written. Amended after #1056 shipped optional user-held-key
(passphrase) encryption for the blob sync backends — File Sync, WebDAV, and
Dropbox — as a first-party feature. The original decision's reasoning stands
unchanged for the surfaces the server must read: the self-hosted cloud backend
and CloudKit remain unencrypted because their merge runs where the document is
stored. The blanket "no first-party encryption" wording below was superseded by
that release; the app-managed-key rejection and the server-merge analysis were
not.

## Context

"Encrypt the data at rest" is the most re-argued request in the tracker, and it
arrives as one sentence covering two different threat models that need
separating before anything can be decided.

**Device theft / offline disk access.** Mindwtr stores its data in SQLite in the
app's own directory. On modern iOS and Android that directory is encrypted at
rest by the OS (iOS Data Protection, Android file-based encryption). On desktop
it is protected exactly when the user has disk encryption enabled — FileVault on
macOS, BitLocker on Windows, LUKS on Linux — which is the default on current
macOS, common but not universal on Windows, and an install-time choice on Linux.
App-level encryption with an app-managed key would not improve on the unencrypted
cases: the key would have to live on the same disk (see below). This threat model
belongs to the platform's disk encryption, and Mindwtr must never claim to add
protection there that it does not have.

**Server-operator access.** The self-hosted cloud sync server (ADR 0010) stores
the synced document as JSON on disk. An operator with filesystem access can read
it. For a self-hosted deployment the operator is usually the user, so this is
the same trust boundary as the device; for a shared or hosted deployment it is a
genuinely different one.

The security-claims rigor rule applies to every sentence below: an encryption
claim is only worth making if it names who holds the key.

## Decision

Mindwtr does not encrypt the sync payload on any backend whose server must read
it to merge — the self-hosted cloud server and CloudKit — and offers no
app-managed-key encryption anywhere. For the blob backends the file-sync path
writes through (File Sync, WebDAV, Dropbox), Mindwtr ships optional first-party
encryption with a user-held passphrase (#1056, MWENC1 format): the device
encrypts before writing, the passphrase never leaves the user, and losing it
makes the synced copies unreadable by design.

### Why app-managed keys are not worth shipping

In an app-managed scheme, Mindwtr generates the key and stores it so the app can
decrypt without the user typing anything. That key has to live on every synced
device, in the app's own storage, beside the data it protects. An attacker who
can read the database file can read the key from the same place — so the scheme
protects against nothing the platform's disk encryption does not already cover.
It would let us put the word "encrypted" on a feature list, which is exactly the
kind of claim the rigor rule exists to stop. The honest description of that
feature is "obfuscated", and it costs real complexity in key rotation, backup,
restore, and multi-device onboarding to buy it.

### Why user-held keys break server-side merge

In a true end-to-end scheme the user holds a key the server never sees. That is
a real security property — and it is incompatible with how sync works today.

The cloud server does not store an opaque blob. `PUT /v1/data`
(`apps/cloud/src/server.ts`) validates the incoming body as an `AppData`
structure and then calls `mergeAppDataWithStats(existingData, incomingData)`,
merging **per entity, revision-wise**: for each task, project, section, area and
person it compares the incoming `rev` against the stored one and resolves
field-by-field, with deterministic tombstone handling. It writes the merged
result, not the payload it received. Two devices that both sync while offline
converge because the server can read and reconcile both documents.

A server holding ciphertext can do none of that. It cannot compare revisions, so
it cannot merge; the only operation left is last-writer-wins on the whole
document, which silently discards the other device's concurrent edits — the
exact data-loss class the revision-aware design (ADR 0003) exists to prevent.
Preserving E2E and multi-device merge together means moving the merge to the
clients: a different sync architecture, in CRDT territory, which ADR 0017
deliberately defers.

### What ships instead: encrypted blob backends (amended 2026-08-22)

The original record closed with "a pluggable encrypted blob backend contributed
by a user remains welcome; we will not promise it as a first-party feature."
#1056 shipped that shape first-party after the spec converged in #1001: the
blob backends (File Sync, WebDAV, Dropbox) can encrypt everything written to
the sync location with a key derived from a user-held passphrase (Argon2id →
AES-256-GCM, MWENC1 container). This does not contradict the key-management
concern that motivated the original wording — Mindwtr still manages no keys.
The passphrase is user-held, device-local, never synced and never recoverable;
merge still happens on devices that hold the plaintext, so the revision-aware
merge is untouched. The tradeoff moved exactly where this section said it
belongs: the user who enables it accepts that a lost passphrase loses the
remote copies. Backends the server must read (self-hosted cloud, CloudKit)
remain excluded for the merge reasons above.

## Consequences

Device-at-rest protection remains the platform's responsibility. Mindwtr makes
no claim that its local SQLite database is app-encrypted; public guidance must
continue to point users to iOS/Android data protection or full-disk encryption
on desktop.

The self-hosted cloud and CloudKit sync payloads remain readable by the service
that merges them. Mindwtr must not describe those backends as end-to-end
encrypted. Self-hosting changes who operates the service, but does not make the
stored JSON cryptographically opaque to that operator.

File Sync, WebDAV, and Dropbox are different: when the user enables sync
encryption, Mindwtr encrypts the document and attachments before they leave the
device using the user's passphrase. Product copy may describe that narrowly as
user-passphrase or end-to-end encryption for those supported blob backends, but
must not generalize the claim to local device storage or server-merged
backends. Users must also be told that Mindwtr never receives or recovers the
passphrase and that losing it makes the encrypted remote copies unreadable.

The revision-aware server merge stays intact for server-merged backends, while
encrypted blob backends continue to merge on trusted clients.

## What would reopen this

- Sync moving to client-side merge (CRDT or equivalent, per ADR 0017), which
  removes the server's need to read the document and makes E2E compatible with
  multi-device convergence.
- Extending user-passphrase encryption to another backend whose storage can
  remain opaque without weakening merge or recovery guarantees.
- A first-party hosted service, which would change the operator trust boundary
  from "the user" to "us" and force the question again on different terms.
