import SwiftUI

private struct SavedSearchTaskRow: Identifiable {
    let row: CoreObject
    var id: Data { Data(row.text("id").utf8) }
}

struct SavedSearchScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
            Spacer()
            if model.savedSearch.flag("found") {
                Button { Task { await model.openSavedSearchSort() } } label: {
                    Label(model.label("sort.label"), systemImage: "arrow.up.arrow.down")
                        .rnFont(14, .semibold).frame(minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(palette.text)
                .disabled(!model.savedSearchActionsEnabled).accessibilityIdentifier("saved-search-sort")
            }
            if !model.savedSearch.object("delete").isEmpty {
                Button { Task { await model.openSavedSearchDelete() } } label: {
                    Text(model.savedSearch.object("delete").text("label")).rnFont(14, .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                    .buttonStyle(.plain).foregroundStyle(palette.danger)
                    .disabled(!model.savedSearchActionsEnabled).accessibilityIdentifier("saved-search-delete")
            }
            }.padding(.horizontal, 16)
            if !model.savedSearch.text("query").isEmpty {
                Text(model.savedSearch.text("query"))
                    .rnFont(12).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(palette.card)
                    .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
                    .accessibilityIdentifier("saved-search-query")
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.savedSearchError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("saved-search-error")
                        Button(model.label("common.retry")) { Task { await model.retrySavedSearch() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("saved-search-retry")
                    }

                    let rows = model.savedSearch.objects("rows")
                    ForEach(rows.map(SavedSearchTaskRow.init)) { entry in
                        let row = entry.row
                        TaskCard(row: row, model: model, palette: palette,
                                 onProject: { project in Task { await model.openProject(project) } },
                                 onToken: { model.focusSavedSearchToken($0) })
                            .disabled(!model.savedSearchCurrent || !model.savedSearchActionsEnabled)
                    }
                    if rows.count < model.savedSearch.number("total") {
                        Button { Task { await model.loadMoreSavedSearch() } } label: {
                            Text(model.label("common.more")).rnFont(13, .semibold)
                                .padding(.horizontal, 16).frame(minHeight: 44)
                                .background(palette.filter, in: Capsule()).contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(!model.savedSearchCurrent || !model.savedSearchActionsEnabled)
                        .accessibilityIdentifier("saved-search-more")
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                    }
                    let empty = model.savedSearch.object("empty")
                    if model.savedSearchCurrent && rows.isEmpty && !empty.isEmpty {
                        VStack(spacing: 16) {
                            Text(empty.text("message")).rnFont(16).foregroundStyle(palette.secondary)
                                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                            let actions = empty.object("actions")
                            if !actions.isEmpty {
                                if dynamicTypeSize.isAccessibilitySize {
                                    VStack(spacing: 12) { emptyActions(actions) }
                                } else {
                                    HStack(spacing: 12) { emptyActions(actions) }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 48).padding(.horizontal, 24)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("saved-search-empty")
                    }
                    if model.busy || (!model.savedSearchCurrent && model.savedSearchError == nil) {
                        ProgressView().frame(maxWidth: .infinity).padding(12)
                            .accessibilityLabel(model.label("common.loading"))
                    }
                }
                .padding(16)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("saved-search-scroll")
            .refreshable { await model.pullToRefresh() }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .savedSearch else { return }
                await model.refresh()
            }
        }
    }

    @ViewBuilder private func emptyActions(_ actions: CoreObject) -> some View {
        emptyButton(actions.text("inboxLabel"), id: "saved-search-inbox") {
            await model.savedSearchGoInbox()
        }
        emptyButton(actions.text("backLabel"), id: "saved-search-back-empty") {
            await model.closeSavedSearch()
        }
    }

    private func emptyButton(_ label: String, id: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Text(label).rnFont(14, .semibold).foregroundStyle(palette.text)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(!model.savedSearchCurrent || !model.savedSearchActionsEnabled)
        .accessibilityIdentifier(id)
    }
}

struct SavedSearchWriteDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var nameFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var labels: CoreObject { model.savedSearchWriteDialog }
    private var saving: Bool { model.savedSearchWriteOperation.text("type") == "save" }
    private var sorting: Bool { model.savedSearchWriteOperation.text("type") == "sort" }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Button { close() } label: { Color.black.opacity(0.4).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().disabled(model.busy || model.retryNeeded)
                    .accessibilityLabel(labels.text("cancelLabel")).accessibilityIdentifier("saved-search-write-dialog-dismiss")
                ViewThatFits(in: .vertical) {
                    content.fixedSize(horizontal: false, vertical: true)
                    ScrollView { content }.scrollDismissesKeyboard(.interactively)
                }
                .frame(maxWidth: 440, maxHeight: geometry.size.height - 24)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .accessibilityElement(children: .contain).accessibilityIdentifier("saved-search-write-card")
                .padding(.horizontal, 24)
            }
        }
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("saved-search-write-dialog")
        .accessibilityAction(.escape) { close() }
        .task(id: model.busy) {
            if saving && !model.busy && !model.retryNeeded && model.savedSearchWriteError == nil { nameFocused = true }
        }
    }

    private var content: some View {
    VStack(alignment: .leading, spacing: 16) {
        Text(labels.text("title")).rnFont(18, .semibold).foregroundStyle(palette.text)
            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
        if saving {
            TextField(labels.text("placeholder"), text: $model.savedSearchWriteName)
                .rnFont(15).foregroundStyle(palette.text).focused($nameFocused)
                .submitLabel(.done).onSubmit { submit() }
                .padding(12).frame(minHeight: 44).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .contentShape(Rectangle()).onTapGesture { nameFocused = true }
                .disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(labels.text("placeholder")).accessibilityIdentifier("saved-search-write-name")
        } else if sorting {
            let choices = model.savedSearchWriteOptions.objects("choices")
            ForEach(choices.indices, id: \.self) { index in
                let choice = choices[index]
                Button { Task { await model.chooseSavedSearchSort(choice) } } label: {
                    HStack {
                        Text(choice.text("label")).rnFont(15, .semibold)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if choice.flag("selected") { Image(systemName: "checkmark").foregroundStyle(palette.tint) }
                    }
                    .padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.savedSearchWriteCanConfirm)
                .accessibilityAddTraits(choice.flag("selected") ? .isSelected : [])
                .accessibilityIdentifier("saved-search-sort-" + (choice["value"] is NSNull ? "global" : choice.text("value")))
            }
            if model.busy { ProgressView().frame(maxWidth: .infinity) }
        } else {
            Text(labels.text("message")).rnFont(15).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let error = model.savedSearchWriteError {
            Text(error).rnFont(14).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("saved-search-write-error")
            Button { endInput(); Task { await model.retrySavedSearchWrite() } } label: {
                Text(model.label("common.retry")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
            .accessibilityIdentifier("saved-search-write-retry")
        }
        if dynamicTypeSize.isAccessibilitySize { VStack(spacing: 8) { actions } }
        else { HStack(spacing: 12) { Spacer(); actions } }
    }.padding(20)
    }

    @ViewBuilder private var actions: some View {
        Button { close() } label: {
            Text(labels.text("cancelLabel")).rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded)
        .accessibilityIdentifier("saved-search-write-cancel")
        if !sorting {
        Button { submit() } label: {
            Text(labels.text(saving ? "saveLabel" : "confirmLabel")).rnFont(14, .semibold)
                .padding(.horizontal, 20).frame(minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil)
                .foregroundStyle(palette.onTint).background(saving ? palette.tint : palette.danger, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.savedSearchWriteCanConfirm)
        .opacity(model.savedSearchWriteCanConfirm ? 1 : 0.5).accessibilityIdentifier("saved-search-write-confirm")
        }
    }

    private func submit() { endInput(); Task { await model.confirmSavedSearchWrite() } }
    private func close() { endInput(); model.closeSavedSearchWrite() }
    private func endInput() {
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
