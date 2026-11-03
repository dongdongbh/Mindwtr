import SwiftUI

struct HistoryScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var searchFocused: Bool
    @State private var archiveDeleteID = ""
    @State private var archiveDeleteRevision = ""
    @State private var archiveDeletePresented = false
    @State private var archiveProjectDeleteID = ""
    @State private var archiveProjectDeleteRevision = ""
    @State private var archiveProjectDeleteConfirmation: CoreObject = [:]
    @State private var archiveProjectDeletePresented = false
    @State private var archiveBulkDeletePresented = false
    @State private var completedAtRow: CoreObject = [:]
    @State private var completedAtOptions: CoreObject = [:]
    @State private var completedAtOptionsTask: Task<Void, Never>?
    @State private var completedAtError = false
    @State private var completedAtArchived = false
    @State private var completedAtGroup = "none"

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(model.historyTabs.objects("tabs").indices, id: \.self) { index in
                        let tab = model.historyTabs.objects("tabs")[index]
                        Button {
                            searchFocused = false
                            Task { await model.selectHistoryTab(tab.text("id")) }
                        } label: {
                            Text(tab.text("label")).rnFont(14, .bold).multilineTextAlignment(.center)
                                .foregroundStyle(tab.flag("selected") ? palette.tint : palette.secondary)
                                .frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, 2)
                                .overlay(alignment: .bottom) { (tab.flag("selected") ? palette.tint : .clear).frame(height: 2) }
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || !model.historyCurrent || !model.archiveBulkDeleteConfirmation.isEmpty)
                        .accessibilityAddTraits(tab.flag("selected") ? .isSelected : [])
                        .accessibilityIdentifier("history-tab-" + tab.text("id"))
                    }
                }
                .padding(.horizontal, 12).background(palette.card)
                .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
                if model.historyArchived { archiveContent }
                else {
                    if model.historyDoneSelectionMode { doneBulkDeleteBar }
                    StatusListContent(model: model, palette: palette, data: model.history, prefix: "done",
                                      current: model.historyCurrent, enabled: model.historyActionsEnabled,
                                      error: model.historyError, disableStatus: false,
                                      onRetry: { Task { await model.retryHistory() } },
                                      onMore: { Task { await model.loadMoreHistory() } },
                                      onFilters: { model.setHistoryPanel("filters") },
                                      onChipAction: { action in Task { await model.applyHistoryChipAction(action) } },
                                      onClear: clearFilters,
                                      onCollapse: { id in Task { await model.toggleHistorySection(id) } },
                                      onDeleteTask: { id, revision in
                                          completedAtError = false
                                          Task { await model.deleteDoneTask(expectedID: id, expectedRevision: revision) }
                                      },
                                      onStatusOptions: { row in await model.doneTaskStatusOptions(row) },
                                      onStatusChange: { row, status in
                                          completedAtError = false
                                          Task { await model.changeDoneTaskStatus(row, status: status) }
                                      }, onCompletedAt: { openCompletedAt($0) },
                                      errorIdentifier: model.doneBulkRemoveWriteError ? "done-bulk-remove-tag-error" : model.doneBulkTagWriteError ? "done-bulk-tag-error" : completedAtError ? "done-completed-at-error" : nil,
                                      selectionActive: model.historyDoneSelectionMode, selectedTaskIDs: model.historyDoneSelectedIDs,
                                      onSelection: { row in Task { await model.selectDoneTask(row) } },
                                      onSelectionStart: { row in Task { await model.selectDoneTask(row) } })
                }
            }
            .accessibilityHidden(!completedAtOptions.isEmpty || model.doneBulkTagPresented || model.doneBulkRemovePresented)
            if !completedAtOptions.isEmpty {
                HistoryTaskCompletedAtDialog(model: model, palette: palette, options: completedAtOptions,
                                            prefix: completedAtArchived ? "archive" : "done", close: closeCompletedAt, save: saveCompletedAt)
            }
            if model.doneBulkTagPresented { HistoryDoneBulkTagDialog(model: model, palette: palette) }
            if model.doneBulkRemovePresented { HistoryDoneBulkRemoveTagDialog(model: model, palette: palette) }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .history else { return }
                await model.refresh()
            }
        }
        .alert(model.history.object("confirmations").object("trashTask").text("title"), isPresented: $archiveDeletePresented) {
            Button(model.history.object("confirmations").object("trashTask").text("cancelLabel"), role: .cancel) {}
            Button(model.history.object("confirmations").object("trashTask").text("confirmLabel"), role: .destructive) {
                let id = archiveDeleteID
                let revision = archiveDeleteRevision
                Task { await model.deleteArchivedTask(expectedID: id, expectedRevision: revision) }
            }
            .accessibilityIdentifier("archive-delete-confirm")
        } message: {
            Text(model.history.object("confirmations").object("trashTask").text("message"))
        }
        .alert(archiveProjectDeleteConfirmation.text("title"), isPresented: $archiveProjectDeletePresented) {
            Button(archiveProjectDeleteConfirmation.text("cancelLabel"), role: .cancel) {}
            Button(archiveProjectDeleteConfirmation.text("confirmLabel"), role: .destructive) {
                let id = archiveProjectDeleteID
                let revision = archiveProjectDeleteRevision
                Task { await model.deleteArchivedProject(expectedID: id, expectedRevision: revision) }
            }
            .accessibilityIdentifier("archive-delete-confirm")
        } message: {
            Text(archiveProjectDeleteConfirmation.text("message"))
        }
        .alert(model.archiveBulkDeleteConfirmation.text("title"), isPresented: $archiveBulkDeletePresented) {
            Button(model.archiveBulkDeleteConfirmation.text("cancelLabel"), role: .cancel) {
                model.cancelArchiveBulkDeleteConfirmation()
            }
            .accessibilityIdentifier(model.historyArchived ? "archive-bulk-delete-cancel" : "done-bulk-delete-cancel")
            Button(model.archiveBulkDeleteConfirmation.text("confirmLabel"), role: .destructive) {
                Task { await model.confirmDeleteSelectedArchiveTasks() }
            }
            .accessibilityIdentifier(model.historyArchived ? "archive-bulk-delete-confirm" : "done-bulk-delete-confirm")
        } message: {
            Text(model.archiveBulkDeleteConfirmation.text("message"))
        }
        .onDisappear {
            closeCompletedAt()
            model.closeDoneBulkTag()
            model.closeDoneBulkRemove()
            archiveBulkDeletePresented = false
            model.cancelArchiveBulkDeleteConfirmation()
            model.leaveArchiveTaskSelection()
            model.leaveDoneTaskSelection()
        }
        .onChange(of: model.archiveBulkDeleteConfirmation.isEmpty) { if $0 { archiveBulkDeletePresented = false } }
        .onChange(of: model.historyArchived) { _ in closeCompletedAt() }
        .onChange(of: model.history.text("segment")) { _ in closeCompletedAt() }
        .onChange(of: model.historyArchiveSelectionMode) { if $0 { closeCompletedAt() } }
        .onChange(of: model.historyDoneSelectionMode) { if $0 { closeCompletedAt() } }
    }

    private func openCompletedAt(_ displayed: CoreObject, archived: Bool = false, group: String = "none") {
        guard model.historyActionsEnabled, model.historyArchived == archived, !archiveSelectionActive,
              !model.historyDoneSelectionMode, !model.taskStatusMenuPresented,
              completedAtOptionsTask == nil else { return }
        searchFocused = false
        completedAtError = false
        completedAtRow = displayed
        completedAtArchived = archived
        completedAtGroup = group
        model.taskStatusMenuPresented = true
        completedAtOptionsTask = Task {
            defer { completedAtOptionsTask = nil }
            let options = archived ? await model.archiveTaskCompletedAtOptions(displayed)
                : await model.doneTaskCompletedAtOptions(displayed)
            guard !Task.isCancelled else { return }
            if let options { completedAtOptions = options }
            else {
                completedAtError = model.historyError != nil
                model.taskStatusMenuPresented = false
            }
        }
    }

    private func closeCompletedAt() {
        let ownsDialog = completedAtOptionsTask != nil || !completedAtOptions.isEmpty
        completedAtOptionsTask?.cancel()
        completedAtOptions = [:]
        if ownsDialog { model.taskStatusMenuPresented = false }
    }

    private func saveCompletedAt(_ instant: String) {
        let displayed = completedAtRow
        let archived = completedAtArchived
        closeCompletedAt()
        Task {
            completedAtError = archived ? !(await model.changeArchiveTaskCompletedAt(displayed, completedAt: instant))
                : !(await model.changeDoneTaskCompletedAt(displayed, completedAt: instant))
        }
    }

    private var archiveContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach(model.history.objects("segments").indices, id: \.self) { index in
                    let segment = model.history.objects("segments")[index]
                    Button {
                        searchFocused = false
                        Task { await model.setHistoryOption("segment", value: segment.text("id")) }
                    } label: {
                        Text(segment.text("label")).rnFont(12, .semibold).multilineTextAlignment(.center)
                            .foregroundStyle(segment.flag("selected") ? palette.onTint : palette.text)
                            .padding(.horizontal, 12).frame(minHeight: 44)
                            .background(segment.flag("selected") ? palette.tint : palette.filter, in: Capsule())
                            .overlay(Capsule().stroke(palette.border, lineWidth: 1)).contentShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
                    .accessibilityAddTraits(segment.flag("selected") ? .isSelected : [])
                    .accessibilityIdentifier("archive-segment-" + segment.text("id"))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
            if !model.history.object("search").isEmpty {
                VStack(spacing: 8) {
                    if dynamicTypeSize.isAccessibilitySize {
                        archiveSearchField
                        HStack { archiveSearchTools; Spacer(minLength: 0) }
                    } else { HStack(spacing: 8) { archiveSearchField; archiveSearchTools } }
                }
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
            if model.historyCurrent && model.history.text("segment") == "tasks" {
                archiveSelectionSummary
                if model.historyArchiveSelectionMode { archiveBulkRestoreBar }
            }
            List {
                Group {
                    if let error = model.historyError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier(completedAtError ? "archive-completed-at-error" : "archive-error")
                        Button(model.label("common.retry")) { Task { await model.retryHistory() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy || (model.retryNeeded && !model.historyArchiveActionPending))
                            .accessibilityIdentifier("archive-retry")
                    }
                    if model.historyCurrent {
                        if model.history.text("segment") != "tasks", !model.history.text("summary").isEmpty {
                            Text(model.history.text("summary")).rnFont(13, .medium).foregroundStyle(palette.secondary)
                                .padding(.top, 4).accessibilityIdentifier("archive-summary")
                        }
                        ForEach(model.history.objects("items").map(ListRowEntry.init)) { entry in
                            let item = entry.item
                            if item.text("type") == "section" { archiveSection(item) }
                            else if item.text("type") == "task" {
                                archiveCard(item)
                                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                        if model.historyArchiveRowActionsEnabled {
                                            Button {
                                                searchFocused = false
                                                Task { await model.restoreArchivedTask(item.object("row").text("id")) }
                                            } label: {
                                                Label(model.history.object("labels").text("restore"), systemImage: "arrow.counterclockwise")
                                            }
                                            .tint(palette.tint)
                                            .accessibilityIdentifier("archive-restore-" + item.object("row").text("id"))
                                        }
                                    }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        if model.historyArchiveRowActionsEnabled {
                                            Button {
                                                searchFocused = false
                                                archiveDeleteID = item.object("row").text("id")
                                                archiveDeleteRevision = item.object("row").text("taskRevision")
                                                archiveDeletePresented = true
                                            } label: {
                                                Label(model.history.object("labels").text("delete"), systemImage: "trash")
                                            }
                                            .tint(palette.danger)
                                            .accessibilityIdentifier("archive-delete-" + item.object("row").text("id"))
                                        }
                                    }
                            }
                            else {
                                archiveCard(item)
                                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                        if model.historyActionsEnabled {
                                            Button {
                                                searchFocused = false
                                                Task { await model.restoreArchivedProject(item.text("id")) }
                                            } label: {
                                                Label(model.history.object("labels").text("restore"), systemImage: "arrow.counterclockwise")
                                            }
                                            .tint(palette.tint)
                                            .accessibilityIdentifier("archive-restore-project-" + item.text("id"))
                                        }
                                    }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        if model.historyActionsEnabled {
                                            Button {
                                                searchFocused = false
                                                archiveProjectDeleteID = item.text("id")
                                                archiveProjectDeleteRevision = item.text("projectRevision")
                                                archiveProjectDeleteConfirmation = item.object("trashConfirmation")
                                                archiveProjectDeletePresented = true
                                            } label: {
                                                Label(model.history.object("labels").text("delete"), systemImage: "trash")
                                            }
                                            .tint(palette.danger)
                                            .accessibilityIdentifier("archive-delete-project-" + item.text("id"))
                                        }
                                    }
                            }
                        }
                        if model.history.objects("items").count < model.history.number("total") {
                            Button(model.label("common.more")) { Task { await model.loadMoreHistory() } }
                                .rnFont(12, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                                .background(palette.filter, in: Capsule()).buttonStyle(.plain)
                                .disabled(!model.historyActionsEnabled).accessibilityIdentifier("archive-more")
                        }
                        if !model.history.object("empty").isEmpty { archiveEmpty }
                    }
                    if model.busy || (!model.historyCurrent && model.historyError == nil) {
                        ProgressView().frame(maxWidth: .infinity).padding(12)
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("archive-scroll")
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refresh() }
        }
    }

    private var doneBulkDeleteBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.historyDoneBulk.object("bar").text("countLabel")).rnFont(13).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("done-bulk-count")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.historyDoneBulk.object("bar").objects("statuses").indices, id: \.self) { index in
                        let option = model.historyDoneBulk.object("bar").objects("statuses")[index]
                        Button { Task { await model.restoreSelectedArchiveTasks(doneStatus: option.text("status")) } } label: {
                            Text(option.text("label")).rnFont(13, .semibold)
                                .fixedSize(horizontal: true, vertical: false)
                                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                                .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.historyDoneBulkStatusEnabled(option.text("status")))
                        .accessibilityLabel(option.text("accessibilityLabel"))
                        .accessibilityIdentifier("done-bulk-status-" + option.text("status"))
                    }
                }
            }
            .accessibilityIdentifier("done-bulk-status-scroll")
            if dynamicTypeSize.isAccessibilitySize {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        doneBulkControls
                        doneBulkTagControls
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("done-bulk-actions-scroll")
            } else {
                HStack(spacing: 8) { doneBulkControls }
                HStack(spacing: 8) { doneBulkTagControls }
            }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    @ViewBuilder private var doneBulkControls: some View {
        Button { model.leaveDoneTaskSelection() } label: {
            doneBulkActionLabel(model.historyDoneBulk.object("bar").object("exit").text("accessibilityLabel"))
        }
        .buttonStyle(.plain).disabled(!model.historyActionsEnabled).accessibilityIdentifier("done-bulk-exit")
        Button { Task { await model.toggleDoneTaskRange() } } label: {
            doneBulkActionLabel(model.historyDoneBulk.object("bar").object("range").text("label"))
        }
        .buttonStyle(.plain).disabled(!model.historyDoneBulkDeleteEnabled)
        .accessibilityAddTraits(model.historyDoneBulk.object("bar").object("range").flag("active") ? .isSelected : [])
        .accessibilityIdentifier("done-bulk-range")
        Button {
            model.requestDeleteSelectedArchiveTasks(done: true)
            archiveBulkDeletePresented = !model.archiveBulkDeleteConfirmation.isEmpty
        } label: {
            doneBulkActionLabel(model.historyDoneBulk.object("bar").object("delete").text("label"))
        }
        .buttonStyle(.plain).foregroundStyle(palette.danger).disabled(!model.historyDoneBulkDeleteEnabled)
        .accessibilityIdentifier("done-bulk-delete")
    }

    @ViewBuilder private var doneBulkTagControls: some View {
        Button { model.openDoneBulkTag() } label: {
            doneBulkActionLabel(model.historyDoneBulk.object("bar").object("addTag").text("label"))
        }
        .buttonStyle(.plain).disabled(!model.historyDoneBulkTagEnabled).accessibilityIdentifier("done-bulk-add-tag")
        Button { model.openDoneBulkRemove() } label: {
            doneBulkActionLabel(model.historyDoneBulk.object("bar").object("removeTag").text("label"))
        }
        .buttonStyle(.plain).disabled(!model.historyDoneBulkRemoveEnabled).accessibilityIdentifier("done-bulk-remove-tag")
    }

    @ViewBuilder private func doneBulkActionLabel(_ text: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            Text(text).rnFont(13, .semibold).fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        } else {
            Text(text).rnFont(13, .semibold).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
    }

    private var archiveSelectionSummary: some View {
        Group {
            if !model.history.text("summary").isEmpty || model.historyArchiveSelectionMode {
                HStack(spacing: 12) {
                    Text(model.history.text("summary")).rnFont(13, .medium).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("archive-summary")
                    Button {
                        searchFocused = false
                        completedAtError = false
                        Task { await model.toggleArchiveTaskSelectionMode() }
                    } label: {
                        Text(model.history.object("labels").text(model.historyArchiveSelectionMode ? "done" : "select"))
                            .rnFont(13, .semibold).multilineTextAlignment(.center)
                            .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.text)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .disabled(!model.historyActionsEnabled).accessibilityIdentifier("archive-select-toggle")
                }
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
    }

    private var archiveBulkRestoreBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.history.object("labels").text("selected")).rnFont(13).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("archive-bulk-count")
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { archiveSelectAllButton; archiveBulkRestoreButton; archiveBulkDeleteButton }
            } else { HStack(spacing: 8) { archiveSelectAllButton; archiveBulkRestoreButton; archiveBulkDeleteButton } }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    private var archiveSelectAllButton: some View {
        Button {
            searchFocused = false
            completedAtError = false
            Task { await model.selectAllArchiveTasks() }
        } label: {
            Text(model.history.object("labels").text("selectAll")).rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.text)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.historyActionsEnabled || model.history.number("visibleTaskCount") == 0
            || model.historyArchiveSelectedIDs.count == model.history.number("visibleTaskCount"))
        .accessibilityIdentifier("archive-bulk-select-all")
    }

    private var archiveBulkRestoreButton: some View {
        Button {
            searchFocused = false
            completedAtError = false
            Task { await model.restoreSelectedArchiveTasks() }
        } label: {
            Text(model.history.object("labels").text("restoreSelected")).rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.onTint)
        .background(palette.tint, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.historyArchiveBulkRestoreEnabled).accessibilityIdentifier("archive-bulk-restore")
    }

    private var archiveBulkDeleteButton: some View {
        Button {
            searchFocused = false
            completedAtError = false
            model.requestDeleteSelectedArchiveTasks()
            archiveBulkDeletePresented = !model.archiveBulkDeleteConfirmation.isEmpty
        } label: {
            Text(model.history.object("labels").text("delete")).rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(.red)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.historyArchiveBulkRestoreEnabled).accessibilityIdentifier("archive-bulk-delete")
    }

    private func archiveSelectionCard(_ item: CoreObject) -> some View {
        let row = item.object("row")
        let group = item.text("groupId").isEmpty ? "none" : item.text("groupId")
        let selected = item.flag("selected")
        return Button {
            searchFocused = false
            completedAtError = false
            Task { await model.toggleArchiveTaskSelection(row) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 5).fill(selected ? palette.tint : Color.clear)
                    RoundedRectangle(cornerRadius: 5).stroke(palette.tint, lineWidth: 1)
                    if selected { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(palette.onTint) }
                }
                .frame(width: 24, height: 24).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.text("title")).rnFont(16, .semibold).strikethrough(item.flag("struck"))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !item.text("descriptionMarkdown").isEmpty {
                        Text(inlineMarkdown(item.text("descriptionMarkdown"))).rnFont(14).lineLimit(1)
                    }
                    Text(item.text("dateLabel")).rnFont(12).italic()
                }
                .foregroundStyle(palette.secondary)
            }
            .fixedSize(horizontal: false, vertical: true).padding(16).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(palette.row, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? palette.tint : palette.border, lineWidth: selected ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
        .accessibilityLabel(model.history.object("labels").text("select") + " " + row.text("title"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("archive-select-" + group + "-" + row.text("id"))
    }

    private var archiveSearchField: some View {
        TextField(model.history.object("search").text("placeholder"),
                  text: Binding(get: { model.historySearchText }, set: { model.setHistoryText($0) }))
            .rnFont(15).autocorrectionDisabled().textInputAutocapitalization(.never)
            .submitLabel(.search).focused($searchFocused).onSubmit { searchFocused = false }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            .disabled(model.retryNeeded).accessibilityLabel(model.history.object("search").text("placeholder"))
            .accessibilityIdentifier("archive-search")
    }

    @ViewBuilder private var archiveSearchTools: some View {
        if !model.history.object("filters").text("buttonLabel").isEmpty {
            Button { searchFocused = false; model.setHistoryPanel("filters") } label: {
                HStack(spacing: 6) {
                    AppIcon(name: "sliders", size: 16)
                    Text(model.history.object("filters").text("buttonLabel")).rnFont(12, .semibold)
                }
                .foregroundStyle(palette.tint).padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.tint, lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(!model.historyActionsEnabled).accessibilityAddTraits(.isSelected)
            .accessibilityIdentifier("archived-active-filters-button")
        }
        Button { searchFocused = false; model.setHistoryPanel("menu") } label: {
            Image(systemName: "ellipsis").font(.system(size: 20)).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
        .accessibilityLabel(model.label("taskEdit.moreOptions")).accessibilityIdentifier("archived-overflow-button")
    }

    private var archiveSelectionActive: Bool {
        model.historyArchived && model.historyArchiveSelectionMode
    }

    @ViewBuilder private func archiveCard(_ item: CoreObject) -> some View {
        if item.text("type") == "task" && model.historyArchiveSelectionMode {
            archiveSelectionCard(item)
        } else if item.text("type") == "project" || item.flag("cancelled") {
            archiveReadOnlyCard(item)
        } else {
            archiveCompletedTaskCard(item)
        }
    }

    private func archiveReadOnlyCard(_ item: CoreObject) -> some View {
        let project = item.text("type") == "project"
        let row = project ? item : item.object("row")
        let group = item.text("groupId").isEmpty ? "none" : item.text("groupId")
        return Button {
            searchFocused = false
            Task {
                if project { await model.openProject(item) }
                else { await model.openTask(row.text("id")) }
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.text("title")).rnFont(16, .semibold).strikethrough(item.flag("struck"))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !item.text("descriptionMarkdown").isEmpty {
                        Text(inlineMarkdown(item.text("descriptionMarkdown"))).rnFont(14).lineLimit(1)
                    }
                    Text(item.text("dateLabel")).rnFont(12).italic()
                    if !item.text("areaName").isEmpty { Text(item.text("areaName")).rnFont(12).italic() }
                }
                .foregroundStyle(palette.secondary)
                if !project || !item.text("indicatorColor").isEmpty {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: project ? item.text("indicatorColor") : "6B7280"))
                        .frame(width: 4)
                }
            }
            .fixedSize(horizontal: false, vertical: true).padding(16).frame(minHeight: 44)
            .background(palette.row, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
        .accessibilityIdentifier(project ? "archive-project-" + row.text("id") : "archive-task-" + group + "-" + row.text("id"))
    }

    private func archiveCompletedTaskCard(_ item: CoreObject) -> some View {
        let project = item.text("type") == "project"
        let row = project ? item : item.object("row")
        let group = item.text("groupId").isEmpty ? "none" : item.text("groupId")
        let editableCompletion = !project && !item.flag("cancelled")
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    searchFocused = false
                    Task {
                        if project { await model.openProject(item) }
                        else { await model.openTask(row.text("id")) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.text("title")).rnFont(16, .semibold).strikethrough(item.flag("struck"))
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !item.text("descriptionMarkdown").isEmpty {
                            Text(inlineMarkdown(item.text("descriptionMarkdown"))).rnFont(14).lineLimit(1)
                        }
                        if !editableCompletion { Text(item.text("dateLabel")).rnFont(12).italic() }
                        if !item.text("areaName").isEmpty { Text(item.text("areaName")).rnFont(12).italic() }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
                .accessibilityIdentifier(project ? "archive-project-" + row.text("id") : "archive-task-" + group + "-" + row.text("id"))
                if editableCompletion {
                    Button { openCompletedAt(row, archived: true, group: group) } label: {
                        Text(item.text("dateLabel")).rnFont(12).italic()
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.historyActionsEnabled || archiveSelectionActive)
                    .accessibilityLabel(model.label("task.editCompletedAt"))
                    .accessibilityIdentifier("archive-task-completed-at-" + group + "-" + row.text("id"))
                    .onDisappear {
                        if completedAtArchived && completedAtRow.text("id") == row.text("id") && completedAtGroup == group {
                            closeCompletedAt()
                        }
                    }
                }
            }
            .foregroundStyle(palette.secondary)
            if !project || !item.text("indicatorColor").isEmpty {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(hex: project ? item.text("indicatorColor") : "6B7280"))
                    .frame(width: 4).accessibilityHidden(true)
            }
        }
        .fixedSize(horizontal: false, vertical: true).padding(16).frame(minHeight: 44)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {

        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
    }

    @ViewBuilder private func archiveSection(_ item: CoreObject) -> some View {
        if item.flag("collapsible") {
            Button { searchFocused = false; Task { await model.toggleHistorySection(item.text("id")) } } label: { sectionLabel(item) }
                .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
                .accessibilityValue(model.label(item.flag("collapsed") ? "markdown.expand" : "markdown.collapse"))
                .accessibilityIdentifier("archive-section-" + item.text("id"))
        } else { sectionLabel(item).accessibilityAddTraits(.isHeader) }
    }

    private func sectionLabel(_ item: CoreObject) -> some View {
        HStack(spacing: 6) {
            if item.flag("collapsible") {
                AppIcon(name: "chevron", size: 15).rotationEffect(.degrees(item.flag("collapsed") ? -90 : 0))
            }
            Text(item.text("title")).textCase(.uppercase).rnFont(13, .bold).tracking(0.4)
            Text(String(item.number("count"))).rnFont(12, .semibold)
            Spacer(minLength: 0)
        }
        .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
    }

    private var archiveEmpty: some View {
        let empty = model.history.object("empty")
        return VStack(spacing: 8) {
            Image(systemName: "archivebox").font(.system(size: 48, weight: .light)).foregroundStyle(palette.secondary).accessibilityHidden(true)
            Text(empty.text("title")).rnFont(18, .semibold).accessibilityIdentifier("archive-empty")
            Text(empty.text("message")).rnFont(14).foregroundStyle(palette.secondary)
            if !empty.text("clearLabel").isEmpty {
                Button(empty.text("clearLabel"), action: clearFilters)
                    .rnFont(14, .semibold).frame(minHeight: 44).disabled(!model.historyActionsEnabled)
                    .accessibilityIdentifier("archive-empty-clear")
            }
        }
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 48)
    }

    private func clearFilters() {
        searchFocused = false
        Task { await model.editHistoryFilter(model.history.object("filters").object("clearEdit")) }
    }
}

private struct HistoryDoneBulkTagDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    private var fields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.doneBulkTagOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            TextField(model.doneBulkTagOptions.text("placeholder"), text: Binding(get: { model.doneBulkTagText }, set: { model.setDoneBulkTagText($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .accessibilityLabel(model.doneBulkTagOptions.text("placeholder"))
                .accessibilityIdentifier("done-bulk-tag-input")
            if let error = model.doneBulkTagReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("done-bulk-tag-error")
                Button { model.setDoneBulkTagText(model.doneBulkTagText) } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier("done-bulk-tag-read-retry")
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { model.closeDoneBulkTag() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    if dynamicTypeSize.isAccessibilitySize {
                        ScrollView { fields }
                            .frame(maxHeight: min(420, max(120, geometry.size.height - 132)))
                            .accessibilityIdentifier("done-bulk-tag-scroll")
                    } else {
                        fields
                    }
                    HStack {
                        Spacer()
                        Button { model.closeDoneBulkTag() } label: {
                            Text(model.doneBulkTagOptions.text("cancelLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).accessibilityIdentifier("done-bulk-tag-cancel")
                        Button { Task { await model.saveDoneBulkTag() } } label: {
                            Text(model.doneBulkTagOptions.text("saveLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.doneBulkTagSaveEnabled)
                        .accessibilityIdentifier("done-bulk-tag-save")
                    }
                }
                .padding(16).frame(maxWidth: 420)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("done-bulk-tag-dialog").accessibilityAction(.escape) { model.closeDoneBulkTag() }
        }
    }
}

private struct HistoryDoneBulkRemoveTagDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var focused: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { model.closeDoneBulkRemove() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(model.doneBulkRemoveOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                            Text(model.doneBulkRemoveOptions.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                            TextField(model.doneBulkRemoveOptions.text("placeholder"), text: Binding(get: { model.doneBulkRemoveQuery }, set: { model.setDoneBulkRemoveQuery($0) }))
                                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                                .accessibilityLabel(model.doneBulkRemoveOptions.text("placeholder"))
                                .accessibilityIdentifier("done-bulk-remove-tag-input")
                            AppChipFlow {
                                ForEach(model.doneBulkRemoveItems.indices, id: \.self) { index in
                                    let item = model.doneBulkRemoveItems[index]
                                    let picked = model.doneBulkRemovePicked(item.text("value"))
                                    Button { model.toggleDoneBulkRemove(item.text("value")) } label: {
                                        Text(item.text("label")).rnFont(14).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                            .padding(.horizontal, 12).padding(.vertical, 8).frame(minWidth: 44, minHeight: 44)
                                            .background(picked ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
                                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(picked ? palette.tint : palette.border, lineWidth: 1))
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).foregroundStyle(picked ? palette.onTint : palette.text)
                                    .disabled(!model.doneBulkRemoveCurrent || model.doneBulkRemoveReading)
                                    .accessibilityLabel(item.text("label")).accessibilityAddTraits(picked ? .isSelected : [])
                                    .accessibilityIdentifier("done-bulk-remove-tag-option-\(index)")
                                }
                            }
                            if model.doneBulkRemoveReading { ProgressView().accessibilityLabel(model.label("common.loading")) }
                            if model.doneBulkRemoveCurrent && model.doneBulkRemoveTotal == 0 {
                                Text(model.label("common.noMatches")).rnFont(14).foregroundStyle(palette.secondary)
                                    .accessibilityIdentifier("done-bulk-remove-tag-no-matches")
                            }
                            if model.doneBulkRemoveItems.count < model.doneBulkRemoveTotal {
                                Button { model.loadMoreDoneBulkRemove() } label: {
                                    Text(model.label("common.more")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.doneBulkRemoveCanLoadMore)
                                .accessibilityIdentifier("done-bulk-remove-tag-more")
                            }
                            if let error = model.doneBulkRemoveReadError {
                                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("done-bulk-remove-tag-error")
                                Button { model.retryDoneBulkRemoveRead() } label: {
                                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.doneBulkRemoveReading)
                                .accessibilityIdentifier("done-bulk-remove-tag-read-retry")
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively).frame(maxHeight: min(480, max(100, geometry.size.height - 132)))
                    .accessibilityIdentifier("done-bulk-remove-tag-scroll")
                    HStack {
                        Spacer()
                        Button { model.closeDoneBulkRemove() } label: {
                            Text(model.doneBulkRemoveOptions.text("cancelLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).accessibilityIdentifier("done-bulk-remove-tag-cancel")
                        Button { Task { await model.saveDoneBulkRemove() } } label: {
                            Text(model.doneBulkRemoveOptions.text("saveLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.doneBulkRemoveSaveEnabled)
                        .accessibilityIdentifier("done-bulk-remove-tag-save")
                    }
                }
                .padding(16).frame(maxWidth: 420).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("done-bulk-remove-tag-dialog").accessibilityAction(.escape) { model.closeDoneBulkRemove() }
            .onAppear { focused = true }
        }
    }
}

private struct HistoryTaskCompletedAtDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let options: CoreObject
    let prefix: String
    let close: () -> Void
    let save: (String) -> Void
    @State private var initialInstant: String
    @State private var date: Date
    @State private var dateChanged = false
    private var frozen: Bool { model.busy || model.retryNeeded }

    init(model: CoreModel, palette: AppPalette, options: CoreObject, prefix: String,
         close: @escaping () -> Void, save: @escaping (String) -> Void) {
        self.model = model
        self.palette = palette
        self.options = options
        self.prefix = prefix
        self.close = close
        self.save = save
        let initial = options["initialValue"] as? String
        let date = (options["initialEpochMilliseconds"] as? NSNumber)
            .map { Date(timeIntervalSince1970: $0.doubleValue / 1_000) } ?? Date()
        _initialInstant = State(initialValue: initial ?? TaskDatePickerComponents.instantString(date))
        _date = State(initialValue: date)
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(options.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                            DatePicker(options.text("title"), selection: Binding(get: { date }, set: { next in
                                guard TaskDatePickerComponents.string(next, time: false) != TaskDatePickerComponents.string(date, time: false)
                                    || TaskDatePickerComponents.string(next, time: true) != TaskDatePickerComponents.string(date, time: true) else { return }
                                date = next
                                dateChanged = true
                            }), displayedComponents: [.date, .hourAndMinute])
                                .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                                .accessibilityLabel(options.text("title"))
                                .accessibilityIdentifier(prefix + "-completed-at-picker").disabled(frozen)
                        }
                    }
                    .frame(maxHeight: max(120, min(dynamicTypeSize.isAccessibilitySize ? .infinity : 360, geometry.size.height - 132)))
                    .accessibilityElement(children: .contain).accessibilityIdentifier(prefix + "-completed-at-dialogscroll")
                    HStack {
                        Spacer()
                        Button(action: cancel) {
                            Text(options.text("cancelLabel")).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary)
                        .disabled(frozen).accessibilityIdentifier(prefix + "-completed-at-cancel")
                        Button {
                            guard !frozen else { return }
                            save(dateChanged ? TaskDatePickerComponents.instantString(date) : initialInstant)
                        } label: {
                            Text(options.text("saveLabel")).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(frozen).accessibilityIdentifier(prefix + "-completed-at-save")
                    }
                }
                .padding(16).frame(maxWidth: 420)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { cancel() }
        }
    }

    private func cancel() {
        guard !frozen else { return }
        close()
    }
}

struct HistoryPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var focusedField: String?
    private var isFilter: Bool { model.historyPanel == "filters" }
    private var menuPrefix: String { model.historyArchived ? "archived" : "done" }
    private var menu: CoreObject { model.historyArchived ? model.history.object("menu") : model.history }
    private var submenu: CoreObject { menu.object(model.historyPanel) }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: isFilter ? .bottom : .center) {
                Button { close() } label: { Color.black.opacity(isFilter ? 0.35 : 0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier(model.historyPrefix + "-panel-dismiss")
                VStack(alignment: .leading, spacing: 0) {
                    if isFilter { filterControls }
                    else {
                        HStack(spacing: 8) {
                            if model.historyPanel != "menu" {
                                Button { model.setHistoryPanel("menu") } label: {
                                    Text(model.label("common.back")).rnFont(13, .semibold).padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier(menuPrefix + "-panel-back")
                            }
                            Text(model.historyPanel == "menu" ? model.label("taskEdit.moreOptions") :
                                 submenu.text(model.historyArchived ? "label" : "title"))
                                .rnFont(17, .bold).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                            Button { close() } label: { AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle()) }
                                .buttonStyle(.plain).accessibilityLabel(model.label("common.close")).accessibilityIdentifier(menuPrefix + "-menu-close")
                        }
                        .frame(minHeight: 44).padding(.bottom, 12)
                        ViewThatFits(in: .vertical) {
                            overflowContent.fixedSize(horizontal: false, vertical: true)
                            ScrollView { overflowContent }.accessibilityIdentifier(menuPrefix + "-panel-scroll")
                        }
                    }
                }
                .padding(isFilter ? 16 : 12)
                .frame(maxWidth: isFilter ? 860 : 440, maxHeight: geometry.size.height * 0.82, alignment: .top)
                .fixedSize(horizontal: false, vertical: !isFilter)
                .background(palette.card, in: RoundedRectangle(cornerRadius: isFilter ? 24 : 16))
                .overlay(RoundedRectangle(cornerRadius: isFilter ? 24 : 16).stroke(palette.border, lineWidth: 1))
                .padding(.horizontal, isFilter ? 0 : 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) {
                focusedField = nil
                if !model.historyPickerName.isEmpty { model.closeHistoryPicker() }
                else if !isFilter && model.historyPanel != "menu" { model.setHistoryPanel("menu") }
                else { close() }
            }
        }
    }

    private var overflowContent: some View {
        VStack(spacing: 4) {
            if model.historyPanel == "menu" {
                overflowRow(title: model.historyArchived ? menu.text("filtersLabel") : model.label("filters.label"),
                            selected: model.history.object("filters").flag("hasActive"), icon: "sliders", id: menuPrefix + "-filter-action") {
                    model.setHistoryPanel("filters")
                }
                ForEach(["sort", "group"], id: \.self) { field in
                    overflowRow(title: model.historyArchived ? menu.object(field).text("label") : model.label(field == "sort" ? "sort.label" : "list.groupBy"),
                                value: menu.object(field).text(model.historyArchived ? "value" : "label"),
                                icon: field == "sort" ? "sort" : "folder", id: menuPrefix + "-" + field + "-action") {
                        model.setHistoryPanel(field)
                    }
                }
            } else {
                ForEach(submenu.objects("options").indices, id: \.self) { index in
                    let option = submenu.objects("options")[index]
                    let value = option.text(model.historyArchived ? "id" : "value")
                    let field = model.historyPanel
                    overflowRow(title: option.text("label"), selected: option.flag("selected"), id: menuPrefix + "-" + field + "-" + value) {
                        close()
                        Task { await model.setHistoryOption(field == "sort" ? "sortBy" : "groupBy", value: value) }
                    }
                }
            }
        }
    }

    private func overflowRow(title: String, value: String = "", selected: Bool = false, icon: String = "",
                             id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if !icon.isEmpty {
                    AppIcon(name: icon, size: 18).foregroundStyle(selected ? palette.tint : palette.secondary)
                        .frame(width: 34, height: 34).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                }
                Text(title).rnFont(15, .semibold).frame(maxWidth: .infinity, alignment: .leading)
                if !value.isEmpty { Text(value).rnFont(13).foregroundStyle(palette.secondary).multilineTextAlignment(.trailing) }
                if selected { Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(palette.tint) }
            }
            .padding(10).frame(minHeight: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.historyActionsEnabled)
        .accessibilityLabel(value.isEmpty ? title : title + ": " + value)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityIdentifier(id)
    }

    private var filterControls: some View {
        ListFilterControls(
            data: model.history, strings: model.strings, palette: palette, prefix: model.historyPrefix,
            enabled: model.historyActionsEnabled, busy: model.busy, frozen: model.retryNeeded, error: model.historyError,
            searchText: Binding(get: { model.historySearchText }, set: { model.setHistoryText($0) }),
            locationText: Binding(get: { model.historyLocationText }, set: { model.setHistoryText($0, location: true) }),
            pickerName: model.historyPickerName, picker: model.historyPicker, pickerCurrent: model.historyPickerCurrent,
            pickerEnabled: model.historyPickerActionsEnabled, pickerError: model.historyPickerError,
            pickerQuery: Binding(get: { model.historyPickerQuery }, set: { model.setHistoryPickerQuery($0) }),
            onEdit: { edit in Task { await model.editHistoryFilter(edit) } },
            onChipAction: { action in Task { await model.applyHistoryChipAction(action) } },
            onArchived: { _ in }, onOpenPicker: model.openHistoryPicker, onBack: model.closeHistoryPicker,
            onMore: model.loadMoreHistoryPicker, onRetry: { Task { await model.retryHistory() } },
            onRetryPicker: model.retryHistoryPicker, onClose: model.closeHistoryPanel, focusedField: $focusedField)
    }

    private func close() { focusedField = nil; model.closeHistoryPanel() }
}
