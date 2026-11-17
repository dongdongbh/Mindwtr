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
- **Startup prompts:** any `--native-…` launch argument (an isolated library, a fixture, the perf harness) keeps the welcome sheet and the support prompt away. Add `--native-startup-prompts` to show them in an isolated library. A Debug build also takes `--native-startup-prompt-preview onboarding` or `--native-startup-prompt-preview donation` to open one prompt at once.
- **Physical iPhone:** use a Debug build with the `NATIVE_DEVICE_TEST` condition and the separate `.native.dev` bundle identifier named in `apps/ios-native/README.md`. Startup refuses any other identity on a device. **Never install this app over the RN app.**
- **Interactive driving:** the skill uses Appium with the XCUITest driver on the physical phone. Find elements by the `accessibilityIdentifier` values listed below.

Almost every UI test lives in one file, `apps/ios-native/App/UITests/FoundationUITests.swift` (about 1,100 tests). Checks lines name that file and the test-name prefix to run. Swift package tests in `apps/ios-native/Tests/MindwtrNativeCoreTests` run real JavaScriptCore and SQLite, but they have no UI.

## Not in this client

App Intents and Siri belong to the RN app. They are not in `apps/ios-native`. The widgets and the Watch app are shared (see Widgets and Watch app below), and this client has its own share extension (see Share sheet below).

- App Intents and Siri: `apps/mobile/ios-app-intents` and `apps/mobile/modules/ios-siri-actions`. This client has its own foreground intents (see Shortcuts and Siri below).
- RN's Share Extension: the `expo-share-intent` plugin in `apps/mobile/app.json`.
- Watch: `apps/mobile/targets/watch` and `apps/mobile/plugins/ios-watch.js`.
- RN Spotlight: `apps/mobile/modules/apple-task-search`. This client has its own opt-in Spotlight entry (see System search below).

## Navigation and Menu

- Reach: Bottom tab bar › Focus, Inbox, + (Add Task), the Quick Access tab, Menu. Menu opens a sheet with Trash, Board, History, Settings, Saved Searches, and tiles for Waiting For, Someday, Review or Projects, Reference, Contexts, Calendar.
- Shortcuts: Deep link `mindwtr-native-dev://open?task=<id>` or `mindwtr-native-dev://open?project=<id>`. Screen links use the widget routes: `mindwtr-native-dev:///focus`, `/inbox`, `/waiting`, `/someday`, `/capture-quick?mode=text` and `/widget-list/<list id>`.
- Selectors: `tab-focus`, `tab-inbox`, `capture-open`, `tab-menu`, `menu-dismiss`, `menu-saved-search-scroll`, `search-open`, `area-open`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/MoreMenuSheet.swift`, `apps/ios-native/App/CoreModel.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testQuickAccess…, testNativeEntityLink…, testMenuTabSyncBadge…), `apps/ios-native/Tests/MindwtrNativeCoreTests/EntityOpenHostTests.swift`, `apps/android-native/bundle/host-sync.test.ts` (Menu tab sync badge)
- Notes: When sync is set up, the Menu icon carries the RN sync dot: amber while syncing or an edit waits to sync, green when healthy, red when it needs attention. VoiceOver reads it after "Menu". Settings › Sync shows the same state. The fourth tab follows Settings › General › Quick access view (default Review), so the Menu tile that it replaces shows Projects. Widget and saved-list links open the screen RN opens (#1485): a Focus, Inbox, Waiting or Someday header opens that screen, the widget Add button opens the capture sheet, `open-feature?feature=` opens the same screen RN opens (Inbox, Focus, Waiting, Someday, Projects, Review or Calendar), `widget-list/filter:<id>` for a saved filter whose view is Contexts opens Contexts with that filter selected, and one whose view is Focus opens Focus with that filter applied. Every other widget list link (`next`, `upcoming`, a saved filter with another view, a deleted or missing saved filter, `context:<token>` and `tag:<token>`) opens the Widget list screen below, as in RN; a deleted or missing filter shows "No results found" there. A `project:` list and an unknown or malformed link only bring the app forward. The production build reads the same routes from `mindwtr://` links and still opens only tasks from `open?`; the development build also opens `open?project=`. A context automation link (`activate-context?context=<name>`, `deactivate-context`, or `context?name=<name>&action=on`) does what RN does: activation posts the notification that lists that context's next actions, and tapping it opens Contexts on that context; deactivation, a context with no next actions and a repeat within 10 seconds post nothing. A `capture?title=…&note=…&tags=…&project=…&requestId=<uuid>` link (the Capture shortcut) opens the capture sheet filled in the way RN fills its capture screen: the tags ride along whole (a tag with a space stays one tag) and are added on save, an existing project is selected, and a project name that does not exist becomes a `+Project` word so saving creates it, as in RN. The request ID, in any letter case, becomes the new task's ID in lower case, so the same link never makes a second task; RN ignores the request ID. A capture link with no title opens Inbox and shows RN's "Capture shortcut unavailable" notice (`link-notice`). Search links open nothing. A link that arrives while the app lock covers the app waits for unlock. A screen link that arrives during a Sandbox session is settled as ignored. A link, widget tap or system search result that arrives over a task sheet with nothing to save closes the sheet and opens the target, as RN does (#1410). A sheet with an unsaved edit, an open prompt, picker or date picker, a running AI request, or pending attachment work stays open, and the link waits until it closes. Checks: `packages/core/src/native-route-destination.test.ts`, `apps/android-native/bundle/host-ios-entity-open.test.ts`, `apps/android-native/bundle/host-ios-context-automation.test.ts`, `apps/android-native/bundle/host-ios-shortcut-capture.test.ts`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeContextAutomationNotificationTests.swift`.

## Share sheet

- Reach: another app's share sheet › Mindwtr, with text, one web link, or up to 6 photos, videos or files (RN's activation rules).
- Code: `apps/ios-native/ShareExtension/ShareViewController.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShareMailbox.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShareEnvelope.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShareCapture.swift`, `apps/android-native/bundle/ios-share-capture.ts`, `apps/ios-native/App/CaptureSheet.swift`, `apps/ios-native/ShareExtension/Info.plist`, `apps/ios-native/ShareExtension/Mindwtr.entitlements`
- Selectors: `native-share-status`, `native-share-retry`, `native-share-close` (extension); `capture-shared-attachments` (the capture sheet's Attachments list)
- Checks: `scripts/ci/validate-ios-native-production-identity.test.js`, `apps/ios-native/scripts/create-dev-project.test.py`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeShareFilesTests.swift`, `apps/android-native/bundle/host-ios-share-capture.test.ts`, `packages/core/src/native-share-capture-sqlite.test.ts`
- Notes: The production project embeds the ShareExtension target with RN's share extension ID `tech.dongdongbh.mindwtr.share-extension`, App Group `group.tech.dongdongbh.mindwtr` and Release profile Mindwtr_ShareExtension_AppStore, so it replaces RN's share sheet entry on upgrade. The development build signs it as `tech.dongdongbh.mindwtr.native.dev.share` and shows "Mindwtr Native Dev". Shared files follow RN's rule: the extension stream-copies each file (50 MiB at most, as RN's attachment check) into the App Group's `NativeShare/files/<share id>/` folder before it writes the share's mailbox entry, so a crash or Cancel leaves no entry. When the app opens the share, it copies the files into its attachment storage and opens the capture sheet with RN's title (the subject, else the text, else the first file's name without its extension), the text as the note only beside a subject, and the files listed under Attachments; Save puts them on the task in the same write, once. Files RN would skip (over 50 MiB, a blocked type, unreadable) show RN's skipped-files notice. The App Group copies are deleted when the share finishes; a discarded share also deletes its attachment copies. Differences from RN: the capture sheet is the native capture popup, not RN's capture screen; a share whose every file was skipped and that has no text shows the extension's failure message instead of an app notice.

## Watch app

- Reach: the Watch app and its complications, installed with the iPhone app.
- Code: `apps/mobile/targets/watch/App`, `apps/mobile/targets/watch/Widgets`, `apps/mobile/targets/watch/Shared`, `apps/ios-native/Watch/Assets.xcassets`, `apps/ios-native/App/Info.plist`
- Checks: `scripts/ci/validate-ios-native-production-identity.test.js`, `apps/ios-native/scripts/create-dev-project.test.py`
- Notes: The production project embeds RN's Watch app (MindwtrWatch, `tech.dongdongbh.mindwtr.watchkitapp`, Release profile "Mindwtr Watch App Store") and its widgets (MindwtrWatchWidgets, `tech.dongdongbh.mindwtr.watchkitapp.widgets`, "Mindwtr Watch Widgets App Store"), built from RN's source with RN's Watch App Group `group.tech.dongdongbh.mindwtr.watch`. The app's Info.plist turns the Watch receiver on (MindwtrWatchEnabled). The dev generator strips these targets; only `--watch` adds the native.dev Watch targets, and every other dev variant turns the receiver off.

## Widgets

- Reach: Home Screen › Edit › Add Widget › Mindwtr Native Dev: Mindwtr (the list widget, small, medium, large and extra large) and Compact (the same four sizes). Lock Screen › Customize › Add Widgets: Focus and Add Task (circular, rectangular and inline). Lock Screen or Control Center › Add Quick Action / Add a Control: Add Task (iOS 18 and later). Edit Widget on the Mindwtr widget picks the list (Today, Inbox, Next, Upcoming, Waiting, Someday or a saved filter) and, for Today, Include available actions.
- Shortcuts: The widgets open RN's links. The development build rewrites each `mindwtr:` link to `mindwtr-native-dev:` before it leaves the widget, so a tap never opens the RN app.
- Code: `apps/mobile/widgets-ios/MindwtrWidgetsBundle.swift`, `apps/mobile/widgets-ios/MindwtrTasksWidget.swift`, `apps/mobile/widgets-ios/MindwtrTasksWidgetIntents.swift`, `apps/mobile/widgets-ios/MindwtrCompactWidget.swift`, `apps/mobile/widgets-ios/MindwtrFocusLockWidget.swift`, `apps/mobile/widgets-ios/MindwtrCaptureLockWidget.swift`, `apps/mobile/modules/ios-widget/ios/MindwtrWidgetActionStore.swift`, `apps/mobile/modules/ios-widget/ios/MindwtrWidgetTaskItem.swift`, `apps/ios-native/scripts/create-dev-project.py`, `apps/ios-native/Sources/MindwtrNativeCore/NativeWidgetFamilyPublisher.swift`, `apps/ios-native/App/CoreModel.swift`, `apps/ios-native/App/NativeCaptureIntents.swift`
- Checks: `scripts/ci/validate-ios-native-production-identity.test.js`, `apps/mobile/modules/ios-widget/tests/MindwtrWidgetPayloadTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeWidgetFamilyPublisherTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeProductionWidgetTaskIntentTests.swift`, `apps/ios-native/scripts/create-dev-project.test.py`, `apps/ios-native/App/UITests/FoundationUITests.swift`
- Notes: The dev project generator compiles the RN files above, unchanged, into the extension target MindwtrNativeCaptureWidget with the MINDWTR_NATIVE_DEV compile condition, which switches the App Group and link scheme to the development ones. The app publishes and drains check-offs in CoreModel (publishProductionWidgetFamiliesIfCurrent); NativeCaptureIntents.swift holds the app side of the Add Task control and the task-open intent. WidgetKit views carry no accessibility identifiers: a task ring is a button labelled with the payload's complete label, a colon and the title, and after a tap it carries the undo label instead. The simulator UI tests are the testRNWidget tests in FoundationUITests; they run only with MINDWTR_RN_WIDGET_UI=1 and a lowercase MINDWTR_RN_WIDGET_RUN UUID. The payload test decodes a payload the native app published, for every list and size, and checks that the development build uses its own group and scheme.
- Notes: These are RN's widgets, built from RN's source with RN's kinds (`MindwtrTasksWidget`, `MindwtrCompactWidget`, `MindwtrFocusLockWidget`, `MindwtrCaptureLockWidget`, `MindwtrCaptureControl`), intent types and parameter names, so a widget placed under RN can keep working once a production extension with RN's bundle ID ships. The app publishes RN's five size payloads to its App Group while it is open and unlocked (production: `group.tech.dongdongbh.mindwtr`; development: `group.tech.dongdongbh.mindwtr.native.dev`). A ring tap queues the completion in RN's widget queue, the row shows struck through with an undo ring, and the app completes the task the next time it is open, then publishes again. A Today list with nothing left falls back to Next Actions, as in RN. Isolated UI-test libraries publish nothing. The development build signs the extension with the existing `.capture-widget` bundle ID. The earlier native-only Add Task and Next Actions widgets are retired; RN's Add Task and Mindwtr widgets cover them. The production project embeds the same files as the MindwtrWidgets target (`tech.dongdongbh.mindwtr.MindwtrWidgets`, App Group `group.tech.dongdongbh.mindwtr`, Release profile Mindwtr_iOS_Widget_AppStore), and the app claims that App Group; the dev generator strips that target and adds its own. `scripts/ci/validate-ios-native-production-identity.test.js` keeps the IDs, group, profile names and source list from drifting.

## Widget list

- Reach: a widget list header or a saved-list shortcut: `mindwtr:///widget-list/<list id>` (`mindwtr-native-dev:` on the development build). The list ID is `next`, `upcoming`, `filter:<saved filter id>` for a view other than Contexts or Focus (or a deleted or missing filter), `context:<token>` or `tag:<token>`.
- Selectors: `widget-list-scroll`, `widget-list-empty`, `widget-list-more`, `widget-list-error`, `widget-list-retry`
- Code: `apps/ios-native/App/SavedSearchScreen.swift`, `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/CoreModel.swift`, `packages/core/src/native-host-contract-widget-list.ts`
- Checks: `apps/ios-native/Tests/MindwtrNativeCoreTests/EntityOpenHostTests.swift`, `apps/ios-native/App/UITests/FoundationUITests.swift`, `packages/core/src/native-host-contract-widget-list.test.ts`
- Notes: Matches RN's `widget-list/[id]` screen. `WidgetListScreen` reads core's `getWidgetListView` through `menuRead("widgetList")`; the header back and title use the `widget-list-back` and `widget-list-title` identifiers. The title is the list's name, or "No results found" when the list no longer exists. The rows are the same task cards as other lists: tap opens the task, swipes and the status menu work, a project opens the project, and a context or tag opens Contexts. An empty list shows "No results found". Pull to refresh syncs. Back returns to the screen that was open before. There is no area filter or search button, as in RN.

## Capture

- Reach: Tab bar › + (Add Task). The description field sits under the title at all times, as in RN (#1406). The sheet also has @ contexts, focus star and Destination controls; More shows syntax help and date chips.
- Shortcuts: Long-press the @ contexts button to reset contexts.
- Selectors: `capture-input`, `capture-save`, `capture-save-edit`, `capture-add-another`, `capture-contexts`, `capture-focus`, `capture-destination`, `capture-destination-picker`, `capture-destination-query`, `capture-destination-close`, `capture-suggestions`, `capture-note`, `capture-close`, `capture-lines-create`
- Code: `apps/ios-native/App/CaptureSheet.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testCapture…, testGtdCapture…, testQuickCaptureShowsDescriptionUnderTitleWithoutMore), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeCaptureLinesHostTests.swift`
- Notes: Input with several lines opens a confirmation that creates one task per line. Core prepares the task before the write, and restart retries that exact task without parsing the text again.
- Destination shows the contextual project/section, default Area, or None. Explicit choices override title syntax without changing status. Unavailable targets remain visible and prevent saving. Local `@`, `+`, `#` suggestions use core parsing and replace the token at the caret; marked-text composition does not accept a suggestion.

## Inbox

- Bulk organize status includes Inbox for returning tasks to processing; existing project, notes, tags and dates stay unchanged unless explicitly edited.

- Reach: Tab bar › Inbox. The toolbar has Sort, Group and Filters icons. The primary button reads Process Inbox (N), or Mind Sweep when Inbox is empty.
- Selectors: `inbox-scroll`, `inbox-process-primary`, `inbox-mind-sweep-primary`, `inbox-mind-sweep-accessory`, `inbox-chips-clear`, `inbox-sort-close`, `inbox-group-close`, `inbox-more`
- Code: `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/ListFilterControls.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testInboxSort…, testInboxFilters…, testTask157InboxCompletion…)
- Notes: Inbox filters last for the session only and reset on restart. Swiping a task row shows Done and Focus on one side and Organize, Dates and Delete on the other; Done uses an empty circle, as in RN (#1480). While the app is open, the shown task list reads again at the first minute after a row's due colour or age changes (core `meta.validUntil`), so a timed due date turns overdue on time (#1360).

## Inbox bulk selection

- Reach: Inbox › long-press a task card. A bar shows the count and Next, Waiting, Someday, Done, Reference, Add tag, Remove tag, Organize and Delete.
- Shortcuts: Long-press a card to start selecting. Use the range control to select a range.
- Selectors: `inbox-bulk-count`, `inbox-bulk-range`, `inbox-bulk-exit`, `inbox-bulk-delete`, `inbox-bulk-confirm`, `inbox-bulk-tag-open`, `inbox-bulk-remove-tag-open`, `inbox-bulk-organize-open`
- Code: `apps/ios-native/App/InboxScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testInboxBulk…)
- Notes: Bulk Delete confirms first and then offers Undo. Organize dates show the localized short date and switch to `YYYY-MM-DD` while you edit them, as in RN (#1231).

## Process Inbox

- Reach: Inbox › Process Inbox (N). The sheet walks one item at a time.
- Selectors: `process-inbox-sheet`, `process-inbox-title`, `process-inbox-next-action`, `process-inbox-skip`, `process-inbox-delegate-who`, `process-inbox-project-search`, `process-inbox-deferred-projects`, `process-inbox-close`, `process-inbox-toast`
- Code: `apps/ios-native/App/ProcessInboxSheet.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testProcessInbox…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeProcessInboxUndoHostTests.swift`
- Notes: Filing, completion and Trash offer Undo for about 5.2 seconds. Settings › GTD › Inbox controls the two-minute prompt and the layout. Incubate and the "Back to clarify" label use a calendar-clock icon, as in RN (#1339). The project step lists Someday and Waiting projects after the active ones, under a "Someday / Waiting" heading (`process-inbox-deferred-projects`).

- Notes: The processing count includes Inbox tasks and due Someday reviews. Area appears before Projects, with the selected project’s inherited Area and indented Section controls. Browse projects offers All areas, No area and named Areas without changing task assignment; search remains global.

## Today's Focus

- Reach: Tab bar › Focus. The header has view options, Filters, a section toggle and a reorder toggle.
- Shortcuts: In reorder mode, drag the handles or use the Move up and Move down accessibility actions. Long-press a saved-filter chip to delete it. Tap the star on a task card to add or remove the focus star.
- Selectors: `focus-title`, `focus-view-options`, `focus-filters-open`, `focus-toggle-sections`, `focus-reorder-toggle`, `focus-reorder-list`, `focus-saved-strip`, `focus-filter-save`, `task-focus-blocked`
- Code: `apps/ios-native/App/InboxScreen.swift`, `apps/ios-native/App/FocusControlsPanel.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testFocus…, testTaskFocus…)
- Notes: Reorder refuses more than 100 displayed rows; its button carries RN's translated VoiceOver hint (`focus.reorderScreenHint`). Filters reset on restart, but section folds and Show details persist on the device.
- Notes: Focus task dates show Today, Tomorrow, or a full localized weekday for the next six days, with explicit times retained. Start uses an arrow and Due a calendar; accessible labels retain the field and exact date. Past dates and dates at least seven days away stay exact. Labels refresh at local midnight and when the app returns to the foreground.

## Pomodoro

- Accounting: linked active work is preserved at pause, task completion, task switch, reset, preset change and work/break transitions. Pauses and breaks do not count; sub-minute remainders carry per task. Completion pauses the linked work timer and leaves completed-Pomodoro counts unchanged unless the work block finished. A linked task that moves to Reference or is no longer on the device does not pause the timer; the panel unlinks it and keeps the timer running, as on mobile.

- Reach: Settings › GTD › the Pomodoro switch turns it on, or Settings › GTD › Pomodoro settings › Enable while it is off. The timer panel then shows on Focus.
- Selectors: `gtd-pomodoro` (the switch), `gtd-pomodoroSettings`, `gtd-pomodoro-enable`, `pomodoro-toggle`, `pomodoro-clock`, `pomodoro-reset`, `pomodoro-switch`, `pomodoro-task`, `pomodoro-complete`, `pomodoro-collapse`
- Code: `apps/ios-native/App/FocusControlsPanel.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativePomodoroAlarmEffects.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTask551Pomodoro…, testTask583Pomodoro…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativePomodoroHostTests.swift`
- Notes: The task picker shows only when Link timer to task is on.

## Task editor

- Reach: Tap a task title. The sheet opens in Preview or Edit. Swiping the sheet down with unsaved changes shows the same Save/Discard/Cancel prompt as Close, as in RN (#1552). More holds Duplicate, Share, Cancel, Delete, Skip this occurrence, Create project from task and, for Reference tasks, Convert to action.
- Selectors: `task-preview-mark-done`, `task-mode-view`, `task-mode-edit`, `task-editor-title`, `task-editor-focus-star`, `task-editor-note`, `task-editor-save`, `task-editor-save-close`, `task-editor-discard`, `task-more`, `task-duplicate`, `task-share`, `task-cancel`, `task-delete`, `task-skip-occurrence`, `task-promote`, `task-reference-convert-to-action`, `task-view-close`
- Code: `apps/ios-native/App/TaskViewSheet.swift`, `apps/ios-native/Sources/MindwtrNativeCore/EditorDraftStore.swift`, `apps/ios-native/App/CoreModel.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskDuplicate…, testTaskShare…, testTaskCancellation…, testTaskDelete…, testTaskSkip…, testTaskPromotion…, testTaskPreview…, testGtdTaskEditor…, testTaskEditorFocusStar…)
- Notes: The Title row has RN's Focus star. It changes the draft only; Save writes it, and core refuses the Save if the Focus limit filled meanwhile. The star is disabled with the limit text when Focus is full, and hidden for read-only, archived and Reference tasks (#1306). Settings › GTD › Task Editor sets the opening mode. Automatic opens Inbox taps in Edit and every other open in Preview. Tasks in archived projects stay read-only in Preview. Date pickers for due, start, review and recurrence end show a month calendar; time pickers stay wheels, as in RN. Bulk Organize dates use the same month calendar. The Destination picker (`task-destination-choice-project-<id>`) lists None, Areas, active Projects, then Someday and Waiting projects in their own "Someday / Waiting" group. The row Destination picker uses the same order before paging, preserving existing order within groups and direct project selection.

- Checklist drag: Drag a checklist row by its handle (`task-checklist-drag-<index>`). The row follows the finger and the rows it passes shift to preview its slot, as in RN (#1483). Tap a handle for row actions.

- Preview completion: Mark Done in the visible Status card flushes pending checklist input, changes the same draft to Done, then invokes its normal owned Save. The handler requires the same host/task/session and an accepted draft edit. Repeat taps and competing Save/Close are blocked while it runs. Failed writes keep the draft and existing Retry/Save; uncertain retries replay the retained request and close only after acknowledgement. Reference, terminal, Trash, projected and archived-project/read-only previews have no action. Checks: `apps/ios-native/Tests/MindwtrNativeCoreTests/PreviewCompletionHostTests.swift` and the two `testPreviewMarkDone...` UI cases.

## Markdown editor

- Reach: Task editor › Edit › Description, or Project Details › Notes › Edit. Tap the text. The format toolbar sits above the keyboard. Drag the task editor down to hide the keyboard, as in RN.
- Selectors: `markdown-toolbar-` followed by the core action id (`heading`, `bold`, `italic`, `strikethrough`, `link`, `code`, `codeBlock`, `quote`, `horizontalRule`, `bulletList`, `orderedList`, `taskList`), `markdown-toolbar-undo`, `task-editor-note`, `project-notes-input`
- Code: `apps/ios-native/App/TaskViewSheet.swift` (NativeMarkdownTextEditor and NativeMarkdownToolbar), `apps/ios-native/Sources/MindwtrNativeCore/NativeMarkdownHistory.swift`, `packages/core/src/native-host-contract.ts` (getMarkdownToolbarActions, applyMarkdownToolbar and applyMarkdownTextChange)
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskNoteMarkdownToolbar…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeMarkdownHistoryTests.swift`, `packages/core/src/native-host-contract-markdown-toolbar.test.ts`
- Notes: Core supplies the buttons, their order, their labels and every rule, as in RN. The task description pairs `[`, `(` and backticks, turns a pasted URL over a selection into a link, and continues lists and quotes on Return. Project notes only continue lists, as in RN. Settings › GTD › Editor typing help turns pairing, linking and continuation off. Typed text always stays: a rule's result applies only if nothing was typed after the edit it answers. Undo keeps the last 100 steps, as in RN. Icons are SF Symbols that stand in for RN's Ionicons and FontAwesome glyphs.

## Task attachments

- Reach: Task editor › Add link, Add file or Add photo. Tap a link title or file to open it.
- Selectors: `task-attachment-add-link`, `task-attachment-add-file`, `task-attachment-add-photo`, `task-attachment-link-input`, `task-attachment-link-save`, `task-attachment-open-dismiss`, `task-attachment-retry`
- Code: `apps/ios-native/App/TaskViewSheet.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAttachmentFiles.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeAttachmentDraftStore.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testTaskAttachment…, testTaskDownload…), `apps/ios-native/Tests/MindwtrNativeCoreTests/AttachmentDraftHostTests.swift`
- Notes: Imports stop at 50 MiB. Attachment changes stay in the task draft until Save.

## Draft recovery

- Reach: Shown by itself after a restart when an unsaved task draft exists. A Resume draft button also floats over the main screen, above the tab bar so it never covers a tab. RN has no draft recovery, so this button has no RN counterpart.
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

- Reach: Menu › Projects (or the Quick Access tab when it is set to Projects) › a project. Each list row has a … menu (Move up, Move down, Area), a long press that offers Move up and Move down, a right swipe to Duplicate and a left swipe to Delete, as in RN (#1489). Project Details holds the actions menu (Complete, Duplicate, Delete, Cancel project), Sections, Notes, Tags, Area, attachments and task view options (Show completed, Sort, Filters, Order).
- Selectors: `projects-scroll`, `projects-create-title`, `projects-create-add`, `projects-tag-filter-toggle`, `project-row-menu-`, `project-row-menu-area-`, `task-swipe-`, `project-row-delete-confirm`, `project-row-error`, `project-detail-title`, `project-back`, `project-actions-menu`, `project-sections-open`, `project-notes-input`, `project-tags-open`, `project-area-open`, `project-task-view-options-button`, `project-attachment-add-link`, `project-bulk-reorder`
- Code: `apps/ios-native/App/ProjectsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testProjectSection…, testProjectNotes…, testProjectTags…, testProjectCompleted…, testProjectFile…, testProjectDownload…, testProjectSelectionReorderOpensTaskOrderAndClearsSelection, testProjectsListRowMenuMovesLongPressMovesAndAreaOpens, testProjectsListRowSwipeDuplicateAndDeleteWithUndo)
- Notes: Archived projects open as read-only previews. Pending Notes save before any view-control change or file action. Long-press a task to select; the selection bar shows Reorder when the project has default sort and something to reorder, as in RN (#1477). Reorder leaves selection and opens the task order list. A row offers only the moves core allows: within its area and never past a project with a different Focus star; archived rows have no … menu. A row's Area opens the Area sheet over the Projects list, as in RN; closing it or choosing an area returns to the list. Project Details Start, Due and Review dates open RN's compact date under the row: picking a day saves it, Done saves the shown date, and Cancel closes it. Delete asks first and offers Undo; Duplicate opens the copy. Row selectors end in the project id: `project-row-menu-<id>`, `project-row-menu-up-<id>`, `project-row-menu-down-<id>`, `project-row-menu-area-<id>`, `task-swipe-duplicate-<id>`, `task-swipe-delete-<id>`.

## Areas

- Reach: Menu › Projects › Manage areas, or Project Details › Area. Settings › Manage › Areas also creates, edits and deletes Areas.
- Selectors: `projects-manage-areas`, `area-manager-close`, `area-create-name`, `area-create-save`, `area-rename-save`, `area-order-sort-name`, `manage-area-add`, `manage-area-delete-confirm`
- Code: `apps/ios-native/App/ProjectsScreen.swift`, `apps/ios-native/App/SettingsScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testArea…, testManageArea…, testProjectArea…)
- Notes: Renaming to an existing name merges the Areas. Delete moves live projects and direct area tasks to Unassigned.

## Contexts

- Reach: Menu › Contexts (or the Quick Access tab when it is set to Contexts).
- Shortcuts: Long-press a chip to add it to the current selection.
- Selectors: `contexts-search`, `contexts-filters`, `contexts-filter-save`, `contexts-more`, `contexts-sort`, `contexts-saved-filter-` (+ filter id)
- Code: `apps/ios-native/App/ContextsScreen.swift`, `apps/ios-native/App/CoreModel.swift` (contextsSavedFilterSort)
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testContextsTokens…, testTask162ContextsRowIdentity…, testContextsSavedFilterSort…), `packages/core/src/native-host-contract-list-views.test.ts` (saved filter sort)
- Notes: A selected saved filter orders rows by its own sort, as mobile does. A sort picked while it is selected lasts only until the filter is tapped again and does not change the list sort.

## Review and Contexts bulk selection

- Reach: Review (scope All or Due, groups expanded) or Contexts › long-press a task card. A bar shows the count, all six statuses, Add tag and Delete. Review also offers Organize (first, filled) and Share.
- Shortcuts: Tap a row's circle or card to toggle it.
- Selectors: screen prefix `review` or `contexts`, then `-bulk-count`, `-bulk-exit`, `-select-` (+ task id), `-bulk-status-` (+ status), `-bulk-tag-open`, `-bulk-organize-open` and `-bulk-share` (Review only), `-bulk-delete`, `-bulk-confirm`; `review-scroll`, `contexts-scroll`; Undo is `task-` + `statusListBulkDelete` + `-undo`. The Review Organize dialog reuses the Inbox dialog, so its controls read review-organize-apply, review-organize-project and so on
- Code: `apps/ios-native/App/ReviewScreen.swift`, `apps/ios-native/App/ContextsScreen.swift`, `apps/ios-native/App/WaitingScreen.swift` (StatusListBulkBar), `apps/ios-native/App/CoreModel.swift` (statusList…)
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testShownListBulk…, testReviewBulkOrganize…), `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testReviewAndContextsBulk…, testReviewBulkMoveColdRecovery…, testReviewBulkOrganizeRides…), `packages/core/src/native-host-contract-review-contexts-bulk.test.ts`
- Notes: Review ends the selection when the scope changes or a selected row is folded away, as mobile does. Contexts drops only the selected rows a chip, search or filter hides. Review Organize writes through the Inbox Organize family with source `review`, so its failed-save retry and cold recovery match Inbox. Mark reviewed, Remove tag, and Contexts' Add/Remove context are not built yet.

## Waiting For

- Reach: Menu › Waiting For. Filter by person.
- Shortcuts: Swipe right on a deferred project row to reactivate it.
- Selectors: `waiting-scroll`, `waiting-clear-person`, `waiting-projects-toggle`
- Code: `apps/ios-native/App/WaitingScreen.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testWaitingPerson…, testDeferredProjectActivation…)
- Notes: A plain tap on a deferred project opens Project Details; only the swipe or the Reactivate action reactivates it.

## Someday/Maybe

- Reach: Menu › Someday. Section headings have Add task. The task status menu has Move to section. Long-press a task card to select; the bulk bar also has Move to section. Grouped by section, parked (Someday) projects sit inside their section above its tasks, as RN does (#1319); other groupings keep the projects block above the list.
- Shortcuts: Swipe right on a parked project row to reactivate it. Long-press a parked project row in a section for Move to section…
- Selectors: `someday-scroll`, `someday-overflow-button`, `someday-section-create-input`, `someday-section-create-save`, `someday-section-move-new-section`, `someday-section-move-undo`, `someday-section-task-input`, `someday-bulk-move-section`, `someday-section-move-choice-` (+ index), `someday-project-` (+ project id, + `-move-section` for its menu item), `someday-project-move-choice-` (+ index), `someday-project-move-new-section`, `someday-project-move-cancel`
- Code: `apps/ios-native/App/SomedayScreen.swift`, `apps/ios-native/App/CoreModel.swift` (somedayProjectMove…), `packages/core/src/native-host-contract-someday-project-section-move.ts`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testSomedaySection…, testSomedayNested…, testSomedayGroupFilter…, testStatusListBulkSomedayMoveToSection…, testSomedayProjectsSitInTheirSection…), `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testSomedaySectionBulkMove…, testSomedayProjectSectionMove…), `packages/core/src/native-host-contract-menu-views.test.ts` (checked iOS write)
- Notes: Move-to-section Undo lasts only for the session and does not return after restart. Bulk Move to section moves only the selected tasks not already in that section, ends the selection, and its Undo restores each task's own earlier section. Section rename and delete live in Settings › Manage. A project's Move to section dialog also has + New section, which creates the section and moves the project into it, as RN's picker does.

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
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testGeneral…, testQuickAccess…), `packages/core/src/native-host-contract-system-date-format.test.ts`
- Notes: The E-ink theme draws the Focus star, the swipe Focus action, and project, area and Focus group dots in black, as in RN (#1498). Menu icons, the Focus review folder outline, Waiting For and Someday project folders, and the Convert to section dots also draw black (#1517). Review badges retain distinct state labels with black text on an opaque light-gray fill. Settings sync indicators use refresh/check/warning glyphs and translated accessible status labels. Color pickers keep their colors. Code: `AppPalette.einkSafe` in `apps/ios-native/App/Appearance.swift`. Date format System follows the iOS Region short date, as the RN app does. The app sends the device pattern to core at startup and on each refresh.

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

- Reach: Settings › Notifications. Reminder notifications offer Open, Complete, Snooze and Dismiss. Dismiss, Complete and Snooze run without opening Mindwtr, as in RN (#1386).
- Selectors: `notifications-title`, `notifications-scroll`, `notifications-time-wheel`, `notifications-picker-done`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeReminderResponse.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeReminderEffects.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeNotificationsSettings…, testNativeReminderResponse…), `apps/ios-native/Tests/MindwtrNativeCoreTests/ReminderResponseRouteHostTests.swift`
- Notes: Open closes a task sheet with nothing to save, as RN does (#1410). Open waits for any active draft before it navigates. Real OS delivery has no physical-device proof yet.

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
- Selectors: `sync-screen`, `sync-url`, `sync-username`, `sync-password`, `sync-token`, `sync-status`, `sync-reload`, `sync-error`, `sync-restart-gate`, `sync-cloudkit-account-status`, `sync-cloudkit-last-error`, `sync-missing-files-continue`, `sync-missing-files-cancel`
- Code: `apps/ios-native/App/SettingsScreen.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeHTTPJobs.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeCryptoJobs.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSecretJobs.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeBackgroundSync.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSyncChangeObservation.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeSync…, testNativeEncryption…, testNativeSelfHosted…, testNativeWebDAV…, testNativeCloudKit…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeForegroundSyncTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeBackgroundSyncTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeSyncChangeObservationTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeForegroundWebDAVTests.swift` (testMissingAttachmentFiles…)
- Notes: An unconfirmed sync result blocks editing and shows a "close and reopen" screen (`sync-restart-gate`). Only WebDAV and self-hosted have forms here. Mixed-client sync is not accepted yet. The sync when the app opens or comes back to the foreground runs in the background, as RN's does: it never disables the screen, and a tap during it runs as soon as it ends. With WebDAV or self-hosted sync, if the server has not answered within 20 seconds, the app stops that sync, shows it as failed on the sync badge, and tries again later (no WebDAV retries after the stop). A sync that is running when the app leaves the foreground keeps going on iOS background time until it finishes or iOS ends the time (#1432). With WebDAV, self-hosted or iCloud sync, when the app leaves the foreground with a local change not yet synced, one sync starts on iOS background time, as RN does. While the app stays open, a local change starts a sync about 2 seconds later, or 5 seconds after the last of several quick changes, as RN does (#1431). The shared pacing still applies: a sync waits at least 5 seconds after the previous one, longer after a slow one, and longer after a failure. The sync starts only when no sheet, editor or draft is open and nothing else is running. It does not block the screen: a tap during it runs as soon as the sync finishes, and the list refreshes after a sync that changed data. If another operation is still open in the core host, the sync waits and tries again 5 seconds later. With iCloud sync, the app syncs when it opens and when it comes back to the foreground, as with WebDAV and self-hosted; while the app is open, a change from another device arrives as an iCloud change notification (push) and starts a sync at once, as RN does (G3). The push sync follows the same rules as the sync after a local change: it waits while the app is busy, locked or in the background, and runs when the app is free again. The app declares the `remote-notification` background mode in `App/Info.plist`, as RN's CloudKit plugin does. The production app (`tech.dongdongbh.mindwtr`, the same App ID as RN) uses RN's iCloud container `iCloud.tech.dongdongbh.mindwtr` and zone `MindwtrZone`, so it reads and writes the same iCloud data as RN. Its device builds sign with `App/Mindwtr.entitlements`, which carries RN's CloudKit and push keys; the simulator build gets no container, so iCloud stays off there. The native.dev app keeps its own `iCloud.tech.dongdongbh.mindwtr.native.dev` container. A wrong bundle and container pair turns iCloud off (`NativeCloudKitContainerTests`). Push also needs the `aps-environment` entitlement. For native.dev, only a CloudKit project generated with `create-dev-project.py --cloudkit --cloudkit-push` asks for it, and that needs Push turned on for the native.dev App ID; plain `--cloudkit` projects leave it out so ordinary phone builds keep signing. With WebDAV, self-hosted or iCloud sync, iOS may also wake Mindwtr in the background about every 15 minutes or later to sync, as the RN app does (`com.expo.modules.backgroundtask.processing`). An iCloud run is skipped when the iCloud account is not available. A background sync that changes data replans task reminders (#1424). A run stops after 4 minutes and counts as a failure; failures wait 15 minutes, doubling up to 2 hours (#1398). A sync that iOS or the deadline cancels after it saved its store does not show the "close and reopen" screen; the change stays pending for the next sync. There is no on-screen control. When a new sync location (a folder, WebDAV, self-hosted, Dropbox or iCloud) is missing attachment files that are also gone from this device, the app shows RN's "Some attachment files are missing" alert with the file list. Cancel keeps the old setup. Continue activates the new location without those files; if more files went missing since the alert, the alert shows again with the new list.
- Upgrade: Settings › Sync › Encryption › Upgrade sync encryption opens an explicit current-passphrase confirmation. Update every device first; older clients cannot read the result. The service uses a verified durable local copy and refuses mismatches or unavailable storage. Keep the upgrade passphrase for retained encrypted recovery archives, even after changing the active passphrase. An interrupted format upgrade can retry; other unfinished encryption transitions do not expose this action. No upgrade runs automatically during unlock.

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

## Welcome sheet and support prompt

- Reach: First start on an empty library with sync off › welcome sheet with Start using Mindwtr, Sync, Import and Skip for now. Start using Mindwtr adds the Getting Started project and opens it. Sync opens Settings › Sync. Import opens Settings › Data. A Release build later shows the support (donation) prompt, on RN's schedule: after 30 days and 21 active days, then again at most every 183 days.
- Selectors: `welcome-sheet`, `welcome-start`, `welcome-sync`, `welcome-import`, `welcome-skip`, `welcome-close`, `welcome-error`, `startup-prompt`, `startup-prompt-dismiss`, `startup-prompt-action`, `startup-prompt-close`, `startup-prompt-toast`
- Code: `apps/ios-native/App/NativeStartupPrompts.swift`, `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/App/CoreModel.swift`, `apps/android-native/bundle/host-about.ts`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testStartupWelcomeSheet…, testStartupDonationPrompt…), `apps/ios-native/Tests/MindwtrNativeCoreTests/StartupPromptsHostTests.swift`, `packages/core/src/native-host-contract-startup-prompts.test.ts`
- Notes: Prompts wait for a clean start: no load error, no pending retry or recovery, App lock unlocked, and no sheet or editor open. Skip stores RN's dismissal key on the device, so the sheet does not come back. Sync and Import close the sheet for this run only. The support prompt's showing is a journaled settings write (`settings.supportPrompt`), so other devices see it. The update reminder is Android only. Unlike RN, the Sync and Data pages do not show the "Start using Mindwtr" handoff card; Settings › Data already has Getting Started.

## System search (Spotlight)

- Reach: Settings › General › Show tasks in system search. Tapping a result opens the task.
- Selectors: `general-ios-search`, `general-ios-search-paused`
- Code: `apps/ios-native/App/MindwtrNativeApp.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSearchIndex.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeSearchSnapshot.swift`
- Checks: `apps/ios-native/App/UITests/FoundationUITests.swift` (testNativeSearch…), `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeSearchConsentTests.swift`
- Notes: It is off by default and stays paused while App lock is on. It publishes only task titles and project names.

## Shortcuts and Siri

- Reach: the Shortcuts app › Mindwtr, or Siri with the App Shortcut phrases: "Capture in Mindwtr", "Add to Mindwtr", "Create a task in Mindwtr" (Capture Task); "Open Mindwtr", "Open a list in Mindwtr", "Show Mindwtr" (Open List); "Add a task in Mindwtr", "Open quick capture in Mindwtr" (Add Task).
- Actions: Capture to Mindwtr (Task, Note, Tags, Project), Open Mindwtr List (Inbox, Focus, Waiting, Someday, Projects, Review, Calendar), Open Mindwtr Saved List (any saved filter), Add Task (quick capture), Add to Mindwtr (Task, Note, Tags, Project, Due date, Start date; runs without opening the app), Get Mindwtr Tasks (List or Project; returns up to 50 Mindwtr Task items without opening the app). Titles, parameters, phrases and dialogs match RN's `apps/mobile/ios-app-intents/MindwtrSiriCaptureIntents.swift`. A Shortcut saved under RN finds each action by the app ID plus the Swift type name (for example `tech.dongdongbh.mindwtr.MindwtrGetTasksIntent`) and stores its parameter property names and list case names. Never rename these intent, entity or enum types, their parameter properties or their cases: a rename silently breaks users' saved Shortcuts.
- Code: `apps/ios-native/App/NativeCaptureIntents.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShortcutIntentLinks.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShortcutCaptures.swift`, `apps/ios-native/Sources/MindwtrNativeCore/NativeShortcutsSnapshot.swift`, `apps/ios-native/App/CoreModel.swift` (drainShortcutCapturesIfCurrent and publishShortcutsSnapshotIfCurrent), `apps/android-native/bundle/ios-watch-ingest.ts`
- Checks: `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeShortcutIntentLinksTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeShortcutCapturesTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeShortcutsSnapshotTests.swift`, `apps/ios-native/Tests/MindwtrNativeCoreTests/NativeShortcutCaptureHostTests.swift`, `apps/android-native/bundle/host-watch.test.ts`, `apps/android-native/bundle/host-ios-receipt-retention.test.ts`, `scripts/ci/validate-ios-app-intents-availability.js`
- Notes: Each action opens RN's link (`mindwtr:///capture?…`, `mindwtr:///open-feature?feature=…`, `mindwtr:///widget-list/filter:<id>?source=shortcut`) through the app's own link router. The production app sends `mindwtr:` links; the `native.dev` app sends the same paths as `mindwtr-native-dev:` links, which its router accepts. The router resolves Open List for all seven lists. A saved Contexts filter opens Contexts with that filter selected and a saved Focus filter opens Focus with it applied; a saved filter of any other view opens the Widget list screen. A prefilled capture link opens the capture sheet filled in, and one with no title shows "Capture shortcut unavailable". The saved-list picker reads the saved filters from the widget payload that the production app publishes to its App Group, so a new filter appears after Mindwtr publishes once; the `native.dev` app has no saved lists. Add to Mindwtr writes RN's queue file to `Documents/pending-captures`, so an RN queue left behind by an upgrade is also saved. The app saves queued items the next time it is open and unlocked, through a journaled host write with durable receipts, and then deletes each file; a malformed file stays untouched. Get Mindwtr Tasks reads a snapshot that the app writes to `Library/Application Support/MindwtrShortcuts/snapshot.json` while it is open; it uses core's RN snapshot. With App Lock on, the app deletes that snapshot, stops writing it and leaves an empty `app-lock-on` marker beside it, so Get Mindwtr Tasks never shows task text and stops the shortcut with "Get Mindwtr Tasks is off while App Lock is on. Turn off App Lock in Mindwtr Settings to use it." Unlocking the app does not turn it back on, as with system search. RN still returns tasks while locked; native keeps App Lock's privacy, as its system search does. The next snapshot after App Lock is turned off removes the marker. Add to Mindwtr still works with App Lock on; the item is saved after unlock. Isolated UI-test libraries neither drain the queue nor write the snapshot. On its first production launch after an upgrade, the app deletes RN's stale App Group copy (`mindwtr-ios-shortcuts-snapshot`); nothing in this client or its widget extension reads that key.

## Capture reminder syntax (#1545)

- Reach: Quick capture or task capture title, then Save.
- Syntax: `/due:tomorrow 5pm /remind-due:1d` and `/start:tomorrow 9am /remind-start:30m`. Positive leads require the matching explicit date command with an explicit time. Units are integer `m`, `h`, `d`, `w`; due accepts 0–10080 minutes and start accepts only 0/5/15/30/60. `0m` turns the advance reminder off. Invalid tokens remain visible, show a warning and refuse save. Existing task reminder policy and device notification settings apply.
- Code: `packages/core/src/quick-add.ts`, `packages/core/src/quick-add-preview.ts`, `packages/core/src/capture.ts`
- Checks: `packages/core/src/quick-add-reminders.test.ts`, `packages/core/src/task-reminder-policy.test.ts`, `packages/core/src/native-host-contract-prepared-capture.test.ts`, `packages/core/src/native-host-contract-prepared-lines.test.ts`, `apps/mobile/components/quick-capture-sheet.save.test.tsx`

### Selective task reminders (#1547)

- Path: task editor → start/due reminders → Start only or Due only. The selected date needs an explicit time or an enabled date-only reminder default; its advance reminder replaces the ordinary alert. Repeat reminders are hidden and inactive in these modes; hidden values are preserved when switching back to Send.
- Ownership: `packages/core/src/task-reminder-policy.ts`, `packages/core/src/schedule-utils.ts`, `packages/core/src/task-editor-schedule.ts`; each platform consumes the shared reminder model and plan.
- Checks: `packages/core/src/selective-reminders.test.ts`; confirm old alarms are withdrawn after changing modes, completion, or permission revocation. Review reminders remain separate.
- Compatibility: older clients skip these selective reminders and cannot edit or preserve the new policy reliably. Update every device before using the new modes.

## Project calendar reference

- Reach: Projects › open a Project › expand Details › the calendar card (first in Details, as in RN) › Link calendar event, Replace linked event, or Unlink calendar event. The picker opens inside the card. Search the upcoming 90-day events by event title or calendar name.
- Selectors: `project-calendar-reference`, `project-calendar-link`, `project-calendar-unlink`, `project-calendar-search`, `project-calendar-cancel`, `project-calendar-title`, `project-calendar-date`, `project-calendar-status`, `project-calendar-picker-status`, `project-calendar-save-failed`; each picker row is `project-calendar-event-` plus its index
- Code: `apps/ios-native/App/ProjectsScreen.swift`, `apps/ios-native/App/CoreModel.swift`, `apps/ios-native/Sources/MindwtrNativeCore/CoreHost.swift`, `packages/core/src/native-host-contract-project-calendar-reference.ts`
- Checks: `packages/core/src/native-host-contract-project-calendar-reference.test.ts`, `apps/ios-native/Tests/MindwtrNativeCoreTests/CoreHostTests.swift` (testProjectCalendarReference…)
- Notes: One read-only ICS event reference belongs to the Project. Linking creates no task and changes no calendar event. Ambiguous identities and incomplete feed reads offer no candidates; unavailable feeds show last-known details. Expanding Details reads the stored link first with `summary: true`, which never downloads feeds; feeds download only when a link exists or the picker is open. Dates show "start – end". Archived Projects are read-only. Explicit unlink persists a null marker. Native writes freeze the selected candidate and Project snapshot before journaling, retain exact retries, and acknowledge only after durable storage.

## Date-only task reminders (#1570)

- Reach: Settings › Notifications › Date-only start reminders / Date-only due reminders. Each offers Off or a local reminder time; both default to Off. Task editor › start/due reminders shows the effective default and retains Skip, advance and configured repeat controls.
- Behavior: Only notification timing changes. Task dates, all-day calendar placement, availability and overdue calculations stay unchanged. Explicit task times take precedence; Review reminders are unchanged. Changing or disabling a default replaces pending reminders without replaying past alerts.
- Code: `packages/core/src/schedule-utils.ts`, `packages/core/src/notifications-settings-model.ts`, `packages/core/src/task-editor-schedule.ts`
- Checks: `packages/core/src/task-editor-schedule.test.ts`; validate independent defaults, explicit-time precedence, Skip, advance reminders and pending notification replacement.
