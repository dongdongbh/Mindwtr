# Mindwtr Unreleased

Changes collected since the latest stable release.

- Android App Lock: returning to Mindwtr keeps the task and screen you had open, and within the Require unlock time it opens at once instead of showing the lock screen for a few seconds. iOS still reopens on the list after the lock (#1423).
- A bare `www.` address in a task description (for example `www.google.com`) is now a link everywhere, including the desktop collapsed description preview, as it already was in the opened description on desktop (#1425).
- Mobile: a Pomodoro focus session's time is no longer lost when Mindwtr closes right as the session ends. The linked task now gets the time the next time you open the app, once.
- Desktop: a Pomodoro focus session's time is no longer lost when Mindwtr quits right as the session ends, and is no longer counted twice when the timer state could not be saved. The linked task gets the time once, at the next start if needed.
- Android: a Pomodoro completion alert shows the time its phase ended, so an alert that arrives late (for example right after the phone restarts) no longer looks like a phase that just ended.
- Web: an image pasted into a task description shows in the description preview right away, before Save uploads it (#1433).
- Desktop and web: Quick Add's syntax help says you can paste images or screenshots with Ctrl+V (⌘V on macOS). The web app shows it only when self-hosted Cloud can take the image (#1433).
- Desktop: auto sync keeps running while the window is hidden, covered or closed to the menu bar. Before, a sync that started then stopped until you showed the window again, and every later sync waited behind it (#1392).
- Mobile: the sync dot turns green as soon as a sync has uploaded your change. Before, it could stay amber for up to several minutes while a second sync waited to run, even with nothing left to send (#1435).
- Mobile: the welcome sheet no longer opens when your tasks failed to load, so "Start using Mindwtr" can no longer add a second Getting Started project to a library that was not empty.
- Mobile: the update reminder and the announcement window now show in your app language (in the fully translated languages; the others keep English for now). Before, the reminder's title, text and buttons and the window's "Not now" and close button were always in English.
- iOS: sync reads a large library's data from the server faster, so a change made right before leaving the app uploads sooner in the background (#1434).
- Desktop: paste an image into a task description and it is saved as an attachment and shown in the description, as the web app already did (#1403).
- iOS: when the new iOS app takes over a Pomodoro session from an older version that had not yet saved a finished focus session's time to its task, it now gives the task that time once. Before, the takeover failed and the Pomodoro timer could not start.
- Android and iOS: a Pomodoro focus session's time is no longer lost when its task's time changed on another device before Mindwtr gave it the time. The time now adds to the task's new total, as on desktop.
- Mobile: in File Sync, if turning on sync encryption was cut off on one device, another device with encryption off no longer adds unencrypted attachment copies to that folder. It stops and asks you to check the location, as WebDAV and Dropbox already did.
- Android: a very large library no longer opens as an empty app, or as an older copy of it, when the phone is slow to read it at start. Mindwtr now waits longer for the data, and shows an error if the read still fails.
- Mobile: after an import, the message now shows why tasks were skipped (for example, tasks imported earlier and then deleted) right below the counts. Before, the reason sat below the snapshot name and was cut off, so "Imported 0 task(s)" had no explanation (#1447).
- Android and iOS: if moving your data into the app's database fails at start, Mindwtr shows your tasks from the older copy and blocks saving until the move succeeds. Before, it showed an empty library and could later save that empty library over the older copy.
- Android and iOS: when Mindwtr moves your data into its database for the first time, it now keeps the settings that belong to this device, such as notification choices. Before, those went back to their defaults.
- Mobile: in quick Process Inbox, "I'll do it" now opens the filing step (project, area, contexts, dates) before moving the task to Next, as guided mode and desktop do (#1445).
- Mobile: Process Inbox date rows have a clock button, so you can set a time for start, due, review and follow-up dates (#1445).
- Mobile and desktop: Process Inbox starts a capture with no project or area in your default area (#1445).
- Android and iOS: on a slow start before Mindwtr has merged its older backup copy into its database, it now waits for the database instead of showing that older copy first. Before, a save from that view could put older settings back.
- Mobile: in quick Process Inbox, Project now opens the project setup at once instead of asking "More than one step?" first (#1445).
- Mobile: Process Inbox has an Edit button that opens the full task editor for the current item, for details processing does not offer, such as a checklist. After you save, processing shows your changes and files the item with them (#1445).
- Mobile: in the task editor, Destination and an empty Due date now have a heading above a value box, like Start date and Review date. Before, they were filled rows with the label inside, so Destination looked like part of the Contexts field above it (#1449, #1451).
- Mobile: the task editor's help button (?) sits next to the Scheduling and Details section titles instead of on its own line. Tapping it shows the help text below the title and does not fold the section (#1450).
- Mobile: after saving in the full task editor from Process Inbox, you stay on the step you were on instead of starting the item over, and Start later now offers contexts (#1445).
