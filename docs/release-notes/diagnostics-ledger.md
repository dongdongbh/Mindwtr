# Release diagnostics ledger

Maintainer file, not user docs. Every stable or RC release adds one log line per change that field testers are asked to confirm, and removes the previous release's lines once that release has been out. The rule lives in the `publish-release` and `publish-rc-release` skills.

Convention: a release-specific line carries `extra.releaseCheck = "<version>/<slug>"` so it can be found with `git grep -n releaseCheck` and trimmed by version. General diagnostics (the sync trail, `[sync-encryption]` events, `Mobile background sync started`/`finished`, activation proofs) never carry `releaseCheck` and are never trimmed.

## General (keep)

- Sync trail: `Sync start`, `Sync step`, `Sync read check found no changes`, `Sync diagnostic complete` (core `sync-run.ts`, both apps).
- `[sync-encryption]` state / remote-read / transition / error / activation (core + both apps).
- `Mobile background sync started` / `finished` / `run took longer than a minute` (`apps/mobile/lib/background-sync-task.ts`, #1001).
- `Mobile background sync registered` with interval (same file).
- Desktop `Sync backend selected; running the verification sync to activate it` (`useSyncSettings.ts`).

## v1.2.7 (add before tagging, trim in the release after)

Field names are checked against the log sanitizer by `packages/core/src/release-diagnostics-fields.test.ts`. `shouldRedactKey` matches by SUBSTRING, so `skippedPasses` (contains `pass`), `monkeyIndex` (contains `key`) and `userAgent` (contains `user`) are silently replaced with `[redacted]`. Add every new field name to that test's list.

### Added

- **`v1.2.7/sync-settings-activation-mobile`** — `apps/mobile/components/settings/use-sync-settings-transport-actions.ts` (in `handleSync`, guarded on an explicit `options.backend`, which only an activation passes). Message: `Sync backend selected; running the verification sync to activate it`. Fields: `backend`, `cloudProvider`. Tester's log: one line the moment a complete backend is chosen or saved, before any manual Sync tap. Desktop's equivalent is the existing line under **General**.
- **`v1.2.7/sync-status-published`** — `apps/mobile/lib/sync-service.ts`, in `finalizeSuccess`. Message: `Sync status published to the store`. Fields: `backend`, `statusPublished` (`wrote-local` or `unchanged`), `lastSyncAt`, `lastSyncStatus`. Tester's log: one line per successful cycle whose `lastSyncAt` advances, proving the Sync screen's "Last sync" is no longer frozen.
- **`v1.2.7/dropbox-signin-detached`** — `apps/desktop/src-tauri/src/sync.rs` (Rust `log::info!`/`log::warn!`, target `sync`). Three phases: `phase=opened` after `open::that_detached` returns, `phase=callback-state-matched` when the real callback is accepted, `phase=callback-state-mismatch` when a stale tab replays an old state and is ignored. Tester's log: `opened` must appear immediately, not after the browser closes, and a completed connect ends in `callback-state-matched`.
- **`v1.2.7/incoming-link-redelivery`** — `apps/mobile/hooks/use-incoming-url.ts`. Message: `Incoming link delivered`. Fields: `scheme`, `host` (nothing further: a capture link carries the task title in its path and query), `delivery` (counter), `deduped`. Tester's log: pressing the same shortcut twice writes two lines with `deduped=false` and rising `delivery`; only an immediate launch-URL echo shows `deduped=true`.
- **`v1.2.7/fence-artifact`** — `apps/mobile/lib/sync-service.ts`, in `acquireWebdavRemoteMutationFence`. Message: `WebDAV sync fence artifact resolved`. Field: `artifact` (basename only). Tester's log: `artifact` must read `.mindwtr-sync-fence-v1.json` and must NEVER read `data.json` (#1132).
- **`v1.2.7/calendar-spanning-events`** — `apps/mobile/lib/external-calendar.ts`, at the end of `fetchSystemCalendarEvents`. Message: `Device calendar events loaded for the window`. Fields: `platform`, `total`, `multiDay`, `allDay`, `spanning`. Tester's log: on Android a month containing a multi-day event must report `spanning` greater than zero, which is exactly what the old containment query dropped.
- **`v1.2.7/cycle-unchanged-skip`** — `packages/core/src/sync-run.ts`, `logUnchangedCycleSkips`, called from both unchanged returns. Message: `Sync cycle changed nothing; passes skipped`. Fields: `backend`, `check` (`fast` or `read`), `skipped` (comma list). Tester's log: an idle device shows this after every `Sync fast check found no changes`, with `local-persist,store-refresh,attachments,remote-fence`. The field is `skipped`, NOT `skippedPasses`, which the sanitizer redacts.
- **`v1.2.7/daily-attachment-presence`** — `apps/desktop/src/lib/sync-service.ts`, in `hasAttachmentSyncWork`. Message: `Attachment presence re-verification checked`. Fields: `presenceDue`, `hasScope`. Tester's log: `presenceDue=false` on every cycle within a day of the last full pass, and `presenceDue=true` once a day or after the sync location changes.

### Existing (do not add a second line)

- **`v1.2.7/fence-heartbeat-reclaim`** — `packages/core/src/sync-run.ts` (91887e4cf) already logs `Reclaimed an abandoned remote sync reservation`, naming the previous owner, its purpose and the lease time left; the busy path logs `Remote sync location is reserved; retrying after the lease lapses`.
- **`v1.2.7/webdav-plaintext-degrade`** — both apps already log `WebDAV read returned no strong ETag; using the plaintext compatibility write` with the `etag` the server actually sent (`apps/mobile/lib/sync-service.ts`, `apps/desktop/src/lib/sync-service.ts`, 6ca1b0375).
- **`v1.2.7/local-only-upload`** — `packages/core/src/sync-run.ts` already logs `Sync local reconcile` with `reconcile: 'aligned-skip'` (and `'idle-cache'` when the carried idle snapshot spared the full local read).
- **`v1.2.7/suspended-timeout-offline`** — the sync failure path logs `Sync failed` carrying the error text, which ends in `the request was interrupted while the app was suspended` (`SUSPENDED_REQUEST_MESSAGE`, core `http-utils.ts`).
- **`v1.2.7/background-sync-registration`** — added (67075324c). `apps/mobile/lib/background-sync-task.ts`, message `Mobile background sync registration checked` with `decision` (register | re-register | unchanged | unregister | deferred-until-foreground), `registered`, `storedInterval`, `interval`, `appState`. A tester's log must show `deferred-until-foreground` on a headless cold start and never a re-register there; `Mobile background sync registered` with its interval stays under General.

### Not added

- **`v1.2.7/android-attachment-link-fallback`** — NOT PROVABLE from the app log today. The Kotlin installer's copy fallback is invisible to JavaScript: `moveExclusive` returns the same `installed`/`published` status whether `Os.link` succeeded or the exclusive-create copy took over, and only a total failure surfaces the errno in its message. Proving it needs one extra field in the map `AttachmentFileInstallerModule.kt` returns, then a `logInfo` at the call site in `apps/mobile/lib/attachment-file-installer.ts`. Until then a tester confirms #1139 by the absence of the old `Could not publish attachment generation (EXDEV)` failure, not by a positive line.
- **`v1.2.7/daily-attachment-presence` (mobile half)** — the existing `Attachment sync skipped` / `Attachment pre-sync skipped` lines with `reason: 'no-pending-work'` prove the skip, but not whether the daily pass was due. A distinct line needs `apps/mobile/lib/attachment-sync-utils.ts`, and it would add an AsyncStorage read to the idle path this same release just optimized.
