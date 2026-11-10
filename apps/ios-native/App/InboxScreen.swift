import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

struct NavigationReplayContentEntry: View {
    let model: CoreModel
    let ticket: CoreModel.NavigationReplayTicket
    let uncovered: () -> Bool
    var body: some View {
        Color.clear.frame(width: 1, height: 1).allowsHitTesting(false).accessibilityHidden(true)
            .onAppear { model.navigationReplayContentEntered(ticket, uncovered: uncovered) }
            .onDisappear { model.navigationReplayContentExited(ticket) }
            .id(ticket.id)
    }
}

struct InboxScreen: View {
    @ObservedObject var model: CoreModel
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var inboxBulkDeletePresented = false
    @State private var bottomSafeInset: CGFloat = 0
    private var palette: AppPalette { AppPalette(theme: model.theme, system: systemScheme) }
    private var focusSections: [CoreObject] { model.focus.objects("sections").filter { $0.number("total") > 0 } }
    private var reviewProjects: [CoreObject] { model.focus.objects("reviewProjects") }
    private var otherFocusKeys: Set<String> {
        Set(focusSections.map { $0.text("key") }.filter { ["schedule", "next", "upcoming", "reviewDue"].contains($0) })
            .union(reviewProjects.isEmpty ? [] : ["reviewProjects"])
    }
    private var otherFocusSectionsOpen: Bool { !otherFocusKeys.subtracting(model.collapsedFocusSections).isEmpty }
    private var defaultAreaScope: Bool {
        model.area.objects("options").first(where: { $0.text("id") == "__all__" })?.text("state") == "included"
    }
    private var menuPanelPresented: Bool {
        model.inboxSortPresented || model.contextsSortPresented || model.inboxGroupPresented || model.inboxFiltersPresented || (model.inboxBulkTagPresented || model.inboxBulkRemovePresented || model.inboxBulkOrganizePresented) || model.morePresented || !model.somedayPanel.isEmpty || !model.referencePanel.isEmpty || !model.historyPanel.isEmpty
    }
    private var menuListPrefix: String {
        model.selectedSurface == .savedSearch ? "saved-search" : model.selectedSurface == .contexts ? "contexts" : model.selectedSurface == .trash ? "trash" : model.selectedSurface == .history ? "history" : model.selectedSurface == .reference ? "reference" : model.selectedSurface == .someday ? "someday" : "waiting"
    }

    @ViewBuilder private var rowTaskBackdateRetryBanner: some View {
        if let message = model.rowTaskBackdateRetryError {
            HStack {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button(model.label("common.retry")) { Task { await model.retry() } }
                    .frame(minWidth: 44, minHeight: 44).disabled(model.busy)
                    .accessibilityIdentifier("row-backdate-retry")
            }
            .padding(12).accessibilityIdentifier("row-backdate-retry-error")
        }
    }

    @ViewBuilder private var taskChecklistMoveRetryBanner: some View {
        if let message = model.taskChecklistMoveRetryError {
            HStack {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button(model.label("common.retry")) { Task { await model.retryTaskChecklistMoveUI() } }
                    .frame(minWidth: 44, minHeight: 44).disabled(model.busy)
                    .accessibilityIdentifier("checklist-move-retry")
            }
            .padding(12).accessibilityIdentifier("checklist-move-retry-error")
        }
    }
    @ViewBuilder private var rowTaskDestinationRetryBanner: some View {
        if let message = model.rowTaskDestinationRetryError {
            HStack {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button(model.label("common.retry")) { Task { await model.retryRowTaskDestinationUI() } }
                    .frame(minWidth: 44, minHeight: 44).disabled(model.busy)
                    .accessibilityIdentifier("row-destination-retry")
            }
            .padding(12).accessibilityIdentifier("row-destination-retry-error")
        }
    }
    @ViewBuilder private var rowTaskDatesRetryBanner: some View {
        if let message = model.rowTaskDatesRetryError {
            HStack {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button(model.label("common.retry")) { Task { await model.retryRowTaskDatesUI() } }
                    .frame(minWidth: 44, minHeight: 44).disabled(model.busy)
                    .accessibilityIdentifier("row-dates-retry")
            }
            .padding(12).accessibilityIdentifier("row-dates-retry-error")
        }
    }
    @ViewBuilder private var rowSwipeMutationRetryBanner: some View {
        if let message = model.rowSwipeMutationRetryError {
            HStack {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                Spacer()
                Button(model.label("common.retry")) { Task { await model.retryRowSwipeMutationUI() } }
                    .frame(minWidth: 44, minHeight: 44).disabled(model.busy)
                    .accessibilityIdentifier("row-swipe-retry")
            }
            .padding(12).accessibilityIdentifier("row-swipe-retry-error")
        }
    }
    private var taskRowMutationRetryBanners: some View {
        VStack(spacing: 0) { rowTaskBackdateRetryBanner; taskChecklistMoveRetryBanner; rowTaskDestinationRetryBanner; rowTaskDatesRetryBanner; rowSwipeMutationRetryBanner }
    }

    private var primarySurfaceContent: AnyView {
        AnyView(Group {
            if model.selectedSurface == .search {
                SearchScreen(model: model, palette: palette)
            } else if model.selectedSurface == .project {
                ProjectDetailScreen(model: model, palette: palette)
            } else if model.selectedSurface == .contexts {
                menuListHeader
                ContextsScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) {
                        endContextsInput()
                        if model.quickAccessView != "contexts" { Task { await model.closeContexts() } }
                    }
            } else if model.selectedSurface == .waiting {
                menuListHeader
                WaitingScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeWaiting() } }
            } else if model.selectedSurface == .someday {
                menuListHeader
                SomedayScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeSomeday() } }
            } else if model.selectedSurface == .settings {
                SettingsScreen(model: model, palette: palette)
            } else if model.selectedSurface == .savedSearch {
                menuListHeader
                SavedSearchScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeSavedSearch() } }
            } else if model.selectedSurface == .trash {
                menuListHeader
                TrashScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeTrash() } }
            } else if model.selectedSurface == .history {
                menuListHeader
                HistoryScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeHistory() } }
            } else if model.selectedSurface == .reference {
                menuListHeader
                ReferenceScreen(model: model, palette: palette)
                    .accessibilityAction(.escape) { Task { await model.closeReference() } }
            } else if model.selectedSurface == .focus && model.focusOrderPresented {
                focusOrderContent
            } else {
                header
                if model.ready {
                    if model.selectedSurface == .inbox {
                        AnyView(inboxContent)
                            .onAppear { Task { await model.recordInboxViewBoundaryRendered() } }
                    }
                    else if model.selectedSurface == .review { ReviewScreen(model: model, palette: palette) }
                    else if model.selectedSurface == .calendar { CalendarScreen(model: model, palette: palette) }
                    else if model.selectedSurface == .board { BoardScreen(model: model, palette: palette) }
                    else if model.selectedSurface == .projects { ProjectsScreen(model: model, palette: palette) }
                    else { focusContent }
                } else {
                    Spacer()
                    if model.busy { ProgressView().accessibilityLabel(model.label("common.loading")) }
                    Spacer()
                }
            }
        })
    }

    private var surfaceNotices: AnyView {
        AnyView(Group {
            if !model.referenceProjectNextActionPresented { taskActionNoticeView }
            if let notice = model.taskReferenceCopyNotice, !model.taskPresented {
                Text(notice).rnFont(14).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(palette.text).background(palette.filter)
                    .accessibilityIdentifier("task-copy-notice")
            }
            if !model.projectDeleteNotice.isEmpty && !model.taskPresented {
                HStack(spacing: 12) {
                    Text(model.projectDeleteNotice.text("message")).rnFont(14)
                        .accessibilityIdentifier("project-delete-notice")
                    Spacer(minLength: 0)
                    if model.projectDeleteNotice.flag("undoEnabled") {
                        Button {
                            Task { await model.undoProjectDelete() }
                        } label: {
                            Text(model.projectDeleteNotice.text("undoLabel"))
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("project-delete-undo")
                    }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(palette.text).background(palette.filter)
            }
            if !model.projectDuplicateNotice.isEmpty && !model.taskPresented {
                Text(model.projectDuplicateNotice.text("message")).rnFont(14)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(palette.text).background(palette.filter)
                    .accessibilityIdentifier("project-duplicate-notice")
            }
            if !model.taskFocusNotice.isEmpty && !model.reviewGuidePresented {
                TaskFocusNotice(model: model, palette: palette)
            }
            if (model.error ?? model.inboxBulkRetryError) != nil && !model.capturePresented && !model.areaPickerPresented && !model.morePresented && !model.mindSweepPresented && !model.processInboxPresented && !model.calendarItemPresented
                && !(model.somedayPanel == "newSection" && model.somedaySectionCreateError != nil)
                && !(model.somedayPanel == "newSectionTask" && model.somedaySectionTaskError != nil)
                && !(model.somedayPanel == "moveSection" && model.somedayMoveError != nil)
                && !(model.selectedSurface == .someday && model.somedayMoveUndoError != nil)
                && !(model.selectedSurface == .settings && model.somedaySectionRenameError != nil)
                && !(model.selectedSurface == .settings && model.somedaySectionDeleteError != nil)
                && !(model.selectedSurface == .settings && model.settingsAreaDeleteError != nil)
                && !(model.selectedSurface == .settings && model.settingsAreaEditActive && model.areaRenameError != nil) {
                FailureBanner(model: model, palette: palette)
            }
            if !model.reviewGuidePresented { taskRowMutationRetryBanners }
        })
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            palette.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                ZStack(alignment: .bottom) {
                    VStack(spacing: 0) {
                        primarySurfaceContent
                        surfaceNotices
                    }
                    .allowsHitTesting(!model.morePresented && !model.inboxGroupPresented && !model.inboxFiltersPresented && !(model.inboxBulkTagPresented || model.inboxBulkRemovePresented || model.inboxBulkOrganizePresented))
                    .accessibilityElement(children: menuPanelPresented ? .ignore : .contain)
                    .accessibilityHidden(menuPanelPresented)
                    if model.morePresented { MoreMenuSheet(model: model, palette: palette) }
                    if !model.somedayPanel.isEmpty { SomedayPanel(model: model, palette: palette) }
                    if !model.referencePanel.isEmpty { ReferencePanel(model: model, palette: palette) }
                    if model.inboxSortPresented { TaskListSortPanel(model: model, palette: palette, caller: .inbox) }
                    if model.contextsSortPresented { TaskListSortPanel(model: model, palette: palette, caller: .contexts) }
                    if model.inboxGroupPresented { InboxGroupPanel(model: model, palette: palette) }
                    if !model.historyPanel.isEmpty { HistoryPanel(model: model, palette: palette) }
                }
                if model.selectedSurface != .search && model.selectedSurface != .project && model.selectedSurface != .waiting
                    && model.selectedSurface != .someday && model.selectedSurface != .reference && model.selectedSurface != .history
                    && model.selectedSurface != .trash && model.selectedSurface != .savedSearch
                    && (model.selectedSurface != .contexts || model.quickAccessView == "contexts")
                    && model.selectedSurface != .settings {
                    tabBar.disabled(model.inboxSortPresented || model.contextsSortPresented || model.inboxGroupPresented || model.inboxFiltersPresented)
                        .accessibilityHidden(model.inboxSortPresented || model.contextsSortPresented || model.inboxGroupPresented || model.inboxFiltersPresented)
                }
            }
            .background(GeometryReader { proxy in
                Color.clear.onAppear { bottomSafeInset = proxy.safeAreaInsets.bottom }
                    .onChange(of: proxy.safeAreaInsets.bottom) { bottomSafeInset = $0 }
            })

            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(model.morePresented || model.inboxSortPresented || model.contextsSortPresented || model.inboxGroupPresented ? .isModal : [])
            .disabled(model.rowTaskDatesPresented || model.rowTaskDestinationPresented || model.taskChecklistMovePresented || model.rowTaskBackdatePresented || (model.inboxBulkTagPresented || model.inboxBulkRemovePresented || model.inboxBulkOrganizePresented) || model.referenceProjectNextActionPresented || model.savedSearchWritePresented || model.focusSavedFilterPresented || model.boardFiltersPresented || model.calendarItemPresented || model.calendarComposerPresented || model.mindSweepPresented || model.processInboxPresented || !model.focusPanel.isEmpty || (model.selectedSurface == .review
                && (model.reviewGuidePresented || model.reviewPickerPresented)))
            .accessibilityHidden(model.rowTaskDatesPresented || model.rowTaskDestinationPresented || model.taskChecklistMovePresented || model.rowTaskBackdatePresented || (model.inboxBulkTagPresented || model.inboxBulkRemovePresented || model.inboxBulkOrganizePresented) || model.referenceProjectNextActionPresented || model.savedSearchWritePresented || model.focusSavedFilterPresented || model.boardFiltersPresented || model.calendarItemPresented || model.calendarComposerPresented || model.mindSweepPresented || model.processInboxPresented || model.capturePresented || model.areaPickerPresented || !model.focusPanel.isEmpty
                || (model.selectedSurface == .review && (model.reviewGuidePresented || model.reviewPickerPresented)))
            if model.inboxBulkTagPresented && model.selectedSurface == .inbox && !model.appLock.concealed {
                InboxBulkTagDialog(model: model, palette: palette)
            }
            if model.inboxBulkRemovePresented && model.selectedSurface == .inbox && !model.appLock.concealed {
                InboxBulkRemoveTagDialog(model: model, palette: palette)
            }
            if model.bulkOrganizeVisible {
                AnyView(InboxBulkOrganizeDialog(model: model, palette: palette))
            }
            if model.selectedSurface == .board && model.boardFiltersPresented {
                BoardFiltersSheet(model: model, palette: palette)
            }
            if !model.focusPanel.isEmpty {
                FocusControlsPanel(model: model, palette: palette)
                    .disabled(model.focusSavedFilterPresented).accessibilityHidden(model.focusSavedFilterPresented)
            }
            if model.focusSavedFilterPresented { FocusSavedFilterDialog(model: model, palette: palette) }
            if model.savedSearchWritePresented { SavedSearchWriteDialog(model: model, palette: palette) }
            if model.selectedSurface == .review && model.reviewGuidePresented {
                ReviewGuideScreen(model: model, palette: palette)
                    .safeAreaInset(edge: .top) {
                        VStack(spacing: 0) {
                            taskRowMutationRetryBanners
                            if model.taskActionNotice.text("source") == "rowDelete" { taskActionNoticeView }
                        }
                    }
                    .disabled(model.rowTaskDatesPresented || model.rowTaskDestinationPresented || model.taskChecklistMovePresented || model.rowTaskBackdatePresented || model.mindSweepPresented || model.processInboxPresented)
                    .accessibilityHidden(model.rowTaskDatesPresented || model.rowTaskDestinationPresented || model.taskChecklistMovePresented || model.rowTaskBackdatePresented || model.areaPickerPresented || model.taskPresented || model.mindSweepPresented || model.processInboxPresented)
            }
            if model.selectedSurface == .review && model.reviewPickerPresented {
                ReviewStartPicker(model: model, palette: palette)
            }
            if model.selectedSurface == .calendar && model.calendarItemPresented {
                CalendarItemSheet(model: model, palette: palette)
            }
            if model.selectedSurface == .calendar && model.calendarComposerPresented {
                CalendarComposerSheet(model: model, palette: palette)
            }
            if model.mindSweepPresented {
                MindSweepSheet(model: model, palette: palette)
            }
            if model.processInboxPresented {
                ProcessInboxSheet(model: model, palette: palette)
                    .disabled(model.taskPresented).accessibilityHidden(model.taskPresented)
            }
            if model.capturePresented {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { model.requestCaptureClose() }
                CaptureSheet(model: model, palette: palette)
                    .frame(maxWidth: 860)
            }
            if model.areaPickerPresented {
                GeometryReader { geometry in
                    ZStack(alignment: .bottom) {
                        Button { model.closeAreaPicker() } label: {
                            Color.black.opacity(0.35).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).ignoresSafeArea().disabled(model.busy || model.retryNeeded)
                        .accessibilityLabel(model.label("common.close")).accessibilityIdentifier("area-dismiss")
                        areaSheet(maxHeight: geometry.size.height * 0.7, bottomInset: geometry.safeAreaInsets.bottom)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
            if model.rowTaskDatesPresented { AnyView(TaskRowDatesDialog(model: model, palette: palette).id(model.rowTaskDatesPresentationID)) }
            if model.rowTaskDestinationPresented { AnyView(rowTaskDestinationContent) }
            if model.taskChecklistMovePresented { AnyView(TaskChecklistMoveDialog(model: model, palette: palette)) }
            if model.rowTaskBackdatePresented { AnyView(rowTaskBackdateContent) }
            if model.referenceProjectNextActionPresented {
                VStack(spacing: 0) {
                    ReferenceProjectNextActionPrompt(model: model, palette: palette)
                    taskActionNoticeView
                }
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
            }
        }
        .foregroundStyle(palette.text)
        .tint(palette.tint)
        .preferredColorScheme(model.theme.text("scheme").isEmpty ? nil : palette.dark ? .dark : .light)
        .sheet(isPresented: Binding(get: { model.taskPresented }, set: { if !$0 && !model.appLock.concealed { model.closeTask() } }),
               onDismiss: { model.navigationReplayTaskSheetDismissed() }) {
            TaskViewSheet(model: model, palette: palette)
                .presentationDetents([.large])
        }
        .sheet(isPresented: Binding(get: { model.inboxFiltersPresented }, set: { if !$0 && !model.appLock.concealed { model.closeInboxFilters() } })) {
            InboxFiltersModalContent(model: model, lock: model.appLock, palette: palette)
                .presentationDetents([.large])
                .interactiveDismissDisabled()
        }
        .onChange(of: model.selectedSurface) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.taskPresented) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.appLock.concealed) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.rowTaskDatesPresentationCurrent) { current in
            if !current && model.rowTaskDatesPresented { model.retireRowTaskDatesPresentation() }
        }
        .onChange(of: model.rowTaskDestinationPresentationCurrent) { current in
            if !current && model.rowTaskDestinationPresented { model.retireRowTaskDestinationPresentation() }
        }
        .onChange(of: model.taskChecklistMovePresentationCurrent) { current in
            if !current && model.taskChecklistMovePresented { model.retireTaskChecklistMovePresentation() }
        }
        .onChange(of: model.rowTaskBackdatePresentationCurrent) { current in
            if !current && model.rowTaskBackdatePresented { model.retireRowTaskBackdatePresentation() }
        }
        .onChange(of: model.taskStatusMenuPresented) { active in
            if !active { model.presentQueuedReferenceProjectNextAction() }
        }
        .task(id: (model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board) && scenePhase == .active) {
            guard model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board, scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board, scenePhase == .active else { return }


                await model.refresh()
            }
        }
    }

    private var rowTaskDestinationContent: some View {
        TaskRowDestinationDialog(model: model, palette: palette,
                                 pending: model.rowTaskDestinationPending, error: { model.rowTaskDestinationError },
                                 identifierPrefix: "row-destination", retryIdentifier: "row-destination-retry",
                                 retry: { await model.retry() }, close: model.cancelRowTaskDestination,
                                 read: { query, offset in await model.rowTaskDestinationOptions(query: query, offset: offset) },
                                 choose: { destination in await model.moveRowTaskDestination(destination) })
            .id(model.rowTaskDestinationPresentationID)
    }

    @ViewBuilder private var rowTaskBackdateContent: some View {
        if !model.rowTaskBackdateOptions.isEmpty {
            TaskRowBackdateDialog(model: model, palette: palette, options: model.rowTaskBackdateOptions,
                                  initialDate: model.rowTaskBackdateInitialDate,
                                  pending: model.rowTaskBackdatePending, error: model.rowTaskBackdateError,
                                  identifierPrefix: "row-backdate", retryIdentifier: "row-backdate-retry",
                                  retry: { await model.retry() }, close: model.cancelRowTaskBackdate,
                                  save: { instant, minutes in
                await model.saveRowTaskBackdate(completedAt: instant, timeSpentText: minutes)
            })
            .id(model.rowTaskBackdatePresentationID)
        } else {
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { model.cancelRowTaskBackdate() }.accessibilityHidden(true)
                VStack(spacing: 12) {
                    if model.rowTaskBackdateReading { ProgressView() }
                    if let message = model.rowTaskBackdateError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("row-backdate-error")
                        Button(model.label("common.retry")) { model.readRowTaskBackdateOptions() }
                            .frame(minHeight: 44).disabled(model.rowTaskBackdateReading || model.busy || model.retryNeeded)
                            .accessibilityIdentifier("row-backdate-retry")
                    }
                    Button(model.label("common.cancel")) { model.cancelRowTaskBackdate() }
                        .frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("row-backdate-cancel")
                }
                .padding(24).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            }
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { model.cancelRowTaskBackdate() }
        }
    }

    @ViewBuilder private var taskActionNoticeView: some View {
        if !model.taskActionNotice.isEmpty && !model.taskPresented {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(model.taskActionNotice.text("message")).rnFont(14)
                                    .accessibilityIdentifier("task-" + model.taskActionNotice.text("operation") + "-notice")
                                if model.taskActionNotice.flag("undoEnabled") {
                                    Button {
                                        Task { await model.undoTaskAction() }
                                    } label: {
                                        Text(model.taskActionNotice.text("undoLabel"))
                                            .frame(minWidth: 44, minHeight: 44)
                                            .contentShape(Rectangle())
                                    }.disabled(model.busy || model.retryNeeded || model.referenceProjectNextActionPending || !model.projectTaskActionUndoEnabled || !model.taskChecklistMoveUndoEnabled || !model.rowTaskDeleteUndoEnabled)
                                        .accessibilityIdentifier("task-" + model.taskActionNotice.text("operation") + "-undo")
                                }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .foregroundStyle(palette.text).background(palette.filter)
                        }
    }

    private func areaSheet(maxHeight: CGFloat, bottomInset: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.label("projects.areaFilter")).rnFont(16, .bold).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("area-title")
                .padding(.bottom, defaultAreaScope ? 12 : 4)
            if !defaultAreaScope {
                Text(model.area.text("summary")).rnFont(13).foregroundStyle(palette.secondary).lineLimit(2)
                    .padding(.bottom, 12).accessibilityIdentifier("area-summary")
            }
            ViewThatFits(in: .vertical) {
                areaOptions.fixedSize(horizontal: false, vertical: true)
                ScrollView { areaOptions }
            }
            if model.error != nil {


                FailureBanner(model: model, palette: palette)
            }
        }
        .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, max(20, bottomInset + 12))
        .frame(maxHeight: maxHeight, alignment: .bottom)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 860, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
        .background(alignment: .bottom) { palette.card.frame(height: 24).ignoresSafeArea(edges: .bottom) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { model.closeAreaPicker() }
    }

    private var areaOptions: some View {
        VStack(spacing: 10) {
            ForEach(model.area.objects("options").indices, id: \.self) { index in
                let option = model.area.objects("options")[index]
                let included = option.text("state") == "included"
                let excluded = option.text("state") == "excluded"
                let tone = excluded ? palette.danger : included ? palette.tint : palette.text
                Button { Task { await model.selectArea(option.object("next")) } } label: {
                    HStack(spacing: 12) {
                        if !option.text("color").isEmpty {
                            Circle().fill(Color(hex: option.text("color"))).frame(width: 8, height: 8)
                                .accessibilityHidden(true)
                        }
                        Text(option.text("label")).rnFont(15, .semibold).lineLimit(1).strikethrough(excluded)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if excluded { AppIcon(name: "x", size: 16) }
                        else if included {

                            Path { path in
                                path.move(to: CGPoint(x: 20, y: 6))
                                path.addLine(to: CGPoint(x: 9, y: 17))
                                path.addLine(to: CGPoint(x: 4, y: 12))
                            }
                            .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                            .frame(width: 24, height: 24).scaleEffect(16.0 / 24).frame(width: 16, height: 16)
                            .accessibilityHidden(true)
                        }
                    }
                    .foregroundStyle(tone).padding(.horizontal, 14).frame(minHeight: 48)
                    .background(included || excluded ? tone.opacity(0.094) : palette.card, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(included || excluded ? tone : palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(excluded ? option.text("label") + " (" + model.label("filters.excluded") + ")" : option.text("label"))
                .accessibilityAddTraits(included ? .isSelected : [])
                .accessibilityValue(excluded ? model.label("filters.excluded") : "")
                .accessibilityIdentifier("area-option-" + option.text("id"))
            }
        }
        .padding(.bottom, 8)
    }

    private var inboxRows: [(id: [String], item: CoreObject)] {
        model.items.map { (id: model.inboxItemIdentity($0), item: $0) }
    }

    private var inboxContent: some View {
        VStack(spacing: 0) {
            toolbar
            inboxFilterChips
            if model.inboxSelectionMode { AnyView(inboxBulkDeleteBar) }
            primaryAction.disabled(!model.inboxActionsEnabled || model.inboxSelectionMode)

            List {
                Group {
                    Text(model.inbox.text("scopeLabel"))
                        .rnFont(13, .semibold).foregroundStyle(palette.secondary)
                        .padding(.horizontal, 16).padding(.bottom, 2)
                    if model.items.isEmpty { emptyState }
                    if let error = model.inboxReadError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("inbox-group-error")
                        Button(model.label("common.retry")) { Task { await model.retryInboxGrouping() } }
                            .frame(minHeight: 44).disabled(model.busy || model.retryNeeded || menuPanelPresented)
                            .accessibilityIdentifier("inbox-group-retry")
                    }
                    ForEach(inboxRows, id: \.id) { entry in
                        let item = entry.item
                        Group {
                            if item.text("type") == "section" { inboxSection(item) }
                            else if item.text("type") == "task" {
                                let row = item.object("row")
                                let selected = model.inboxTaskSelected(row.text("id"))
                                HStack(spacing: 8) {
                                    if model.inboxSelectionMode, !row.flag("readOnly") {
                                        Button { Task { await model.selectInboxTask(row) } } label: {
                                            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                                .font(.system(size: 22)).foregroundStyle(palette.tint)
                                                .frame(width: 45, height: 45).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).accessibilityLabel(row.text("title"))
                                        .accessibilityAddTraits(selected ? .isSelected : [])
                                        .accessibilityIdentifier("inbox-select-" + (item.text("groupId").isEmpty ? "none" : item.text("groupId")) + "-" + row.text("id"))
                                    }
                                    TaskCard(row: row, model: model, palette: palette,
                                             readOnly: model.inboxSelectionMode || row.flag("readOnly"),
                                             hideStatusBadge: model.inboxSelectionMode,
                                             onSelection: model.inboxSelectionMode && !row.flag("readOnly") ? { row in Task { await model.selectInboxTask(row) } } : nil,
                                             onSelectionStart: !row.flag("readOnly") ? { row in Task { await model.selectInboxTask(row) } } : nil,
                                             swipeHost: .list)
                                        .accessibilityIdentifier("inbox-item-" + item.text("groupId") + "-" + row.text("id"))
                                }
                                    .disabled(!model.inboxActionsEnabled)
                            }
                        }
                        .onAppear {
                            Task { await model.loadMore(automaticRow: entry.id) }
                        }
                        .onChange(of: model.inboxActionsEnabled) { enabled in
                            if enabled { Task { await model.loadMore(automaticRow: entry.id) } }
                        }
                    }
                    if model.items.count < model.inbox.number("total") {
                        Button { Task { await model.loadMore() } } label: {
                            Text(model.label("common.more")).rnFont(12, .semibold)
                                .padding(.horizontal, 12).frame(minHeight: 44)
                                .background(palette.filter, in: Capsule()).contentShape(Capsule())
                        }
                        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || menuPanelPresented)
                        .accessibilityIdentifier("inbox-more")
                    }
                    if model.busy && !model.capturePresented { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .listRowInsets(EdgeInsets(top: 3, leading: 12, bottom: 3, trailing: 12))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("inbox-scroll")
            .refreshable { await model.pullToRefresh() }
        }
        .background {
            if let ticket = model.navigationReplayTicket(for: "inbox"), !menuPanelPresented, !inboxBulkDeletePresented {
                NavigationReplayContentEntry(model: model, ticket: ticket,
                    uncovered: { !menuPanelPresented && !inboxBulkDeletePresented })
            }
        }
        .alert(model.archiveBulkDeleteConfirmation.text("title"), isPresented: $inboxBulkDeletePresented) {
            Button(model.archiveBulkDeleteConfirmation.text("cancelLabel"), role: .cancel) {
                model.cancelArchiveBulkDeleteConfirmation()
            }.accessibilityIdentifier("inbox-bulk-cancel")
            Button(model.archiveBulkDeleteConfirmation.text("confirmLabel"), role: .destructive) {
                Task { await model.confirmDeleteSelectedArchiveTasks() }
            }.accessibilityIdentifier("inbox-bulk-confirm")
        } message: { Text(model.archiveBulkDeleteConfirmation.text("message")) }
        .onChange(of: model.archiveBulkDeleteConfirmation.isEmpty) { if $0 { inboxBulkDeletePresented = false } }
        .onChange(of: scenePhase) { model.inboxSelectionOwnerChanged(active: $0 == .active) }
        .onDisappear { model.inboxSelectionOwnerChanged(active: false) }
    }

    private var inboxBulkDeleteBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(model.inboxBulk.object("bar").text("countLabel"))
                    .rnFont(13).foregroundStyle(palette.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-bulk-count")
                Spacer(minLength: 0)
                Button { model.leaveInboxTaskSelection() } label: {
                    AppIcon(name: "x", size: 16).frame(width: 45, height: 45).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(!model.inboxSelectionExitEnabled)
                .accessibilityLabel(model.inboxBulk.object("bar").object("exit").text("accessibilityLabel"))
                .accessibilityIdentifier("inbox-bulk-exit")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let statuses = model.inboxBulk.object("bar").objects("statuses")
                    ForEach(statuses.indices, id: \.self) { index in
                        let option = statuses[index]
                        Button { Task { await model.moveSelectedInboxTasks(status: option.text("status")) } } label: {
                            inboxBulkActionLabel(option.text("label"))
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(!model.inboxBulkStatusEnabled(option.text("status")))
                        .accessibilityLabel(option.text("accessibilityLabel"))
                        .accessibilityIdentifier("inbox-bulk-status-" + option.text("status"))
                    }
                    Button { model.openInboxBulkOrganize() } label: {
                        inboxBulkActionLabel(model.inboxBulk.object("bar").object("organize").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkOrganizeEnabled)
                    .accessibilityLabel(model.inboxBulk.object("bar").object("organize").text("label"))
                    .accessibilityIdentifier("inbox-bulk-organize-open")
                    Button { model.openInboxBulkTag() } label: {
                        inboxBulkActionLabel(model.inboxBulk.object("bar").object("addTag").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkTagEnabled)
                    .accessibilityLabel(model.inboxBulk.object("bar").object("addTag").text("accessibilityLabel"))
                    .accessibilityIdentifier("inbox-bulk-tag-open")
                    Button { model.openInboxBulkRemove() } label: {
                        inboxBulkActionLabel(model.inboxBulk.object("bar").object("removeTag").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkRemoveEnabled)
                    .accessibilityLabel(model.inboxBulk.object("bar").object("removeTag").text("label"))
                    .accessibilityIdentifier("inbox-bulk-remove-tag-open")
                    Button { Task { await model.toggleInboxTaskRange() } } label: {
                        inboxBulkActionLabel(model.inboxBulk.object("bar").object("range").text("label"))
                    }
                    .buttonStyle(.plain).disabled(!model.inboxBulkDeleteEnabled)
                    .accessibilityAddTraits(model.inboxBulk.object("bar").object("range").flag("active") ? .isSelected : [])
                    .accessibilityIdentifier("inbox-bulk-range")
                    Button {
                        model.requestDeleteSelectedInboxTasks()
                        inboxBulkDeletePresented = !model.archiveBulkDeleteConfirmation.isEmpty
                    } label: { inboxBulkActionLabel(model.inboxBulk.object("bar").object("delete").text("label")) }
                    .buttonStyle(.plain).foregroundStyle(palette.danger).disabled(!model.inboxBulkDeleteEnabled)
                    .accessibilityIdentifier("inbox-bulk-delete")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("inbox-bulk-actions-scroll")
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border).allowsHitTesting(false))
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func inboxBulkActionLabel(_ text: String) -> some View {
        Text(text).rnFont(13, .semibold).fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 12).frame(minWidth: 45, minHeight: 45)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border).allowsHitTesting(false))
            .contentShape(Rectangle())
    }

    @ViewBuilder private func inboxSection(_ item: CoreObject) -> some View {
        if item.flag("collapsible") {
            Button { Task { await model.toggleInboxSection(item.text("id")) } } label: { inboxSectionLabel(item) }
                .buttonStyle(.plain).disabled(!model.inboxActionsEnabled)
                .accessibilityValue(model.label(item.flag("collapsed") ? "markdown.expand" : "markdown.collapse"))
                .accessibilityIdentifier("inbox-section-" + item.text("id"))
        } else { inboxSectionLabel(item).accessibilityAddTraits(.isHeader) }
    }

    private func inboxSectionLabel(_ item: CoreObject) -> some View {
        HStack(spacing: 6) {
            if item.flag("collapsible") {
                AppIcon(name: "chevron", size: 15).rotationEffect(.degrees(item.flag("collapsed") ? -90 : 0))
                    .foregroundStyle(palette.secondary)
            }
            Text(item.text("title")).rnFont(13, .bold).foregroundStyle(item.flag("muted") ? palette.secondary : palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(String(item.number("count"))).rnFont(12, .semibold).foregroundStyle(palette.secondary)
        }
        .frame(minHeight: 44).contentShape(Rectangle()).padding(.top, 4)
    }

    private var focusContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error = model.focusError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .accessibilityIdentifier("focus-error")
                    Button(model.label("common.retry")) { model.retryFocus() }
                        .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("focus-retry")
                }
                PomodoroTimerPanel(model: model, palette: palette)
                if !model.focus.isEmpty {
                    focusToolbar
                    focusFilterRows
                    let empty = model.focus.object("controls").object("empty")
                    if model.focusCurrent && !empty.isEmpty {
                        VStack(spacing: 4) {
                            Text(empty.text("title")).rnFont(16, .bold)
                                .accessibilityIdentifier("focus-empty-title")
                            Text(empty.text("subtitle")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                        }
                        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                    ForEach(focusSections.indices, id: \.self) { index in
                        let section = focusSections[index]
                        let key = section.text("key")
                        focusSectionHeader(key: key, title: section.text("title"), count: section.number("total"), first: index == 0, countLabel: section.text("countLabel"))
                        if !section.text("hiddenByAreaLabel").isEmpty {
                            Text(section.text("hiddenByAreaLabel")).rnFont(12).foregroundStyle(palette.secondary)
                                .padding(.bottom, 10)
                        }
                        if !model.collapsedFocusSections.contains(key) {
                            let rows = section.objects("rows")
                            ForEach(rows.indices, id: \.self) { rowIndex in
                                let row = rows[rowIndex]


                                VStack(alignment: .leading, spacing: 0) {
                                    let groups = section.objects("groups").filter { $0.number("start") == rowIndex }
                                    ForEach(groups.indices, id: \.self) { groupIndex in
                                        focusGroupHeader(groups[groupIndex], section: key).id(key + ":" + groups[groupIndex].text("id"))
                                    }
                                    let rowGroup = section.objects("groups").first { group in
                                        rowIndex >= group.number("start") &&
                                            rowIndex - group.number("start") < group.number("count")
                                    }
                                    let laterToday = key == "schedule" && row.flag("laterToday")
                                    if laterToday && (rowIndex == 0 || !rows[rowIndex - 1].flag("laterToday")) {
                                        focusLaterTodayHeader
                                    }
                                    let groupID = laterToday ? "focus:schedule:later-today" : rowGroup?.text("id")
                                    let collapsed = groupID.map { (model.collapsedFocusGroups[key] ?? []).contains($0) } ?? false
                                    if !collapsed {
                                        TaskCard(row: row, model: model, palette: palette,
                                                 footer: row.text("revealLabel").isEmpty ? row.text("laterTodayLabel") : row.text("revealLabel"),
                                                 showDetails: model.focusShowDetails, showFocusToggle: true,
                                                 onProject: { project in Task { await model.openProject(project) } })
                                            .padding(.leading, section.objects("groups").isEmpty ? 0 : 25)
                                            .overlay(alignment: .leading) {
                                                if !section.objects("groups").isEmpty { palette.border.frame(width: 2).padding(.leading, 13) }
                                            }
                                            .accessibilityIdentifier("focus-group-item-" + (groupID ?? "none") + "-" + row.text("id"))
                                            .padding(.bottom, 8).disabled(!model.focusActionsEnabled)
                                    }
                                }
                                .id(key + ":" + String(rowIndex) + ":" + row.text("id"))
                            }
                            if rows.count < section.number("rowTotal") {
                                Button { Task { await model.loadMoreFocus(key) } } label: {
                                    Text(model.label("common.more")).rnFont(13, .semibold)
                                        .padding(.horizontal, 16).frame(minHeight: 44)
                                        .background(palette.filter, in: Capsule())
                                }
                                .buttonStyle(.plain).disabled(!model.focusActionsEnabled)
                                .accessibilityLabel(model.label("common.more") + " " + section.text("title"))
                                .accessibilityIdentifier("focus-more-" + key)
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                            }
                        }
                    }
                    if !reviewProjects.isEmpty {
                        focusSectionHeader(key: "reviewProjects", title: model.label("agenda.reviewDueProjects"),
                                           count: reviewProjects.count, first: focusSections.isEmpty)
                        if !model.collapsedFocusSections.contains("reviewProjects") {
                            ForEach(reviewProjects.indices, id: \.self) { index in
                                focusReviewProject(reviewProjects[index])
                            }
                        }
                    }
                }
                if (model.busy || model.focusLoading) && !model.capturePresented { ProgressView().frame(maxWidth: .infinity).padding(12) }
            }
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
        .accessibilityIdentifier("focus-scroll")
        .refreshable { await model.pullToRefresh() }
    }

    private var focusFilterRows: some View {
        let controls = model.focus.object("controls")
        return VStack(alignment: .leading, spacing: 0) {
            let saved = controls.object("savedFilters")
            if !saved.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        let all = saved.object("all")
                        focusFilterChip(all.text("label"), selected: all.flag("selected"), id: "focus-saved-all") {
                            model.editFocusControl(all.object("edit"))
                        }
                        let entries = saved.object("chips").objects("items")
                        ForEach(entries.indices, id: \.self) { index in
                            let item = entries[index]
                            focusSavedFilterChip(item)
                        }
                        if entries.count < saved.object("chips").number("total") {
                            focusFilterChip(model.label("common.more"), selected: false, id: "focus-saved-more") {
                                model.loadMoreFocusControls(saved: true)
                            }
                        }
                    }.padding(.vertical, 8)
                }.fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("focus-saved-strip")
            }
            let active = controls.object("activeChips")
            if !active.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        let chips = active.objects("chips")
                        ForEach(chips.indices, id: \.self) { index in
                            let chip = chips[index]
                            focusFilterChip(chip.text("label"), selected: true, excluded: chip.flag("excluded"), removable: true,
                                            id: "focus-active-chip-" + chip.text("id")) { model.editFocusControl(chip.object("edit")) }
                        }
                        let clear = active.object("clear")
                        focusFilterChip(clear.text("label"), selected: false, id: "focus-active-clear") { model.editFocusControl(clear.object("edit")) }
                    }.padding(.vertical, 8)
                }.fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func focusSavedFilterChip(_ item: CoreObject) -> some View {
        let selected = item.flag("selected")
        let remove = { Task { await model.openFocusSavedFilter(["type": "delete", "id": item.text("id")], message: item.text("label")) } }
        return HStack(spacing: 0) {
            Button { model.selectFocusSavedFilter(item.text("id")) } label: {
                Text(item.text("label")).rnFont(12, .semibold).fixedSize()
                    .padding(.leading, 12).padding(.trailing, 8).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("focus-saved-" + item.text("id"))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .onLongPressGesture { _ = remove() }
            .accessibilityAction(named: item.text("deleteLabel")) { _ = remove() }
            Button { _ = remove() } label: {
                AppIcon(name: "x", size: 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(item.text("deleteLabel"))
            .accessibilityIdentifier("focus-saved-delete-" + item.text("id"))
        }
        .foregroundStyle(selected ? palette.onTint : palette.text)
        .background(selected ? palette.tint : palette.filter, in: Capsule())
        .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
        .disabled(!model.focusControlsEnabled)
    }

    private func focusFilterChip(_ title: String, selected: Bool, excluded: Bool = false, removable: Bool = false,
                                 id: String, action: @escaping () -> Void) -> some View {
        let tone = excluded ? palette.danger : palette.tint
        return Button(action: action) {
            HStack(spacing: 6) {
                Text(title).rnFont(12, .semibold).strikethrough(excluded).fixedSize()
                if removable { AppIcon(name: "x", size: 12) }
            }
            .foregroundStyle(selected ? palette.onTint : palette.text).padding(.horizontal, 12).padding(.vertical, 6)
            .frame(minHeight: 44).background(selected ? tone : palette.filter, in: Capsule())
            .overlay(Capsule().stroke(selected ? tone : palette.border, lineWidth: 1)).contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(!model.focusControlsEnabled).accessibilityIdentifier(id)
        .accessibilityLabel(removable ? model.label("filters.remove") + ": " + title : title)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityValue(excluded ? model.label("filters.excluded") : "")
    }

    private var focusLaterTodayHeader: some View {
        let id = "focus:schedule:later-today"
        let collapsed = (model.collapsedFocusGroups["schedule"] ?? []).contains(id)
        return Button { model.toggleFocusGroup(section: "schedule", id: id) } label: {
            HStack(spacing: 8) {
                AppIcon(name: "chevron", size: 15).rotationEffect(.degrees(collapsed ? -90 : 0))
                    .accessibilityHidden(true)
                Text(model.label("agenda.laterToday")).rnFont(13, .bold)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
            .padding(.top, 10).padding(.bottom, 6)
        }
        .buttonStyle(.plain).disabled(!model.focusControlsEnabled)
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
        .accessibilityValue(model.label(collapsed ? "markdown.expand" : "markdown.collapse"))
        .accessibilityIdentifier("focus-group-header-" + id)
    }

    private func focusGroupHeader(_ group: CoreObject, section: String) -> some View {
        let collapsed = (model.collapsedFocusGroups[section] ?? []).contains(group.text("id"))
        return Button { model.toggleFocusGroup(section: section, id: group.text("id")) } label: {
            HStack(spacing: 8) {
                AppIcon(name: "chevron", size: 15).rotationEffect(.degrees(collapsed ? -90 : 0))
                    .foregroundStyle(palette.secondary).accessibilityHidden(true)
                Circle().fill(group.flag("muted") ? palette.secondary : palette.einkSafe(group.text("dotColor").isEmpty ? palette.tint : Color(hex: group.text("dotColor"))))
                    .frame(width: 8, height: 8).accessibilityHidden(true)
                Text(group.text("title").uppercased()).rnFont(13, .bold).tracking(0.6).foregroundStyle(group.flag("muted") ? palette.secondary : palette.text)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                Text(String(group.number("count"))).rnFont(12, .semibold).foregroundStyle(palette.secondary)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
            .padding(.horizontal, 4).padding(.top, 10).padding(.bottom, 8)
        }
        .buttonStyle(.plain).disabled(!model.focusControlsEnabled)
        .accessibilityValue(model.label(collapsed ? "markdown.expand" : "markdown.collapse"))
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("focus-group-header-" + group.text("id"))
    }

    private var focusToolbar: some View {
        let controls = model.focus.object("controls").object("header")
        return HStack(spacing: 12) {
            Text(model.focus.text("dateLabel").uppercased()).rnFont(12, .semibold).tracking(0.6)
                .foregroundStyle(palette.secondary).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("focus-date")
            HStack(spacing: 8) {
                Button { model.openFocusPanel("view") } label: {
                    // Lucide Settings2 paths from RN; license: App/Lucide-LICENSE.
                    Path { path in
                        path.move(to: CGPoint(x: 14, y: 17)); path.addLine(to: CGPoint(x: 5, y: 17))
                        path.move(to: CGPoint(x: 19, y: 7)); path.addLine(to: CGPoint(x: 10, y: 7))
                        path.addEllipse(in: CGRect(x: 14, y: 14, width: 6, height: 6))
                        path.addEllipse(in: CGRect(x: 4, y: 4, width: 6, height: 6))
                    }
                        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(width: 24, height: 24).scaleEffect(20.0 / 24).frame(width: 20, height: 20)
                        .foregroundStyle(controls.object("viewOptions").flag("active") || model.focusShowDetails ? palette.tint : palette.secondary)
                        .frame(width: 44, height: 44)
                        .accessibilityHidden(true)
                }
                .buttonStyle(.plain).disabled(!model.focusControlsEnabled).accessibilityLabel(controls.object("viewOptions").text("label"))
                .accessibilityValue(model.label(model.focusPanel == "view" ? "markdown.collapse" : "markdown.expand"))
                .accessibilityIdentifier("focus-view-options")
                Button { model.openFocusPanel("filters") } label: {
                    AppIcon(name: "sliders", size: 20)
                        .foregroundStyle(controls.object("filters").flag("active") ? palette.tint : palette.secondary)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                        .overlay(alignment: .topTrailing) {
                            if !controls.object("filters").text("badge").isEmpty {
                                Text(controls.object("filters").text("badge")).rnFont(9, .bold).foregroundStyle(palette.onTint)
                                    .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 14).background(palette.tint, in: Capsule())
                            }
                        }
                }
                .buttonStyle(.plain).disabled(!model.focusControlsEnabled)
                .accessibilityLabel(controls.object("filters").text("label"))
                .accessibilityValue(controls.object("filters").text("badge")).accessibilityIdentifier("focus-filters-open")
                Button { model.toggleOtherFocusSections() } label: {

                    Path { path in
                        path.move(to: CGPoint(x: 17, y: 11)); path.addLine(to: CGPoint(x: 12, y: 6)); path.addLine(to: CGPoint(x: 7, y: 11))
                        path.move(to: CGPoint(x: 17, y: 18)); path.addLine(to: CGPoint(x: 12, y: 13)); path.addLine(to: CGPoint(x: 7, y: 18))
                    }
                        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(width: 24, height: 24).scaleEffect(20.0 / 24).frame(width: 20, height: 20)
                        .rotationEffect(.degrees(otherFocusSectionsOpen ? 0 : 180))
                        .foregroundStyle(otherFocusSectionsOpen ? palette.secondary : palette.tint)
                        .frame(width: 44, height: 44).opacity(otherFocusKeys.isEmpty ? 0.4 : 1)
                        .accessibilityHidden(true)
                }
                .buttonStyle(.plain).disabled(otherFocusKeys.isEmpty || !model.focusControlsEnabled)
                .accessibilityLabel(model.label(otherFocusSectionsOpen ? "agenda.collapseOtherSections" : "agenda.expandOtherSections"))
                .accessibilityIdentifier("focus-toggle-sections")
            }
        }
        .padding(.top, 6)
    }

    private func focusSectionHeader(key: String, title: String, count: Int, first: Bool, countLabel: String = "") -> some View {
        let open = !model.collapsedFocusSections.contains(key)
        let countText = countLabel.isEmpty ? String(count) : countLabel
        return HStack(spacing: 8) {
            Button { model.toggleFocusSection(key) } label: {
                HStack(spacing: 10) {
                    Text(open ? "▾" : "▸").rnFont(12).frame(width: 14)
                    Text(title.uppercased()).rnFont(12, .bold, maxScale: 1.2).tracking(1).lineLimit(2)
                    Text("(\(countText))").rnFont(12, .semibold, maxScale: 1.2)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.focusControlsEnabled)
            .accessibilityLabel(title + " · " + countText)
            .accessibilityValue(model.label(open ? "markdown.collapse" : "markdown.expand"))
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("focus-section-" + key)
            let reorder = model.focus.object("controls").object("reorder")
            if key == "focus" && !reorder.isEmpty {
                Button { Task { await model.openFocusOrder() } } label: {
                    HStack(spacing: 4) {

                        Path { path in
                            for x in [9.0, 15.0] {
                                for y in [5.0, 12.0, 19.0] {
                                    path.addEllipse(in: CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
                                }
                            }
                        }
                        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(width: 24, height: 24).scaleEffect(15.0 / 24).frame(width: 15, height: 15)
                        .accessibilityHidden(true)
                        Text(reorder.text("label")).rnFont(11, .bold, maxScale: 1.2)
                    }
                    .foregroundStyle(palette.secondary).frame(minHeight: 44).padding(.horizontal, 6)
                }
                .buttonStyle(.plain).disabled(!model.focusActionsEnabled)
                .accessibilityIdentifier("focus-reorder-toggle")
            }
        }
        .padding(.top, first ? 8 : 18).padding(.bottom, 10)
    }

    private var focusOrderContent: some View {
        let labels = model.focus.object("controls").object("reorder")
        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(labels.text("title").uppercased()).rnFont(13, .bold, maxScale: 1.2).tracking(1).lineLimit(1)
                    .foregroundStyle(palette.text).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                Button { model.closeFocusOrder() } label: {
                    Text(model.label("common.done")).rnFont(14, .bold)
                        .foregroundStyle(palette.onTint).padding(.horizontal, 18).frame(minHeight: 44)
                        .background(palette.tint).clipShape(RoundedRectangle(cornerRadius: 20))
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("focus-reorder-done")
            }
            .padding(.horizontal, 12).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(palette.border).frame(height: 1) }
            if let error = model.focusOrderError {
                VStack(alignment: .leading, spacing: 4) {
                    Text(error).rnFont(13).foregroundStyle(palette.danger)
                        .accessibilityIdentifier("focus-reorder-error")
                    Button { Task { await model.retryFocusOrder() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold).frame(minHeight: 44)
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
                    .accessibilityIdentifier("focus-reorder-retry")
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            List {
                ForEach(model.focusOrderView.objects("rows").map { FocusOrderItem(row: $0) }) { item in
                    let row = item.row
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.text("title")).rnFont(15, .semibold).foregroundStyle(palette.text).lineLimit(1)
                        if !row.text("secondaryLabel").isEmpty {
                            Text(row.text("secondaryLabel")).rnFont(12).foregroundStyle(palette.secondary).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
                    .listRowInsets(EdgeInsets(top: 4, leading: 26, bottom: 4, trailing: 14))
                    .listRowSeparator(.hidden)
                    .listRowBackground(RoundedRectangle(cornerRadius: 12).fill(palette.card)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 0.5))
                        .padding(.horizontal, 12).padding(.vertical, 4))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.text("positionLabel"))
                    .accessibilityHint(labels.text("hint"))
                    .accessibilityIdentifier("focus-reorder-row-" + row.text("id"))
                    .accessibilityActions {
                        if row["moveUp"] is [String] {
                            Button(labels.text("moveUpLabel")) { Task { await model.moveFocusTask(row, up: true) } }
                        }
                        if row["moveDown"] is [String] {
                            Button(labels.text("moveDownLabel")) { Task { await model.moveFocusTask(row, up: false) } }
                        }
                    }
                    .moveDisabled(!model.focusOrderInputEnabled)
                }
                .onMove { source, destination in Task { await model.moveFocusTask(from: source, to: destination) } }
                if model.focusOrderShowHint {
                    Text(labels.text("hint")).rnFont(12).foregroundStyle(palette.secondary)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .environment(\.editMode, .constant(.active))
            .accessibilityIdentifier("focus-reorder-list")
            .disabled(!model.focusOrderInputEnabled)
        }
        .accessibilityAction(.escape) { model.closeFocusOrder() }
    }

    private func focusReviewProject(_ project: CoreObject) -> some View {
        Button { Task { await model.openProject(project) } } label: {
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    AppIcon(name: "folder", size: 18).frame(width: 36, height: 36)
                        .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(
                            project.text("color").isEmpty ? palette.border : Color(hex: project.text("color")), lineWidth: 1))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.text("title")).rnFont(16, .bold).lineLimit(1)
                        Text(project.text("statusLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !project.text("reviewDateLabel").isEmpty {
                    Text(project.text("reviewDateLabel")).rnFont(12, .bold).foregroundStyle(palette.secondary)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 72)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.focusActionsEnabled)
        .padding(.bottom, 8)
        .accessibilityIdentifier("focus-project-" + project.text("id"))
    }

    private var header: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 0) {
                    headerTitle.padding(.horizontal, 16)
                    headerTools
                }
            } else {
                ZStack { headerTitle; headerTools }.frame(height: 44)
            }
        }
        .background(palette.card.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
    }

    private var headerTitle: some View {
            Text(model.ready ? (model.selectedSurface == .focus ? model.label("tab.next")
                : model.selectedSurface == .review ? model.label("tab.review")
                : model.selectedSurface == .calendar ? model.label("nav.calendar")
                : model.selectedSurface == .board ? model.label("nav.board")
                : model.selectedSurface == .projects ? model.label("projects.title") : model.inbox.text("title")) : "Mindwtr")
                .rnFont(17, .bold).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(model.selectedSurface == .focus ? "focus-title"
                    : model.selectedSurface == .review ? "review-title"
                    : model.selectedSurface == .calendar ? "calendar-title"
                    : model.selectedSurface == .board ? "board-title"
                    : model.selectedSurface == .projects ? "projects-title" : "inbox-title")
    }

    private var headerTools: some View {
            HStack {
                Button { Task { await model.openAreaPicker() } } label: {
                    HStack(spacing: 4) {
                        Text(model.area.text("label")).rnFont(13, .semibold).lineLimit(1)
                        AppIcon(name: "chevron", size: 13)
                    }
                    .foregroundStyle(defaultAreaScope ? palette.secondary : palette.tint)
                    .frame(minHeight: 48).padding(.horizontal, 6).frame(maxWidth: 160, alignment: .leading)
                }
                .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("projects.areaFilter") + ": " + model.area.text("summary"))
                .accessibilityValue(model.area.text("label"))
                .accessibilityIdentifier("area-open")
                Spacer()
                Button { model.openSearch() } label: {
                    AppIcon(name: "search", size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("search.title")).accessibilityIdentifier("search-open")
            }
            .padding(.horizontal, 16)
    }

    private var menuListHeader: some View {
        VStack(spacing: 0) {
            if dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 8) { menuListBack; menuListTitle }
                HStack(spacing: 8) { Spacer(minLength: 0); menuListTools }
            } else {
                HStack(spacing: 8) { menuListBack; menuListTitle; menuListTools }
            }
        }
        .padding(.horizontal, 8).frame(minHeight: 52)
        .background(palette.card.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
    }

    private func endContextsInput() {
        if model.selectedSurface == .contexts {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
    }

    @ViewBuilder private var menuListBack: some View {
        if model.selectedSurface != .contexts || model.quickAccessView != "contexts" {
            Button {
                endContextsInput()
                Task {
                    if model.selectedSurface == .contexts { await model.closeContexts() }
                    else if model.selectedSurface == .savedSearch { await model.closeSavedSearch() }
                    else if model.selectedSurface == .trash { await model.closeTrash() }
                    else if model.selectedSurface == .history { await model.closeHistory() }
                    else if model.selectedSurface == .reference { await model.closeReference() }
                    else if model.selectedSurface == .someday { await model.closeSomeday() }
                    else { await model.closeWaiting() }
                }
            } label: {
                AppIcon(name: "chevron", size: 24).rotationEffect(.degrees(90)).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
            .accessibilityLabel(model.label("common.back"))
            .accessibilityIdentifier(menuListPrefix + "-back")
        }
    }

    private var menuListTitle: some View {
        Text(model.selectedSurface == .savedSearch ? (model.savedSearch.text("title").isEmpty ? model.label("search.savedSearches") : model.savedSearch.text("title")) : model.selectedSurface == .reference && !model.reference.text("title").isEmpty
             ? model.reference.text("title") : model.label(menuListPrefix == "history" || menuListPrefix == "trash" || menuListPrefix == "contexts" ? "nav." + menuListPrefix : menuListPrefix + ".title")).rnFont(17, .bold)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier(menuListPrefix + "-title")
    }

    @ViewBuilder private var menuListTools: some View {
        Button {
            endContextsInput()
            Task { await model.openAreaPicker() }
        } label: {
            HStack(spacing: 4) {
                Text(model.area.text("label")).rnFont(12, .semibold).lineLimit(1)
                AppIcon(name: "chevron", size: 12)
            }
            .foregroundStyle(defaultAreaScope ? palette.secondary : palette.tint)
            .frame(minHeight: 44).frame(maxWidth: 90).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
        .accessibilityLabel(model.label("projects.areaFilter") + ": " + model.area.text("summary"))
        .accessibilityValue(model.area.text("label")).accessibilityIdentifier("area-open")
        Button { endContextsInput(); model.openSearch() } label: {
            AppIcon(name: "search", size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
        .accessibilityLabel(model.label("search.title")).accessibilityIdentifier("search-open")
        if model.selectedSurface == .reference {
            Button { model.referencePanel = "menu" } label: {
                Image(systemName: "ellipsis").font(.system(size: 20)).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.referenceActionsEnabled)
            .accessibilityLabel(model.label("taskEdit.moreOptions")).accessibilityIdentifier("reference-overflow-button")
        } else if model.selectedSurface == .history && !model.historyArchived {
            Button { model.setHistoryPanel("menu") } label: {
                Image(systemName: "ellipsis").font(.system(size: 20)).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
            .accessibilityLabel(model.label("taskEdit.moreOptions")).accessibilityIdentifier("done-overflow-button")
        }
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            ForEach([("sort", "sort"), ("folder", "group"), ("sliders", "filters")], id: \.0) { icon, field in
                Button {
                    if field == "sort" { Task { await model.openInboxSort() } }
                    else if field == "group" { Task { await model.openInboxGroup() } }
                    else { model.openInboxFilters() }
                } label: {
                    let selected = field == "filters" && model.inbox.object("toolbar").object(field).flag("selected")
                    let count = model.inbox.object("toolbar").object(field).text("countLabel")

                    let counted = field == "filters" && !count.isEmpty
                    HStack(spacing: 5) {
                        AppIcon(name: icon, size: 16)
                        if counted { Text(count).rnFont(13, .bold) }
                    }
                    .foregroundStyle(selected ? palette.tint : palette.secondary)
                    .padding(.horizontal, counted ? 9 : 0)
                    .frame(minWidth: 32, minHeight: 32)
                    .background(palette.filter, in: Capsule())
                    .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                    .padding(.horizontal, counted ? 6 : 0)
                    .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain).disabled(field == "sort" ? !model.inboxSortEnabled : field == "group" ? !model.inboxGroupEnabled : !model.inboxFiltersEnabled)
                .accessibilityLabel(model.inbox.object("toolbar").object(field).text("accessibilityLabel"))
                .accessibilityIdentifier("inbox-" + field + "-open")
                .accessibilityAddTraits(field == "filters" && model.inbox.object("toolbar").object(field).flag("selected") ? .isSelected : [])
                .accessibilityValue(field == "filters" ? model.inbox.object("toolbar").object(field).text("countLabel") : "")
            }
            Spacer(minLength: 8)
            if model.inbox.object("mindSweep").text("placement") == "accessory" {
                Button { Task { await model.openMindSweep() } } label: {
                    actionLabel(model.inbox.object("mindSweep").text("label"), icon: "brain", color: palette.secondary)
                        .rnFont(14, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(palette.filter, in: Capsule())
                        .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(!model.inboxActionsEnabled || model.inboxSelectionMode || model.inbox.object("mindSweep").text("label").isEmpty)
                .accessibilityIdentifier("inbox-mind-sweep-accessory")
            }
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
    }

    @ViewBuilder private var inboxFilterChips: some View {
        let chips = model.inbox.objects("chips")
        if !chips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                ForEach(chips.indices, id: \.self) { index in
                    let chip = chips[index]
                    let tone = chip.flag("excluded") ? palette.danger : palette.tint
                    Button { Task { await model.applyInboxChipAction(chip.object("action")) } } label: {
                        HStack(spacing: 4) {
                            Text(chip.text("label")).rnFont(12, .semibold).strikethrough(chip.flag("excluded"))
                            AppIcon(name: "x", size: 12)
                        }
                        .foregroundStyle(tone).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(tone, lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(!model.inboxActionsEnabled)
                    .accessibilityLabel(chip.text("accessibilityLabel")).accessibilityAddTraits(.isSelected)
                    .accessibilityValue(chip.flag("excluded") ? model.label("filters.excluded") : "")
                    .accessibilityIdentifier("inbox-chip-" + chip.text("id"))
                }
                Button { Task { await model.editInboxFilter(model.inbox.object("filters").object("clearEdit")) } } label: {
                    Text(model.inbox.text("clearLabel")).rnFont(12, .semibold).padding(.horizontal, 12)
                        .frame(minHeight: 44).contentShape(Capsule())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxActionsEnabled)
                .accessibilityIdentifier("inbox-chips-clear")
                }
                .padding(.horizontal, 16)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("inbox-chips-scroll")
        }
    }

    private var primaryAction: some View {
        let process = model.inbox.object("process")
        let mindSweep = model.inbox.object("mindSweep")
        let isMindSweep = process.isEmpty && mindSweep.text("placement") == "primary" && !mindSweep.text("label").isEmpty
        let label = process.isEmpty ? mindSweep.text("label") : process.text("label")
        return Button {
            Task {
                if isMindSweep { await model.openMindSweep() }
                else { await model.openProcessInbox() }
            }
        } label: {
            actionLabel(label, icon: process.isEmpty ? "brain" : "checks", color: palette.tint)
                .rnFont(15, .semibold).frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 16)
                .background(palette.material ? palette.captureBackground : palette.tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.material ? .clear : palette.tint, lineWidth: 0.7))
        }
        .buttonStyle(.plain).disabled(label.isEmpty || !model.ready || model.busy || model.retryNeeded)
        .accessibilityIdentifier(isMindSweep ? "inbox-mind-sweep-primary" : "inbox-process-primary")
        .padding(.horizontal, 16).padding(.top, 6)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text(model.inbox.object("empty").text("message")).rnFont(15, .semibold)
            Text(model.inbox.object("empty").text("hint")).rnFont(13).foregroundStyle(palette.secondary.opacity(0.8))
            Button {
                Task {
                    let edit = model.inbox.object("empty").object("action").object("filterEdit")
                    if !edit.isEmpty { await model.editInboxFilter(edit) }
                    else { await model.openCapture() }
                }
            } label: {
                Text(model.inbox.object("empty").text("actionLabel"))
                    .rnFont(13, .bold).padding(.horizontal, 16).padding(.vertical, 9)
                    .frame(minHeight: 44).contentShape(Capsule())
                    .overlay(Capsule().stroke(palette.text, lineWidth: 1))
            }
            .buttonStyle(.plain).padding(.top, 8)
            .disabled(!model.inboxActionsEnabled)
            .accessibilityIdentifier(model.inbox.object("empty").object("action").object("filterEdit").isEmpty
                ? "inbox-empty-capture" : "inbox-empty-clear")
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity).padding(.horizontal, 20).padding(.vertical, 36)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            tab("target", label: model.label("tab.next"), surface: .focus)
            tab("inbox", label: model.label("tab.inbox"), surface: .inbox)
            Button { Task { await model.openCapture() } } label: {
                AppIcon(name: "plus", size: 28).foregroundStyle(palette.captureForeground)
                    .frame(width: 48, height: 38)
                    .background(palette.captureBackground, in: RoundedRectangle(cornerRadius: 10))
                    .shadow(color: .black.opacity(0.10), radius: 4, y: 2)
                    .offset(y: -4)
                    .frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded || (model.selectedSurface == .inbox && model.inboxSelectionMode)
                || (model.selectedSurface == .project && model.projectSelectionMode))
            .accessibilityLabel(model.label("nav.addTask"))
            .accessibilityIdentifier("capture-open")
            quickAccessTab
            Button { endContextsInput(); Task { await model.toggleMore() } } label: {
                VStack(spacing: 2) {
                    AppIcon(name: "menu", size: model.morePresented ? 26 : 24).opacity(model.morePresented ? 1 : 0.65)
                    Text(model.label("tab.menu")).rnFont(10, model.morePresented ? .bold : .semibold, maxScale: 1.15).lineLimit(1)
                }
                .foregroundStyle(model.morePresented ? palette.tint : palette.secondary)
                .frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded)
            .accessibilityLabel(model.label("tab.menu")).accessibilityIdentifier("tab-menu")
            .accessibilityAddTraits(model.morePresented ? .isSelected : [])
        }
        .frame(minHeight: 66)
        .disabled(model.unassignedAreaColorActive || model.settingsAreaCreatePresented)

        .padding(.bottom, -min(12, bottomSafeInset))
        .background(palette.card.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { palette.border.frame(height: 0.5) }
    }

    private func tab(_ icon: String, label: String, surface: CoreModel.Surface? = nil) -> some View {
        let selected = surface == model.selectedSurface
        return Button { if let surface { Task { await model.selectSurface(surface) } } } label: {
            VStack(spacing: 2) {
                AppIcon(name: icon, size: selected ? 26 : 24).opacity(selected ? 1 : 0.65)
                Text(label).rnFont(10, selected ? .bold : .semibold, maxScale: 1.15).lineLimit(1)
            }
            .foregroundStyle(selected ? palette.tint : palette.secondary)
            .frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(surface == nil || !model.ready || model.busy || model.retryNeeded)
        .accessibilityLabel(label)
        .accessibilityIdentifier(surface == .focus ? "tab-focus" : surface == .inbox ? "tab-inbox" : "tab-" + icon)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var quickAccessTab: some View {
        let selected = (model.quickAccessView == "projects" && model.selectedSurface == .projects)
            || (model.quickAccessView == "review" && model.selectedSurface == .review)
            || (model.quickAccessView == "calendar" && model.selectedSurface == .calendar)
            || (model.quickAccessView == "board" && model.selectedSurface == .board)
            || (model.quickAccessView == "contexts" && model.selectedSurface == .contexts)
        return Button { Task {
            if model.quickAccessView == "review" { await model.openReview() }
            else if model.quickAccessView == "calendar" { await model.openCalendar() }
            else if model.quickAccessView == "board" { await model.openBoard() }
            else if model.quickAccessView == "contexts" { await model.openContexts() }
            else { await model.openProjects() }
        } } label: {
            VStack(spacing: 2) {
                quickAccessIcon(selected: selected).opacity(selected ? 1 : 0.65)
                Text(model.quickAccessLabel).rnFont(10, selected ? .bold : .semibold, maxScale: 1.15).lineLimit(1)
            }
            .foregroundStyle(selected ? palette.tint : palette.secondary)
            .frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!["projects", "review", "calendar", "board", "contexts"].contains(model.quickAccessView) || !model.ready || model.busy || model.retryNeeded)
        .accessibilityLabel(model.quickAccessLabel).accessibilityIdentifier("tab-" + model.quickAccessView)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private func quickAccessIcon(selected: Bool) -> some View {
        if model.quickAccessView == "projects" {
            AppIcon(name: "folder", size: selected ? 26 : 24)
        } else if model.quickAccessView == "board" {
            Image(systemName: "rectangle.split.3x1").font(.system(size: 24)).frame(width: 24, height: 24).accessibilityHidden(true)
        } else if model.quickAccessView == "calendar" || model.quickAccessView == "contexts" {

            Path { path in
                if model.quickAccessView == "contexts" { path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20)) }
                else {
                    path.addRoundedRect(in: CGRect(x: 3, y: 4, width: 18, height: 18), cornerSize: CGSize(width: 2, height: 2))
                    path.move(to: CGPoint(x: 8, y: 2)); path.addLine(to: CGPoint(x: 8, y: 6))
                    path.move(to: CGPoint(x: 16, y: 2)); path.addLine(to: CGPoint(x: 16, y: 6))
                    path.move(to: CGPoint(x: 3, y: 10)); path.addLine(to: CGPoint(x: 21, y: 10))
                }
            }
            .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .frame(width: 24, height: 24).accessibilityHidden(true)
        } else { AppIcon(name: "review", size: 24) }
    }

    private func disabledIcon(_ icon: String, label: String, size: CGFloat) -> some View {
        Button {} label: { AppIcon(name: icon, size: size).frame(width: 44, height: 44) }
            .buttonStyle(.plain).disabled(true).accessibilityLabel(label)
    }

    private func actionLabel(_ label: String, icon: String, color: Color) -> some View {
        HStack(spacing: 8) {
            AppIcon(name: icon, size: 18).foregroundStyle(color)
            Text(label).foregroundStyle(palette.text).multilineTextAlignment(.center)
        }
    }
}

private struct TaskCardSelectionLongPress: ViewModifier {
    @Environment(\.isEnabled) private var interactionEnabled
    let identity: String
    let host: TaskRowSwipeHost
    let enabled: Bool
    let action: () -> Void

    @ViewBuilder func body(content: Content) -> some View {
        if host == .list {
            content.background(TaskCardLongPressRegistrar(identity: identity, enabled: enabled && interactionEnabled, action: action)
                .allowsHitTesting(false))
        } else {
            content.modifier(TaskCardStackLongPress(identity: identity, enabled: enabled && interactionEnabled, action: action))
        }
    }
}

private struct TaskCardStackLongPress: ViewModifier {
    let identity: String
    let enabled: Bool
    let action: () -> Void

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(TaskCardStackLongPressGesture(identity: identity, enabled: enabled, action: action))
        } else {
            content.simultaneousGesture(LongPressGesture(minimumDuration: 0.5, maximumDistance: 10).onEnded { _ in
                if enabled { action() }
            }, including: enabled ? .all : .subviews)
        }
    }
}

@available(iOS 18.0, *)
private struct TaskCardStackLongPressGesture: UIGestureRecognizerRepresentable {
    let identity: String
    let enabled: Bool
    let action: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }
    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let press = UILongPressGestureRecognizer()
        press.minimumPressDuration = 0.5
        press.allowableMovement = 10
        press.delegate = context.coordinator
        press.isEnabled = enabled
        context.coordinator.adopt(self)
        return press
    }
    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        context.coordinator.adopt(self)
        if recognizer.state != .began && recognizer.state != .changed { recognizer.isEnabled = enabled }
    }
    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let current = context.coordinator
        guard recognizer.state == .began, current.enabled,
              current.pressedIdentity.utf8.elementsEqual(current.identity.utf8) else { return }
        current.action()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var identity = ""
        var pressedIdentity = ""
        var enabled = false
        var action: () -> Void = {}

        func adopt(_ gesture: TaskCardStackLongPressGesture) {
            identity = gesture.identity; enabled = gesture.enabled; action = gesture.action
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            if gestureRecognizer.state == .possible { pressedIdentity = identity }
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            other === (other.view as? UIScrollView)?.panGestureRecognizer
        }
    }
}

private struct TaskCardLongPressRegistrar: UIViewRepresentable {
    let identity: String
    let enabled: Bool
    let action: () -> Void

    func makeUIView(context: Context) -> RegistrarView { RegistrarView(frame: .zero) }
    func updateUIView(_ view: RegistrarView, context: Context) {
        view.configure(identity: identity, enabled: enabled, action: action)
    }
    static func dismantleUIView(_ view: RegistrarView, coordinator: ()) { view.stop() }

    final class RegistrarView: UIView {
        private var identity = ""
        private var enabled = false
        private var press = CardLongPress()

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        func configure(identity: String, enabled: Bool, action: @escaping () -> Void) {
            if !self.identity.utf8.elementsEqual(identity.utf8) {
                press.retire()
                press = CardLongPress()
                self.identity = identity
            }
            self.enabled = enabled
            press.marker = self
            press.configure(enabled: enabled, action: action)
            attach()
        }
        override func didMoveToSuperview() { super.didMoveToSuperview(); attach() }
        override func didMoveToWindow() { super.didMoveToWindow(); attach() }
        override func layoutSubviews() { super.layoutSubviews(); attach() }
        func stop() { enabled = false; press.retire() }

        private func attach() {
            guard enabled, window != nil else { press.detach(); return }


            var ancestor = superview
            var host: UIView?
            while let candidate = ancestor {
                if let cell = candidate as? UICollectionViewCell { host = cell.contentView; break }
                if let cell = candidate as? UITableViewCell { host = cell.contentView; break }
                if candidate is UIScrollView || candidate is UIWindow { break }
                ancestor = candidate.superview
            }
            guard let host, isDescendant(of: host) else { press.detach(); return }
            var parent = host.superview
            while let candidate = parent, !(candidate is UIScrollView), !(candidate is UIWindow) {
                parent = candidate.superview
            }
            guard let scroll = parent as? UIScrollView else { press.detach(); return }
            press.attach(to: host, scroll: scroll)
        }
    }

    final class CardLongPress: UILongPressGestureRecognizer, UIGestureRecognizerDelegate {
        weak var marker: UIView?
        private weak var enclosingScroll: UIScrollView?
        private var requestedEnabled = false
        private var retired = false
        private var fired = false
        private var action: (() -> Void)?
        private var recognizing: Bool { state == .began || state == .changed }

        init(marker: UIView? = nil) {
            super.init(target: nil, action: nil)
            self.marker = marker
            minimumPressDuration = 0.5
            allowableMovement = 10
            cancelsTouchesInView = true
            delegate = self
            addTarget(self, action: #selector(handlePress))
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        func configure(enabled: Bool, action: (() -> Void)?) {
            requestedEnabled = enabled && !retired
            self.action = requestedEnabled ? action : nil


            if !requestedEnabled && !recognizing { detach() }
        }
        func attach(to host: UIView, scroll: UIScrollView) {
            guard requestedEnabled, !retired else { return }
            if view !== host {
                guard !recognizing else { return }
                detach()
                host.addGestureRecognizer(self)
            }
            enclosingScroll = scroll
            isEnabled = true
        }
        func detach() {
            guard !recognizing else { return }
            view?.removeGestureRecognizer(self)
            enclosingScroll = nil
            isEnabled = false
        }
        func retire() {
            retired = true
            requestedEnabled = false
            action = nil
            marker = nil
            detach()
        }
        @objc private func handlePress() {
            if state == .began, requestedEnabled, !retired, !fired {
                fired = true
                action?()
            } else if state == .ended || state == .cancelled || state == .failed {
                fired = false
                if !requestedEnabled || retired || marker?.window == nil { detach() }
            }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard requestedEnabled, !retired, let marker, let host = view, let touched = touch.view,
                  marker.window != nil, marker.window === host.window,
                  marker.isDescendant(of: host), (touched === host || touched.isDescendant(of: host)),
                  marker.bounds.width > 0, marker.bounds.height > 0 else { return false }
            let point = touch.location(in: marker)
            return point.x.isFinite && point.y.isFinite && marker.bounds.contains(point)
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            other === enclosingScroll?.panGestureRecognizer
        }
    }
}

enum TaskRowSwipeHost { case local, list }

private struct TaskRowSwipeButton: View {
    let action: CoreObject
    let palette: AppPalette
    let rowID: String
    let native: Bool
    let activate: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var symbol: String {
        switch action.text("id") {
        case "done": return "circle"
        case "focus": return action.flag("focused") ? "star.fill" : "star"
        case "organize": return "folder"
        case "dates": return "calendar"
        case "delete": return "trash"
        case "duplicate": return "square.on.square"
        case "restore": return "arrow.uturn.backward"
        default: return "arrow.right"
        }
    }
    private var color: Color {
        switch action.text("id") {
        case "delete": return palette.danger
        case "focus": return palette.focusStar
        case "done": return palette.success
        case "dates": return palette.secondary
        default: return palette.tint
        }
    }
    @ViewBuilder var body: some View {
        if native { actionButton.buttonStyle(.automatic) }
        else { actionButton.buttonStyle(.plain) }
    }
    private var actionButton: some View {
        Button(action: activate) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 20)).accessibilityHidden(true)
                if !dynamicTypeSize.isAccessibilitySize {
                    Text(action.text("label")).rnFont(12, .semibold).multilineTextAlignment(.center).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
            .foregroundStyle(.white)
            .background(native ? Color.clear : color)
        }
        .tint(color).disabled(!action.flag("enabled"))
        .accessibilityLabel(action.text("label"))
        .accessibilityIdentifier("task-swipe-" + action.text("id") + "-" + rowID)
    }
}

private struct TaskRowSwipeTray: ViewModifier {
    let host: TaskRowSwipeHost
    let actions: CoreObject
    let identity: String
    let rowID: String
    let palette: AppPalette
    let enabled: Bool
    let closeGeneration: Int
    let layoutDirection: LayoutDirection
    let activate: (CoreObject, String) -> Void
    var cornerRadius: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var offset: CGFloat = 0
    @State private var openingOffset: CGFloat = 0
    @State private var dragAxis = 0
    @State private var width: CGFloat = 320
    private var left: [CoreObject] { enabled ? actions.objects("swipeRight").filter { $0.flag("enabled") } : [] }
    private var right: [CoreObject] { enabled ? actions.objects("swipeLeft").filter { $0.flag("enabled") } : [] }
    private var buttonWidth: CGFloat { min(64, max(44, width / CGFloat(max(1, max(left.count, right.count))))) }
    private var leftWidth: CGFloat { CGFloat(left.count) * buttonWidth }
    private var rightWidth: CGFloat { CGFloat(right.count) * buttonWidth }

    @ViewBuilder func body(content: Content) -> some View {
        if host == .list {
            content
                .swipeActions(edge: layoutDirection == .leftToRight ? .leading : .trailing, allowsFullSwipe: false) {
                    ForEach(left.indices, id: \.self) { index in button(left[index], native: true) }
                }
                .swipeActions(edge: layoutDirection == .leftToRight ? .trailing : .leading, allowsFullSwipe: false) {
                    ForEach(right.indices.reversed(), id: \.self) { index in button(right[index], native: true) }
                }
        } else {
            ZStack {
                if offset > 0 {
                    HStack(spacing: 0) {
                        ForEach(left.indices, id: \.self) { index in button(left[index], native: false).frame(width: buttonWidth) }
                        Spacer(minLength: 0)
                    }
                    .environment(\.layoutDirection, .leftToRight)
                }
                if offset < 0 {
                    HStack(spacing: 0) {
                        Spacer(minLength: 0)
                        ForEach(right.indices, id: \.self) { index in button(right[index], native: false).frame(width: buttonWidth) }
                    }
                    .environment(\.layoutDirection, .leftToRight)
                }
                content
                    .overlay {
                        if offset != 0 {
                            Color.clear.contentShape(Rectangle()).onTapGesture { close() }
                        }
                    }
                    .offset(x: offset)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .background(GeometryReader { geometry in
                Color.clear.onAppear { width = geometry.size.width }
                    .onChange(of: geometry.size.width) { width = $0; close() }
            })
            .modifier(TaskRowSwipeDrag(active: !left.isEmpty || !right.isEmpty, began: dragBegan, changed: dragChanged, ended: dragEnded))
            .accessibilityElement(children: .contain)
            .accessibilityActions {
                ForEach((left + right).indices, id: \.self) { index in
                    let action = (left + right)[index]
                    Button(action.text("label")) { activate(action, identity) }
                }
            }
            .onChange(of: identity) { _ in close() }
            .onChange(of: closeGeneration) { _ in close() }
            .onChange(of: enabled) { if !$0 { close() } }
            .onChange(of: scenePhase) { if $0 != .active { close() } }
            .onDisappear { offset = 0; dragAxis = 0; openingOffset = 0 }
        }
    }
    private func button(_ action: CoreObject, native: Bool) -> some View {
        TaskRowSwipeButton(action: action, palette: palette, rowID: rowID, native: native) {
            close(); activate(action, identity)
        }
    }
    private func close() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { offset = 0 }
        dragAxis = 0; openingOffset = 0
    }
    static func isHorizontalIntent(_ translation: CGSize) -> Bool {
        translation.width.isFinite && translation.height.isFinite
            && abs(translation.width) > abs(translation.height) * 1.25
    }
    private func dragBegan() {
        guard enabled, !left.isEmpty || !right.isEmpty else { return }
        dragAxis = 1; openingOffset = offset
    }
    private func dragChanged(_ translation: CGSize) {
        guard enabled, !left.isEmpty || !right.isEmpty else { return }
        if dragAxis == 0 {
            if Self.isHorizontalIntent(translation) {
                dragAxis = 1; openingOffset = offset
            } else { dragAxis = -1 }
        }
        guard dragAxis == 1 else { return }
        offset = min(leftWidth, max(-rightWidth, openingOffset + translation.width))
    }
    private func dragEnded() {
        defer { dragAxis = 0; openingOffset = 0 }
        guard dragAxis == 1 else { return }
        let target: CGFloat = offset > min(72, leftWidth / 2) ? leftWidth
            : offset < -min(72, rightWidth / 2) ? -rightWidth : 0
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { offset = target }
    }
}

extension View {
    func projectRowSwipeTray(actions: CoreObject, identity: String, rowID: String, palette: AppPalette, enabled: Bool,
                             layoutDirection: LayoutDirection, activate: @escaping (CoreObject, String) -> Void) -> some View {
        modifier(TaskRowSwipeTray(host: .local, actions: actions, identity: identity, rowID: rowID, palette: palette,
                                  enabled: enabled, closeGeneration: 0, layoutDirection: layoutDirection,
                                  activate: activate, cornerRadius: 8))
    }

    func projectRowLongPress(identity: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        modifier(TaskCardStackLongPress(identity: identity, enabled: enabled, action: action))
    }
}

private struct TaskRowSwipeDrag: ViewModifier {
    let active: Bool
    let began: () -> Void
    let changed: (CGSize) -> Void
    let ended: () -> Void

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(TaskRowSwipePan(active: active, began: began, changed: changed, ended: ended))
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { value in
                changed(value.translation)
            }.onEnded { _ in
                ended()
            })
        }
    }
}

@available(iOS 18.0, *)
private struct TaskRowSwipePan: UIGestureRecognizerRepresentable {
    let active: Bool
    let began: () -> Void
    let changed: (CGSize) -> Void
    let ended: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }
    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = TaskRowSwipePanRecognizer()
        pan.delegate = context.coordinator
        pan.isEnabled = active
        return pan
    }
    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = active
    }
    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        switch recognizer.state {
        case .began:
            began()
        case .changed:
            guard let translation = context.converter.localTranslation else { return }
            changed(CGSize(width: translation.x, height: translation.y))
        case .ended, .cancelled:
            ended()
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let translation = pan.translation(in: pan.view)
            return TaskRowSwipeTray.isHorizontalIntent(CGSize(width: translation.x, height: translation.y))
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other === (other.view as? UIScrollView)?.panGestureRecognizer
        }
    }
}

private final class TaskRowSwipePanRecognizer: UIPanGestureRecognizer {
    private var origin: CGPoint?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if origin == nil { origin = touches.first?.location(in: view) }
        super.touchesBegan(touches, with: event)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible, let origin, let point = touches.first?.location(in: view),
           hypot(point.x - origin.x, point.y - origin.y) < 12 { return }
        super.touchesMoved(touches, with: event)
    }
    override func reset() {
        origin = nil
        super.reset()
    }
}

struct TaskCard: View {
    let row: CoreObject
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var footer: String = ""
    var readOnly: Bool = false
    var hideStatusBadge: Bool = false
    var showDetails: Bool = false
    var showFocusToggle: Bool = false
    var onProject: ((CoreObject) -> Void)? = nil
    var onToken: ((String) -> Void)? = nil
    var beforeAction: (() -> Void)? = nil
    var onMoveToSection: (() -> Void)? = nil
    var moveToSectionLabel: String = ""
    var onStatusOptions: ((CoreObject) async -> CoreObject?)? = nil
    var onStatusChange: ((CoreObject, String) -> Void)? = nil
    var onCompletedAt: ((CoreObject) -> Void)? = nil
    var onSelection: ((CoreObject) -> Void)? = nil
    var onSelectionStart: ((CoreObject) -> Void)? = nil
    var swipeHost: TaskRowSwipeHost = .local
    var onSwipeDelete: ((CoreObject) -> Void)? = nil
    var onSwipeNext: ((CoreObject) -> Void)? = nil
    var onSwipeOrganize: ((CoreObject) -> Void)? = nil
    var swipeInteractionDisabled = false
    @ScaledMetric(relativeTo: .body) private var assignedToFontSize: CGFloat = 12
    @Environment(\.isEnabled) private var rowEnabled
    @Environment(\.layoutDirection) private var hostLayoutDirection
    @State private var swipeDTO: CoreObject = [:]
    @State private var swipePublishedKey = ""
    @State private var swipePublishedRow: CoreObject = [:]
    @State private var swipeCloseGeneration = 0
    @State private var selectionPressStartedAt = Date.distantPast
    @State private var statusMenu = false
    @State private var navigationReplayCoverID = UUID()
    @State private var statusRow: CoreObject = [:]
    @State private var statusOptions: CoreObject = [:]
    @State private var statusOptionsTask: Task<Void, Never>?
    @State private var defaultStatusMenu = false
    @State private var checklistMoveEntry: CoreObject = [:]
    @State private var defaultStatusReadID = UUID()
    @State private var checklistExpanded = false
    @State private var checklistView: CoreObject = [:]
    @State private var checklistInput = ""
    @State private var checklistError: String?
    @State private var checklistReadTask: Task<Void, Never>?
    @State private var checklistReadID = UUID()
    @FocusState private var checklistInputFocused: Bool
    private var checklistIdentity: String { model.taskCardPresentationContext + ":" + row.text("id") }
    private var hasInlineChecklist: Bool {
        row.text("status") != "reference" && meta.objects("parts").contains { $0.text("kind") == "checklist" }
    }
    private var checklistSection: CoreObject {
        checklistView.objects("rows").first { $0.text("type") == "checklist" } ?? [:]
    }
    private var checklistWritable: Bool {
        !readOnly && onSelection == nil && !checklistView.isEmpty && !checklistView.flag("readOnly")
            && checklistView.text("taskRevision").utf8.elementsEqual(row.text("taskRevision").utf8)
            && model.inlineChecklistEnabled(row, writing: true)
    }
    private var meta: CoreObject { row.object("meta") }
    private var swipeEnabled: Bool {
        rowEnabled && !readOnly && onSelection == nil && !swipeInteractionDisabled && model.taskRowSwipeActionsEnabled(row)
    }
    private var swipeReadIdentity: String {
        checklistIdentity + ":" + row.text("taskRevision") + ":" + row.text("status")
            + ":" + String(row.flag("isFocusedToday")) + ":" + String(onSelection != nil)
            + ":" + String(readOnly) + ":" + String(rowEnabled) + ":" + String(swipeInteractionDisabled)
            + ":" + String(swipeEnabled) + ":" + String(model.taskRowSwipeLanguageGeneration)
    }
    private var statusColor: Color {
        Color(hex: model.theme.object("status").object(palette.dark ? "dark" : "light").object(row.text("status")).text("text"))
    }

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                titleContent
                if showDetails && !meta.text("descriptionPreview").isEmpty {
                    Text(NativeMarkdownInline.attributedText(meta.object("description").objects("inline"),
                         labels: meta.object("description").object("labels"), palette: palette, referenceLinks: true)).rnFont(14)
                        .foregroundStyle(palette.secondary).lineLimit(row.text("status") == "reference" ? 3 : 1)
                        .accessibilityIdentifier("task-description-" + row.text("id"))
                        .onTapGesture { openTask() }
                        .environment(\.openURL, OpenURLAction { openDescriptionURL($0) })
                        .accessibilityAction { openTask() }
                }
                let parts = meta.objects("parts").filter { showDetails || !$0.flag("detail") }
                if !parts.isEmpty {
                    if onProject != nil || onToken != nil || onCompletedAt != nil || hasInlineChecklist
                        || (meta.flag("relativeScheduleDates") && parts.contains { ["start", "due"].contains($0.text("kind")) }) {
                        AppChipFlow {
                            ForEach(parts.indices, id: \.self) { index in
                                let part = parts[index]
                                if meta.flag("relativeScheduleDates"), ["start", "due"].contains(part.text("kind")) {
                                    HStack(spacing: 4) {
                                        Image(systemName: part.text("kind") == "start" ? "arrow.right" : "calendar")
                                            .font(.system(size: 12)).foregroundStyle(scheduleIconColor(part)).accessibilityHidden(true)
                                        Text(metadata([part])).rnFont(12, .medium)
                                    }
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel(part.text("accessibilityLabel"))
                                } else if part.text("kind") == "checklist", hasInlineChecklist {
                                    Button {
                                        beforeAction?()
                                        checklistInputFocused = false
                                        checklistExpanded.toggle()
                                        if checklistExpanded { loadInlineChecklist() }
                                        else { cancelInlineChecklistRead() }
                                    } label: {
                                        HStack(spacing: 4) {
                                            Text(metadata([part])).rnFont(12, .medium)
                                            Image(systemName: checklistExpanded ? "chevron.up" : "chevron.down").font(.system(size: 10))
                                        }
                                        .frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).disabled(onSelection != nil || !model.inlineChecklistEnabled(row))
                                    .accessibilityValue(checklistExpanded ? model.label("common.close") : model.label("common.open"))
                                    .accessibilityIdentifier("task-inline-checklist-" + row.text("id"))
                                } else if part.text("kind") == "completed", row.text("status") == "done", let onCompletedAt {
                                    Button {
                                        beforeAction?()
                                        onCompletedAt(row)
                                    } label: {
                                        Text(metadata([part])).rnFont(12, .medium).frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || readOnly || row.flag("readOnly"))
                                    .accessibilityLabel(model.label("task.editCompletedAt"))
                                    .accessibilityIdentifier("task-completed-at-" + row.text("id"))
                                } else if part.text("kind") == "project", !part.text("projectId").isEmpty, let onProject {
                                    Button {
                                        beforeAction?()
                                        onProject(["id": part.text("projectId"),
                                                   "title": row.text("projectTitle").isEmpty ? part.text("text") : row.text("projectTitle")])
                                    } label: {
                                        Text(metadata([part])).rnFont(12, .medium).frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                                    .accessibilityIdentifier("task-project-" + row.text("id") + "-" + part.text("projectId"))
                                } else if ["context", "tag"].contains(part.text("kind")), let onToken {
                                    Button {
                                        beforeAction?()
                                        onToken(part.text("text"))
                                    } label: {
                                        Text(metadata([part])).rnFont(12, .medium).frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                                    .accessibilityLabel(model.label(part.text("kind") == "context" ? "task.aria.openContext" : "task.aria.openTag")
                                        .replacingOccurrences(of: "{{name}}", with: part.text("text"))
                                        .replacingOccurrences(of: "{name}", with: part.text("text")))
                                    .accessibilityIdentifier("task-token-" + row.text("id") + "-" + part.text("text"))
                                } else {
                                    Text(metadata([part])).rnFont(12, .medium).fixedSize(horizontal: false, vertical: true)
                                        .onTapGesture { openTask() }
                                }
                            }
                        }
                    } else {
                        Text(metadata(parts)).rnFont(12, .medium).fixedSize(horizontal: false, vertical: true)
                            .contentShape(Rectangle()).onTapGesture { openTask() }
                    }
                }
                if checklistExpanded && hasInlineChecklist && onSelection == nil { inlineChecklistContent }
                if !footer.isEmpty {
                    Text(footer).rnFont(12, .semibold).foregroundStyle(palette.secondary).padding(.top, 4)
                        .contentShape(Rectangle()).onTapGesture { openTask() }
                }
                if showDetails && !meta.text("ageLabel").isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "hourglass").font(.system(size: 11)).accessibilityHidden(true)
                        Text(meta.text("ageLabel")).rnFont(12)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(meta.text("ageLabel"))
                    .accessibilityIdentifier("task-age-" + row.text("id"))
                    .foregroundStyle(palette.secondary)
                    .onTapGesture { openTask() }
                    .accessibilityAction { openTask() }
                }
            }
            .frame(minHeight: 44).contentShape(Rectangle())
            if !hideStatusBadge && !meta.text("statusLabel").isEmpty {
                Button {
                    openRowStatusMenu(row)
                } label: {
                    AppIcon(name: "status", size: 20).foregroundStyle(statusColor).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.taskStatusMenuPresented || row.flag("readOnly") || readOnly || onSelection != nil || statusOptionsTask != nil)
                .accessibilityLabel(model.label("task.aria.changeStatus").replacingOccurrences(of: "{{status}}", with: meta.text("statusLabel")))
                .accessibilityHint(model.label("task.aria.changeStatusHint"))
                .accessibilityIdentifier("task-status-" + row.text("id"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10).padding(.horizontal, 16)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))
        .modifier(TaskRowSwipeTray(host: swipeHost, actions: swipeDTO, identity: swipePublishedKey,
            rowID: row.text("id"), palette: palette, enabled: swipeEnabled && swipePublishedKey == swipeReadIdentity,
            closeGeneration: swipeCloseGeneration, layoutDirection: hostLayoutDirection, activate: activateSwipe))
        .task(id: swipeReadIdentity) {
            let identity = swipeReadIdentity, displayed = row
            swipeDTO = [:]; swipePublishedKey = ""; swipePublishedRow = [:]
            guard let value = await model.readTaskRowSwipeActions(displayed, selectionMode: onSelection != nil,
                interactionDisabled: readOnly || !rowEnabled || swipeInteractionDisabled || !model.taskRowSwipeActionsEnabled(displayed)),
                  !Task.isCancelled, identity == swipeReadIdentity else { return }
            swipePublishedRow = displayed; swipePublishedKey = identity; swipeDTO = value
        }
        .overlay(alignment: .leading) {
            if !meta.text("priority").isEmpty {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(hex: model.theme.object("priority").text(meta.text("priority"))))
                    .frame(width: 3).padding(.vertical, 8).padding(.leading, 6)
            }
        }
        .environment(\.layoutDirection, meta.text("textDirection") == "rtl" ? .rightToLeft : .leftToRight)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(meta.text("accessibilityLabel"))
        .modifier(TaskCardSelectionLongPress(identity: row.text("id"), host: swipeHost, enabled: onSelectionStart != nil, action: {
            recordStackSelectionPress()
            onSelectionStart?(row)
        }))
        .confirmationDialog(defaultStatusMenu ? statusOptions.text("title") : (onStatusOptions == nil ? meta.text("statusLabel") : statusOptions.text("title")),
                            isPresented: Binding(get: { statusMenu }, set: {
                                statusMenu = $0; model.navigationReplayLocalCover(navigationReplayCoverID, presented: $0)
                            }), titleVisibility: .visible) {
            if let onStatusChange {
                ForEach(statusOptions.objects("options").indices, id: \.self) { index in
                    let option = statusOptions.objects("options")[index]
                    Button((option.flag("selected") ? "✓ " : "") + option.text("label")) {
                        onStatusChange(statusRow, option.text("status"))
                    }
                        .disabled(model.busy || model.retryNeeded || readOnly || statusRow.flag("readOnly"))
                        .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                        .accessibilityIdentifier("done-status-" + option.text("status"))
                }
            } else {
                ForEach(statusOptions.objects("options").indices, id: \.self) { index in
                    let option = statusOptions.objects("options")[index]
                    Button((option.flag("selected") ? "✓ " : "") + option.text("label")) {
                        selectDefaultStatus(option)
                    }
                    .disabled(model.busy || model.retryNeeded || readOnly || onSelection != nil || statusRow.flag("readOnly")
                              || option.flag("selected") || !model.rowQuickStatusMenuCurrent(navigationReplayCoverID, row: statusRow))
                    .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                    .accessibilityIdentifier(option.text("status") == "done" ? "task-complete" : "task-status-" + option.text("status"))
                }
                if !checklistMoveEntry.isEmpty {
                    Button(checklistMoveEntry.text("title")) {
                        beforeAction?()
                        model.openTaskChecklistMove(statusRow, entry: checklistMoveEntry, presentation: navigationReplayCoverID)
                    }
                    .disabled(model.busy || model.retryNeeded || readOnly || onSelection != nil || statusRow.flag("readOnly")
                              || !model.rowQuickStatusMenuCurrent(navigationReplayCoverID, row: statusRow))
                    .accessibilityIdentifier("task-add-to-checklist")
                }
                if model.rowTaskBackdateAvailable(statusRow, presentation: navigationReplayCoverID) {
                    Button(model.label("task.completedAtPromptTitle")) {
                        beforeAction?()
                        model.openRowTaskBackdate(statusRow, presentation: navigationReplayCoverID)
                    }
                    .disabled(model.busy || model.retryNeeded || readOnly || onSelection != nil || statusRow.flag("readOnly")
                              || !model.rowTaskBackdateAvailable(statusRow, presentation: navigationReplayCoverID))
                    .accessibilityIdentifier("task-status-completion-time")
                }
                if let onMoveToSection, !moveToSectionLabel.isEmpty {
                    Button(moveToSectionLabel) { onMoveToSection() }
                        .disabled(model.busy || model.retryNeeded || readOnly || row.flag("readOnly")
                                  || model.somedayMoveUndoAwaitingRefresh || model.somedayMoveUndoError != nil)
                        .accessibilityIdentifier("task-move-section-" + row.text("id"))
                }
            }
            if model.rowTaskDatesAvailable(statusRow, presentation: navigationReplayCoverID) {
                Button(model.label("filters.taskDates")) {
                    beforeAction?()
                    model.openRowTaskDates(statusRow, presentation: navigationReplayCoverID)
                }
                .disabled(model.busy || model.retryNeeded || readOnly || onSelection != nil || statusRow.flag("readOnly")
                          || !model.rowTaskDatesAvailable(statusRow, presentation: navigationReplayCoverID))
                .accessibilityIdentifier("task-status-dates")
            }
            if model.rowTaskDestinationAvailable(statusRow, presentation: navigationReplayCoverID) {
                Button(model.label("task.moveToProjectOrArea")) {
                    beforeAction?()
                    model.openRowTaskDestination(statusRow, presentation: navigationReplayCoverID)
                }
                .disabled(model.busy || model.retryNeeded || readOnly || onSelection != nil || statusRow.flag("readOnly")
                          || !model.rowTaskDestinationAvailable(statusRow, presentation: navigationReplayCoverID))
                .accessibilityIdentifier("task-status-destination")
            }
            Button(model.label("task.copyTaskLink")) { model.copyTaskReference(row.text("id"), link: true) }
                .accessibilityIdentifier("task-copy-link-" + row.text("id"))
            Button(model.label("task.copyTaskId")) { model.copyTaskReference(row.text("id"), link: false) }
                .accessibilityIdentifier("task-copy-id-" + row.text("id"))
            Button(model.label("common.cancel"), role: .cancel) {}
        }
        .onChange(of: statusMenu) {
            model.taskStatusMenuPresented = $0
            model.navigationReplayLocalCover(navigationReplayCoverID, presented: $0)
            if !$0 {
                model.retireRowTaskDestinationMenu(navigationReplayCoverID)
                model.retireRowTaskDatesMenu(navigationReplayCoverID)
                if defaultStatusMenu { model.retireRowQuickStatusOptions(navigationReplayCoverID) }
            }
        }
        .onChange(of: checklistIdentity) { _ in resetInlineChecklist(); retireDefaultStatusMenu() }
        .onChange(of: InlineChecklistRevision(row: row)) { current in
            retireDefaultStatusMenu()
            checklistView = [:]
            if checklistExpanded { loadInlineChecklist(displayed: current.row) }
        }
        .onChange(of: model.busy) { busy in
            if !busy && checklistExpanded && checklistReadTask == nil
                && checklistView.text("taskRevision") != row.text("taskRevision") && model.inlineChecklistEnabled(row) {
                loadInlineChecklist()
            }
        }
        .onChange(of: onSelection != nil) { selecting in
            if selecting { resetInlineChecklist(); retireDefaultStatusMenu() }
        }
        .onDisappear {
            resetInlineChecklist()
            retireDefaultStatusMenu()
            model.retireRowTaskDestinationMenu(navigationReplayCoverID)
            model.retireRowTaskDatesMenu(navigationReplayCoverID)
            model.navigationReplayLocalCover(navigationReplayCoverID, presented: false)
            let ownsMenu = statusMenu || statusOptionsTask != nil
            statusOptionsTask?.cancel()
            if ownsMenu { model.taskStatusMenuPresented = false }
        }
    }

    private func activateSwipe(_ action: CoreObject, identity: String) {
        guard identity == swipeReadIdentity, identity == swipePublishedKey, swipeEnabled, action.flag("enabled"),
              (swipeDTO.objects("swipeRight") + swipeDTO.objects("swipeLeft")).contains(where: {
                  NSDictionary(dictionary: $0).isEqual(to: action)
              }) else { return }
        let displayed = swipePublishedRow
        guard let activation = model.captureTaskRowSwipeActivation(displayed) else { return }
        swipeCloseGeneration += 1
        if action.text("id") == "organize" {
            if let onSwipeOrganize {
                beforeAction?()
                guard model.taskRowSwipeActivationCurrent(activation, row: displayed) else { return }
                onSwipeOrganize(displayed)
            }
            else { openRowStatusMenu(displayed, activation: activation) }
            return
        }
        beforeAction?()
        guard model.taskRowSwipeActivationCurrent(activation, row: displayed) else { return }
        switch action.text("id") {
        case "done": Task { await model.completeTaskRowSwipe(displayed, activation: activation) }
        case "focus": Task { await model.focusRowTask(displayed, focused: !action.flag("focused"), activation: activation) }
        case "dates": model.openRowTaskDatesFromSwipe(displayed)
        case "delete":
            resetInlineChecklist()
            if let onSwipeDelete { onSwipeDelete(displayed) }
            else { Task { await model.deleteRowTask(displayed, activation: activation) } }
        case "restore", "next":
            guard !action.text("status").isEmpty else { return }
            if let onSwipeNext { onSwipeNext(displayed) }
            else if let onStatusChange { onStatusChange(displayed, action.text("status")) }
            else { Task { await model.changeTaskRowSwipeStatus(displayed, status: action.text("status"), activation: activation) } }
        default: break
        }
    }

    private func openRowStatusMenu(_ displayed: CoreObject, activation: CoreModel.TaskRowSwipeActivation? = nil) {
        guard !model.taskStatusMenuPresented, onSelection == nil, !readOnly, !displayed.flag("readOnly"),
              model.taskRowSwipeRowCurrent(displayed) else { return }
        beforeAction?()
        if let activation, !model.taskRowSwipeActivationCurrent(activation, row: displayed) { return }
        model.taskStatusMenuPresented = true
        model.retainRowTaskDestinationMenu(displayed, presentation: navigationReplayCoverID)
        model.retainRowTaskDatesMenu(displayed, presentation: navigationReplayCoverID)
        if let onStatusOptions {
            let identity = checklistIdentity, readID = UUID()
            defaultStatusReadID = readID; statusRow = displayed
            statusOptionsTask = Task {
                defer { if defaultStatusReadID == readID { statusOptionsTask = nil } }
                if let options = await onStatusOptions(displayed) {
                    guard !Task.isCancelled, defaultStatusReadID == readID, identity == checklistIdentity,
                          onSelection == nil, !readOnly, model.taskRowSwipeRowCurrent(displayed) else { return }
                    statusOptions = options
                    statusMenu = true; model.navigationReplayLocalCover(navigationReplayCoverID, presented: true)
                } else if defaultStatusReadID == readID, identity == checklistIdentity {
                    model.retireRowTaskDestinationMenu(navigationReplayCoverID)
                    model.retireRowTaskDatesMenu(navigationReplayCoverID)
                    model.taskStatusMenuPresented = false
                }
            }
        } else { readDefaultStatusOptions() }
    }

    private func readDefaultStatusOptions() {
        let displayed = row, identity = checklistIdentity, readID = UUID()
        defaultStatusReadID = readID; defaultStatusMenu = true
        statusRow = displayed; statusOptions = [:]; checklistMoveEntry = [:]
        statusOptionsTask = Task {
            var presented = false
            defer {
                if defaultStatusReadID == readID {
                    statusOptionsTask = nil
                    if !presented {
                        model.retireRowQuickStatusOptions(navigationReplayCoverID)
                        model.retireRowTaskDestinationMenu(navigationReplayCoverID)
                        model.retireRowTaskDatesMenu(navigationReplayCoverID)
                        model.taskStatusMenuPresented = false
                    }
                }
            }
            if let options = await model.readRowQuickStatusOptions(displayed, presentation: navigationReplayCoverID) {
                guard !Task.isCancelled, defaultStatusReadID == readID, identity == checklistIdentity,
                      onSelection == nil, !readOnly, model.rowQuickStatusMenuCurrent(navigationReplayCoverID, row: displayed) else { return }
                guard let entry = await model.readTaskChecklistMoveEntry(displayed, presentation: navigationReplayCoverID),
                      !Task.isCancelled, defaultStatusReadID == readID, identity == checklistIdentity,
                      onSelection == nil, !readOnly, model.rowQuickStatusMenuCurrent(navigationReplayCoverID, row: displayed) else { return }
                checklistMoveEntry = entry
                statusOptions = options; presented = true
                statusMenu = true; model.navigationReplayLocalCover(navigationReplayCoverID, presented: true)
            }
        }
    }

    private func selectDefaultStatus(_ option: CoreObject) {
        guard !option.flag("selected"), onSelection == nil, !readOnly, !statusRow.flag("readOnly"),
              model.rowQuickStatusMenuCurrent(navigationReplayCoverID, row: statusRow) else { return }
        beforeAction?()
        let displayed = statusRow
        if option.text("status") == "done" {
            model.retireRowQuickStatusOptions(navigationReplayCoverID)
            model.taskStatusMenuPresented = false
            Task { await model.complete(displayed.text("id"), taskRevision: displayed.text("taskRevision")) }
        } else {
            model.changeRowQuickStatus(displayed, options: statusOptions, status: option.text("status"), presentation: navigationReplayCoverID)
        }
    }

    private func retireDefaultStatusMenu() {
        guard defaultStatusMenu else { return }
        let ownsMenu = statusMenu || statusOptionsTask != nil
        defaultStatusReadID = UUID(); statusOptionsTask?.cancel(); statusOptionsTask = nil
        model.retireRowQuickStatusOptions(navigationReplayCoverID)
        model.retireRowTaskDestinationMenu(navigationReplayCoverID)
        model.retireRowTaskDatesMenu(navigationReplayCoverID)
        statusMenu = false; defaultStatusMenu = false; statusOptions = [:]; checklistMoveEntry = [:]
        if ownsMenu { model.taskStatusMenuPresented = false }
    }

    private struct InlineChecklistEntry: Identifiable {
        let value: CoreObject
        var id: Data { Data(value.text("id").utf8) }
    }

    private struct InlineChecklistRevision: Equatable {
        let row: CoreObject
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.row.text("taskRevision") == rhs.row.text("taskRevision") }
    }

    private var inlineChecklistContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(checklistSection.objects("items").map { InlineChecklistEntry(value: $0) }) { item in
                let entry = item.value
                Button {
                    beforeAction?(); checklistInputFocused = false
                    let displayed = row, view = checklistView
                    Task { await model.submitInlineChecklist(displayed, view: view, itemID: entry.text("id"), completed: !entry.flag("completed")) }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        NativeMarkdownChecklistMarker(bullet: false, completed: entry.flag("completed"), palette: palette)
                            .frame(width: 44, height: 44)
                        Text(NativeMarkdownInline.attributedText(entry.objects("inline"), labels: checklistView.object("markdownLabels"), palette: palette))
                            .rnFont(14).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!checklistWritable)
                .accessibilityLabel(entry.text("title"))
                .accessibilityValue(model.label(entry.flag("completed") ? "common.done" : "status.active"))
                .accessibilityAddTraits(entry.flag("completed") ? .isSelected : [])
                .accessibilityIdentifier("task-inline-checklist-toggle-" + row.text("id") + "-" + entry.text("id"))
            }
            if checklistReadTask != nil {
                Text(model.label("common.loading")).rnFont(14).foregroundStyle(palette.secondary)
            }
            if let checklistError {
                Text(checklistError).rnFont(14).foregroundStyle(palette.secondary)
                Button(model.label("common.retry")) { beforeAction?(); loadInlineChecklist() }
                    .buttonStyle(.plain).frame(minHeight: 44).disabled(!model.inlineChecklistEnabled(row))
            }
            if checklistSection.objects("items").count < checklistSection.number("total") {
                Button(model.label("common.more")) {
                    beforeAction?(); checklistInputFocused = false
                    loadInlineChecklist(more: true)
                }
                .buttonStyle(.plain).frame(minHeight: 44).disabled(checklistReadTask != nil || !model.inlineChecklistEnabled(row))
            }
            if !readOnly && !row.flag("readOnly") && !checklistView.flag("readOnly"), !checklistSection.object("add").isEmpty {
                let add = checklistSection.object("add")
                HStack(spacing: 8) {
                    TextField(add.text("placeholder"), text: $checklistInput)
                        .rnFont(16).padding(12).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .focused($checklistInputFocused).submitLabel(.done)
                        .onSubmit { submitInlineChecklistInput() }
                        .accessibilityLabel(add.text("label"))
                        .accessibilityIdentifier("task-inline-checklist-input-" + row.text("id"))
                    Button(add.text("label")) { submitInlineChecklistInput() }
                        .buttonStyle(.plain).frame(minWidth: 44, minHeight: 44)
                        .disabled(checklistInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("task-inline-checklist-add-" + row.text("id"))
                }
                .disabled(!checklistWritable)
            }
        }
        .padding(.top, 4)
    }

    private func submitInlineChecklistInput() {
        guard checklistWritable, !checklistInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        beforeAction?(); checklistInputFocused = false
        let displayed = row, view = checklistView, input = checklistInput, identity = checklistIdentity
        Task {
            let accepted = await model.submitInlineChecklist(displayed, view: view, title: input)
            if accepted && identity == checklistIdentity && checklistInput == input { checklistInput = "" }
        }
    }

    private func loadInlineChecklist(more: Bool = false, displayed current: CoreObject? = nil) {
        cancelInlineChecklistRead()
        let readID = UUID(), identity = checklistIdentity, context = model.taskCardPresentationContext, displayed = current ?? row
        let previous = more ? checklistView : nil
        checklistReadID = readID; checklistError = nil
        checklistReadTask = Task {
            defer { if checklistReadID == readID { checklistReadTask = nil } }
            do {
                let view = try await model.readInlineChecklist(displayed, context: context, previous: previous)
                guard !Task.isCancelled, checklistReadID == readID, checklistExpanded, identity == checklistIdentity else { return }
                checklistView = view
            } catch is CancellationError {} catch {
                guard !Task.isCancelled, checklistReadID == readID, checklistExpanded, identity == checklistIdentity else { return }
                checklistError = error.localizedDescription
            }
        }
    }

    private func cancelInlineChecklistRead() {
        checklistReadID = UUID(); checklistReadTask?.cancel(); checklistReadTask = nil
    }

    private func resetInlineChecklist() {
        cancelInlineChecklistRead(); checklistExpanded = false; checklistView = [:]
        checklistInput = ""; checklistError = nil; checklistInputFocused = false
    }

    private var selectionPressJustStarted: Bool { Date().timeIntervalSince(selectionPressStartedAt) < 1.5 }

    private func recordStackSelectionPress() {
        guard swipeHost == .local else { return }
        if #available(iOS 18.0, *) { return }
        selectionPressStartedAt = Date()
    }

    private func openTask() {
        if selectionPressJustStarted { return }
        if let onSelection { onSelection(row); return }
        beforeAction?()
        Task { await model.openTask(row.text("id")) }
    }

    private func openDescriptionURL(_ url: URL) -> OpenURLAction.Result {
        guard model.workspaceAdmissionsOpen else { return .discarded }
        if url.scheme == "mindwtr-native-row", url.host == "reference",
           let index = Int(url.lastPathComponent),
           url.absoluteString == "mindwtr-native-row://reference/\(index)" {
            let runs = meta.object("description").objects("inline")
            guard runs.indices.contains(index), runs[index].text("type") == "link" else { return .discarded }
            let target = runs[index].object("target")
            beforeAction?()
            if target.text("kind") == "task" {
                Task { await model.openTask(target.text("id"), descriptionSourceID: row.text("id")) }
            } else if target.text("kind") == "project" {
                Task { await model.openProject(["id": target.text("id")],
                                               descriptionSourceID: row.text("id")) }
            } else { return .discarded }
            return .handled
        }
        if let scheme = url.scheme?.lowercased(), ["upnote", "obsidian"].contains(scheme),
           let original = NativeMarkdownLinkURL.originalHref(url, runs: meta.object("description").objects("inline")) {
            Task {
                await NativeNoteAppLink.open(original, surface: "markdown", admission: { model.workspaceAdmissionsOpen }) { opened in
                    await model.recordNoteAppHandoff(opened ? "opened" : "failed", surface: "markdown", scheme: scheme)
                    if !opened { NativeNoteAppLink.showFailure(original, labels: model.strings, admission: { model.workspaceAdmissionsOpen }) }
                }
            }
            return .handled
        }
        return ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
    }

    private var focusBlockedReason: String {
        row.flag("isFocusedToday") ? "" : row.text("focusBlockedLabel")
    }

    private var titleContent: some View {
        HStack(spacing: 8) {
            Text(row.text("title")).rnFont(15, .medium)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
                .frame(minHeight: 44).contentShape(Rectangle()).onTapGesture { openTask() }
                .accessibilityIdentifier("task-title-" + row.text("id"))
                .accessibilityAction { openTask() }
            if !showDetails && !meta.text("descriptionPreview").isEmpty {
                Image(systemName: "text.alignleft").font(.system(size: 12)).foregroundStyle(palette.secondary)
                    .accessibilityLabel(model.label("taskEdit.descriptionLabel"))
                    .accessibilityIdentifier("task-description-cue-" + row.text("id"))
            }
            if !showDetails, let recurrence = meta.objects("parts").first(where: { $0.text("kind") == "recurrence" }) {
                Image(systemName: "repeat").font(.system(size: 12)).foregroundStyle(palette.secondary)
                    .accessibilityLabel(model.label("taskEdit.recurrenceLabel")).accessibilityValue(recurrence.text("text"))
                    .accessibilityIdentifier("task-recurrence-cue-" + row.text("id"))
            }
            if showFocusToggle, meta.flag("canFocus"), !readOnly, !row.flag("readOnly") {
                Button {
                    beforeAction?()
                    Task { await model.setTaskFocus(row) }
                } label: {
                    AppFocusStar(focused: row.flag("isFocusedToday"), palette: palette, size: 20)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.taskFocusInputEnabled(row) || !focusBlockedReason.isEmpty)
                .accessibilityLabel(focusBlockedReason.isEmpty
                    ? model.label(row.flag("isFocusedToday") ? "agenda.removeFromFocus" : "agenda.addToFocus")
                    : focusBlockedReason)
                .accessibilityIdentifier("task-focus-" + row.text("id"))
            }
        }
    }

    private func scheduleIconColor(_ part: CoreObject) -> Color {
        if part.text("kind") == "due" && part.text("tone") == "overdue" { return palette.danger }
        if part.text("kind") == "due" && part.text("tone") == "dueSoon" { return palette.warning }
        return palette.secondary
    }

    private func metadata(_ parts: [CoreObject]) -> AttributedString {
        var result = AttributedString()
        for (index, part) in parts.enumerated() {
            if index > 0 { result += AttributedString("   ") }
            let kind = part.text("kind")
            if kind == "project" || kind == "area" {
                var dot = AttributedString("● ")
                dot.foregroundColor = palette.einkSafe(part.text("dotColor").isEmpty ? palette.tint : Color(hex: part.text("dotColor")))
                result += dot
            }
            var text = AttributedString(part.text("text") + (part.number("overflowCount") > 0 ? " +\(part.number("overflowCount"))" : ""))
            if kind == "context" { text.foregroundColor = Color(hex: "3B82F6") }
            else if kind == "assignedTo" {
                text.foregroundColor = palette.text
                text.swiftUI.font = .system(size: assignedToFontSize, weight: .semibold)
            }
            else if kind == "due" && part.text("tone") == "overdue" { text.foregroundColor = palette.danger }
            else if kind == "dateIssue" || kind == "projectDeadline" || (kind == "due" && part.text("tone") == "dueSoon") { text.foregroundColor = palette.warning }
            else { text.foregroundColor = palette.secondary }
            result += text
        }
        return result
    }
}

struct TaskFocusNotice: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.taskFocusNotice.text("title")).rnFont(14, .semibold)
                Text(model.taskFocusNotice.text("message")).rnFont(13)
                    .accessibilityIdentifier("task-focus-blocked")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { model.dismissTaskFocusNotice() } label: {
                Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(model.label("common.close"))
        }
        .foregroundStyle(palette.warning).padding(.horizontal, 16).padding(.vertical, 8)
        .background(palette.card)
    }
}

struct FailureBanner: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.error ?? model.inboxBulkRetryError ?? "").rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier("persistence-error")
            Button { Task { await model.retry() } } label: {
                Text(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry"))
                    .rnFont(14, .semibold).frame(minHeight: 44).contentShape(Rectangle())
            }
            .disabled(model.busy)
            .accessibilityIdentifier("persistence-retry")
            #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
            .accessibilityValue(model.settingsAIGeminiRetryFixtureValue)
            #endif
            DiagnosticsFailureAction(model: model, palette: palette)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(palette.card)
    }
}


struct DiagnosticsFailureAction: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var diagnosticsOwner = UUID()
    @State private var diagnosticsPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.cachedFailureDiagnosticsAvailable {
                Button {
                    diagnosticsPresented = model.openCachedFailureDiagnostics(owner: diagnosticsOwner)
                } label: {
                    Text(model.diagnosticsLabels.text("title")).rnFont(14, .semibold)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityIdentifier("persistence-diagnostics")
            }
        }
        .sheet(isPresented: $diagnosticsPresented, onDismiss: {
            model.closeDiagnostics(owner: diagnosticsOwner)
        }) {
            VStack(spacing: 0) {
                HStack {
                    Text(model.diagnosticsLabels.text("title")).rnFont(20, .bold)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(model.label("common.close")) {
                        model.closeDiagnostics(owner: diagnosticsOwner)
                        diagnosticsPresented = false
                    }
                    .frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("diagnostics-close")
                }
                .padding(.horizontal, 16).foregroundStyle(palette.text).background(palette.card)
                DiagnosticsCard(model: model, palette: palette, owner: diagnosticsOwner)
            }
            .accessibilityAction(.escape) {
                model.closeDiagnostics(owner: diagnosticsOwner)
                diagnosticsPresented = false
            }
        }
        .onChange(of: model.diagnosticsSession) { session in
            if session == nil || model.diagnosticsOwner != diagnosticsOwner { diagnosticsPresented = false }
        }
    }
}

private struct FocusOrderItem: Identifiable {
    let row: CoreObject
    var id: String { row.text("id") }
}


private struct ReferenceProjectNextActionPrompt: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private let prefix = "reference-project-next-action"
    private var options: CoreObject { model.referenceProjectNextActionOptions }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { model.dismissReferenceProjectNextAction() }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    if !options.isEmpty {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(options.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                                    .accessibilityIdentifier(prefix + "-title")
                                Text(options.text("description")).rnFont(14).fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier(prefix + "-description")
                                if !model.referenceProjectNextActionCandidates.isEmpty {
                                    Text(model.label("projects.nextActionPromptChooseExisting")).rnFont(14, .semibold)
                                    ForEach(Array(model.referenceProjectNextActionCandidates.enumerated()), id: \.offset) { index, candidate in
                                        Button {
                                            Task { await model.performReferenceProjectNextAction("choose", candidate: candidate) }
                                        } label: {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(candidate.text("title")).fixedSize(horizontal: false, vertical: true)
                                                Text(candidate.text("statusLabel")).rnFont(12).foregroundStyle(palette.secondary)
                                            }
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.referenceProjectNextActionControlsEnabled)
                                        .accessibilityIdentifier(prefix + "-candidate-" + String(index))
                                    }
                                }
                                if options.object("candidates").flag("hasMore") {
                                    Button {
                                        Task { await model.readReferenceProjectNextAction(more: true) }
                                    } label: {
                                        Text(model.label("common.more")).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                                    }
                                    .disabled(!model.referenceProjectNextActionControlsEnabled).accessibilityIdentifier(prefix + "-more")
                                }
                                Text(model.label("projects.nextActionPromptAddNew")).rnFont(14, .semibold)
                                TextField(options.object("input").text("placeholder"), text: Binding(
                                    get: { model.referenceProjectNextActionText }, set: model.updateReferenceProjectNextActionText))
                                    .textFieldStyle(.roundedBorder).frame(minHeight: 44)
                                    .disabled(model.referenceProjectNextActionPending || model.busy)
                                    .accessibilityIdentifier(prefix + "-input")
                                actionButton(options.object("input").text("addLabel"), suffix: "add", enabled: model.referenceProjectNextActionCanSave) {
                                    await model.performReferenceProjectNextAction("add")
                                }
                                actionButton(options.object("input").text("saveAndEditLabel"), suffix: "save-edit", enabled: model.referenceProjectNextActionCanSave) {
                                    await model.performReferenceProjectNextAction("add", openAfterSave: true)
                                }
                                if !options.object("completeProject").isEmpty {
                                    actionButton(options.object("completeProject").text("label"), suffix: "complete-project") {
                                        await model.performReferenceProjectNextAction("completeProject")
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .accessibilityIdentifier(prefix + "-scroll")
                    }
                    if model.referenceProjectNextActionReading { ProgressView().accessibilityLabel(model.label("common.loading")) }
                    if let error = model.referenceProjectNextActionError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier(prefix + "-error")
                        Button {
                            Task {
                                if model.referenceProjectNextActionPending { await model.retry() }
                                else { await model.readReferenceProjectNextAction() }
                            }
                        } label: {
                            Text(model.label("common.retry")).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(model.busy || model.referenceProjectNextActionReading)
                        .accessibilityIdentifier(prefix + (model.referenceProjectNextActionPending ? "-retry" : "-read-retry"))
                    }
                    Button { model.dismissReferenceProjectNextAction() } label: {
                        Text(options.object("skip").text("label").isEmpty ? model.label("common.cancel") : options.object("skip").text("label"))
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .disabled(model.busy || model.referenceProjectNextActionPending).accessibilityIdentifier(prefix + "-skip")
                }
                .rnFont(14).padding(16)
                .frame(maxWidth: 860, maxHeight: geometry.size.height * 0.94, alignment: .topLeading)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(palette.border)
                    .allowsHitTesting(false).accessibilityHidden(true))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(prefix + "-prompt")
        .accessibilityAction(.escape) { model.dismissReferenceProjectNextAction() }
    }

    private func actionButton(_ title: String, suffix: String, enabled: Bool = true, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Text(title).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .disabled(!model.referenceProjectNextActionControlsEnabled || !enabled)
        .accessibilityIdentifier(prefix + "-" + suffix)
    }
}

private struct TaskListSortPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let caller: CoreModel.TaskListSortCaller
    private var prefix: String { caller.rawValue }

    private func close() {
        switch caller {
        case .inbox: model.closeInboxSort()
        case .reference: model.closeReferencePanel()
        case .contexts: model.closeContextsSort()
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Button { close() } label: { Color.black.opacity(0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier(prefix + "-sort-dismiss").disabled(model.busy || model.retryNeeded)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Text(model.label("sort.label")).rnFont(17, .bold).frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityAddTraits(.isHeader)
                        Button { close() } label: { AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle()) }
                            .buttonStyle(.plain).accessibilityLabel(model.label("common.close"))
                            .accessibilityIdentifier(prefix + "-sort-close").disabled(model.busy || model.retryNeeded)
                    }
                    .frame(minHeight: 44).padding(.bottom, 12)
                    ViewThatFits(in: .vertical) {
                        TaskListSortChoices(model: model, palette: palette, caller: caller).fixedSize(horizontal: false, vertical: true)
                        ScrollView { TaskListSortChoices(model: model, palette: palette, caller: caller) }
                            .accessibilityIdentifier(prefix + "-sort-scroll")
                    }
                }
                .padding(12).frame(maxWidth: 440, maxHeight: geometry.size.height * 0.82, alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .padding(.horizontal, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { close() }
        }
    }
}

private struct InboxGroupPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Button { model.closeInboxGroup() } label: { Color.black.opacity(0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("inbox-group-dismiss").disabled(model.busy || model.retryNeeded)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Text(model.inbox.object("toolbar").object("group").text("title"))
                            .rnFont(17, .bold).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                        Button { model.closeInboxGroup() } label: {
                            AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityLabel(model.label("common.close"))
                        .accessibilityIdentifier("inbox-group-close").disabled(model.busy || model.retryNeeded)
                    }
                    .frame(minHeight: 44).padding(.bottom, 12)
                    ViewThatFits(in: .vertical) {
                        choices.fixedSize(horizontal: false, vertical: true)
                        ScrollView { choices }.accessibilityIdentifier("inbox-group-scroll")
                    }
                }
                .padding(12).frame(maxWidth: 440, maxHeight: geometry.size.height * 0.82, alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .padding(.horizontal, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { model.closeInboxGroup() }
        }
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error = model.inboxReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("inbox-group-error")
                Button(model.label("common.retry")) { Task { await model.retryInboxGrouping() } }
                    .frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                    .accessibilityIdentifier("inbox-group-retry")
            }
            let options = model.inbox.object("toolbar").object("group").objects("options")
            ForEach(options.indices, id: \.self) { index in
                let choice = options[index]
                Button { Task { await model.setInboxGroup(choice.text("value")) } } label: {
                    HStack(spacing: 8) {
                        Text(choice.text("label")).rnFont(15).frame(maxWidth: .infinity, alignment: .leading)
                        if choice.flag("selected") { AppIcon(name: "check", size: 16) }
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.inboxGroupActionsEnabled)
                .accessibilityAddTraits(choice.flag("selected") ? .isSelected : [])
                .accessibilityIdentifier("inbox-group-" + choice.text("value"))
            }
            if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
        }
    }
}

private struct InboxFiltersModalContent: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var lock: AppLockController
    let palette: AppPalette

    var body: some View {
        Group {
            if lock.concealed {
                palette.bg.ignoresSafeArea().accessibilityHidden(true)
            } else {
                InboxFiltersPanel(model: model, palette: palette).id(model.inboxFilterPresentation)
            }
        }
    }
}

private struct InboxFiltersPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var focusedField: String?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Button { close() } label: { Color.black.opacity(0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("inbox-filters-dismiss")
                ListFilterControls(
                    data: model.inbox, strings: model.strings, palette: palette, prefix: "inbox",
                    enabled: model.inboxFilterControlsEnabled, busy: model.busy, frozen: model.retryNeeded,
                    error: model.inboxReadError,
                    searchText: Binding(get: { model.inboxSearchText }, set: { model.setInboxFilterText($0) }),
                    locationText: Binding(get: { model.inboxLocationText }, set: { model.setInboxFilterText($0, location: true) }),
                    pickerName: model.inboxFilterPickerName, picker: model.inboxFilterPicker,
                    pickerCurrent: model.inboxFilterPickerCurrent, pickerEnabled: model.inboxFilterPickerActionsEnabled,
                    pickerError: model.inboxFilterPickerError,
                    pickerQuery: Binding(get: { model.inboxFilterPickerQuery }, set: model.setInboxFilterPickerQuery),
                    onEdit: { edit in Task { await model.editInboxFilter(edit) } },
                    onChipAction: { action in Task { await model.applyInboxChipAction(action) } },
                    onArchived: { _ in }, onOpenPicker: model.openInboxFilterPicker, onBack: model.closeInboxFilterPicker,
                    onMore: model.loadMoreInboxFilterPicker, onRetry: model.retryInboxFilters,
                    onRetryPicker: model.retryInboxFilterPicker, onClose: close, focusedField: $focusedField)
                    .padding(12).frame(maxWidth: 440, maxHeight: geometry.size.height * 0.9, alignment: .top)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                    .padding(.horizontal, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        }
    }

    private func close() { focusedField = nil; model.closeInboxFilters() }
}

private struct InboxBulkTagDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    private var fields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.inboxBulkTagOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            TextField(model.inboxBulkTagOptions.text("placeholder"), text: Binding(
                get: { model.inboxBulkTagText }, set: { model.setInboxBulkTagText($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.inboxBulkTagOptions.text("placeholder"))
                .accessibilityIdentifier("inbox-bulk-tag-input")
            if let error = model.inboxBulkTagReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("inbox-bulk-tag-read-error")
                Button { model.setInboxBulkTagText(model.inboxBulkTagText) } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("inbox-bulk-tag-read-retry")
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture {
                    if !model.busy && !model.retryNeeded { model.closeInboxBulkTag() }
                }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    if dynamicTypeSize.isAccessibilitySize {
                        ScrollView { fields }
                            .frame(maxHeight: min(420, max(120, geometry.size.height - 132)))
                            .accessibilityIdentifier("inbox-bulk-tag-scroll")
                    } else { fields }
                    HStack {
                        Spacer()
                        Button { model.closeInboxBulkTag() } label: {
                            Text(model.inboxBulkTagOptions.text("cancelLabel")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("inbox-bulk-tag-cancel")
                        Button { Task { await model.saveInboxBulkTag() } } label: {
                            Text(model.inboxBulkTagOptions.text("saveLabel")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkTagSaveEnabled)
                        .accessibilityIdentifier("inbox-bulk-tag-save")
                    }
                }
                .padding(16).frame(maxWidth: 420)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("inbox-bulk-tag-dialog").accessibilityAction(.escape) {
                if !model.busy && !model.retryNeeded { model.closeInboxBulkTag() }
            }
        }
    }
}

private struct InboxBulkRemoveTagDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var focused: Bool

    private var heading: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.inboxBulkRemoveOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            Text(model.inboxBulkRemoveOptions.text("description")).rnFont(13).foregroundStyle(palette.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var queryInput: some View {
        TextField(model.inboxBulkRemoveOptions.text("placeholder"), text: Binding(get: { model.inboxBulkRemoveQuery }, set: { model.setInboxBulkRemoveQuery($0) }))
            .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
            .submitLabel(.done).onSubmit { focused = false }
            .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .accessibilityLabel(model.inboxBulkRemoveOptions.text("placeholder"))
            .disabled(model.busy || model.retryNeeded)
            .accessibilityIdentifier("inbox-bulk-remove-tag-input")
            .fixedSize(horizontal: false, vertical: true).layoutPriority(1)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppChipFlow {
                ForEach(model.inboxBulkRemoveItems.indices, id: \.self) { index in
                    let item = model.inboxBulkRemoveItems[index]
                    let picked = model.inboxBulkRemovePicked(item.text("value"))
                    Button { model.toggleInboxBulkRemove(item.text("value")) } label: {
                        Text(item.text("label")).rnFont(14).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 12).padding(.vertical, 8).frame(minWidth: 44, minHeight: 44)
                            .background(picked ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(picked ? palette.tint : palette.border, lineWidth: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(picked ? palette.onTint : palette.text)
                    .disabled(model.busy || model.retryNeeded || !model.inboxBulkRemoveCurrent || model.inboxBulkRemoveReading)
                    .accessibilityLabel(item.text("label")).accessibilityAddTraits(picked ? .isSelected : [])
                    .accessibilityIdentifier("inbox-bulk-remove-tag-option-\(index)")
                }
            }
            if model.inboxBulkRemoveReading { ProgressView().accessibilityLabel(model.label("common.loading")) }
            if model.inboxBulkRemoveCurrent && model.inboxBulkRemoveTotal == 0 {
                Text(model.label("common.noMatches")).rnFont(14).foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("inbox-bulk-remove-tag-no-matches")
            }
            if model.inboxBulkRemoveItems.count < model.inboxBulkRemoveTotal {
                Button { model.loadMoreInboxBulkRemove() } label: {
                    Text(model.label("common.more")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkRemoveCanLoadMore)
                .accessibilityIdentifier("inbox-bulk-remove-tag-more")
            }
            if let error = model.inboxBulkRemoveReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("inbox-bulk-remove-tag-read-error")
                Button { model.retryInboxBulkRemoveRead() } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded || model.inboxBulkRemoveReading)
                .accessibilityIdentifier("inbox-bulk-remove-tag-read-retry")
            }
        }
    }

    private var actions: some View {
        HStack {
            Spacer()
            Button { model.closeInboxBulkRemove() } label: {
                Text(model.inboxBulkRemoveOptions.text("cancelLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded).accessibilityIdentifier("inbox-bulk-remove-tag-cancel")
            Button { Task { await model.saveInboxBulkRemove() } } label: {
                Text(model.inboxBulkRemoveOptions.text("saveLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.inboxBulkRemoveSaveEnabled)
            .accessibilityIdentifier("inbox-bulk-remove-tag-save")
        }
        .fixedSize(horizontal: false, vertical: true).layoutPriority(1)
    }

    private func contents(scrollingHeading: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !scrollingHeading { heading }
            queryInput
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if scrollingHeading { heading }
                    options
                }
            }
            .scrollDismissesKeyboard(.interactively).frame(minHeight: 44, maxHeight: 480)
            .accessibilityIdentifier("inbox-bulk-remove-tag-scroll")
            actions
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { if !model.busy && !model.retryNeeded { model.closeInboxBulkRemove() } }.accessibilityHidden(true)


                contents(scrollingHeading: dynamicTypeSize.isAccessibilitySize || geometry.size.height < 500)
                .padding(16).frame(maxWidth: 420, maxHeight: max(0, geometry.size.height - 32))
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("inbox-bulk-remove-tag-dialog").accessibilityAction(.escape) { if !model.busy && !model.retryNeeded { model.closeInboxBulkRemove() } }
            .onAppear { focused = true }
        }
    }
}


private struct InboxBulkOrganizeDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var dateField: String?
    @State private var pickerDate = Date()
    private var view: CoreObject { model.inboxBulkOrganizeView }
    private var prefix: String { model.bulkOrganizeIsProject ? "project-organize" : "inbox-organize" }
    private var locked: Bool { !model.inboxBulkOrganizeControlsEnabled }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { model.closeInboxBulkOrganize() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(view.text("title").isEmpty ? model.label("bulk.organize") : view.text("title"))
                            .rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 0)
                        Button { model.closeInboxBulkOrganize() } label: {
                            AppIcon(name: "x", size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.inboxBulkOrganizeCloseEnabled)
                        .accessibilityLabel(view.text("closeLabel").isEmpty ? model.label("common.close") : view.text("closeLabel"))
                        .accessibilityIdentifier(prefix + "-close")
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if !view.text("subtitle").isEmpty {
                                Text(view.text("subtitle")).rnFont(13).foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if model.inboxBulkOrganizePickerKind != nil { AnyView(picker) }
                            else { AnyView(fields) }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .frame(maxHeight: max(120, geometry.size.height - 230))
                    .accessibilityIdentifier(prefix + "-scroll")
                    if model.inboxBulkOrganizeReading || model.busy { ProgressView().frame(maxWidth: .infinity) }
                    if let error = model.inboxBulkOrganizeReadError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier(prefix + "-error")
                        Button {
                            if model.retryNeeded { Task { await model.retry() } }
                            else { model.retryInboxBulkOrganizeRead() }
                        } label: { Text(model.label("common.retry")).frame(minHeight: 44).contentShape(Rectangle()) }
                        .buttonStyle(.plain).disabled(model.busy).accessibilityIdentifier(prefix + "-retry")
                    }
                    HStack {
                        Button {
                            if model.inboxBulkOrganizePickerKind != nil { model.closeInboxOrganizePicker() }
                            else { model.closeInboxBulkOrganize() }
                        } label: {
                            Text(view.text("cancelLabel").isEmpty ? model.label("common.cancel") : view.text("cancelLabel"))
                                .frame(minWidth: 60, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.inboxBulkOrganizeCloseEnabled)
                        .accessibilityIdentifier(prefix + "-cancel")
                        Spacer(minLength: 0)
                        if model.inboxBulkOrganizePickerKind == nil {
                            Button { Task { await model.applyInboxBulkOrganize() } } label: {
                                Text(view.text("applyLabel")).rnFont(14, .semibold).fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 12).frame(minHeight: 44).foregroundStyle(palette.onTint)
                                    .background(palette.tint, in: RoundedRectangle(cornerRadius: 10)).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.inboxBulkOrganizeApplyEnabled)
                            .accessibilityIdentifier(prefix + "-apply")
                        }
                    }
                }
                .padding(16).frame(maxWidth: 480).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { model.closeInboxBulkOrganize() }
        }
        .onChange(of: model.inboxBulkOrganizePickerKind) { _ in dateField = nil }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(view.text("statusLabel")).rnFont(14, .semibold)
            AppChipFlow {
                ForEach(view.objects("statuses").indices, id: \.self) { index in
                    let item = view.objects("statuses")[index]
                    Button { model.editInboxBulkOrganize(item.object("edit")) } label: {
                        Text(item.text("label")).rnFont(14).padding(.horizontal, 12).padding(.vertical, 10)
                            .frame(minHeight: 44).foregroundStyle(item.flag("selected") ? palette.onTint : palette.text)
                            .background(item.flag("selected") ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 12))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(locked)
                    .accessibilityAddTraits(item.flag("selected") ? .isSelected : [])
                    .accessibilityIdentifier(prefix + "-status-" + item.text("value"))
                }
            }
            destination("project"); destination("area")
            if view["waitingFor"] is CoreObject {
                input("delegateWho", part: view.object("waitingFor"))
            }
            ForEach(view.objects("dates").indices, id: \.self) { index in
                AnyView(date(view.objects("dates")[index]))
            }
            input("contexts", part: view.object("contexts"))
            input("tags", part: view.object("tags"))
            if !view.isEmpty && !view.flag("canApply") {
                Text(view.text("validationMessage")).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(prefix + "-validation")
            }
        }
        .padding(.bottom, 8)
    }
    private func destination(_ kind: String) -> some View {
        let part = view.object(kind)
        return Button { model.openInboxOrganizePicker(kind) } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(part.text("label")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                HStack {
                    Text(part.text("value")).rnFont(16).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0); AppIcon(name: "chevron-down", size: 16)
                }
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(palette.input, in: RoundedRectangle(cornerRadius: 10)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(locked || !model.inboxBulkOrganizeCurrent || part.flag("disabled"))
        .accessibilityLabel(part.text("accessibilityLabel")).accessibilityIdentifier(prefix + "-" + kind)
    }
    private func input(_ field: String, part: CoreObject) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(part.text("label")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
            TextField(part.text("placeholder"), text: Binding(
                get: { model.inboxBulkOrganizeInputs[field] ?? part.text("value") },
                set: { model.setInboxBulkOrganizeText(field, value: $0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).disabled(locked)
                .accessibilityLabel(part.text("label")).accessibilityIdentifier(prefix + "-" + field)
        }
    }
    private func date(_ part: CoreObject) -> some View {
        let field = part.text("field")
        return VStack(alignment: .leading, spacing: 8) {
            input(field, part: part)
            AppChipFlow {
                ForEach(part.objects("quickDates").indices, id: \.self) { index in
                    let quick = part.objects("quickDates")[index]
                    Button { model.editInboxBulkOrganize(quick.object("edit")) } label: {
                        Text(quick.text("label")).rnFont(14).padding(.horizontal, 12).frame(minHeight: 44)
                            .foregroundStyle(quick.flag("selected") ? palette.onTint : palette.text)
                            .background(quick.flag("selected") ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(locked).accessibilityLabel(quick.text("accessibilityLabel"))
                    .accessibilityIdentifier(prefix + "-" + field + "-" + quick.text("preset"))
                }
                Button {
                    guard let date = TaskDatePickerComponents.date(["date": part.text("pickerStart"), "time": "12:00"]) else { return }
                    pickerDate = date; dateField = field
                } label: { AppIcon(name: "calendar", size: 18).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain).disabled(locked).accessibilityLabel(part.text("calendarAccessibilityLabel"))
                .accessibilityIdentifier(prefix + "-" + field + "-calendar")
            }
            if dateField == field {
                DatePicker(part.text("label"), selection: Binding(get: { pickerDate }, set: { value in
                    let next = TaskDatePickerComponents.string(value, time: false)
                    let previous = TaskDatePickerComponents.string(pickerDate, time: false)
                    pickerDate = value
                    if next != previous { model.setInboxBulkOrganizeText(field, value: next) }
                }), displayedComponents: .date)
                    .datePickerStyle(.graphical).labelsHidden().disabled(locked)
                    .accessibilityIdentifier(prefix + "-" + field + "-picker")
                Button { dateField = nil } label: { Text(part.text("doneText")).frame(minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).disabled(locked).accessibilityLabel(part.text("doneLabel"))
                    .accessibilityIdentifier(prefix + "-" + field + "-done")
            }
        }
    }
    private var picker: some View {
        let items = model.inboxBulkOrganizePickerItems
        return VStack(alignment: .leading, spacing: 8) {
            TextField(model.label("common.search"), text: Binding(
                get: { model.inboxBulkOrganizePickerQuery }, set: { model.setInboxOrganizePickerQuery($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
                .onSubmit { Task { await model.submitInboxOrganizePicker() } }
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .disabled(locked).accessibilityLabel(model.label("common.search"))
                .accessibilityIdentifier(prefix + "-picker-search")
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    Button { model.chooseInboxOrganizePicker(item) } label: {
                        HStack {
                            Text(item.text("label")).rnFont(16).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            if item.flag("selected") { Image(systemName: "checkmark").foregroundStyle(palette.tint) }
                        }
                        .padding(10).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(locked || !model.inboxBulkOrganizePickerCurrent || model.inboxBulkOrganizePickerReading)
                    .accessibilityAddTraits(item.flag("selected") ? .isSelected : [])
                    .accessibilityIdentifier(prefix + "-picker-choice-" + String(index))
                }
            }
            if !model.inboxBulkOrganizePicker.object("create").isEmpty {
                Button { Task { await model.createInboxOrganizePickerChoice() } } label: {
                    Text(model.inboxBulkOrganizePicker.object("create").text("label")).rnFont(16)
                        .fixedSize(horizontal: false, vertical: true).padding(10).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(locked || !model.inboxBulkOrganizePickerCurrent || model.inboxBulkOrganizePickerReading)
                .accessibilityLabel(model.inboxBulkOrganizePicker.object("create").text("accessibilityLabel"))
                .accessibilityIdentifier(prefix + "-picker-create")
            }
            if model.inboxBulkOrganizePickerReading { ProgressView().frame(maxWidth: .infinity) }
            if let error = model.inboxBulkOrganizePickerError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
                Button { model.retryInboxOrganizePicker() } label: { Text(model.label("common.retry")).frame(minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).disabled(locked || model.inboxBulkOrganizePickerReading)
                    .accessibilityIdentifier(prefix + "-picker-retry")
            } else if model.inboxOrganizePickerCanLoadMore {
                Button { model.loadMoreInboxOrganizePicker() } label: { Text(model.label("common.more")).frame(minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityIdentifier(prefix + "-picker-more")
            }
        }
    }
}

private struct TaskChecklistMoveDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var searchFocused: Bool
    private var frozen: Bool { model.busy || model.retryNeeded || model.taskChecklistMovePending }
    private var options: CoreObject { model.taskChecklistMoveOptions }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    Text(options.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                    TextField(options.text("searchPlaceholder"), text: Binding(
                        get: { model.taskChecklistMoveQuery }, set: model.setTaskChecklistMoveQuery))
                        .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                        .focused($searchFocused).padding(12).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .accessibilityLabel(options.text("searchPlaceholder"))
                        .accessibilityIdentifier("checklist-move-search").disabled(frozen)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(model.taskChecklistMoveItems.indices, id: \.self) { index in
                                let target = model.taskChecklistMoveItems[index]
                                Button {
                                    guard !frozen, model.taskChecklistMovePickerCurrent else { return }
                                    searchFocused = false
                                    Task { await model.chooseTaskChecklistMoveTarget(target) }
                                } label: {
                                    HStack {
                                        Text(target.text("title")).rnFont(16).multilineTextAlignment(.leading)
                                        Spacer()
                                        if target.number("totalCount") > 0 {
                                            Text(String(target.number("completedCount")) + "/" + String(target.number("totalCount")))
                                                .rnFont(13).foregroundStyle(palette.secondary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 8).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(frozen || model.taskChecklistMoveReading || !model.taskChecklistMovePickerCurrent)
                                .accessibilityIdentifier("checklist-move-target-" + target.text("id"))
                            }
                            if model.taskChecklistMoveReading { ProgressView() }
                            if model.taskChecklistMovePickerCurrent, model.taskChecklistMoveItems.isEmpty, !model.taskChecklistMoveReading {
                                Text(options.text("noMatchesLabel")).rnFont(14).foregroundStyle(palette.secondary)
                                    .accessibilityIdentifier("checklist-move-empty")
                            }
                            if options.flag("hasMore"), model.taskChecklistMovePickerCurrent {
                                Button(model.label("common.more")) { model.readTaskChecklistMoveOptions(more: true) }
                                    .frame(minHeight: 44).disabled(frozen || model.taskChecklistMoveReading)
                                    .accessibilityIdentifier("checklist-move-more")
                            }
                            if let message = model.taskChecklistMoveError {
                                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("checklist-move-error")
                                Button(model.label("common.retry")) {
                                    if model.taskChecklistMovePending { Task { await model.retry() } }
                                    else { model.readTaskChecklistMoveOptions() }
                                }
                                .frame(minHeight: 44).disabled(model.busy || model.taskChecklistMoveReading)
                                .accessibilityIdentifier("checklist-move-retry")
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .frame(maxHeight: max(120, min(dynamicTypeSize.isAccessibilitySize ? .infinity : 420, geometry.size.height - 180)))
                    .accessibilityIdentifier("checklist-move-scroll")
                    HStack {
                        Spacer()
                        Button(action: cancel) { Text(options.text("cancelLabel")).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle()) }
                            .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(frozen)
                            .accessibilityIdentifier("checklist-move-cancel")
                    }
                }
                .padding(16).frame(maxWidth: 480).foregroundStyle(palette.text)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { cancel() }
        }
    }
    private func cancel() {
        guard !frozen else { return }
        searchFocused = false; model.cancelTaskChecklistMove()
    }
}
