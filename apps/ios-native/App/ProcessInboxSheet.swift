import SwiftUI

struct ProcessInboxSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var focusedField: String?
    @State private var notesOpen = false
    @State private var pickingField: String?
    @State private var pickedDate = Date()

    private var view: CoreObject { model.processInboxView }
    private var capture: CoreObject { view.object("capture") }
    private var enabled: Bool { model.processInboxControlsEnabled }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !model.processInboxUndoLabel.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.processInboxToast).rnFont(13).foregroundStyle(palette.success)
                    actionButton(model.processInboxUndoLabel, id: "process-inbox-undo",
                                 requiresControls: false, active: model.processInboxUndoEnabled) {
                        Task { await model.undoProcessInboxDecision() }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.vertical, 8)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if view.isEmpty { completed }
                    else {
                        captureCard
                        if !view.text("question").isEmpty {
                            Text(view.text("question")).rnFont(20, .bold)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                        }
                        if !view.text("hint").isEmpty {
                            Text(view.text("hint")).rnFont(14).foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        choices
                        if !view.object("dateRow").isEmpty { dateRow(view.object("dateRow")) }
                        if !view.object("delegate").isEmpty { delegateSection }
                        if view.flag("projectFirst") { projectSection; contextsSection }
                        else { contextsSection; projectSection }
                        if !view.object("somedaySections").isEmpty { somedaySection }
                        if !view.object("moreOptions").isEmpty { moreOptions }
                        footer
                    }
                    messages
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(20)
            }
            .id(view.text("taskId"))
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("process-inbox-scroll")
        }
        .background(palette.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { Task { await model.closeProcessInbox() } }
        .onChange(of: view.text("taskId")) { _ in notesOpen = false }
        .sheet(isPresented: Binding(get: { pickingField != nil }, set: { if !$0 { pickingField = nil } })) {
            datePickerSheet
        }
    }

    private var header: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Button { Task { await model.closeProcessInbox() } } label: {
                Image(systemName: "xmark").font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.processInboxCloseEnabled)
            .accessibilityLabel(model.label("common.close"))
            .accessibilityIdentifier("process-inbox-close")
            VStack(alignment: .leading, spacing: 5) {
                Text(view.object("progress").text("label")).rnFont(13, .semibold)
                    .accessibilityIdentifier("process-inbox-progress")
                let progress = view.object("progress")
                ProgressView(value: Double(progress.number("processed")), total: Double(max(progress.number("total"), 1)))
                    .tint(palette.tint)
                    .accessibilityLabel(progress.text("label"))
                    .accessibilityIdentifier("process-inbox-sheet")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !view.isEmpty {
                Button { Task { await model.changeProcessInboxMode() } } label: {
                    Text(view.text("modeToggleLabel")).rnFont(13, .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityIdentifier("process-inbox-mode")
                Button { Task { await model.skipProcessInbox() } } label: {
                    Text(view.text("skip")).rnFont(14, .semibold).foregroundStyle(palette.tint)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityIdentifier("process-inbox-skip")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
    }

    private var captureCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !capture.text("returningLabel").isEmpty {
                Text(capture.text("returningLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("process-inbox-returning")
            }
            textInput("title", label: capture.text("titleLabel"), multiline: true)
                .accessibilityIdentifier("process-inbox-title")
            if !capture.objects("similarTasks").isEmpty {
                Text(capture.text("similarTasksLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                ForEach(capture.objects("similarTasks").indices, id: \.self) { index in
                    let task = capture.objects("similarTasks")[index]
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.text("title")).rnFont(13)
                        Text(task.text("meta")).rnFont(11).foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("process-inbox-similar-\(index)")
                }
            }
            if !notesOpen && !capture.text("notePreview").isEmpty {
                Text(capture.text("notePreview")).rnFont(13).foregroundStyle(palette.secondary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Button { notesOpen.toggle() } label: {
                HStack(spacing: 6) {
                    Text(capture.text("descriptionLabel")).rnFont(14, .semibold)
                    Image(systemName: notesOpen ? "chevron.up" : "chevron.down").font(.system(size: 12))
                }
                .foregroundStyle(palette.tint).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(notesOpen ? model.label("markdown.collapse") : model.label("markdown.expand"))
            .accessibilityIdentifier("process-inbox-notes-toggle")
            if notesOpen {
                textInput("description", label: capture.text("descriptionLabel"), multiline: true)
                    .accessibilityIdentifier("process-inbox-notes")
            }
            if !capture.text("refineHint").isEmpty {
                Text(capture.text("refineHint")).rnFont(12).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))
    }

    private var choices: some View {
        VStack(spacing: 0) {
            let values = view.objects("choices")
            let ordinary = values.filter { !$0.flag("danger") }
            let destructive = values.filter { $0.flag("danger") }
            VStack(spacing: 10) {
                ForEach(ordinary.indices, id: \.self) { index in
                    let choice = ordinary[index]
                    Button { Task { await model.decideProcessInbox(choice.text("id")) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: choiceSymbol(choice.text("icon"))).frame(width: 22)
                                .accessibilityHidden(true)
                            Text(choice.text("label")).rnFont(15, .semibold)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(palette.text)
                        .padding(.horizontal, 16).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!enabled)
                    .accessibilityIdentifier("process-inbox-choice-" + choice.text("id"))
                }
            }
            ForEach(destructive.indices, id: \.self) { index in
                let choice = destructive[index]
                Button { Task { await model.decideProcessInbox(choice.text("id")) } } label: {
                    HStack(spacing: 6) {
                        Spacer(minLength: 0)
                        Image(systemName: choiceSymbol(choice.text("icon"))).font(.system(size: 16))
                            .accessibilityHidden(true)
                        Text(choice.text("label")).rnFont(14, .semibold)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(palette.danger)
                    .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
                .padding(.top, 16)
                .accessibilityIdentifier("process-inbox-choice-" + choice.text("id"))
            }
        }
    }

    private func choiceSymbol(_ icon: String) -> String {
        switch icon {
        case "done": return "checkmark.circle"
        case "project": return "folder"
        case "later": return "clock"
        case "delegate": return "person"
        case "someday": return "cloud"
        case "incubate": return "leaf"
        case "reference": return "bookmark"
        case "trash": return "trash"
        default: return "chevron.right"
        }
    }

    @ViewBuilder private func dateRow(_ row: CoreObject) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(row.text("label")).rnFont(15, .semibold)
            Button { presentDatePicker(row) } label: {
                HStack {
                    Image(systemName: "calendar").accessibilityHidden(true)
                    Text(row.text("display")).rnFont(14)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).accessibilityHidden(true)
                }
                .padding(.horizontal, 12).frame(minHeight: 44)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!enabled)
            .accessibilityLabel(row.text("label") + ": " + row.text("display"))
            .accessibilityIdentifier("process-inbox-date-" + row.text("field"))
            AppChipFlow {
                let quick = row.objects("quickDates")
                ForEach(quick.indices, id: \.self) { index in
                    option(quick[index], id: "process-inbox-date-" + row.text("field") + "-preset-\(index)")
                }
                if !row.object("timeMode").isEmpty {
                    option(row.object("timeMode"), id: "process-inbox-date-" + row.text("field") + "-time-mode")
                }
                if !row.object("clear").isEmpty {
                    option(row.object("clear"), id: "process-inbox-date-" + row.text("field") + "-clear")
                }
            }
        }
        .sectionCard(palette)
    }

    @ViewBuilder private var projectSection: some View {
        let project = view.object("project")
        if !project.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(project.text("title")).rnFont(16, .bold).accessibilityAddTraits(.isHeader)
                if !project.text("areaLabel").isEmpty {
                    Text(project.text("areaLabel")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                    options(project.objects("areas"), prefix: "process-inbox-area")
                }
                let conversion = project.object("conversion")
                if !conversion.isEmpty {
                    Text(conversion.text("nextActionLabel")).rnFont(14, .semibold)
                    textInput("nextAction", label: conversion.text("nextActionLabel"))
                        .submitLabel(.next).onSubmit {
                            Task { await model.editProcessInbox([:], conversionAction: "nextSubmit") }
                        }
                        .accessibilityIdentifier("process-inbox-next-action")
                    let rows = conversion.objects("rows")
                    ForEach(rows.indices, id: \.self) { index in
                        let rowLayout = dynamicTypeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                            : AnyLayout(HStackLayout(spacing: 8))
                        rowLayout {
                            textInput("extra-\(index)", label: conversion.text("nextActionLabel"))
                                .submitLabel(.next).onSubmit {
                                    Task { await model.editProcessInbox([:], conversionAction: "rowSubmit", index: index) }
                                }
                                .accessibilityIdentifier("process-inbox-extra-\(index)")
                            Button { Task { await model.editProcessInbox(rows[index].object("remove"), conversionAction: "remove", index: index) } } label: {
                                Image(systemName: "xmark").frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain).disabled(!enabled)
                            .accessibilityLabel(conversion.text("removeActionLabel"))
                            .accessibilityIdentifier("process-inbox-remove-extra-\(index)")
                        }
                    }
                    actionButton(conversion.object("addAction").text("label"), id: "process-inbox-add-action") {
                        Task { await model.editProcessInbox(conversion.object("addAction").object("edit"), conversionAction: "add") }
                    }
                    primaryButton(conversion.text("createLabel"), id: "process-inbox-create-project") {
                        Task { await model.decideProcessInbox("createProject") }
                    }
                } else {
                    if !project.object("current").isEmpty {
                        option(project.object("current"), id: "process-inbox-project-current")
                    }
                    let search = project.object("search")
                    if !search.isEmpty {
                        let searchLayout = dynamicTypeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                            : AnyLayout(HStackLayout(spacing: 8))
                        searchLayout {
                            textInput("projectSearch", label: search.text("label"))
                                .submitLabel(.done).onSubmit { Task { await model.decideProcessInbox("submitProjectSearch") } }
                                .accessibilityIdentifier("process-inbox-project-search")
                            if !search.text("createLabel").isEmpty {
                                actionButton(search.text("createLabel"), id: "process-inbox-project-submit") {
                                    Task { await model.decideProcessInbox("submitProjectSearch") }
                                }
                            }
                        }
                    }
                    options(project.objects("projects"), prefix: "process-inbox-project")
                }
            }
            .sectionCard(palette)
        }
    }

    @ViewBuilder private var somedaySection: some View {
        let section = view.object("somedaySections")
        if !section.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(section.text("label")).rnFont(15, .semibold)
                options(section.objects("options"), prefix: "process-inbox-someday")
            }
            .sectionCard(palette)
        }
    }

    @ViewBuilder private var delegateSection: some View {
        let delegate = view.object("delegate")
        if !delegate.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(delegate.text("title")).rnFont(16, .bold)
                Text(delegate.text("hint")).rnFont(14).foregroundStyle(palette.secondary)
                textInput("delegateWho", label: delegate.text("whoLabel"))
                    .accessibilityIdentifier("process-inbox-delegate-who")
                options(delegate.objects("whoSuggestions"), prefix: "process-inbox-delegate-person")
                if !delegate.object("followUp").isEmpty { dateRow(delegate.object("followUp")) }
                if !delegate.object("request").text("message").isEmpty {
                    ShareLink(item: delegate.object("request").text("message"),
                              subject: Text(delegate.object("request").text("subject"))) {
                        Text(delegate.text("sendLabel")).rnFont(14, .semibold)
                            .foregroundStyle(palette.tint).frame(minHeight: 44)
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("process-inbox-delegate-share")
                }
            }
            .sectionCard(palette)
        }
    }

    @ViewBuilder private var contextsSection: some View {
        let contexts = view.object("contexts")
        if !contexts.isEmpty { tokenSection(contexts, kind: "context") }
    }

    private func tokenSection(_ tokens: CoreObject, kind: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tokens.text("title")).rnFont(15, .semibold)
            if !tokens.text("selectedContextsLabel").isEmpty {
                Text(tokens.text("selectedContextsLabel")).rnFont(12).foregroundStyle(palette.secondary)
            }
            options(tokens.objects("selectedContexts"), prefix: "process-inbox-" + kind + "-selected")
            if !tokens.text("selectedTagsLabel").isEmpty {
                Text(tokens.text("selectedTagsLabel")).rnFont(12).foregroundStyle(palette.secondary)
            }
            options(tokens.objects("selectedTags"), prefix: "process-inbox-" + kind + "-tag-selected")
            let tokenLayout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 8))
            tokenLayout {
                textInput("tokenInput", label: tokens.text("placeholder"))
                    .submitLabel(.done).onSubmit {
                        if tokens.object("add").flag("enabled") {
                            Task { await model.editProcessInbox(tokens.object("add").object("edit")) }
                        }
                    }
                    .accessibilityIdentifier("process-inbox-" + kind + "-input")
                actionButton(tokens.object("add").text("label"), id: "process-inbox-" + kind + "-add",
                             active: tokens.object("add").flag("enabled")) {
                    Task { await model.editProcessInbox(tokens.object("add").object("edit")) }
                }
            }
            options(tokens.objects("suggestions"), prefix: "process-inbox-" + kind + "-suggestion")
            if !tokens.text("contextSuggestionsLabel").isEmpty {
                Text(tokens.text("contextSuggestionsLabel")).rnFont(12).foregroundStyle(palette.secondary)
                options(tokens.objects("contextSuggestions"), prefix: "process-inbox-context-suggestion")
            }
            if !tokens.text("tagSuggestionsLabel").isEmpty {
                Text(tokens.text("tagSuggestionsLabel")).rnFont(12).foregroundStyle(palette.secondary)
                options(tokens.objects("tagSuggestions"), prefix: "process-inbox-tag-suggestion")
            }
        }
        .sectionCard(palette)
    }

    @ViewBuilder private var moreOptions: some View {
        let more = view.object("moreOptions")
        if !more.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Button { Task { await model.editProcessInbox(more.object("edit")) } } label: {
                    HStack {
                        Text(more.text("label")).rnFont(15, .semibold)
                        Spacer()
                        Image(systemName: more.flag("open") ? "chevron.up" : "chevron.down")
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityValue(more.flag("open") ? model.label("markdown.collapse") : model.label("markdown.expand"))
                .accessibilityIdentifier("process-inbox-more")
                if more.flag("open") {
                    let scheduling = more.object("scheduling")
                    if !scheduling.isEmpty {
                        Text(scheduling.text("title")).rnFont(15, .bold)
                        ForEach(scheduling.objects("rows").indices, id: \.self) { index in
                            dateRow(scheduling.objects("rows")[index])
                        }
                    }
                    let organization = more.object("organization")
                    if !organization.isEmpty { organizationSection(organization) }
                    let tags = more.object("tags")
                    if !tags.isEmpty { tokenSection(tags, kind: "tag") }
                }
            }
            .sectionCard(palette)
        }
    }

    private func organizationSection(_ section: CoreObject) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(section.text("title")).rnFont(15, .bold)
            if !section.text("priorityLabel").isEmpty {
                Text(section.text("priorityLabel")).rnFont(13, .semibold)
                options(section.objects("priorities"), prefix: "process-inbox-priority")
            }
            if !section.text("energyLabel").isEmpty {
                Text(section.text("energyLabel")).rnFont(13, .semibold)
                options(section.objects("energyLevels"), prefix: "process-inbox-energy")
            }
            if !section.text("timeEstimateLabel").isEmpty {
                Text(section.text("timeEstimateLabel")).rnFont(13, .semibold)
                options(section.objects("timeEstimates"), prefix: "process-inbox-estimate")
            }
            if !section.text("assignedToLabel").isEmpty {
                Text(section.text("assignedToLabel")).rnFont(13, .semibold)
                textInput("assignedTo", label: section.text("assignedToPlaceholder"))
                    .accessibilityIdentifier("process-inbox-assigned-to")
                options(section.objects("assignedToSuggestions"), prefix: "process-inbox-assigned-person")
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 10) {
            if !view.text("fileIt").isEmpty {
                primaryButton(view.text("fileIt"), id: "process-inbox-file") {
                    Task { await model.decideProcessInbox("fileIt") }
                }
            }
            if !view.text("back").isEmpty {
                actionButton(view.text("back"), id: "process-inbox-back") {
                    Task { await model.decideProcessInbox("back") }
                }
            }
        }
    }

    private var completed: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.inbox.object("empty").text("message").isEmpty ? model.label("common.done")
                 : model.inbox.object("empty").text("message"))
                .rnFont(20, .bold).accessibilityAddTraits(.isHeader)
            primaryButton(model.label("common.close"), id: "process-inbox-finish") {
                Task { await model.closeProcessInbox() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var messages: some View {
        VStack(alignment: .leading, spacing: 10) {
            let notice = model.processInboxNotice
            if !notice.isEmpty {
                Text(notice.text("title")).rnFont(14, .semibold)
                Text(notice.text("message")).rnFont(13)
                    .foregroundStyle(notice.text("tone") == "error" ? palette.danger : palette.warning)
                    .accessibilityIdentifier("process-inbox-notice")
            }
            if !model.processInboxToast.isEmpty && model.processInboxUndoLabel.isEmpty {
                Text(model.processInboxToast).rnFont(13).foregroundStyle(palette.success)
                    .accessibilityIdentifier("process-inbox-toast")
            }
            if let readError = model.processInboxReadError {
                Text(readError).rnFont(13).foregroundStyle(palette.danger)
                actionButton(model.label("common.retry"), id: "process-inbox-read-retry",
                             requiresControls: false, active: !model.busy && !model.retryNeeded) {
                    Task { await model.retryProcessInboxRead() }
                }
            }
            if let processError = model.processInboxError {
                Text(processError).rnFont(13).foregroundStyle(palette.danger)
                    .accessibilityIdentifier("process-inbox-error")
            }
            if model.retryNeeded {
                actionButton(model.label("common.retry"), id: "process-inbox-save-retry",
                             requiresControls: false, active: !model.busy && model.retryNeeded) {
                    Task { await model.retry() }
                }
            }
        }
    }

    private func textInput(_ field: String, label: String, multiline: Bool = false) -> some View {
        TextField(label, text: Binding(
            get: { model.processInboxInputs[field] ?? "" },
            set: { model.setProcessInboxInput(field, $0) }), axis: multiline ? .vertical : .horizontal)
            .rnFont(15)
            .lineLimit(multiline ? 2...5 : 1...1)
            .focused($focusedField, equals: field)
            .padding(12).frame(maxWidth: .infinity, minHeight: 44)
            .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            // Pure text reads leave controls enabled, so focus survives typing.
            .disabled(!enabled)
            .contentShape(Rectangle())
            .onTapGesture { if enabled { focusedField = field } }
            .accessibilityLabel(label)
    }

    private func options(_ values: [CoreObject], prefix: String) -> some View {
        AppChipFlow {
            ForEach(values.indices, id: \.self) { index in
                option(values[index], id: prefix + "-\(index)")
            }
        }
    }

    private func option(_ value: CoreObject, id: String) -> some View {
        let selected = value.flag("selected")
        return Button { Task { await model.editProcessInbox(value.object("edit")) } } label: {
            HStack(spacing: 6) {
                if !value.text("color").isEmpty {
                    Circle().fill(Color(hex: value.text("color"))).frame(width: 8, height: 8)
                }
                Text(value.text("label")).rnFont(13, .semibold)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(selected ? palette.onTint : palette.text)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(selected ? palette.tint : palette.card, in: Capsule())
            .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func actionButton(_ title: String, id: String, requiresControls: Bool = true, active: Bool = true,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).rnFont(14, .semibold).foregroundStyle(palette.tint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled((requiresControls && !enabled) || !active)
        .accessibilityIdentifier(id)
    }

    private func primaryButton(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).rnFont(15, .semibold).foregroundStyle(palette.onTint)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 14)
                .background(palette.tint, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(id == "process-inbox-finish" ? !model.processInboxCloseEnabled : !enabled)
        .accessibilityIdentifier(id)
    }

    private func presentDatePicker(_ row: CoreObject) {
        guard enabled else { return }
        let raw = row.text("date")
        if raw.count >= 10 {
            let day = String(raw.prefix(10))
            let parts = day.split(separator: "-").compactMap { Int($0) }
            if parts.count == 3 {
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = .current
                pickedDate = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date()
            }
        } else { pickedDate = Date() }
        pickingField = row.text("field")
    }

    private var datePickerSheet: some View {
        VStack(spacing: 16) {
            DatePicker("", selection: $pickedDate, displayedComponents: .date)
                .datePickerStyle(.graphical).labelsHidden()
            Button(model.label("common.done")) {
                guard let field = pickingField else { return }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = .current
                let components = calendar.dateComponents([.year, .month, .day], from: pickedDate)
                guard let year = components.year, let month = components.month, let day = components.day else { return }
                let selectedDay = String(format: "%04d-%02d-%02d", year, month, day)
                pickingField = nil
                Task { await model.editProcessInbox(["type": "setPickedDate", "field": field, "day": selectedDay]) }
            }
            .rnFont(15, .semibold).frame(minHeight: 44).disabled(!enabled)
            .accessibilityIdentifier("process-inbox-date-confirm")
        }
        .padding(20)
        .presentationDetents([.medium, .large])
    }
}

private extension View {
    func sectionCard(_ palette: AppPalette) -> some View {
        self.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
    }
}
