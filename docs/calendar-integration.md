# Calendar Integration (Hard + Soft Landscape)

## Summary

- **View-only** external calendars (ICS subscriptions) inside Mindwtr.
- **Hard Landscape**: meetings/classes (external events).
- **Soft Landscape**: tasks (Mindwtr) with `timeEstimate`.
- Calendar is a **planning surface**, not a capture surface.
  - You schedule **existing** tasks by setting `startTime`.

---

## GTD Semantics (Mindwtr Fields)

### `dueDate` = Deadline (Hard)

- Use `dueDate` only for true deadlines (e.g., “Submit assignment”).
- Calendar shows deadlines clearly (all-day badge or timed marker if time is present).

### `startTime` = Tickler / Scheduled Start (Soft)

- Use `startTime` for “not before” availability and time-blocking.
- Recommended behavior:
  - Tasks with `startTime` **in the future** are hidden from action lists (“Next”, “Inbox”), but visible in a “Future”/Tickler view.
  - Once `startTime <= now`, the task becomes actionable again and appears in its status list.

### `timeEstimate` = Duration Hint (Soft)

- Used for planning blocks on the calendar/agenda (default duration).
- Users can still override duration during scheduling if needed.

---

## UI Targets

### Calendar Views

- **Day view**: time grid with events + scheduled tasks.
- **Month view**: overview with markers for deadlines, scheduled tasks, and events.

### Scheduling UX

- Calendar is **not** a capture surface.
- Scheduling means **placing an existing task** onto the calendar by setting:
  - `startTime` (and optionally inferred duration from `timeEstimate`)

**Desktop**
- Schedule existing tasks into open time by assigning a start time.
- Move a scheduled task by adjusting its start time.

**Mobile**
- Tap a task in the day view to schedule it.
- Adjust start time from the task editor or the day list.

---

## Integrations

### iCal / ICS Subscription (View‑Only)

- Paste a calendar **ICS URL** in Settings.
- Events are fetched and cached on-device.
- Works with Google/Outlook calendar publishing links without OAuth.

### Provider OAuth (Later)

- Google Calendar: OAuth + read-only scope.
- Outlook/Microsoft 365: Microsoft Graph + read-only calendar scope.
- Store tokens securely per platform (avoid putting tokens in synced `data.json`):
  - Mobile: Secure storage
  - Desktop: OS keychain/secure store (fallback to config with warnings)
  - Web: avoid `localStorage` tokens; prefer server-backed sessions

---

## Data & Caching

- External events are **derived data** and cached per device.
- Refresh manually or on a periodic cadence.
- Events are not synced via Mindwtr sync (privacy + size).

---

## Notes

- Use **dueDate** for hard deadlines.
- Use **startTime** for “not before” scheduling/tickler behavior.
- Use **timeEstimate** to indicate the default duration.
