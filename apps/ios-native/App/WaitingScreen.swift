import SwiftUI

struct WaitingScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    private var showsList: Bool { model.waitingCurrent || (model.busy && !model.waiting.isEmpty) }

    var body: some View {
        VStack(spacing: 0) {
            if showsList {
                stats
                peopleFilter
            }
            if model.statusListSelectionMode { StatusListBulkBar(model: model, palette: palette, idPrefix: "waiting") }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.waitingError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("waiting-error")
                        Button(model.label("common.retry")) { Task { await model.refresh() } }
                            .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("waiting-retry")
                    }
                    if showsList {
                        deferredProjects
                        let rows = model.waiting.objects("rows")
                        ForEach(rows.indices, id: \.self) { index in
                            let row = rows[index]
                            let selecting = model.statusListSelectionMode
                            let selectable = model.statusListTaskSelectable(row)
                            HStack(spacing: 8) {
                                if selecting && selectable { StatusListSelectButton(model: model, row: row, palette: palette, idPrefix: "waiting") }
                                TaskCard(row: row, model: model, palette: palette,
                                         readOnly: selecting || row.flag("readOnly"), hideStatusBadge: selecting,
                                         showDetails: model.waiting.flag("showDetails"),
                                         onSelection: selecting && selectable ? { row in Task { await model.selectStatusListTask(row) } } : nil,
                                         onSelectionStart: selectable ? { row in Task { await model.selectStatusListTask(row) } } : nil)
                            }
                            .id(row.text("id"))
                        }
                        if rows.count < model.waiting.number("total") {
                            moreButton("waiting-more") { await model.loadMoreWaiting() }
                        }
                        let empty = model.waiting.object("empty")
                        if !empty.isEmpty {
                            VStack(spacing: 8) {
                                pauseIcon.foregroundStyle(palette.secondary).padding(.bottom, 8)
                                Text(empty.text("title")).rnFont(18, .semibold)
                                Text(empty.text("hint")).rnFont(14).foregroundStyle(palette.secondary)
                            }
                            .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                            .padding(.vertical, 48).padding(.horizontal, 24)
                            .accessibilityElement(children: .combine).accessibilityIdentifier("waiting-empty")
                        }
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(16)
            }
            .accessibilityIdentifier("waiting-scroll")
            .refreshable { await model.pullToRefresh() }
        }
        .onChange(of: scenePhase) { model.statusListSelectionOwnerChanged(active: $0 == .active) }
        .onDisappear { model.statusListSelectionOwnerChanged(active: false) }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .waiting else { return }
                await model.refresh()
            }
        }
    }

    private var stats: some View {
        HStack(alignment: .top, spacing: 24) {
            let entries = model.waiting.objects("stats")
            ForEach(entries.indices, id: \.self) { index in
                VStack(spacing: 4) {
                    Text(String(entries[index].number("value"))).rnFont(24, .bold).foregroundStyle(Color(hex: "F59E0B"))
                    Text(entries[index].text("label")).rnFont(12).foregroundStyle(palette.secondary)
                        .multilineTextAlignment(.center)
                }
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 0)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private var peopleFilter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.waiting.text("filterLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let all = model.waiting.object("all")
                    personChip(label: all.text("label"), person: "", selected: all.flag("selected"), identifier: "waiting-person-all")
                    let people = model.waiting.object("people")
                    let entries = people.objects("items")
                    ForEach(entries.indices, id: \.self) { index in
                        let person = entries[index]
                        personChip(label: person.text("label"), person: person.text("person"), selected: person.flag("selected"),
                                   identifier: "waiting-person-" + person.text("person"))
                    }
                    if entries.count < people.number("total") {
                        moreButton("waiting-more-people") { await model.loadMoreWaitingCollection("people") }
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if !model.waiting.text("clearLabel").isEmpty {
                Button { Task { await model.selectWaitingPerson("") } } label: {
                    Text(model.waiting.text("clearLabel")).rnFont(12, .semibold)
                        .padding(.horizontal, 8).frame(minHeight: 44)
                        .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.waitingActionsEnabled).accessibilityIdentifier("waiting-clear-person")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.card).overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private func personChip(label: String, person: String, selected: Bool, identifier: String) -> some View {
        Button { Task { await model.selectWaitingPerson(person) } } label: {
            Text(label).rnFont(12, .semibold).foregroundStyle(selected ? palette.onTint : palette.text)
                .multilineTextAlignment(.center).padding(.horizontal, 12).padding(.vertical, 6)
                .frame(minHeight: 44).frame(maxWidth: 180)
                .background(selected ? palette.tint : palette.filter, in: Capsule())
                .overlay(Capsule().stroke(palette.border, lineWidth: 1)).contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(!model.waitingActionsEnabled)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityIdentifier(identifier)
    }

    @ViewBuilder private var deferredProjects: some View {
        let deferred = model.waiting.object("deferred")
        let collection = deferred.object("rows")
        if !deferred.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Button { model.waitingProjectsExpanded.toggle() } label: {
                    HStack(spacing: 8) {
                        AppIcon(name: "chevron", size: 18).rotationEffect(.degrees(model.waitingProjectsExpanded ? 0 : -90))
                        Text(deferred.text("title"))
                            .rnFont(12, .semibold).tracking(0.5).textCase(.uppercase)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.waitingActionsEnabled)
                .accessibilityValue(model.label(model.waitingProjectsExpanded ? "markdown.collapse" : "markdown.expand"))
                .accessibilityIdentifier("waiting-projects-toggle")
                if model.waitingProjectsExpanded {
                    let entries = collection.objects("items")
                    ForEach(entries.indices, id: \.self) { index in
                        let project = entries[index]
                        SwipeActionCard(
                            palette: palette, enabled: model.waitingActionsEnabled,
                            id: "waiting-project-" + project.text("id"),
                            leftLabel: deferred.text("activateLabel"), rightLabel: "",
                            leftSystemImage: "arrow.uturn.backward",
                            open: { Task { await model.openProject(project) } },
                            swipe: { _ in Task { await model.activateDeferredProject(project.text("id")) } },
                            content: HStack(spacing: 10) {
                                AppIcon(name: "folder", size: 18)
                                    .foregroundStyle(project.text("color").isEmpty ? palette.secondary : Color(hex: project.text("color")))
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
                        moreButton("waiting-more-deferredProjects") { await model.loadMoreWaitingCollection("deferredProjects") }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, model.waitingProjectsExpanded ? 12 : 0)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
            .padding(.bottom, 4)
        }
    }

    private func moreButton(_ identifier: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Text(model.label("common.more")).rnFont(12, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.filter, in: Capsule()).contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(!model.waitingActionsEnabled).accessibilityIdentifier(identifier)
    }

    private var pauseIcon: some View {
        // Lucide PauseCircle, as in RN's empty Waiting view.
        Path { path in
            path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20))
            path.move(to: CGPoint(x: 10, y: 8)); path.addLine(to: CGPoint(x: 10, y: 16))
            path.move(to: CGPoint(x: 14, y: 8)); path.addLine(to: CGPoint(x: 14, y: 16))
        }
        .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24).scaleEffect(2).frame(width: 48, height: 48).accessibilityHidden(true)
    }
}

struct StatusListSelectButton: View {
    @ObservedObject var model: CoreModel
    let row: CoreObject
    let palette: AppPalette
    let idPrefix: String

    var body: some View {
        let selected = model.statusListTaskSelected(row.text("id"))
        Button { Task { await model.selectStatusListTask(row) } } label: {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 22)).foregroundStyle(palette.tint)
                .frame(width: 45, height: 45).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(row.text("title"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(idPrefix + "-select-" + row.text("id"))
    }
}

struct StatusListBulkBar: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let idPrefix: String
    @State private var deletePresented = false

    var body: some View {
        let bar = model.statusListBulk.object("bar")
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(bar.text("countLabel"))
                    .rnFont(13).foregroundStyle(palette.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(idPrefix + "-bulk-count")
                Spacer(minLength: 0)
                Button { model.leaveStatusListSelection() } label: {
                    AppIcon(name: "x", size: 16).frame(width: 45, height: 45).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(!model.statusListSelectionExitEnabled)
                .accessibilityLabel(bar.object("exit").text("accessibilityLabel"))
                .accessibilityIdentifier(idPrefix + "-bulk-exit")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let statuses = bar.objects("statuses")
                    ForEach(statuses.indices, id: \.self) { index in
                        let option = statuses[index]
                        action(option.text("label"), accessibility: option.text("accessibilityLabel"),
                               id: "-bulk-status-" + option.text("status"), enabled: model.statusListBulkStatusEnabled(option.text("status"))) {
                            Task { await model.moveSelectedStatusListTasks(status: option.text("status")) }
                        }
                    }
                    let moveToSection = bar.object("moveToSection")
                    if idPrefix == "someday" && !moveToSection.isEmpty {
                        action(moveToSection.text("label"), id: "-bulk-move-section", enabled: model.statusListBulkMoveToSectionEnabled) {
                            Task { await model.openSelectedSomedaySectionMove() }
                        }
                    }
                    action(bar.object("addTag").text("label"), accessibility: bar.object("addTag").text("accessibilityLabel"),
                           id: "-bulk-tag-open", enabled: model.statusListBulkTagEnabled) { model.openStatusListBulkTag() }
                    if ["waiting", "someday"].contains(idPrefix) {
                        action(bar.object("range").text("label"), id: "-bulk-range", enabled: model.statusListBulkRangeEnabled,
                               selected: model.statusListRangeSelectMode) { Task { await model.toggleStatusListRange() } }
                    }
                    if let text = model.statusListBulk["shareText"] as? String, !text.isEmpty {
                        ShareLink(item: text) {
                            Text(model.label("common.share")).rnFont(13, .semibold).fixedSize(horizontal: true, vertical: false)
                                .padding(.horizontal, 12).frame(minWidth: 45, minHeight: 45)
                                .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border).allowsHitTesting(false))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.statusListBulkShareEnabled)
                        .accessibilityIdentifier(idPrefix + "-bulk-share")
                    }
                    action(bar.object("delete").text("label"), id: "-bulk-delete", enabled: model.statusListBulkDeleteEnabled, destructive: true) {
                        model.requestDeleteSelectedStatusListTasks()
                        deletePresented = !model.archiveBulkDeleteConfirmation.isEmpty
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(idPrefix + "-bulk-actions-scroll")
            if let message = model.statusListBulkError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(idPrefix + "-bulk-error")
            }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border).allowsHitTesting(false))
        .padding(.horizontal, 16).padding(.vertical, 8)
        .alert(model.archiveBulkDeleteConfirmation.text("title"), isPresented: $deletePresented) {
            Button(model.archiveBulkDeleteConfirmation.text("cancelLabel"), role: .cancel) {
                model.cancelArchiveBulkDeleteConfirmation()
            }.accessibilityIdentifier(idPrefix + "-bulk-cancel")
            Button(model.archiveBulkDeleteConfirmation.text("confirmLabel"), role: .destructive) {
                Task { await model.confirmDeleteSelectedArchiveTasks() }
            }.accessibilityIdentifier(idPrefix + "-bulk-confirm")
        } message: { Text(model.archiveBulkDeleteConfirmation.text("message")) }
        .onChange(of: model.archiveBulkDeleteConfirmation.isEmpty) { if $0 { deletePresented = false } }
        .sheet(isPresented: Binding(get: { model.statusListTagPresented }, set: { if !$0 { model.closeStatusListBulkTag() } })) {
            StatusListTagSheet(model: model, palette: palette, idPrefix: idPrefix)
                .presentationDetents([.medium, .large])
                .interactiveDismissDisabled(!model.statusListTagCloseEnabled)
        }
    }

    private func action(_ title: String, accessibility: String? = nil, id: String, enabled: Bool,
                        destructive: Bool = false, selected: Bool = false, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).rnFont(13, .semibold).fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 12).frame(minWidth: 45, minHeight: 45)
                .background(selected ? palette.tint.opacity(0.18) : palette.card, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border).allowsHitTesting(false))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(destructive ? palette.danger : palette.tint)
        .disabled(!enabled)
        .accessibilityLabel(accessibility ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(idPrefix + id)
    }
}

struct StatusListTagSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let idPrefix: String
    @FocusState private var inputFocused: Bool

    var body: some View {
        let options = model.statusListTagOptions
        VStack(alignment: .leading, spacing: 12) {
            Text(options.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            TextField(options.text("placeholder"), text: Binding(get: { model.statusListTagText }, set: { model.setStatusListTagText($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().focused($inputFocused)
                .submitLabel(.done).onSubmit { inputFocused = false }
                .padding(12).frame(minHeight: 45).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .accessibilityLabel(options.text("placeholder"))
                .accessibilityIdentifier(idPrefix + "-bulk-tag-input")
            if let message = model.statusListTagReadError ?? model.statusListBulkError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(idPrefix + "-bulk-tag-error")
            }
            HStack(spacing: 12) {
                Button { model.closeStatusListBulkTag() } label: {
                    Text(options.text("cancelLabel")).rnFont(15, .semibold).frame(maxWidth: .infinity, minHeight: 45).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.text).disabled(!model.statusListTagCloseEnabled)
                .accessibilityIdentifier(idPrefix + "-bulk-tag-cancel")
                Button { inputFocused = false; Task { await model.saveStatusListBulkTag() } } label: {
                    Text(options.text("saveLabel")).rnFont(15, .semibold).frame(maxWidth: .infinity, minHeight: 45)
                        .background(palette.tint, in: RoundedRectangle(cornerRadius: 8)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.onTint).disabled(!model.statusListTagSaveEnabled)
                .accessibilityIdentifier(idPrefix + "-bulk-tag-save")
            }
            Spacer(minLength: 0)
        }
        .padding(16).background(palette.bg)
        .onAppear { inputFocused = true }
    }
}
