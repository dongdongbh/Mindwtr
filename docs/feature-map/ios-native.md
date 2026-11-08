# iOS native client feature map

**Status: early development client.** `apps/ios-native` is the SwiftUI and JavaScriptCore foundation from [ADR 0029](../adr/0029-native-clients-host-the-typescript-core.md). The production iOS app is still the React Native app in `apps/mobile`. This page maps only what `apps/ios-native` owns.

The app is a SwiftUI shell. Task rules, labels and storage plans come from `packages/core`, which runs inside JavaScriptCore. Swift runs the SQL that core asks for. Most labels on this page come from `packages/core/src/i18n/locales/en.ts`.

`apps/ios-native/README.md` records per-task evidence. Parts of its prose lag the source. For example, it still calls backup import and Trash purge pending, but both exist in source and UI tests. Trust the source and the tests.

## Launch for testing

There is no Mac on the Linux machine. Edit on Linux. Build and test on the Mac mini over SSH. The repo-local skill `mindwtr-apple-dev` explains the SSH host, the Mac checkout, storage rules and device safety. Read it first.

- **Move code by Git.** Send a committed revision to a clean Mac checkout or worktree. Do not overwrite changes that already exist on the Mac.
- **The helper targets React Native.** The helper's `build-device` and `test` commands open the generated RN workspace under apps/mobile/ios. For this client, run `xcodebuild` on `apps/ios-native/MindwtrNative.xcodeproj` with the shared scheme `MindwtrNative`.
- **Full check (Mac, repo root):** `bash apps/ios-native/scripts/validate.sh`. It builds the core bundle, runs the script checks and `swift test`, then compiles the simulator app without signing. A compile-only build does not prove Keychain behavior.
- **Generate the core bundle first.** `Resources/core-host.js` and `Resources/label-keys.json` (every English label key, which the app loads at startup and on each language change) are ignored by Git. Run `node apps/ios-native/scripts/build-bundle.mjs` before any Xcode build.
- **UI tests:** `xcodebuild test -project apps/ios-native/MindwtrNative.xcodeproj -scheme MindwtrNative -destination 'platform=iOS Simulator,name=<simulator>' -only-testing:MindwtrNativeUITests/FoundationUITests/<testName>`. Keep Debug signing and the simulator entitlements on for runtime tests.
- **Isolated library:** pass `--native-ui-test-library <lowercase-uuid>` to use a separate `NativeUITests/<UUID>` library and preference suite.
- **Physical iPhone:** use a Debug build with the `NATIVE_DEVICE_TEST` condition and the separate `.native.dev` bundle identifier named in `apps/ios-native/README.md`. Startup refuses any other identity on a device. **Never install this app over the RN app.**
- **Interactive driving:** the skill uses Appium with the XCUITest driver on the physical phone. Find elements by the `accessibilityIdentifier` values listed below.

Almost every UI test lives in one file, `apps/ios-native/App/UITests/FoundationUITests.swift` (about 1,100 tests). Checks lines name that file and the test-name prefix to run. Swift package tests in `apps/ios-native/Tests/MindwtrNativeCoreTests` run real JavaScriptCore and SQLite, but they have no UI.

## Not in this client

Widgets, App Intents and Siri, the Share Extension and the Watch app belong to the RN app. They are not in `apps/ios-native`.

- Widgets: `apps/mobile/widgets-ios`, wired by `apps/mobile/plugins/ios-widgets-and-shortcuts.js`.
- App Intents and Siri: `apps/mobile/ios-app-intents` and `apps/mobile/modules/ios-siri-actions`.
- Share Extension: the `expo-share-intent` plugin in `apps/mobile/app.json`.
- Watch: `apps/mobile/targets/watch` and `apps/mobile/plugins/ios-watch.js`.
- RN Spotlight: `apps/mobile/modules/apple-task-search`. This client has its own opt-in Spotlight entry (see System search below).

## Navigation and Menu

- Reach: Bottom tab bar › Focus, Inbox, + (Add Task), the Quick Access tab, Menu. Menu opens a sheet with Trash, Board, History, Settings, Saved Searches, and tiles for Waiting For, Someday, Review or Projects, Reference, Contexts, Calendar.
- Shortcuts: Deep link `mindwtr-native-dev://open?task=<id>` or `mindwtr-native-dev://open?project=<id>`.
- Selectors: `tab-focus`, `tab-inbox`, `capture-open`, `tab-menu`, `menu-dismiss`, `menu-saved-search-scroll`, `search-open`, `area-open`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/MoreMenuSheet.swift`, `apps/ios-native/App/CoreModel.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testQuickAccess…, testNativeEntityLink…), `apps/ios-native/Tests/MindwtrNativeCoreTests/EntityOpenHostTests.swift`
- Notes: The fourth tab follows Settings › General › Quick access view (default Review), so the Menu tile that it replaces shows Projects. Only `open?task=` and `open?project=` links work; capture, search and `mindwtr://` links open nothing.

## Capture

- Reach: Tab bar › + (Add Task). The description field sits under the title at all times, as in RN (#1406). The sheet also has @ contexts, focus star and Area controls; More shows syntax help and date chips.
- Shortcuts: Long-press the @ contexts button to reset contexts.
- Selectors: `capture-input`, `capture-save`, `capture-save-edit`, `capture-add-another`, `capture-contexts`, `capture-focus`, `capture-area`, `capture-note`, `capture-close`, `capture-lines-create`
- Code: `apps/ios-native/App/CaptureSheet.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testCapture…, testGtdCapture…, testQuickCaptureShowsDescriptionUnderTitleWithoutMore), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeCaptureLinesHostTests.swift`
- Notes: Input with several lines opens a confirmation that creates one task per line. Core prepares the task before the write, and restart retries that exact task without parsing the text again.

## Inbox

- Reach: Tab bar › Inbox. The toolbar has Sort, Group and Filters icons. The primary button reads Process Inbox (N), or Mind Sweep when Inbox is empty.
- Selectors: `inbox-scroll`, `inbox-process-primary`, `inbox-mind-sweep-primary`, `inbox-mind-sweep-accessory`, `inbox-chips-clear`, `inbox-sort-close`, `inbox-group-close`, `inbox-more`
- Code: `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/ListFilterControls.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testInboxSort…, testInboxFilters…, testTask157InboxCompletion…)
- Notes: Inbox filters last for the session only and reset on restart.

## Inbox bulk selection

- Reach: Inbox › long-press a task card. A bar shows the count and Next, Waiting, Someday, Done, Reference, Add tag, Remove tag, Organize and Delete.
- Shortcuts: Long-press a card to start selecting. Use the range control to select a range.
- Selectors: `inbox-bulk-count`, `inbox-bulk-range`, `inbox-bulk-exit`, `inbox-bulk-delete`, `inbox-bulk-confirm`, `inbox-bulk-tag-open`, `inbox-bulk-remove-tag-open`, `inbox-bulk-organize-open`
- Code: `apps/ios-native/App/InboxScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testInboxBulk…)
- Notes: Bulk Delete confirms first and then offers Undo.

## Process Inbox

- Reach: Inbox › Process Inbox (N). The sheet walks one item at a time.
- Selectors: `process-inbox-sheet`, `process-inbox-title`, `process-inbox-next-action`, `process-inbox-skip`, `process-inbox-delegate-who`, `process-inbox-project-search`, `process-inbox-close`, `process-inbox-toast`
- Code: `apps/ios-native/App/ProcessInboxSheet.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testProcessInbox…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeProcessInboxUndoHostTests.swift`
- Notes: Filing, completion and Trash offer Undo for about 5.2 seconds. Settings › GTD › Inbox controls the two-minute prompt and the layout.

## Today's Focus

- Reach: Tab bar › Focus. The header has view options, Filters, a section toggle and a reorder toggle.
- Shortcuts: In reorder mode, drag the handles or use the Move up and Move down accessibility actions. Long-press a saved-filter chip to delete it. Tap the star on a task card to add or remove the focus star.
- Selectors: `focus-title`, `focus-view-options`, `focus-filters-open`, `focus-toggle-sections`, `focus-reorder-toggle`, `focus-reorder-list`, `focus-saved-strip`, `focus-filter-save`, `task-focus-blocked`
- Code: `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/FocusControlsPanel.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testFocus…, testTaskFocus…)
- Notes: Reorder refuses more than 100 displayed rows. Filters reset on restart, but section folds and Show details persist on the device.

## Pomodoro

- Reach: Settings › GTD › Pomodoro settings turns it on. The timer panel then shows on Focus.
- Selectors: `gtd-pomodoro-enable`, `pomodoro-toggle`, `pomodoro-clock`, `pomodoro-reset`, `pomodoro-switch`, `pomodoro-task`, `pomodoro-complete`, `pomodoro-collapse`
- Code: `apps/ios-native/App/FocusControlsPanel.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativePomodoroAlarmEffects.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask551Pomodoro…, testTask583Pomodoro…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativePomodoroHostTests.swift`
- Notes: The task picker shows only when Link timer to task is on.

## Task editor

- Reach: Tap a task title. The sheet opens in Preview or Edit. More holds Duplicate, Share, Cancel, Delete, Skip this occurrence, Create project from task and, for Reference tasks, Convert to action.
- Selectors: `task-mode-view`, `task-mode-edit`, `task-editor-title`, `task-editor-note`, `task-editor-save`, `task-editor-save-close`, `task-editor-discard`, `task-more`, `task-duplicate`, `task-share`, `task-cancel`, `task-delete`, `task-skip-occurrence`, `task-promote`, `task-reference-convert-to-action`, `task-view-close`
- Code: `apps/ios-native/App/TaskViewSheet.swift`, `apps/ios-native/Sources/MindwtrNativeCore/EditorDraftStore.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskDuplicate…, testTaskShare…, testTaskCancellation…, testTaskDelete…, testTaskSkip…, testTaskPromotion…, testTaskPreview…, testGtdTaskEditor…)
- Notes: Settings › GTD › Task Editor sets the opening mode. Automatic opens Inbox taps in Edit and every other open in Preview. Tasks in archived projects stay read-only in Preview.

## Task attachments

- Reach: Task editor › Add link, Add file or Add photo. Tap a link title or file to open it.
- Selectors: `task-attachment-add-link`, `task-attachment-add-file`, `task-attachment-add-photo`, `task-attachment-link-input`, `task-attachment-link-save`, `task-attachment-open-dismiss`, `task-attachment-retry`
- Code: `apps/ios-native/App/TaskViewSheet.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAttachmentFiles.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAttachmentDraftStore.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskAttachment…, testTaskDownload…), `apps/ios-native/Tests/MindwtrNativeCoreTests/AttachmentDraftHostTests.swift`
- Notes: Imports stop at 50 MiB. Attachment changes stay in the task draft until Save.

## Draft recovery

- Reach: Shown by itself after a restart when an unsaved task draft exists. A Resume draft button also floats over the main screen.
- Selectors: `task-recovery-gate`, `task-recovery-resume`, `task-recovery-keep`, `task-recovery-discard`, `task-recovery-discard-confirm`, `task-recovery-open`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/Sources/MindwtrNativeCore/EditorDraftStore.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskDraftRecovery…), `apps/ios-native/Tests/MindwtrNativeCoreTests/EditorDraftRecoveryHostTests.swift`
- Notes: Reopening a draft checks its starting values against storage first. A conflicting newer edit is refused, not overwritten.

## Review and Mind Sweep

- Reach: Quick Access tab › Review (or Menu › Review) › Daily Review or Weekly Review. Mind Sweep opens from Weekly Review and from Inbox.
- Selectors: `review-guide-step`, `review-guide-count`, `review-guide-close`, `review-daily-process-inbox`, `review-weekly-process-inbox`, `review-mind-sweep-button`, `mind-sweep-input`, `mind-sweep-close`
- Code: `apps/ios-native/App/ReviewScreen.swift`, `apps/ios-native/App/MindSweepSheet.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testGtdReview…, testReviewRow…, testWeeklyReviewMindSweep…, testMindSweep…)
- Notes: Settings › GTD › Review turns the Daily Focus and Weekly Contexts steps on or off.

## Search and saved searches

- Reach: Search icon in the screen header. Save the query as a named search. Menu › Saved Searches opens one.
- Selectors: `search-input`, `search-clear`, `search-close`, `search-filters-open`, `search-save-open`, `saved-search-query`, `saved-search-delete`, `saved-search-write-name`, `saved-search-write-confirm`
- Code: `apps/ios-native/App/SearchScreen.swift`, `apps/ios-native/App/SavedSearchScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testSearchHeader…, testSavedSearch…)
- Notes: Saving an exact query that already has a saved search opens that search and does not rename it.

## Projects

- Reach: Menu › Projects (or the Quick Access tab when it is set to Projects) › a project. Project Details holds the actions menu (Complete, Duplicate, Delete, Cancel project), Sections, Notes, Tags, Area, attachments and task view options (Show completed, Sort, Filters, Order).
- Selectors: `projects-scroll`, `projects-create-title`, `projects-create-add`, `projects-tag-filter-toggle`, `project-detail-title`, `project-back`, `project-actions-menu`, `project-sections-open`, `project-notes-input`, `project-tags-open`, `project-area-open`, `project-task-view-options-button`, `project-attachment-add-link`
- Code: `apps/ios-native/App/ProjectsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testProjectSection…, testProjectNotes…, testProjectTags…, testProjectCompleted…, testProjectFile…, testProjectDownload…)
- Notes: Archived projects open as read-only previews. Pending Notes save before any view-control change or file action.

## Areas

- Reach: Menu › Projects › Manage areas, or Project Details › Area. Settings › Manage › Areas also creates, edits and deletes Areas.
- Selectors: `projects-manage-areas`, `area-manager-close`, `area-create-name`, `area-create-save`, `area-rename-save`, `area-order-sort-name`, `manage-area-add`, `manage-area-delete-confirm`
- Code: `apps/ios-native/App/ProjectsScreen.swift`, `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testArea…, testManageArea…, testProjectArea…)
- Notes: Renaming to an existing name merges the Areas. Delete moves live projects and direct area tasks to Unassigned.

## Contexts

- Reach: Menu › Contexts (or the Quick Access tab when it is set to Contexts).
- Shortcuts: Long-press a chip to add it to the current selection.
- Selectors: `contexts-search`, `contexts-filters`, `contexts-filter-save`, `contexts-more`
- Code: `apps/ios-native/App/ContextsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testContextsTokens…, testTask162ContextsRowIdentity…)

## Review and Contexts bulk selection

- Reach: Review (scope All or Due, groups expanded) or Contexts › long-press a task card. A bar shows the count, all six statuses, Add tag and Delete. Review also offers Share.
- Shortcuts: Tap a row's circle or card to toggle it.
- Selectors: screen prefix `review` or `contexts`, then `-bulk-count`, `-bulk-exit`, `-select-` (+ task id), `-bulk-status-` (+ status), `-bulk-tag-open`, `-bulk-share` (Review only), `-bulk-delete`, `-bulk-confirm`; `review-scroll`, `contexts-scroll`; Undo is `task-` + `statusListBulkDelete` + `-undo`
- Code: `apps/ios-native/App/ReviewScreen.swift`, `apps/ios-native/App/ContextsScreen.swift`, `apps/ios-native/App/WaitingScreen.swift` (StatusListBulkBar), `apps/ios-native/App/CoreModel.swift` (statusList…)
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testShownListBulk…), `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testReviewAndContextsBulk…, testReviewBulkMoveColdRecovery…)
- Notes: Review ends the selection when the scope changes or a selected row is folded away, as mobile does. Contexts drops only the selected rows a chip, search or filter hides. Mark reviewed, Organize, Remove tag, and Contexts' Add/Remove context are not built yet.

## Waiting For

- Reach: Menu › Waiting For. Filter by person.
- Shortcuts: Swipe right on a deferred project row to reactivate it.
- Selectors: `waiting-scroll`, `waiting-clear-person`, `waiting-projects-toggle`
- Code: `apps/ios-native/App/WaitingScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testWaitingPerson…, testDeferredProjectActivation…)
- Notes: A plain tap on a deferred project opens Project Details; only the swipe or the Reactivate action reactivates it.

## Someday/Maybe

- Reach: Menu › Someday. Section headings have Add task. The task status menu has Move to section. Long-press a task card to select; the bulk bar also has Move to section.
- Shortcuts: Swipe right on a deferred project row to reactivate it.
- Selectors: `someday-scroll`, `someday-overflow-button`, `someday-section-create-input`, `someday-section-create-save`, `someday-section-move-new-section`, `someday-section-move-undo`, `someday-section-task-input`, `someday-bulk-move-section`, `someday-section-move-choice-` (+ index)
- Code: `apps/ios-native/App/SomedayScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testSomedaySection…, testSomedayNested…, testSomedayGroupFilter…, testStatusListBulkSomedayMoveToSection…), `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testSomedaySectionBulkMove…)
- Notes: Move-to-section Undo lasts only for the session and does not return after restart. Bulk Move to section moves only the selected tasks not already in that section, ends the selection, and its Undo restores each task's own earlier section. Section rename and delete live in Settings › Manage.

## Waiting and Someday bulk selection

- Reach: Waiting For or Someday › long-press a task card. A bar shows the count, the five other statuses, Add tag, Range and Delete. Someday also shows Move to section.
- Shortcuts: Tap a row's circle or card to toggle it. Range selects every row between the last tapped row and the next tap.
- Selectors: screen prefix `waiting` or `someday`, then `-bulk-count`, `-bulk-exit`, `-select-` (+ task id), `-bulk-status-` (+ status), `-bulk-tag-open`, `-bulk-tag-input`, `-bulk-tag-save`, `-bulk-range`, `-bulk-move-section` (Someday only), `-bulk-delete`, `-bulk-confirm`; Undo is `task-` + `statusListBulkDelete` + `-undo`
- Code: `apps/ios-native/App/WaitingScreen.swift` (StatusListBulkBar), `apps/ios-native/App/SomedayScreen.swift`, `apps/ios-native/App/CoreModel.swift` (statusList…)
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testStatusListBulk…), `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testStatusListBulk…)
- Notes: Changing the person or a filter drops selected rows that are no longer on screen. Delete confirms first and then offers Undo. The row's own Move to section is hidden while selecting; use the bar's Move to section (`someday-bulk-move-section`) instead.

## Reference

- Reach: Menu › Reference. Swipe a row to reveal Next, Change status and Delete. Change status also offers Completion time and Move to project or area.
- Shortcuts: Swipe a row. Long-press a row to start bulk selection.
- Selectors: `reference-overflow-button`, `reference-status-completion-time`, `reference-status-destination`, `reference-destination-search`, `reference-backdate-save`, `reference-bulk-count`, `reference-bulk-exit`, `reference-bulk-add-tag`, `reference-bulk-delete`
- Code: `apps/ios-native/App/ReferenceScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testReference…, testTask192ReferenceBulkTrash…)
- Notes: A swipe alone never writes; tap the revealed button. Completion time saves at once and has no Undo.

## Board

- Reach: Menu › Board. Columns follow task status.
- Shortcuts: Drag a card by its handle to another column. Swipe a card sideways for Duplicate or Trash.
- Selectors: `board-scroll`, `board-search`, `board-search-clear`, `board-filter-title`, `board-filter-due`, `board-picker-search`
- Code: `apps/ios-native/App/BoardScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testBoardCrossColumnDrag…, testBoardDoneCrossDrop…, testBoardSwipe…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeBoardMoveTests.swift`

## Calendar

- Reach: Menu › Calendar (or the Quick Access tab when it is set to Calendar). Views are Month, Week, Day and Schedule. Tap a task for Remove from calendar or Delete.
- Selectors: `calendar-period-title`, `calendar-month-grid`, `calendar-query`, `calendar-selected-date`, `calendar-composer-query`, `calendar-composer-save`, `calendar-details-close`, `calendar-feed-message`
- Code: `apps/ios-native/App/CalendarScreen.swift`, `apps/ios-native/App/NativeCalendarEventEditor.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeCalendarReader.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testCalendarUnschedule…, testCalendarDelete…, testNativeCalendar…), `apps/ios-native/App/UITests/CalendarEventEditorUITests.swift`, `apps/ios-native/Tests/AppLifecycle/CalendarEventEditorLifetimeChecks.swift`
- Notes: External events show in all views and count as busy time. A failed feed shows a warning, so the view cannot suggest false free time.

## History

- Reach: Menu › History. It has separate Done and Archived tabs, each with search, filters and bulk selection.
- Selectors: `archive-search`, `archive-scroll`, `archive-select-toggle`, `archive-bulk-restore`, `archive-bulk-delete`, `done-overflow-button`, `archived-overflow-button`, `done-bulk-count`
- Code: `apps/ios-native/App/HistoryScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testHistory…, testTask172ArchiveRestore…, testTask180ArchiveBulkRestore…)
- Notes: Each tab keeps its own grouping, sort and folds after restart.

## Trash

- Reach: Menu › Trash. Swipe right on a task or project, then tap Restore. Select mode offers bulk Restore and Purge.
- Selectors: `trash-scroll`, `trash-select-toggle`, `trash-bulk-select-all`, `trash-bulk-restore`, `trash-bulk-purge`, `trash-purge-confirm`, `trash-clear`, `trash-retention-hint`
- Code: `apps/ios-native/App/TrashScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTrashTaskRestore…, testTrashProjectRestore…, testTask503…, testTask508…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeTrashPurgeHostTests.swift`
- Notes: A swipe alone does not write. Restoring a project does not reattach live tasks that Project Delete detached.

## Settings

- Reach: Menu › Settings. Rows include Manage, General, Notifications, Advanced, GTD, Data, Sync, About. A search field filters all settings.
- Selectors: `settings-search`, `settings-scroll`, `settings-back`, `settings-no-matches`
- Code: `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testGeneralPreferences…, testGeneralTheme…, testGeneralLanguage…, testGtd…)
- Notes: Failed saves keep the exact request for Retry and for recovery after a cold restart. A failed read after a saved write retries only the read.

## Settings › General

- Reach: Settings › General. Theme, Language, Show task age, Quick access view, Week starts on, Date format, Time format, Calendar system, App lock, Show tasks in system search.
- Selectors: `general-scroll`, `general-show-task-age`, `general-regional-toggle`, `general-app-lock`, `general-ios-search`, `general-picker-cancel`
- Code: `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testGeneral…, testQuickAccess…)

## Settings › Manage

- Reach: Settings › Manage. Areas, People, Contexts, Tags and Someday sections.
- Selectors: `manage-area-add`, `manage-person-create-open`, `manage-taxonomy-name`, `manage-taxonomy-save`, `manage-someday-name`, `manage-someday-save`, `manage-unassigned-color`
- Code: `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testManageArea…, testManagePerson…, testManageTaxonomy…, testSomedayManage…, testManageUnassigned…)
- Notes: Renaming a person updates matching task assignments. Deleting a person keeps every task assignment.

## Settings › GTD

- Reach: Settings › GTD. Default schedule time, Today's Focus limit, Default Project flow, Auto-archive, Review, Inbox, Capture, Task Editor and Pomodoro settings.
- Selectors: `gtd-scroll`, `gtd-default-area`, `gtd-inbox-scroll`, `gtd-review-scroll`, `gtd-capture-scroll`, `gtd-archive-scroll`, `gtd-field-scroll`
- Code: `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testGtdWorkflow…, testGtdInbox…, testGtdReview…, testGtdCapture…, testGtdTaskEditor…, testAutoArchive…)
- Notes: Task Editor opening mode is device-local. It is not saved to SQLite or synced.

## Notifications and reminders

- Reach: Settings › Notifications. Reminder notifications offer Open, Complete and Snooze.
- Selectors: `notifications-title`, `notifications-scroll`, `notifications-time-wheel`, `notifications-picker-done`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeReminderResponse.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeReminderEffects.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeNotificationsSettings…, testNativeReminderResponse…), `apps/ios-native/Tests/MindwtrNativeCoreTests/ReminderResponseRouteHostTests.swift`
- Notes: Open waits for any active draft before it navigates. Real OS delivery has no physical-device proof yet.

## Settings › Data

- Reach: Settings › Data › Backup. Export Backup, Export CSV, Export as TaskNotes, Restore Backup, Merge Backup, and Import from Mindwtr CSV, Todoist, TickTick, DGT GTD and OmniFocus. Diagnostics sits below Backup.
- Selectors: `backup-disclosure`, `data-transfer-export`, `data-transfer-export-csv`, `data-transfer-export-tasknotes`, `data-transfer-restore`, `data-transfer-merge`, `data-transfer-import-csv`, `data-transfer-import-todoist`, `data-transfer-import-ticktick`, `data-transfer-import-dgt`, `data-transfer-import-omnifocus`, `backup-restore-confirm`, `backup-result-undo`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeBackupExportFile.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeBackupImportFile.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask198Backup…, testTask199CSVExport…, testTask202BackupRecovery…, testTask203CSVImport…, testTask204JSONRestore…, testTask205TodoistImport…, testTask207TickTickImport…, testTask208DGTImport…, testTask209OmniFocusImport…)
- Notes: JSON export holds attachment metadata, not file bytes. Exports go to the system share sheet.

## Diagnostics

- Reach: Settings › Data › Diagnostics. Debug logging toggle, share log, clear log.
- Selectors: `diagnostics-title`, `diagnostics-debug-logging`, `diagnostics-share`, `diagnostics-clear`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeDiagnosticsLogFile.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask197Diagnostics…)

## Sync and encryption

- Reach: Settings › Sync. Pick a backend, then set URL and credentials. Encryption controls sit on the same screen.
- Selectors: `sync-screen`, `sync-url`, `sync-username`, `sync-password`, `sync-token`, `sync-status`, `sync-reload`, `sync-error`, `sync-restart-gate`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeHTTPJobs.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeCryptoJobs.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSecretJobs.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeSync…, testNativeEncryption…, testNativeSelfHosted…, testNativeWebDAV…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeForegroundSyncTests.swift`
- Notes: An unconfirmed sync result blocks editing and shows a "close and reopen" screen (`sync-restart-gate`). Only WebDAV and self-hosted have forms here. Mixed-client sync is not accepted yet.

## Apple Reminders import

- Reach: Settings › Sync › Apple Reminders. Pick a list, then import. Auto import is optional.
- Selectors: `sync-apple-reminders`, `apple-reminders-screen`, `apple-reminders-list`, `apple-reminders-import`, `apple-reminders-auto`, `apple-reminders-delete`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAppleRemindersProvider.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAppleRemindersJobs.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask578Reminders…, testTask579Reminders…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeAppleRemindersImportRunTests.swift`
- Notes: The row is disabled while the Sync draft has unsaved changes.

## Settings › Advanced

- Reach: Settings › Advanced › External Calendar (device calendars, subscriptions, push to calendar) or AI assistant.
- Selectors: `advanced-title`, `calendar-settings-title`, `calendar-device-grant`, `calendar-device-enabled`, `calendar-subscription-url`, `calendar-subscription-add`, `calendar-push-enabled`, `ai-summary-title`, `ai-timeout-advanced`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeCalendarAuthorization.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeCalendarPushEffects.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeCalendar…, testNativeAISummary…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeCalendarSubscriptionAddHostTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeAISettingsProjectionTests.swift`
- Notes: Saving a calendar choice never asks for calendar permission. Only the enable action or Grant asks. The AI page is mostly a read-only summary.

## About and feedback

- Reach: Settings › About. Send feedback opens a form.
- Selectors: `about-app-name`, `about-version`, `about-update-open`, `feedback-message`, `feedback-email`, `feedback-submit`, `feedback-github`
- Code: `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask423About…, testTask427About…, testTask433Feedback…), `apps/ios-native/Tests/MindwtrNativeCoreTests/FeedbackHostTests.swift`

## App lock

- Reach: Settings › General › App lock. A lock screen with Unlock covers the app.
- Selectors: `general-app-lock`, `app-lock-gate`, `app-lock-unlock`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testAppLock…)
- Notes: App lock hides the app view; it does not encrypt the database. Turning it on asks for authentication first. Cold start and backgrounding lock the app again.

## System search (Spotlight)

- Reach: Settings › General › Show tasks in system search. Tapping a result opens the task.
- Selectors: `general-ios-search`, `general-ios-search-paused`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSearchIndex.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSearchSnapshot.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeSearch…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeSearchConsentTests.swift`
- Notes: It is off by default and stays paused while App lock is on. It publishes only task titles and project names.
