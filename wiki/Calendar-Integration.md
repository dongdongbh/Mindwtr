# Calendar Integration (Hard + Soft Landscape)

Mindwtr supports calendar integration in two directions: reading external calendars into the planner, and pushing Mindwtr tasks out to a device calendar on mobile.

- **Mobile (iOS/Android):** device calendars already exposed by the system, plus ICS subscription URLs
- **Android mobile:** one-way push from Mindwtr tasks to a selected device calendar
- **Desktop (macOS):** Apple Calendar via EventKit, plus ICS subscription URLs
- **Desktop (Linux/Windows) and Web:** ICS subscription URLs

## Concepts

- **Hard Landscape**: Meetings/classes from external calendars.
- **Soft Landscape**: Mindwtr tasks scheduled with `startTime` and `timeEstimate`.
- The calendar is a **planning surface** for arranging existing tasks and creating scheduled tasks when the calendar context is the fastest place to do it.

## GTD Semantics

- **`dueDate`** = Deadline (hard commitments).
- **`startTime`** = Tickler/scheduled start (soft commitments).
- **`timeEstimate`** = Suggested duration when scheduling.

## Views

- **Day view**: time grid with scheduled tasks, deadlines, and external events.
- **Week view**: seven-day planning grid for scanning the current work week.
- **Month view**: overview with markers for deadlines, scheduled tasks, and events.
- **Schedule view**: rolling 60-day list for upcoming deadlines, scheduled tasks, and external events.

On desktop, the current calendar state is reflected in the URL:

- `calendarView`: `day`, `week`, `month`, or `schedule`
- `calendarDate`: the selected date, when a day is selected
- `calendarMonth`: the visible calendar month

This lets you bookmark or share a specific planning window, for example a week view for the current sprint or a schedule view for the next two months.

## Scheduling Workflow

On desktop:

1. Choose a date or open a time slot.
2. Pick **New** to create a scheduled task, or **Existing** to schedule an unscheduled task.
3. Set start and end times. Mindwtr checks the slot against scheduled tasks and visible external events.
4. Save the task, or adjust timing later from the task editor, day view, or selected-day list.

On mobile:

1. Open **Calendar -> Schedule Tasks** from the day view.
2. Select an existing task.
3. Mindwtr finds the earliest free slot for that day, avoiding visible external events and scheduled tasks.

Mindwtr uses `timeEstimate` as the default duration when available. If there is a conflict, choose another time or shorten the duration.

## External Calendars

### Support Matrix

Supported today:

| Platform | Supported calendar feature | Notes |
| --- | --- | --- |
| Android mobile | Push Mindwtr tasks to a device calendar | Verified with Google Calendar on Android. Choose a Google-backed calendar target if you need events to appear in Google Calendar web. |
| iOS/Android mobile | Read device calendars | Reads calendars already exposed by the device calendar database after permission is granted. |
| iOS/Android mobile | Direct ICS subscription URLs | The URL must return raw iCalendar data. |
| macOS desktop | Apple Calendar accounts | Read through macOS EventKit after permission is granted. This includes calendars synced into Apple Calendar, such as iCloud, Google, and Exchange. |
| Desktop and Web | Direct ICS subscription URLs | The URL must return raw iCalendar data. |

Not supported today:

- Linux native desktop calendar accounts.
- Windows native desktop calendar accounts.
- CalDAV account login, server discovery, or DAVx5-specific account discovery.
- Calendar provider OAuth inside Mindwtr, such as signing in to Google, Microsoft, or Nextcloud from Mindwtr.
- Authenticated/private URLs that return `HTTP 401` unless the secret is already embedded in the URL by the calendar provider.
- Calendar web page URLs, including public share pages that render HTML instead of raw `.ics` data.
- Editing external calendar events from Mindwtr.
- Syncing external calendar events through Mindwtr sync. External events are fetched and cached locally.
- Two-way task/calendar sync. Pushed calendar events are generated from Mindwtr tasks.
- Exporting recurring task rules as native recurring calendar events.

### Visibility

External calendar visibility is a local display preference:

- Settings-synced external calendar subscriptions follow your sync settings.
- The per-calendar show/hide state in the Calendar view is stored on the current device.
- Hidden calendars are still available in Settings; they are just excluded from the visible planning surface and free-slot checks on that device.

### Mobile: Push Tasks to Calendar

On Android, Mindwtr can push scheduled tasks and tasks with due dates into a selected device calendar:

- Tasks with `startTime` become timed events. `timeEstimate` is used as the event duration when available.
- Tasks with only `dueDate` become all-day events.
- Completed, archived, or deleted tasks are removed from the pushed calendar.
- If you choose a shared account calendar, event titles use a `Mindwtr:` prefix so they are distinguishable from normal calendar events.
- If you choose a dedicated calendar named `Mindwtr`, Google Calendar can show Mindwtr items with that calendar's own color.

Setup:

1. Open **Settings → Calendar**
2. Enable **Push tasks to calendar**
3. Grant calendar permission
4. Expand **Sync target**
5. Choose where Mindwtr should write events

Target choices:

- **Dedicated account calendar**: best for Google Calendar. Create a calendar named `Mindwtr` in the same Google account, then select the target that says `Dedicated account calendar`.
- **Shared account calendar**: writes into an existing Google/account calendar and prefixes titles with `Mindwtr:`.
- **Dedicated local calendar**: stays on the Android device. Some calendar apps hide local calendars, and it will not appear on calendar.google.com.
- **Shared local calendar**: writes to a local device calendar only.

To use a separate Google-backed `Mindwtr` calendar:

1. Open Google Calendar on the web.
2. Create a new calendar named `Mindwtr` under the same Google account used on Android.
3. On Android, open Google Calendar and refresh the account. Make sure Calendar sync is enabled in Android account settings.
4. Return to Mindwtr **Settings → Calendar**, tap **Refresh calendars**, and select the `Mindwtr` target that shows your Google account.

If the Google-backed `Mindwtr` calendar does not appear in Mindwtr yet, Android has not exposed it through the system calendar provider. Refresh Google Calendar, check Android account sync, then tap **Refresh calendars** in Mindwtr.

### Mobile: Read Device Calendars

On mobile, Mindwtr can read calendars from the device calendar database:

- **Android:** via the Android calendar provider. If a sync app does not expose calendars through that provider, Mindwtr cannot see them.
- **iOS:** via EventKit-backed system calendars, such as iCloud, Google, Exchange, and Outlook once enabled in iOS Settings.

Setup:

1. Open **Settings → Calendar**
2. Enable **Device calendars**
3. Grant calendar permission
4. Expand **Device calendars**
5. Choose which device calendars to display

Mindwtr stays read-only and does not perform provider OAuth for calendar sources.

Mindwtr hides its own pushed `Mindwtr` calendars from the read list to avoid importing duplicate copies of the events it created.

### macOS: Apple Calendar Integration

On macOS desktop, Mindwtr can read Apple Calendar events through EventKit:

1. Open **Settings -> Calendar**
2. Request Apple Calendar access
3. Allow Mindwtr in macOS **System Settings -> Privacy & Security -> Calendars**

This works only for calendars that are already visible in Apple Calendar. Linux and Windows do not have native desktop calendar account integration today.

### Desktop/Web: ICS URLs

1. Open **Settings → Calendar**
2. Add your **ICS URL**
3. Refresh to fetch events

Events are cached on-device and are not synced via Mindwtr sync.

### ICS URL Requirements

Mindwtr expects the URL to fetch raw iCalendar text. A working feed usually:

- starts with `BEGIN:VCALENDAR`
- has a URL ending in `.ics` or an explicit subscription/export link from the calendar provider
- can be fetched without an interactive login page or extra headers

Common examples:

- Google Calendar: use the private **Secret address in iCal format**.
- Nextcloud Calendar: use the calendar subscription/export `.ics` link, not the public calendar page URL.

If Mindwtr shows `HTTP 401`, the server is asking for authentication. Username/password prompts, CalDAV login, and bearer-token headers are not supported for calendar URLs. Use the provider's secret iCalendar subscription URL instead.

If a URL opens a normal web page in a browser, it is probably not the ICS feed. Copy the subscription/export URL from that page.

### Private calendars (Google Calendar)

You **do not** need to make your calendar public. Use the private "Secret address" instead:

1. Open Google Calendar on the web → **Settings**.
2. Select the calendar in the left sidebar.
3. In **Integrate calendar**, copy **Secret address in iCal format**.
4. Paste that URL into Mindwtr.

That link acts like a password: only apps with the link can see events, while the calendar stays private.

## Notes

- Desktop Calendar can create a new scheduled task from the in-calendar composer. Mobile scheduling currently works with existing tasks.
- External calendars are **read-only** inside Mindwtr.
- Recurring events with `RRULE:...;COUNT=...` stop after their original count. If you previously saw very old recurring events, re-import after updating to v0.4.9+.
