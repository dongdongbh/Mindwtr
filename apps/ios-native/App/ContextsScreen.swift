import SwiftUI
import UIKit

private struct ContextsTaskRow: Identifiable {
    let row: CoreObject
    var id: Data { Data(row.text("id").utf8) }
}

struct ContextsScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var searchFocused: Bool
    @FocusState private var filterFocusedField: String?
    @State private var filterPickerName = ""
    @State private var filterPickerQuery = ""

    var body: some View {
        VStack(spacing: 0) {
            TextField(model.contexts.text("searchPlaceholder"), text: Binding(
                get: { model.contextsSearchText }, set: { model.setContextsSearch($0) }))
                .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($searchFocused).submitLabel(.done).onSubmit { endInput() }
                .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 40)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .disabled(model.retryNeeded).accessibilityIdentifier("contexts-search")
                .padding(12).background(palette.card)
                .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
            if !model.contexts.isEmpty { filters }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.contextsError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("contexts-error")
                        Button(model.label("common.retry")) { endInput(); model.retryContexts() }
                            .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("contexts-retry")
                    }


                    if !model.contexts.isEmpty {
                        let rows = model.contexts.objects("rows")
                        ForEach(rows.map(ContextsTaskRow.init)) { entry in
                            let row = entry.row
                            TaskCard(row: row, model: model, palette: palette,
                                     onProject: { project in Task { await model.openProject(project) } },
                                     onToken: { model.focusContextsToken($0) }, beforeAction: endInput)
                                .disabled(!model.contextsActionsEnabled)
                        }
                        if rows.count < model.contexts.number("total") {
                            Button { endInput(); model.loadMoreContexts() } label: {
                                Text(model.label("common.more")).rnFont(13, .semibold)
                                    .padding(.horizontal, 16).frame(minHeight: 44)
                                    .background(palette.filter, in: Capsule()).contentShape(Capsule())
                            }
                            .buttonStyle(.plain).disabled(!model.contextsActionsEnabled)
                            .accessibilityIdentifier("contexts-more")
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                        }
                        let empty = model.contexts.object("empty")
                        if model.contextsCurrent && !empty.isEmpty {
                            VStack(spacing: 8) {
                                emptyIcon(check: empty.text("icon") == "check")
                                    .foregroundStyle(palette.secondary).padding(.bottom, 8)
                                Text(empty.text("title")).rnFont(18, .semibold)
                                Text(empty.text("message")).rnFont(14).foregroundStyle(palette.secondary)
                            }
                            .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                            .padding(.vertical, 48).padding(.horizontal, 24)
                            .accessibilityElement(children: .combine).accessibilityIdentifier("contexts-empty")
                        }
                    }
                    if model.contextsLoading || model.busy {
                        ProgressView().frame(maxWidth: .infinity).padding(12)
                            .accessibilityLabel(model.label("common.loading"))
                    }
                }
                .padding(12)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { endInput(); await model.refresh() }
        }
        .sheet(isPresented: Binding(get: { model.contextsFilterSheetOpen }, set: { model.setContextsFilterSheet($0) })) {
            VStack(alignment: .leading, spacing: 8) {
                if model.contexts.flag("canSave") && filterPickerName.isEmpty {
                    Button(model.label("common.save")) { Task { await model.openContextsSavedFilter() } }
                        .rnFont(14, .semibold).foregroundStyle(palette.tint).frame(minHeight: 44)
                        .disabled(!model.contextsControlsEnabled).accessibilityIdentifier("contexts-save-filter")
                }
                contextFilterControls
            }
            .padding(16).background(palette.card).presentationDetents([.medium, .large])
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .contexts else { return }
                await model.refresh()
            }
        }
    }

    private var filters: some View {
        VStack(spacing: 0) {
            HStack {
                Button(model.label("filters.label")) {
                    endInput(); filterPickerName = ""; filterPickerQuery = ""; model.setContextsFilterSheet(true)
                }
                .rnFont(13, .semibold).foregroundStyle(palette.tint).frame(minHeight: 44)
                .disabled(!model.contextsControlsEnabled).accessibilityIdentifier("contexts-filters")
                Spacer()
            }.padding(.horizontal, 12)
            let saved = model.contexts.object("savedFilters").objects("items")
            if !saved.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(saved.indices, id: \.self) { index in
                            let filter = saved[index]
                            Button(filter.text("name")) {
                                endInput(); model.selectContextsSavedFilter(filter.flag("selected") ? nil : filter.text("id"))
                            }
                            .rnFont(13, .semibold).padding(.horizontal, 12).frame(minHeight: 44)
                            .background(filter.flag("selected") ? palette.tint : palette.filter, in: Capsule())
                            .foregroundStyle(filter.flag("selected") ? palette.onTint : palette.text)
                            .buttonStyle(.plain).disabled(!model.contextsControlsEnabled)
                            .accessibilityAddTraits(filter.flag("selected") ? .isSelected : [])
                        }
                    }.padding(.horizontal, 12)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    let chips = model.contexts.objects("chips")
                    ForEach(chips.indices, id: \.self) { index in chip(chips[index]) }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
            }
            .fixedSize(horizontal: false, vertical: true)
            let mode = model.contexts.object("matchMode")
            if !mode.isEmpty {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(mode.text("label")).rnFont(11, .semibold).foregroundStyle(palette.secondary)
                        matchOptions(mode)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 5)
                } else {
                    HStack(spacing: 8) {
                        Text(mode.text("label")).rnFont(11, .semibold).foregroundStyle(palette.secondary)
                        Spacer(minLength: 0)
                        matchOptions(mode)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 5)
                }
            }
        }
        .padding(.top, 4).padding(.bottom, 6).background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private var contextFilterControls: some View {
        var data = model.contexts
        data["chips"] = model.contexts["filterChips"]
        let state = model.contexts.object("filters").object("state")
        return ListFilterControls(
            data: data, strings: model.strings, palette: palette, prefix: "contexts",
            enabled: model.contextsControlsEnabled, busy: model.busy, frozen: model.retryNeeded, error: model.contextsError,
            searchText: Binding(get: { state.text("searchQuery") }, set: { model.editContextsFilter(["type": "setSearch", "value": $0]) }),
            locationText: Binding(get: { state.text("location") }, set: { model.editContextsFilter(["type": "setLocation", "value": $0]) }),
            pickerName: filterPickerName, picker: model.contextsFilterPicker, pickerCurrent: model.contextsControlsEnabled,
            pickerEnabled: model.contextsControlsEnabled, pickerError: model.contextsError,
            pickerQuery: Binding(get: { filterPickerQuery }, set: {
                filterPickerQuery = $0; model.setContextsFilterPicker(name: filterPickerName, query: $0)
            }),
            onEdit: model.editContextsFilter,
            onChipAction: { model.editContextsFilter($0.object("filterEdit")) }, onArchived: { _ in },
            onOpenPicker: { name in filterPickerName = name; filterPickerQuery = ""; model.setContextsFilterPicker(name: name) },
            onBack: { filterPickerName = ""; filterPickerQuery = ""; model.setContextsFilterPicker(name: nil) },
            onMore: { model.setContextsFilterPicker(name: filterPickerName, query: filterPickerQuery, more: true) },
            onRetry: model.retryContexts,
            onRetryPicker: { model.setContextsFilterPicker(name: filterPickerName, query: filterPickerQuery) },
            onClose: { model.setContextsFilterSheet(false) }, focusedField: $filterFocusedField)
    }


    @ViewBuilder private func chip(_ chip: CoreObject) -> some View {
        let selected = chip.flag("selected")
        let additive = chip.object("additive")
        let button = Button { endInput(); model.selectContextsChip(chip.text("id")) } label: {
            HStack(spacing: 6) {
                Text(chip.text("label")).rnFont(13, .medium).fixedSize()
                Text(String(chip.number("count"))).rnFont(10, .semibold)
                    .foregroundStyle(selected ? palette.text : palette.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1).frame(minWidth: 18)
                    .background(selected ? palette.card : (palette.dark ? Color.white : Color.black).opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 8))
            }
            .foregroundStyle(selected ? palette.onTint : palette.text)
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 44)
            .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain).disabled(!model.contextsControlsEnabled)
        .accessibilityLabel(chip.text("accessibilityLabel"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("contexts-chip-" + chip.text("id"))
        if additive.isEmpty {
            button
        } else {
            let add = { endInput(); model.selectContextsChip(chip.text("id"), additive: true) }
            button

                .highPriorityGesture(LongPressGesture().onEnded { _ in add() })
                .accessibilityAction(named: additive.text("label"), add)
        }
    }

    private func matchOptions(_ mode: CoreObject) -> some View {
        HStack(spacing: 0) {
            let options = mode.objects("options")
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                let selected = option.flag("selected")
                Button { endInput(); model.selectContextsMatchMode(option.text("mode")) } label: {
                    Text(option.text("label")).rnFont(12, .semibold)
                        .foregroundStyle(selected ? palette.onTint : palette.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 6).frame(minWidth: 52, minHeight: 44)
                        .background(selected ? palette.tint : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.contextsControlsEnabled)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("contexts-match-" + option.text("mode"))
            }
        }
        .padding(2).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private func endInput() {
        searchFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func emptyIcon(check: Bool) -> some View {

        Path { path in
            if check {
                path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20))
                path.move(to: CGPoint(x: 9, y: 12)); path.addLine(to: CGPoint(x: 11, y: 14)); path.addLine(to: CGPoint(x: 15, y: 10))
            } else {
                path.move(to: CGPoint(x: 20.6, y: 13.4)); path.addLine(to: CGPoint(x: 13.4, y: 20.6))
                path.addQuadCurve(to: CGPoint(x: 10.6, y: 20.6), control: CGPoint(x: 12, y: 22))
                path.addLine(to: CGPoint(x: 2, y: 12)); path.addLine(to: CGPoint(x: 2, y: 2))
                path.addLine(to: CGPoint(x: 12, y: 2)); path.addLine(to: CGPoint(x: 20.6, y: 10.6))
                path.addQuadCurve(to: CGPoint(x: 20.6, y: 13.4), control: CGPoint(x: 22, y: 12))
                path.closeSubpath(); path.addEllipse(in: CGRect(x: 6.5, y: 6.5, width: 1, height: 1))
            }
        }
        .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24).scaleEffect(2).frame(width: 48, height: 48).accessibilityHidden(true)
    }
}
