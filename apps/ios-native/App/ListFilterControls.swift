import SwiftUI

/// The RN TaskFilterSheet contents shared by the two core list DTOs.
/// Query, paging and edit ownership remain with the calling screen's model.
struct ListFilterControls: View {
    let data: CoreObject
    let strings: CoreObject
    let palette: AppPalette
    let prefix: String
    let enabled: Bool
    let busy: Bool
    let frozen: Bool
    let error: String?
    @Binding var searchText: String
    @Binding var locationText: String
    let pickerName: String
    let picker: CoreObject
    let pickerCurrent: Bool
    let pickerEnabled: Bool
    let pickerError: String?
    @Binding var pickerQuery: String
    let onEdit: (CoreObject) -> Void
    let onChipAction: (CoreObject) -> Void
    let onArchived: (Bool) -> Void
    let onOpenPicker: (String) -> Void
    let onBack: () -> Void
    let onMore: () -> Void
    let onRetry: () -> Void
    let onRetryPicker: () -> Void
    let onClose: () -> Void
    @State private var expanded: Set<String> = []
    @FocusState.Binding var focusedField: String?
    private var filters: CoreObject { data.object("filters") }
    private var isPicker: Bool { !pickerName.isEmpty }
    private var panelTitle: String {
        localized(isPicker ? (pickerName == "tokens" ? "filters.contexts" : "filters.projects") : "filters.label")
    }
    private func localized(_ key: String) -> String { strings.text(key) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    panelBack
                    Text(panelTitle).rnFont(16, .bold).fixedSize()
                        .frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                    panelClear
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(panelTitle).rnFont(16, .bold).fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    HStack { panelBack; Spacer(); panelClear }
                }
            }
            .frame(minHeight: 44).padding(.bottom, 12)
            if isPicker { pickerBody }
            else {
                ScrollView { filterOverview.padding(.vertical, 8).padding(.bottom, 12) }
                    .scrollDismissesKeyboard(.interactively)
                    .accessibilityIdentifier(prefix + "-filter-overview-scroll")
            }
            HStack {
                Spacer()
                Button { close() } label: {
                    Text(localized("common.done")).rnFont(14, .bold).padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier(prefix + "-filters-close")
            }
            .padding(.top, 8)
        }
        .accessibilityAction(.escape) {
            focusedField = nil
            if isPicker { onBack() } else { onClose() }
        }
    }

    @ViewBuilder private var panelBack: some View {
        if isPicker {
            Button { focusedField = nil; onBack() } label: {
                Text(localized("common.back")).rnFont(13, .semibold).padding(.horizontal, 8)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).accessibilityIdentifier(prefix + "-panel-back")
        }
    }

    @ViewBuilder private var panelClear: some View {
        if filters.flag("hasActive") || data.flag("hasActiveFilters") {
            Button { apply(filters.object("clearEdit")) } label: {
                Text(localized("filters.clear")).rnFont(13, .semibold).padding(.horizontal, 10)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!enabled)
            .accessibilityIdentifier(prefix + "-filters-clear")
        }
    }

    private var filterOverview: some View {
        VStack(alignment: .leading, spacing: 14) {
            activeChips
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel(localized("common.search"))
                filterInput(localized("search.placeholder"), label: localized("common.search"), id: prefix + "-filter-search",
                            value: $searchText)
            }
            let archived = data.object("archivedProjectsToggle")
            if !archived.isEmpty {
                Toggle(archived.text("label"), isOn: Binding(get: { archived.flag("value") }, set: onArchived))
                    .rnFont(14).frame(minHeight: 44).disabled(!enabled)
                    .accessibilityIdentifier(prefix + "-include-archived-projects")
            }
            VStack(alignment: .leading, spacing: 8) {
                let taskDates = filters.object("taskDates")
                if !taskDates.isEmpty {
                    let dateOptions = taskDates.objects("options")
                    overviewRow(taskDates.text("label"), summary: summary(dateOptions.filter { $0.flag("selected") }.map { $0.text("label") }),
                                expanded: expanded.contains("taskDates"), id: prefix + "-filter-taskDates") { toggle("taskDates") }
                    if expanded.contains("taskDates") { optionChips(dateOptions, id: prefix + "-filter-taskDates") }
                }
                if filters.object("tokens").number("total") > 0 {
                    overviewRow(localized("filters.contexts"), summary: tokenSummary, id: prefix + "-filter-tokens") {
                        focusedField = nil
                        onOpenPicker("tokens")
                    }
                }
                if filters.object("projects").number("total") > 0 {
                    overviewRow(localized("filters.projects"), summary: projectSummary, id: prefix + "-filter-projects") {
                        focusedField = nil
                        onOpenPicker("projects")
                    }
                }
                if filters.object("visibility").flag("timeEstimate") && !filters.objects("timeEstimates").isEmpty {
                    disclosure("timeEstimates", title: localized("filters.timeEstimate"))
                }
                if filters.object("visibility").flag("energyLevel") { disclosure("energyLevels", title: localized("taskEdit.energyLevel")) }
                if filters.object("visibility").flag("priority") || filters.object("visibility").flag("location") {
                    overviewRow(localized("filters.more"), summary: moreSummary, expanded: expanded.contains("more"), id: prefix + "-filter-more") {
                        toggle("more")
                    }
                    if expanded.contains("more") {
                        VStack(alignment: .leading, spacing: 12) {
                            if filters.object("visibility").flag("priority") {
                                sectionLabel(localized("filters.priority"))
                                optionChips(filters.objects("priorities"), id: prefix + "-filter-priority")
                            }
                            if filters.object("visibility").flag("location") {
                                sectionLabel(localized("taskEdit.locationLabel"))
                                filterInput(localized("taskEdit.locationPlaceholder"), label: localized("taskEdit.locationLabel"),
                                            id: prefix + "-filter-location", value: $locationText)
                            }
                        }
                        .padding(.horizontal, 4).padding(.top, 2)
                    }
                }
            }
            if let error = error { filterFailure(error, picker: false) }
            if busy { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    @ViewBuilder private var activeChips: some View {
        let chips = data.objects("chips")
        if !chips.isEmpty {
            sectionLabel(localized("filters.active"))
            AppChipFlow {
                ForEach(chips.indices, id: \.self) { index in
                    let chip = chips[index]
                    filterChip(chip.text("label"), selected: true, excluded: chip.flag("excluded"), removable: true,
                               id: prefix + "-filter-chip-" + chip.text("id")) { applyChip(chip.object("action")) }
                        .accessibilityLabel(localized("filters.remove") + ": " + chip.text("label"))
                }
            }
        }
    }

    private var pickerBody: some View {
        VStack(spacing: 10) {
            filterInput(localized("common.search"), label: localized("common.search") + " " + panelTitle,
                        id: prefix + "-filter-picker-search", value: $pickerQuery)
            ScrollView {
                LazyVStack(spacing: 0) {
                    // Keep the accepted projection in layout while refreshing to preserve the scroll position.
                    Group {
                        let items = picker.objects("items")
                        ForEach(items.indices, id: \.self) { index in pickerOption(items[index]) }
                        if pickerCurrent && items.isEmpty {
                            Text(localized("search.noResults")).rnFont(14).foregroundStyle(palette.secondary).padding(.vertical, 28)
                        }
                        if items.count < picker.number("total") {
                            Button { onMore() } label: {
                                Text(localized("common.more")).rnFont(14, .semibold).frame(minHeight: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(!pickerEnabled)
                            .accessibilityIdentifier(prefix + "-filter-picker-more")
                        }
                        if pickerName == "tokens" {
                            // Give the bounded match controls one lazy child so their index IDs cannot collide with token rows.
                            VStack(alignment: .leading, spacing: 0) {
                                let controls = filters.objects("matchModes")
                                ForEach(controls.indices, id: \.self) { index in
                                    VStack(alignment: .leading, spacing: 8) {
                                        sectionLabel(controls[index].text("label"))
                                        optionChips(controls[index].objects("options"), id: prefix + "-filter-match-" + controls[index].text("kind"))
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                                }
                            }
                        }
                    }
                    .disabled(!pickerEnabled)
                }
                .padding(.vertical, 8)
            }
            .overlay {
                if !pickerCurrent && error == nil && pickerError == nil {
                    ProgressView().allowsHitTesting(false)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier(prefix + "-filter-picker-scroll")
            if let error = error { filterFailure(error, picker: false) }
            else if let error = pickerError { filterFailure(error, picker: true) }
        }
    }

    private func pickerOption(_ item: CoreObject) -> some View {
        let token = pickerName == "tokens"
        let selected = token ? item.text("state") == "included" : item.flag("selected")
        let excluded = token && item.text("state") == "excluded"
        let label = item.text(token ? "value" : "title")
        return Button { apply(item.object("edit")) } label: {
            HStack(spacing: 12) {
                Text(label).rnFont(14).strikethrough(excluded).frame(maxWidth: .infinity, alignment: .leading)
                if selected { Image(systemName: "checkmark").font(.system(size: 16)) }
                if excluded { Text(localized("filters.excluded")).rnFont(12, .semibold) }
            }
            .foregroundStyle(excluded ? palette.danger : selected ? palette.tint : palette.text)
            .padding(.horizontal, 4).padding(.vertical, 8).frame(minHeight: 52).contentShape(Rectangle())
            .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
        }
        .buttonStyle(.plain).disabled(!pickerEnabled)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityValue(excluded ? localized("filters.excluded") : "")
        .accessibilityIdentifier(prefix + "-filter-" + (token ? "token-" + label : "project-" + item.text("id")))
    }

    private func filterInput(_ placeholder: String, label: String, id: String, value: Binding<String>) -> some View {
        TextField(placeholder, text: value).rnFont(15).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.search).focused($focusedField, equals: id).onSubmit { focusedField = nil }
            .padding(.horizontal, 12).frame(minHeight: 44).background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .disabled(frozen).accessibilityLabel(label).accessibilityIdentifier(id)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).rnFont(12, .semibold).tracking(0.4).textCase(.uppercase).foregroundStyle(palette.secondary)
    }

    private func overviewRow(_ label: String, summary: String, expanded: Bool? = nil, id: String,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).rnFont(14, .semibold)
                    Text(summary).rnFont(12).foregroundStyle(palette.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                AppIcon(name: "chevron", size: 18).rotationEffect(.degrees(expanded == true ? 180 : expanded == false ? 0 : -90))
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 9).frame(minHeight: 60)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id)
        .accessibilityValue(expanded.map { localized($0 ? "markdown.collapse" : "markdown.expand") } ?? "")
    }

    @ViewBuilder private func disclosure(_ key: String, title: String) -> some View {
        overviewRow(title, summary: summary(filters.objects(key).filter { $0.flag("selected") }.map { $0.text("label") }),
                    expanded: expanded.contains(key), id: prefix + "-filter-" + key) { toggle(key) }
        if expanded.contains(key) { optionChips(filters.objects(key), id: prefix + "-filter-" + key).padding(.horizontal, 4).padding(.top, 2) }
    }

    private func optionChips(_ options: [CoreObject], id: String) -> some View {
        AppChipFlow {
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                filterChip(option.text("label"), selected: option.flag("selected"), id: id + "-" + option.text("value")) {
                    apply(option.object("edit"))
                }
            }
        }
    }

    private func filterChip(_ label: String, selected: Bool, excluded: Bool = false, removable: Bool = false,
                            id: String, action: @escaping () -> Void) -> some View {
        let tone = excluded ? palette.danger : palette.tint
        return Button(action: action) {
            HStack(spacing: 4) {
                Text(label).rnFont(12, .semibold).strikethrough(excluded)
                if removable { AppIcon(name: "x", size: 12) }
            }
            .foregroundStyle(selected ? palette.onTint : palette.text).padding(.horizontal, 12).padding(.vertical, 6)
            .frame(minHeight: 44).background(selected ? tone : palette.filter, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(selected ? tone : palette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 22))
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id)
        .accessibilityAddTraits(selected ? .isSelected : []).accessibilityValue(excluded ? localized("filters.excluded") : "")
    }

    private func filterFailure(_ error: String, picker: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
            Button {
                if picker { onRetryPicker() } else { onRetry() }
            } label: {
                Text(localized("common.retry")).rnFont(14, .semibold)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(busy || frozen)
            .accessibilityIdentifier(picker ? prefix + "-filter-picker-retry" : prefix + "-filter-retry")
        }
    }

    private var tokenSummary: String {
        let state = filters.object("state")
        return summary((state["tokens"] as? [String] ?? []) + (state["excludedTokens"] as? [String] ?? []).map {
            $0 + " (" + localized("filters.excluded") + ")"
        })
    }
    private var projectSummary: String {
        // Chips include selected projects beyond the first picker window.
        summary(data.objects("chips").filter {
            $0.object("action").object("filterEdit").text("type") == "toggleProject"
        }.map { $0.text("label") })
    }
    private var moreSummary: String {
        var labels = filters.objects("priorities").filter { $0.flag("selected") }.map { $0.text("label") }
        let location = filters.object("state").text("location")
        if !location.isEmpty { labels.append(localized("taskEdit.locationLabel") + ": " + location) }
        return summary(labels)
    }
    private func summary(_ values: [String]) -> String { values.isEmpty ? localized("common.all") : values.joined(separator: ", ") }
    private func toggle(_ key: String) { if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) } }
    private func apply(_ edit: CoreObject) { focusedField = nil; onEdit(edit) }
    private func applyChip(_ action: CoreObject) { focusedField = nil; onChipAction(action) }
    private func close() { focusedField = nil; onClose() }
}
