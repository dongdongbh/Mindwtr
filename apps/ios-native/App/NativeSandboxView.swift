import Combine
import Foundation
import SwiftUI
import UIKit
import MindwtrNativeCore

@MainActor
final class NativeSandboxModel: ObservableObject {
    enum ListKind: String, CaseIterable { case inbox, next, today, projects }
    private struct Request { let method: NativeSandboxMethod; let arguments: String }
    let runtime: NativeSandboxRuntime
    let strings: CoreObject
    @Published private(set) var kind: ListKind = .inbox
    @Published private(set) var view: CoreObject = [:]
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var projectID: String?
    @Published private(set) var projectTitle = ""
    @Published var taskPresented = false
    @Published private(set) var taskID = ""
    @Published private(set) var editor: CoreObject = [:]
    @Published var titleDraft = ""
    @Published var descriptionDraft = ""
    @Published var captureDraft = ""
    @Published var projectDraft = ""
    @Published var renamePresented = false
    @Published var renameDraft = ""
    private var renameOptions: CoreObject = [:]
    private var pending: Request?
    private var operation: Task<Void, Never>?
    private var operationID = UUID()
    private var closed = false
    var canEdit: Bool { !busy && pending == nil && !closed }
    var canRetry: Bool { !busy && pending != nil && !closed }
    init(runtime: NativeSandboxRuntime, strings: CoreObject) { self.runtime = runtime; self.strings = strings }
    func label(_ key: String) -> String { strings.text(key) }
    var rows: [CoreObject] {
        projectID == nil ? view.objects("rows") : view.objects("items").filter { $0.text("type") == "task" }.map { $0.object("row") }
    }
    var projects: [CoreObject] {
        ["active", "deferred", "archived"].flatMap { view.objects($0).flatMap { $0.objects("projects") } }
    }
    func select(_ selected: ListKind) {
        guard canEdit else { return }
        kind = selected; projectID = nil; projectTitle = ""; view = [:]; refresh()
    }
    func refresh(more: Bool = false) {
        guard canEdit else { return }
        let method: NativeSandboxMethod = projectID == nil ? (kind == .projects ? .projects : kind == .next ? .next : kind == .today ? .today : .inbox) : .project
        var arguments: CoreObject = method == .projects ? [:] : ["offset": more ? (projectID == nil ? view.objects("rows").count : view.objects("items").count) : 0, "limit": 100]
        if let projectID { arguments["projectId"] = projectID }
        if more { arguments["revision"] = view.text("revision") }
        run(method, arguments: arguments) { result in
            if more {
                let field = self.projectID == nil ? "rows" : "items"
                var combined = result; combined[field] = self.view.objects(field) + result.objects(field); self.view = combined
            } else { self.view = result }
        }
    }
    var hasMore: Bool {
        kind != .projects || projectID != nil ? (projectID == nil ? view.objects("rows").count : view.objects("items").count) < view.number("total") : false
    }
    func openProject(_ row: CoreObject) {
        guard canEdit else { return }
        projectID = row.text("id"); projectTitle = row.text("title"); view = [:]; refresh()
    }
    func openTask(_ row: CoreObject) {
        guard canEdit else { return }
        let id = row.text("id")
        run(.task, arguments: ["id": id]) { _ in
            self.run(.editor, arguments: ["id": id]) { result in
                self.taskID = id; self.editor = result
                self.titleDraft = result.object("draft").text("title")
                self.descriptionDraft = result.object("draft").text("description")
                self.taskPresented = true
            }
        }
    }
    func saveTask() {
        guard canEdit, !taskID.isEmpty else { return }
        let draft = editor.object("draft")
        run(.saveDraft, arguments: ["id": taskID, "base": ["title": draft.text("title"), "description": draft.text("description")],
            "patch": ["title": titleDraft, "description": descriptionDraft], "requestId": UUID().uuidString.lowercased()]) { _ in
            self.taskPresented = false; self.editor = [:]; self.refresh()
        }
    }
    func capture() {
        guard canEdit, !captureDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        run(.capture, arguments: ["title": captureDraft, "captureId": UUID().uuidString.lowercased()]) { _ in
            self.captureDraft = ""; self.refresh()
        }
    }
    func complete(_ row: CoreObject) {
        guard canEdit else { return }
        run(.complete, arguments: ["id": row.text("id"), "taskRevision": row.text("taskRevision"), "requestId": UUID().uuidString.lowercased()]) { _ in self.refresh() }
    }
    func createProject() {
        guard canEdit, !projectDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        run(.createProject, arguments: ["title": projectDraft, "areaId": NSNull(), "requestId": UUID().uuidString.lowercased()]) { _ in
            self.projectDraft = ""; self.refresh()
        }
    }
    func beginRename() {
        guard canEdit, let projectID else { return }
        run(.renameOptions, arguments: ["projectId": projectID]) { result in
            guard result.flag("canRename") else { return }
            self.renameOptions = result; self.renameDraft = result.object("project").text("title"); self.renamePresented = true
        }
    }
    func renameProject() {
        guard canEdit, let projectID else { return }
        var expected = renameOptions.object("project"); expected.removeValue(forKey: "id")
        run(.renameProject, arguments: ["projectId": projectID, "title": renameDraft, "expected": expected,
            "requestId": UUID().uuidString.lowercased()]) { result in
            self.projectTitle = result.text("title"); self.renamePresented = false; self.refresh()
        }
    }
    private var completion: ((CoreObject) -> Void)?
    private func run(_ method: NativeSandboxMethod, arguments: CoreObject, completion: @escaping (CoreObject) -> Void) {
        guard canEdit else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys])
            pending = Request(method: method, arguments: String(decoding: data, as: UTF8.self))
            self.completion = completion; dispatch()
        } catch { self.error = label("settings.feedback.actionFailed") }
    }
    func retry() { guard canRetry else { return }; dispatch() }
    private func dispatch() {
        guard !closed, !busy, let request = pending else { return }
        let id = UUID(); operationID = id; busy = true; error = nil
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let raw = try await self.runtime.call(request.method, argumentsJSON: request.arguments)
                guard !self.closed, self.operationID == id, !Task.isCancelled,
                      let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? CoreObject else { throw CancellationError() }
                let callback = self.completion
                self.pending = nil; self.completion = nil; self.operation = nil; self.busy = false
                callback?(value)
            } catch {
                guard !self.closed, self.operationID == id else { return }
                self.operation = nil; self.busy = false
                if let failure = error as? NativeSandboxRuntimeError {
                    switch failure {
                    case .invalidInput:
                        self.pending = nil; self.completion = nil
                    case .core(let code, _) where ["INVALID_INPUT", "STALE_REVISION", "TASK_NOT_FOUND", "NOT_READY"].contains(code):
                        self.pending = nil; self.completion = nil
                    default: break
                    }
                }
                if !Task.isCancelled { self.error = self.label("settings.feedback.actionFailed") }
            }
        }
    }
    func suspend() { operation?.cancel() }
    func closeAndDrain() async throws {
        closed = true; operationID = UUID()
        let admitted = operation; admitted?.cancel(); await admitted?.value
        try await runtime.closeAndDrain()
        operation = nil; pending = nil; completion = nil; busy = false
    }
}

struct NativeSandboxView: View {
    @ObservedObject var session: NativeSandboxSession
    let palette: AppPalette
    var body: some View {
        Group {
            if let sample = session.sample, session.state == .sample { NativeSandboxContent(model: sample, session: session, palette: palette) }
            else {
                VStack(spacing: 16) {
                    Text(session.model.label("sandbox.switching")).rnFont(22, .semibold)
                    if session.working { ProgressView() }
                    if session.failure {
                        Text(session.model.label("settings.feedback.actionFailed")).rnFont(15).multilineTextAlignment(.center)
                        Button(session.model.label("common.retry")) { session.retryTransition() }.frame(minHeight: 44)
                        if session.canReturn { Button(session.model.label("sandbox.exit")) { session.exit() }.frame(minHeight: 44) }
                    }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
        .overlay(alignment: .bottom) {
            if session.fixtureTransitionEnabled {
                Text(session.fixtureTransitionState).font(.caption2).lineLimit(6).padding(4)
                    .accessibilityElement(children: .ignore).accessibilityLabel(session.fixtureTransitionState)
                    .accessibilityIdentifier("sandbox-transition-state")
            }
        }
        #endif
        .background(palette.bg).foregroundStyle(palette.text)
            .environment(\.nativeExternalLinkAdmission, { false })
            .environment(\.openURL, OpenURLAction { _ in .discarded })
    }
}

private struct NativeSandboxContent: View {
    @ObservedObject var model: NativeSandboxModel
    @ObservedObject var session: NativeSandboxSession
    let palette: AppPalette
    private func title(_ kind: NativeSandboxModel.ListKind) -> String {
        model.label(kind == .inbox ? "tab.inbox" : kind == .next ? "tab.next" : kind == .today ? "focus.schedule" : "nav.projects")
    }
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(model.label("sandbox.title")).rnFont(22, .bold).accessibilityAddTraits(.isHeader)
                Text(model.label("sandbox.notice")).rnFont(13).foregroundStyle(palette.secondary)
                HStack {
                    Button(model.label("sandbox.resetShort")) { session.reset() }.frame(minHeight: 44).accessibilityIdentifier("sandbox-reset")
                    Spacer()
                    Button(model.label("sandbox.exitShort")) { session.exit() }.frame(minHeight: 44).accessibilityIdentifier("sandbox-exit")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 16) {
                        ForEach(NativeSandboxModel.ListKind.allCases, id: \.rawValue) { kind in
                            Button(title(kind)) { model.select(kind) }.frame(minHeight: 44)
                                .accessibilityAddTraits(model.kind == kind && model.projectID == nil ? .isSelected : [])
                                .accessibilityIdentifier("sandbox-tab-" + kind.rawValue)
                        }
                    }
                }.disabled(!model.canEdit)
            }.padding(16).background(palette.card)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if model.projectID != nil {
                        HStack {
                            Text(model.projectTitle).rnFont(21, .bold)
                            Spacer()
                            Button(model.label("common.rename")) { model.beginRename() }.disabled(!model.canEdit)
                        }
                    }
                    HStack {
                        TextField(model.label("nav.addTask"), text: $model.captureDraft).textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("sandbox-capture-input")
                        Button(model.label("common.add")) { model.capture() }.frame(minHeight: 44).accessibilityIdentifier("sandbox-capture-save")
                    }.disabled(!model.canEdit)
                    if model.kind == .projects && model.projectID == nil {
                        HStack {
                            TextField(model.label("projects.addPlaceholder"), text: $model.projectDraft).textFieldStyle(.roundedBorder)
                            Button(model.label("common.add")) { model.createProject() }.frame(minHeight: 44)
                        }.disabled(!model.canEdit)
                        ForEach(model.projects.indices, id: \.self) { index in
                            let project = model.projects[index]
                            Button { model.openProject(project) } label: {
                                Text(project.text("title")).rnFont(17, .semibold).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            }.disabled(!model.canEdit)
                        }
                    } else {
                        ForEach(model.rows.indices, id: \.self) { index in
                            let row = model.rows[index]
                            HStack(spacing: 12) {
                                Button { model.openTask(row) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(row.text("title")).rnFont(17, .semibold)
                                        Text(row.object("meta").text("statusLabel")).rnFont(13).foregroundStyle(palette.secondary)
                                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }.accessibilityIdentifier("sandbox-task-" + row.text("id"))
                                if row.text("status") != "done" {
                                    Button { model.complete(row) } label: { Image(systemName: "checkmark.circle").frame(width: 44, height: 44) }
                                        .accessibilityLabel(model.label("common.done"))
                                }
                            }.disabled(!model.canEdit).padding(12).background(palette.row, in: RoundedRectangle(cornerRadius: 12))
                        }
                        if model.hasMore { Button(model.label("common.more")) { model.refresh(more: true) }.disabled(!model.canEdit).frame(minHeight: 44) }
                    }
                    if model.busy { ProgressView() }
                    if let error = model.error { Text(error).rnFont(14).foregroundStyle(palette.danger) }
                    if model.canRetry { Button(model.label("common.retry")) { model.retry() }.frame(minHeight: 44) }
                }.padding(16)
            }
        }
        .sheet(isPresented: $model.taskPresented) {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.label("taskEdit.title")).rnFont(22, .bold)
                TextField(model.label("taskEdit.titleLabel"), text: $model.titleDraft).textFieldStyle(.roundedBorder).disabled(!model.canEdit)
                    .accessibilityIdentifier("sandbox-task-title")
                TextField(model.label("taskEdit.descriptionLabel"), text: $model.descriptionDraft, axis: .vertical)
                    .lineLimit(5...12).textFieldStyle(.roundedBorder).disabled(!model.canEdit)
                    .accessibilityIdentifier("sandbox-task-description")
                HStack {
                    Button(model.label("common.cancel")) { model.taskPresented = false }
                    Spacer()
                    Button(model.label("common.save")) { model.saveTask() }.accessibilityIdentifier("sandbox-task-save")
                }.frame(minHeight: 44).disabled(!model.canEdit)
                if let error = model.error { Text(error).foregroundStyle(palette.danger) }
                if model.canRetry { Button(model.label("common.retry")) { model.retry() }.frame(minHeight: 44) }
                Spacer()
            }.padding(20).interactiveDismissDisabled(!model.canEdit).presentationDetents([.large])
        }
        .sheet(isPresented: $model.renamePresented) {
            VStack(spacing: 16) {
                TextField(model.label("taskEdit.titleLabel"), text: $model.renameDraft).textFieldStyle(.roundedBorder).disabled(!model.canEdit)
                HStack {
                    Button(model.label("common.cancel")) { model.renamePresented = false }
                    Spacer()
                    Button(model.label("common.save")) { model.renameProject() }
                }.frame(minHeight: 44).disabled(!model.canEdit)
                if let error = model.error { Text(error).foregroundStyle(palette.danger) }
                if model.canRetry { Button(model.label("common.retry")) { model.retry() } }
                Spacer()
            }.padding(20).interactiveDismissDisabled(!model.canEdit)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in model.suspend() }
    }
}
