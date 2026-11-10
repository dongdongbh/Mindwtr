# Android native client

The native client is a Kotlin and Jetpack Compose app in `apps/android-native`. It replaces the React Native (RN) app in `apps/mobile` and must match it screen for screen. Every label on screen comes from core (`packages/core`), so the English labels below are the values in `packages/core/src/i18n/locales/en.ts`.

## Launch for testing

- **Dev identity.** The debug build installs as `tech.dongdongbh.mindwtr.nativeclient.dev`. It has its own database (`mindwtr-native-dev.db`) and its own link scheme, `mindwtr-native-dev`. It never reads or replaces the RN app on the same phone.
- **Build.** From the repo root run `bun install --frozen-lockfile`, then `node apps/android-native/scripts/build-bundle.mjs`, then `./gradlew :app:assembleDebug --offline` in `apps/android-native/android`. The checks install the play debug APK from the Gradle output folder unless you pass an APK path.
- **One shared phone.** All device checks run on one shared test phone. Each script takes the adb serial as its first argument: `node apps/android-native/scripts/check-<name>-device.mjs <adb-serial> [apk]`.
- **The lock.** Each check first runs itself again under `flock` on a lock file for that serial (`apps/android-native/scripts/device-lock.mjs`). So two runs never share the phone. A second run prints "waiting for another run" and waits up to 4 hours.
- **Batch runner.** `node apps/android-native/scripts/run-device-batch.mjs [check names] [--no-build] [--detach] [--log <dir>]` runs a batch. It builds the bundle and the Gradle variants, takes a batch-wide lock, runs each check with a 1-hour timeout, and runs `check-upgrade-device` last. The last line of `summary.txt` in the log folder is `VERDICT PASS n/n` or `VERDICT FAIL`.
- **Who has the phone.** `node apps/android-native/scripts/phone-queue.mjs` lists the run that holds the lock and the runs that wait.
- **Selectors.** Compose `testTag` values show up as the resource id. `apps/android-native/scripts/device.mjs` finds a node by the last part of its resource id (`tagged`), or by English text from `en.ts` (`button`, `tab`).
- **Keyboard.** Checks type through the phone's own keyboard. They stop with exit 3 unless the layout is English. Set `MINDWTR_KEYBOARD_OK=1` only after you checked the keyboard yourself.
- **Fault switches.** Debug builds read `debug.mindwtr.native.*` system properties (for example `fail_commit`, `journal_stop`, `language`). Release builds never read them.

## Inbox

- Reach: Tab bar › Inbox. The list header has Sort, Group, Filters, the Mind Sweep pill, and the "All areas" line.
- Shortcuts: Swipe a row right for Done or Focus. Swipe left for Organize, Dates…, Delete. Pull down to sync. Link `mindwtr-native-dev:///inbox`.
- Selectors: `task-row`, `swipe-done`, `read-retry`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/InboxScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/InboxViewModel.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskRowView.kt`
- Checks: `apps/android-native/scripts/check-toolbars-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/RowStatusControlTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ListViewStateTest.kt`
- Notes: Every list shows 50 rows first, and **More** loads the next 50. A row has no Done button, as in RN: completion is the swipe tray's Done or the status menu.

## Task row swipe actions

- Reach: Any task list row.
- Shortcuts: Swipe right on an open task: Done, Focus (or Remove from focus). Long press Done in that tray to pick a past completion time. Swipe left: Organize, Dates…, Delete. A done task swipes right to Restore to Inbox. A reference task swipes right to Next. Tap the open row to shut the tray.
- Selectors: `swipe-done`, `swipe-focus`, `dates-sheet`, `dates-startTime`, `dates-dueDate`, `dates-save`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskRowView.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/InboxViewModel.kt`, `packages/core/src/native-host-contract-task-swipe.ts`, `packages/core/src/task-row-swipe-actions.ts`
- Checks: `apps/android-native/scripts/check-swipe-tray-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/SwipeTrayTest.kt`, `packages/core/src/native-host-contract-task-swipe.test.ts`
- Notes: Core builds each tray, the same table RN reads. Each tray button's test tag is `swipe-<action id>` (done, focus, organize, dates, delete, restore, next). Organize opens the status and Move menu. Dates… opens the Task dates sheet; Save writes once. Swipes are off during bulk selection.

## Add to checklist

- Reach: An Inbox row whose task is only a title › its status control › Destination › Add to checklist…. Pick an open task; the search narrows by title.
- Selectors: `checklist-target-search`, `checklist-target`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskRowView.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/InboxViewModel.kt`, `packages/core/src/native-host-contract-checklist-move.ts`, `packages/core/src/task-checklist-move.ts`
- Checks: `apps/android-native/scripts/check-checklist-target-device.mjs`, `packages/core/src/native-host-contract-checklist-move.test.ts`, `packages/core/src/task-checklist-move.test.ts`
- Notes: The title becomes one unchecked item on the target and the Inbox item goes to Trash, in one write. The toast "Added to checklist" has Undo, which brings the item back and removes only its line. Targets with a checklist come first and show their n/m progress. A task with notes, dates, tags, a project or any other detail does not offer it, as in RN.

## Task row checklist

- Reach: Any task list row whose task has a checklist (not the Inbox, as in RN) › the checklist badge (n/m) under the title.
- Shortcuts: Tap the badge to show or fold the items. Tap an item to tick or untick it. Type in + Add Item and press Done to add one. Ticks made within 200 ms go out as one write.
- Selectors: `row-checklist-toggle`, `row-checklist-item`, `row-checklist-add`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskRowView.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/RowChecklist.kt`, `packages/core/src/native-host-contract-task-row-checklist.ts`, `packages/core/src/task-row-checklist.ts`
- Checks: `apps/android-native/scripts/check-row-checklist-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/RowChecklistTest.kt`, `packages/core/src/native-host-contract-task-row-checklist.test.ts`, `packages/core/src/task-row-checklist.test.ts`
- Notes: A tick changes the item by its id on the latest task. A list-mode task completes when its last item is ticked. A Reference item's list ticks, but the reference never completes or enters Focus. Rows in an archived project show the items read-only. Selection mode hides + Add Item. Open lists fold when the screen or tab changes, as RN's rows reset. While an action waits for Retry, ticks are off. A tick on a task deleted elsewhere is dropped without a message, as in RN.

## Selection mode and Bulk organize

- Bulk organize status includes Inbox for returning tasks to processing; existing project, notes, tags and dates stay unchanged unless explicitly edited.

- Reach: Long-press a row in Inbox, Waiting For, Someday/Maybe, Reference, or Done. The bulk bar shows the count, statuses, Add tag, Remove tag, Delete, and Bulk organize (Inbox only).
- Selectors: `organize-create`, `organize-picker-search`, `organize-create-failed`, `destination-search`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/BulkBar.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ListActions.kt`
- Checks: `apps/android-native/scripts/check-toolbars-device.mjs`, `apps/android-native/scripts/check-sweep-saved-device.mjs`
- Notes: The bar has **Select all**, which RN lacks (a deliberate difference). Core refuses Select all if the rows changed since it was shown.

## Process Inbox

- Reach: Inbox › Process Inbox (N). The header switches between Guided and Quick and has Skip and Close.
- Selectors: `process-inbox`, `process-title`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ProcessInbox.kt`
- Checks: `apps/android-native/scripts/check-process-inbox-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ProcessInboxHeaderTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ProcessInboxScrollTest.kt`
- Notes: The count shows 99+ above 99, but TalkBack reads the exact count. After a process death the app lands on the Inbox and resends the owed answer in the background. The project chips follow the Projects view order (areas in order, then each project's order), with Someday / Waiting projects after a heading (`process-inbox-deferred-projects`).

## Mind Sweep

- Reach: Inbox › Mind Sweep pill. An empty Inbox shows Mind Sweep in place of Process Inbox. The Weekly Review links to it too.
- Selectors: `mind-sweep`, `mind-sweep-start`, `mind-sweep-input`, `mind-sweep-add`, `mind-sweep-back`, `mind-sweep-close`, `mind-sweep-group-title`, `mind-sweep-summary`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MindSweep.kt`
- Checks: `apps/android-native/scripts/check-sweep-saved-device.mjs`
- Notes: Back and Next go to the step core put on the button, so a fast double tap moves one step (RN moves two). Text typed while Add is pending stays in the box.

## Quick capture popup

- Reach: Tab bar › center + button. The popup has the field, More (note, Focus, due time, contexts, area, project, priority, dates, Import .txt), Add another, Save & edit, and Save.
- Shortcuts: Link `mindwtr-native-dev:///open-feature?feature=capture`.
- Selectors: `quick-capture`, `capture-title`, `capture-note`, `quick-add-preview`, `capture-scroll`, `capture-import-text`, `capture-processing`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CaptureScreen.kt`
- Checks: `apps/android-native/scripts/check-capture-device.mjs`, `apps/android-native/scripts/check-keyboard-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/TokenCommitTest.kt`
- Notes: Several lines ask core's question first. Create tasks writes a recovery snapshot, then one task per line in one write. Close discards the draft, as in RN.

## Capture screen

- Reach: Opens from a capture link, a share, an assistant note, the widget's quick capture, or the "Add task with details" app shortcut. The card has the title, the description, Save & edit, Save, and Cancel.
- Shortcuts: Links `mindwtr-native-dev:///capture?title=…` and `mindwtr-native-dev:///capture-quick`.
- Selectors: `capture-modal`, `capture-modal-title`, `capture-modal-description`, `capture-modal-save`, `capture-modal-save-edit`, `capture-modal-cancel`, `capture-modal-attachment`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CaptureModal.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CaptureModalModel.kt`
- Checks: `apps/android-native/scripts/check-capture-modal-device.mjs`, `apps/android-native/scripts/check-keyboard-device.mjs`
- Notes: The draft survives rotation and process death. A capture link with no title shows the toast "Capture shortcut unavailable" and opens nothing.

## Voice capture

- Reach: Capture popup › microphone (Start recording, Stop recording). It needs speech to text on in Settings › Advanced › AI assistant.
- Selectors: `capture-mic`, `capture-recording`, `voice-alert-ok`, `ai-speech-card`, `ai-speech-enabled`, `ai-speech-base-url`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CaptureVoice.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/VoiceRecorder.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostVoice.kt`, `apps/android-native/bundle/host-voice.ts`
- Checks: `apps/android-native/scripts/check-voice-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/CaptureVoiceTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/VoiceRecorderTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/HostVoiceTest.kt`
- Notes: Closing the popup while recording saves nothing and leaves no file. A refused microphone permission shows an alert and records nothing.

## Focus

- Reach: Tab bar › Focus. A cold start opens Focus, as RN does.
- Shortcuts: Pull down to sync. Link `mindwtr-native-dev:///open-feature?feature=today`.
- Selectors: `task-row`, `task-edit-focus-star`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/FocusScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/FocusModel.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/FocusControls.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/PullSync.kt`
- Checks: `apps/android-native/scripts/check-focus-device.mjs`, `apps/android-native/scripts/check-focus-small2-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/FocusViewSameShownTest.kt`
- Notes: Sections, titles, and totals are core's, in core's order. On the reorder screen only the dragged row moves (RN also slides the others); the stored order is the same.

## Pomodoro

- Reach: Focus › Pomodoro card at the top of the list, when core shows it.
- Selectors: `pomodoro-card`, `pomodoro-clock`, `pomodoro-primary`, `pomodoro-picker`, `pomodoro-task`, `pomodoro-done`, `pomodoro-fold`, `pomodoro-event`, `pomodoro-link`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/Pomodoro.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/PomodoroAlarms.kt`
- Checks: `apps/android-native/scripts/check-notifications-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PomodoroClockTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PomodoroAlarmBookTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PomodoroPlanGateTest.kt`
- Notes: The end alarm is armed even if the app is closed. A tap on the alert opens the app and removes the alert.

## Task editor

- Reach: Tap a task row. The editor opens on its Form tab. A Done task opens on its View tab.
- Selectors: `task-preview-mark-done`, `task-editor`, `markdown-toolbar`, `task-description-fullscreen`, `task-description-preview`, `editor-waiting-for`, `monthly-custom`, `monthly-custom-interval`, `editor-destination-search`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskEditor.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MarkdownToolbar.kt`
- Checks: `apps/android-native/scripts/check-editor-device.mjs`, `apps/android-native/scripts/check-monthly-repeat-device.mjs`, `apps/android-native/scripts/check-keyboard-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EditorNavigationTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EditorActionSaveTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PreviewCompletionTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/MarkdownDraftTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/MonthlyCustomTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/TaskEditorFocusRevealTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/DestinationMatchesTest.kt`
- Notes: The draft survives rotation and process death. If a save was in flight at a death, the relaunch sends that same save again and closes the editor. Destination lists projects in the Projects view order, with Someday / Waiting projects after them under their own heading. Destination has RN's search field: it filters projects and areas by title, ignoring case and outer spaces.

- View completion: Mark Done in the visible Status card queues pending checklist text before draft Done, then sends one normal owned Save. The draft queue and retained save request survive recovery; a refused draft edit cancels queued completion. Repeat taps, draft changes and Close are blocked during completion. A failed save retains the draft and existing Retry; acknowledgement precedes closing. Reference, terminal, Trash, projected and read-only/archived-project previews have no action.

## Task View tab and checklist

- Reach: Editor › View tab. The checklist has add, reorder by drag, and Reset checklist.
- Selectors: `task-view`, `view-checklist-add`, `checklist-add-item`, `checklist-item-input`, `checklist-reset`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TaskView.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ChecklistDrag.kt`
- Checks: `apps/android-native/scripts/check-settings-editor-device.mjs`, `apps/android-native/scripts/check-editor-menu-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/TaskEditorChecklistTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/TaskEditorChecklistAddTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ChecklistDragTest.kt`
- Notes: Settings › GTD › Task editor layout decides whether a task opens on Preview (View) or on the Form.

## Task editor menu

- Reach: Editor › ⋯ menu. It has Copy Mindwtr link, Copy task ID, Share, Duplicate, Delete, Cancel task, and Create project (promote to project).
- Selectors: `editor-menu`, `editor-more`, `promote-dialog`, `promote-title`, `promote-confirm`, `promote-expand`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EditorMenu.kt`
- Checks: `apps/android-native/scripts/check-editor-menu-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EditorMenuTest.kt`
- Notes: Duplicate opens the copy, not the original. Delete and Cancel task each show a toast with Undo.

## Next action prompt

- Reach: Finish the last next action of a project. The prompt "What's the next action?" offers candidates, Add next action, Save & edit, Skip, and Complete project.
- Selectors: `next-action-prompt`, `next-action-candidate`, `next-action-input`, `next-action-add`, `next-action-save-edit`, `next-action-skip`, `next-action-complete-project`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/NextActionPrompt.kt`
- Checks: `apps/android-native/scripts/check-next-action-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/NextActionPromptModelTest.kt`
- Notes: Skip writes nothing. Add next action uses the quick-add grammar, so typed tokens set fields.

## Completion time

- Reach: Tap the completion date on a done row (History › Done or Archived). A date dialog opens, then a time dialog.
- Selectors: `row-completed-at`, `completed-at-card`, `completed-at-minutes`, `completed-at-save`, `completed-at-cancel`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CompletedAtFlow.kt`
- Checks: `apps/android-native/scripts/check-backdate-device.mjs`, `apps/android-native/scripts/check-toolbars-device.mjs`
- Notes: Core stores the picked local day and time as a whole minute. Moving the date keeps the task done.

## Global search

- Reach: Header › search button. It has the field, Clear, the filter sheet, project and task results, Mark Done, and Save Search.
- Shortcuts: Link `mindwtr-native-dev:///global-search?q=…`.
- Selectors: `global-search`, `search-result`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SearchScreen.kt`
- Checks: `apps/android-native/scripts/check-search-device.mjs`
- Notes: A task result opens the editor over the search. Its row on the list beneath is outlined for 3.5 seconds.

## Saved searches

- Reach: Search › Save Search. Open one from Menu (the saved searches list). Delete is the red trash in its header.
- Selectors: `saved-search-delete`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SavedSearchScreen.kt`
- Checks: `apps/android-native/scripts/check-sweep-saved-device.mjs`, `apps/android-native/scripts/check-search-device.mjs`
- Notes: A deleted saved search shows core's empty line, with Inbox and Back.

## Area switcher

- Reach: Header › left side (the area label, for example "All areas"). A tap opens the area sheet.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AreaSwitcher.kt`
- Checks: `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/MenuAreaFilterTest.kt`
- Notes: No device check selects an area here; the language check only reads the "All areas" line.

## Menu (More sheet)

- Reach: Tab bar › Menu. The sheet has Trash, Board, History, Settings, the saved searches, and six tiles (Waiting For, Someday/Maybe, Review, Reference, Contexts, Calendar, or Projects).
- Shortcuts: Drag down, tap the backdrop, press Back, or tap Menu again to close it.
- Selectors: `more-sheet`, `menu-screen`, `menu-sync-dot`, `menu-dialog-field`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MoreSheet.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MenuModel.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MenuWidgets.kt`
- Checks: `apps/android-native/scripts/check-menu-device.mjs`
- Notes: The quick-access tab (Review by default) moves Projects into the sheet. A Menu screen opens full screen over the tabs; Back returns to the tabs.

## Waiting For

- Reach: Menu › Waiting For. Person chips (All, each person, Clear) narrow the list.
- Shortcuts: Link `mindwtr-native-dev:///waiting`.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/WaitingScreen.kt`
- Checks: `apps/android-native/scripts/check-menu-device.mjs`, `apps/android-native/scripts/check-next-action-device.mjs`
- Notes: Parked projects show here too. Swipe a parked project right to make it active.

## Someday/Maybe

- Reach: Menu › Someday/Maybe. The list menu has Filters, Sort, Group, Details, and New section…
- Shortcuts: Link `mindwtr-native-dev:///open-feature?feature=someday`.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SomedayScreen.kt`
- Checks: `apps/android-native/scripts/check-someday-projects-device.mjs`, `apps/android-native/scripts/check-menu-device.mjs`
- Notes: A row's status menu adds Move to section…, and its toast has Undo. Someday projects show as parked rows with no Projects block above the list.

## Reference and History

- Reach: Menu › Reference. Menu › History › Done or Archived tab. Archived has Tasks and Projects chips, search, Select, Restore, and Delete.
- Shortcuts: On Archived, swipe right to Restore and left to Delete.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/StatusListScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ArchiveScreen.kt`
- Checks: `apps/android-native/scripts/check-menu-device.mjs`, `apps/android-native/scripts/check-journal-device.mjs`, `apps/android-native/scripts/check-toolbars-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ReferenceGroupByTest.kt`
- Notes: Restore puts a task back in the Inbox. History keeps its open tab through rotation and process death.

## Contexts

- Reach: Menu › Contexts (or the quick-access tab when set to Contexts). Chips: All, No context, each context and tag, and an All/Any switch.
- Shortcuts: Swipe a row right for Done or Focus, and left for Organize, Dates…, Delete.
- Selectors: `contexts-list`, `list-search`, `token-picker-list`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ContextsScreen.kt`
- Checks: `apps/android-native/scripts/check-review-device.mjs`, `apps/android-native/scripts/check-review-organize-device.mjs`
- Notes: The bulk bar here adds Add context and Remove context.

## Trash

- Reach: Menu › Trash. It has Select, Clear Trash, and the retention hint.
- Shortcuts: Swipe a row right to Restore and left to Delete permanently.
- Selectors: `trash-list`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/TrashScreen.kt`
- Checks: `apps/android-native/scripts/check-review-device.mjs`
- Notes: Clear Trash sends the revision its question showed, so core refuses it if Trash changed in between.

## Review, Weekly Review, and Daily Review

- Reach: Tab bar › Review (the default quick-access tab) › Start Review › Weekly or Daily. Rows due for review have Mark reviewed and Review in 1 week.
- Selectors: `review-list`, `weekly-review`, `daily-review`, `review-step-indicator`, `review-step-title`, `review-step-scroll`, `review-complete-project-prompt`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ReviewScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ReviewOrganize.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/WeeklyReviewScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/DailyReviewScreen.kt`
- Checks: `apps/android-native/scripts/check-review-device.mjs`, `apps/android-native/scripts/check-review-organize-device.mjs`, `apps/android-native/scripts/check-weekly-complete-device.mjs`
- Notes: Close keeps the review step on the device, and Finish deletes it. Organize on Review sends the task revisions it showed, so a stale write is refused. In Weekly Review's Projects step, an open project card has Complete under Open project; it asks first while the project has unfinished tasks, and the step stays after the last project is completed.

## Calendar

- Reach: Menu › Calendar (or the quick-access tab). Modes: month, week, day, and schedule. The header has ‹, Today, and ›.
- Shortcuts: Swipe sideways on the month or day to move one period. Tap the day timeline to open the composer at that time. Link `mindwtr-native-dev:///calendar`.
- Selectors: `calendar`, `calendar-title`, `calendar-add`, `calendar-composer`, `calendar-composer-query`, `calendar-composer-save`, `calendar-sheet`, `calendar-block`, `calendar-timeline`, `calendar-search`, `calendar-schedule`, `calendar-all-day-more`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CalendarScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CalendarModel.kt`
- Checks: `apps/android-native/scripts/check-calendar-board-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/CalendarVisitTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/WeekStartScrollTest.kt`
- Notes: The Calendar's place, sheet, and composer draft survive rotation and process death.

## External calendars

- Reach: Settings › Advanced › External Calendar. It has calendar URL subscriptions (Add, Test), Device calendar, and the push to a Mindwtr calendar (Delete Mindwtr calendar).
- Selectors: `calendar-url`, `calendar-device`, `calendar-device-body`, `calendar-grant`, `calendar-push`, `calendar-delete-confirm`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CalendarSettings.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostCalendars.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/CalendarPushWrites.kt`, `apps/android-native/bundle/host-calendar.ts`
- Checks: `apps/android-native/scripts/check-calendar-feeds-device.mjs`, `apps/android-native/scripts/check-upgrade-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/HostCalendarsTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/CalendarPushWritesTest.kt`
- Notes: A subscription URL is never written to the journal, the log files, or logcat. Feed requests carry no Origin header.

## Board

- Reach: Menu › Board. Five status columns, a search box, Clear, and Filters.
- Shortcuts: Swipe a card right past half to duplicate it; left past half to delete it (no question, no Undo, as in RN). Hold a card 180 ms to drag it to another column.
- Selectors: `board`, `board-search`, `board-filters`, `board-column`, `board-card`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/BoardScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/BoardModel.kt`
- Checks: `apps/android-native/scripts/check-calendar-board-device.mjs`, `apps/android-native/scripts/check-review-organize-device.mjs`
- Notes: A drop sends one move, so only the moved card is written.

## Projects

- Reach: Tab bar › quick-access tab when set to Projects; otherwise Menu › Projects. The top field adds a project. Manage areas sets area order and colors, and a tap on an area name renames it. A project row's "…" opens Move up, Move down and Area (Move to area); an area heading's "…" opens Manage areas on that area, ready to rename. A rename to another area's name (any case) is refused. In a project, a long press on a task enters selection: the bar above the list moves the picked tasks to a status, organizes, tags, removes tags or deletes them, and Reorder opens project task Reorder. Back leaves selection before the project.
- Selectors: `projects-manage-areas`, `project-area-manager`, `project-area-new-name`, `project-area-save`, `project-row-menu-`, `project-row-menu-sheet`, `project-area-move-sheet`, `project-area-picker-`, `project-area-menu-`, `project-area-name-`, `project-area-rename-input`, `project-area-rename-taken`, `area-rename-save`, `project-area-new`, `project-reorder-list`, `project-actions-menu-button`, `project-actions-sheet`, `project-add-task-button`, `project-completed-heading`, `project-task-filter-button`, `project-task-view-options-button`, `project-view-options-sheet`, `project-view-reorder-option`, `project-task-reorder-toggle`, `project-task-reorder-row`, `project-task-drag-handle`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ProjectsScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AreaOrderSheet.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/BulkBar.kt`
- Checks: `apps/android-native/scripts/check-projects-device.mjs`, `apps/android-native/scripts/check-projects-menus-device.mjs`, `apps/android-native/scripts/check-project-select-device.mjs`, `packages/core/src/native-host-contract-project-bulk-android.test.ts`, `apps/android-native/bundle/host-area-rename.test.ts`, `packages/core/src/native-host-contract-area-rename.test.ts`, `apps/android-native/scripts/check-onboarding-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ProjectMovesTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ProjectReorderAnchorTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/StaleMoveTest.kt`
- Notes: Archived projects show as closed. A project opened from the editor returns to the project on Close. Back from a project returns to the screen it was opened from (Someday, Review, Focus, a menu list); a project opened from the Projects list returns to the list.

## Project details

- Reach: Projects › a project › Details. It holds status, area, dates (Review date), scope (Sequential, Parallel), notes with Preview, tags, sections, and attachments. The ⋯ sheet has Duplicate, Archive, Convert to section, and Delete.
- Shortcuts: Link `mindwtr-native-dev:///open?project=<id>`.
- Selectors: `project-title-input`, `project-details-toggle`, `project-details-status`, `project-area-sheet`, `project-notes-input`, `project-notes-preview`, `project-tag-input`, `project-section-manager`, `project-section-title-input`, `project-details-attachments`, `project-convert-sheet`, `project-delete-button`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/ProjectDetails.kt`
- Checks: `apps/android-native/scripts/check-project-details-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ProjectDetailsTest.kt`
- Notes: Preview shows the typed notes and stores nothing. Review date stores the picked hour and minute with seconds at 0.

## Attachments

- Reach: Editor › Attachments › Add file, Add photo, or Add link. Project › Details › attachments. A row opens the file in another app or removes it.
- Selectors: `attachment-add-file`, `attachment-link-sheet`, `attachment-link-input`, `attachment-link-save`, `attachment-row`, `attachment-image-preview`, `attachment-audio`, `project-attachment-add-link`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/Attachments.kt`, `apps/android-native/bundle/host-attachments.ts`
- Checks: `apps/android-native/scripts/check-attachments-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/DraftAttachmentsTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/AttachmentLogTest.kt`
- Notes: Files are copied into the app and named by their IDs. Remove soft-deletes the attachment (it sets deletedAt).

## Missing attachment files

- Reach: Settings › Sync, after a sync location change: "Some attachment files are missing" › Continue without these files, or Cancel.
- Selectors: `sync-missing-files-continue`, `sync-missing-files-cancel`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SyncSettings.kt`
- Checks: `apps/android-native/scripts/check-continue-without-files-device.mjs`
- Notes: After Continue the attachment stays live and shows as missing. Remove then soft-deletes it.

## Share to Mindwtr

- Reach: Another app › Share › Mindwtr. Text, images, audio, video, and files are accepted. The capture screen opens with the shared content.
- Selectors: `capture-modal`, `capture-modal-attachment`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SharedFileStager.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EntryPoints.kt`
- Checks: `apps/android-native/scripts/check-share-files-device.mjs`, `apps/android-native/scripts/check-entry-points-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/SharedFileStagerTest.kt`
- Notes: A file over 50 MiB is skipped, and no copy is left. Cancel stores nothing.

## Links, app shortcuts, and assistant notes

- Reach: Long-press the launcher icon for app shortcuts. Open a `mindwtr-native-dev://` link. Ask Google Assistant to make a note.
- Shortcuts: Links `/inbox`, `/waiting`, `/calendar`, `/open-feature?feature=today|someday|capture`, `/open?task=<id>`, `/open?project=<id>`, `/global-search?q=…`, `/capture?title=…`, `/capture-quick`, `/widget-list`.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EntryPoints.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EntryQueue.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EntryLifecycle.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/UpNoteLink.kt`, `apps/android-native/scripts/build-shortcuts.mjs`
- Checks: `apps/android-native/scripts/check-entry-points-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EntryQueueTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EntryLifecycleTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/UpNoteLinkTest.kt`
- Notes: The dev build uses the `mindwtr-native-dev` scheme; a release uses `mindwtr`. Do not send `mindwtr://` links in a dev check: they reach the RN app.

## Home-screen widgets and Quick Settings tile

- Reach: Home screen › Widgets › Mindwtr (Tasks, Compact, Quick capture). Quick Settings › the Mindwtr capture tile (RN's tile class).
- Shortcuts: Tap a widget row's ring to complete it. The widget header opens the app or a widget list.
- Code: `apps/android-native/android/widget/src/main/java/tech/dongdongbh/mindwtr/androidwidget/CaptureSyncHeadlessService.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostWidgets.kt`, `apps/android-native/bundle/host-widgets.ts`, `apps/android-native/scripts/build-widgets.mjs`, `apps/mobile/modules/android-widget`
- Checks: `apps/android-native/scripts/check-widgets-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/WidgetRefreshGateTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/WidgetAudioDrainTest.kt`, `apps/android-native/android/widget/src/test/java/tech/dongdongbh/mindwtr/androidwidget/CaptureSyncHeadlessServiceTest.kt`
- Notes: The widget code is RN's module, compiled as is. A ring tap is queued and completed by a background job, even if the app was killed first.

## Widget list

- Reach: A widget's list link opens the list full screen. Back leaves it.
- Shortcuts: Link `mindwtr-native-dev:///widget-list`.
- Selectors: `swipe-done`, `swipe-focus`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/WidgetListScreen.kt`
- Checks: `apps/android-native/scripts/check-widget-list-device.mjs`
- Notes: A saved filter that is gone shows "No results" with no rows.

## Automation capture

- Reach: Settings › GTD › Capture defaults › Automation capture. When on, the card shows the token and Copy token.
- Shortcuts: Other apps send the capture intent (`tech.dongdongbh.mindwtr.action.CAPTURE`) with the token. Context automation broadcasts activate or deactivate a context.
- Selectors: `android-capture-intent-switch`, `android-capture-intent-token`, `android-capture-intent-copy`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CoreWork.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CoreJob.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/contextautomation/ContextAutomationReceiver.kt`
- Checks: `apps/android-native/scripts/check-runner-device.mjs`, `apps/android-native/scripts/check-bgsync-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/CoreJobTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/contextautomation/ContextTriggerTest.kt`
- Notes: Off, or a wrong token, queues and stores nothing. Each capture is stored once by the background job, with no screen shown.

## Settings and General

- Reach: Menu › Settings. The menu has a search field and General, GTD, Manage, Data, Notifications, Sync, Advanced, and About. General has Theme, Language, Week starts on, the quick-access view, and App lock.
- Selectors: `settings-search`, `settings-picker`, `settings-field-sheet`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SettingsScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SettingsModel.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/Labels.kt`
- Checks: `apps/android-native/scripts/check-settings-editor-device.mjs`, `apps/android-native/scripts/check-language-device.mjs`
- Notes: A new language reloads every label at once. The language check sets the debug property `debug.mindwtr.native.language`, so it never changes the phone's language.

## Manage

- Reach: Settings › Manage. Core's five sections include areas, people, contexts, and tags. A row opens the editor dialog.
- Selectors: `manage-editor`, `manage-editor-name`, `manage-editor-save`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SettingsScreen.kt`
- Checks: `apps/android-native/scripts/check-settings-editor-device.mjs`
- Notes: A new area named like a live one shows the taken-name line, and Save writes nothing.

## App lock

- Reach: Settings › General › App lock. Require unlock sets the relock delay.
- Selectors: `app-lock`, `app-lock-message`, `app-lock-unlock`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AppLock.kt`
- Checks: `apps/android-native/scripts/check-app-lock-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/AppLockRelockTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/EntryLockHoldTest.kt`
- Notes: The check runs on a phone with no screen lock and never sets one. A link that arrives while locked waits in the entry queue until unlock.

## System search

- Reach: Settings › General › Expose to system search.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostAppSearch.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/AppSearchIndex.kt`, `apps/android-native/bundle/host-app-search.ts`
- Checks: `apps/android-native/scripts/check-app-search-device.mjs`
- Notes: Mark Done removes a task from the index. Turning the setting off empties the index.

## Sync

- Reach: Settings › Sync. Backends: WebDAV, self-hosted cloud, and File Sync (Select Folder). It has Test connection, Allow insecure connections (HTTP), Save, Sync now, and sync history.
- Shortcuts: Pull down on a list to sync.
- Selectors: `sync-url`, `sync-username`, `sync-token`, `sync-save`, `sync-now`, `sync-status`, `sync-error`, `sync-select-folder`, `sync-history`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SyncSettings.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostSyncLock.kt`, `apps/android-native/bundle/host-sync.ts`
- Checks: `apps/android-native/scripts/check-sync-device.mjs`, `apps/android-native/scripts/check-bgsync-device.mjs`, `apps/android-native/scripts/check-file-sync-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PullSyncFailureTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/HostSyncLockTest.kt`
- Notes: The password is sealed in secure storage and never logged. Background sync runs every 15 minutes and skips during a failure cooldown.

## Sync encryption

- Reach: Settings › Sync › Encryption › Enable encryption. It also has Disable, Show passphrase, and the locked state that asks for the passphrase.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SyncSettings.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostCrypto.kt`
- Checks: `apps/android-native/scripts/check-encryption-device.mjs`, `apps/android-native/scripts/check-encryption-dry-run.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PassphraseFieldsTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/HostCryptoTest.kt`
- Notes: Argon2id key derivation never blocks the engine: a tap during it still answers. After a restart the phone syncs the encrypted folder with no passphrase typed.

## Data: backup, import, and recovery

- Reach: Settings › Data. It has Export Backup, Merge Backup, Import from Todoist, Mindwtr CSV import, Getting Started content, and Recovery snapshots.
- Selectors: `data-transfer-export`, `data-transfer-merge`, `recovery-snapshots-disclosure`, `backup-disclosure`, `import-disclosure`, `import-guide-link`, `add-getting-started-content`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/DataTransfer.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/BackupOperations.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/RecoverySnapshots.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/DataChannel.kt`
- Checks: `apps/android-native/scripts/check-data-device.mjs`, `apps/android-native/scripts/check-data-deadlines-device.mjs`, `apps/android-native/scripts/check-data-deadlines2-device.mjs`, `apps/android-native/scripts/check-data-large-import-device.mjs`, `apps/android-native/scripts/check-data-no-undo-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/DataFilesTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/BackupOperationsTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/RecoverySnapshotsTest.kt`
- Notes: The four small scripts each run one part of `check-data-device.mjs` through the `D1C_PART` variable. An import toast has Undo that brings the old library back.

## Archive retention

- Reach: Settings › Data › Archive retention. Pick days or Never, then Save, review, and Apply or Cancel.
- Selectors: `archive-retention-days`, `archive-retention-never`, `archive-retention-save`, `archive-retention-review`, `archive-retention-apply`, `archive-retention-cancel`, `archive-retention-save-failed`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SettingsScreen.kt`
- Checks: `apps/android-native/scripts/check-archive-retention-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ArchiveRetentionRunTest.kt`
- Notes: Apply stores the days and removes nothing by itself. The purge runs later, only after a sync in that session.

## Diagnostics log

- Reach: Settings › Data › Debug logging, Share log, and Clear log. Data also holds the analytics question.
- Selectors: `settings-share-log`, `settings-clear-log`, `analytics-keep`, `analytics-disable`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SettingsScreen.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/DiagnosticsLogFile.kt`
- Checks: `apps/android-native/scripts/check-log-device.mjs`
- Notes: Share log opens the system share sheet; Back sends nothing. With logging off, the app writes no log file.

## Notifications and reminders

- Reach: Settings › Notifications. It has Task reminders, Daily digest, Weekly review (day and time), and Quick capture in notification bar.
- Shortcuts: A reminder notification has Snooze. A tap opens the task.
- Selectors: `exact-alarm-notice`, `exact-alarm-allow`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/NotificationsSettings.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/Reminders.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CoreNotifications.kt`, `apps/android-native/bundle/host-reminders.ts`
- Checks: `apps/android-native/scripts/check-notifications-device.mjs`, `apps/android-native/scripts/check-reminders-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ReminderPlanTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ReminderJobTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/ReminderStartTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/NotificationsTimeTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/PersistentCaptureTest.kt`
- Notes: A force-stop drops every alarm, as a reboot does; the app remakes them in the background. A task with only date-only dates gets no alarm.

## AI assistant

- Reach: Settings › Advanced › AI assistant › Enable AI assistant. It has the provider, model suggestions, and the API key. AI also shows in Process Inbox (clarify) and Weekly Review.
- Selectors: `ai-enabled`, `ai-picker`, `ai-consent-agree`, `ai-consent-cancel`, `ai-answer`, `ai-applied`, `ai-apply-all`, `ai-alert-ok`, `process-ai-clarify`, `review-ai-run`, `review-ai-suggestion`, `review-ai-apply`, `review-ai-error`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AISettings.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AIActions.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AIRules.kt`, `apps/android-native/bundle/host-ai.ts`
- Checks: `apps/android-native/scripts/check-ai-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/AIRulesTest.kt`
- Notes: Turning AI on, or picking a new provider, asks for consent first, and nothing is written while the question is open. The key is never stored in plain text.

## Gmail capture

- Reach: Settings › GTD › Capture defaults › Gmail section. It has the enabled status, the label picker, and the error and notice lines.
- Selectors: `gmail-capture-section`, `gmail-enabled-status`, `gmail-expand`, `gmail-label-picker`, `gmail-label-sheet`, `gmail-notice`, `gmail-error`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/GmailCapture.kt`, `apps/android-native/android/app/src/play/java/tech/dongdongbh/mindwtr/pilot/GmailAuthorization.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostGmailReceipts.kt`, `apps/android-native/bundle/host-gmail.ts`
- Checks: `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/GmailCycleTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/HostGmailReceiptsTest.kt`, `apps/android-native/android/app/src/testPlay/java/tech/dongdongbh/mindwtr/pilot/GmailFailureCodeTest.kt`
- Notes: Only the play flavor can sign in to Gmail; the foss flavor has a stub. No device check covers this feature.

## About and feedback

- Reach: Settings › About. It shows the version, links (website, terms, privacy, license), the update alert, and Send feedback.
- Selectors: `about-version`, `about-alert-action`, `about-alert-cancel`, `feedback-modal`, `feedback-message`, `feedback-email`, `feedback-send`, `feedback-github`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/AboutSettings.kt`, `apps/android-native/bundle/host-about.ts`
- Checks: `apps/android-native/scripts/check-about-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/AboutEndpointsTest.kt`
- Notes: The app sends at most one heartbeat a day. Diagnostics never hold the feedback message or email.

## Onboarding and Getting Started

- Reach: First start › welcome sheet with Start, Sync, and Skip onboarding. Start opens the Getting Started project.
- Selectors: `welcome-sheet`, `welcome-start`, `welcome-sync`, `startup-prompt`, `getting-started-actions`, `mobile-onboarding-start-fresh-handoff`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/StartupPrompts.kt`
- Checks: `apps/android-native/scripts/check-onboarding-device.mjs`
- Notes: Skip stops the sheet for good. A handoff closes it for that run only, so the next start opens it again.

## Session restore

- Reach: Leave the app on Someday/Maybe, History, a saved search, or a project, then start it again within 25 minutes.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/SessionRestore.kt`
- Checks: `apps/android-native/scripts/check-session-restore-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/SessionRestoreTest.kt`
- Notes: Settings, the reviews, Mind Sweep, widget lists, and search are never stored, so a death there reopens the screen beneath.

## Startup and splash

- Reach: Launch the app. The start screen shows until the first list is drawn.
- Selectors: `boot-failure`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MainActivity.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/MindwtrApplication.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/StartOrder.kt`
- Checks: `apps/android-native/scripts/check-startup-device.mjs`, `apps/android-native/scripts/check-splash-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/StartOrderTest.kt`
- Notes: The startup check uses the benchmark package (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark`) and the budgets in `docs/performance/budgets.md`. The splash check fails if a progress bar shows.

## Safe writes and Try again

- Reach: Any failed write shows its message with Try again. Try again sends the exact same request.
- Selectors: `owed-retry`, `read-retry`, `themed-alert`
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournal.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/WriteQueue.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/CoreHost.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/HeldPublication.kt`
- Checks: `apps/android-native/scripts/check-journal-device.mjs`, `apps/android-native/scripts/check-lifecycle-device.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/WriteJournalTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/WriteQueueTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/RefusedCommandTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/FailureBannerSlotTest.kt`
- Notes: Every write is saved to a journal before the engine sees it, so a write cut off by a process death is sent again once at the next start. A capture keeps its capture UUID, so a resend never makes a duplicate.

## Upgrade from the React Native app

- Reach: Install a release build over the RN app. The native app opens RN's database and settings.
- Code: `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/LegacyRnStoreGuard.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/RnKeyValue.kt`, `apps/android-native/scripts/build-upgrade-harness.mjs`
- Checks: `apps/android-native/scripts/check-upgrade-device.mjs`, `apps/android-native/scripts/check-variant-identity.mjs`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/LegacyRnStoreGuardTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/LegacyPreflightTest.kt`, `apps/android-native/android/app/src/test/java/tech/dongdongbh/mindwtr/pilot/core/RnKeyValueTest.kt`
- Notes: The check uses the throwaway package `tech.dongdongbh.mindwtr.upgradetest` over a real RN build. A guard blocks the start, with no capture field, when RN's data cannot be read safely.

## Device harness

- Reach: No user screen. These checks prove the app's JavaScript engine host: network fetch, secure storage, and Intl date formats.
- Code: `apps/android-native/scripts/device.mjs`, `apps/android-native/scripts/device-lock.mjs`, `apps/android-native/scripts/run-device-batch.mjs`, `apps/android-native/scripts/phone-queue.mjs`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/HostNetwork.kt`, `apps/android-native/android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/core/IcuDateTimeFormat.kt`
- Checks: `apps/android-native/scripts/check-net-device.mjs`, `apps/android-native/scripts/check-intl-device.mjs`, `apps/android-native/scripts/run-device-batch.test.mjs`, `apps/android-native/scripts/check-boot-gates.mjs`
- Notes: The net check needs `debug.mindwtr.native.net_check=<port>` and ends by stopping the host on purpose. The intl check compares the phone's output with RN's Hermes baseline in `apps/android-native/scripts/intl-hermes-baseline.json`.
