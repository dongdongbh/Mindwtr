# android-widget

Native Android home-screen widgets, the floating quick-capture dialog, and the
opt-in automation capture receiver.
Every widget string comes from the payload `apps/mobile/lib/widget-service.ts`
publishes (`AndroidTasksWidgetPayload`) into SharedPreferences
`mindwtr_widget` / `payload`; Kotlin lays it out and refreshes Upcoming dates.

## Kinds

| Kind | Provider | Layout | Plugin table row (`plugins/android-widget.js` `buildWidgetKinds`) |
|---|---|---|---|
| `TASKS` | `TasksWidgetProvider` | `mindwtr_widget` | `Tasks`: 3x2, resizable, preview PNG |
| `COMPACT` | `CompactWidgetProvider` | `mindwtr_compact_widget` | `Compact`: 2x2, resizable, simple-style preview PNG |
| `QUICK_CAPTURE` | `QuickCaptureWidgetProvider` | `mindwtr_quick_capture_widget` | `QuickCapture`: 1x1, no resize |

Adding a kind: one row in `WidgetKind`, one `MindwtrWidgetProvider` subclass
(one line), one layout, one row in the plugin's `buildWidgetKinds` table, and a
`when` branch in `WidgetRenderer.buildViews`. Rows for a list-backed kind come
from `TasksWidgetFactory`, keyed by the `EXTRA_KIND` extra on the adapter
intent.

## Tasks widget lists (#1173)

The Tasks widget reads optional payload sections and supports a list chooser.
Its default Focus projection combines Today's Focus and Today. A user's
explicit choice of Focus, Inbox, Next Actions, Upcoming, Waiting, Someday, or a saved
filter remains selected across payload updates. The title opens the displayed
list in the app; blank background, space below the visible rows, section
headers, and the empty message open Focus regardless of the selected list. A
separate 44dp chevron target opens the native chooser, and the plus remains
capture. The Focus background action has its own immutable PendingIntent
identity per widget id, distinct from the displayed-list route and chooser.
Check-offs append queue commands for the app
to apply through the normal store; widget code never writes SQLite.

A check-off stays visible and struck through during the three-second Undo
window, whose pending map is persisted with `AtomicFile`. After the completion command is durably published, Tasks and Compact
hide every cached occurrence locally, remove empty section headings, and let
the remaining rows fill the widget. Compact chooses its Focus/Next Actions
fallback after this filtering, so its header always matches its rows. The
delayed path partially updates rows and header/count/empty chrome without
replacing the row PendingIntent template. Android 12+ receives direct
`RemoteCollectionItems` using the same row renderer as the legacy service;
only older Android uses collection invalidation. Direct collections avoid
Android 16's asynchronous conversion of the legacy service adapter. Queue failures keep the row pending and visible for a
deterministic retry. The app still owns the eventual task completion through
the normal pending-capture drain. A stale tap after publication only reconciles
the hidden presentation; it never removes the queued completion.

## Compact widget

The optional Compact style uses native RemoteViews with the simple v1.2.8
layout: a 13sp title, 10sp Inbox count, flat 12sp task rows, and a capture
button pinned below the scrollable list. It shows the shared Focus projection
under the localized `Today` header; when Today's Focus and Today are both empty, it shows Next Actions
under that list's localized title. The list fills the resized widget with as
many rows as fit, up to the available tasks. It has no list selection, section
headings, metadata, or inline checkboxes. Task taps open the existing native detail sheet. Capture opens
`QuickCaptureActivity` over the launcher and durably queues the new task
without opening the main app. Both styles share the payload, theme, refresh,
and pending-capture paths; no React Native widget rendering dependency is used.
Its title opens the list Compact actually displays, including the post-filter
Next Actions fallback; blank background, space below visible rows, and the
empty message open Focus. Delayed partial row updates refresh both links
together with the header.

List payloads may provide a validated hostless `mindwtr:///...` `openUri`.
Legacy Focus, Inbox, Waiting, and Someday payloads map to their existing app
routes. Next Actions, Upcoming, saved-filter and context/tag ids map to the shared
`/widget-list/<encoded-list-id>` destination; unknown or malformed ids fall
back to Focus rather than becoming arbitrary paths.

The Tasks header uses the same opaque day/night or custom-palette background
as its body. The divider and plus retain their subtle border/accent roles, and
the separate chooser chevron follows the muted-text token for contrast instead
of retaining a fixed or semi-transparent accent tint.

Every Android snapshot includes bounded Focus, Inbox, Next Actions, Waiting,
Upcoming, and Someday lists, even before a Tasks widget is placed. After the app has
published once, a newly placed widget can select those cached lists without
another app opening. The chooser also offers every saved filter (up to the
established 50-filter limit), context and tag by name, but the payload carries
their lists only for what placed widgets chose: a list for every label made each
refresh grow with the labels (#1399). A newly chosen one shows under its name,
empty, until the app's next publication (unless another widget already shows that
list). The Tasks chooser groups these under their existing translated headings and
offers search for longer inventories.
Rows recycle through a native ListView; searching preserves the pending choice.
Each widget stores its own selection.

Context/tag options come from undeleted tasks visible under the current area and
active-project rules, including retained done/archived task labels and hierarchy
ancestors. They have no arbitrary token-count cap. Rows use the full actionable
widget pool across statuses, shared canonical hierarchical filtering, and widget
sorting; the Focus screen's current token filter does not narrow these lists.
Selected removed labels stay empty under their own heading. IDs are
`context:<canonical-token>` and `tag:<canonical-token>`; links encode the whole ID
as one path segment. Android-only chooser metadata does not change iOS snapshots.

When a placed widget chose a context or tag, publication indexes task/token
memberships once, then verifies indexed candidates with shared `applyFilter`. Each
list retains the existing 200-row Android cache limit, with total count and
overflow navigation. Snapshot size grows with the chosen lists, not with the
number of labels.

Upcoming is a preview of the shared Focus seven-day list. Its rows have no
completion ring and open their task directly. Each row supplies `upcomingDate`
(a calendar date, floating local datetime or canonical UTC instant) and `upcomingLabel` (localized Starts
or Returns). Every render excludes dates outside tomorrow through local day
seven, and formats absolute dates in the current Android locale and time zone.
Empty Upcoming stays selected. Tasks and legacy Tasks providers listen for
date, clock, and timezone changes and request Android's inexact 30-minute widget
updates; Compact and Quick Capture keep their existing cadence. Launcher and
power-management delays can postpone redraws. Native refresh only filters the
cached rows: newly eligible tasks and data/filter changes require the app's
next payload publication.

## Picker previews

The config plugin builds each `previewLayout` from its real native layout,
with sample task rows replacing the live collection. Each kind also has its
own `assets/images/widget-*-preview.png` fallback for launchers that use only
`previewImage`. These PNGs are rendered from the native sample layouts; update
them when changing widget layouts. Do not reuse the retired React Native
widget screenshot for the native kinds.
Picker names/descriptions for Compact use Android locale resources. Preview
sample content is intentionally static English demonstration data, including
the bitmap fallback; it is not a live localized task list. Placed widgets and
their capture dialogs use the app's localized payload as usual.

## Quick capture dialog

`QuickCaptureActivity` writes `<filesDir>/pending-captures/<uuid>.json` in the
schema core's `packages/core/src/pending-captures.ts` (`parsePendingCapture`) reads,
through `PendingCaptureWriter` (temp file + rename), then bumps the stored
payload's `inboxCount` and redraws every widget. The tile, app shortcut,
capture notification and all three widgets launch it by explicit class name.

A Tasks widget showing one context or tag opens the dialog with that token typed
in (`@Todd `), editable like any text; the drain's quick-add parse applies it
(#1418). `WidgetListStore.captureText` writes simple and hierarchical tokens
as typed (`@person/todd `) and other names in quoted form (`@"Two words" `), the
forms quick-add parses without a known-token list (#1428). A name with a quote,
a backslash, or a space before `@ # + ! % /` opens empty.

After a text **Save** it starts `CaptureSyncHeadlessService` (not exported), which
wakes the JS task `MindwtrCaptureSync` in `apps/mobile/lib/background-sync-task.ts`:
that imports the queue through the store and runs one sync, so the task reaches
other devices without opening the app (#1257). Native code still never writes
task data. A refused service start is logged and ignored; the queue is then
imported at the next app opening or scheduled background sync.

When speech-to-text is enabled in the app, the dialog also shows a microphone
button. Recording uses the existing microphone permission only while the native
dialog is visible, with a five-minute limit. It writes a 16 kHz mono PCM16 WAV
under `<filesDir>/quick-capture-audio/`, then atomically queues an `audio` JSON
item with the same UUID. No main activity, background microphone service, or
database write is involved. Save confirms the recording is queued, not that a
task has already been transcribed. The app's startup/foreground drain uses the
configured transcription provider (local Whisper on F-Droid), retains failed
captures for retry, and removes the queue item and WAV only after durable task
creation. Replaying a capture after an exhausted storage retry must persist the
existing task before acknowledging it, without creating a duplicate or changing
its revision. Explicit Cancel discards the unsaved draft; leaving during
recording stops the microphone and queues the usable recording.

Recordings already in the pending queue do not expire. Unqueued temporary or
orphan WAV files left by an interrupted process are removed on a later native
capture open only after seven days; active drafts and queued files are excluded.
The native writer preserves the `Context.filesDir` URI spelling used by Expo
while separately validating canonical file ownership. The JavaScript resolver
also supports React Native's URL implementation, which omits credential fields
for file URLs.

## Automation capture intent (#1149)

`CaptureIntentReceiver` accepts the explicit action
`tech.dongdongbh.mindwtr.action.CAPTURE` with string extras `text` and `token`.
It is off by default. Enabling it creates a random 256-bit token in an
`AtomicFile` under `noBackupFilesDir`, outside app backup and Mindwtr sync;
disabling deletes the token, and enabling again creates a new one.

The exported receiver validates the exact action, types, nonblank text,
2,000-character limit, and token before publishing one atomic queue file with
source `android-capture-intent`. It never launches the app, uses the network,
or writes SQLite. The normal pending-capture drain creates the Inbox task when
Mindwtr next starts or foregrounds, then deletes the queue file only after the
store save is durable.
