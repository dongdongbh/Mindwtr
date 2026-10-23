import SwiftUI
import UIKit

/// Focus has its own core DTO: no row search or archived-project toggle.
struct FocusControlsPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var expanded: Set<String> = []
    @FocusState private var focusedField: String?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var controls: CoreObject { model.focus.object("controls") }
    private var sheet: CoreObject { controls.object("filterSheet") }
    private var view: CoreObject { controls.object("view") }
    private var text: CoreObject { sheet.object("text") }
    private var picker: Bool { !model.focusPickerName.isEmpty }
    private var title: String {
        model.focusPanel == "view" ? view.text("title") : picker
            ? text.text(model.focusPickerName == "tokens" ? "contexts" : "projects") : sheet.text("title")
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { close() } label: { Color.black.opacity(0.35).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("focus-controls-dismiss")
                VStack(alignment: .leading, spacing: 12) {
                    header
                    groupFailure
                    if picker { pickerBody }
                    else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                if model.focusPanel == "view" { viewOptions }
                                else { overview }
                                failure
                            }
                            .padding(.bottom, 12)
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .accessibilityIdentifier("focus-controls-scroll")
                    }
                    HStack {
                        Spacer()
                        Button { close() } label: {
                            Text(model.focusPanel == "view" ? view.text("doneLabel") : sheet.text("doneLabel"))
                                .rnFont(15, .semibold).padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("focus-controls-close")
                    }
                }
                .padding(16).frame(maxWidth: 860, maxHeight: geometry.size.height * 0.82)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) {
                endInput()
                if picker { model.closeFocusPicker() } else { model.closeFocusPanel() }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if picker {
                    Button { endInput(); model.closeFocusPicker() } label: {
                        Text(text.text("back")).rnFont(13, .semibold).padding(.horizontal, 8).frame(minHeight: 44)
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier("focus-filter-picker-back")
                }
                Text(title).rnFont(16, .bold).frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                if !dynamicTypeSize.isAccessibilitySize { headerActions }
            }
            if dynamicTypeSize.isAccessibilitySize { HStack { Spacer(); headerActions } }
        }
        .frame(minHeight: 44)
    }

    @ViewBuilder private var headerActions: some View {
        if model.focusPanel == "filters" {
            if !sheet.object("save").isEmpty {
                Button { endInput(); Task { await model.openFocusSavedFilter(["type": "save"]) } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "bookmark").font(.system(size: 14))
                        Text(sheet.object("save").text("label")).rnFont(13, .semibold)
                    }.frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.focusControlsEnabled)
                .accessibilityIdentifier("focus-filter-save")
            }
            if sheet.object("clear").flag("visible") || model.focusLocationRefused {
                Button { apply(sheet.object("clear").object("edit")) } label: {
                    Text(sheet.object("clear").text("label")).rnFont(13, .semibold)
                        .padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.focusControlsEnabled)
                .accessibilityIdentifier("focus-filter-clear")
            }
        }
    }

    private var viewOptions: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel(view.object("sort").text("label"))
            options(view.object("sort").objects("options"), prefix: "focus-sort")
            sectionLabel(view.object("group").text("label"))
            AppChipFlow {
                let choices = view.object("group").objects("options")
                ForEach(choices.indices, id: \.self) { index in
                    let item = choices[index]
                    chip(item.text("label"), selected: item.flag("selected"), id: "focus-group-" + item.text("value")) {
                        endInput()
                        Task { await model.setFocusGroup(item.text("value")) }
                    }
                }
            }
            sectionLabel(view.object("details").text("sectionLabel"))
            chip(view.object("details").text(model.focusShowDetails ? "hideLabel" : "showLabel"),
                 selected: model.focusShowDetails, id: "focus-details") { model.toggleFocusShowDetails() }
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 12) {
            activeChips
            let taskDates = sheet.object("taskDates")
            if !taskDates.isEmpty {
                let dateOptions = taskDates.objects("options")
                overviewRow(taskDates.text("label"), summary: dateOptions.filter { $0.flag("selected") }.map { $0.text("label") }.joined(separator: ", "),
                            expanded: expanded.contains("taskDates"), id: "focus-filter-taskDates") { toggle("taskDates") }
                if expanded.contains("taskDates") { options(dateOptions, prefix: "focus-filter-taskDates") }
            }
            if sheet.object("tokens").number("total") > 0 {
                overviewRow(text.text("contexts"), summary: sheet.object("summaries").text("tokens"), id: "focus-filter-tokens") {
                    endInput(); model.openFocusPicker("tokens")
                }
            }
            if sheet.object("projects").number("total") > 0 {
                overviewRow(text.text("projects"), summary: sheet.object("summaries").text("projects"), id: "focus-filter-projects") {
                    endInput(); model.openFocusPicker("projects")
                }
            }
            if sheet.object("visibility").flag("timeEstimate") && !sheet.objects("timeEstimates").isEmpty {
                disclosure("timeEstimates", label: text.text("timeEstimate"))
            }
            if sheet.object("visibility").flag("energyLevel") { disclosure("energyLevels", label: text.text("energyLevel")) }
            if sheet.object("visibility").flag("priority") || sheet.object("visibility").flag("location") {
                overviewRow(text.text("more"), summary: sheet.object("summaries").text("more"), expanded: expanded.contains("more"), id: "focus-filter-more") {
                    toggle("more")
                }
                if expanded.contains("more") {
                    if sheet.object("visibility").flag("priority") {
                        sectionLabel(text.text("priority"))
                        options(sheet.objects("priorities"), prefix: "focus-filter-priority")
                    }
                    if sheet.object("visibility").flag("location") {
                        sectionLabel(text.text("location"))
                        input(text.text("locationPlaceholder"), label: text.text("location"), id: "focus-filter-location", value: Binding(
                            get: { model.focusLocationText }, set: { model.setFocusLocation($0) }))
                    }
                }
            }
        }
    }

    @ViewBuilder private var activeChips: some View {
        let chips = sheet.objects("chips")
        let advanced = sheet.objects("advancedChips")
        if !chips.isEmpty || !advanced.isEmpty {
            sectionLabel(text.text("active"))
            AppChipFlow {
                ForEach(chips.indices, id: \.self) { index in
                    let item = chips[index]
                    chip(item.text("label"), selected: true, excluded: item.flag("excluded"), removable: true,
                         id: "focus-filter-chip-" + item.text("id")) { apply(item.object("edit")) }
                        .accessibilityLabel(text.text("removeFilter") + ": " + item.text("label"))
                }
                ForEach(advanced.indices, id: \.self) { index in
                    let item = advanced[index]
                    chip(item.text("label"), selected: true, removable: true,
                         id: "focus-filter-advanced-" + item.text("id")) {
                        endInput()
                        Task { await model.openFocusSavedFilter(["type": "removeCriterion", "criterionId": item.text("criterionId")], message: item.text("label")) }
                    }
                    .accessibilityLabel(text.text("removeFilter") + ": " + item.text("label"))
                }
            }
        }
    }

    private var pickerBody: some View {
        VStack(spacing: 10) {
            input(text.text("search"), label: text.text("search") + " " + title, id: "focus-filter-picker-search", value: Binding(
                get: { model.focusPickerQuery }, set: { model.setFocusPickerQuery($0) }))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.focusPickerMatchesQuery {
                        let items = model.focusPicker.objects("items")
                        ForEach(items.indices, id: \.self) { index in pickerOption(items[index]) }
                        if model.focusPickerCurrent && items.isEmpty {
                            Text(text.text("noResults")).rnFont(14).foregroundStyle(palette.secondary).padding(.vertical, 28)
                                .accessibilityIdentifier("focus-filter-picker-empty")
                        }
                        if items.count < model.focusPicker.number("total") {
                            Button { endInput(); model.loadMoreFocusControls() } label: {
                                Text(model.label("common.more")).rnFont(14, .semibold).frame(minHeight: 44)
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!model.focusPickerActionsEnabled)
                            .accessibilityIdentifier("focus-filter-picker-more")
                        }
                    }
                    if model.focusPickerName == "tokens" {
                        ForEach(["context", "tag"], id: \.self) { kind in
                            let match = sheet.object("matchModes").object(kind)
                            if match.flag("visible") {
                                VStack(alignment: .leading, spacing: 8) {
                                    sectionLabel(match.text("label"))
                                    options(match.objects("options"), prefix: "focus-filter-match-" + kind)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                            }
                        }
                    }
                    failure
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("focus-filter-picker-list")
        }
    }

    private func pickerOption(_ item: CoreObject) -> some View {
        let token = model.focusPickerName == "tokens"
        let selected = token ? item.text("state") == "included" : item.flag("selected")
        let excluded = token && item.text("state") == "excluded"
        let label = item.text(token ? "value" : "title")
        // RN keeps the picker search keyboard open while selecting options.
        return Button { model.editFocusControl(item.object("edit")) } label: {
            HStack(spacing: 12) {
                Text(label).rnFont(14).strikethrough(excluded).frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if selected || excluded { Text(text.text(excluded ? "excluded" : "selected")).rnFont(12, .semibold) }
            }
            .foregroundStyle(excluded ? palette.danger : selected ? palette.tint : palette.text)
            .padding(.horizontal, 4).padding(.vertical, 8).frame(minHeight: 52).contentShape(Rectangle())
            .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
        }
        .buttonStyle(.plain).disabled(!model.focusPickerActionsEnabled)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityValue(excluded ? text.text("excluded") : "")
        .accessibilityIdentifier("focus-filter-" + (token ? "token-" + label : "project-" + item.text("id")))
    }

    @ViewBuilder private var groupFailure: some View {
        if let error = model.focusGroupError {
            VStack(alignment: .leading, spacing: 4) {
                Text(error).rnFont(13).foregroundStyle(palette.danger).lineLimit(3)
                    .accessibilityIdentifier("focus-group-error")
                Button { endInput(); Task { await model.retryFocusGroup() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
                .accessibilityIdentifier("focus-group-retry")
            }
        }
    }

    @ViewBuilder private var failure: some View {
        if let error = model.focusError {
            Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier("focus-filter-error")
            Button { endInput(); model.retryFocus() } label: {
                Text(model.label("common.retry")).rnFont(14, .semibold).frame(minHeight: 44)
            }
            .disabled(model.busy || model.retryNeeded).accessibilityIdentifier("focus-filter-retry")
        } else if model.focusLoading { ProgressView().frame(maxWidth: .infinity).padding(12) }
    }

    private func input(_ placeholder: String, label: String, id: String, value: Binding<String>) -> some View {
        TextField(placeholder, text: value).rnFont(15).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.done).focused($focusedField, equals: id).onSubmit { endInput() }
            .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 44)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .disabled(model.retryNeeded).accessibilityLabel(label).accessibilityIdentifier(id)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).rnFont(12, .semibold).tracking(0.4).textCase(.uppercase).foregroundStyle(palette.secondary)
    }

    private func overviewRow(_ title: String, summary: String, expanded: Bool? = nil, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).rnFont(14, .semibold)
                    Text(summary).rnFont(12).foregroundStyle(summary == text.text("all") ? palette.secondary : palette.tint)
                }
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                AppIcon(name: "chevron", size: 18).rotationEffect(.degrees(expanded == true ? 180 : expanded == false ? 0 : -90))
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 9).frame(minHeight: 60)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.focusControlsEnabled).accessibilityIdentifier(id)
        .accessibilityValue(expanded.map { model.label($0 ? "markdown.collapse" : "markdown.expand") } ?? "")
    }

    @ViewBuilder private func disclosure(_ key: String, label: String) -> some View {
        overviewRow(label, summary: sheet.object("summaries").text(key), expanded: expanded.contains(key), id: "focus-filter-" + key) { toggle(key) }
        if expanded.contains(key) { options(sheet.objects(key), prefix: "focus-filter-" + key) }
    }

    private func options(_ values: [CoreObject], prefix: String, enabled: Bool = true) -> some View {
        AppChipFlow {
            ForEach(values.indices, id: \.self) { index in
                let item = values[index]
                chip(item.text("label"), selected: item.flag("selected"), id: prefix + "-" + item.text("value"), enabled: enabled) {
                    apply(item.object("edit"))
                }
            }
        }
    }

    private func chip(_ title: String, selected: Bool, excluded: Bool = false, removable: Bool = false,
                      id: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        let tone = excluded ? palette.danger : palette.tint
        return Button(action: action) {
            HStack(spacing: 4) {
                Text(title).rnFont(12, .semibold).strikethrough(excluded).fixedSize(horizontal: false, vertical: true)
                if removable { AppIcon(name: "x", size: 12) }
            }
            .foregroundStyle(selected ? palette.onTint : palette.text).padding(.horizontal, 12).padding(.vertical, 6)
            .frame(minHeight: 44).background(selected ? tone : palette.filter, in: Capsule())
            .overlay(Capsule().stroke(selected ? tone : palette.border, lineWidth: 1)).contentShape(Capsule())
        }
        .buttonStyle(.plain).disabled(!enabled || !model.focusControlsEnabled).opacity(enabled ? 1 : 0.5)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityValue(excluded ? text.text("excluded") : "")
        .accessibilityIdentifier(id)
    }

    private func toggle(_ key: String) {
        endInput()
        if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) }
    }
    private func apply(_ edit: CoreObject) { endInput(); model.editFocusControl(edit) }
    private func close() { endInput(); model.closeFocusPanel() }
    private func endInput() {
        focusedField = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// RN's save-name overlay and destructive confirmations share exact-retry state.
struct FocusSavedFilterDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var nameFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var labels: CoreObject { model.focusSavedFilterDialog }
    private var saving: Bool { model.focusSavedFilterOperation.text("type") == "save" }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Button { close() } label: { Color.black.opacity(0.4).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().disabled(model.busy || model.retryNeeded)
                    .accessibilityLabel(labels.text("cancelLabel")).accessibilityIdentifier("focus-saved-dialog-dismiss")
                ViewThatFits(in: .vertical) {
                    content.fixedSize(horizontal: false, vertical: true)
                    ScrollView { content }.scrollDismissesKeyboard(.interactively)
                }
                .frame(maxWidth: 440, maxHeight: geometry.size.height - 24)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .accessibilityElement(children: .contain).accessibilityIdentifier("focus-saved-card")
                .padding(.horizontal, 24)
            }
        }
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("focus-saved-dialog")
        .accessibilityAction(.escape) { close() }
        .task(id: model.busy) {
            if saving && !model.busy && !model.retryNeeded && model.focusSavedFilterError == nil { nameFocused = true }
        }
    }

    private var content: some View {
    VStack(alignment: .leading, spacing: 16) {
        Text(labels.text("title")).rnFont(18, .semibold).foregroundStyle(palette.text)
            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
        if saving {
            TextField(labels.text("placeholder"), text: $model.focusSavedFilterName)
                .rnFont(15).foregroundStyle(palette.text).focused($nameFocused)
                .submitLabel(.done).onSubmit { submit() }
                .padding(12).frame(minHeight: 44).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .contentShape(Rectangle()).onTapGesture { nameFocused = true }
                .disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(labels.text("placeholder")).accessibilityIdentifier("focus-saved-name")
        } else {
            Text(labels.text("message")).rnFont(15).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let error = model.focusSavedFilterError {
            Text(error).rnFont(14).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("focus-saved-error")
            Button { endInput(); Task { await model.retryFocusSavedFilter() } } label: {
                Text(model.label("common.retry")).rnFont(14, .semibold).frame(minHeight: 44)
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy)
            .accessibilityIdentifier("focus-saved-retry")
        }
        if dynamicTypeSize.isAccessibilitySize { VStack(spacing: 8) { actions } }
        else { HStack(spacing: 12) { Spacer(); actions } }
    }.padding(20)
    }

    @ViewBuilder private var actions: some View {
        Button { close() } label: {
            Text(labels.text("cancelLabel")).rnFont(14, .semibold).frame(minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(model.busy || model.retryNeeded)
        .accessibilityIdentifier("focus-saved-cancel")
        Button { submit() } label: {
            Text(labels.text(saving ? "saveLabel" : "confirmLabel")).rnFont(14, .semibold)
                .padding(.horizontal, 20).frame(minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil)
                .foregroundStyle(palette.onTint).background(saving ? palette.tint : palette.danger, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.focusSavedFilterCanConfirm)
        .opacity(model.focusSavedFilterCanConfirm ? 1 : 0.5).accessibilityIdentifier("focus-saved-confirm")
    }

    private func submit() { endInput(); Task { await model.confirmFocusSavedFilter() } }
    private func close() { endInput(); model.closeFocusSavedFilter() }
    private func endInput() {
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}


struct PomodoroTimerPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private var panel: CoreObject { model.pomodoroPanel }
    private var text: CoreObject { panel.object("text") }

    var body: some View {
        if panel.flag("visible") || model.pomodoroError != nil {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    if panel.flag("collapsed") { clock }
                    else { Text(text.text("title").isEmpty ? model.label("pomodoro.mobileTitle") : text.text("title")).rnFont(16, .bold).accessibilityAddTraits(.isHeader) }
                    Spacer(minLength: 8)
                    Button { model.togglePomodoroCollapsed() } label: {
                        Image(systemName: panel.flag("collapsed") ? "chevron.down" : "chevron.up")
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(text.text("collapse"))
                    .accessibilityIdentifier("pomodoro-collapse")
                }
                if panel.text("kind") != "ready" {
                    if model.pomodoroError == nil { ProgressView(model.label("common.loading")) }
                } else {
                    Text(text.text("phase") + " · " + text.text("state")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                    if !panel.flag("collapsed") {
                        clock.frame(maxWidth: .infinity)
                        AppChipFlow {
                            ForEach(panel.objects("presets").indices, id: \.self) { index in
                                let preset = panel.objects("presets")[index]
                                Button(preset.text("label")) {
                                    Task { await model.performPomodoroAction("setDurations", values: ["durations": [
                                        "focusMinutes": preset.number("focusMinutes"), "breakMinutes": preset.number("breakMinutes")]]) }
                                }
                                .buttonStyle(.bordered).tint(preset.flag("active") ? palette.tint : palette.secondary)
                                .accessibilityAddTraits(preset.flag("active") ? .isSelected : [])
                                .accessibilityIdentifier("pomodoro-preset-" + preset.text("id"))
                                .disabled(!model.pomodoroInputsEnabled)
                            }
                        }
                        AppChipFlow {
                            Button(text.text("toggle")) { Task { await model.performPomodoroAction("toggle") } }
                                .buttonStyle(.borderedProminent).tint(palette.tint).foregroundStyle(palette.onTint)
                                .accessibilityIdentifier("pomodoro-toggle")
                            Button(text.text("reset")) { Task { await model.performPomodoroAction("reset") } }
                                .accessibilityIdentifier("pomodoro-reset")
                            Button(text.text("switchPhase")) { Task { await model.performPomodoroAction("switchPhase") } }
                                .accessibilityIdentifier("pomodoro-switch")
                        }
                        .buttonStyle(.bordered).disabled(!model.pomodoroInputsEnabled)
                        Text(text.text("sessionsDone") + ": " + String(panel.number("completedToday")))
                            .rnFont(13).foregroundStyle(palette.secondary).accessibilityIdentifier("pomodoro-count")
                        if !panel.text("event").isEmpty {
                            Text(panel.text("event")).rnFont(14).accessibilityIdentifier("pomodoro-event")
                        }
                        if panel.flag("linkTaskEnabled") {
                            let selected = panel.object("selectedTask")
                            Text(text.text("selectedTask")).rnFont(13, .semibold)
                            Text(selected.isEmpty ? text.text("timerOnly") : selected.text("title"))
                                .rnFont(14).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("pomodoro-task")
                            Button(text.text("changeTask")) { Task { await model.openPomodoroPicker() } }
                                .buttonStyle(.bordered).disabled(!model.pomodoroInputsEnabled).accessibilityIdentifier("pomodoro-link")
                            if !selected.isEmpty {
                                Button(text.text("markDone")) { Task { await model.completePomodoroTask() } }
                                    .buttonStyle(.bordered).disabled(!model.pomodoroInputsEnabled).accessibilityIdentifier("pomodoro-complete")
                            }
                        }
                    }
                }
                if let error = model.pomodoroError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("pomodoro-error")
                    Button(model.label("common.retry")) { Task { await model.retryPomodoro() } }
                        .disabled(model.busy).accessibilityIdentifier("pomodoro-retry")
                }
            }
            .padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))
            .padding(.bottom, 12).controlSize(.large)
            .sheet(isPresented: Binding(get: { model.pomodoroPickerPresented }, set: { if !$0 { model.closePomodoroPicker() } })) {
                NavigationStack {
                    List {
                        Button(text.text("timerOnly")) { Task { await model.choosePomodoroTask(nil) } }
                            .accessibilityIdentifier("pomodoro-task-none")
                        ForEach(model.pomodoroTasks.indices, id: \.self) { index in
                            let task = model.pomodoroTasks[index]
                            Button(task.text("title")) { Task { await model.choosePomodoroTask(task.text("id")) } }
                                .accessibilityIdentifier("pomodoro-choice-" + task.text("id"))
                        }
                        if model.pomodoroTasks.count < model.pomodoroTaskCount {
                            Button(text.text("more")) { Task { await model.loadMorePomodoroTasks() } }
                                .accessibilityIdentifier("pomodoro-more")
                        }
                        if let error = model.pomodoroError {
                            Text(error).foregroundStyle(palette.danger)
                            Button(model.label("common.retry")) { Task { await model.openPomodoroPicker() } }
                        }
                    }
                    .disabled(!model.pomodoroInputsEnabled)
                    .navigationTitle(text.text("selectedTask"))
                    .toolbar { ToolbarItem(placement: .cancellationAction) {
                        Button(model.label("common.close")) { model.closePomodoroPicker() }
                    } }
                }
            }
        }
    }

    @ViewBuilder private var clock: some View {
        if panel.flag("isRunning"), let end = panel["phaseEndsAtMs"] as? NSNumber,
           let start = panel.object("observation")["nowMs"] as? NSNumber, end.doubleValue > start.doubleValue {
            Text(timerInterval: Date(timeIntervalSince1970: start.doubleValue / 1000)...Date(timeIntervalSince1970: end.doubleValue / 1000), countsDown: true)
                .monospacedDigit().rnFont(panel.flag("collapsed") ? 22 : 40, .bold).accessibilityIdentifier("pomodoro-clock")
        } else {
            Text(panel.text("clock")).monospacedDigit().rnFont(panel.flag("collapsed") ? 22 : 40, .bold)
                .accessibilityIdentifier("pomodoro-clock")
        }
    }
}
