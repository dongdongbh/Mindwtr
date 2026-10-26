import SwiftUI

struct ReviewScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private var view: CoreObject { model.reviewOverview }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    AppChipFlow {
                        let choices = view.object("scope").objects("options")
                        ForEach(choices.indices, id: \.self) { index in
                            let choice = choices[index]
                            ReviewAction(title: choice.text("label"), selected: view.object("scope").text("selected") == choice.text("id"),
                                enabled: model.reviewActionsEnabled, palette: palette, id: "review-scope-" + choice.text("id")) {
                                Task { await model.editReviewOverview(scope: choice.text("id")) }
                            }
                        }
                        if view.object("scope").text("selected") == "all" {
                            ReviewAction(title: model.label("nav.history"), enabled: model.reviewActionsEnabled, palette: palette, id: "review-history") {
                                Task { await model.openHistory() }
                            }
                        }
                    }
                    Text(view.object("scope").text("help")).rnFont(12).foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
                AppChipFlow {
                    ReviewAction(title: view.object("expansion").text("label"),
                        enabled: model.reviewActionsEnabled && !view.object("expansion").flag("disabled"), palette: palette, id: "review-expand-cycle") {
                        Task { await model.editReviewOverview(expansion: ["type": "cycle"]) }
                    }
                    ReviewAction(title: view.object("startReview").text("label"), selected: true,
                        enabled: model.reviewActionsEnabled, palette: palette, id: "review-start") { model.openReviewPicker() }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(palette.card)
                Group {
                    ReviewFailure(model: model, palette: palette)
                    if let notice = model.reviewNotice {
                        Text(notice).rnFont(14).foregroundStyle(palette.success)
                            .accessibilityIdentifier("review-row-notice")
                    }
                    if !view.text("empty").isEmpty {
                        Text(view.text("empty")).rnFont(14).foregroundStyle(palette.secondary)
                            .frame(maxWidth: .infinity).padding(.vertical, 40).accessibilityIdentifier("review-empty")
                    }
                    let items = view.objects("items")
                    ForEach(items.indices, id: \.self) { index in
                        let item = items[index]
                        if item.text("type") == "task" {
                            VStack(alignment: .leading, spacing: 8) {
                                TaskCard(row: item.object("row"), model: model, palette: palette,
                                    onProject: { project in Task { await model.openProject(project) } })
                                AppChipFlow {
                                    ForEach(["markReviewed", "advance"], id: \.self) { name in
                                        let action = item.object("review").object(name)
                                        if !action.isEmpty {
                                            ReviewAction(title: action.text("label"), enabled: model.reviewActionsEnabled,
                                                palette: palette, id: "review-task-" + name + "-" + item.object("row").text("id")) {
                                                Task { await model.performReviewTaskAction(action.object("action")) }
                                            }
                                            .accessibilityLabel(action.text("accessibilityLabel"))
                                        }
                                    }
                                }
                            }
                            .disabled(!model.reviewActionsEnabled).padding(.leading, 20)
                        } else { group(item) }
                    }
                    if items.count < view.number("total") {
                        ReviewAction(title: model.label("common.more"), enabled: model.reviewActionsEnabled, palette: palette, id: "review-more") {
                            Task { await model.loadMoreReview() }
                        }
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(.horizontal, 12).padding(.bottom, 10)
            }
        }
        .refreshable { await model.refresh() }
    }

    private func group(_ item: CoreObject) -> some View {
        let area = item.text("type") == "area"
        return Button {
            Task { await model.editReviewOverview(expansion: ["type": area ? "toggleArea" : "toggleProject", "id": item.text("id")]) }
        } label: {
            HStack(spacing: 10) {
                if area { Circle().fill(item.text("color").isEmpty ? palette.tint : Color(hex: item.text("color"))).frame(width: 9, height: 9) }
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.text("title")).rnFont(area ? 16 : 15, .bold)
                    HStack(spacing: 5) {
                        if !item.text("statusTone").isEmpty {
                            Circle().fill(item.text("statusTone") == "warning" ? palette.warning : item.text("statusTone") == "danger" ? palette.danger : palette.success).frame(width: 6, height: 6)
                        }
                        Text(item.text("summary")).rnFont(12)
                            .foregroundStyle(item.text("summaryTone") == "warning" ? palette.warning : palette.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: item.flag("expanded") ? "chevron.down" : "chevron.right").foregroundStyle(palette.secondary)
            }
            .padding(14).frame(minHeight: 44).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.reviewActionsEnabled).padding(.leading, area ? 0 : 12)
        .accessibilityLabel(item.text("accessibilityLabel"))
        .accessibilityValue(model.label(item.flag("expanded") ? "markdown.collapse" : "markdown.expand"))
        .accessibilityAddTraits(item.flag("expanded") ? .isSelected : [])
        .accessibilityIdentifier("review-" + item.text("type") + "-" + item.text("id"))
    }
}

struct ReviewStartPicker: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { model.closeReviewPicker() }.accessibilityHidden(true)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(model.reviewOverview.object("startReview").text("label")).rnFont(20, .bold).accessibilityAddTraits(.isHeader)
                        let choices = model.reviewOverview.object("startReview").objects("options")
                        ForEach(choices.indices, id: \.self) { index in
                            let choice = choices[index]
                            ReviewAction(title: choice.text("label"), enabled: !model.busy && !model.retryNeeded,
                                palette: palette, id: "review-start-" + choice.text("id")) {
                                Task { await model.openReviewGuide(choice.text("id")) }
                            }
                        }
                        ReviewAction(title: model.reviewOverview.object("startReview").text("cancelLabel"),
                            enabled: !model.busy && !model.retryNeeded, palette: palette, id: "review-start-cancel") { model.closeReviewPicker() }
                    }
                    .padding(20)
                }
                .frame(maxWidth: 440, maxHeight: geometry.size.height * 0.7)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16)).padding(20)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { model.closeReviewPicker() }
        }
    }
}

struct ReviewGuideScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private var view: CoreObject { model.reviewGuide }
    private var content: CoreObject { view.object("content") }
    private var labels: CoreObject { view.object("labels") }
    private var daily: Bool { model.reviewKind == "daily" }
    private var scheduledGroup: Bool {
        !daily && ["waiting", "someday"].contains(content.text("step")) && content.object("scheduled").number("count") > 0
    }
    private var scheduledExpanded: Bool { model.reviewExpandedScheduled.contains(content.text("step")) }
    private var title: String {
        let value = daily ? view.text("title") : labels.text("weeklyReview")
        return value.isEmpty ? model.reviewOverview.object("startReview").objects("options")
            .first(where: { $0.text("id") == model.reviewKind })?.text("label") ?? "" : value
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Button { Task { await model.closeReviewGuide() } } label: {
                    AppIcon(name: "x", size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("common.close")).accessibilityIdentifier("review-guide-close")
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                    Text(view.object("step").text("title")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("review-guide-step")
                    Text(view.object("step").text(daily ? "label" : "indicator")).rnFont(12).foregroundStyle(palette.secondary)
                }
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12).background(palette.card)
            HStack {
                Button { Task { await model.openAreaPicker() } } label: {
                    Text(model.area.text("label")).rnFont(13, .semibold).padding(.horizontal, 12)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
                .accessibilityLabel(model.label("projects.areaFilter")).accessibilityIdentifier("review-guide-area")
                Spacer()
                Button { model.openSearch() } label: {
                    AppIcon(name: "search", size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                    .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
                    .accessibilityLabel(model.label("search.title")).accessibilityIdentifier("review-guide-search")
            }
            if !daily && !view.isEmpty {
                ProgressView(value: (view.object("step")["progress"] as? Double ?? 0) / 100).tint(palette.tint)
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        let steps = view.objects("rail")
                        ForEach(steps.indices, id: \.self) { index in
                            let step = steps[index]
                            Text(String(step.number("number")) + " " + step.text("title")).rnFont(12, .semibold)
                                .foregroundStyle(step.text("state") == "current" ? palette.tint : palette.secondary)
                                .padding(.vertical, 8).accessibilityAddTraits(step.text("state") == "current" ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 14)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ReviewFailure(model: model, palette: palette)
                    instructions
                    if content.text("step") == "inbox" {
                        inboxProcess
                        if !daily { inboxMindSweep }
                    }
                    if !content.text("empty").isEmpty { empty(content.text("empty")) }
                    if !daily && content.text("step") == "stale" { staleProjects }
                    if !daily && content.text("step") == "calendar" { calendarTasks }
                    let items = view.objects("items")
                    let visibleItems = scheduledGroup ? items.filter { !$0.flag("scheduled") } : items
                    ForEach(visibleItems.indices, id: \.self) { index in
                        guideItem(visibleItems[index])
                        openProjectLink(after: index, in: visibleItems)
                    }
                    if scheduledGroup {
                        scheduledToggle
                        if scheduledExpanded {
                            let scheduledItems = items.filter { $0.flag("scheduled") }
                            ForEach(scheduledItems.indices, id: \.self) { index in guideItem(scheduledItems[index]) }
                        }
                    }
                    // A folded group should not offer pages containing only its hidden rows.
                    let visibleTotal = view.number("total") - (scheduledGroup && !scheduledExpanded ? content.object("scheduled").number("count") : 0)
                    if items.count < visibleTotal {
                        ReviewAction(title: model.label("common.more"), enabled: model.reviewActionsEnabled, palette: palette, id: "review-guide-more") {
                            Task { await model.loadMoreReview() }
                        }
                    }
                    if content.text("step") == "completed" {
                        completed
                        if !daily { completedMindSweepNudge }
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(16)
            }
            .accessibilityIdentifier("review-guide-content-" + content.text("step"))
            .refreshable { await model.refresh() }
            if !model.taskFocusNotice.isEmpty { TaskFocusNotice(model: model, palette: palette) }
            if model.error != nil { FailureBanner(model: model, palette: palette) }
            footer
        }
        .foregroundStyle(palette.text).background(palette.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { Task { await model.closeReviewGuide() } }
    }

    @ViewBuilder private var instructions: some View {
        if daily {
            Text(view.object("step").text("description")).rnFont(14).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if content["count"] != nil {
                Text(String(content.number("count")) + " " + content.text("unit")).rnFont(14, .semibold)
            }
        } else {
            let step = content.text("step")
            let heading = ["inbox": "inboxDesc", "stale": "stale", "calendar": "calendarUpcoming",
                "waiting": "waitingDesc", "contexts": "contexts", "projects": "projectsDesc", "someday": "somedayDesc"][step] ?? ""
            let hint = ["inbox": "inboxGuide", "stale": "staleDesc", "calendar": "calendarDesc",
                "waiting": "waitingGuide", "contexts": "contextsDesc", "projects": "projectsGuide", "someday": "somedayGuide"][step] ?? ""
            if !heading.isEmpty { Text(labels.text(heading)).rnFont(18, .bold).accessibilityAddTraits(.isHeader) }
            if !hint.isEmpty { Text(labels.text(hint)).rnFont(14).foregroundStyle(palette.secondary).fixedSize(horizontal: false, vertical: true) }
            if !content.text("countLabel").isEmpty {
                Text(content.text("countLabel")).rnFont(14, .semibold)
                    .accessibilityIdentifier("review-guide-count")
            }
        }
    }

    @ViewBuilder private var inboxProcess: some View {
        let label = daily ? content.text("processLabel") : labels.text("processInbox")
        let hasItems = daily ? content.number("count") > 0 : !content.text("countLabel").isEmpty
        if hasItems && !label.isEmpty {
            Button { Task { await model.openProcessInbox() } } label: {
                HStack(spacing: 10) {
                    Image(systemName: "play.fill").font(.system(size: 14)).accessibilityHidden(true)
                    Text(label).rnFont(14, .semibold).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                }
                .foregroundStyle(palette.onTint)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 14)
                .background(palette.tint, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
            .accessibilityLabel(label)
            .accessibilityIdentifier(daily ? "review-daily-process-inbox" : "review-weekly-process-inbox")
        }
    }

    private var inboxMindSweep: some View {
        Button { Task { await model.openMindSweep() } } label: {
            HStack(spacing: 10) {
                AppIcon(name: "brain", size: 18)
                Text(labels.text("mindSweep")).rnFont(14, .semibold)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(palette.tint)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 14)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
        .accessibilityLabel(labels.text("mindSweep"))
        .accessibilityIdentifier("review-mind-sweep-button")
    }

    private var completedMindSweepNudge: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(labels.text("mindSweepTitle")).rnFont(16, .bold)
                .accessibilityIdentifier("review-mind-sweep-nudge-title")
            Text(labels.text("mindSweepIntro")).rnFont(14).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button { Task { await model.openMindSweep() } } label: {
                HStack(spacing: 8) {
                    AppIcon(name: "brain", size: 16)
                    Text(labels.text("mindSweep")).rnFont(14, .semibold)
                }
                .foregroundStyle(palette.tint)
                .padding(.horizontal, 14).frame(minHeight: 44)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.tint, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
            .accessibilityLabel(labels.text("mindSweep"))
            .accessibilityIdentifier("review-mind-sweep-button")
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
    }

    private var scheduledToggle: some View {
        Button { model.toggleReviewScheduled() } label: {
            HStack(spacing: 8) {
                Image(systemName: scheduledExpanded ? "chevron.down" : "chevron.right")
                Text(content.object("scheduled").text("label")).rnFont(13, .semibold)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(palette.secondary).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
        .accessibilityLabel(content.object("scheduled").text("label"))
        .accessibilityValue(model.label(scheduledExpanded ? "markdown.collapse" : "markdown.expand"))
        .accessibilityAddTraits(scheduledExpanded ? .isSelected : [])
        .accessibilityIdentifier("review-scheduled-toggle-" + content.text("step"))
    }

    @ViewBuilder private func guideItem(_ item: CoreObject) -> some View {
        if !item.object("row").isEmpty {
            TaskCard(row: item.object("row"), model: model, palette: palette,
                footer: daily ? item.object("followUp").text("label") : "", hideStatusBadge: item.flag("hideStatusBadge"),
                showFocusToggle: daily && content.text("step") == "focus", onProject: { project in Task { await model.openProject(project) } })
                .disabled(!model.reviewActionsEnabled)
        } else if item.text("type") == "project" {
            Button { Task { await model.expandWeeklyReviewProject(item.text("id")) } } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Circle().fill(item.text("areaColor").isEmpty ? palette.tint : Color(hex: item.text("areaColor"))).frame(width: 8, height: 8)
                        Text(item.text("title")).rnFont(16, .bold).frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: item.flag("expanded") ? "chevron.down" : "chevron.right")
                    }
                    Text(item.object("badge").text("label")).rnFont(12, .semibold)
                        .foregroundStyle(Color(hex: item.object("badge").text("color")))
                        .padding(6).background(Color(hex: item.object("badge").text("background")), in: Capsule())
                    Text(item.text("countLabel")).rnFont(12).foregroundStyle(palette.secondary)
                }
                .fixedSize(horizontal: false, vertical: true).padding(14).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
            .accessibilityAddTraits(item.flag("expanded") ? .isSelected : []).accessibilityIdentifier("review-guide-project-" + item.text("id"))
        } else if item.text("type") == "context" {
            VStack(alignment: .leading, spacing: 8) {
                let context = item.text("context")
                let window = model.reviewNestedWindow("contextTasks", key: context, fallback: item.object("tasks"))
                let expanded = model.reviewExpandedContexts.contains(context)
                HStack(alignment: .firstTextBaseline) {
                    Text(context).rnFont(16, .bold).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Text(String(window.number("total"))).rnFont(13).foregroundStyle(palette.secondary)
                        .accessibilityIdentifier("review-context-count-" + context)
                }
                let tasks = window.objects("items")
                let visibleTasks = expanded ? tasks : Array(tasks.prefix(max(0, content.number("previewCount"))))
                ForEach(visibleTasks.indices, id: \.self) { index in taskLink(visibleTasks[index].text("id"), title: visibleTasks[index].text("title")) }
                if expanded && tasks.count < window.number("total") {
                    ReviewAction(title: model.label("common.more"), enabled: model.reviewActionsEnabled, palette: palette,
                        id: "review-context-more-" + item.text("context")) {
                        Task { await model.loadMoreReviewNested("contextTasks", key: context) }
                    }
                }
                if !item.text("moreLabel").isEmpty {
                    ReviewAction(title: expanded ? labels.text("less") : item.text("moreLabel"), selected: expanded,
                        enabled: model.reviewActionsEnabled, palette: palette, id: "review-context-toggle-" + context) {
                        model.toggleReviewContext(context)
                    }
                }
            }
            .padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
        }
    }

    /// RN's Open project link (#1459): under an expanded project's last row, or under its card when it has none.
    @ViewBuilder private func openProjectLink(after index: Int, in items: [CoreObject]) -> some View {
        let item = items[index]
        let projectID = item.text("type") == "project" ? item.text("id") : item.text("projectId")
        let nextProjectID = index + 1 < items.count ? items[index + 1].text("projectId") : ""
        if !daily, !projectID.isEmpty, nextProjectID != projectID,
           let card = items[...index].last(where: { $0.text("type") == "project" }), card.text("id") == projectID, card.flag("expanded") {
            Button { Task { await model.openProject(card) } } label: {
                HStack(spacing: 6) {
                    AppIcon(name: "folder", size: 14)
                    Text(card.text("openLabel")).rnFont(13, .semibold).lineLimit(1)
                }
                .foregroundStyle(palette.tint).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.reviewActionsEnabled)
            .accessibilityLabel(card.text("openLabel")).accessibilityIdentifier("review-guide-open-project-" + projectID)
        }
    }

    private var staleProjects: some View {
        let window = model.reviewNestedWindow("staleProjects", fallback: content.object("projects"))
        return VStack(alignment: .leading, spacing: 8) {
            let projects = window.objects("items")
            ForEach(projects.indices, id: \.self) { index in
                let project = projects[index]
                Button { Task { await model.openProject(project) } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(project.text("title")).rnFont(15, .semibold)
                        Text(project.text("daysLabel")).rnFont(12).foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12).frame(minHeight: 44)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 10)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.reviewActionsEnabled).accessibilityIdentifier("review-stale-project-" + project.text("id"))
            }
            if projects.count < window.number("total") {
                ReviewAction(title: model.label("common.more"), enabled: model.reviewActionsEnabled, palette: palette, id: "review-stale-more") {
                    Task { await model.loadMoreReviewNested("staleProjects") }
                }
            }
        }
    }

    private var calendarTasks: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(labels.text("calendarTasks")).rnFont(15, .bold)
            let tasks = content.objects("tasks")
            ForEach(tasks.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 4) {
                    taskLink(tasks[index].text("taskId"), title: tasks[index].text("title"))
                    Text(tasks[index].text("meta")).rnFont(12).foregroundStyle(palette.secondary)
                }
            }
            if !content.text("tasksEmpty").isEmpty { empty(content.text("tasksEmpty")) }
        }
    }

    private func taskLink(_ id: String, title: String) -> some View {
        Button { Task { await model.openTask(id) } } label: {
            Text(title).rnFont(15).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.reviewActionsEnabled).accessibilityIdentifier("review-guide-task-" + id)
    }

    private func empty(_ text: String) -> some View {
        Text(text).rnFont(14).foregroundStyle(palette.secondary).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
    }

    private var completed: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "checkmark.circle").font(.system(size: 48)).foregroundStyle(palette.tint).accessibilityHidden(true)
            if daily {
                Text(model.label("dailyReview.completeDesc")).rnFont(14).foregroundStyle(palette.secondary)
            } else {
                Text(labels.text("reviewComplete")).rnFont(22, .bold)
                Text(labels.text("completeDesc")).rnFont(14).foregroundStyle(palette.secondary)
                let week = content.object("week")
                if !week.isEmpty {
                    Text(week.text("heading")).rnFont(16, .bold)
                    ForEach(week["rows"] as? [String] ?? [], id: \.self) { Text($0).rnFont(14) }
                }
                let checks = content.objects("checks")
                ForEach(checks.indices, id: \.self) { index in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: checks[index].flag("good") ? "checkmark.circle" : "circle").foregroundStyle(palette.secondary)
                        Text(checks[index].text("text")).rnFont(14)
                    }
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
    }

    private var footer: some View {
        AppChipFlow {
            if !view.object("finish").isEmpty {
                ReviewAction(title: view.object("finish").text("label"), selected: true, enabled: model.reviewActionsEnabled,
                    palette: palette, id: "review-guide-finish") { Task { await model.finishReview() } }
            } else {
                ReviewAction(title: view.object("back").text("label"), enabled: model.reviewActionsEnabled && (view.object("back")["checkpoint"] is String),
                    palette: palette, id: "review-guide-back") { Task { await model.moveReview("back") } }
                ReviewAction(title: view.object("next").text("label"), selected: true, enabled: model.reviewActionsEnabled && !view.object("next").isEmpty,
                    palette: palette, id: "review-guide-next") { Task { await model.moveReview("next") } }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .trailing).background(palette.card)
        .overlay(alignment: .top) { palette.border.frame(height: 1) }
    }
}

private struct ReviewAction: View {
    let title: String
    var selected = false
    let enabled: Bool
    let palette: AppPalette
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).rnFont(14, .semibold).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.text)
                .padding(.horizontal, 14).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 10)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.5)
        .accessibilityIdentifier(id).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ReviewFailure: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var body: some View {
        if let error = model.reviewError {
            Text(error).rnFont(14).foregroundStyle(palette.danger).textSelection(.enabled).accessibilityIdentifier("review-error")
            ReviewAction(title: model.label("common.retry"), enabled: !model.busy && !model.retryNeeded, palette: palette, id: "review-retry") {
                Task { await model.retryReview() }
            }
        }
    }
}
