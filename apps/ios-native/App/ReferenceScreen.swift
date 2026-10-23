import SwiftUI
import UIKit

struct ReferenceScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @State private var bulkDeletePresented = false

    var body: some View {
        ZStack {
        VStack(spacing: 0) {
            if model.referenceSelectionMode { bulkDeleteBar }
        StatusListContent(model: model, palette: palette, data: model.reference, prefix: "reference",
                          current: model.referenceCurrent, enabled: model.referenceActionsEnabled,
                          error: model.referenceError, disableStatus: false,
                          onRetry: { Task { await model.retryReference() } },
                          onMore: { Task { await model.loadMoreReference() } },
                          onFilters: { model.referencePanel = "filters" },
                          onChipAction: { action in Task { await model.applyReferenceChipAction(action) } },
                          onClear: { Task { await model.editReferenceFilter(model.reference.object("filters").object("clearEdit")) } },
                          onCollapse: { id in Task { await model.toggleReferenceSection(id) } },
                          onDeleteTask: { id, revision in Task { await model.deleteReferenceTask(expectedID: id, expectedRevision: revision) } },
                          onNextTask: { id, revision in Task { await model.moveReferenceTaskToNext(expectedID: id, expectedRevision: revision) } },
                          onStatusOptions: { row in await model.referenceTaskStatusOptions(row) },
                          onStatusChange: { row, status in Task { await model.changeReferenceTaskStatus(row, status: status) } },
                          onBackdateOptions: { row in await model.referenceTaskBackdateOptions(row) },
                          onBackdateSave: { row, instant, minutes in await model.backdateReferenceTask(row, completedAt: instant, timeSpentText: minutes) },
                          onDestinationOptions: { row, query, offset in await model.referenceTaskDestinationOptions(row, query: query, offset: offset) },
                          onDestinationChoose: { row, destination in await model.moveReferenceTaskDestination(row, destination: destination) },
                          errorIdentifier: model.referenceBulkRemoveWriteError ? "reference-bulk-remove-tag-error" : model.referenceBulkTagWriteError ? "reference-bulk-tag-error" : nil,
                          selectionActive: model.referenceSelectionMode, selectedTaskIDs: model.referenceSelectedIDs,
                          onSelection: { row in Task { await model.selectReferenceTask(row) } },
                          onSelectionStart: { row in Task { await model.selectReferenceTask(row) } })
        }
        .accessibilityHidden(model.referenceBulkTagPresented || model.referenceBulkRemovePresented)
        if model.referenceBulkTagPresented { ReferenceBulkTagDialog(model: model, palette: palette) }
        if model.referenceBulkRemovePresented { ReferenceBulkRemoveTagDialog(model: model, palette: palette) }
        }
        .alert(model.archiveBulkDeleteConfirmation.text("title"), isPresented: $bulkDeletePresented) {
            Button(model.archiveBulkDeleteConfirmation.text("cancelLabel"), role: .cancel) {
                model.cancelArchiveBulkDeleteConfirmation()
            }.accessibilityIdentifier("reference-bulk-cancel")
            Button(model.archiveBulkDeleteConfirmation.text("confirmLabel"), role: .destructive) {
                Task { await model.confirmDeleteSelectedArchiveTasks() }
            }.accessibilityIdentifier("reference-bulk-confirm")
        } message: { Text(model.archiveBulkDeleteConfirmation.text("message")) }
        .onChange(of: model.archiveBulkDeleteConfirmation.isEmpty) { if $0 { bulkDeletePresented = false } }
        .onDisappear { model.referenceSelectionOwnerChanged() }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .reference else { return }
                // The first selection query has not published selection mode yet.
                // Do not queue a timer refresh behind that in-flight operation.
                guard !model.busy else { continue }
                // A periodic reread disables the current controls while it runs.
                // Keep an in-progress selection usable; writes still validate
                // the selected revisions against durable data before committing.
                guard !model.referenceSelectionMode, !model.referenceBulkTagPresented, !model.referenceBulkRemovePresented, !model.referenceActionPending else {
                    NSLog("Native iOS Reference periodic refresh deferred releaseCheck=v1.3.4/ios-reference-bulk-refresh outcome=selection")
                    continue
                }
                await model.refresh()
            }
        }
    }

    private var bulkDeleteBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(model.referenceBulk.object("bar").text("countLabel"))
                    .rnFont(13).foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("reference-bulk-count")
                Spacer(minLength: 0)
                Button { model.leaveReferenceTaskSelection() } label: {
                    AppIcon(name: "x", size: 16).frame(width: 45, height: 45).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.secondary)
                .disabled(!model.referenceActionsEnabled)
                .accessibilityLabel(model.referenceBulk.object("bar").object("exit").text("accessibilityLabel"))
                .accessibilityIdentifier("reference-bulk-exit")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    let statuses = model.referenceBulk.object("bar").objects("statuses")
                    ForEach(statuses.indices, id: \.self) { index in
                        let option = statuses[index]
                        Button { Task { await model.moveSelectedReferenceTasks(status: option.text("status")) } } label: {
                            bulkActionLabel(option.text("label"))
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(!model.referenceBulkStatusEnabled(option.text("status")))
                        .accessibilityLabel(option.text("accessibilityLabel"))
                        .accessibilityIdentifier("reference-bulk-status-" + option.text("status"))
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("reference-bulk-status-scroll")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Button { Task { await model.toggleReferenceTaskRange() } } label: {
                        bulkActionLabel(model.referenceBulk.object("bar").object("range").text("label"))
                    }
                    .buttonStyle(.plain).disabled(!model.referenceBulkDeleteEnabled)
                    .accessibilityAddTraits(model.referenceBulk.object("bar").object("range").flag("active") ? .isSelected : [])
                    .accessibilityIdentifier("reference-bulk-range")
                    Button { model.openReferenceBulkTag() } label: {
                        bulkActionLabel(model.referenceBulk.object("bar").object("addTag").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.referenceBulkTagEnabled)
                    .accessibilityLabel(model.referenceBulk.object("bar").object("addTag").text("accessibilityLabel"))
                    .accessibilityIdentifier("reference-bulk-add-tag")
                    Button { model.openReferenceBulkRemove() } label: {
                        bulkActionLabel(model.referenceBulk.object("bar").object("removeTag").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.referenceBulkRemoveEnabled)
                    .accessibilityLabel(model.referenceBulk.object("bar").object("removeTag").text("accessibilityLabel"))
                    .accessibilityIdentifier("reference-bulk-remove-tag")
                    Button {
                        model.requestDeleteSelectedReferenceTasks()
                        bulkDeletePresented = !model.archiveBulkDeleteConfirmation.isEmpty
                    } label: {
                        bulkActionLabel(model.referenceBulk.object("bar").object("delete").text("label"))
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.danger).disabled(!model.referenceBulkDeleteEnabled)
                    .accessibilityIdentifier("reference-bulk-delete")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("reference-bulk-actions-scroll")
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border).allowsHitTesting(false))
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func bulkActionLabel(_ text: String) -> some View {
        Text(text).rnFont(13, .semibold).fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 12).frame(minWidth: 45, minHeight: 45)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border).allowsHitTesting(false))
            .contentShape(Rectangle())
    }
}

private struct ReferenceBulkTagDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    private var fields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.referenceBulkTagOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            TextField(model.referenceBulkTagOptions.text("placeholder"), text: Binding(
                get: { model.referenceBulkTagText }, set: { model.setReferenceBulkTagText($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.referenceBulkTagOptions.text("placeholder"))
                .accessibilityIdentifier("reference-bulk-tag-input")
            if let error = model.referenceBulkTagReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("reference-bulk-tag-read-error")
                Button { model.setReferenceBulkTagText(model.referenceBulkTagText) } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("reference-bulk-tag-read-retry")
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture {
                    if !model.busy && !model.retryNeeded { model.closeReferenceBulkTag() }
                }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    if dynamicTypeSize.isAccessibilitySize {
                        ScrollView { fields }
                            .frame(maxHeight: min(420, max(120, geometry.size.height - 132)))
                            .accessibilityIdentifier("reference-bulk-tag-scroll")
                    } else { fields }
                    HStack {
                        Spacer()
                        Button { model.closeReferenceBulkTag() } label: {
                            Text(model.referenceBulkTagOptions.text("cancelLabel")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("reference-bulk-tag-cancel")
                        Button { Task { await model.saveReferenceBulkTag() } } label: {
                            Text(model.referenceBulkTagOptions.text("saveLabel")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.referenceBulkTagSaveEnabled)
                        .accessibilityIdentifier("reference-bulk-tag-save")
                    }
                }
                .padding(16).frame(maxWidth: 420)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("reference-bulk-tag-dialog").accessibilityAction(.escape) {
                if !model.busy && !model.retryNeeded { model.closeReferenceBulkTag() }
            }
        }
    }
}

private struct ReferenceBulkRemoveTagDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var focused: Bool

    private var heading: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.referenceBulkRemoveOptions.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
            Text(model.referenceBulkRemoveOptions.text("description")).rnFont(13).foregroundStyle(palette.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var queryInput: some View {
        TextField(model.referenceBulkRemoveOptions.text("placeholder"), text: Binding(get: { model.referenceBulkRemoveQuery }, set: { model.setReferenceBulkRemoveQuery($0) }))
            .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
            .submitLabel(.done).onSubmit { focused = false }
            .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .accessibilityLabel(model.referenceBulkRemoveOptions.text("placeholder"))
            .disabled(model.busy || model.retryNeeded)
            .accessibilityIdentifier("reference-bulk-remove-tag-input")
            .fixedSize(horizontal: false, vertical: true).layoutPriority(1)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppChipFlow {
                ForEach(model.referenceBulkRemoveItems.indices, id: \.self) { index in
                    let item = model.referenceBulkRemoveItems[index]
                    let picked = model.referenceBulkRemovePicked(item.text("value"))
                    Button { model.toggleReferenceBulkRemove(item.text("value")) } label: {
                        Text(item.text("label")).rnFont(14).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 12).padding(.vertical, 8).frame(minWidth: 44, minHeight: 44)
                            .background(picked ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(picked ? palette.tint : palette.border, lineWidth: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(picked ? palette.onTint : palette.text)
                    .disabled(model.busy || model.retryNeeded || !model.referenceBulkRemoveCurrent || model.referenceBulkRemoveReading)
                    .accessibilityLabel(item.text("label")).accessibilityAddTraits(picked ? .isSelected : [])
                    .accessibilityIdentifier("reference-bulk-remove-tag-option-\(index)")
                }
            }
            if model.referenceBulkRemoveReading { ProgressView().accessibilityLabel(model.label("common.loading")) }
            if model.referenceBulkRemoveCurrent && model.referenceBulkRemoveTotal == 0 {
                Text(model.label("common.noMatches")).rnFont(14).foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("reference-bulk-remove-tag-no-matches")
            }
            if model.referenceBulkRemoveItems.count < model.referenceBulkRemoveTotal {
                Button { model.loadMoreReferenceBulkRemove() } label: {
                    Text(model.label("common.more")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.referenceBulkRemoveCanLoadMore)
                .accessibilityIdentifier("reference-bulk-remove-tag-more")
            }
            if let error = model.referenceBulkRemoveReadError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("reference-bulk-remove-tag-read-error")
                Button { model.retryReferenceBulkRemoveRead() } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded || model.referenceBulkRemoveReading)
                .accessibilityIdentifier("reference-bulk-remove-tag-read-retry")
            }
        }
    }

    private var actions: some View {
        HStack {
            Spacer()
            Button { model.closeReferenceBulkRemove() } label: {
                Text(model.referenceBulkRemoveOptions.text("cancelLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded).accessibilityIdentifier("reference-bulk-remove-tag-cancel")
            Button { Task { await model.saveReferenceBulkRemove() } } label: {
                Text(model.referenceBulkRemoveOptions.text("saveLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.referenceBulkRemoveSaveEnabled)
            .accessibilityIdentifier("reference-bulk-remove-tag-save")
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
            .accessibilityIdentifier("reference-bulk-remove-tag-scroll")
            actions
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { if !model.busy && !model.retryNeeded { model.closeReferenceBulkRemove() } }.accessibilityHidden(true)
                // Keep one query field as keyboard height changes. Accessibility
                // text or less than 500pt moves only informational copy into the scroll.
                contents(scrollingHeading: dynamicTypeSize.isAccessibilitySize || geometry.size.height < 500)
                .padding(16).frame(maxWidth: 420, maxHeight: max(0, geometry.size.height - 32))
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
                #if DEBUG && targetEnvironment(simulator)
                if model.referenceBulkRemoveTestReadEnabled {
                    Text("Reference picker read test state").font(.system(size: 1)).frame(width: 1, height: 1)
                        .accessibilityIdentifier("reference-bulk-remove-tag-test-read-state")
                        .accessibilityValue(model.referenceBulkRemoveTestReadState).allowsHitTesting(false)
                }
                #endif
            }
            .foregroundStyle(palette.text).accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("reference-bulk-remove-tag-dialog").accessibilityAction(.escape) { if !model.busy && !model.retryNeeded { model.closeReferenceBulkRemove() } }
            .onAppear { focused = true }
        }
    }
}

// Grouped tag lists may contain the same task in several sections.
struct ListRowEntry: Identifiable {
    let item: CoreObject
    var id: Data {
        let raw: String
        switch item.text("type") {
        case "task": raw = "task:" + item.text("groupId") + ":" + item.object("row").text("id")
        default: raw = item.text("type") + ":" + item.text("id")
        }
        return Data(raw.utf8)
    }
}

// Reference and Done consume the same core status-list DTO and RN TaskList layout.
struct StatusListContent: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let data: CoreObject
    let prefix: String
    let current: Bool
    let enabled: Bool
    let error: String?
    let disableStatus: Bool
    let onRetry: () -> Void
    let onMore: () -> Void
    let onFilters: () -> Void
    let onChipAction: (CoreObject) -> Void
    let onClear: () -> Void
    let onCollapse: (String) -> Void
    let onDeleteTask: ((String, String) -> Void)?
    var onNextTask: ((String, String) -> Void)? = nil
    var onStatusOptions: ((CoreObject) async -> CoreObject?)? = nil
    var onStatusChange: ((CoreObject, String) -> Void)? = nil
    var onBackdateOptions: ((CoreObject) async -> CoreObject?)? = nil
    var onBackdateSave: ((CoreObject, String, String?) async -> Bool)? = nil
    var onDestinationOptions: ((CoreObject, String, Int) async -> CoreObject?)? = nil
    var onDestinationChoose: ((CoreObject, CoreObject) async -> Bool)? = nil
    var onCompletedAt: ((CoreObject) -> Void)? = nil
    var errorIdentifier: String? = nil
    var selectionActive = false
    var selectedTaskIDs: [String] = []
    var onSelection: ((CoreObject) -> Void)? = nil
    var onSelectionStart: ((CoreObject) -> Void)? = nil
    // One stable list owner serves repeated tag-group occurrences of a task.
    @State private var referenceStatusRow: CoreObject = [:]
    @State private var referenceStatusOptions: CoreObject = [:]
    @State private var referenceStatusMenuPresented = false
    @State private var referenceStatusOptionsTask: Task<Void, Never>?
    @State private var referenceStatusGeneration = 0
    @State private var referenceStatusOpeningContext = ""
    @State private var ownsReferenceStatusMenu = false
    @State private var referenceDestinationActive = false
    @State private var referenceBackdateActive = false
    @State private var referenceBackdateOptions: CoreObject = [:]
    @State private var referenceBackdateInitialDate = Date()

    // Keep Reference's existing row identities during a background reread.
    // Removing the snapshot here resets List's scroll position every minute.
    // `current` still gates interaction until the new snapshot is accepted.
    private var displaysSnapshot: Bool {
        current || (prefix == "reference" && data.text("kind") == "reference" && error == nil)
    }

    private var listContent: some View {
        VStack(spacing: 0) {
            if displaysSnapshot { activeFilters }
            if prefix == "done" || prefix == "reference" {
                List {
                    Group { contentRows }
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .accessibilityIdentifier(prefix + "-scroll")
                .refreshable { await model.refresh() }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) { contentRows }
                        .padding(16)
                }
                .accessibilityIdentifier(prefix + "-scroll")
                .refreshable { await model.refresh() }
            }
        }
    }

    @ViewBuilder var body: some View {
        if prefix == "reference" {
            ZStack {
                listContent.accessibilityHidden(referenceBackdateActive || referenceDestinationActive)
                if referenceDestinationActive {
                    ReferenceTaskDestinationDialog(model: model, palette: palette, close: closeReferenceStatusMenu,
                                                   read: { query, offset in
                        guard referenceStatusIsCurrent, let onDestinationOptions else { return nil }
                        return await onDestinationOptions(referenceStatusRow, query, offset)
                    }, choose: { destination in
                        guard referenceStatusIsCurrent, let onDestinationChoose else { return false }
                        let saved = await onDestinationChoose(referenceStatusRow, destination)
                        if saved { closeReferenceStatusMenu() }
                        return saved
                    })
                }
                if referenceBackdateActive {
                    if !referenceBackdateOptions.isEmpty {
                        ReferenceTaskBackdateDialog(model: model, palette: palette, options: referenceBackdateOptions,
                                                   initialDate: referenceBackdateInitialDate, close: closeReferenceStatusMenu,
                                                   save: { instant, minutes in
                            guard referenceStatusIsCurrent, let onBackdateSave else { return false }
                            let displayed = referenceStatusRow
                            let saved = await onBackdateSave(displayed, instant, minutes)
                            if saved { closeReferenceStatusMenu() }
                            return saved
                        })
                    } else {
                        VStack(spacing: 12) {
                            ProgressView()
                            Button(model.label("common.cancel")) { closeReferenceStatusMenu() }
                                .frame(minHeight: 44).contentShape(Rectangle())
                                .accessibilityIdentifier("reference-backdate-cancel")
                        }
                        .padding(24).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
                    }
                }
            }
            .confirmationDialog(referenceStatusOptions.text("title"), isPresented: $referenceStatusMenuPresented, titleVisibility: .visible) {
                ForEach(referenceStatusOptions.objects("options").indices, id: \.self) { index in
                    let option = referenceStatusOptions.objects("options")[index]
                    Button((option.flag("selected") ? "✓ " : "") + option.text("label")) {
                        guard referenceStatusIsCurrent, enabled, !model.busy, !model.retryNeeded else {
                            closeReferenceStatusMenu()
                            return
                        }
                        let displayed = referenceStatusRow
                        closeReferenceStatusMenu()
                        onStatusChange?(displayed, option.text("status"))
                    }
                    .disabled(!referenceStatusIsCurrent || !enabled || model.busy || model.retryNeeded)
                    .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                    .accessibilityIdentifier("reference-status-" + option.text("status"))
                }
                if onBackdateOptions != nil && onBackdateSave != nil {
                    Button(model.label("task.completedAtPromptTitle")) { openReferenceBackdatePicker() }
                        .disabled(!referenceStatusIsCurrent || !enabled || model.busy || model.retryNeeded)
                        .accessibilityIdentifier("reference-status-completion-time")
                }
                if onDestinationOptions != nil && onDestinationChoose != nil {
                    Button(model.label("task.moveToProjectOrArea")) { openReferenceDestinationPicker() }
                        .disabled(!referenceStatusIsCurrent || !enabled || model.busy || model.retryNeeded)
                        .accessibilityIdentifier("reference-status-destination")
                }
                Button(model.label("common.cancel"), role: .cancel) { closeReferenceStatusMenu() }
                    .accessibilityIdentifier("reference-status-cancel")
            }
            .onChange(of: referenceStatusMenuPresented) { visible in
                if !visible && ownsReferenceStatusMenu && !referenceBackdateActive && !referenceDestinationActive { closeReferenceStatusMenu() }
            }
            .onChange(of: referenceStatusCurrentContext) { context in
                if ownsReferenceStatusMenu, !context.utf8.elementsEqual(referenceStatusOpeningContext.utf8) {
                    closeReferenceStatusMenu()
                }
            }
            .onChange(of: model.busy) { busy in
                if busy && ownsReferenceStatusMenu && !referenceBackdateActive && !referenceDestinationActive { closeReferenceStatusMenu() }
            }
            .onDisappear { closeReferenceStatusMenu() }
        } else { listContent }
    }

    private var referenceStatusCurrentContext: String {
        guard ownsReferenceStatusMenu else { return "" }
        return (referenceDestinationActive ? model.referenceTaskDestinationContext(referenceStatusRow)
            : referenceBackdateActive ? model.referenceTaskBackdateContext(referenceStatusRow)
            : model.referenceTaskStatusContext(referenceStatusRow)) ?? ""
    }

    private var referenceStatusIsCurrent: Bool {
        ownsReferenceStatusMenu && !referenceStatusOpeningContext.isEmpty
            && referenceStatusCurrentContext.utf8.elementsEqual(referenceStatusOpeningContext.utf8)
    }

    private func canOfferReferenceStatus(_ row: CoreObject) -> Bool {
        prefix == "reference" && onStatusOptions != nil && onStatusChange != nil && !selectionActive
            && !row.flag("readOnly") && row.text("status") == "reference"
            && !row.text("id").isEmpty && !row.text("taskRevision").isEmpty
    }

    private func openReferenceStatusMenu(_ displayed: CoreObject) {
        guard canOfferReferenceStatus(displayed), enabled, !model.busy, !model.retryNeeded,
              !model.taskStatusMenuPresented, let onStatusOptions,
              let context = model.referenceTaskStatusContext(displayed) else { return }
        referenceStatusGeneration += 1
        let generation = referenceStatusGeneration
        referenceStatusRow = displayed
        referenceStatusOptions = [:]
        referenceStatusOpeningContext = context
        ownsReferenceStatusMenu = true
        model.taskStatusMenuPresented = true
        referenceStatusOptionsTask = Task {
            defer {
                if referenceStatusGeneration == generation { referenceStatusOptionsTask = nil }
            }
            let options = await onStatusOptions(displayed)
            guard !Task.isCancelled, referenceStatusGeneration == generation else { return }
            guard referenceStatusIsCurrent, !model.busy else { closeReferenceStatusMenu(); return }
            guard let options else { closeReferenceStatusMenu(); return }
            referenceStatusOptions = options
            referenceStatusMenuPresented = true
        }
    }

    private func openReferenceBackdatePicker() {
        guard referenceStatusIsCurrent, enabled, !model.busy, !model.retryNeeded, let onBackdateOptions else { return }
        // Keep the same owned gate and captured row through the system-dialog handoff.
        referenceBackdateActive = true
        referenceStatusMenuPresented = false
        referenceStatusGeneration += 1
        let generation = referenceStatusGeneration
        let displayed = referenceStatusRow
        referenceStatusOptionsTask = Task {
            defer { if referenceStatusGeneration == generation { referenceStatusOptionsTask = nil } }
            let options = await onBackdateOptions(displayed)
            guard !Task.isCancelled, referenceStatusGeneration == generation else { return }
            guard referenceStatusIsCurrent, !model.busy, let options else { closeReferenceStatusMenu(); return }
            referenceBackdateInitialDate = Date()
            referenceBackdateOptions = options
        }
    }

    private func openReferenceDestinationPicker() {
        guard referenceStatusIsCurrent, enabled, !model.busy, !model.retryNeeded, onDestinationOptions != nil else { return }
        referenceDestinationActive = true
        referenceStatusMenuPresented = false
        referenceStatusGeneration += 1
        referenceStatusOptionsTask?.cancel()
        referenceStatusOptionsTask = nil
    }

    private func closeReferenceStatusMenu() {
        let destination = ownsReferenceStatusMenu && model.selectedSurface != .reference
            ? model.selectedSurface : nil
        referenceStatusGeneration += 1
        referenceStatusOptionsTask?.cancel()
        referenceStatusOptionsTask = nil
        referenceStatusMenuPresented = false
        referenceBackdateActive = false
        referenceDestinationActive = false
        referenceBackdateOptions = [:]
        referenceStatusOptions = [:]
        referenceStatusRow = [:]
        referenceStatusOpeningContext = ""
        if ownsReferenceStatusMenu { model.taskStatusMenuPresented = false }
        model.presentQueuedReferenceProjectNextAction()
        ownsReferenceStatusMenu = false
        if let destination {
            // Navigation may have reached refresh before this owner's menu gate
            // was released. Load that destination once after cancelling the read.
            Task {
                guard model.selectedSurface == destination else { return }
                await model.refresh()
            }
        }
    }

    @ViewBuilder private var contentRows: some View {
        if let error = error {
            Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier(errorIdentifier ?? prefix + "-error")
            Button(model.label("common.retry")) { onRetry() }
                .rnFont(14, .semibold).frame(minHeight: 44)
                .disabled(model.busy || (model.retryNeeded && !(prefix == "reference" ? model.referenceActionPending : model.historyDoneActionPending)))
                .accessibilityIdentifier(prefix + "-retry")
        }
        if displaysSnapshot {
            let items = data.objects("items")
            ForEach(items.map(ListRowEntry.init)) { entry in
                let item = entry.item
                if item.text("type") == "task" {
                    let row = item.object("row")
                    let selected = prefix == "reference"
                        ? selectedTaskIDs.contains(where: { $0.utf8.elementsEqual(row.text("id").utf8) })
                        : selectedTaskIDs.contains(row.text("id"))
                    HStack(spacing: 8) {
                        if selectionActive, !row.flag("readOnly") {
                            Button { onSelection?(row) } label: {
                                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22)).foregroundStyle(palette.tint)
                                    .frame(width: 45, height: 45).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu)
                            .accessibilityLabel(row.text("title"))
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier(prefix + "-select-" + (item.text("groupId").isEmpty ? "none" : item.text("groupId")) + "-" + row.text("id"))
                        }
                        TaskCard(row: row, model: model, palette: palette, readOnly: disableStatus || selectionActive || row.flag("readOnly"),
                                 hideStatusBadge: selectionActive,
                                 onProject: selectionActive ? nil : { project in Task { await model.openProject(project) } },
                                 onStatusOptions: selectionActive ? nil : onStatusOptions, onStatusChange: selectionActive ? nil : onStatusChange,
                                 onCompletedAt: selectionActive ? nil : onCompletedAt,
                                 onSelection: selectionActive ? onSelection : nil,
                                 onSelectionStart: enabled && !row.flag("readOnly") ? onSelectionStart : nil)
                    }
                        .id(entry.id)
                        .disabled(prefix == "reference" && !current)
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            let swipe = row.object("meta").object("swipe")
                            if let onNextTask, enabled, !ownsReferenceStatusMenu, !selectionActive, !row.flag("readOnly"),
                               swipe.text("target") == "next", !swipe.text("label").isEmpty,
                               !row.text("id").isEmpty, !row.text("taskRevision").isEmpty {
                                Button {
                                    onNextTask(row.text("id"), row.text("taskRevision"))
                                } label: {
                                    Label { Text(swipe.text("label")) } icon: { AppIcon(name: swipe.text("icon"), size: 18) }
                                }
                                .tint(palette.tint)
                                .accessibilityIdentifier(prefix + "-next-" + row.text("id"))
                            }
                            if canOfferReferenceStatus(row), enabled, !ownsReferenceStatusMenu {
                                Button { openReferenceStatusMenu(row) } label: {
                                    Label(model.label("taskStatus.changeStatus"), systemImage: "ellipsis")
                                }
                                .tint(palette.secondary)
                                .accessibilityIdentifier("reference-change-status-" + row.text("id"))
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if let onDeleteTask, enabled, !ownsReferenceStatusMenu, !selectionActive, !row.flag("readOnly"),
                               !row.text("id").isEmpty, !row.text("taskRevision").isEmpty {
                                Button {
                                    onDeleteTask(row.text("id"), row.text("taskRevision"))
                                } label: {
                                    Label(model.label("common.delete"), systemImage: "trash")
                                }
                                .tint(palette.danger)
                                .accessibilityIdentifier(prefix + "-delete-" + row.text("id"))
                            }
                        }
                        .accessibilityActions {
                            if canOfferReferenceStatus(row) {
                                Button(model.label("taskStatus.changeStatus")) { openReferenceStatusMenu(row) }
                                    .disabled(!enabled || model.busy || model.retryNeeded)
                            }
                        }
                } else if item.text("type") == "section" { section(item) }
            }
            if items.count < data.number("total") {
                Button { onMore() } label: {
                    Text(model.label("common.more")).rnFont(12, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(palette.filter, in: Capsule()).contentShape(Capsule())
                }
                .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu).accessibilityIdentifier(prefix + "-more")
            }
            if items.isEmpty { emptyState }
        }
        if model.busy || (!current && error == nil) {
            ProgressView().frame(maxWidth: .infinity).padding(12)
        }
    }

    @ViewBuilder private var activeFilters: some View {
        if data.flag("hasActiveFilters") {
            HStack {
                Button { onFilters() } label: {
                    HStack(spacing: 6) {
                        AppIcon(name: "sliders", size: 16)
                        Text(model.label("filters.label") + " · " + String(data.number("filterActiveCount"))).rnFont(12, .semibold)
                    }
                    .foregroundStyle(palette.tint).padding(.horizontal, 12).frame(minHeight: 44)
                    .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.tint, lineWidth: 1)).contentShape(Capsule())
                }
                .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu).accessibilityAddTraits(.isSelected)
                .accessibilityIdentifier(prefix + "-active-filters")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
        let chips = data.objects("chips")
        if !chips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(chips.indices, id: \.self) { index in
                        let chip = chips[index]
                        let tone = chip.flag("excluded") ? palette.danger : palette.tint
                        Button { onChipAction(chip.object("action")) } label: {
                            HStack(spacing: 6) {
                                Text(chip.text("label")).rnFont(12, .semibold).strikethrough(chip.flag("excluded"))
                                AppIcon(name: "x", size: 14)
                            }
                            .foregroundStyle(tone).padding(.horizontal, 12).frame(minHeight: 44)
                            .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(tone, lineWidth: 1)).contentShape(Capsule())
                        }
                        .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu)
                        .accessibilityLabel(model.label("filters.remove") + ": " + chip.text("label"))
                        .accessibilityValue(chip.flag("excluded") ? model.label("filters.excluded") : "")
                        .accessibilityIdentifier(prefix + "-chip-" + chip.text("id"))
                    }
                    Button { onClear() } label: {
                        Text(model.label("filters.clear")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                            .padding(.horizontal, 12).frame(minHeight: 44).background(palette.filter, in: Capsule())
                            .overlay(Capsule().stroke(palette.border, lineWidth: 1)).contentShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu).accessibilityIdentifier(prefix + "-clear-filters")
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            .fixedSize(horizontal: false, vertical: true).background(palette.card)
            .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
        }
    }

    @ViewBuilder private func section(_ item: CoreObject) -> some View {
        if item.flag("collapsible") {
            Button { onCollapse(item.text("id")) } label: { sectionLabel(item) }
                .buttonStyle(.plain).disabled(!enabled || ownsReferenceStatusMenu)
                .accessibilityValue(model.label(item.flag("collapsed") ? "markdown.expand" : "markdown.collapse"))
                .accessibilityIdentifier(prefix + "-section-" + item.text("id"))
        } else { sectionLabel(item).accessibilityAddTraits(.isHeader) }
    }

    private func sectionLabel(_ item: CoreObject) -> some View {
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

    private var emptyState: some View {
        let empty = data.object("empty")
        return VStack(spacing: 8) {
            Text(empty.text("message")).rnFont(18, .semibold)
            Text(empty.text("hint")).rnFont(14).foregroundStyle(palette.secondary)
            if empty.flag("clear") {
                Button(empty.text("actionLabel")) {
                    onClear()
                }
                .rnFont(14, .semibold).frame(minHeight: 44).disabled(!enabled || ownsReferenceStatusMenu)
                .accessibilityIdentifier(prefix + "-empty-clear")
            }
        }
        .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 48)
    }
}

private struct ReferenceTaskBackdateDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let options: CoreObject
    let close: () -> Void
    let save: (String, String?) async -> Bool
    @State private var date: Date
    @State private var initialInstant: String
    @State private var dateChanged = false
    @State private var minutesText: String
    @State private var confirming = false
    @FocusState private var minutesFocused: Bool
    private var frozen: Bool { confirming || model.busy || model.retryNeeded || model.referenceTaskBackdatePending }

    init(model: CoreModel, palette: AppPalette, options: CoreObject, initialDate: Date,
         close: @escaping () -> Void, save: @escaping (String, String?) async -> Bool) {
        self.model = model
        self.palette = palette
        self.options = options
        self.close = close
        self.save = save
        _date = State(initialValue: initialDate)
        _initialInstant = State(initialValue: TaskDatePickerComponents.instantString(initialDate))
        _minutesText = State(initialValue: (options["initialTimeSpentMinutes"] as? NSNumber).map { String($0.intValue) } ?? "")
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    ScrollViewReader { reader in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(options.text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                                DatePicker(options.text("title"), selection: Binding(get: { date }, set: { next in
                                    guard !frozen,
                                          TaskDatePickerComponents.string(next, time: false) != TaskDatePickerComponents.string(date, time: false)
                                            || TaskDatePickerComponents.string(next, time: true) != TaskDatePickerComponents.string(date, time: true) else { return }
                                    date = next
                                    dateChanged = true
                                }), displayedComponents: [.date, .hourAndMinute])
                                    .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                                    .accessibilityLabel(options.text("title"))
                                    .accessibilityIdentifier("reference-backdate-picker").disabled(frozen)
                                if options.flag("showTimeSpent") {
                                    Text(options.text("timeSpentLabel").uppercased()).rnFont(14)
                                        .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
                                    TextField(options.text("timeSpentPlaceholder"), text: Binding(get: { minutesText }, set: { text in
                                        guard !frozen else { return }
                                        minutesText = text
                                    }))
                                        .onChange(of: minutesText) { text in
                                            guard !frozen else { return }
                                            let digits = String(decoding: text.utf8.filter { (48...57).contains($0) }, as: UTF8.self)
                                            if text != digits { minutesText = digits }
                                        }
                                        .rnFont(16).keyboardType(.numberPad).submitLabel(.done)
                                        .focused($minutesFocused)
                                        .padding(12).frame(minHeight: 44)
                                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                                        .accessibilityLabel(options.text("timeSpentLabel"))
                                        .accessibilityIdentifier("reference-backdate-time-spent").disabled(frozen)
                                        .id("reference-backdate-minutes-field")
                                }
                                if let error = model.referenceError {
                                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                        .accessibilityIdentifier("reference-backdate-error")
                                }
                                if model.referenceTaskBackdatePending, model.retryNeeded {
                                    Button { Task { await model.retryReference() } } label: {
                                        Text(model.label("common.retry")).frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
                                    .accessibilityIdentifier("reference-retry")
                                }
                            }
                        }
                        .frame(maxHeight: max(120, min(dynamicTypeSize.isAccessibilitySize ? .infinity : 420, geometry.size.height - 132)))
                        .accessibilityElement(children: .contain).accessibilityIdentifier("reference-backdate-scroll")
                        .onChange(of: minutesFocused) { _ in scrollMinutesIntoView(reader) }
                        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                            scrollMinutesIntoView(reader)
                        }
                    }
                    HStack {
                        Spacer()
                        Button(action: cancel) {
                            Text(options.text("cancelLabel")).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary)
                        .disabled(frozen).accessibilityIdentifier("reference-backdate-cancel")
                        Button {
                            guard !frozen else { return }
                            minutesFocused = false
                            confirming = true
                            let instant = dateChanged ? TaskDatePickerComponents.instantString(date) : initialInstant
                            let minutes = options.flag("showTimeSpent") ? minutesText : nil
                            Task {
                                _ = await save(instant, minutes)
                                confirming = false
                            }
                        } label: {
                            Text(options.text("saveLabel")).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(frozen).accessibilityIdentifier("reference-backdate-save")
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
        minutesFocused = false
        close()
    }

    private func scrollMinutesIntoView(_ reader: ScrollViewProxy) {
        guard minutesFocused, !frozen else { return }
        // Match the editor: iOS 17 applies its keyboard inset after the
        // notification, so scrolling immediately uses the old viewport.
        DispatchQueue.main.async {
            guard minutesFocused, !frozen else { return }
            reader.scrollTo("reference-backdate-minutes-field", anchor: .bottom)
        }
    }
}

private struct ReferenceTaskDestinationDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let close: () -> Void
    let read: (String, Int) async -> CoreObject?
    let choose: (CoreObject) async -> Bool
    @State private var query = ""
    @State private var options: CoreObject = [:]
    @State private var choices: [CoreObject] = []
    @State private var loading = true
    @State private var readError: String?
    @State private var readTask: Task<Void, Never>?
    @State private var generation = 0
    @State private var retryOffset = 0
    @State private var retryAppend = false
    @State private var confirming = false
    @FocusState private var searchFocused: Bool
    private var frozen: Bool { confirming || model.busy || model.retryNeeded || model.referenceTaskDestinationPending }
    private var labels: CoreObject { options.object("labels") }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    Text(labels.text("title").isEmpty ? model.label("task.destination") : labels.text("title"))
                        .rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                    if !labels.isEmpty {
                        TextField(labels.text("search"), text: Binding(get: { query }, set: { text in
                            guard !frozen, !query.utf8.elementsEqual(text.utf8) else { return }
                            query = text
                            load(offset: 0, append: false)
                        }))
                        .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .focused($searchFocused).submitLabel(.search).disabled(frozen)
                        .accessibilityLabel(labels.text("search")).accessibilityIdentifier("reference-destination-search")
                    }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(choices.indices, id: \.self) { index in
                                let choice = choices[index], kind = choice.text("kind")
                                if kind != "none", index == 0 || choices[index - 1].text("kind") != kind {
                                    Text(labels.text(kind == "project" ? "projects" : "areas")).rnFont(13, .semibold)
                                        .foregroundStyle(palette.secondary).padding(.top, 8).accessibilityAddTraits(.isHeader)
                                }
                                Button {
                                    guard !frozen, !loading, readError == nil else { return }
                                    confirming = true
                                    searchFocused = false
                                    let destination: CoreObject = kind == "none" ? ["kind": "none"] : ["kind": kind, "id": choice.text("id")]
                                    Task { _ = await choose(destination); confirming = false }
                                } label: {
                                    HStack(spacing: 12) {
                                        Text(choice.text("label")).rnFont(16).frame(maxWidth: .infinity, alignment: .leading)
                                            .fixedSize(horizontal: false, vertical: true)
                                        if choice.flag("selected") { Image(systemName: "checkmark").foregroundStyle(palette.tint) }
                                    }
                                    .padding(10).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(frozen || loading || readError != nil)
                                .accessibilityLabel(choice.text("label"))
                                .accessibilityAddTraits(choice.flag("selected") ? .isSelected : [])
                                .accessibilityIdentifier("reference-destination-choice-" + String(index))
                            }
                            if !loading, readError == nil, choices.allSatisfy({ $0.text("kind") == "none" }) {
                                Text(labels.text("noMatches")).rnFont(14).foregroundStyle(palette.secondary)
                            }
                            if loading { ProgressView().frame(maxWidth: .infinity).padding(12) }
                            if let readError {
                                Text(readError).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("reference-destination-error")
                                Button { load(offset: retryOffset, append: retryAppend) } label: {
                                    Text(labels.text("retry").isEmpty ? model.label("common.retry") : labels.text("retry"))
                                        .frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen || loading)
                                .accessibilityIdentifier("reference-destination-read-retry")
                            } else if options.flag("hasMore") {
                                Button { load(offset: (options["nextOffset"] as? NSNumber)?.intValue ?? 0, append: true) } label: {
                                    Text(labels.text("more")).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen || loading)
                                .accessibilityIdentifier("reference-destination-more")
                            }
                            if model.referenceTaskDestinationPending, let error = model.referenceError {
                                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("reference-destination-error")
                                Button { Task { await model.retryReference() } } label: {
                                    Text(model.label("common.retry")).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
                                .accessibilityIdentifier("reference-retry")
                            }
                        }
                    }
                    .frame(maxHeight: max(120, geometry.size.height - 210))
                    .accessibilityIdentifier("reference-destination-scroll")
                    HStack {
                        Spacer()
                        Button(action: cancel) {
                            Text(labels.text("cancel").isEmpty ? model.label("common.cancel") : labels.text("cancel"))
                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(frozen)
                        .accessibilityIdentifier("reference-destination-cancel")
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
        .onAppear { load(offset: 0, append: false) }
        .onDisappear { generation += 1; readTask?.cancel(); readTask = nil }
    }

    private func load(offset: Int, append: Bool) {
        guard !frozen else { return }
        generation += 1
        let currentGeneration = generation, text = query
        readTask?.cancel()
        loading = true
        readError = nil
        retryOffset = offset
        retryAppend = append
        readTask = Task {
            let page = await read(text, offset)
            guard !Task.isCancelled, generation == currentGeneration, query.utf8.elementsEqual(text.utf8) else { return }
            loading = false
            readTask = nil
            guard let page else { readError = model.referenceError ?? model.label("common.retry"); return }
            choices = append ? choices + page.objects("choices") : page.objects("choices")
            options = page
        }
    }

    private func cancel() {
        guard !frozen else { return }
        searchFocused = false
        close()
    }
}

struct ReferencePanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var focusedField: String?
    private var isFilter: Bool { model.referencePanel == "filters" }
    private var isSort: Bool { model.referencePanel == "sort" }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: isFilter ? .bottom : .center) {
                Button { close() } label: { Color.black.opacity(isFilter ? 0.35 : 0.28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("reference-panel-dismiss").disabled(model.busy || model.retryNeeded)
                VStack(alignment: .leading, spacing: 0) {
                    if isFilter { filterControls }
                    else {
                        HStack(spacing: 8) {
                            if model.referencePanel == "group" || isSort {
                                Button { model.backReferencePanel() } label: {
                                    Text(model.label("common.back")).rnFont(13, .semibold).padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier("reference-panel-back").disabled(model.busy || model.retryNeeded)
                            }
                            Text(isSort ? model.label("sort.label") : model.referencePanel == "group" ? model.reference.object("group").text("title") : model.label("taskEdit.moreOptions"))
                                .rnFont(17, .bold).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                            Button { close() } label: { AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle()) }
                                .buttonStyle(.plain).accessibilityLabel(model.label("common.close")).accessibilityIdentifier("reference-menu-close").disabled(model.busy || model.retryNeeded)
                        }
                        .frame(minHeight: 44).padding(.bottom, 12)
                        ViewThatFits(in: .vertical) {
                            overflowContent.fixedSize(horizontal: false, vertical: true)
                            ScrollView { overflowContent }.accessibilityIdentifier("reference-panel-scroll")
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
                guard !model.busy, !model.retryNeeded else { return }
                focusedField = nil
                if !model.referencePickerName.isEmpty { model.closeReferencePicker() }
                else if model.referencePanel == "group" || isSort { model.backReferencePanel() }
                else { close() }
            }
        }
    }

    private var overflowContent: some View {
        VStack(spacing: 4) {
            if model.referencePanel == "menu" {
                overflowRow(title: model.label("filters.label"), selected: model.reference.flag("hasActiveFilters"),
                            icon: "sliders", id: "reference-filter-action") { model.referencePanel = "filters" }
                overflowRow(title: model.label("sort.label"), value: model.reference.object("sort").text("label"),
                            icon: "sort", id: "reference-sort-action") { Task { await model.openReferenceSort() } }
                overflowRow(title: model.label("list.groupBy"), value: model.reference.object("group").text("label"),
                            icon: "folder", id: "reference-group-action") { model.referencePanel = "group" }
            } else if isSort {
                TaskListSortChoices(model: model, palette: palette, caller: .reference)
            } else {
                let options = model.reference.object("group").objects("options")
                ForEach(options.indices, id: \.self) { index in
                    let option = options[index]
                    overflowRow(title: option.text("label"), selected: option.flag("selected"),
                                id: "reference-group-" + option.text("value")) {
                        close()
                        Task { await model.setReferenceOption("groupBy", value: option.text("value")) }
                    }
                }
            }
        }
    }

    private func overflowRow(title: String, value: String = "", selected: Bool = false, icon: String = "",
                             id: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
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
        .buttonStyle(.plain).disabled(!model.referenceActionsEnabled || !enabled).opacity(enabled ? 1 : 0.55)
        .accessibilityLabel(value.isEmpty ? title : title + ": " + value)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityIdentifier(id)
    }

    private var filterControls: some View {
        ListFilterControls(
            data: model.reference, strings: model.strings, palette: palette, prefix: "reference",
            enabled: model.referenceActionsEnabled, busy: model.busy, frozen: model.retryNeeded, error: model.referenceError,
            searchText: Binding(get: { model.referenceSearchText }, set: { model.setReferenceText($0) }),
            locationText: Binding(get: { model.referenceLocationText }, set: { model.setReferenceText($0, location: true) }),
            pickerName: model.referencePickerName, picker: model.referencePicker, pickerCurrent: model.referencePickerCurrent,
            pickerEnabled: model.referencePickerActionsEnabled, pickerError: model.referencePickerError,
            pickerQuery: Binding(get: { model.referencePickerQuery }, set: { model.setReferencePickerQuery($0) }),
            onEdit: { edit in Task { await model.editReferenceFilter(edit) } },
            onChipAction: { action in Task { await model.applyReferenceChipAction(action) } },
            onArchived: { value in Task { await model.setReferenceOption("includeArchivedProjects", value: value) } },
            onOpenPicker: model.openReferencePicker, onBack: model.closeReferencePicker,
            onMore: model.loadMoreReferencePicker, onRetry: { Task { await model.retryReference() } },
            onRetryPicker: model.retryReferencePicker, onClose: model.closeReferencePanel, focusedField: $focusedField)
    }

    private func close() { focusedField = nil; model.closeReferencePanel() }
}

struct TaskListSortChoices: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let caller: CoreModel.TaskListSortCaller
    private var prefix: String { caller == .inbox ? "inbox" : "reference" }

    var body: some View {
        VStack(spacing: 4) {
            if let error = model.referenceSortError {
                Text(error).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(prefix + "-sort-error")
                Button(model.label("common.retry")) {
                    Task {
                        if caller == .inbox { await model.retryInboxSort() }
                        else { await model.retryReferenceSort() }
                    }
                }
                .rnFont(15, .semibold).foregroundStyle(palette.tint).frame(minHeight: 44)
                .disabled(model.busy).accessibilityIdentifier(prefix + "-sort-retry")
            }
            let choices = model.referenceSortOptions.objects("choices")
            ForEach(choices.indices, id: \.self) { index in
                let option = choices[index]
                Button {
                    Task {
                        if caller == .inbox { await model.setInboxSort(option.text("value")) }
                        else { await model.setReferenceSort(option.text("value")) }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Text(option.text("label")).rnFont(15, .semibold).frame(maxWidth: .infinity, alignment: .leading)
                        if option.flag("selected") { Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(palette.tint) }
                    }
                    .padding(10).frame(minHeight: 52).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.taskListSortActionsEnabled)
                .accessibilityLabel(option.text("label"))
                .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                .accessibilityIdentifier(prefix + "-sort-" + option.text("value"))
            }
            if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
        }
    }
}
