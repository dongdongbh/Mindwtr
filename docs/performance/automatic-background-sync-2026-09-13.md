# Automatic mobile background scheduling — September 13, 2026

The user chose one automatic background-sync schedule for all devices, including devices whose old interval preference was Off. The mobile interval card and obsolete settings search result are removed. Sync backend Off remains authoritative.

Supported configured backends now request the existing 15-minute minimum interval. Expo/Android/iOS choose when deferred work actually runs. The obsolete device-local interval preference is no longer read or written; only the previous registration record is retained to detect migration. No synced setting, data schema, native permission, or actual sync-document writer changed.

Registration reconciliation is serialized. Each caller reads fresh configuration and native state in its queued pass. Native registration changes occur only in foreground, after an in-flight background task settles; migration then rechecks state and configuration. Existing registrations with legacy intervals are removed and replaced once, while matching registrations remain untouched. Errors leave the queue retryable. Existing actual sync orchestration, callback coalescing, deadlines, abort and storage quiescence remain intact.

With Diagnostics enabled, `v1.3.0/automatic-background-sync` proves the fixed schedule was registered or an existing matching registration was confirmed. It does not prove an OS run or a successful data sync. See the diagnostics ledger.

Validation in `/home/dd/worktrees/Mindwtr/automatic-background-sync-20260913`: 103 focused tests across four files, then 29 background-task tests after a final assertion refinement; mobile typecheck, scoped ESLint and diagnostic-field checks passed. Tests cover every old choice, headless/inactive deferral, an active worker, configuration changes during slow reads/native mutation, serialized overlapping callers, failure/retry, unchanged registration and surrounding settings/search behavior. Independent Sol review found no blocking defects. Full cold headless startup and physical iOS execution remain unverified. Public docs were updated in all six languages and their full check passed.

The worktree's ignored `.orchestrator/tasks/automatic-background-sync-20260913/` contains the authoritative packet, implementation report and independent review. Source is based on local main3034a6e1c; publication must exclude unrelated release-preparation commits. Use the exact published commit and CI run to establish integration status. No release was requested or initiated by this change.

## Physical Android validation

On the connected OnePlus CPH2655 / Android 16, the fresh Dev bundle showed Sync backend Off, Settings sync options and Recovery snapshots with the interval card absent. The Dev app's original settings were backed up; a temporary legacy Off interval plus a loopback-only WebDAV configuration tested registration without using any real remote backend. The new `registered` diagnostic appeared, and Android JobScheduler exposed exactly one Dev job with a minimum delay of approximately 15 minutes.

After Home, reconciliation logged `deferred-until-foreground`. Forcing that Dev job through JobScheduler invoked the background callback with JavaScript timers paused; the callback settled and Expo scheduled exactly one successor with another approximately 15-minute minimum delay. No registration mutation ran in the inactive pass. This proves a background invocation in an already loaded Dev runtime, not cold headless startup, remote sync success, or an exact OS cadence. The deliberately unreachable loopback backend prevents a real remote write.

Evidence is under `/home/dd/.cache/mindwtr-checklist-focus/background-native/`, the `background-sync-settings.png` screenshot, and `metro-background.log`. Original four settings were restored individually, preserving other Dev data and settings. A fresh foreground launch confirmed Sync Off, unregistered the test worker, and left zero Dev jobs in JobScheduler. Dev and the task-owned Metro process were stopped and the task-owned ADB reverse removed. No production app or global device permission was changed.

## Native CloudKit operation deadlines

`CloudKitOperationTimeouts` applies native deadlines to every operation created by `CloudKitSyncManager` and `CloudKitChangeTracker`. JavaScript timers stop while iOS suspends the app, so the shared sync deadline cannot by itself bound a suspended CloudKit request. Native timeout errors use the existing transient CloudKit failure handling.

The request inactivity timeout is 30 seconds. The total resource timeout is 180 seconds for record operations, leaving room within the JavaScript background run's four-minute deadline. Asset operations have a 600-second total timeout: a 50 MB attachment would otherwise need roughly 2.3 Mbit/s continuously to finish within 180 seconds, and foreground retries on slower links would fail repeatedly. The longer asset timeout also applies in foreground.

`apply(to:resourceSeconds:)` reads the operation configuration, preserves its quality of service, sets both deadlines, and assigns the configuration back. `CKOperation.configuration` is an Objective-C copy property; mutating a getter result without assigning it back can lose the update.
