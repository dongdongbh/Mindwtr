import SwiftUI

struct WaitingScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if model.waitingCurrent {
                stats
                peopleFilter
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.waitingError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("waiting-error")
                        Button(model.label("common.retry")) { Task { await model.refresh() } }
                            .rnFont(14, .semibold).frame(minHeight: 44).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("waiting-retry")
                    }
                    if model.waitingCurrent {
                        deferredProjects
                        let rows = model.waiting.objects("rows")
                        ForEach(rows.indices, id: \.self) { index in
                            TaskCard(row: rows[index], model: model, palette: palette,
                                     showDetails: model.waiting.flag("showDetails"))
                                .id(rows[index].text("id"))
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
            .refreshable { await model.refresh() }
        }
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

        Path { path in
            path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20))
            path.move(to: CGPoint(x: 10, y: 8)); path.addLine(to: CGPoint(x: 10, y: 16))
            path.move(to: CGPoint(x: 14, y: 8)); path.addLine(to: CGPoint(x: 14, y: 16))
        }
        .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24).scaleEffect(2).frame(width: 48, height: 48).accessibilityHidden(true)
    }
}
