import SwiftUI

struct SearchScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var inputFocused: Bool
    @FocusState private var locationFocused: Bool
    @State private var filtersPresented = false

    private var options: CoreObject { model.searchView.object("filterOptions") }
    private var presentation: CoreObject { options.object("presentation") }
    private var filtersEnabled: Bool { !model.searchFilters.isEmpty && !model.busy && !model.retryNeeded && !model.taskPresented }
    private var hasSearch: Bool { !model.searchView.text("query").isEmpty || model.searchView.flag("hasActiveFilters") }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                header
                if !model.searchView.text("query").isEmpty {
                    Text(model.label("search.helpOperators")).rnFont(12).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 8)
                }
                if !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        inputFocused = false
                        Task { await model.openSavedSearchSave() }
                    } label: {
                        Text(model.label("search.saveSearch")).rnFont(14, .semibold)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint)
                    .disabled(!model.searchActionsEnabled).accessibilityIdentifier("search-save-open")
                }
                activeChips
                if model.searchLoading && !model.retryNeeded {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(model.label("search.searching")).rnFont(12).foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 8)
                    .accessibilityElement(children: .combine)
                }
                if let error = model.searchError {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        Button(model.label("common.retry")) { model.retrySearch() }
                            .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("search-retry")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                }
                results
            }
            .accessibilityHidden(filtersPresented)
            if filtersPresented {
                GeometryReader { geometry in
                    ZStack(alignment: .bottom) {
                        Button { closeFilters() } label: { Color.black.opacity(0.45).contentShape(Rectangle()) }
                            .buttonStyle(.plain).ignoresSafeArea().disabled(model.busy || model.retryNeeded)
                            .accessibilityLabel(model.label("common.close"))
                        filterSheet
                            .frame(maxHeight: geometry.size.height * 0.82)
                            .padding(12)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
        .onAppear { inputFocused = true }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return }
                guard scenePhase == .active, model.selectedSurface == .search else { return }
                await model.refresh()
            }
        }
    }

    private var header: some View {
        VStack(spacing: dynamicTypeSize.isAccessibilitySize ? 4 : 0) {
            HStack(spacing: 8) {
                AppIcon(name: "search", size: 20).foregroundStyle(palette.secondary).padding(.trailing, 4)
                TextField(model.label("search.placeholder"), text: Binding(get: { model.searchQuery }, set: model.setSearchQuery))
                    .rnFont(16).frame(minHeight: 44).focused($inputFocused).submitLabel(.search)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(model.retryNeeded || model.taskPresented)
                    .onSubmit { inputFocused = false }
                    .accessibilityLabel(model.label("search.title")).accessibilityIdentifier("search-input")
                if !model.searchQuery.isEmpty {
                    Button { model.setSearchQuery(""); inputFocused = true } label: {
                        AppIcon(name: "x", size: 20).foregroundStyle(palette.secondary)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.retryNeeded)
                    .accessibilityLabel(model.label("common.clear")).accessibilityIdentifier("search-clear")
                }
                if !dynamicTypeSize.isAccessibilitySize { filterButton; closeButton }
            }
            if dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 8) { Spacer(minLength: 0); filterButton; closeButton }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private var filterButton: some View {
        Button {
            inputFocused = false
            filtersPresented = true
        } label: {
            AppIcon(name: "sliders", size: 18)
                .foregroundStyle(filtersPresented || model.searchView.flag("hasActiveFilters") ? palette.tint : palette.secondary)
                .frame(width: 32, height: 32)
                .background(filtersPresented || model.searchView.flag("hasActiveFilters") ? palette.filter : .clear,
                            in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(
                    filtersPresented || model.searchView.flag("hasActiveFilters") ? palette.tint : palette.border, lineWidth: 1))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!filtersEnabled)
        .accessibilityLabel(model.label("filters.label")).accessibilityIdentifier("search-filters-open")
    }

    private var closeButton: some View {
        Button {
            inputFocused = false
            Task { await model.closeSearch() }
        } label: {
            Text(model.label("common.cancel")).rnFont(14, .semibold)
                .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.tint)
        .disabled(model.busy || model.retryNeeded).accessibilityIdentifier("search-close")
    }

    @ViewBuilder private var activeChips: some View {
        let chips = model.searchView.objects("activeChips")
        if !chips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(chips.indices, id: \.self) { index in
                        let chip = chips[index]
                        chipButton(chip.text("label"), selected: true, identifier: "search-chip-" + chip.text("key"),
                                   enabled: model.searchActionsEnabled) { model.removeSearchChip(chip.text("key")) }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var results: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if model.searchCurrent {
                    let projects = model.searchView.objects("projects")
                    let tasks = model.searchView.objects("tasks")
                    if hasSearch && model.searchView.flag("isTruncated") {
                        Text(model.label("search.showingFirst")
                            .replacingOccurrences(of: "{shown}", with: String(projects.count + tasks.count))
                            .replacingOccurrences(of: "{total}", with: model.searchView.text("totalResultsLabel")))
                            .rnFont(12).foregroundStyle(palette.secondary).accessibilityIdentifier("search-truncated")
                    }
                    if hasSearch && model.searchView.number("hiddenCompletedCount") > 0 {
                        Button { setFilter("includeCompleted", true) } label: {
                            Text(model.label("search.hiddenCompletedMatches")
                                .replacingOccurrences(of: "{{count}}", with: String(model.searchView.number("hiddenCompletedCount"))))
                                .rnFont(13, .semibold).foregroundStyle(palette.tint)
                                .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 12)
                                .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        }
                        .buttonStyle(.plain).disabled(!model.searchActionsEnabled).accessibilityIdentifier("search-hidden-completed")
                    }
                    // Core follows RN's flat order: projects, then tasks.
                    // Sibling lazy rows need distinct identities across both result types.
                    ForEach(projects.map { (id: "project-" + $0.text("id"), row: $0) }, id: \.id) { projectResult($0.row) }
                    ForEach(tasks.map { (id: "task-" + $0.text("id"), row: $0) }, id: \.id) { taskResult($0.row) }
                    if hasSearch && projects.isEmpty && tasks.isEmpty {
                        Text(model.label("search.noResults") + (model.searchView.text("query").isEmpty
                             ? "" : " \"" + model.searchView.text("query") + "\""))
                            .rnFont(16).foregroundStyle(palette.secondary).multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity).padding(32).accessibilityIdentifier("search-empty")
                    }
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func projectResult(_ row: CoreObject) -> some View {
        Button {
            inputFocused = false
            Task { await model.openProject(row) }
        } label: {
            HStack(spacing: 12) {
                AppIcon(name: "folder", size: 24).foregroundStyle(palette.tint).frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    highlightedTitle(row).rnFont(16, .medium).accessibilityLabel(row.text("title"))
                    Text(model.label("search.resultProject")).rnFont(12).foregroundStyle(palette.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.searchActionsEnabled)
        .accessibilityIdentifier("search-project-" + row.text("id"))
    }

    private func taskResult(_ row: CoreObject) -> some View {
        let opensEditor = row.flag("inStore") && row.object("tap").text("kind") == "editor"
        let canComplete = row.flag("canComplete") && !row.flag("readOnly")
        return HStack(spacing: 12) {
            if canComplete {
                Button {
                    inputFocused = false
                    Task { await model.completeSearchTask(row.text("id")) }
                } label: {
                    taskGlyph(cancelled: row.flag("cancelled")).foregroundStyle(palette.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.searchActionsEnabled)
                .accessibilityLabel(model.label("review.markDone"))
                .accessibilityIdentifier("search-complete-" + row.text("id"))
            } else {
                taskGlyph(cancelled: row.flag("cancelled"))
                    .foregroundStyle(row.flag("cancelled") || !row.flag("inStore") ? palette.secondary : palette.tint)
                    .frame(width: 44, height: 44).accessibilityHidden(true)
            }
            if opensEditor {
                Button {
                    inputFocused = false
                    Task { await model.openSearchTask(row.text("id")) }
                } label: {
                    HStack(spacing: 12) {
                        taskText(row)
                        AppIcon(name: "chevron", size: 20).rotationEffect(.degrees(-90)).foregroundStyle(palette.secondary)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.searchActionsEnabled)
                .accessibilityLabel(row.object("meta").text("accessibilityLabel").isEmpty
                    ? row.text("title") : row.object("meta").text("accessibilityLabel"))
                .accessibilityIdentifier("search-task-" + row.text("id"))
            } else { taskText(row) }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private func taskText(_ row: CoreObject) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            highlightedTitle(row).rnFont(16, .medium)
            Text(model.label("search.resultTask") + (row.text("projectTitle").isEmpty
                 ? "" : " • " + model.label("search.inProjectSuffix")))
                .rnFont(12).foregroundStyle(palette.secondary)
            let date = row.object("date")
            if !date.isEmpty {
                Text(date.text("label")).rnFont(12)
                    .foregroundStyle(date.text("tone") == "danger" ? palette.danger : date.text("tone") == "warning" ? palette.warning : palette.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading)
    }

    private func highlightedTitle(_ row: CoreObject) -> Text {
        let segments = row.objects("titleSegments")
        if segments.isEmpty { return Text(row.text("title")) }
        return segments.reduce(Text("")) { result, segment in
            result + Text(segment.text("text"))
                .foregroundColor(segment.flag("highlighted") ? palette.tint : palette.text)
                .fontWeight(segment.flag("highlighted") ? .semibold : .medium)
        }
    }

    private func taskGlyph(cancelled: Bool) -> some View {
        // Lucide CircleCheck/CircleX paths from RN; license: App/Lucide-LICENSE.
        Path { path in
            path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20))
            if cancelled {
                path.move(to: CGPoint(x: 15, y: 9)); path.addLine(to: CGPoint(x: 9, y: 15))
                path.move(to: CGPoint(x: 9, y: 9)); path.addLine(to: CGPoint(x: 15, y: 15))
            } else {
                path.move(to: CGPoint(x: 9, y: 12)); path.addLine(to: CGPoint(x: 11, y: 14)); path.addLine(to: CGPoint(x: 15, y: 10))
            }
        }
        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)).frame(width: 24, height: 24)
    }

    private var filterSheet: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Text(model.label("filters.label")).rnFont(14, .semibold).accessibilityAddTraits(.isHeader)
                Spacer()
                if model.searchView.flag("hasActiveFilters") {
                    Button(presentation.text("clear")) { model.setSearchFilters(model.searchView.object("defaultFilters")) }
                        .rnFont(12, .semibold).frame(minHeight: 44).foregroundStyle(palette.tint)
                        .disabled(!filtersEnabled).accessibilityIdentifier("search-filters-clear")
                }
                Button { closeFilters() } label: {
                    AppIcon(name: "x", size: 18).foregroundStyle(palette.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("common.close")).accessibilityIdentifier("search-filters-close")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    filterOptions("due", field: "duePreset", label: presentation.object("sections").text("due"))
                    sectionLabel(options.object("location").text("label"))
                    TextField(options.object("location").text("placeholder"), text: Binding(
                        get: { model.searchFilters.text("locationQuery") }, set: { setFilter("locationQuery", $0) }))
                        .rnFont(13).padding(.horizontal, 10).frame(minHeight: 44)
                        .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
                        .focused($locationFocused).onSubmit { locationFocused = false }.disabled(!filtersEnabled)
                        .accessibilityLabel(options.object("location").text("label")).accessibilityIdentifier("search-location")
                    sectionLabel(presentation.object("sections").text("tokens"))
                    AppChipFlow {
                        ForEach(options["tokens"] as? [String] ?? [], id: \.self) { token in
                            chipButton(token, selected: selectedValues("selectedTokens").contains(token),
                                       identifier: "search-token-" + token, enabled: filtersEnabled) { toggleFilter("selectedTokens", token) }
                        }
                    }
                    sectionLabel(options.object("include").text("label"))
                    AppChipFlow {
                        includeChip("includeCompleted", label: options.object("include").text("completed"), identifier: "search-include-completed")
                        includeChip("includeReference", label: options.object("include").text("reference"), identifier: "search-include-reference")
                        includeChip("hideFutureTasks", label: options.object("include").text("hideFutureTasks"), identifier: "search-hide-future")
                    }
                    filterOptions("statuses", field: "selectedStatuses", label: presentation.object("sections").text("status"), multiple: true)
                    filterOptions("scope", field: "scope", label: presentation.object("sections").text("scope"))
                    filterOptions("areas", field: "selectedArea", label: presentation.object("sections").text("area"))
                }
                .padding(.bottom, 12)
            }
            if model.error != nil { FailureBanner(model: model, palette: palette) }
        }
        .padding(12).background(palette.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { closeFilters() }
    }

    private func filterOptions(_ key: String, field: String, label: String, multiple: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel(label)
            AppChipFlow {
                ForEach(options.objects(key).indices, id: \.self) { index in
                    let option = options.objects(key)[index]
                    let value = option.text("value")
                    chipButton(option.text("label"), selected: multiple ? selectedValues(field).contains(value) : model.searchFilters.text(field) == value,
                               identifier: "search-filter-" + field + "-" + value, enabled: filtersEnabled) {
                        if multiple { toggleFilter(field, value) } else { setFilter(field, value) }
                    }
                }
            }
        }
    }

    private func includeChip(_ field: String, label: String, identifier: String) -> some View {
        chipButton(label, selected: model.searchFilters.flag(field), identifier: identifier, enabled: filtersEnabled) {
            setFilter(field, !model.searchFilters.flag(field))
        }
    }

    private func chipButton(_ label: String, selected: Bool, identifier: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).rnFont(12, .semibold).foregroundStyle(selected ? palette.onTint : palette.text)
                .padding(.horizontal, 10).padding(.vertical, 6).frame(minHeight: 44)
                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    private func sectionLabel(_ label: String) -> some View {
        Text(label.uppercased()).rnFont(12, .semibold).tracking(0.4).foregroundStyle(palette.secondary)
            .accessibilityAddTraits(.isHeader)
    }

    private func setFilter(_ field: String, _ value: Any) {
        var filters = model.searchFilters
        guard !filters.isEmpty else { return }
        filters[field] = value
        model.setSearchFilters(filters)
    }

    private func selectedValues(_ field: String) -> [String] { model.searchFilters[field] as? [String] ?? [] }

    private func toggleFilter(_ field: String, _ value: String) {
        var values = selectedValues(field)
        if let index = values.firstIndex(of: value) { values.remove(at: index) }
        else { values.append(value) }
        setFilter(field, values)
    }

    private func closeFilters() {
        guard !model.busy, !model.retryNeeded else { return }
        locationFocused = false
        filtersPresented = false
    }
}

/// RN's wrapping chip row, with intrinsic widths and accessible multiline labels.
struct AppChipFlow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = arrangement(width: proposal.width ?? 320, subviews: subviews)
        return CGSize(width: proposal.width ?? 320, height: sizes.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrangement(width: bounds.width, subviews: subviews)
        for (index, frame) in frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
                                 proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
    }

    private func arrangement(width: CGFloat, subviews: Subviews) -> [CGRect] {
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        return subviews.map { view in
            let ideal = view.sizeThatFits(.unspecified)
            let size = view.sizeThatFits(ProposedViewSize(width: min(ideal.width, width), height: nil))
            if x > 0 && x + size.width > width { x = 0; y += rowHeight + 8; rowHeight = 0 }
            let frame = CGRect(x: x, y: y, width: size.width, height: size.height)
            x += size.width + 8
            rowHeight = max(rowHeight, size.height)
            return frame
        }
    }
}
