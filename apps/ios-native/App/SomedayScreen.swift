import SwiftUI

struct SomedayScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    private var showsList: Bool { model.somedayCurrent || (model.busy && !model.someday.isEmpty) }

    var body: some View {
        VStack(spacing: 0) {
            if !model.someday.isEmpty { stats }
            if !model.somedayMoveNotice.isEmpty || model.somedayMoveUndoError != nil { moveNotice }
            if model.statusListSelectionMode { StatusListBulkBar(model: model, palette: palette, idPrefix: "someday") }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.somedayError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("someday-error")
                        Button(model.label("common.retry")) { Task { await model.retrySomeday() } }
                            .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("someday-retry")
                    }
                    if showsList {
                        deferredProjects
                        let items = model.someday.objects("items")
                        ForEach(somedayItemKeys(items), id: \.identity) { key in
                            let item = items[key.index]
                            if item.text("type") == "task" {
                                let row = item.object("row")
                                let selecting = model.statusListSelectionMode
                                let selectable = model.statusListTaskSelectable(row)
                                HStack(spacing: 8) {
                                    if selecting && selectable { StatusListSelectButton(model: model, row: row, palette: palette, idPrefix: "someday") }
                                    TaskCard(row: row, model: model, palette: palette,
                                             readOnly: selecting || row.flag("readOnly"), hideStatusBadge: selecting,
                                             showDetails: model.someday.flag("showDetails"),
                                             onMoveToSection: !selecting && row.text("status") == "someday" && !row.flag("readOnly")
                                                ? { Task { await model.openSomedaySectionMove(row) } } : nil,
                                             moveToSectionLabel: model.someday.object("text").text("moveToSection"),
                                             onSelection: selecting && selectable ? { row in Task { await model.selectStatusListTask(row) } } : nil,
                                             onSelectionStart: selectable ? { row in Task { await model.selectStatusListTask(row) } } : nil)
                                }
                                .id(row.text("id"))
                            } else if item.text("type") == "heading" {
                                HStack(spacing: 8) {
                                    Text(item.text("title")).rnFont(13, .bold)
                                        .foregroundStyle(item.flag("muted") ? palette.secondary : palette.text)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .accessibilityAddTraits(.isHeader)
                                        .accessibilityIdentifier("someday-heading-" + item.text("id"))
                                    let addTask = item.object("addTask")
                                    if !addTask.isEmpty {
                                        Button {
                                            Task { await model.openSomedaySectionTask(addTask) }
                                        } label: {
                                            AppIcon(name: "plus", size: 18).frame(width: 44, height: 44)
                                                .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.somedayActionsEnabled)
                                        .accessibilityLabel(addTask.text("accessibilityLabel"))
                                        .accessibilityIdentifier("someday-section-add-task-" + item.text("id"))
                                    }
                                }
                                .padding(.top, 14).padding(.bottom, 4)
                            }
                        }
                        if items.count < model.someday.number("total") {
                            moreButton("someday-more") { await model.loadMoreSomeday() }
                        }
                        emptyState
                    }
                    if model.busy || (!model.somedayCurrent && model.somedayError == nil) {
                        ProgressView().frame(maxWidth: .infinity).padding(12)
                    }
                }
                .padding(16)
            }
            .accessibilityIdentifier("someday-scroll")
            .refreshable { await model.pullToRefresh() }
        }
        .onChange(of: scenePhase) { model.statusListSelectionOwnerChanged(active: $0 == .active) }
        .onDisappear { model.statusListSelectionOwnerChanged(active: false) }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .someday else { return }
                await model.refresh()
            }
        }
    }

    private var stats: some View {
        HStack(alignment: .center, spacing: 8) {
            AppChipFlow {
                let entries = model.someday.objects("stats")
                ForEach(entries.indices, id: \.self) { index in
                    VStack(spacing: 4) {
                        Text(String(entries[index].number("value"))).rnFont(24, .bold).foregroundStyle(Color(hex: "8B5CF6"))
                        Text(entries[index].text("label")).rnFont(12).foregroundStyle(palette.secondary)
                    }
                    .padding(.trailing, 16).accessibilityElement(children: .combine)
                }
                let chip = model.someday.object("filterChip")
                if !chip.isEmpty {
                    Button { Task { await model.editSomedayFilter(model.someday.object("filters").object("clearEdit")) } } label: {
                        HStack(spacing: 4) {
                            Text(chip.text("label")).rnFont(12, .semibold)
                            AppIcon(name: "x", size: 12)
                        }
                        .foregroundStyle(palette.onTint).padding(.horizontal, 10).frame(minHeight: 44)
                        .background(palette.tint, in: Capsule()).contentShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(!model.somedayActionsEnabled)
                    .accessibilityLabel(chip.text("removeLabel")).accessibilityIdentifier("someday-clear-filters")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { model.somedayPanel = "menu" } label: {
                Image(systemName: "ellipsis").rnFont(20).foregroundStyle(palette.secondary)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.somedayActionsEnabled)
            .accessibilityLabel(model.someday.object("menu").text("moreLabel")).accessibilityIdentifier("someday-overflow-button")
        }
        .padding(16).background(palette.card).overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private var moveNotice: some View {
        HStack(spacing: 10) {
            if model.somedayMoveUndoError != nil {
                Text(model.somedayMoveUndoFailureLabel.isEmpty
                     ? model.someday.object("text").text("undoFailed") : model.somedayMoveUndoFailureLabel).rnFont(13)
                    .foregroundStyle(palette.danger).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("someday-section-undo-error")
                if model.somedayMoveUndoCanRetry {
                    Button { Task { await model.retrySomedayMoveUndo() } } label: {
                        Text(model.label("common.retry")).rnFont(13, .semibold)
                            .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("someday-section-undo-retry")
                } else {
                    Button { model.dismissSomedayMoveUndoError() } label: {
                        Text(model.label("common.close")).rnFont(13, .semibold)
                            .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("someday-section-undo-dismiss")
                }
            } else {
                Text(model.somedayMoveNotice.text("message")).rnFont(13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { Task { await model.undoSomedaySectionMove() } } label: {
                    Text(model.somedayMoveNotice.text("undoLabel")).rnFont(13, .semibold)
                        .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.somedayMoveUndoEnabled)
                .accessibilityIdentifier("someday-section-move-undo")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 4)
        .background(palette.card)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("someday-section-move-notice")
    }

    @ViewBuilder private var emptyState: some View {
        let empty = model.someday.object("empty")
        if !empty.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "lightbulb").font(.system(size: 44, weight: .light))
                    .foregroundStyle(palette.secondary).frame(width: 48, height: 48).padding(.bottom, 8).accessibilityHidden(true)
                Text(empty.text("title")).rnFont(18, .semibold)
                Text(empty.text("hint")).rnFont(14).foregroundStyle(palette.secondary)
                if empty.flag("clear") {
                    Button(model.label("filters.clear")) {
                        Task { await model.editSomedayFilter(model.someday.object("filters").object("clearEdit")) }
                    }
                    .rnFont(14, .semibold).frame(minHeight: 44).disabled(!model.somedayActionsEnabled)
                        .accessibilityIdentifier("someday-empty-clear")
                }
            }
            .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 48).padding(.horizontal, 24)
        }
    }

    @ViewBuilder private var deferredProjects: some View {
        let deferred = model.someday.object("deferred")
        let collection = deferred.object("rows")
        if !deferred.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Button { model.somedayProjectsExpanded.toggle() } label: {
                    HStack(spacing: 8) {
                        AppIcon(name: "chevron", size: 18).rotationEffect(.degrees(model.somedayProjectsExpanded ? 0 : -90))
                        Text(deferred.text("title")).rnFont(12, .semibold).tracking(0.5).textCase(.uppercase)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.somedayActionsEnabled)
                .accessibilityValue(model.label(model.somedayProjectsExpanded ? "markdown.collapse" : "markdown.expand"))
                .accessibilityIdentifier("someday-projects-toggle")
                if model.somedayProjectsExpanded {
                    let entries = collection.objects("items")
                    ForEach(entries.indices, id: \.self) { index in
                        let project = entries[index]
                        SwipeActionCard(
                            palette: palette, enabled: model.somedayActionsEnabled,
                            id: "someday-project-" + project.text("id"),
                            leftLabel: deferred.text("activateLabel"), rightLabel: "",
                            leftSystemImage: "arrow.uturn.backward",
                            open: { Task { await model.openProject(project) } },
                            swipe: { _ in Task { await model.activateDeferredProject(project.text("id")) } },
                            content: HStack(spacing: 10) {
                                AppIcon(name: "folder", size: 18)
                                    .foregroundStyle(project.text("color").isEmpty ? palette.secondary : palette.einkSafe(Color(hex: project.text("color"))))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(project.text("title")).rnFont(14, .semibold).foregroundStyle(palette.text)
                                    if !project.text("areaName").isEmpty {
                                        Text(project.text("areaName")).rnFont(12).foregroundStyle(palette.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, 10).padding(.horizontal, 12).frame(minHeight: 44)
                            .background(palette.card, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                        )
                    }
                    if entries.count < collection.number("total") {
                        moreButton("someday-more-deferredProjects") { await model.loadMoreSomeday(deferred: true) }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, model.somedayProjectsExpanded ? 12 : 0)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(.bottom, 4)
        }
    }

    private func moreButton(_ identifier: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Text(model.label("common.more")).rnFont(12, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.filter, in: Capsule()).contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(!model.somedayActionsEnabled).accessibilityIdentifier(identifier)
    }
}

struct SomedayPanel: View {
    @FocusState private var focusedField: String?
    @State private var createFocusedOnce = false
    @State private var taskFocusedOnce = false
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private var menu: CoreObject { model.someday.object("menu") }
    private var isFilter: Bool { model.somedayPanel == "filters" }
    private var isCreate: Bool { model.somedayPanel == "newSection" }
    private var isTaskCreate: Bool { model.somedayPanel == "newSectionTask" }
    private var isMove: Bool { model.somedayPanel == "moveSection" }
    private var isPicker: Bool { !model.somedayPickerName.isEmpty }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: isFilter ? .bottom : .center) {
                Button { close() } label: { Color.black.opacity(isFilter ? 0.35 : 0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("someday-panel-dismiss")
                    .disabled(model.somedaySectionCreatePending || model.somedaySectionCreateAwaitingRefresh
                              || model.somedaySectionTaskPending
                              || model.somedayMovePending || model.somedayMoveAwaitingRefresh
                              || model.somedayMoveLookupOwed || model.busy || model.retryNeeded)
                VStack(alignment: .leading, spacing: 0) {
                    if isCreate {
                        ViewThatFits(in: .vertical) {
                            createContent.fixedSize(horizontal: false, vertical: true)
                            ScrollView { createContent }.scrollDismissesKeyboard(.interactively)
                        }
                    } else if isTaskCreate {
                        ViewThatFits(in: .vertical) {
                            taskCreateContent.fixedSize(horizontal: false, vertical: true)
                            ScrollView { taskCreateContent }.scrollDismissesKeyboard(.interactively)
                        }
                    } else if isMove {
                        ViewThatFits(in: .vertical) {
                            moveContent(scrollChoices: false).fixedSize(horizontal: false, vertical: true)
                            moveContent(scrollChoices: true)
                        }
                    } else if isFilter { filterControls } else {
                        panelHeader
                        ViewThatFits(in: .vertical) {
                            overflowContent.fixedSize(horizontal: false, vertical: true)
                            ScrollView { overflowContent }
                        }
                    }
                }
                .padding(isFilter ? 16 : 12)
                .frame(maxWidth: isFilter ? 860 : 440, maxHeight: geometry.size.height * 0.82, alignment: .top)
                .fixedSize(horizontal: false, vertical: !isFilter)
                .background {
                    RoundedRectangle(cornerRadius: isFilter ? 24 : 16)
                        .fill(palette.card)
                        .contentShape(RoundedRectangle(cornerRadius: isFilter ? 24 : 16))
                        .onTapGesture { }
                }
                .overlay(RoundedRectangle(cornerRadius: isFilter ? 24 : 16).stroke(palette.border, lineWidth: 1))
                .padding(.horizontal, isFilter ? 0 : 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { backOrClose() }
        }
        .onChange(of: isCreate) { if !$0 { createFocusedOnce = false } }
        .onChange(of: isTaskCreate) { if !$0 { taskFocusedOnce = false } }
        .onChange(of: model.busy) { value in
            if !value && isCreate && !createFocusedOnce && !model.somedaySectionCreatePending
                && !model.somedaySectionCreateAwaitingRefresh {
                focusedField = "someday-section-create"
                createFocusedOnce = true
            }
            if !value && isTaskCreate && !taskFocusedOnce && !model.somedaySectionTaskPending
                && !model.somedaySectionTaskAwaitingRefresh {
                focusedField = "someday-section-task"
                taskFocusedOnce = true
            }
        }
    }

    private var panelHeader: some View {
        HStack(spacing: 8) {
            if model.somedayPanel != "menu" {
                Button { backOrClose() } label: {
                    Text(model.label("common.back")).rnFont(13, .semibold).padding(.horizontal, 8).frame(minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier("someday-panel-back")
            }
            Text(model.somedayPanel == "menu" ? menu.text("moreLabel") : menu.object(model.somedayPanel).text("label"))
                .rnFont(17, .bold).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
            Button { close() } label: { AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain).accessibilityLabel(menu.text("closeLabel")).accessibilityIdentifier("someday-menu-close")
        }
        .frame(minHeight: 44).padding(.bottom, 12)
    }

    private var overflowContent: some View {
        VStack(spacing: 4) {
            if model.somedayPanel == "menu" {
                overflowRow(menu.object("filters"), icon: "sliders", id: "someday-filter-action") { model.somedayPanel = "filters" }
                overflowRow(menu.object("sort"), icon: "sort", id: "someday-sort-action") { model.somedayPanel = "sort" }
                overflowRow(menu.object("group"), icon: "folder", id: "someday-group-action") { model.somedayPanel = "group" }
                overflowRow(menu.object("newSection"), icon: "plus", id: "someday-new-section-action") {
                    Task { await model.openSomedaySectionCreate() }
                }
                overflowRow(menu.object("details"), icon: "eye", id: "someday-toggle-details") {
                    let value = !model.someday.flag("showDetails")
                    close()
                    Task { await model.setSomedayOption("showDetails", value: value) }
                }
            } else {
                let key = model.somedayPanel
                let options = menu.object(key).objects("options")
                ForEach(options.indices, id: \.self) { index in
                    let option = options[index]
                    overflowRow(option, icon: "", id: "someday-" + key + "-" + option.text("value")) {
                        close()
                        Task { await model.setSomedayOption(key == "sort" ? "sortBy" : "groupBy", value: option.text("value")) }
                    }
                }
            }
        }
    }

    private func overflowRow(_ item: CoreObject, icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if !icon.isEmpty {
                    Group {
                        if icon == "eye" { Image(systemName: "eye").font(.system(size: 18)) }
                        else { AppIcon(name: icon, size: 18) }
                    }
                    .foregroundStyle(item.flag("selected") ? palette.tint : palette.secondary)
                    .frame(width: 34, height: 34).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                }
                Text(item.text("label")).rnFont(15, .semibold).frame(maxWidth: .infinity, alignment: .leading)
                if !item.text("value").isEmpty && icon != "" {
                    Text(item.text("value")).rnFont(13).foregroundStyle(palette.secondary).multilineTextAlignment(.trailing)
                }
                if item.flag("selected") { Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(palette.tint) }
            }
            .padding(10).frame(minHeight: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.somedayActionsEnabled).accessibilityIdentifier(id)
        .accessibilityLabel(item.text("accessibilityLabel").isEmpty ? item.text("label") : item.text("accessibilityLabel"))
        .accessibilityAddTraits(item.flag("selected") ? .isSelected : [])
    }

    private var filterControls: some View {
        ListFilterControls(
            data: model.someday, strings: model.strings, palette: palette, prefix: "someday",
            enabled: model.somedayActionsEnabled, busy: model.busy, frozen: model.retryNeeded, error: model.somedayError,
            searchText: Binding(get: { model.somedaySearchText }, set: { model.setSomedayText($0) }),
            locationText: Binding(get: { model.somedayLocationText }, set: { model.setSomedayText($0, location: true) }),
            pickerName: model.somedayPickerName, picker: model.somedayPicker, pickerCurrent: model.somedayPickerCurrent,
            pickerEnabled: model.somedayPickerActionsEnabled, pickerError: model.somedayPickerError,
            pickerQuery: Binding(get: { model.somedayPickerQuery }, set: { model.setSomedayPickerQuery($0) }),
            onEdit: { edit in Task { await model.editSomedayFilter(edit) } },
            onChipAction: { action in Task { await model.editSomedayFilter(action.object("filterEdit")) } },
            onArchived: { _ in }, onOpenPicker: model.openSomedayPicker, onBack: model.closeSomedayPicker,
            onMore: model.loadMoreSomedayPicker, onRetry: { Task { await model.retrySomeday() } },
            onRetryPicker: model.retrySomedayPicker, onClose: { model.closeSomedayPanel() }, focusedField: $focusedField)
    }

    private var createContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.label("viewSections.add")).rnFont(17, .bold)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("someday-section-create-title")
            TextField(model.label("viewSections.namePlaceholder"), text: Binding(
                get: { model.somedaySectionCreateDraft }, set: { model.setSomedaySectionCreateDraft($0) }))
                .rnFont(16).focused($focusedField, equals: "someday-section-create")
                .submitLabel(.done).onSubmit {
                    focusedField = nil
                    Task { await model.saveSomedaySectionCreate() }
                }
                .padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(model.somedaySectionCreatePending || model.somedaySectionCreateAwaitingRefresh || model.retryNeeded)
                .accessibilityLabel(model.label("viewSections.nameHint"))
                .accessibilityIdentifier("someday-section-create-input")
            if model.somedaySectionCreateError != nil || model.somedaySectionCreateReadError != nil {
                Text(model.label("viewSections.updateFailed")).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityAddTraits(.updatesFrequently).accessibilityIdentifier("someday-section-create-error")
                Button { Task { await model.retrySomedaySectionCreate() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("someday-section-create-retry")
            } else if model.busy {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                Button { close() } label: {
                    Text(model.label("common.cancel")).rnFont(14, .semibold)
                        .padding(.horizontal, 14).frame(minWidth: 88, minHeight: 44)
                        .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .disabled(model.somedaySectionCreatePending || model.somedaySectionCreateAwaitingRefresh
                              || model.busy || model.retryNeeded)
                    .opacity(model.somedaySectionCreatePending || model.somedaySectionCreateAwaitingRefresh
                             || model.busy || model.retryNeeded ? 0.5 : 1)
                    .accessibilityIdentifier("someday-section-create-cancel")
                Button {
                    focusedField = nil
                    Task { await model.saveSomedaySectionCreate() }
                } label: {
                    Text(model.somedaySectionCreateOptions.object("text").text("saveLabel").isEmpty
                        ? model.label("common.save") : model.somedaySectionCreateOptions.object("text").text("saveLabel"))
                        .rnFont(14, .semibold).padding(.horizontal, 14).frame(minWidth: 88, minHeight: 44)
                        .foregroundStyle(palette.onTint).background(palette.tint, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.somedaySectionCreateCanSave)
                .opacity(model.somedaySectionCreateCanSave ? 1 : 0.5)
                .accessibilityIdentifier("someday-section-create-save")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private var taskCreateContent: some View {
        let copy = model.somedaySectionTaskOptions.object("text")
        return VStack(alignment: .leading, spacing: 14) {
            Text(copy.text("title").isEmpty ? model.label("nav.addTask") : copy.text("title")).rnFont(17, .bold)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("someday-section-task-title")
            TextField(copy.text("placeholder").isEmpty ? model.label("taskEdit.titleLabel") : copy.text("placeholder"), text: Binding(
                get: { model.somedaySectionTaskDraft }, set: { model.setSomedaySectionTaskDraft($0) }))
                .rnFont(16).focused($focusedField, equals: "someday-section-task")
                .submitLabel(.done).onSubmit {
                    focusedField = nil
                    Task { await model.saveSomedaySectionTask() }
                }
                .padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(model.busy || model.somedaySectionTaskPending || model.somedaySectionTaskAwaitingRefresh || model.retryNeeded)
                .accessibilityLabel(copy.text("inputLabel").isEmpty ? model.label("taskEdit.titleLabel") : copy.text("inputLabel"))
                .accessibilityIdentifier("someday-section-task-input")
            if model.somedaySectionTaskError != nil || model.somedaySectionTaskReadError != nil {
                Text(copy.text("failed").isEmpty ? model.label("settings.feedback.actionFailed") : copy.text("failed"))
                    .rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityAddTraits(.updatesFrequently).accessibilityIdentifier("someday-section-task-error")
                Button { Task { await model.retrySomedaySectionTask() } } label: {
                    Text(copy.text("retryLabel").isEmpty ? model.label("common.retry") : copy.text("retryLabel"))
                        .rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("someday-section-task-retry")
            } else if model.busy {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                Button { close() } label: {
                    Text(copy.text("cancelLabel").isEmpty ? model.label("common.cancel") : copy.text("cancelLabel"))
                        .rnFont(14, .semibold).padding(.horizontal, 14).frame(minWidth: 88, minHeight: 44)
                        .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .disabled(model.somedaySectionTaskPending || model.busy || model.retryNeeded)
                    .opacity(model.somedaySectionTaskPending || model.busy || model.retryNeeded ? 0.5 : 1)
                    .accessibilityIdentifier("someday-section-task-cancel")
                Button {
                    focusedField = nil
                    Task { await model.saveSomedaySectionTask() }
                } label: {
                    Text(copy.text("saveLabel").isEmpty ? model.label("common.save") : copy.text("saveLabel"))
                        .rnFont(14, .semibold).padding(.horizontal, 14).frame(minWidth: 88, minHeight: 44)
                        .foregroundStyle(palette.onTint).background(palette.tint, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.somedaySectionTaskCanSave)
                .opacity(model.somedaySectionTaskCanSave ? 1 : 0.5)
                .accessibilityIdentifier("someday-section-task-save")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private var moveChoices: some View {
        let choices = model.somedayMoveOptions.object("choices")
        let items = choices.objects("items")
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(items.indices, id: \.self) { index in
                let choice = items[index]
                Button { Task { await model.chooseSomedayMoveSection(index) } } label: {
                    HStack(spacing: 8) {
                        Text(choice.text("title")).rnFont(15, .medium)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if choice.flag("selected") {
                            Image(systemName: "checkmark").font(.system(size: 16))
                                .foregroundStyle(palette.tint).accessibilityHidden(true)
                        }
                    }
                    .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.somedayMoveActionsEnabled)
                .accessibilityLabel(choice.text("title"))
                .accessibilityAddTraits(choice.flag("selected") ? .isSelected : [])
                .accessibilityIdentifier("someday-section-move-choice-\(index)")
            }
            if items.count < choices.number("total") {
                Button { Task { await model.loadMoreSomedayMoveChoices() } } label: {
                    Text(model.label("common.more")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.somedayMoveActionsEnabled)
                .accessibilityIdentifier("someday-section-move-more")
            }
            Button { Task { await model.openSomedaySectionCreate(fromMove: true) } } label: {
                Text("+ " + model.label("viewSections.add")).rnFont(15, .medium)
                    .foregroundStyle(palette.tint)
                    .frame(maxWidth: .infinity, minHeight: 45, alignment: .leading)
                    .padding(.horizontal, 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.somedayMoveActionsEnabled)
            .accessibilityIdentifier("someday-section-move-new-section")
        }
    }

    private func moveContent(scrollChoices: Bool) -> some View {
        let items = model.somedayMoveOptions.object("choices").objects("items")
        return VStack(alignment: .leading, spacing: 10) {
            Text(model.somedayMoveOptions.text("title").isEmpty
                 ? model.someday.object("text").text("moveToSection") : model.somedayMoveOptions.text("title"))
                .rnFont(17, .bold).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("someday-section-move-title")
            if model.somedayMoveError != nil || model.somedayMoveReadError != nil {
                Text(model.somedayMoveOptions.text("moveFailed").isEmpty
                     ? model.someday.object("text").text("moveFailed") : model.somedayMoveOptions.text("moveFailed")).rnFont(13)
                    .foregroundStyle(palette.danger).accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("someday-section-move-error")
                Button { Task { await model.retrySomedayMove() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy)
                .accessibilityIdentifier("someday-section-move-retry")
            } else if model.busy && items.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
            if scrollChoices {
                ScrollView { moveChoices }
                    .accessibilityIdentifier("someday-section-move-scroll")
            } else {
                moveChoices
            }
            Button {
                focusedField = nil
                model.closeSomedayPanel(abandonCreatedMove: true)
            } label: {
                Text(model.somedayMoveOptions.text("cancelLabel").isEmpty
                     ? model.label("common.cancel") : model.somedayMoveOptions.text("cancelLabel"))
                    .rnFont(14, .semibold).frame(maxWidth: .infinity, minHeight: 44)
                    .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.somedayMovePending || model.somedayMoveAwaitingRefresh || model.busy || model.retryNeeded)
            .opacity(model.somedayMovePending || model.somedayMoveAwaitingRefresh || model.busy || model.retryNeeded ? 0.5 : 1)
            .accessibilityIdentifier("someday-section-move-cancel")
        }
        .frame(maxWidth: .infinity, maxHeight: scrollChoices ? .infinity : nil, alignment: .topLeading)
    }

    private func close() {
        focusedField = nil
        if isCreate { model.cancelSomedaySectionCreate() }
        else { model.closeSomedayPanel() }
    }
    private func backOrClose() {
        focusedField = nil
        if isCreate || isTaskCreate || isMove { close() }
        else if isPicker { model.closeSomedayPicker() }
        else if !isFilter && model.somedayPanel != "menu" { model.somedayPanel = "menu" }
        else { close() }
    }
}

struct SomedayItemKey {
    let identity: String
    let index: Int
}

func somedayItemKeys(_ items: [CoreObject]) -> [SomedayItemKey] {
    var seen: [String: Int] = [:]
    return items.indices.map { index in
        let item = items[index], type = item.text("type")
        let base = type + ":" + (type == "task" ? item.object("row").text("id") : item.text("id"))
        let occurrence = seen[base, default: 0]; seen[base] = occurrence + 1
        return SomedayItemKey(identity: base + "#" + String(occurrence), index: index)
    }
}
