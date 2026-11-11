# Mobile feature map (Expo + React Native)

Source: `apps/mobile`. Routes live in `apps/mobile/app` (expo-router). Labels below come from `packages/core/src/i18n/locales/en.ts`. The URL scheme is `mindwtr` (`apps/mobile/app.json`).

## Launch for testing

- Start Metro from the repo root with `bun run mobile:start` (runs `expo start`). Build and install a native app with `bun run mobile:android` or `bun run mobile:ios` (`expo run:android`, `expo run:ios`).
- Build the development variant from `apps/mobile` with `bun run android:dev` or `bun run ios:dev`. It runs `expo prebuild --clean` with `APP_VARIANT=development`. The app installs as `tech.dongdongbh.mindwtr.dev` next to the release app `tech.dongdongbh.mindwtr`. Both use the `mindwtr` scheme, so pin the package when you send a deep link (`adb shell am start -a android.intent.action.VIEW -d "mindwtr:///inbox" tech.dongdongbh.mindwtr.dev`).
- Run the component and unit tests with `bun run test` in `apps/mobile` (Vitest).
- Use the `android-emulator-testing` skill before any adb, Appium, or emulator command. It drives the dedicated Galaxy S23 test phone through Appium + UiAutomator2, an emulator, or Expo Go. Use the `mindwtr-apple-dev` skill for the iPhone.
- At launch the app reopens the last route it restored, not always Focus (`apps/mobile/app/index.tsx`).

## Tab bar and Menu sheet

- Reach: Bottom tabs, left to right: Focus › Inbox › Add Task (center button) › Review › Menu. On a wide or unfolded screen the tabs move to a side rail.
- Shortcuts: Long press the center Add Task button to open capture in the other mode (voice instead of text, or text instead of voice).
- Selectors: `adaptive-window-root`
- Code: `apps/mobile/app/(drawer)/(tabs)/_layout.tsx`, `apps/mobile/app/(drawer)/_layout.tsx`, `packages/core/src/more-menu-model.ts`, `apps/mobile/hooks/use-adaptive-window.tsx`
- Checks: `apps/mobile/tests/tab-layout-quick-capture.test.tsx`, `apps/mobile/app/(drawer)/_layout.test.tsx`, `apps/mobile/hooks/use-adaptive-window.test.tsx`
- Notes: Menu opens a sheet (Waiting For, Someday, Projects, Reference, Contexts, Calendar, Trash, Board, History, Settings, Saved Searches), not a screen. The fourth tab follows Settings › General › Quick access view; when that is not Review, the sheet shows Review where it would show Projects.

## Area filter

- Reach: Area filter button at the left of the tab screen header (label "Area filter: <areas>"). Also in the header of stacked screens such as Board and Calendar.
- Code: `apps/mobile/components/mobile-area-switcher.tsx`, `apps/mobile/hooks/use-mobile-area-filter.ts`
- Checks: `apps/mobile/components/mobile-area-switcher.test.tsx`
- Notes: Inbox ignores the area filter. New captures get the selected area only when the default area mode is "active" and the capture names no project.

## Focus

- Reach: Focus tab. Sections include Today's Focus, schedule, next actions, upcoming, and review-due projects.
- Shortcuts: Swipe a row right for Done or Focus. Long press a review-due task to mark it reviewed. Long press a focused or next task to defer its start date. Reorder › long press and drag a row. Long press a saved filter chip to delete it.
- Selectors: `focus-reorder-toggle`, `focus-reorder-list`, `focus-reorder-row-` (+ task id), `focus-reorder-handle-` (+ task id), `focus-reorder-done`, `focus-view-options-content`, `focus-hidden-by-area`
- Code: `apps/mobile/app/(drawer)/(tabs)/focus.tsx`, `apps/mobile/components/focus/focus-list-layout.ts`
- Checks: `apps/mobile/lib/focus-screen.test.tsx`, `apps/mobile/lib/focus-controls-parity.test.tsx`, `apps/mobile/tests/focused-count-selector.test.ts`
- Notes: Long press on Focus rows does not start bulk selection. Starring an inbox task makes it next, and the focus cap can block a new star.
- Notes: Focus task dates show Today, Tomorrow, or a full localized weekday for the next six days, with explicit times retained. Start uses an arrow and Due a calendar; accessible labels retain the field and exact date. Past dates and dates at least seven days away stay exact. Labels refresh at local midnight and when the app returns to the foreground.

## Pomodoro

- Reach: Settings › GTD › Pomodoro timer (switch on) › Focus tab shows the Pomodoro Focus panel. Settings › GTD › Pomodoro settings for presets.
- Selectors: `gtd-nav-pomodoro`, `pomodoro-completion-alert`, `exact-alarm-notice`, `exact-alarm-allow`
- Code: `apps/mobile/components/pomodoro-panel.tsx`, `apps/mobile/lib/pomodoro-controller.ts`, `apps/mobile/hooks/root-layout/use-root-layout-pomodoro.ts`
- Checks: `apps/mobile/components/pomodoro-panel.test.tsx`, `apps/mobile/hooks/root-layout/use-root-layout-pomodoro.test.tsx`, `apps/mobile/components/settings/exact-alarm-notice.test.tsx`
- Notes: The panel is hidden until the feature switch is on.

## Inbox

- Reach: Inbox tab. Header button "Process Inbox (N)". With an empty Inbox the main button is Mind Sweep.
- Shortcuts: Swipe right for Done or Focus. Swipe left for Organize, Dates…, Delete. Long press a row to start bulk selection. Pull down to sync.
- Code: `apps/mobile/app/(drawer)/(tabs)/inbox.tsx`, `apps/mobile/components/task-list.tsx`
- Checks: `apps/mobile/app/(drawer)/(tabs)/inbox.test.tsx`, `apps/mobile/components/task-list/inbox-view-parity.test.tsx`, `apps/mobile/components/task-list.test.tsx`
- Notes: The list and its count ignore the global area filter, including tasks with no area. The "All areas" hint above the list shows this.

## Inbox processing

- Reach: Inbox › Process Inbox (N). A step-by-step clarify flow opens for each task.
- Code: `apps/mobile/components/inbox-processing-modal.tsx`, `apps/mobile/components/inbox-processing/InboxStepFlow.tsx`, `apps/mobile/components/inbox-processing/useInboxProcessingController.ts`
- Checks: `apps/mobile/components/inbox-processing-modal.test.tsx`, `apps/mobile/components/inbox-processing/process-inbox-parity.test.tsx`, `apps/mobile/components/inbox-processing/InboxProjectSection.test.tsx`
- Notes: Setting a project clears a direct area, because a task has one Container.

## Mind Sweep

- Reach: Inbox › Mind Sweep. Also Review › Start Review › Weekly Review › Mind Sweep button.
- Selectors: `mind-sweep-start`, `mind-sweep-input`, `mind-sweep-add`, `mind-sweep-next`, `mind-sweep-back`, `mind-sweep-finish`, `mind-sweep-close`, `mind-sweep-summary`, `mind-sweep-scope-` (+ scope), `review-mind-sweep-button`
- Code: `apps/mobile/app/mind-sweep-modal.tsx`, `apps/mobile/components/mind-sweep-modal-content.tsx`
- Checks: `apps/mobile/components/mind-sweep-modal-content.test.tsx`, `apps/mobile/tests/mind-sweep-modal.test.tsx`
- Notes: Each item becomes an inbox task through Capture.

## Quick capture sheet

- Reach: Center Add Task tab button. Also an empty-list action on Inbox.
- Shortcuts: Long press Add Task to switch text and voice. Deep link `mindwtr:///capture-quick?mode=text&entry=details` opens this sheet over Inbox.
- Selectors: `quick-capture-adaptive-surface`, `quick-capture-scroll`, `quick-capture-close`, `quick-capture-syntax-help-toggle`, `quick-add-preview`, `quick-date-chips-row`
- Code: `apps/mobile/components/quick-capture-sheet.tsx`, `apps/mobile/components/quick-capture-sheet/QuickCaptureSheetBody.tsx`, `apps/mobile/app/(drawer)/(tabs)/capture-quick.tsx`
- Checks: `apps/mobile/tests/tab-layout-quick-capture.test.tsx`, `apps/mobile/components/quick-capture-sheet.save.test.tsx`, `apps/mobile/components/quick-capture-sheet/QuickCaptureSheetModal.test.tsx`, `apps/mobile/tests/capture-quick.test.tsx`
- Notes: Buttons are Save, Add another, and Save & edit. A `+Project` token that names only an archived project creates a new project. Settings › GTD › Capture defaults picks text or voice as the default.

## Voice capture and Whisper

- Reach: Long press Add Task (or tap it when voice is the default) › Start recording › Stop recording.
- Code: `apps/mobile/components/use-quick-capture-audio.ts`, `apps/mobile/lib/speech-to-text.ts`, `apps/mobile/lib/whisper-model-store.ts`
- Checks: `apps/mobile/components/use-quick-capture-audio.test.tsx`, `apps/mobile/lib/speech-to-text.test.ts`
- Notes: Transcription runs only when Settings › Advanced › AI assistant › Enable speech to text is on. The provider is local Whisper or a cloud provider. The recording can also be kept as an audio attachment.

## Queued Android capture

- Reach: Android Quick capture widget, Quick Settings tile, or capture shortcut.
- Code: `apps/mobile/modules/android-widget/android/src/main/java/tech/dongdongbh/mindwtr/androidwidget/QuickCaptureActivity.kt`, `packages/core/src/pending-captures.ts`
- Checks: `packages/core/src/pending-captures.test.ts`, `apps/mobile/lib/pending-captures.test.ts`
- Notes: Text and audio queue ingestion uses the configured default area, including active-filter mode. Explicit area/project choices take precedence. Missing or deleted default areas remain unassigned.

## Full-screen capture (system entry)

- Reach: Opened by the share sheet, Control Center, a capture deep link, and `mindwtr:///capture-quick` without `entry=details`.
- Code: `apps/mobile/app/capture-modal.tsx`, `packages/core/src/entry-points.ts`
- Checks: `apps/mobile/tests/capture-modal.test.tsx`, `apps/mobile/tests/capture-modal.parity.test.tsx`
- Notes: System URLs are rewritten to `/capture-modal?origin=system` in `apps/mobile/app/+native-intent.ts`. After a system-launched capture, the app returns to the previous app.

## Task editor

- Reach: Tap any task row. Header: Close, More, Save. More holds Share, Duplicate task, Create project from task, Delete, and more.
- Shortcuts: Swipe horizontally between the Edit and Preview pages.
- Selectors: `task-preview-mark-done`, `task-edit-adaptive-surface`, `task-edit-preview-page`, `task-edit-read-only-hint`, `task-edit-focus-star`, `project-create-error`, `area-create-error`, `destination-create-error`
- Code: `apps/mobile/components/task-edit-modal.tsx`, `apps/mobile/components/task-edit/TaskEditHeader.tsx`, `apps/mobile/components/task-edit/TaskEditFormTab.tsx`, `apps/mobile/components/task-edit/TaskEditViewTab.tsx`
- Checks: `apps/mobile/components/task-edit-modal.test.tsx`, `apps/mobile/components/task-edit/TaskEditFormTab.test.tsx`, `apps/mobile/components/task-edit/TaskEditViewTab.test.tsx`, `apps/mobile/components/task-edit/use-task-edit-actions.save-result.test.tsx`, `apps/mobile/components/task-edit/use-task-edit-preview-completion.test.tsx`
- Notes: Edits stay in the Task draft until Save. Sending a draft back to Inbox drops its Focus star. Field order and visibility come from Settings › GTD › Task editor layout.

- Preview completion: Mark Done appears inside the visible Status card for editable active tasks. It saves the complete current draft, including pending checklist input, through one normal completion write. Repeated taps and competing Save/Close are blocked until persistence finishes; a failed barrier keeps the Done draft/files with inline error and Retry in Preview/header. Retry actively persists the applied state without creating another recurring successor. iOS sheet swipe dismissal is disabled while submitting or retrying. Reference, terminal, Trash, projected and archived-project previews have no action.

## Checklist and attachments

- Reach: Task editor › checklist field and attachments field. Task rows also show checklist progress.
- Shortcuts: Drag a checklist row by its handle; the row follows the finger and neighboring rows preview its slot. Sideways movement keeps the drag active. Release commits the draft move; cancellation restores the original positions. Tap a handle for row actions; tapping another handle switches the menu on release. Both editor scroll views stay locked during handle contact; edge scrolling remains available. The order panel also provides up/down buttons.
- Selectors: `mobile-checklist-add-item`, `mobile-checklist-order-toggle`, `mobile-checklist-order-panel`, `mobile-checklist-row-` (+ item key), `mobile-checklist-drag-` (+ item key), `mobile-checklist-move-up-` (+ item id), `mobile-checklist-move-down-` (+ item id)
- Code: `apps/mobile/components/task-edit/TaskEditContentField.tsx`, `apps/mobile/components/task-edit/use-checklist-handle-drag.tsx`, `apps/mobile/components/task-edit/use-task-edit-attachments.ts`, `apps/mobile/components/swipeable-task-item/useSwipeableChecklist.ts`
- Checks: `apps/mobile/components/task-edit/TaskEditContentField.test.tsx`, `apps/mobile/components/task-edit/use-task-edit-attachments.test.tsx`, `apps/mobile/tests/attachments.parity.test.tsx`
- Notes: Attachments are buffered with the Task draft and count as pending edits.

## AI clarify and breakdown

- Reach: Task editor › AI clarify or AI breakdown. Needs Settings › Advanced › AI assistant › Enable AI assistant.
- Code: `apps/mobile/components/task-edit/use-task-edit-copilot.ts`, `apps/mobile/components/ai-response-modal.tsx`
- Checks: `apps/mobile/components/task-edit/use-task-edit-copilot.test.tsx`, `apps/mobile/components/ai-actions.parity.test.tsx`

## Task row swipe actions

- Reach: Any task list row.
- Shortcuts: Swipe right on an open task: Done, Focus (or Remove from focus). Long press Done in that tray to pick a past completion time. Swipe left: Organize, Dates…, Delete. A done task swipes right to Restore to Inbox. A reference task swipes right to Next.
- Selectors: `task-priority-strip`
- Code: `apps/mobile/components/swipeable-task-item.tsx`, `apps/mobile/components/swipeable-task-item/SwipeableTaskItemTray.tsx`, `packages/core/src/task-row-swipe-actions.ts`
- Checks: `apps/mobile/components/swipeable-task-item.test.tsx`, `apps/mobile/components/swipeable-task-item/SwipeableTaskItemStatusMenu.test.tsx`
- Notes: Organize opens the status and Move menu. A Move changes only the Container, never the status. Swipes are off during bulk selection.

## Bulk selection

- Bulk organize status includes Inbox for returning tasks to processing; existing project, notes, tags and dates stay unchanged unless explicitly edited.

- Reach: Long press a task row in Inbox, project tasks, Waiting For, Someday, Contexts, or Review. The bar shows Move to, Bulk organize, Range, Add tag, Remove tag, Delete, and Done to exit.
- Selectors: `task-list-range-select-toggle`, `task-list-reorder-shortcut`, `bulk-organize-project-picker-row`, `bulk-organize-area-picker-row`, `project-task-selection-bulk-bar`
- Code: `apps/mobile/components/use-task-list-selection.ts`, `apps/mobile/components/task-list/TaskListBulkBar.tsx`, `apps/mobile/components/task-list/TaskListBulkOrganizeModal.tsx`
- Checks: `apps/mobile/components/use-task-list-selection.test.tsx`, `apps/mobile/components/task-list/TaskListBulkBar.test.tsx`, `apps/mobile/components/task-list/bulk-actions-parity.test.tsx`, `apps/mobile/tests/review-screen-bulk-organize.test.tsx`
- Notes: Destructive actions confirm first, and bulk delete offers undo. Trash and Archived use their own Select button instead of this module.

## List filters, sort, and group

- Reach: List header › Filters, Sort, Group. Active filters show as chips with a clear button.
- Selectors: `sort-option-inherit`, `sort-option-` (+ option)
- Code: `apps/mobile/components/task-list/TaskListHeader.tsx`, `apps/mobile/components/task-filter-sheet.tsx`, `apps/mobile/components/task-list/TaskListSortModal.tsx`, `apps/mobile/hooks/use-task-filter-selections.ts`
- Checks: `apps/mobile/components/task-filter-sheet.test.tsx`, `apps/mobile/components/task-list/TaskListHeader.test.tsx`, `apps/mobile/components/task-list/TaskListSortModal.test.tsx`, `apps/mobile/hooks/use-task-filter-selections.test.tsx`
- Notes: Applying a saved filter turns its criteria back into Filter selections and drops values the pickers cannot show.

## Projects

- Reach: Menu › Projects (or the Projects tab when it is the quick access view). Tap a project to open its detail sheet.
- Shortcuts: Swipe a project right for Duplicate. Swipe left for Delete. Long press a project for Move up / Move down. Deep link `mindwtr://open?project=<id>`.
- Selectors: `projects-list-controls`, `projects-tag-filter-toggle`, `projects-tag-filter-section`, `project-row-` (+ project id), `project-row-open-` (+ project id), `project-row-duplicate-` (+ project id), `project-row-delete-` (+ project id), `project-area-header-` (+ kind and area id), `project-area-menu-` (+ kind and area id)
- Code: `apps/mobile/app/(drawer)/projects-screen.tsx`, `apps/mobile/app/(drawer)/(tabs)/projects.tsx`, `apps/mobile/components/projects-screen/ProjectRow.tsx`, `apps/mobile/components/projects-screen/ProjectAreaModals.tsx`
- Checks: `apps/mobile/lib/projects-screen.test.tsx`, `apps/mobile/lib/projects-screen-sort.test.tsx`, `apps/mobile/components/projects-screen/ProjectRow.test.tsx`, `apps/mobile/components/projects-screen/ProjectAreaModals.test.tsx`
- Notes: Projects are grouped by area. "Add new project..." creates a project. "Manage areas" renames and reorders areas.

## Project detail

- Reach: Projects › tap a project. Controls cover status, area, tags, dates, sections, flow mode, and the project task list.
- Shortcuts: Reorder › long press and drag a task handle.
- Selectors: `project-actions-menu-button`, `project-add-task-button`, `project-status-picker`, `project-status-menu-item-` (+ status), `project-area-picker`, `project-tag-picker`, `project-due-date-picker`, `project-start-date-picker`, `project-review-date-picker`, `project-sections-button`, `project-section-add-button`, `project-section-title-input`, `project-section-save-button`, `project-flow-mode-options`, `project-convert-to-section-button`, `project-duplicate-button`, `project-delete-button`, `project-task-reorder-toggle`, `project-task-drag-handle-` (+ task id), `project-task-view-options-button`
- Code: `apps/mobile/components/projects-screen/ProjectDetailModal.tsx`, `apps/mobile/components/projects-screen/ProjectTaskList.tsx`, `apps/mobile/components/projects-screen/ProjectToSectionModal.tsx`
- Checks: `apps/mobile/components/projects-screen/ProjectDetailModal.test.tsx`, `apps/mobile/components/projects-screen/ProjectToSectionModal.test.tsx`, `apps/mobile/components/project-next-action-prompt.test.tsx`
- Notes: An Archived project is read-only and accepts no new tasks. Tasks moved in land at the end of the Unsectioned group.

## Contexts and tags

- Reach: Menu › Contexts. Chips list each @context and #tag with a count.
- Shortcuts: Tap a chip to show only that token. Long press a chip to add it to or remove it from the selection. Deep link route `/contexts?token=@home`.
- Code: `apps/mobile/components/views/contexts-view.tsx`, `apps/mobile/app/(drawer)/contexts.tsx`, `apps/mobile/app/(drawer)/(tabs)/contexts-tab.tsx`
- Checks: `apps/mobile/components/views/contexts-view.test.tsx`, `apps/mobile/components/views/contexts-view.parity.test.tsx`
- Notes: Several selected tokens match in "all" mode by default; the view can switch to "any".

## Waiting For

- Reach: Menu › Waiting For. Filter by person.
- Code: `apps/mobile/components/views/waiting-view.tsx`, `apps/mobile/app/(drawer)/waiting.tsx`
- Checks: `apps/mobile/components/views/waiting-view.test.tsx`, `apps/mobile/components/views/menu-views-parity.test.tsx`

## Someday/Maybe

- Reach: Menu › Someday. The overflow menu holds filter, sort, group, details, and New section.
- Shortcuts: Long press a deferred project to move it to a section.
- Selectors: `someday-overflow-button`, `someday-filter-action`, `someday-sort-action`, `someday-sort-` (+ value), `someday-group-action`, `someday-group-` (+ value), `someday-toggle-details`, `someday-new-section-action`
- Code: `apps/mobile/components/views/someday-view.tsx`, `apps/mobile/components/views/someday-section-manager.tsx`, `apps/mobile/components/views/deferred-projects-section.tsx`
- Checks: `apps/mobile/components/views/someday-view.test.tsx`, `apps/mobile/components/views/someday-section-manager.test.tsx`, `apps/mobile/components/views/deferred-projects-section.test.tsx`
- Notes: A Deferred project is still a valid home for tasks.

## Reference

- Reach: Menu › Reference.
- Shortcuts: Swipe a reference task right to make it Next.
- Code: `apps/mobile/app/(drawer)/reference.tsx`
- Checks: `apps/mobile/app/(drawer)/reference.test.tsx`

## Board

- Reach: Menu › Board (screen title "Board View"). One column per status.
- Shortcuts: Long press a card, then drag it up or down to another column to change its status.
- Selectors: `board-filter-controls`
- Code: `apps/mobile/components/views/board-view.tsx`, `apps/mobile/app/(drawer)/board.tsx`
- Checks: `apps/mobile/components/views/board-view.test.tsx`, `apps/mobile/components/views/board-view.parity.test.tsx`

## Calendar

- Reach: Menu › Calendar. Modes: Day, Week, Month, Schedule.
- Shortcuts: Swipe left or right on Month or Day to change the period. In the Day timeline, long press a scheduled block and drag it to a new time. Deep link `mindwtr:///calendar`.
- Selectors: `calendar-all-day-more`, `calendar-deadline-` (+ task id)
- Code: `apps/mobile/components/views/calendar-view.tsx`, `apps/mobile/components/views/calendar/useCalendarViewController.ts`, `apps/mobile/components/views/calendar/calendar-task-composer-modal.tsx`
- Checks: `apps/mobile/components/views/calendar/calendar-period-navigation.test.tsx`, `apps/mobile/components/views/calendar-view.all-day.test.tsx`, `apps/mobile/components/views/calendar-view.schedule-order.test.tsx`, `apps/mobile/components/views/calendar/calendar-task-composer-modal.test.tsx`

## Review screen

- Reach: Review tab. Toggle "Due for review" or "All open tasks". Start Review opens a picker: Daily Review or Weekly Review.
- Shortcuts: "Review in 1 week" on a row. Long press a row for bulk selection.
- Code: `apps/mobile/app/(drawer)/review.tsx`, `apps/mobile/app/(drawer)/(tabs)/review-tab.tsx`
- Checks: `apps/mobile/app/(drawer)/review.parity.test.tsx`, `apps/mobile/tests/review-screen-bulk-organize.test.tsx`

## Daily Review

- Reach: Review › Start Review › Daily Review. Steps: today, focus, inbox, waiting, then completed.
- Selectors: `daily-review-step-scroll-today`, `daily-review-step-scroll-focus`, `daily-review-step-scroll-inbox`, `daily-review-step-scroll-waiting`, `daily-review-completed-scroll`, `daily-review-footer`
- Code: `apps/mobile/app/daily-review.tsx`, `apps/mobile/components/daily-review-modal.tsx`
- Checks: `apps/mobile/components/daily-review-modal.test.tsx`, `apps/mobile/components/daily-review-modal.parity.test.tsx`
- Notes: Waiting For follows a valid review date, falling back to the task's start date; future dates defer the prompt.

## Weekly Review and share card

- Reach: Review › Start Review › Weekly Review. The share card button opens "My weekly reflection".
- Selectors: `review-completed-scroll`, `review-complete-project-` (+ project id), `review-confirm-complete-project`, `review-share-card-button`, `share-card-preview`, `share-card-message`, `share-card-reflection`, `share-card-style-` (+ style), `share-card-export`, `share-card-close`
- Code: `apps/mobile/components/review-modal.tsx`, `apps/mobile/components/review/useReviewModalController.ts`, `apps/mobile/components/share-card-modal.tsx`, `apps/mobile/app/weekly-review.tsx`
- Checks: `apps/mobile/components/review-modal.test.tsx`, `apps/mobile/components/review-modal.parity.test.tsx`, `apps/mobile/components/share-card-modal.test.tsx`
- Notes: The Start Review picker opens the review in place. Only a review notification opens the `/weekly-review` route. Waiting For follows a valid review date, falling back to the task's start date; future dates stay under Not due yet.

## History: Done and Archived

- Reach: Menu › History › Done or Archived tab. The Review screen's All open tasks mode also links to History.
- Shortcuts: Swipe an archived row right to restore it and left to delete it. Route `/done` redirects to `/history?tab=done`.
- Selectors: `archived-overflow-button`, `archived-filter-action`, `archived-sort-action`, `archived-sort-` (+ option), `archived-group-action`, `archived-group-` (+ option), `archived-active-filters-button`, `archived-group-header-` (+ group id)
- Code: `apps/mobile/app/(drawer)/history.tsx`, `apps/mobile/app/(drawer)/done.tsx`, `apps/mobile/app/(drawer)/archived.tsx`
- Checks: `apps/mobile/app/(drawer)/history.test.tsx`, `apps/mobile/app/(drawer)/done.test.tsx`, `apps/mobile/tests/archived-screen.test.tsx`, `apps/mobile/app/(drawer)/archived.parity.test.tsx`

## Trash

- Reach: Menu › Trash. Header: Select, Select All, Clear Trash.
- Shortcuts: Swipe right for Restore. Swipe left for Delete Permanently.
- Code: `apps/mobile/app/(drawer)/trash.tsx`
- Checks: `apps/mobile/tests/trash-screen.test.tsx`, `apps/mobile/app/(drawer)/trash.parity.test.tsx`
- Notes: Trash selects tasks and projects together, so it stays outside the shared Bulk selection module.

## Search and saved searches

- Reach: Search icon at the right of any tab header. "Save Search" stores the query. Saved searches appear in Menu › Saved Searches.
- Shortcuts: Deep link `mindwtr:///global-search?q=<text>`.
- Code: `apps/mobile/app/global-search.tsx`, `apps/mobile/app/(drawer)/saved-search/[id].tsx`
- Checks: `apps/mobile/app/global-search.test.tsx`, `apps/mobile/app/(drawer)/saved-search/saved-search-screen.test.tsx`, `apps/mobile/app/(drawer)/saved-search/saved-search.parity.test.tsx`

## Pull-to-sync and sync badge

- Reach: Pull down on a task list. A colored dot on the Menu tab and on Settings › Sync shows sync state.
- Code: `apps/mobile/hooks/use-manual-pull-sync.ts`, `apps/mobile/hooks/use-mobile-sync-badge.ts`, `apps/mobile/components/PullSyncIndicator.tsx`
- Checks: `apps/mobile/hooks/use-manual-pull-sync.test.tsx`, `apps/mobile/tests/use-root-layout-sync-effects.test.tsx`

## Settings home

- Reach: Menu › Settings. Rows: General, GTD, Manage, Notifications, Sync, Data, Advanced, About. A search box filters rows.
- Shortcuts: Route `/settings?settingsScreen=<id>` opens a subscreen, for example `sync` or `gtd-capture`.
- Code: `apps/mobile/app/(drawer)/settings.tsx`, `apps/mobile/components/settings/settings.shell.tsx`, `packages/core/src/settings-menu-model.ts`
- Checks: `apps/mobile/components/settings/settings.shell.test.tsx`, `apps/mobile/components/settings/settings.search.test.ts`, `apps/mobile/components/settings/settings.parity.test.tsx`
- Notes: Advanced holds AI assistant and External Calendar.

## Settings › General (appearance, language, app lock)

- Reach: Settings › General. Theme, Language, regional formats, Quick access view, App lock, Expose to system search (Android).
- Notes: E-Ink renders identity accents in monochrome without changing stored colors or color pickers. Review badges keep distinct state labels with dark text on a light fill. Sync indicators use refresh/check/warning glyphs and translated status labels.
- Selectors: `regional-formats-toggle`, `app-lock-privacy-cover`
- Code: `apps/mobile/components/settings/general-settings-screen.tsx`, `packages/core/src/general-settings-model.ts`, `apps/mobile/components/mobile-app-lock-gate.tsx`
- Checks: `apps/mobile/components/settings/general-settings-screen.test.tsx`, `apps/mobile/components/mobile-app-lock-gate.test.tsx`
- Notes: App lock uses the device lock and protects the app view, not the database. On Android, a native window keeps the mounted app and its dialogs private while away, showing a blank cover. The unlock panel appears only while active and locked. Private screens wait for the authoritative local database at startup; a backup snapshot cannot decide whether the app is locked. A failed load shows a generic retry screen. Enabling App lock in Settings reuses only that action’s just-completed device authentication; an asynchronously loaded enabled preference requires unlocking.

## Settings › GTD

- Reach: Settings › GTD. Subscreens: Pomodoro settings, Auto-archive done tasks, Task editor layout, Capture defaults, Review steps, Inbox processing.
- Selectors: `gtd-nav-pomodoro`, `gtd-nav-archive`, `gtd-nav-task-editor`, `gtd-nav-capture`, `gtd-nav-review`, `gtd-nav-inbox`, `default-area-picker-button`, `default-area-picker-option-` (+ value), `task-editor-row-` (+ field id), `task-editor-visibility-` (+ field id), `task-open-mode-` (+ value)
- Code: `apps/mobile/components/settings/gtd-settings-screen.tsx`, `packages/core/src/gtd-settings-model.ts`
- Checks: `apps/mobile/components/settings/gtd-settings-screen.test.tsx`, `apps/mobile/components/settings/gtd-settings-screen.parity.test.tsx`

## Settings › Manage

- Reach: Settings › Manage. Sections: areas, contexts, tags, people, Someday sections.
- Selectors: `manage-section-toggle-areas`, `manage-section-toggle-contexts`, `manage-section-toggle-tags`, `manage-section-toggle-people`, `manage-section-toggle-someday-sections`, `manage-area-add`, `manage-context-add`, `manage-tag-add`, `manage-person-add`, `manage-editor-save`, `manage-editor-cancel`, `manage-unassigned-area-color`
- Code: `apps/mobile/components/settings/manage-settings-screen.tsx`
- Checks: `apps/mobile/components/settings/manage-settings-screen.test.tsx`

## Settings › Notifications

- Reach: Settings › Notifications. Task reminders, Daily digest, Weekly review, app icon badge, "Quick capture in notification bar" (Android).
- Selectors: `app-icon-badge`, `task-reminder-default`
- Code: `apps/mobile/components/settings/notifications-settings-screen.tsx`, `apps/mobile/lib/notification-service-local.ts`, `apps/mobile/lib/persistent-capture-notification.ts`
- Checks: `apps/mobile/components/settings/notifications-settings-screen.test.tsx`, `apps/mobile/components/settings/notifications-settings-screen.parity.test.tsx`, `apps/mobile/lib/persistent-capture-notification.test.ts`

## Notification actions

- Reach: Tap a reminder to open its task in Focus. Use the Complete or Snooze action button on a task reminder. Review, daily review, and weekly review notifications open their screens.
- Code: `apps/mobile/hooks/root-layout/use-root-layout-notification-open-handler.ts`, `apps/mobile/lib/notification-completion-drain.ts`, `apps/mobile/plugins/patch-alarm-notification-gradle.js`
- Checks: `apps/mobile/tests/use-root-layout-notification-open-handler.test.tsx`, `apps/mobile/tests/use-root-layout-notification-open-handler.durable.test.tsx`, `apps/mobile/lib/notification-completion-drain.test.ts`, `apps/mobile/scripts/check-reminder-actions-device.sh`
- Notes: The device script builds an instrumented APK and runs on a real phone (default serial is the S23). Complete can run without opening the app.

## Settings › Sync (backends, encryption)

- Reach: Settings › Sync › Sync backend: Off, File, WebDAV, Self-Hosted, Dropbox, iCloud (Apple builds). Then the encryption card, Settings sync options, and Recovery snapshots.
- Selectors: `sync-guide-link`, `sync-encryption-guide-link`, `sync-preferences-disclosure`, `sync-preferences-chevron`, `recovery-snapshots-disclosure`, `recovery-snapshots-chevron`, `recovery-snapshot-` (+ snapshot)
- Code: `apps/mobile/components/settings/sync-settings-screen.tsx`, `apps/mobile/components/settings/sync-settings-webdav-panel.tsx`, `apps/mobile/components/settings/sync-settings-dropbox-panel.tsx`, `apps/mobile/components/settings/sync-settings-file-panel.tsx`, `apps/mobile/components/settings/sync-settings-selfhosted-panel.tsx`, `apps/mobile/components/settings/sync-settings-cloudkit-panel.tsx`, `apps/mobile/components/settings/sync-settings-encryption-card.tsx`
- Checks: `apps/mobile/components/settings/sync-settings-screen.parity.test.tsx`, `apps/mobile/components/settings/sync-settings-encryption-card.test.tsx`, `apps/mobile/components/settings/use-sync-settings-transport-actions.test.tsx`
- Notes: A new backend stays inactive until its probe passes; each sync is one Sync run in core. Use the `sync-device-testing` skill for real backends.
- Upgrade: Settings › Sync › Encryption › Upgrade sync encryption opens an explicit current-passphrase confirmation. Update every device first; older clients cannot read the result. The service uses a verified durable local copy and refuses mismatches or unavailable storage. Keep the upgrade passphrase for retained encrypted recovery archives, even after changing the active passphrase. An interrupted format upgrade can retry; other unfinished encryption transitions do not expose this action. No upgrade runs automatically during unlock.

## Settings › Data (backup, import, export, diagnostics)

- Reach: Settings › Data › Backup: Export Backup, Export CSV, Export as TaskNotes, Merge Backup, Restore Backup, and Import from Todoist, TickTick, OmniFocus, DGT GTD, Mindwtr CSV. Below: Apple Reminders import (iOS), archive retention, Open sandbox, Diagnostics.
- Selectors: `backup-disclosure`, `data-transfer-export`, `data-transfer-export-csv`, `data-transfer-export-tasknotes`, `data-transfer-merge`, `data-transfer-restore`, `import-disclosure`, `data-transfer-import-todoist`, `data-transfer-import-ticktick`, `data-transfer-import-omnifocus`, `data-transfer-import-dgt`, `data-transfer-import-mindwtr-csv`, `import-guide-link`, `add-getting-started-content`, `sync-encryption-diagnostics-disclosure`, `apple-reminders-import-row`, `apple-reminders-list-row`, `apple-reminders-auto-import-switch`, `apple-reminders-delete-switch`
- Code: `apps/mobile/components/settings/sync-settings-sections.tsx`, `apps/mobile/components/settings/use-sync-settings-backup-actions.ts`, `apps/mobile/lib/data-transfer.ts`, `apps/mobile/components/settings/apple-reminders-import-section.tsx`, `apps/mobile/components/settings/archive-retention-section.tsx`
- Checks: `apps/mobile/components/settings/sync-settings-sections.test.tsx`, `apps/mobile/components/settings/use-sync-settings-backup-actions.test.tsx`, `apps/mobile/components/settings/sync-diagnostics-card.parity.test.tsx`, `apps/mobile/components/settings/apple-reminders-import-section.test.tsx`, `apps/mobile/components/settings/archive-retention-section.test.tsx`
- Notes: The Data and Sync screens share one component; the `mode` prop picks the sections.

## Sandbox workspace

- Reach: Settings › Data › Open sandbox. A banner offers reset and Exit sandbox.
- Selectors: `sandbox-workspace-banner`, `sandbox-workspace-banner-content`, `sandbox-reset-button`, `sandbox-exit-button`, `sandbox-workspace-modal-cue`
- Code: `apps/mobile/components/sandbox-workspace-banner.tsx`, `apps/mobile/components/settings/sandbox-settings-screen.tsx`, `apps/mobile/lib/sandbox-workspace.ts`
- Checks: `apps/mobile/components/sandbox-workspace-banner.test.tsx`, `apps/mobile/components/settings/sandbox-entry-confirmation.test.ts`
- Notes: In the sandbox, Settings shows only the sandbox screen.

## Settings › Advanced › AI assistant

- Reach: Settings › Advanced › AI assistant. Enable AI assistant, pick a provider (OpenAI, Anthropic, Gemini, local), and set speech to text (Whisper model download).
- Code: `apps/mobile/components/settings/ai-settings-screen.tsx`, `apps/mobile/components/settings/ai-settings-assistant-card.tsx`, `apps/mobile/components/settings/ai-settings-speech-card.tsx`, `apps/mobile/components/settings/ai-settings-whisper-model.ts`
- Checks: `apps/mobile/components/settings/ai-settings-screen.test.tsx`, `apps/mobile/components/settings/ai-settings-assistant-card.test.tsx`, `apps/mobile/components/settings/ai-settings-whisper-model.test.ts`

## Settings › Advanced › External Calendar

- Reach: Settings › Advanced › External Calendar. Add ICS subscriptions under External calendars. Pick Device calendars to show or push tasks.
- Selectors: `calendar-guide-link`
- Code: `apps/mobile/components/settings/calendar-settings-screen.tsx`, `apps/mobile/lib/external-calendar.ts`, `apps/mobile/lib/calendar-push-sync.ts`
- Checks: `apps/mobile/components/settings/calendar-settings-screen.parity.test.tsx`, `apps/mobile/tests/external-calendar.test.ts`, `apps/mobile/tests/calendar-push-sync.test.ts`

## Settings › About and feedback

- Reach: Settings › About. Version, update badge, and a feedback form that can attach diagnostics.
- Code: `apps/mobile/components/settings/about-settings-screen.tsx`, `apps/mobile/components/settings/feedback-settings-modal.tsx`
- Checks: `apps/mobile/components/settings/about-settings-screen.parity.test.tsx`, `apps/mobile/components/settings/feedback-settings-modal.test.tsx`

## Onboarding

- Reach: First launch shows the onboarding flow. "Skip onboarding" leaves it.
- Selectors: `mobile-onboarding-start-fresh-handoff`
- Code: `apps/mobile/components/MobileOnboardingFlow.tsx`, `apps/mobile/app/_layout.tsx`
- Checks: `apps/mobile/components/MobileOnboardingFlow.test.tsx`

## Share target

- Reach: Another app › Share › Mindwtr. The full-screen capture opens with the shared text as the title and a URL in the description.
- Code: `apps/mobile/hooks/root-layout/use-root-layout-external-capture.ts`, `apps/mobile/app/+native-intent.ts`, `packages/core/src/entry-points.ts`
- Checks: `apps/mobile/tests/use-root-layout-external-capture.test.tsx`, `apps/mobile/tests/native-intent.test.ts`, `apps/mobile/tests/expo-share-intent-patch.test.ts`
- Notes: A cold-start share routes to `/inbox` first, then opens capture.

## Deep links

- Reach: Open a `mindwtr://` URL from adb, a browser, Shortcuts, or an assistant.
- Shortcuts: `mindwtr:///capture?title=<t>&note=<n>&project=<p>&tags=a,b` opens a capture confirmation. `mindwtr://open?task=<id>` opens the task in Focus; `?project=<id>` and `?area=<id>` open Projects. `mindwtr:///open-feature?feature=inbox|focus|waiting|someday|projects|review|calendar|capture`. `mindwtr:///capture-quick` opens the full-screen capture; add `?mode=text&entry=details` to open the quick capture sheet instead. `mindwtr:///global-search?q=<text>`. Plain routes such as `mindwtr:///focus` and `mindwtr:///calendar` also work.
- Code: `apps/mobile/app/+native-intent.ts`, `packages/core/src/capture-deeplink.ts`, `packages/core/src/entry-points.ts`, `apps/mobile/hooks/use-incoming-url.ts`
- Checks: `apps/mobile/tests/native-intent.test.ts`, `apps/mobile/tests/use-incoming-url.test.tsx`, `apps/mobile/tests/entry-points.parity.test.tsx`, `apps/mobile/tests/use-root-layout-external-capture.test.tsx`
- Notes: A capture URL never saves directly; it opens a confirmation. A URL with no title shows a "Capture shortcut unavailable" toast.

## Context automation

- Reach: An automation app opens `mindwtr://activate-context/@home` (or `deactivate-context`). On Android, the intent actions `tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT` and `tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT` do the same.
- Code: `apps/mobile/hooks/root-layout/use-root-layout-context-automation.ts`, `apps/mobile/lib/context-automation-handler.ts`, `packages/core/src/context-automation.ts`
- Checks: `apps/mobile/tests/use-root-layout-context-automation.test.tsx`, `apps/mobile/lib/context-automation-handler.test.ts`
- Notes: Activation posts a notification with that context's next actions. Tapping it opens Contexts for that token.

## Capture integrations: automation intent and Gmail

- Reach: Settings › GTD › Capture defaults › Automation capture (Android) and Gmail.
- Selectors: `android-capture-intent-section`, `android-capture-intent-switch`, `android-capture-intent-token`, `android-capture-intent-copy`, `gmail-capture-section`, `gmail-expand`, `gmail-enabled-status`, `gmail-label-picker`, `gmail-label-` (+ label id), `gmail-notice`, `gmail-error`
- Code: `apps/mobile/components/settings/android-capture-intent-section.tsx`, `apps/mobile/components/settings/gmail-capture-section.tsx`, `apps/mobile/hooks/root-layout/use-root-layout-gmail-capture.ts`
- Checks: `apps/mobile/components/settings/android-capture-intent-section.test.tsx`, `apps/mobile/components/settings/gmail-capture-section.test.tsx`, `apps/mobile/hooks/root-layout/use-root-layout-gmail-capture.test.tsx`

## Android widgets

- Reach: Home screen › add widget: Tasks (list chooser), Compact, Quick Capture. Tap the title to open the shown list. Tap the chevron to choose a list. Tap a ring to check off a task. Tap plus to capture.
- Shortcuts: Widget links open `mindwtr:///focus`, `mindwtr:///inbox`, `mindwtr:///waiting`, `mindwtr:///someday`, or `mindwtr:///widget-list/<list-id>`.
- Code: `apps/mobile/modules/android-widget/README.md`, `apps/mobile/plugins/android-widget.js`, `apps/mobile/lib/widget-service.ts`, `apps/mobile/app/(drawer)/widget-list/[id].tsx`, `apps/mobile/hooks/use-widget-launch.tsx`
- Checks: `apps/mobile/tests/use-widget-launch.test.tsx`, `apps/mobile/app/(drawer)/widget-list/widget-list-screen.test.tsx`, `apps/mobile/modules/android-widget/android/src/test/java/tech/dongdongbh/mindwtr/androidwidget/WidgetNavigationTest.kt`, `apps/mobile/hooks/root-layout/use-root-layout-pending-captures.test.tsx`
- Notes: Widget check-offs and captures are queued; the app applies them through the store on the next drain. Widget code never writes SQLite. Rows checked off in a row stay in place, struck through and undoable, until three seconds after the last tap; then they all leave together (`CheckoffStore.kt`, check `CheckoffStoreTest.kt`) (#1211).
- E-Ink: Present priority rings and identity dots use each Android widget's effective text foreground, including transparent light-text and dark-text modes. Missing identity stays hidden; the transparent surface stays clear.

## Android launcher shortcuts and Quick Settings tile

- Reach: Long press the app icon: Capture, Add task…, Focus, Calendar. Quick Settings › Capture tile. Assistant app actions use `open-feature`.
- Shortcuts: Add task… opens `mindwtr:///capture-quick?mode=text&entry=details`. Capture opens a floating capture dialog without the main app.
- Code: `apps/mobile/plugins/android-app-shortcuts.js`, `apps/mobile/plugins/android-quick-settings-tile.js`, `apps/mobile/modules/android-widget/android/src/main/java/tech/dongdongbh/mindwtr/androidwidget/QuickCaptureActivity.kt`
- Checks: `apps/mobile/tests/native-intent.test.ts`

## iOS widgets, Home Screen quick actions, Siri

- Reach: Home Screen and Lock Screen widgets: Mindwtr (list), Compact, Focus, Add Task, plus a Control Center Add Task control. Long press the app icon: Add task, Focus, Calendar. Shortcuts app actions: Capture to Mindwtr, Add to Mindwtr, Open Mindwtr List, Open Mindwtr Saved List, Get Mindwtr Tasks.
- Code: `apps/mobile/widgets-ios/MindwtrWidgetsBundle.swift`, `apps/mobile/widgets-ios/MindwtrTasksWidget.swift`, `apps/mobile/plugins/ios-widgets-and-shortcuts.js`, `apps/mobile/ios-app-intents/MindwtrSiriCaptureIntents.swift`
- Checks: `apps/mobile/lib/ios-widget-completions.test.ts`
- Notes: The Control Center control opens `mindwtr://capture-quick?source=control`, which routes to the full-screen capture.
- Mindwtr widget: Edit Widget → List selects a built-in list or saved search; Focus also offers Include available actions. Normal medium widgets use a single list header and one-line task titles with date labels. Rows adapt to the widget height and Dynamic Type while keeping completion and capture controls; a sole Focus/Schedule heading is omitted, real groups remain, and VoiceOver retains task metadata. Compact and the other widget sizes keep their existing layouts.

## Apple Watch companion

- Reach: Watch app paired with the iPhone build.
- Code: `apps/mobile/targets/watch`, `apps/mobile/hooks/root-layout/use-root-layout-watch.ts`, `apps/mobile/plugins/ios-watch.js`
- Checks: `apps/mobile/hooks/root-layout/use-root-layout-watch.test.tsx`

## Apple evaluation screen (development only)

- Reach: Route `/apple-evaluation` in an iOS development build. Other builds redirect to Inbox.
- Selectors: `apple-image-capture-evaluation`, `apple-image-pick`, `apple-image-analyze`, `apple-image-save`, `apple-image-cancel`
- Code: `apps/mobile/app/apple-evaluation.tsx`, `apps/mobile/components/AppleImageCaptureEvaluation.tsx`
- Checks: `apps/mobile/tests/apple-evaluation-route.test.tsx`

## Capture reminder syntax (#1545)

- Reach: Quick capture or task capture title, then Save.
- Syntax: `/due:tomorrow 5pm /remind-due:1d` and `/start:tomorrow 9am /remind-start:30m`. Positive leads require the matching explicit date command with an explicit time. Units are integer `m`, `h`, `d`, `w`; due accepts 0–10080 minutes and start accepts only 0/5/15/30/60. `0m` turns the advance reminder off. Invalid tokens remain visible, show a warning and refuse save. Existing task reminder policy and device notification settings apply.
- Code: `packages/core/src/quick-add.ts`, `packages/core/src/quick-add-preview.ts`, `packages/core/src/capture.ts`
- Checks: `packages/core/src/quick-add-reminders.test.ts`, `packages/core/src/task-reminder-policy.test.ts`, `packages/core/src/native-host-contract-prepared-capture.test.ts`, `packages/core/src/native-host-contract-prepared-lines.test.ts`, `apps/mobile/components/quick-capture-sheet.save.test.tsx`
