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
