# Apple Siri and task-entity contract

Mindwtr exposes read-only task queries and two foreground Reminders actions in the production Expo iOS app.

## Current read-only entity

`MindwtrTaskEntity` is backed by the app-maintained shortcuts snapshot. Native
code never reads SQLite. Snapshot version 2 provides:

- a stable task ID and exact `mindwtr://open?task=<encoded-id>` link;
- display title, list/project label, due date, and start date;
- a generation timestamp;
- eligible, published, and omitted counts for each list, each published project,
  project groups, and unique tasks.

The React Native publisher includes version and coverage in its fingerprint,
so crossing a cap still publishes changed omission metadata when the visible
IDs stay unchanged. A successful App Group write records
`v1.3.1/apple-task-snapshot` with aggregate counts only. It does not claim the
later Core Spotlight launch reindex succeeded.

Native queries preserve the caller's identifier order. Duplicate titles never
act as identity. The entity validates a snapshot link against the same task ID
and falls back to a newly constructed exact-ID link if the stored URL is absent
or malformed. Missing and duplicate project names produce distinct dialogs.
Get Tasks reports a snapshot older than 24 hours. Its boundedness dialog uses
the requested list's omission count or the matched project's own omission
count; another list/project projection cannot mask that query's omissions. An
older snapshot without query-specific coverage reports possible omissions when
it returns the 50-item cap. Snapshot results are not a full-store answer.

Spotlight currently performs clear-and-replace indexing when the app launches.
React Native can refresh the snapshot later without triggering a new index, so
Spotlight can remain stale until the next launch. The consuming app revalidates
every returned ID against current hydrated state before opening a task.

## iOS 27 Reminders actions

`MindwtrCreateReminderIntent` creates an Inbox task with a title and an optional due date. `MindwtrUpdateReminderIntent` sets or clears the due date on an eligible Inbox task. Both return the persisted task entity. An explicitly supplied unsupported field fails the request before a write.

The foreground app publishes a bounded projection of ordinary, unassigned Inbox tasks. Siri resolves the required update target before it foregrounds the app. A date edit therefore requires an existing foreground access session. The query uses stable task IDs. Date edits also require the revision shown to the caller. App Lock, a workspace transition, sandbox mode, and unavailable canonical storage disable this path. The custom Capture action continues to use its own background queue.

The Swift intent submits a command with a unique ID and waits for its receipt. React Native validates the command in the current workspace and writes the task and device-local receipt in one conditional SQLite transaction. If the process stops before acknowledgment, the consumer can replay that command without applying the edit twice. Separate invocations of the same words are separate commands.

## Native validation

From the repository root, check the SDK availability guards and the Expo plugin.

```sh
node scripts/ci/validate-ios-app-intents-availability.js
bun test apps/mobile/plugins/ios-widgets-and-shortcuts.test.js
```

On a Mac with Xcode 27 and a matching iOS simulator runtime, generate the development app and register the UI test target. Use a dedicated simulator with synthetic tasks.

```sh
cd apps/mobile
APP_VARIANT=development bunx expo prebuild --platform ios --no-install
(cd ios && pod install)
ruby ios-app-intents/tests/register-test-target.rb ios/MindwtrDev.xcodeproj
CI=1 APP_VARIANT=development NODE_ENV=production xcodebuild test \
  -workspace ios/MindwtrDev.xcworkspace -scheme MindwtrReminderIntentsTests \
  -configuration Release -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -parallel-testing-enabled NO
```

The test creates an Inbox task, edits the returned entity, and resolves its new date after restarting Mindwtr. Use an Apple Intelligence iPhone to check spoken requests, foreground handoff, and App Lock. Test the existing capture and query actions on the oldest supported iOS release.

## Apple sources

- [Reminders App Schema domain](https://developer.apple.com/documentation/appintents/app-schema-domain-reminders)
- [Reminders createReminder](https://developer.apple.com/documentation/appintents/appschema/remindersintent/createreminder)
- [Develop for Shortcuts and Spotlight with App Intents](https://developer.apple.com/videos/play/wwdc2026/240/)
