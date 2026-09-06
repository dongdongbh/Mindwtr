# android-widget

Native Android home-screen widgets and the floating quick-capture dialog.
Every string comes from the payload `apps/mobile/lib/widget-service.ts`
publishes (`AndroidTasksWidgetPayload`) into SharedPreferences
`mindwtr_widget` / `payload`; Kotlin only lays it out.

## Kinds

| Kind | Provider | Layout | Plugin table row (`plugins/android-widget.js` `WIDGET_KINDS`) |
|---|---|---|---|
| `TASKS` | `TasksWidgetProvider` | `mindwtr_widget` | `Tasks`: 3x2, resizable, preview PNG |
| `QUICK_CAPTURE` | `QuickCaptureWidgetProvider` | `mindwtr_quick_capture_widget` | `QuickCapture`: 1x1, no resize |

Adding a kind: one row in `WidgetKind`, one `MindwtrWidgetProvider` subclass
(one line), one layout, one row in the plugin's `WIDGET_KINDS` table, and a
`when` branch in `WidgetRenderer.buildViews`. Rows for a list-backed kind come
from `TasksWidgetFactory`, keyed by the `EXTRA_KIND` extra on the adapter
intent.

## Seam for the Focus kind (#1173)

`WidgetPayload.parse` ignores unknown keys, so the shared payload can grow an
optional `sections` array (date header, Today's focus / Next / Upcoming, each
item with `openUri` and a check-off id) without touching the shipped kinds. A
`FOCUS` kind then reads `root.optJSONArray("sections")` into its own data
class, `TasksWidgetFactory` branches on `kind` to flatten sections into rows
(header rows get their own view type), and check-off becomes a second fill-in
intent that targets a small exported-false receiver appending a
`pending-captures`-style queue item, never the database.

## Quick capture dialog

`QuickCaptureActivity` writes `<filesDir>/pending-captures/<uuid>.json` in the
schema `apps/mobile/lib/pending-captures.ts` (`parsePendingCapture`) reads,
through `PendingCaptureWriter` (temp file + rename), then bumps the stored
payload's `inboxCount` and redraws every widget. The tile, app shortcut,
capture notification and both widgets launch it by explicit class name.
