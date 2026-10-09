import SwiftUI
import LocalAuthentication
import UIKit
import MindwtrNativeCore
import UserNotifications

/// One immutable process snapshot, shared by startup and future early native response capture.
enum NativeAppLaunch {
    static let arguments = ProcessInfo.processInfo.arguments
    static let selection: Result<NativeLaunchSelection, Error> = {
        #if targetEnvironment(simulator) || (DEBUG && NATIVE_DEVICE_TEST)
        let identifier = Bundle.main.bundleIdentifier
        #if !targetEnvironment(simulator)
        guard identifier == "tech.dongdongbh.mindwtr.native.dev" else {
            return .failure(LaunchFailure.developmentBundleRequired)
        }
        let mode = NativeLaunchSelection.BuildMode.deviceTest
        #elseif DEBUG
        let mode = NativeLaunchSelection.BuildMode.simulatorDebug
        #else
        let mode = NativeLaunchSelection.BuildMode.simulatorRelease
        #endif
        return Result {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: false)
            return try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: identifier,
                supportURL: support, homeURL: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), mode: mode)
        }
        #else
        return .failure(LaunchFailure.unavailable)
        #endif
    }()

    private enum LaunchFailure: LocalizedError {
        case developmentBundleRequired
        case unavailable
        var errorDescription: String? {
            switch self {
            case .developmentBundleRequired: return "Physical testing requires the isolated native development app."
            case .unavailable: return "This build is not enabled for physical-device testing."
            }
        }
    }
}

/// One pre-host owner; a failed open is retried only by a later explicit capture or startup.
actor NativeNotificationResponses {
    struct Diagnostic: Sendable {
        let action: String
        let outcome: String
    }
    static let shared = NativeNotificationResponses()
    static let changed = Notification.Name("MindwtrNativeNotificationResponsesChanged")
    private var storage: NativeReminderInbox?
    private var diagnostics: [Diagnostic] = []

    #if DEBUG && targetEnvironment(simulator)
    private var moreTestCaptured = false
    func captureMoreTestResponse() async throws {
        let mode = ProcessInfo.processInfo.environment["MINDWTR_RESPONSE_TEST_MORE"] ?? ""
        guard !moreTestCaptured, ["1", "context"].contains(mode),
              case let .isolated(_, _, namespace, _) = try NativeAppLaunch.selection.get() else { return }
        moreTestCaptured = true
        let content = UNMutableNotificationContent()
        let data = mode == "context"
            ? ["alarmKey": "task:task452-preview", "kind": "context-automation", "context": " @office "]
            : ["alarmKey": "task:task452-preview", "taskId": "task452-preview"]
        content.userInfo = ["mindwtrNativeReminder": ["version": 1, "namespace": namespace, "id": 452], "data": data]
        let request = UNNotificationRequest(identifier: "mindwtr-native:\(namespace):452", content: content, trigger: nil)
        let now = Date()
        guard let response = NativeReminderResponse.capture(request, deliveredAt: now, receivedAt: now,
            actionIdentifier: UNNotificationDefaultActionIdentifier, namespace: namespace),
              try await capture(response) != nil else { throw CocoaError(.coderInvalidValue) }
        record(.open, outcome: "captured")
        await MainActor.run {
            // The fixture must capture while More is open, rather than win a close/capture race.
            precondition(NativeAppModel.shared.morePresented)
            NativeAppModel.shared.requestNotificationResponses()
        }
    }
    #endif

    func record(_ action: NativeReminderResponse.Action, outcome: String) {
        if diagnostics.count == 128 { diagnostics.removeFirst() }
        diagnostics.append(.init(action: action.rawValue, outcome: outcome))
    }

    func takeDiagnostics() -> [Diagnostic] {
        defer { diagnostics.removeAll() }
        return diagnostics
    }

    private func inbox() throws -> NativeReminderInbox {
        if let storage { return storage }
        let opened = try NativeReminderInbox(selection: NativeAppLaunch.selection.get())
        storage = opened
        return opened
    }

    func capture(_ response: NativeReminderResponse) async throws -> NativeReminderInbox.Item? {
        let current = try inbox()
        do { return try await current.capture(response) }
        catch {
            try await current.retry()
            return try await current.capture(response)
        }
    }

    func pending() async throws -> [NativeReminderInbox.Item] {
        let current = try inbox()
        try await current.retry()
        return try await current.pending()
    }

    func markAdmitting(_ id: String) async throws -> NativeReminderInbox.Item {
        let current = try inbox()
        do { return try await current.markAdmitting(id) }
        catch {
            try await current.retry()
            return try await current.markAdmitting(id)
        }
    }

    func finish(_ item: NativeReminderInbox.Item) async throws {
        let current = try inbox()
        do { try await current.finish(item) }
        catch {
            try await current.retry()
            try await current.finish(item)
        }
    }
}

final class NativeNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let selection = try? NativeAppLaunch.selection.get() else { return true }
        switch selection {
        case .standard, .isolated:
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.setNotificationCategories(NativeReminderResponse.categories())
        case .rehearsal: break
        }
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let namespace: String
        guard let selection = try? NativeAppLaunch.selection.get() else { completionHandler(); return }
        switch selection {
        case let .standard(_, _, name), let .isolated(_, _, name, _): namespace = name
        case .rehearsal: completionHandler(); return
        }
        guard let captured = NativeReminderResponse.capture(response.notification.request,
            deliveredAt: response.notification.date, receivedAt: Date(),
            actionIdentifier: response.actionIdentifier, namespace: namespace) else { completionHandler(); return }
        Task {
            defer { completionHandler() }
            do {
                if try await NativeNotificationResponses.shared.capture(captured) != nil {
                    await NativeNotificationResponses.shared.record(captured.action, outcome: "captured")
                    await MainActor.run {
                        NativeAppModel.shared.requestNotificationResponses()
                        NotificationCenter.default.post(name: NativeNotificationResponses.changed, object: nil)
                    }
                } else {
                    await NativeNotificationResponses.shared.record(captured.action, outcome: "retired")
                    await MainActor.run { NativeAppModel.shared.requestNotificationResponses() }
                }
            } catch {
                await NativeNotificationResponses.shared.record(captured.action, outcome: "capture-refused")
                await MainActor.run { NativeAppModel.shared.requestNotificationResponses() }
            }
        }
    }
}

@MainActor
enum NativeAppModel {
    static let shared = CoreModel()
}

@main
struct MindwtrNativeApp: App {
    @UIApplicationDelegateAdaptor(NativeNotificationDelegate.self) private var notificationDelegate
    @StateObject private var model = NativeAppModel.shared

    var body: some Scene {
        WindowGroup {
            AppLockRoot(model: model, lock: model.appLock)
                .environment(\.nativeExternalLinkLabels, model.strings)
                .environment(\.nativeExternalLinkDiagnostic, { outcome, surface in
                    Task { await model.recordUpNoteHandoff(outcome, surface: surface) }
                })
                .task { await model.start() }
        }
    }
}

/// Device authentication only; the shared core owns the saved setting and its writes.
@MainActor
final class AppLockController: ObservableObject {
    @Published private(set) var enabled: Bool?
    @Published private(set) var locked = true
    @Published private(set) var authenticating = false
    @Published private(set) var errorKey: String?
    @Published private(set) var nonce = 0
    private var promptedNonce = -1
    private var phase: ScenePhase = .active
    private var context: LAContext?
    private var authenticationGeneration = 0
    private var successfulAuthenticationGeneration: Int?
    private var privacyCovers: [UIView] = []
#if DEBUG && targetEnvironment(simulator)
    // Configured only after CoreModel validates an isolated UUID test library.
    var testOutcomes: [String] = []
#endif
    var concealed: Bool { enabled == nil || locked }

    func saved(_ value: Bool, justEnabled: Bool = false) {
        let firstRead = enabled == nil
        let changed = enabled != value
        enabled = value
        if !value { locked = false; errorKey = nil }
        else if justEnabled && phase != .background && successfulAuthenticationGeneration == authenticationGeneration { locked = false; errorKey = nil }
        else if firstRead || changed { lock() }
    }

    func readFailed() {
        enabled = nil
        locked = true
    }

    private func lock() {
        locked = true
        errorKey = nil
        nonce += 1
    }

    func concealSnapshot() {
        guard enabled != false, privacyCovers.isEmpty else { return }
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows where window.isKeyWindow {
                let cover = UIView(frame: window.bounds)
                cover.backgroundColor = .systemBackground
                cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                cover.isAccessibilityElement = false
                cover.accessibilityViewIsModal = true
                window.addSubview(cover)
                privacyCovers.append(cover)
            }
        }
    }

    func sceneChanged(_ next: ScenePhase) {
        let previous = phase
        phase = next
        if next == .active {
            // Remove after SwiftUI has reconciled the locked tree, including any presented sheets.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.phase == .active else { return }
                self.privacyCovers.forEach { $0.removeFromSuperview() }
                self.privacyCovers.removeAll()
            }
        }
        // The system prompt makes the app inactive. Actual backgrounding cancels it.
        if next == .background {
            authenticationGeneration += 1
            context?.invalidate()
            if enabled == true { lock() }
        } else if previous == .active && next == .inactive && !authenticating {
            authenticationGeneration += 1
            if enabled == true { lock() }
        }
    }

    func autoUnlock(label: (String) -> String) async {
        guard enabled == true, locked, phase == .active, !authenticating, promptedNonce != nonce else { return }
        let candidate = nonce
        do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
        guard candidate == nonce, enabled == true, locked, phase == .active, !authenticating,
              promptedNonce != candidate else { return }
        promptedNonce = candidate
        await unlock(label: label)
    }

    func unlock(label: (String) -> String) async {
        guard enabled == true, locked else { return }
        promptedNonce = nonce
        if await authenticate(reason: label("appLock.prompt"), label: label) { locked = false }
    }

    func authenticate(reason: String, label: (String) -> String) async -> Bool {
        guard !authenticating, phase == .active else { return false }
        authenticating = true
        errorKey = nil
        let generation = authenticationGeneration
        defer { authenticating = false; context = nil }
#if DEBUG && targetEnvironment(simulator)
        if !testOutcomes.isEmpty {
            let outcome = testOutcomes.removeFirst()
            // Exercise the system-prompt inactive/active exception without invoking biometrics.
            sceneChanged(.inactive)
            await Task.yield()
            sceneChanged(.active)
            guard generation == authenticationGeneration, phase != .background else { return false }
            if outcome == "success" { successfulAuthenticationGeneration = generation; return true }
            errorKey = outcome == "cancel" ? "appLock.cancelled" : outcome == "unavailable" ? "appLock.unavailable" : "appLock.failed"
            return false
        }
#endif
        let attempt = LAContext()
        context = attempt
        attempt.localizedCancelTitle = label("common.cancel")
        attempt.localizedFallbackTitle = label("appLock.useDevicePasscode")
        var failure: NSError?
        guard attempt.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else {
            errorKey = "appLock.unavailable"
            return false
        }
        let result: (Bool, Error?) = await withCheckedContinuation { continuation in
            let prompt = reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Unlock Mindwtr" : reason
            attempt.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) { success, error in
                continuation.resume(returning: (success, error))
            }
        }
        guard generation == authenticationGeneration, phase != .background else { return false }
        if result.0 { successfulAuthenticationGeneration = generation; return true }
        switch (result.1 as? LAError)?.code {
        case .userCancel, .appCancel, .systemCancel: errorKey = "appLock.cancelled"
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled: errorKey = "appLock.unavailable"
        default: errorKey = "appLock.failed"
        }
        return false
    }
}

private struct AppLockRoot: View {
    private struct ForegroundState: Equatable {
        let token: UUID?
        let active: Bool
        let concealed: Bool
    }
    @ObservedObject var model: CoreModel
    @ObservedObject var lock: AppLockController
    @State private var confirmingCorruptDraftDiscard = false
    @State private var observedApplicationActive: Bool?
    @Environment(\.scenePhase) private var phase
    @Environment(\.colorScheme) private var scheme
    private var palette: AppPalette { AppPalette(theme: model.theme, system: scheme) }
    // Match RN AppState: refresh the initial snapshot until a lifecycle event supersedes it.
    private var applicationActive: Bool {
        observedApplicationActive ?? (UIApplication.shared.applicationState == .active)
    }

    var body: some View {
        let startupToken = model.completedStartupToken
        let foreground = ForegroundState(token: startupToken, active: applicationActive, concealed: lock.concealed)
        Group {
            if model.ready && !lock.concealed {
                if model.settingsSyncRestartRequired {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                            .font(.system(size: 32)).accessibilityHidden(true)
                        Text("The operation could not be confirmed. Close and reopen Mindwtr before trying again.")
                            .rnFont(17, .semibold).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.bg).foregroundStyle(palette.text)
                        .accessibilityIdentifier("sync-restart-gate")
                } else if model.settingsSyncPresented {
                    SettingsScreen(model: model, palette: palette)
                } else if model.taskRecoveryGateVisible {
                    TaskRecoveryGate(model: model, palette: palette)
                } else {
                    InboxScreen(model: model)
                        .overlay(alignment: .bottomTrailing) {
                            if model.taskRecoveryAvailable {
                                Button(model.taskAttachmentState == .savedCleanup
                                    || (model.taskAttachmentState == .discardedCleanup && !model.taskAttachmentHasIndependentDraft)
                                    ? "File cleanup" : "Resume draft") { model.showTaskRecovery() }
                                    .buttonStyle(.borderedProminent)
                                    .padding(16)
                                    .accessibilityIdentifier("task-recovery-open")
                            }
                        }
                }
            } else {
                ZStack {
                    palette.bg.ignoresSafeArea()
                    GeometryReader { geometry in
                        ScrollView {
                        VStack(spacing: 0) {
                            Image(systemName: "lock").font(.system(size: 34)).accessibilityHidden(true)
                                .frame(width: 72, height: 72)
                                .background(palette.filter, in: RoundedRectangle(cornerRadius: 24))
                                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
                                .padding(.bottom, 22)
                            Text(model.label("appLock.title").isEmpty ? "Mindwtr" : model.label("appLock.title")).rnFont(24, .bold).accessibilityAddTraits(.isHeader)
                                .multilineTextAlignment(.center).padding(.bottom, 10)
                            Text(model.label(lock.errorKey ?? "appLock.description"))
                                .rnFont(15).foregroundStyle(palette.secondary).multilineTextAlignment(.center)
                                .frame(maxWidth: 320).padding(.bottom, 26)
                            if model.busy || lock.authenticating {
                                ProgressView().accessibilityLabel(model.label("appLock.authenticating"))
                            } else if !model.ready && model.taskAttachmentState == .savedCleanup {
                                TaskAttachmentRecoveryStatus(model: model, palette: palette)
                            } else if model.taskRecoveryStartupCorrupt {
                                Text("An unreadable task draft prevents startup. Its contents cannot be shown.")
                                    .rnFont(15).multilineTextAlignment(.center).padding(.bottom, 12)
                                    .accessibilityIdentifier("task-recovery-startup-corrupt")
                                Button("Discard unreadable draft") { confirmingCorruptDraftDiscard = true }
                                    .accessibilityIdentifier("task-recovery-startup-discard")
                            } else if model.appLockRecoveryPending {
                                Text("The pending App lock change could not be confirmed. Cancel it to continue with the saved setting.")
                                    .rnFont(15).multilineTextAlignment(.center).padding(.bottom, 20)
                                Button("Cancel pending change") { Task { await model.cancelAppLockRecovery() } }
                                    .foregroundStyle(palette.onTint)
                                    .accessibilityIdentifier("app-lock-recovery-cancel")
                            } else if !model.ready && model.projectFileAvailabilityPending && lock.enabled != nil {
                                if lock.concealed {
                                    Button(model.label("appLock.unlock").isEmpty ? "Unlock" : model.label("appLock.unlock")) {
                                        Task { await lock.unlock(label: model.label) }
                                    }
                                    .foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-unlock")
                                } else {
                                    ProjectFileAvailabilityRecoveryPanel(model: model, palette: palette)
                                }
                            } else if !model.ready && !model.projectFileAddSummary.isEmpty && lock.enabled != nil {
                                if lock.concealed {
                                    Button(model.label("appLock.unlock").isEmpty ? "Unlock" : model.label("appLock.unlock")) {
                                        Task { await lock.unlock(label: model.label) }
                                    }
                                    .foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-unlock")
                                } else {
                                    ProjectFileAddRecoveryPanel(model: model, palette: palette)
                                }
                            } else if !model.ready || lock.enabled == nil {
                                if !model.ready && model.error != nil {
                                    Text(model.label("settings.feedback.actionFailed").isEmpty
                                        ? "Couldn't complete this action. Try again."
                                        : model.label("settings.feedback.actionFailed"))
                                        .rnFont(15).foregroundStyle(palette.danger).multilineTextAlignment(.center).padding(.bottom, 12)
                                        .accessibilityIdentifier("app-lock-read-error")
                                }
                                Button(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry")) {
                                    Task { await model.retryAppLockRead() }
                                }.foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-read-retry")
                            } else {
                                Button(model.label("appLock.unlock")) { Task { await lock.unlock(label: model.label) } }
                                    .foregroundStyle(palette.onTint)
                                    .accessibilityIdentifier("app-lock-unlock")
                            }
                        }
                        .padding(32).frame(maxWidth: 540)
                        .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                        }
                    }
                }
                .foregroundStyle(palette.text).tint(palette.tint)
                .buttonStyle(.borderedProminent).controlSize(.large).rnFont(16, .bold)
                .accessibilityIdentifier("app-lock-gate")
            }
        }
        .preferredColorScheme(model.theme.text("scheme").isEmpty ? nil : palette.dark ? .dark : .light)
        .onAppear {
            lock.sceneChanged(phase)
            if applicationActive { model.notificationSettingsDidBecomeActive() }
            model.requestForegroundSync(token: model.completedStartupToken, active: applicationActive)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestNotificationResponses()
        }
        .onReceive(NotificationCenter.default.publisher(for: NativeNotificationResponses.changed)) { _ in
            model.requestNotificationResponses()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            observedApplicationActive = true
            model.notificationSettingsDidBecomeActive()
            model.requestNotificationResponses()
            guard !lock.concealed else { return }
            model.requestForegroundSync(token: model.completedStartupToken, active: true)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            observedApplicationActive = false
            model.notificationSettingsWillResignActive()
            model.cancelForegroundSync()
            model.cancelReminderLifecycle()
            model.cancelProjectAttachmentDownload()
            model.clearSettingsSyncForPrivacy()
            model.stopTaskAudioForBackground()
            model.cancelTaskFileImport()
            model.cancelProjectFileImport()
            model.flushTaskDraftCheckpointInBackground()
            if model.appLockActive && !lock.authenticating { lock.readFailed() }
            lock.concealSnapshot()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            model.cancelNotificationSettingsIntent()
        }
        .onChange(of: phase) { next in
            if next == .background { model.cancelNotificationSettingsIntent() }
            model.observeForegroundSyncScene(next, token: startupToken)
            if next != .active {
                model.cancelForegroundSync()
                model.cancelReminderLifecycle()
                model.cancelProjectAttachmentDownload()
                model.cancelProjectFileAvailabilityRecovery()
                model.clearSettingsSyncForPrivacy()
                model.stopTaskAudioForBackground()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.flushTaskDraftCheckpointInBackground()
            }
            if next != .active && model.appLockActive && !lock.authenticating { lock.readFailed() }
            lock.sceneChanged(next)
            if next == .active && !lock.concealed { Task { await model.refresh() } }
            model.requestForegroundSync(token: model.completedStartupToken, active: applicationActive)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: applicationActive)
        }
        .onChange(of: lock.concealed) { concealed in
            if concealed {
                model.cancelNotificationSettingsIntent()
                model.cancelForegroundSync()
                model.cancelReminderLifecycle()
                model.cancelProjectAttachmentDownload()
                model.cancelProjectFileAvailabilityRecovery()
                model.clearSettingsSyncForPrivacy()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.dismissTaskShare()
            }
            if !concealed && phase == .active { Task { await model.refresh() } }
        }
        .onChange(of: foreground) { next in
            model.requestForegroundSync(token: next.token, active: next.active)
            model.requestReminderLifecycle(token: next.token, active: next.active)
            if next.active && !next.concealed { model.requestNotificationResponses() }
        }
        .onChange(of: model.notificationResponseContextClean) { clean in
            if clean { model.requestNotificationResponses() }
        }
        #if DEBUG && targetEnvironment(simulator)
        .onChange(of: model.morePresented) { presented in
            if presented { Task { try? await NativeNotificationResponses.shared.captureMoreTestResponse() } }
        }
        #endif
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.significantTimeChangeNotification)) { _ in
            model.reminderClockChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in model.reminderClockChanged() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in model.reminderClockChanged() }
        .task(id: "\(model.ready)-\(lock.nonce)-\(phase == .active)-\(lock.authenticating)") {
            guard model.ready, phase == .active else { return }
            await lock.autoUnlock(label: model.label)
        }
        .alert("Discard unreadable draft?", isPresented: $confirmingCorruptDraftDiscard) {
            Button("Discard draft", role: .destructive) {
                Task { await model.discardCorruptStartupDraft() }
            }
            .accessibilityIdentifier("task-recovery-startup-discard-confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the unsaved editor draft from this device. A pending save will prevent removal until it is settled.")
        }
    }
}

private struct TaskRecoveryGate: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var confirmingDiscard = false
    private var retainedCleanup: Bool {
        model.taskAttachmentState == .savedCleanup
            || (model.taskAttachmentState == .discardedCleanup && !model.taskAttachmentHasIndependentDraft)
    }
    private var canResume: Bool {
        model.taskAttachmentState == .none || model.taskAttachmentState == .active
            || model.taskAttachmentHasIndependentDraft
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.taskAttachmentState == .savedCleanup ? "Task saved"
                        : retainedCleanup ? "Draft discarded" : "Saved task draft")
                        .rnFont(24, .bold)
                        .accessibilityAddTraits(.isHeader)
                    if !retainedCleanup {
                        Text(model.taskRecoveryReviewTitle.isEmpty ? "Untitled task" : model.taskRecoveryReviewTitle)
                            .rnFont(17, .semibold)
                            .accessibilityIdentifier("task-recovery-title")
                        if !model.taskRecoveryReviewNote.isEmpty {
                            Text(model.taskRecoveryReviewNote).rnFont(15)
                                .foregroundStyle(palette.secondary)
                                .accessibilityIdentifier("task-recovery-note")
                        }
                        ForEach(Array(model.taskRecoveryReviewLines.enumerated()), id: \.offset) { entry in
                            Text(entry.element).rnFont(15).foregroundStyle(palette.secondary)
                        }
                    }
                    TaskAttachmentRecoveryStatus(model: model, palette: palette)
                    if let conflict = model.taskRecoveryConflict {
                        Text(conflict).rnFont(15).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("task-recovery-conflict")
                    }
                    if !retainedCleanup, let protectionError = model.taskRecoveryCheckpointError {
                        Text(protectionError).rnFont(15).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("task-recovery-error")
                        Button(model.label("common.retry")) {
                            Task { await model.retryTaskDraftCheckpoint() }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("task-recovery-retry-checkpoint")
                    }
                    if model.busy && model.taskAttachmentState == .none {
                        ProgressView().frame(minHeight: 44)
                            .accessibilityIdentifier("task-recovery-loading")
                    }
                    if canResume {
                        Button("Resume editing") { Task { await model.restoreTaskRecovery() } }
                            .buttonStyle(.borderedProminent)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy)
                            .accessibilityIdentifier("task-recovery-resume")
                    }
                    if !retainedCleanup {
                        Button("Keep for later") { Task { await model.keepTaskRecoveryForLater() } }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy || model.taskRecoveryCheckpointError != nil)
                            .accessibilityIdentifier("task-recovery-keep")
                        Button("Discard draft", role: .destructive) { confirmingDiscard = true }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy)
                            .accessibilityIdentifier("task-recovery-discard")
                    }
                }
                .padding(24)
                .frame(maxWidth: 540, minHeight: geometry.size.height, alignment: .center)
                .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(palette.text)
        .background(palette.bg)
        .tint(palette.tint)
        .accessibilityIdentifier("task-recovery-gate")
        .alert("Discard saved draft?", isPresented: $confirmingDiscard) {
            Button("Discard draft", role: .destructive) {
                Task { await model.discardTaskRecoveryDraft(close: true) }
            }
            .accessibilityIdentifier("task-recovery-discard-confirm")
            Button(model.label("common.cancel"), role: .cancel) {}
        } message: {
            Text("This removes the unsaved task changes from this device.")
        }
        .task {
            if canResume && model.taskRecoveryConflict == nil { await model.restoreTaskRecovery() }
        }
    }
}

struct TaskAttachmentRecoveryStatus: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    private var message: String? {
        switch model.taskAttachmentState {
        case .none: return nil
        case .active: return "File editing is active. Save or discard this draft to finish."
        case .interrupted: return "File editing was interrupted. Retry to confirm the result before continuing."
        case .savedCleanup: return "Task saved. File cleanup still needs to finish. Retry will finish cleanup."
        case .discardedCleanup:
            return model.taskAttachmentHasIndependentDraft
                ? "An earlier draft was discarded. Its file cleanup still needs to finish."
                : "Draft changes were discarded. File cleanup still needs to finish."
        case .blocked: return "This draft needs a recovery decision before file editing can continue."
        }
    }

    var body: some View {
        if message != nil || model.taskAttachmentError != nil {
            VStack(alignment: .leading, spacing: 8) {
                if let message {
                    Text(message).rnFont(14).foregroundStyle(palette.secondary)
                        .accessibilityIdentifier("task-attachment-status")
                }
                if model.taskAttachmentError != nil {
                    Text(model.label("settings.feedback.actionFailed").isEmpty
                        ? "Couldn't complete this action. Try again."
                        : model.label("settings.feedback.actionFailed")).rnFont(14).foregroundStyle(palette.danger)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("task-attachment-error")
                }
                if model.taskAttachmentWorking {
                    ProgressView().frame(minHeight: 44)
                }
                if model.taskAttachmentState == .interrupted || model.taskAttachmentState == .savedCleanup
                    || model.taskAttachmentState == .discardedCleanup || model.taskAttachmentState == .blocked {
                    if model.taskAttachmentState == .discardedCleanup
                        && (model.taskPresented || model.taskAttachmentHasIndependentDraft) {
                        Text("Save or discard the current draft before retrying file cleanup.")
                            .rnFont(14).foregroundStyle(palette.secondary)
                    }
                    Button(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry")) {
                        Task { await model.retryTaskAttachmentRecovery() }
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(model.busy || model.taskAttachmentWorking
                        || (model.taskAttachmentState == .discardedCleanup
                            && (model.taskPresented || model.taskAttachmentHasIndependentDraft)))
                    .accessibilityIdentifier("task-attachment-retry")
                }
                if model.taskAttachmentState == .discardedCleanup && !model.taskPresented
                    && !model.taskAttachmentHasIndependentDraft {
                    Button("Continue") { Task { await model.continueAfterTaskAttachmentDiscard() } }
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(model.busy || model.taskAttachmentWorking)
                        .accessibilityIdentifier("task-attachment-continue")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
