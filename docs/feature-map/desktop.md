# Desktop feature map

Source: `apps/desktop/src` (Tauri + React). Labels come from `packages/core/src/i18n/locales/en.ts`.

## Launch for testing

- **Web build (what Playwright uses):** run `bun desktop:web` from the repo root. It starts Vite on `http://localhost:5173` (strict port).
- **Playwright:** run `bun run test:e2e`. `playwright.config.ts` starts `bun desktop:web` itself and reuses a running server outside CI.
- **Native app:** run `bun desktop:dev` (runs `bunx tauri dev`). Tray, global shortcut, app lock, file sync, Local API, and the MCP server work only here.
- **Desktop unit tests:** run `bun --cwd apps/desktop test` (Vitest).
- **Open a view directly:** add `?view=<id>` to the URL, for example `/?view=inbox`. Ids: `agenda` (Focus), `inbox`, `next`, `projects`, `someday`, `waiting`, `reference`, `calendar`, `review`, `contexts`, `board`, `timeline`, `history`, `done`, `archived`, `trash`, `settings`, `obsidian`, `savedSearch:<id>`.
- **Skip onboarding:** set localStorage `mindwtr:desktop:first-run-onboarding:v1` to `dismissed` before load.
- **Seed data:** write a JSON snapshot to localStorage `mindwtr-data` before load. `e2e/seed.ts` has `seedAppData`, `dismissOnboarding`, and `seedTheme`.
- **Stable attributes:** desktop has few `data-testid` values. Specs also use `[data-sidebar-item][data-view="<id>"]`, `[data-task-id="<id>"]`, `[data-project-navigation-item][data-project-id="<id>"]`, `[data-settings-key="<key>"]`, `[data-main-content]`, and `[data-sandbox-banner]`.
- **Keybinding style:** the default style is Vim. Settings › Advanced › Keyboard and window switches it to Standard or Emacs.

## Sidebar navigation

- Reach: Sidebar sections Focus (Focus, Inbox), Lists (Projects, Someday/Maybe, Waiting For), Organize (Calendar, Review, Contexts), More (Reference, Obsidian, Board View, Timeline, History, Trash). Settings sits at the bottom.
- Shortcuts: Vim and Standard: `g` then `f` Focus, `i` Inbox, `n` Next Actions, `p` Projects, `c` Contexts, `r` Review, `w` Waiting For, `s` Someday/Maybe, `e` Reference, `l` Calendar, `b` Board View, `t` Timeline, `d` Done, `a` Archived, `T` Trash. Emacs: `Alt+I`, `Alt+N`, `Alt+A` (Focus), `Alt+P`, `Alt+C`, `Alt+R`, `Alt+W`, `Alt+S`, `Alt+E`, `Alt+L`, `Alt+B`, `Alt+T`, `Alt+D`, `Alt+Shift+A`, `Alt+Shift+T`. All styles: `Ctrl+B` or `Ctrl+\` toggles the sidebar (`Cmd` on macOS). `Ctrl+Shift+\` toggles focus mode. `F11` toggles full screen (native app only).
- Code: `apps/desktop/src/components/Layout.tsx`, `apps/desktop/src/App.tsx`, `apps/desktop/src/contexts/keybinding-context.tsx`
- Checks: `e2e/app.spec.ts`, `e2e/navigation-submenus.spec.ts`, `e2e/keyboard-ui-compat.spec.ts`, `apps/desktop/src/components/Layout.test.tsx`, `apps/desktop/src/App.navigation-layout.test.tsx`
- Notes: Next Actions has no sidebar item; reach it with `gn`, `Alt+N`, or `/?view=next`. Obsidian appears only after a vault is set up, and Timeline only after the Timeline feature is on. Settings › General › Look & Feel › Sidebar views can hide items.

## Focus

- Reach: Sidebar › Focus. This is the default view at launch. Sections: Today's Focus, Due Today, Review Due, Next Actions, Upcoming. Select › choose tasks › Bulk organize opens the shared organizer.
- Shortcuts: `gf` (Vim, Standard), `Alt+A` (Emacs). Standard style: `S` adds the selected task to Today's Focus.
- Selectors: `todays-focus-section`, `focus-hidden-by-area`
- Code: `apps/desktop/src/components/views/AgendaView.tsx`, `apps/desktop/src/components/views/agenda/AgendaHeader.tsx`, `apps/desktop/src/components/views/agenda/AgendaSections.tsx`, `apps/desktop/src/components/views/agenda/AgendaFiltersPanel.tsx`, `apps/desktop/src/components/views/agenda/SortableFocusRow.tsx`, `apps/desktop/src/components/FocusStarIcon.tsx`
- Checks: `e2e/app.spec.ts`, `e2e/compact-filters.spec.ts`, `e2e/focus-area-selection.spec.ts`, `e2e/focus-bulk-selection.spec.ts`, `e2e/saved-focus-filter-toggle.spec.ts`, `e2e/desktop-direct-controls.spec.ts`, `apps/desktop/src/components/views/AgendaView.test.tsx`, `apps/desktop/src/components/views/AgendaView.selection.test.tsx`, `apps/desktop/src/components/views/agenda/AgendaHeader.test.tsx`, `apps/desktop/src/components/FocusStarIcon.test.tsx`
- Notes: The star is the Focus star. Starring an Inbox task clarifies it to next; adding a star obeys the focus cap. An area filter hides Focus rows but they still use focus slots. Select All includes actual tasks in expanded filtered sections and groups, including offscreen rows, once per task ID. Folded sections, folded groups and project review cards are excluded. Selection mode disables task dragging and row quick actions; completing a selected sequential action leaves its newly exposed successor unchanged.
- Notes: Focus task dates show Today, Tomorrow, or a full localized weekday for the next six days, with explicit times retained. Start uses an arrow and Due a calendar; accessible labels retain the field and exact date. Past dates and dates at least seven days away stay exact. Labels refresh at local midnight and when the app returns to the foreground.

## Pomodoro timer

- Reach: Settings › GTD › Features › Pomodoro timer (turn on). Then Sidebar › Focus shows the timer panel.
- Code: `apps/desktop/src/components/views/PomodoroPanel.tsx`, `apps/desktop/src/components/views/PomodoroTaskPicker.tsx`, `apps/desktop/src/hooks/usePomodoroAlerts.ts`
- Checks: `apps/desktop/src/components/views/PomodoroPanel.test.tsx`, `apps/desktop/src/hooks/usePomodoroAlerts.test.tsx`
- Notes: The feature is off by default. Seed `settings.features.pomodoro = true` to test it.

## Inbox

- Reach: Sidebar › Inbox. The badge shows the Inbox count. The list has an "Add Task..." input at the top.
- Shortcuts: `gi` (Vim, Standard), `Alt+I` (Emacs). `a` or `Insert` focuses the add-task input.
- Selectors: `virtualized-task-list`
- Code: `apps/desktop/src/components/views/ListView.tsx`, `apps/desktop/src/components/views/list/ListQuickAdd.tsx`, `apps/desktop/src/components/views/list/ListHeader.tsx`, `apps/desktop/src/components/views/list/GroupedTaskSections.tsx`
- Checks: `e2e/app.spec.ts`, `e2e/unified-inbox.spec.ts`, `apps/desktop/src/components/views/ListView.test.tsx`
- Notes: The list, counts, and processing queue ignore the global area filter. `virtualized-task-list` exists only when a long list switches to windowed rendering.

## Quick Add

- Reach: Sidebar › Add Task. Also any view's add button, the tray menu › Quick Add, and the global shortcut.
- Shortcuts: `a` or `Insert` opens Quick Add when the view has no add-task input. In the dialog: `Enter` saves, `Shift+Enter` saves and keeps the dialog open, `Ctrl+Enter` (`Cmd+Enter` on macOS) is Save & edit, `Esc` closes, `Ctrl+V` (`⌘V`) pastes images.
- Selectors: `quick-add-preview`
- Code: `apps/desktop/src/components/QuickAddModal.tsx`, `apps/desktop/src/components/QuickAddPreview.tsx`, `apps/desktop/src/components/ui/QuickAddSyntaxHint.tsx`, `apps/desktop/src/components/QuickDateChips.tsx`
- Checks: `e2e/unified-inbox.spec.ts`, `e2e/clarify.spec.ts`, `apps/desktop/src/components/QuickAddModal.test.tsx`, `apps/desktop/src/components/QuickAddModal.preview.test.tsx`, `apps/desktop/src/components/QuickAddModal.paste-hint.test.tsx`, `apps/desktop/src/components/QuickAddPreview.test.tsx`
- Notes: Quick Add is a Capture. A `+Project` that names only an archived project creates a new project. Syntax: `/due:`, `/start:`, `/review:`, `/note:`, `/link:`, `@context`, `#tag`, `+Project`, `!Area`, `%Person`, `/*` (Focus star). The "Quick voice capture" button records audio.

## Global quick add and tray

- Appearance: macOS uses a transparent monochrome template menu bar icon that follows the system menu bar appearance. Other desktop platforms retain the colored tray icon.
- Reach: Tray icon menu › Quick Add, Show Mindwtr, Lock Mindwtr (only when app lock is on), Quit. Settings › General › Input › Global quick add shortcut. Settings › Advanced › Keyboard and window › Show system tray icon.
- Shortcuts: Default `Ctrl+Alt+M` (Linux), `Ctrl+Option+M` (macOS). Other choices: `Ctrl+Alt+N`, `Ctrl+Alt+Q`, and legacy `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS).
- Code: `apps/desktop/src/lib/global-quick-add-shortcut.ts`, `apps/desktop/src/QuickAddWindowApp.tsx`, `apps/desktop/src/lib/quick-add-window.ts`, `apps/desktop/src/lib/desktop-shell-sync.ts`, `apps/desktop/src-tauri/src/ui.rs`
- Checks: `apps/desktop/src/components/views/settings/SettingsMainPage.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsMainPage.test.tsx`
- Notes: The default is off on Windows and in Flatpak. The native shortcut opens a separate window (`?quickAddWindow=1`) that has no Save & edit. In the web build the same key combo works only while the page has focus.

## Inbox processing

- Reach: Sidebar › Inbox › Process Inbox (n). Modes: Guided and Quick. Settings › GTD › Inbox processing sets the default mode and steps.
- Code: `apps/desktop/src/components/views/InboxProcessor.tsx`, `apps/desktop/src/components/InboxProcessingWizard.tsx`, `apps/desktop/src/components/InboxProcessingQuickPanel.tsx`, `apps/desktop/src/components/InboxProcessingScheduleFields.tsx`, `apps/desktop/src/components/InboxProcessingSectionField.tsx`, `apps/desktop/src/components/InboxProcessingLinks.tsx`, `apps/desktop/src/components/InboxSimilarTasks.tsx`, `apps/desktop/src/components/InboxNextActionDrafts.tsx`, `apps/desktop/src/components/views/inbox/useInboxProcessingController.ts`
- Checks: `e2e/clarify.spec.ts`, `e2e/inbox-similarity.spec.ts`, `e2e/onboarding.spec.ts`, `apps/desktop/src/components/views/InboxProcessor.test.tsx`, `apps/desktop/src/components/InboxProcessingPanels.test.tsx`, `apps/desktop/src/components/InboxProcessingScheduleFields.test.tsx`, `apps/desktop/src/components/views/inbox/useInboxProcessingController.test.tsx`
- Notes: The queue ignores the area filter, like the Inbox list. Similar-task matches are offline title matches and never change existing tasks.

## Mind Sweep

- Reach: Sidebar › Inbox › Mind Sweep (next to Process Inbox, or the main button of an empty Inbox). Weekly Review also offers it.
- Code: `apps/desktop/src/components/MindSweepModal.tsx`
- Checks: `apps/desktop/src/components/MindSweepModal.test.tsx`
- Notes: Each line written becomes a new Inbox task.

## Next Actions

- Notes: The full Next Actions inventory has no task-count warning. Today’s Focus remains a separate shortlist.

- Reach: No sidebar item. Use `gn` (Vim, Standard), `Alt+N` (Emacs), or `/?view=next`.
- Code: `apps/desktop/src/components/views/ListView.tsx`, `apps/desktop/src/components/views/list/next-grouping.ts`
- Checks: `e2e/ui-simplification.spec.ts`, `e2e/task-menu-dates.spec.ts`, `apps/desktop/src/components/views/ListView.test.tsx`

## Projects

- Reach: Sidebar › Projects. The projects panel has New project, Active Projects, Someday / Waiting, and Closed groups, plus a Tag filter. Select a project to open its workspace (Project Notes, Add Section, Add Task, Columns layout, Complete, Duplicate, Cancel project, Convert to section…).
- Shortcuts: `gp` (Vim, Standard), `Alt+P` (Emacs). `j`/`k` move through the project list when it has focus.
- Code: `apps/desktop/src/components/views/ProjectsView.tsx`, `apps/desktop/src/components/views/projects/ProjectsSidebar.tsx`, `apps/desktop/src/components/views/projects/ProjectWorkspace.tsx`, `apps/desktop/src/components/views/projects/ProjectDetailsHeader.tsx`, `apps/desktop/src/components/views/projects/ProjectDetailsFields.tsx`, `apps/desktop/src/components/views/projects/ProjectNotesSection.tsx`, `apps/desktop/src/components/views/projects/ProjectToSectionDialog.tsx`, `apps/desktop/src/components/GettingStartedActions.tsx`
- Checks: `e2e/navigation-submenus.spec.ts`, `e2e/projects-calm.spec.ts`, `e2e/projects-keyboard.spec.ts`, `e2e/archived-project-reopen.spec.ts`, `e2e/project-color-override.spec.ts`, `apps/desktop/src/components/views/ProjectsView.test.tsx`, `apps/desktop/src/components/views/projects/ProjectsSidebar.test.tsx`, `apps/desktop/src/components/views/projects/ProjectWorkspace.columns.test.tsx`, `apps/desktop/src/components/views/projects/ProjectDetailsHeader.test.tsx`, `apps/desktop/src/components/views/projects/ProjectNotesSection.test.tsx`
- Notes: Wide windows show a separate projects pane beside global navigation. Its collapse/expand buttons preserve selection; drag its vertical divider to resize (width is remembered). Narrow workspaces use an overlay navigator. Projects without active tasks show a compact, left-aligned placeholder that remains a task drop target. A Deferred project still accepts tasks; an Archived project accepts none. Completing one task in an archived project reopens the project and its section.

## Project sections

- Reach: Sidebar › Projects › (project) › Add Section. Each section heading has a menu with move and reorder actions.
- Code: `apps/desktop/src/components/views/projects/ProjectSectionActionsMenu.tsx`, `apps/desktop/src/components/views/projects/section-dnd.tsx`, `apps/desktop/src/components/views/projects/SortableRows.tsx`, `apps/desktop/src/components/ui/SectionSelector.tsx`
- Checks: `apps/desktop/src/components/views/projects/ProjectSectionActionsMenu.test.tsx`, `apps/desktop/src/components/views/projects/useProjectSectionActions.test.tsx`, `apps/desktop/src/components/views/projects/SortableRows.test.tsx`, `apps/desktop/src/components/ui/SectionSelector.test.tsx`
- Notes: A task moved into a project from elsewhere lands at the end of the Unsectioned group.

## Areas and the area filter

- Reach: Sidebar › Area filter (All areas, each area, No area). Areas are managed in Sidebar › Projects › (project) › Manage areas, and in Settings › Manage › Areas.
- Shortcuts: `1`–`9` select area 1–9, `0` clears the filter. `Shift+A` then a digit does the same.
- Selectors: `area-color-picker-root`, `area-color-picker-menu`, `area-color-picker-panel`, `area-color-picker-surface`, `area-color-picker-hue`, `area-color-picker-preview`, `area-color-picker-custom`
- Code: `apps/desktop/src/components/ui/SidebarAreaFilter.tsx`, `apps/desktop/src/components/views/projects/AreaManagerModal.tsx`, `apps/desktop/src/components/views/projects/AreaColorPicker.tsx`, `apps/desktop/src/components/ui/AreaSelector.tsx`
- Checks: `e2e/focus-area-selection.spec.ts`, `e2e/unified-inbox.spec.ts`, `e2e/project-color-override.spec.ts`, `apps/desktop/src/components/ui/SidebarAreaFilter.test.tsx`, `apps/desktop/src/components/views/projects/AreaManagerModal.test.tsx`, `apps/desktop/src/components/views/projects/AreaColorPicker.test.tsx`
- Notes: The filter can include and exclude areas without closing between changes. Its compact summary shows the first area and remaining count for each scope; hover or focus exposes the full selection. The adjacent All areas reset clears both scopes. A task in an area with no project is an Area task.

## Someday/Maybe

- Reach: Sidebar › Someday/Maybe. Someday sections group the list; manage them in Settings › Manage › Someday sections.
- Shortcuts: `gs` (Vim, Standard), `Alt+S` (Emacs).
- Code: `apps/desktop/src/components/views/ListView.tsx`, `apps/desktop/src/components/views/list/SomedaySectionMoveDialog.tsx`, `apps/desktop/src/components/ui/SomedaySectionSelector.tsx`, `apps/desktop/src/lib/someday-section-actions.ts`
- Checks: `e2e/someday-sections.spec.ts`, `e2e/list-density-layout.spec.ts`, `apps/desktop/src/components/views/ListView.someday-sections.test.tsx`, `apps/desktop/src/components/views/list/SomedaySectionMoveDialog.test.tsx`

## Waiting For

- Reach: Sidebar › Waiting For.
- Shortcuts: `gw` (Vim, Standard), `Alt+W` (Emacs).
- Code: `apps/desktop/src/components/views/ListView.tsx`
- Checks: `apps/desktop/src/components/views/ListView.test.tsx`
- Notes: Starring a review-due waiting task keeps it waiting.

## Reference

- Reach: Sidebar › More › Reference.
- Shortcuts: `ge` (Vim, Standard), `Alt+E` (Emacs).
- Code: `apps/desktop/src/components/views/ListView.tsx`
- Checks: `e2e/reference.spec.ts`
- Notes: Search matches title and notes with all terms. A reference task has a secondary Convert to action button.

## Contexts

- Reach: Sidebar › Contexts. Wide workspaces show a separate collapsible contexts pane beside global navigation; use Collapse contexts panel / Expand contexts panel to hide or restore it. Narrow workspaces use the context selector above tasks. One view covers both @contexts and #tags. Context match and Tag match switch between All and Any.
- Shortcuts: `gc` (Vim, Standard), `Alt+C` (Emacs).
- Code: `apps/desktop/src/components/views/ContextsView.tsx`, `apps/desktop/src/lib/contexts-view-state.ts`
- Checks: `e2e/navigation-submenus.spec.ts`, `e2e/contexts-match-mode.spec.ts`, `e2e/saved-taxonomy.spec.ts`, `apps/desktop/src/components/views/ContextsView.test.tsx`
- Notes: Dropping a dragged task on a context assigns that context and offers undo.

## Calendar

- Reach: Sidebar › Calendar. Modes: Month, Week, Day, and Schedule. Completed shows done and archived tasks on their completion day.
- Shortcuts: `gl` (Vim, Standard), `Alt+L` (Emacs).
- Code: `apps/desktop/src/components/views/CalendarView.tsx`, `apps/desktop/src/components/views/calendar/CalendarDeadlineLane.tsx`, `apps/desktop/src/components/views/calendar/CalendarModals.tsx`, `apps/desktop/src/components/views/calendar/CalendarPlanningPanel.tsx`, `apps/desktop/src/components/views/calendar/CalendarSelectedDayPanel.tsx`
- Checks: `e2e/calendar-timed-deadlines.spec.ts`, `apps/desktop/src/components/views/CalendarView.test.tsx`, `apps/desktop/src/components/views/calendar/CalendarModals.test.tsx`, `apps/desktop/src/components/views/calendar/CalendarPlanningPanel.test.tsx`
- Notes: Timed deadlines show in a separate deadline lane, not as work blocks. External calendar events come from Settings › Integrations.

## Board View

- Reach: Sidebar › More › Board View. Columns: Inbox, Next Actions, Waiting For, Someday/Maybe, Completed.
- Shortcuts: `gb` (Vim, Standard), `Alt+B` (Emacs).
- Code: `apps/desktop/src/components/views/BoardView.tsx`, `apps/desktop/src/components/views/board/BoardFiltersPanel.tsx`
- Checks: `apps/desktop/src/components/views/BoardView.test.tsx`
- Notes: Dragging a card to another column changes its status.

## Timeline

- Reach: Settings › GTD › Features › Timeline view (turn on). Then Sidebar › More › Timeline. Zoom: Day, Week, Month.
- Shortcuts: `gt` (Vim, Standard), `Alt+T` (Emacs). On a reorder handle: `Space` picks up, `Up`/`Down` move, `Space` drops, `Esc` cancels.
- Selectors: `timeline-scroller`, `timeline-group`, `timeline-group-separator`, `timeline-row-label`, `timeline-bar`, `timeline-project-bar`, `timeline-move-${target.kind}`, `timeline-resize-${edge}`, `timeline-reorder-${target.kind}`, `timeline-date-preview`, `timeline-today-line`, `timeline-axis-major`, `timeline-axis-minor`, `timeline-gridline-minor`, `timeline-omitted-notice`
- Code: `apps/desktop/src/components/views/TimelineView.tsx`, `apps/desktop/src/components/views/timeline/TimelineOrderRow.tsx`, `apps/desktop/src/lib/timeline-date-edit.ts`, `apps/desktop/src/lib/timeline-order.ts`
- Checks: `e2e/timeline-editing.spec.ts`, `e2e/timeline-ordering.spec.ts`, `apps/desktop/src/components/views/TimelineView.test.tsx`, `apps/desktop/src/components/views/TimelineView.date-edit.test.tsx`
- Notes: The feature is off by default; seed `settings.features.timeline = true`. `target.kind` is `task` or `project`; `edge` is the bar end being resized. Date drags preview beside the title without moving the table and save only on confirm. Mouse row handles appear on hover or keyboard focus and stay visible while reordering; touch handles stay visible. Cross-section drops are refused.

## History

- Reach: Sidebar › More › History. Tabs: Done and Archived. Archived has Tasks and Projects segments.
- Shortcuts: `gd` Done, `ga` Archived (Vim, Standard). `Alt+D`, `Alt+Shift+A` (Emacs). `Left`/`Right`/`Home`/`End` switch tabs.
- Code: `apps/desktop/src/components/views/HistoryView.tsx`, `apps/desktop/src/components/views/ArchiveView.tsx`
- Checks: `e2e/ui-simplification.spec.ts`, `apps/desktop/src/components/views/ArchiveView.test.tsx`
- Notes: The old `done` and `archived` view ids open the matching History tab. A cancelled task is restored from Archived.

## Trash

- Reach: Sidebar › More › Trash. Actions: Restore, Restore project, Delete Permanently, Clear Trash.
- Shortcuts: `gT` (Vim, Standard), `Alt+Shift+T` (Emacs).
- Code: `apps/desktop/src/components/views/TrashView.tsx`
- Checks: `e2e/app.spec.ts`, `apps/desktop/src/components/views/TrashView.test.tsx`
- Notes: Trash selects tasks and projects together, so it stays outside the shared Bulk selection rules.

## Obsidian Tasks

- Reach: Settings › Integrations › Obsidian vault import (choose a vault). Then Sidebar › More › Obsidian. Rows offer Bring into Mindwtr.
- Code: `apps/desktop/src/components/views/ObsidianView.tsx`, `apps/desktop/src/components/views/settings/SettingsObsidianSection.tsx`, `apps/desktop/src/lib/obsidian-service.ts`
- Checks: `apps/desktop/src/components/views/ObsidianView.test.tsx`, `apps/desktop/src/components/views/settings/SettingsObsidianSection.test.tsx`
- Notes: Opening `obsidian` with no vault set redirects to Settings.

## Global search and saved searches

- Reach: Sidebar › Search. Results cover tasks, projects, and people. Save Search adds an entry under Sidebar › Saved Searches.
- Shortcuts: `Ctrl+K` (`⌘K` on macOS) toggles search in every style. Also `/` (Vim, Standard) and `Ctrl+S` (Emacs). `Up`/`Down`/`Enter` pick a result.
- Selectors: `virtualized-task-list`
- Code: `apps/desktop/src/components/GlobalSearch.tsx`, `apps/desktop/src/components/views/SearchView.tsx`
- Checks: `e2e/global-search-highlights.spec.ts`, `apps/desktop/src/components/GlobalSearch.test.tsx`, `apps/desktop/src/components/views/SearchView.test.tsx`, `apps/desktop/src/App.search-highlight.test.tsx`
- Notes: Opening a result outside the current area filter switches the filter to All areas. The query accepts operators such as `status:`, `context:`, `tag:`, `project:`, and `due:<=7d`.

## Filters and saved filters

- Reach: Any task list › Filters (Contexts & tags, Projects, Priority, Time estimate, Task dates). Sort and Group sit beside it. Focus and Contexts offer Save filter.
- Code: `apps/desktop/src/components/views/list/ListFiltersPanel.tsx`, `apps/desktop/src/components/views/list/FilterDisclosure.tsx`, `apps/desktop/src/components/views/list/active-filter-chips.ts`, `apps/desktop/src/components/views/list/ViewControls.tsx`, `apps/desktop/src/components/views/list/GroupBySelect.tsx`, `apps/desktop/src/components/views/list/list-toolbar.tsx`, `apps/desktop/src/components/views/list/ToolbarSelect.tsx`
- Checks: `e2e/compact-filters.spec.ts`, `e2e/saved-focus-filter-toggle.spec.ts`, `e2e/ui-simplification.spec.ts`, `e2e/keyboard-ui-compat.spec.ts`, `apps/desktop/src/components/views/list/ListFiltersPanel.test.tsx`, `apps/desktop/src/components/views/list/FilterDisclosure.test.tsx`, `apps/desktop/src/components/views/list/ToolbarSelect.test.tsx`
- Notes: Sort and Group keep visible sentence-case labels and aligned icons in compact controls; long values truncate with the full value on hover. A chip for a value the view does not apply is muted and does not count as filtering. `Esc` in a view's search input returns focus to the list.

## List presentation

- Reach: Any task list › Show details / Hide details. Settings › General › Look & Feel › Density.
- Shortcuts: `Ctrl+Shift+D` toggles details, `Ctrl+Shift+C` toggles density (`Cmd` on macOS).
- Code: `apps/desktop/src/components/views/list/ViewHeaderActions.tsx`, `apps/desktop/src/lib/density.ts`
- Checks: `e2e/desktop-direct-controls.spec.ts`, `e2e/list-density-layout.spec.ts`, `apps/desktop/src/components/views/list/ViewHeaderActions.test.tsx`

## Task list keyboard

- Reach: Any task list.
- Shortcuts: All styles: `j`/`k` or arrows move, `gg`/`G` first and last, `Enter` expands the selected task, `.` opens the task menu, `s` then `i`/`n`/`w`/`s`/`d`/`a` sets status, `Ctrl+C` copies the title, `Ctrl+Click`/`Shift+Click` selects. Vim: `e` edit, `x` toggle done, `dd` delete, `yy` copy title, `yi` copy with description. Standard: `Shift+Enter` edit, `e` toggle done, `x` select, `F2` rename, `#` delete, `z` undo. Emacs: `Ctrl+N`/`Ctrl+P` move, `Ctrl+E` edit, `Ctrl+T` toggle done, `Ctrl+D` delete, `Ctrl+.` task menu.
- Code: `apps/desktop/src/contexts/keybinding-context.tsx`, `apps/desktop/src/components/views/list/task-list-scope.ts`
- Checks: `e2e/keyboard-ui-compat.spec.ts`, `e2e/task-copy-title.spec.ts`, `apps/desktop/src/contexts/keybinding-context.test.tsx`, `apps/desktop/src/contexts/keybinding-copy.test.tsx`, `apps/desktop/src/components/views/list/task-list-scope.test.tsx`
- Notes: Keys are ignored while an editor, menu, listbox, or modal owns focus. Toggling done on a done task moves it to Inbox.

## Keyboard shortcuts help

- Reach: Settings › Advanced › Keyboard and window › Keyboard Shortcuts.
- Shortcuts: `?` (Vim, Standard), `Ctrl+H` or `Ctrl+?` (Emacs). `Ctrl+,` (`Cmd+,`) opens Settings.
- Code: `apps/desktop/src/components/KeybindingHelpModal.tsx`
- Checks: `e2e/ui-simplification.spec.ts`, `apps/desktop/src/components/KeybindingHelpModal.test.tsx`
- Notes: The modal lists only shortcuts for the current Keybinding Style.

## Task editor

- Reach: Double-click a task row. Sections: Details, Scheduling, Organization. Fields include Description, checklist, attachments, and recurrence. Settings › GTD › Task editor layout › Editor opening picks In-row or Pop-up.
- Shortcuts: `e` (Vim), `Shift+Enter` (Standard), `Ctrl+E` (Emacs). `Ctrl+Enter` (`Cmd+Enter`) saves. `Esc` cancels.
- Code: `apps/desktop/src/components/TaskItem.tsx`, `apps/desktop/src/components/Task/TaskItemEditor.tsx`, `apps/desktop/src/components/Task/TaskItemEditorSurface.tsx`, `apps/desktop/src/components/Task/TaskEditorSection.tsx`, `apps/desktop/src/components/Task/TaskItemFieldRenderer.tsx`, `apps/desktop/src/components/Task/fields/TaskMetadataFields.tsx`, `apps/desktop/src/components/Task/fields/DescriptionField.tsx`, `apps/desktop/src/components/Task/fields/RecurrenceField.tsx`, `apps/desktop/src/components/Task/TaskForm/ChecklistField.tsx`, `apps/desktop/src/components/Task/TaskForm/AttachmentsField.tsx`, `apps/desktop/src/components/Task/TaskItemRecurrenceModal.tsx`
- Checks: `e2e/task-editor-sections.spec.ts`, `e2e/advance-reminder.spec.ts`, `e2e/time-input-format.spec.ts`, `e2e/saved-taxonomy.spec.ts`, `apps/desktop/src/components/Task/TaskItemEditor.test.tsx`, `apps/desktop/src/components/Task/TaskItemFieldRenderer.test.tsx`, `apps/desktop/src/components/Task/TaskEditorSection.test.tsx`, `apps/desktop/src/components/Task/useTaskItemSubmit.test.tsx`, `apps/desktop/src/components/Task/TaskForm/ChecklistField.test.tsx`, `apps/desktop/src/components/Task/TaskForm/AttachmentsField.test.tsx`, `apps/desktop/src/components/Task/TaskItemRecurrenceModal.test.tsx`
- Notes: Edits live in the Task draft until Save. The default presentation is In-row. Sending a draft back to Inbox drops its Focus star.

## Task menu

- Copy task details copies the title, project name, start/due values, description and checklist as plain text. Copy Title and copy shortcuts retain their existing behavior.

- Reach: Right-click a task row, or its more-options button. Items include Move to…, Dates…, Contexts…, Copy Title, Copy task details, Copy Mindwtr link, Copy task ID, Rename task, Add to checklist…, Create project from task, Convert to Section, Cancel task.
- Shortcuts: `.` (Vim, Standard), `Ctrl+.` (Emacs). `F2` renames (Standard).
- Code: `apps/desktop/src/components/Task/TaskQuickActionMenu.tsx`, `apps/desktop/src/components/Task/useTaskQuickActionMenuProps.ts`, `apps/desktop/src/lib/task-clipboard.ts`, `apps/desktop/src/components/ui/DestinationSelector.tsx`, `apps/desktop/src/components/TaskProjectConversionDialog.tsx`
- Checks: `e2e/task-menu-dates.spec.ts`, `e2e/task-menu-contexts.spec.ts`, `e2e/task-menu-project-create.spec.ts`, `e2e/task-copy-title.spec.ts`, `e2e/ui-simplification.spec.ts`, `apps/desktop/src/components/Task/TaskQuickActionMenu.test.tsx`, `apps/desktop/src/components/Task/useTaskQuickActionMenuProps.test.tsx`, `apps/desktop/src/lib/task-clipboard.test.ts`, `apps/desktop/src/components/ui/DestinationSelector.test.tsx`
- Notes: Move to… changes only the Container, never status or dates. Menu edits wait for Save; a project created there is not assigned until Save.

## Bulk selection

- Bulk organize status includes Inbox for returning tasks to processing; existing project, notes, tags and dates stay unchanged unless explicitly edited.

- Reach: Any task list, including Focus, › Select. Available toolbar actions include Select All, Add context, Remove context, Add tag, Remove tag, Bulk organize, Export selected tasks as CSV, and Delete. Focus uses the Review bulk actions; the organizer includes contexts. Done leaves the mode.
- Shortcuts: `Ctrl+Click` (`Cmd+Click`) or `Shift+Click` a row. `x` toggles selection (Standard).
- Code: `apps/desktop/src/components/views/list/BulkSelectionToolbar.tsx`, `apps/desktop/src/components/views/list/ListBulkActions.tsx`, `apps/desktop/src/components/views/list/TaskBulkOrganizeModal.tsx`, `apps/desktop/src/components/views/review/ReviewBulkActions.tsx`, `apps/desktop/src/components/TokenPickerModal.tsx`
- Checks: `e2e/reference.spec.ts`, `apps/desktop/src/components/views/list/ListBulkActions.test.tsx`, `apps/desktop/src/components/views/list/TaskBulkOrganizeModal.test.tsx`, `apps/desktop/src/components/views/list/useTaskSelection.test.tsx`, `apps/desktop/src/components/views/list/useSelectedTasksCsvExport.test.tsx`, `apps/desktop/src/components/views/projects/ProjectWorkspace.selection.test.tsx`, `apps/desktop/src/components/views/review/ReviewBulkActions.test.tsx`
- Notes: Destructive bulk actions confirm first. Bulk deletes offer undo, and a store rejection shows an error, never a false success.

## Drag and drop

- Reach: Drag a task row onto a sidebar item (Inbox, Someday/Maybe, Waiting For, Reference, History, Calendar), onto a project or area in the projects panel, onto a context, onto a calendar day, onto a Board View column, or within Today's Focus to reorder.
- Code: `apps/desktop/src/components/Layout.tsx`, `apps/desktop/src/lib/calendar-task-drag.ts`, `apps/desktop/src/components/views/projects/projects-view-dnd.ts`, `apps/desktop/src/components/views/projects/project-area-dnd.tsx`, `apps/desktop/src/components/views/projects/section-dnd.tsx`, `apps/desktop/src/components/views/agenda/SortableFocusRow.tsx`, `apps/desktop/src/components/views/BoardView.tsx`
- Checks: `e2e/timeline-ordering.spec.ts`, `apps/desktop/src/components/Layout.test.tsx`, `apps/desktop/src/components/views/ProjectsView.test.tsx`, `apps/desktop/src/components/views/BoardView.test.tsx`, `apps/desktop/src/components/views/ContextsView.test.tsx`
- Notes: Dropping on History marks the task done. Dropping on a project or area is a Move and keeps the status. Rows cannot be dragged while editing, expanded, or in selection mode.

## Undo

- Reach: The toast after a complete, delete, or move shows Undo. Settings › General › Input › Undo notifications.
- Shortcuts: `Ctrl+Z` (`Cmd+Z`) outside text fields. `z` (Standard).
- Code: `apps/desktop/src/components/ToastHost.tsx`, `apps/desktop/src/lib/undo-registry.ts`
- Checks: `e2e/someday-sections.spec.ts`, `apps/desktop/src/components/ToastHost.test.tsx`

## Daily Review

- Reach: Sidebar › Review › Start daily review. Steps include Process Inbox and Today’s Focus.
- Code: `apps/desktop/src/components/views/review/DailyReviewModal.tsx`
- Checks: `e2e/review.spec.ts`, `apps/desktop/src/components/views/review/DailyReviewModal.test.tsx`
- Notes: The focus step obeys the Today's focus limit. Waiting For follows a valid review date, falling back to the task's start date; future dates defer the prompt. Finishing the guide does not mark individual reminders reviewed.

## Weekly Review

- Reach: Sidebar › Review › Start weekly review. Steps: Process Inbox, Stale items, Review Calendar, Waiting For, Contexts (optional), Review Projects, Someday/Maybe, All Done!. All Done! has Share my reflection.
- Shortcuts: `gr` opens Review (Vim, Standard), `Alt+R` (Emacs).
- Code: `apps/desktop/src/components/views/ReviewView.tsx`, `apps/desktop/src/components/views/review/WeeklyReviewModal.tsx`, `apps/desktop/src/components/views/review/ReviewHeader.tsx`, `apps/desktop/src/components/views/review/ReviewTaskList.tsx`, `apps/desktop/src/components/views/review/ReviewFiltersBar.tsx`, `apps/desktop/src/components/ShareCardDialog.tsx`
- Checks: `e2e/review.spec.ts`, `e2e/share-card.spec.ts`, `e2e/person-review.spec.ts`, `apps/desktop/src/components/views/ReviewView.test.tsx`, `apps/desktop/src/components/views/review/WeeklyReviewModal.test.tsx`, `apps/desktop/src/components/ShareCardDialog.test.tsx`
- Notes: Start daily review and Start weekly review are workflow actions in the header, separate from Due for review / All open tasks filters. Both use the toolbar height; Weekly Review remains the primary action. Settings › GTD › Weekly review flow can add a contexts step. Waiting For follows a valid review date, falling back to the task's start date; future dates stay under Not due yet. The share card holds only the date and the user's note, never task data.

## Onboarding

- Reach: First launch shows Welcome to Mindwtr with Start using Mindwtr, Import tasks, Set up sync, and Skip onboarding.
- Code: `apps/desktop/src/components/DesktopOnboardingFlow.tsx`, `apps/desktop/src/components/GettingStartedActions.tsx`, `apps/desktop/src/lib/desktop-onboarding-events.ts`
- Checks: `e2e/onboarding.spec.ts`, `apps/desktop/src/components/DesktopOnboardingFlow.test.tsx`, `apps/desktop/src/components/GettingStartedActions.test.tsx`
- Notes: Start using Mindwtr adds a Getting Started project and two sample Inbox items. Import and sync choices open Settings with a hint and a way back.

## Startup prompts

- Reach: Shown at launch, one at a time: announcement, then update reminder, then donation ask.
- Code: `apps/desktop/src/components/StartupPromptModal.tsx`, `apps/desktop/src/components/AppAnnouncementModal.tsx`, `apps/desktop/src/lib/prompt-test-controls.ts`, `apps/desktop/src/App.tsx`
- Notes: Prompts wait for the shared gate: settings loaded, onboarding settled, no close prompt, no external sync change. They never show in tests or the sandbox. In dev builds, dispatch window event `mindwtr:prompt-test` with `detail.kind` set to `announcement`, `donation`, `update`, or `review` to force one.

## Close window prompt

- Reach: Close the main window. The dialog Close Mindwtr? offers Keep running in tray, Quit the app, and Don't ask again. Settings › Advanced › Keyboard and window › Close window behavior changes it later.
- Code: `apps/desktop/src/components/CloseBehaviorModal.tsx`, `apps/desktop/src/lib/window-behavior.ts`, `apps/desktop/src/lib/close-request-handler.ts`
- Notes: The default is ask, except Flatpak, which defaults to tray. With the tray icon hidden, tray behavior quits instead. Native app only.

## App lock

- Reach: Settings › Advanced › Privacy › App lock. Tray › Lock Mindwtr. The lock screen shows Mindwtr is locked and Unlock.
- Shortcuts: `Ctrl+Shift+L` (`Cmd+Shift+L`) locks when app lock is on.
- Selectors: `app-lock-screen`
- Code: `apps/desktop/src/components/AppLockGate.tsx`, `apps/desktop/src/components/views/settings/AppLockSettingsSection.tsx`, `apps/desktop/src/lib/app-lock.ts`, `apps/desktop/src-tauri/src/app_lock.rs`
- Checks: `apps/desktop/src/components/AppLockGate.test.tsx`, `apps/desktop/src/components/views/settings/AppLockSettingsSection.test.tsx`
- Notes: Supported only on Windows (Windows Hello) and macOS (Touch ID or passcode). The setting is hidden on Linux and in the web build. It protects the view, not the database.

## Sandbox

- Reach: Settings › Data › Open sandbox. A banner shows Sandbox · Sample data with Reset sample data and Exit sandbox.
- Code: `apps/desktop/src/components/sandbox/OpenSandboxSetting.tsx`, `apps/desktop/src/components/sandbox/SandboxBanner.tsx`, `apps/desktop/src/components/views/SandboxSettingsView.tsx`, `apps/desktop/src/lib/sandbox-session.ts`
- Checks: `e2e/sandbox.spec.ts`, `apps/desktop/src/components/sandbox/OpenSandboxSetting.test.tsx`
- Notes: Sandbox edits never touch the personal workspace. Settings shows a reduced page in the sandbox, and the MCP server is unavailable there.

## Workspaces

- Reach: Settings › Data › Workspaces › Add workspace. Sidebar › Workspace switcher.
- Code: `apps/desktop/src/components/views/settings/SettingsWorkspacesSection.tsx`, `apps/desktop/src/components/workspaces/SidebarWorkspaceSwitcher.tsx`, `apps/desktop/src/components/workspaces/use-workspaces.tsx`
- Checks: `apps/desktop/src/components/workspaces/workspaces-ui.test.tsx`
- Notes: iCloud sync is offered only in the default workspace.

## Task links

- Reach: Task menu › Copy Mindwtr link. Opening a `mindwtr://open?task=<id>` link opens that task.
- Code: `apps/desktop/src/hooks/use-task-deep-link.ts`, `apps/desktop/src/lib/task-clipboard.ts`
- Checks: `apps/desktop/src/hooks/use-task-deep-link.test.tsx`

## Save failure banner

- Reach: Appears at the top when a save fails: "Your latest changes could not be saved." with Try again.
- Code: `apps/desktop/src/components/PersistenceFailureBanner.tsx`
- Checks: `apps/desktop/src/components/PersistenceFailureBanner.test.tsx`

## Settings search

- Reach: Sidebar › Settings › Search settings… box at the top of the settings sidebar.
- Shortcuts: `Up`/`Down` move, `Enter` opens the match, `Esc` clears.
- Code: `apps/desktop/src/components/views/SettingsView.tsx`, `apps/desktop/src/components/views/settings/SettingsSidebar.tsx`, `apps/desktop/src/components/views/settings/settings-search.ts`, `packages/core/src/settings-search-keys.ts`
- Checks: `e2e/ai-request-timeout.spec.ts`, `apps/desktop/src/components/views/settings/SettingsSidebar.test.tsx`, `apps/desktop/src/components/views/settings/settings-search.test.tsx`, `apps/desktop/src/components/views/settings/settings-search-coverage.test.tsx`
- Notes: A match opens its page, expands its section, and highlights the row (`data-settings-key`).

## Settings › General

- Reach: Settings › General. Look & Feel (Appearance, Density, Text size, Font, Show task age, Sidebar views), Localization (Language), Regional formats (Week starts on, Date format, Calendar system, Time format), Input (Global quick add shortcut, Undo notifications).
- Notes: E-Ink renders project/area accents, Calendar and Timeline indicators, group dots and review badges in monochrome. Review state labels keep a light fill and dark text. Stored colors and color-picker swatches are unchanged.
- Shortcuts: `Ctrl+=`, `Ctrl+-`, `Ctrl+0` zoom in, out, and reset (`Cmd` on macOS). `Ctrl`+wheel also zooms.
- Code: `apps/desktop/src/components/views/settings/SettingsMainPage.tsx`, `apps/desktop/src/lib/theme.ts`, `apps/desktop/src/lib/webview-zoom.ts`
- Checks: `e2e/a11y.spec.ts`, `e2e/ukrainian.spec.ts`, `e2e/time-input-format.spec.ts`, `apps/desktop/src/components/views/settings/SettingsMainPage.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsMainPage.test.tsx`

## Settings › GTD

- Reach: Settings › GTD. Auto-archive done tasks, Default schedule time, Today's focus limit, Include tasks starting today in Today, Default project flow, Features (Timeline view, Pomodoro timer), Default capture method, Weekly review flow, Inbox processing, Task editor layout.
- Code: `apps/desktop/src/components/views/settings/SettingsGtdPage.tsx`
- Checks: `apps/desktop/src/components/views/settings/SettingsGtdPage.test.tsx`

## Settings › Manage

- Reach: Settings › Manage. Areas, People, Someday sections, Contexts, Tags. Each can be renamed, deleted, or reordered.
- Code: `apps/desktop/src/components/views/settings/SettingsManagePage.tsx`
- Checks: `e2e/person-review.spec.ts`, `e2e/saved-taxonomy.spec.ts`, `apps/desktop/src/components/views/settings/SettingsManagePage.test.tsx`
- Notes: Unused contexts and tags saved here survive reload and appear in the task editor.

## Settings › Notifications

- Reach: Settings › Notifications. Task reminders, Default task reminders, Start date reminders, Due date reminders, Review date reminders, Weekly review (Review day, Review time), Daily digest (Morning briefing, Evening review).
- Code: `apps/desktop/src/components/views/settings/SettingsNotificationsPage.tsx`, `apps/desktop/src/lib/notification-service.tsx`
- Checks: `e2e/advance-reminder.spec.ts`, `apps/desktop/src/components/views/settings/SettingsNotificationsPage.test.tsx`

## Settings › Sync

- Reach: Settings › Sync › Sync backend: Off, Cloud Sync (Dropbox, iCloud), Folder / File Sync (File), Advanced / Custom Server (WebDAV, Self-hosted). Then Encryption, Settings sync options, Background sync, Sync history, Recovery snapshots, and Sync now.
- Shortcuts: `Ctrl+Alt+S` (Linux/Windows), `Cmd+Option+S` (macOS) syncs now.
- Code: `apps/desktop/src/components/views/settings/SettingsSyncPage.tsx`, `apps/desktop/src/components/views/settings/sync/SyncConfigurationSection.tsx`, `apps/desktop/src/components/views/settings/sync/SyncEncryptionSection.tsx`, `apps/desktop/src/components/views/settings/sync/SyncStatusSection.tsx`, `apps/desktop/src/lib/sync-service.ts`
- Checks: `apps/desktop/src/components/views/settings/sync/SyncConfigurationSection.test.tsx`, `apps/desktop/src/components/views/settings/sync/SyncEncryptionSection.test.tsx`, `apps/desktop/src/components/views/settings/sync/SyncStatusSection.test.tsx`
- Notes: iCloud shows only on macOS in the default workspace. A new destination stays off until its probe passes (one Sync run). Encryption covers File, WebDAV, and Dropbox only. Real-backend checks follow the sync-device-testing skill.

## Settings › Data

- Reach: Settings › Data. Open sandbox, Backup (Export Backup, Export CSV, Export as TaskNotes, Restore Backup, Merge Backup), Import Data (Import from Todoist, TickTick, DGT GTD, OmniFocus, Mindwtr CSV), Attachment cleanup, Archive retention, Diagnostics, Workspaces.
- Code: `apps/desktop/src/components/views/settings/SettingsDataPage.tsx`, `apps/desktop/src/components/views/settings/sync/DataTransferSections.tsx`, `apps/desktop/src/components/views/settings/sync/AttachmentsCleanupSection.tsx`, `apps/desktop/src/components/views/settings/ArchiveRetentionSection.tsx`, `apps/desktop/src/lib/data-transfer.ts`
- Checks: `apps/desktop/src/components/views/settings/sync/DataTransferSections.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsDataPage.test.tsx`, `apps/desktop/src/components/views/settings/ArchiveRetentionSection.test.tsx`

## Diagnostics

- Reach: Settings › Data › Diagnostics. Debug logging, Log file, Save log, Clear log, Opt out of diagnostics.
- Code: `apps/desktop/src/components/views/settings/sync/DiagnosticsSection.tsx`, `apps/desktop/src/lib/app-log.ts`
- Checks: `apps/desktop/src/components/views/settings/sync/DiagnosticsSection.test.tsx`
- Notes: Field testers confirm fixes only through this log. A fix on a path the screen cannot show adds a `releaseCheck` log line (AGENTS.md).

## Settings › Integrations

- Reach: Settings › Integrations. External Calendar (ICS URL, Choose local .ics file), System calendar (Push tasks to system calendar), Obsidian vault import, Email capture (IMAP), Gmail, Local MCP server (advanced).
- Code: `apps/desktop/src/components/views/settings/SettingsIntegrationsPage.tsx`, `apps/desktop/src/components/views/settings/SettingsCalendarPage.tsx`, `apps/desktop/src/components/views/settings/SettingsObsidianSection.tsx`, `apps/desktop/src/components/views/settings/SettingsEmailCaptureSection.tsx`, `apps/desktop/src/components/views/settings/SettingsGmailCaptureSection.tsx`
- Checks: `e2e/docs-links.spec.ts`, `apps/desktop/src/components/views/settings/SettingsCalendarPage.test.tsx`, `apps/desktop/src/components/views/settings/useCalendarSettings.test.tsx`, `apps/desktop/src/components/views/settings/SettingsObsidianSection.test.tsx`, `apps/desktop/src/components/views/settings/SettingsGmailCaptureSection.test.tsx`
- Notes: System calendar push is offered on macOS and Linux only. Gmail can be missing from a build.

## Local MCP server

- Reach: Settings › Integrations › Local MCP server (advanced). Enable local MCP server, MCP port, Allow task and project edits, Allow archiving, Allow deletion, Copy connection details, Copy for Codex, Regenerate access token.
- Code: `apps/desktop/src/components/views/settings/SettingsMcpSection.tsx`, `apps/desktop/src/lib/mcp-server.ts`, `apps/desktop/src-tauri/src/mcp_server.rs`, `apps/desktop/src-tauri/src/mcp_tools.rs`
- Checks: `apps/desktop/src/components/views/settings/SettingsMcpSection.test.tsx`
- Notes: Default port is 8722 on 127.0.0.1 with a bearer token. Native app only, outside the sandbox. Regenerating the token revokes every old connection.

## Settings › AI assistant

- Reach: Settings › AI assistant. Enable AI assistant (Provider, Model, API key, Custom OpenAI-compatible base URL, Extra request parameters, Request timeout, Copilot model, Reasoning effort), Speech to text. In the task editor: AI assistant, AI clarify, AI breakdown.
- Code: `apps/desktop/src/components/views/settings/SettingsAiPage.tsx`, `apps/desktop/src/components/Task/TaskEditorAiPanels.tsx`, `apps/desktop/src/lib/ai-config.ts`, `apps/desktop/src/lib/speech-to-text.ts`
- Checks: `e2e/ai-request-timeout.spec.ts`, `apps/desktop/src/components/views/settings/SettingsAiPage.test.tsx`, `apps/desktop/src/components/views/settings/useAiSettings.test.tsx`, `apps/desktop/src/components/Task/useTaskItemAi.copilot.test.tsx`

## Settings › Advanced

- Reach: Settings › Advanced. Keyboard and window (Keybinding Style, Keyboard Shortcuts, Window decorations, Close window behavior, Show system tray icon, Launch at startup), Privacy (App lock), Automation (Local API), Rendering (Use software rendering), Network (Proxy URL).
- Code: `apps/desktop/src/components/views/settings/SettingsAdvancedPage.tsx`, `apps/desktop/src/lib/launch-at-startup.ts`
- Checks: `e2e/ui-simplification.spec.ts`, `apps/desktop/src/components/views/settings/SettingsAdvancedPage.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsAdvancedPage.test.tsx`

## Local API

- Repository helper: `scripts/mindwtr-api.ts` also supports task-list versions, conditional PATCH/complete/archive, durable create receipts and normalized unchanged PATCH. Versions and receipts stay scoped to the issuing server/workspace. Owning helper files: `scripts/mindwtr-automation-core.ts`, `scripts/mindwtr-automation-storage.ts`, `scripts/mindwtr-helper-reliability.ts`; checks: `scripts/mindwtr-api.test.ts`, `scripts/mindwtr-helper-reliability.test.ts`, `scripts/mindwtr-automation-storage.test.ts`. Diagnostic: `v1.3.9/helper-api-reliability` on stderr.

- Reach: Settings › Advanced › Automation › Enable local API server, Port, Bearer token.
- Code: `apps/desktop/src/components/views/settings/SettingsAdvancedPage.tsx`, `apps/desktop/src/lib/local-api-server.ts`, `apps/desktop/src-tauri/src/local_api.rs`
- Checks: `apps/desktop/src/components/views/settings/SettingsAdvancedPage.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsAdvancedPage.test.tsx`
- Notes: Default port is 3456. Native app only. The MCP server calls the same operations.


### Task reliability

- Reach: native app › Settings › Advanced › Local API, or MCP server. Enable edits for writes and use that service's bearer credential.
- Polling and references: task-list GETs support query-scoped strong ETags and `If-None-Match`; unchanged replies are bodyless 304 responses. Poll `?all=1&deleted=1` when the complete retained tombstone snapshot is needed. Reads still load/hash the snapshot. `/sections` (`projectId` optional) and `/people` expose live raw records, or `deleted=1`; native and standalone MCP list tools support these reads with writes disabled. Single section/person lookups and mutations remain unavailable in Local API mode.
- Read: `GET /tasks/:id` returns sibling `version` and a quoted strong `ETag`; REST and MCP task lists return sibling `versions` by task ID without changing task objects. Authenticated `/health` reports `apiVersion: 2` and explicit capabilities. PATCH, complete and archive accept optional `If-Match` (wildcard or comma-separated quoted entity tags; weak tags never match). Built-in MCP update, complete and archive tools accept optional `expectedVersion`. Stale requests return `task_version_conflict` (HTTP 412) without writing.
- Create: `POST /tasks` accepts optional `Idempotency-Key`; built-in MCP `mindwtr_add_task` accepts `idempotencyKey`. Tokens are 1–128 visible ASCII characters. Identical retries return the original result for seven days, including after edits or deletion; changed payloads return `idempotency_conflict`. Receipts are local to the workspace SQLite database and authenticated credential. At 10,000 unexpired receipts, new keyed creates return `idempotency_capacity`; existing receipts still replay. After expiry, reuse can create another task.
- Compatibility: `/v1/tasks` and `/v1/tasks/:id` protect creation/PATCH against older servers. `/v2/tasks/:id/complete` and `/v2/tasks/:id/archive` require `If-Match`; older servers refuse these routes. Standalone MCP uses `/v2` for conditional completion and never falls back to an unconditional write. Omitting protection preserves ordinary writes. A normalized unchanged PATCH preserves revision metadata and skips task writes and snapshot publication.
- Ordinary reopening: `POST /tasks/:id/reopen` accepts optional `{status}` (`inbox`, `next`, `waiting`, `someday`; default `next`) and `If-Match`. It reopens live done/archived tasks, reactivates an archived parent and its eligible archive-owned sections atomically, and keeps finished siblings finished. A retry at the requested active status keeps rows/version unchanged; a different active status conflicts. Terminal tasks with any non-null recurrence metadata return `recurrence_requires_app` without changes. Trash restoration stays separate. Native and Local API standalone `mindwtr_reopen_task` accept optional `expectedVersion`; older servers refuse the new route without fallback.
- Area creation: `POST /areas` accepts `{name,props?:{color?,icon?}}`, with a trimmed name up to 200 UTF-16 units. A live name match returns unchanged with response-only `existing: true`; a deleted match restores its same ID and matching legacy cascade children, keeping independently deleted and detached rows as they are. Fresh creation orders after all retained areas. Native and Local API standalone `mindwtr_add_area` use the same operation. Authenticated health capabilities `ordinaryTaskReopen` and `areaCreate` identify these endpoints.
- Owning files: `apps/desktop/src-tauri/src/local_api.rs`, `apps/desktop/src-tauri/src/storage.rs`, `apps/desktop/src-tauri/src/mcp_tools.rs`, `apps/desktop/src-tauri/src/mcp_server.rs`; standalone adapter `apps/mcp-server/src/local-api-service.ts`.
- Checks: `apps/desktop/src-tauri/src/local_api.rs` (reliability tests), `apps/desktop/src-tauri/src/storage.rs`, `apps/desktop/src-tauri/src/mcp_server.rs`, `apps/mcp-server/src/local-api-service.test.ts`, and `packages/core/src/local-api-lifecycle-parity.test.ts` (shared full-row golden fixtures); run bun run docs:check-feature-map. Diagnostics markers v1.3.8/local-api-reliability and v1.3.9/local-api-conditional-action prove conditional writes, unchanged PATCH, durable replay, or conditional lifecycle persistence. Markers v1.3.9/local-api-task-reopen and v1.3.9/local-api-area-create prove successful lifecycle/area outcomes.

## Settings › About

- Reach: Settings › About. Version, Install Channel, Check for Updates, Send feedback, Documentation, Support development, License. A badge on About marks an available update.
- Code: `apps/desktop/src/components/views/settings/SettingsAboutPage.tsx`, `apps/desktop/src/components/views/settings/SettingsUpdateModal.tsx`, `apps/desktop/src/components/views/settings/SettingsFeedbackModal.tsx`, `apps/desktop/src/lib/update-service.ts`
- Checks: `e2e/docs-links.spec.ts`, `apps/desktop/src/components/views/settings/SettingsUpdateModal.test.tsx`, `apps/desktop/src/components/views/settings/SettingsFeedbackModal.test.tsx`, `apps/desktop/src/components/views/settings/useSettingsAboutPage.test.tsx`
- Notes: Send feedback appears only when the build sets `VITE_FEEDBACK_ENDPOINT_URL`.

## Web offline mode

- Reach: The web build installs a service worker, so it keeps working offline.
- Code: `apps/desktop/src/lib/web-service-worker.ts`, `apps/desktop/src/main.tsx`
- Checks: `e2e/service-worker-online.spec.ts`
- Notes: A worker update never reloads the page or deletes local data.

## Capture reminder syntax (#1545)

- Reach: Quick capture or task capture title, then Save.
- Syntax: `/due:tomorrow 5pm /remind-due:1d` and `/start:tomorrow 9am /remind-start:30m`. Positive leads require the matching explicit date command with an explicit time. Units are integer `m`, `h`, `d`, `w`; due accepts 0–10080 minutes and start accepts only 0/5/15/30/60. `0m` turns the advance reminder off. Invalid tokens remain visible, show a warning and refuse save. Existing task reminder policy and device notification settings apply.
- Code: `packages/core/src/quick-add.ts`, `packages/core/src/quick-add-preview.ts`, `packages/core/src/capture.ts`
- Checks: `packages/core/src/quick-add-reminders.test.ts`, `packages/core/src/task-reminder-policy.test.ts`, `packages/core/src/native-host-contract-prepared-capture.test.ts`, `packages/core/src/native-host-contract-prepared-lines.test.ts`, `apps/mobile/components/quick-capture-sheet.save.test.tsx`
