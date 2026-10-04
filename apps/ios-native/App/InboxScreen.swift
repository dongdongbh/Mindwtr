import SwiftUI
import UIKit

struct InboxScreen: View {
    @ObservedObject var model: CoreModel
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
        model.morePresented || !model.somedayPanel.isEmpty || !model.referencePanel.isEmpty || !model.historyPanel.isEmpty
    }
    private var menuListPrefix: String {
        model.selectedSurface == .savedSearch ? "saved-search" : model.selectedSurface == .contexts ? "contexts" : model.selectedSurface == .trash ? "trash" : model.selectedSurface == .history ? "history" : model.selectedSurface == .reference ? "reference" : model.selectedSurface == .someday ? "someday" : "waiting"
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            palette.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                ZStack(alignment: .bottom) {
                    VStack(spacing: 0) {
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
                                if model.selectedSurface == .inbox { inboxContent }
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
                        if !model.referenceProjectNextActionPresented { taskActionNoticeView }
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
                        if model.error != nil && !model.capturePresented && !model.areaPickerPresented && !model.morePresented && !model.mindSweepPresented && !model.processInboxPresented && !model.calendarItemPresented
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
                    }
                    .accessibilityElement(children: menuPanelPresented ? .ignore : .contain)
                    .accessibilityHidden(menuPanelPresented)
                    if model.morePresented { MoreMenuSheet(model: model, palette: palette) }
                    if !model.somedayPanel.isEmpty { SomedayPanel(model: model, palette: palette) }
                    if !model.referencePanel.isEmpty { ReferencePanel(model: model, palette: palette) }
                    if !model.historyPanel.isEmpty { HistoryPanel(model: model, palette: palette) }
                }
                if model.selectedSurface != .search && model.selectedSurface != .project && model.selectedSurface != .waiting
                    && model.selectedSurface != .someday && model.selectedSurface != .reference && model.selectedSurface != .history
                    && model.selectedSurface != .trash && model.selectedSurface != .savedSearch
                    && (model.selectedSurface != .contexts || model.quickAccessView == "contexts")
                    && model.selectedSurface != .settings {
                    tabBar
                }
            }
            // More's content, dismissal backdrop and visible tabs share one modal boundary.
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(model.morePresented ? .isModal : [])
            .disabled(model.referenceProjectNextActionPresented || model.savedSearchWritePresented || model.focusSavedFilterPresented || model.boardFiltersPresented || model.calendarItemPresented || model.calendarComposerPresented || model.mindSweepPresented || model.processInboxPresented || !model.focusPanel.isEmpty || (model.selectedSurface == .review
                && (model.reviewGuidePresented || model.reviewPickerPresented)))
            .accessibilityHidden(model.referenceProjectNextActionPresented || model.savedSearchWritePresented || model.focusSavedFilterPresented || model.boardFiltersPresented || model.calendarItemPresented || model.calendarComposerPresented || model.mindSweepPresented || model.processInboxPresented || model.capturePresented || model.areaPickerPresented || !model.focusPanel.isEmpty
                || (model.selectedSurface == .review && (model.reviewGuidePresented || model.reviewPickerPresented)))
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
                    .disabled(model.mindSweepPresented || model.processInboxPresented)
                    .accessibilityHidden(model.areaPickerPresented || model.taskPresented || model.mindSweepPresented || model.processInboxPresented)
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
            }
            if model.capturePresented {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { if !model.busy && !model.retryNeeded { model.capturePresented = false } }
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
        .sheet(isPresented: Binding(get: { model.taskPresented }, set: { if !$0 && !model.appLock.concealed { model.closeTask() } })) {
            TaskViewSheet(model: model, palette: palette)
                .presentationDetents([.large])
        }
        .onChange(of: model.selectedSurface) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.taskPresented) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.appLock.concealed) { _ in model.referenceProjectNextActionOwnerChanged() }
        .onChange(of: model.taskStatusMenuPresented) { active in
            if !active { model.presentQueuedReferenceProjectNextAction() }
        }
        .task(id: (model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board) && scenePhase == .active) {
            guard model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board, scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard model.selectedSurface == .focus || model.selectedSurface == .review || model.selectedSurface == .calendar || model.selectedSurface == .board, scenePhase == .active else { return }
                // Core decides which timed tasks have become available. The shared
                // refresh path also guards capture, pending writes and in-flight work.
                await model.refresh()
            }
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
                                    }.disabled(model.busy || model.retryNeeded || model.referenceProjectNextActionPending)
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
                // The screen underneath is hidden from VoiceOver while this sheet
                // is open. Keep uncertain-write recovery in the modal itself.
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
                            // Lucide Check, as in RN's area sheet.
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

    private var inboxContent: some View {
        VStack(spacing: 0) {
            toolbar
            primaryAction
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    Text(model.inbox.text("scopeLabel"))
                        .rnFont(13, .semibold).foregroundStyle(palette.secondary)
                        .padding(.horizontal, 16).padding(.bottom, 2)
                    if model.items.isEmpty { emptyState }
                    ForEach(model.items.indices, id: \.self) { index in
                        let item = model.items[index]
                        if item.text("type") == "task" {
                            TaskCard(row: item.object("row"), model: model, palette: palette)
                                .id(item.object("row").text("id"))
                                .onAppear {
                                    if index == model.items.count - 5 { Task { await model.loadMore() } }
                                }
                        }
                    }
                    if model.busy && !model.capturePresented { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(12)
            }
            .refreshable { await model.refresh() }
        }
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
                        focusSectionHeader(key: key, title: section.text("title"), count: section.number("total"), first: index == 0)
                        if !model.collapsedFocusSections.contains(key) {
                            let rows = section.objects("rows")
                            ForEach(rows.indices, id: \.self) { rowIndex in
                                let row = rows[rowIndex]
                                // Keep each occurrence's conditional headers in
                                // its own container instead of flattening repeated
                                // nested ForEach index 0 into the lazy stack.
                                VStack(alignment: .leading, spacing: 0) {
                                    let groups = section.objects("groups").filter { $0.number("start") == rowIndex }
                                    ForEach(groups.indices, id: \.self) { groupIndex in
                                        focusGroupHeader(groups[groupIndex]).id(key + ":" + groups[groupIndex].text("id"))
                                    }
                                    if row.flag("laterToday") && (rowIndex == 0 || !rows[rowIndex - 1].flag("laterToday")) {
                                        Text(model.label("agenda.laterToday")).rnFont(13, .bold)
                                            .foregroundStyle(palette.secondary).padding(.top, 10).padding(.bottom, 6)
                                            .accessibilityAddTraits(.isHeader)
                                    }
                                    TaskCard(row: row, model: model, palette: palette,
                                             footer: row.text("revealLabel").isEmpty ? row.text("laterTodayLabel") : row.text("revealLabel"),
                                             showDetails: model.focusShowDetails, showFocusToggle: true,
                                             onProject: { project in Task { await model.openProject(project) } })
                                        .padding(.leading, section.objects("groups").isEmpty ? 0 : 25)
                                        .overlay(alignment: .leading) {
                                            if !section.objects("groups").isEmpty { palette.border.frame(width: 2).padding(.leading, 13) }
                                        }
                                        .padding(.bottom, 8).disabled(!model.focusActionsEnabled)
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
        .refreshable { await model.refresh() }
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

    private func focusGroupHeader(_ group: CoreObject) -> some View {
        HStack(spacing: 8) {
            Circle().fill(group.flag("muted") ? palette.secondary : group.text("dotColor").isEmpty ? palette.tint : Color(hex: group.text("dotColor")))
                .frame(width: 8, height: 8).accessibilityHidden(true)
            Text(group.text("title").uppercased()).rnFont(13, .bold).tracking(0.6).foregroundStyle(group.flag("muted") ? palette.secondary : palette.text)
                .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            Text(String(group.number("count"))).rnFont(12, .semibold).foregroundStyle(palette.secondary)
        }
        .padding(.horizontal, 4).padding(.top, 10).padding(.bottom, 8)
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
                        .frame(width: 44, height: 44)
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
                    // Lucide ChevronsUp/Down, matching RN's control.
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

    private func focusSectionHeader(key: String, title: String, count: Int, first: Bool) -> some View {
        let open = !model.collapsedFocusSections.contains(key)
        return HStack(spacing: 8) {
            Button { model.toggleFocusSection(key) } label: {
                HStack(spacing: 10) {
                    Text(open ? "▾" : "▸").rnFont(12).frame(width: 14)
                    Text(title.uppercased()).rnFont(12, .bold, maxScale: 1.2).tracking(1).lineLimit(2)
                    Text("(\(count))").rnFont(12, .semibold, maxScale: 1.2)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.focusControlsEnabled)
            .accessibilityLabel(title + " · \(count)")
            .accessibilityValue(model.label(open ? "markdown.collapse" : "markdown.expand"))
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("focus-section-" + key)
            let reorder = model.focus.object("controls").object("reorder")
            if key == "focus" && !reorder.isEmpty {
                Button { Task { await model.openFocusOrder() } } label: {
                    HStack(spacing: 4) {
                        // Lucide GripVertical paths from RN.
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
                    AppIcon(name: "search", size: 22).frame(width: 44, height: 44)
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
            AppIcon(name: "search", size: 22).frame(width: 44, height: 44)
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
                Button {} label: {
                    AppIcon(name: icon, size: 16).foregroundStyle(palette.secondary)
                        .frame(width: 32, height: 32)
                        .background(palette.filter, in: Circle())
                        .overlay(Circle().stroke(palette.border, lineWidth: 1))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).disabled(true)
                .accessibilityLabel(model.inbox.object("toolbar").object(field).text("accessibilityLabel"))
            }
            Spacer(minLength: 8)
            if model.inbox.object("mindSweep").text("placement") == "accessory" {
                Button { Task { await model.openMindSweep() } } label: {
                    actionLabel(model.inbox.object("mindSweep").text("label"), icon: "brain", color: palette.secondary)
                        .rnFont(14, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(palette.filter, in: Capsule())
                        .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded || model.inbox.object("mindSweep").text("label").isEmpty)
                .accessibilityIdentifier("inbox-mind-sweep-accessory")
            }
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
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
            Button { Task { await model.openCapture() } } label: {
                Text(model.inbox.object("empty").text("actionLabel"))
                    .rnFont(13, .bold).padding(.horizontal, 16).padding(.vertical, 9)
                    .overlay(Capsule().stroke(palette.text, lineWidth: 1))
            }
            .buttonStyle(.plain).padding(.top, 8)
            .disabled(model.busy || model.retryNeeded)
            .accessibilityIdentifier("inbox-empty-capture")
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
            .buttonStyle(.plain).disabled(!model.ready || model.busy || model.retryNeeded)
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
        // RN's iOS tab bar subtracts 12pt from the bottom safe-area inset.
        .padding(.bottom, -12)
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
            // Lucide Calendar/Circle paths used by RN's quick-access tab.
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
    let enabled: Bool
    let action: () -> Void

    func body(content: Content) -> some View {
        content.background(TaskCardLongPressRegistrar(identity: identity, enabled: enabled && interactionEnabled, action: action)
            .allowsHitTesting(false))
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
            // List provides a row-local UIKit host on both iOS 17 and newer
            // systems. Never put a per-card recognizer on a shared scroll/window.
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
            // Keep an already recognized touch cancelled through its release,
            // even if selection rerenders this card with a nil handler.
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
    @State private var statusMenu = false
    @State private var statusRow: CoreObject = [:]
    @State private var statusOptions: CoreObject = [:]
    @State private var statusOptionsTask: Task<Void, Never>?
    private var meta: CoreObject { row.object("meta") }
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
                    if onProject != nil || onToken != nil || onCompletedAt != nil {
                        AppChipFlow {
                            ForEach(parts.indices, id: \.self) { index in
                                let part = parts[index]
                                if part.text("kind") == "completed", row.text("status") == "done", let onCompletedAt {
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
                    beforeAction?()
                    model.taskStatusMenuPresented = true
                    if let onStatusOptions {
                        let displayed = row
                        statusRow = displayed
                        statusOptionsTask = Task {
                            defer { statusOptionsTask = nil }
                            if let options = await onStatusOptions(displayed) {
                                guard !Task.isCancelled else { return }
                                statusOptions = options
                                statusMenu = true
                            } else { model.taskStatusMenuPresented = false }
                        }
                    } else { statusMenu = true }
                } label: {
                    AppIcon(name: "status", size: 20).foregroundStyle(statusColor).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || row.flag("readOnly") || readOnly || statusOptionsTask != nil)
                .accessibilityLabel(model.label("task.aria.changeStatus").replacingOccurrences(of: "{{status}}", with: meta.text("statusLabel")))
                .accessibilityHint(model.label("task.aria.changeStatusHint"))
                .accessibilityIdentifier("task-status-" + row.text("id"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10).padding(.horizontal, 16)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))
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
        // Observe the whole card without adding a hit-testing overlay or replacing taps.
        .modifier(TaskCardSelectionLongPress(identity: row.text("id"), enabled: onSelectionStart != nil, action: {
            onSelectionStart?(row)
        }))
        .confirmationDialog(onStatusOptions == nil ? meta.text("statusLabel") : statusOptions.text("title"),
                            isPresented: $statusMenu, titleVisibility: .visible) {
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
                Button(model.label("common.done")) {
                    Task { await model.complete(row.text("id"), taskRevision: row.text("taskRevision")) }
                }
                    .accessibilityIdentifier("task-complete")
                if let onMoveToSection, !moveToSectionLabel.isEmpty {
                    Button(moveToSectionLabel) { onMoveToSection() }
                        .disabled(model.busy || model.retryNeeded || readOnly || row.flag("readOnly")
                                  || model.somedayMoveUndoAwaitingRefresh || model.somedayMoveUndoError != nil)
                        .accessibilityIdentifier("task-move-section-" + row.text("id"))
                }
            }
            Button(model.label("common.cancel"), role: .cancel) {}
        }
        .onChange(of: statusMenu) { model.taskStatusMenuPresented = $0 }
        .onDisappear {
            let ownsMenu = statusMenu || statusOptionsTask != nil
            statusOptionsTask?.cancel()
            if ownsMenu { model.taskStatusMenuPresented = false }
        }
    }

    private func openTask() {
        if let onSelection { onSelection(row); return }
        beforeAction?()
        Task { await model.openTask(row.text("id")) }
    }

    private func openDescriptionURL(_ url: URL) -> OpenURLAction.Result {
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
        if url.scheme?.lowercased() == "upnote",
           let original = NativeMarkdownLinkURL.originalHref(url, runs: meta.object("description").objects("inline")) {
            Task {
                let opened = await NativeUpNoteLink.open(original, surface: "markdown")
                await model.recordUpNoteHandoff(opened ? "opened" : "failed", surface: "markdown")
                if !opened { NativeUpNoteLink.showFailure(original, labels: model.strings) }
            }
            return .handled
        }
        return ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
    }

    private var titleContent: some View {
        HStack(spacing: 8) {
            Text(row.text("title")).rnFont(15, .medium)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
                .frame(minHeight: 44).contentShape(Rectangle()).onTapGesture { openTask() }
                .accessibilityIdentifier("task-title-" + row.text("id"))
                .accessibilityAction { openTask() }
            if showFocusToggle, meta.flag("canFocus"), !readOnly, !row.flag("readOnly") {
                Button {
                    beforeAction?()
                    Task { await model.setTaskFocus(row) }
                } label: {
                    AppFocusStar(focused: row.flag("isFocusedToday"), inactiveColor: palette.secondary, size: 20)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.taskFocusInputEnabled(row))
                .accessibilityLabel(model.label(row.flag("isFocusedToday") ? "agenda.removeFromFocus" : "agenda.addToFocus"))
                .accessibilityIdentifier("task-focus-" + row.text("id"))
            }
        }
    }

    private func metadata(_ parts: [CoreObject]) -> AttributedString {
        var result = AttributedString()
        for (index, part) in parts.enumerated() {
            if index > 0 { result += AttributedString("   ") }
            let kind = part.text("kind")
            if kind == "project" || kind == "area" {
                var dot = AttributedString("● ")
                dot.foregroundColor = part.text("dotColor").isEmpty ? palette.tint : Color(hex: part.text("dotColor"))
                result += dot
            }
            var text = AttributedString(part.text("text") + (part.number("overflowCount") > 0 ? " +\(part.number("overflowCount"))" : ""))
            if kind == "context" { text.foregroundColor = Color(hex: "3B82F6") }
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
            Text(model.error ?? "").rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier("persistence-error")
            Button { Task { await model.retry() } } label: {
                Text(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry"))
                    .rnFont(14, .semibold).frame(minHeight: 44).contentShape(Rectangle())
            }
            .disabled(model.busy)
            .accessibilityIdentifier("persistence-retry")
            DiagnosticsFailureAction(model: model, palette: palette)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(palette.card)
    }
}

/// Local presentation ownership also works inside the task editor's existing sheet.
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

// App-level ownership deliberately outlives the completed Reference row.
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
