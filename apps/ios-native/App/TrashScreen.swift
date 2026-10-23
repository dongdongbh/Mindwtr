import SwiftUI

struct TrashScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let confirmation = model.trashPurgeConfirmation
        VStack(alignment: .leading, spacing: 0) {
            if model.trashCurrent || model.trashSelectionMode {
                selectionSummary
                if model.trashSelectionMode { bulkRestoreBar }
                if !model.trash.text("retentionHint").isEmpty {
                    Text(model.trash.text("retentionHint")).rnFont(12).foregroundStyle(palette.secondary)
                        .padding(.horizontal, 16).padding(.top, 4)
                        .accessibilityIdentifier("trash-retention-hint")
                }
            }
            GeometryReader { geometry in
                List {
                    Group {
                        if let error = model.trashError {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("trash-error")
                                Button(model.label("common.retry")) { Task { await model.retryTrash() } }
                                    .rnFont(14, .semibold).frame(minHeight: 44)
                                    .disabled(model.busy).accessibilityIdentifier("trash-retry")
                            }
                        }
                        if model.trashCurrent {
                            ForEach(model.trash.objects("items").map(TrashRowEntry.init)) { entry in
                                selectableRow(entry)
                                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                        if model.trashRowActionsEnabled {
                                            let project = entry.item.text("type") == "project"
                                            let id = project ? entry.item.text("id") : entry.item.object("row").text("id")
                                            Button {
                                                Task { await model.restoreTrashItem(id, project: project) }
                                            } label: {
                                                Label(model.trash.object("labels").text("restore"), systemImage: "arrow.counterclockwise")
                                            }
                                            .tint(palette.tint)
                                            .accessibilityIdentifier((project ? "trash-restore-project-" : "trash-restore-") + id)
                                        }
                                    }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        if model.trashRowActionsEnabled {
                                            let project = entry.item.text("type") == "project"
                                            let id = project ? entry.item.text("id") : entry.item.object("row").text("id")
                                            Button { model.requestTrashItemPurge(entry.item) } label: {
                                                Label(model.trash.object("labels").text("delete"), systemImage: "trash")
                                            }
                                            .tint(palette.danger)
                                            .accessibilityIdentifier((project ? "trash-purge-project-" : "trash-purge-task-") + id)
                                        }
                                    }
                            }
                            if model.trash.objects("items").count < model.trash.number("total") {
                                Button { Task { await model.loadMoreTrash() } } label: {
                                    Text(model.label("common.more")).rnFont(12, .semibold)
                                        .padding(.horizontal, 12).frame(minHeight: 44)
                                        .background(palette.filter, in: Capsule()).contentShape(Capsule())
                                }
                                .buttonStyle(.plain).disabled(!model.trashActionsEnabled).accessibilityIdentifier("trash-more")
                            }
                            if !model.trash.object("empty").isEmpty {
                                emptyState.frame(minHeight: max(0, geometry.size.height - 32))
                            }
                        }
                        if model.busy || (!model.trashCurrent && model.trashError == nil) {
                            ProgressView().frame(maxWidth: .infinity).padding(12)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .accessibilityIdentifier("trash-scroll")
                .refreshable { await model.refresh() }
            }
            #if DEBUG && targetEnvironment(simulator)
            if model.trashBulkFixtureEnabled {
                VStack(spacing: 4) {
                    Text(model.trashBulkTestState).rnFont(10).lineLimit(1).accessibilityIdentifier("trash-bulk-fixture-state")
                    HStack {
                        Button("Release Trash response") { model.releaseTrashBulkFixtureResponse() }
                            .accessibilityIdentifier("trash-bulk-fixture-release")
                        Button("Replace Trash read host") { model.replaceTrashBulkFixtureReadHost() }
                            .accessibilityIdentifier("trash-bulk-fixture-host")
                    }
                    .buttonStyle(.bordered).frame(minHeight: 44)
                    if model.trashPurgeFixtureEnabled {
                        Button("Confirm retired Trash alert") { model.exerciseRetiredTrashPurgeFixtureConfirmation() }
                            .buttonStyle(.bordered).frame(minHeight: 44)
                            .accessibilityIdentifier("trash-purge-fixture-late-confirm")
                    }
                }
                .padding(8).background(palette.card)
            }
            #endif
        }
        .alert(confirmation?.copy.text("title") ?? "", isPresented: Binding(
            get: { confirmation != nil },
            set: { shown in if !shown, let id = confirmation?.id { model.cancelTrashPurge(id) } }
        ), presenting: confirmation) { claim in
            Button(claim.copy.text("cancelLabel"), role: .cancel) { model.cancelTrashPurge(claim.id) }
                .accessibilityIdentifier("trash-purge-cancel")
            Button(claim.copy.text("confirmLabel"), role: .destructive) {
                model.confirmTrashPurge(claim.id)
            }
            .accessibilityIdentifier("trash-purge-confirm")
            #if DEBUG && targetEnvironment(simulator)
            .disabled(!model.trashPurgeFixtureCanConfirm)
            #endif
        } message: { claim in
            Text(claim.copy.text("message"))
        }
        .onDisappear {
            if let id = confirmation?.id { model.cancelTrashPurge(id) }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .trash else { return }
                await model.refresh()
            }
        }
    }

    private var selectionSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                summaryText
                VStack(spacing: 8) { selectionToggleButton; if model.trash.number("total") > 0 { clearButton } }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    summaryText
                    selectionToggleButton
                    if model.trash.number("total") > 0 { clearButton }
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
    }

    private var summaryText: some View {
        Text(model.trash.text("summary")).rnFont(13, .medium).foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("trash-summary")
    }

    private var selectionToggleButton: some View {
        Button { Task { await model.toggleTrashSelectionMode() } } label: {
            Text(model.trash.object("labels").text(model.trashSelectionMode ? "done" : "select"))
                .rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.text)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
        .disabled(model.trashSelectionMode ? !model.trashSelectionCanClose : !model.trashActionsEnabled)
        .accessibilityIdentifier("trash-select-toggle")
    }

    private var clearButton: some View {
        Button { Task { await model.requestClearTrashPurge() } } label: {
            Text(model.trash.object("labels").text("clearAll"))
                .rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.danger)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
        .disabled(!model.trashClearEnabled).accessibilityIdentifier("trash-clear")
    }

    private var bulkRestoreBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.trash.object("labels").text("selected")).rnFont(13).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("trash-bulk-count")
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { selectAllButton; bulkRestoreButton; bulkPurgeButton }
            } else {
                HStack(spacing: 8) { selectAllButton; bulkRestoreButton }
                bulkPurgeButton
            }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
        .padding(.horizontal, 16).padding(.vertical, 4)
    }

    private var selectAllButton: some View {
        Button { Task { await model.selectAllTrashItems() } } label: {
            Text(model.trash.object("labels").text("selectAll")).rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.text)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.trashActionsEnabled || model.trash.number("total") == 0
            || model.trashSelectedCount == model.trash.number("total"))
        .accessibilityIdentifier("trash-bulk-select-all")
    }

    private var bulkRestoreButton: some View {
        Button { Task { await model.restoreSelectedTrashItems() } } label: {
            Label(model.trash.object("labels").text("restoreSelected"), systemImage: "arrow.counterclockwise")
                .rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.text)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.trashBulkRestoreEnabled).accessibilityIdentifier("trash-bulk-restore")
    }

    private var bulkPurgeButton: some View {
        Button { model.requestSelectedTrashPurge() } label: {
            Label(model.trash.object("labels").text("deleteSelected"), systemImage: "trash")
                .rnFont(13, .semibold).multilineTextAlignment(.center)
                .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.danger)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!model.trashBulkRestoreEnabled).accessibilityIdentifier("trash-bulk-purge")
    }

    @ViewBuilder private func selectableRow(_ entry: TrashRowEntry) -> some View {
        if model.trashSelectionMode {
            let project = entry.item.text("type") == "project"
            let title = project ? entry.item.text("title") : entry.item.object("row").text("title")
            let selected = model.trashItemSelected(entry.item)
            Button { Task { await model.toggleTrashItemSelection(entry.item) } } label: { row(entry) }
                .buttonStyle(.plain).disabled(!model.trashActionsEnabled)
                .accessibilityLabel(model.trash.object("labels").text("select") + " " + title)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("trash-select-" + entry.identity)
        } else { row(entry) }
    }

    private func row(_ entry: TrashRowEntry) -> some View {
        let item = entry.item
        let project = item.text("type") == "project"
        let data = project ? item : item.object("row")
        let selected = model.trashSelectionMode && model.trashItemSelected(item)
        return HStack(spacing: 12) {
            if model.trashSelectionMode {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? palette.tint : palette.secondary)
                    .frame(width: 22).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(data.text("title")).rnFont(16, .semibold).strikethrough()
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 4)
                if !item.text("descriptionMarkdown").isEmpty {
                    Text(inlineMarkdown(item.text("descriptionMarkdown"))).rnFont(14).lineLimit(1).padding(.bottom, 4)
                }
                Text(item.text("typeLabel")).rnFont(12).italic()
                Text(item.text("deletedLabel")).rnFont(12).italic()
            }
            .foregroundStyle(palette.secondary)
            if !project || !item.text("indicatorColor").isEmpty {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(hex: project ? item.text("indicatorColor") : "6B7280"))
                    .frame(width: 4).accessibilityHidden(true)
            }
        }
        .fixedSize(horizontal: false, vertical: true).padding(16)
        .background(palette.row, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? palette.tint : palette.border, lineWidth: selected ? 2 : 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("trash-" + entry.identity)
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {
        var preview = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(source)
        // RN's Trash rows are static outside selection. Preserve inline styling
        // without turning Markdown in a deleted item into an interactive link.
        preview.link = nil
        return preview
    }

    private var emptyState: some View {
        let empty = model.trash.object("empty")
        return VStack(spacing: 0) {
            Image(systemName: "trash").font(.system(size: 40, weight: .light))
                .foregroundStyle(palette.secondary).padding(.bottom, 12).accessibilityHidden(true)
            Text(empty.text("title")).rnFont(18, .semibold).padding(.bottom, 6).accessibilityIdentifier("trash-empty")
            Text(empty.text("message")).rnFont(14).foregroundStyle(palette.secondary)
        }
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}

private struct TrashRowEntry: Identifiable {
    let item: CoreObject
    var id: Data { Data(identity.utf8) }
    var identity: String {
        item.text("type") + "-" + (item.text("type") == "task" ? item.object("row").text("id") : item.text("id"))
    }
}
