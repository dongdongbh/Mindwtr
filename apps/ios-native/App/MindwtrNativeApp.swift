import SwiftUI
import LocalAuthentication
import UIKit

@main
struct MindwtrNativeApp: App {
    @StateObject private var model = CoreModel()

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
    @ObservedObject var model: CoreModel
    @ObservedObject var lock: AppLockController
    @State private var confirmingCorruptDraftDiscard = false
    @Environment(\.scenePhase) private var phase
    @Environment(\.colorScheme) private var scheme
    private var palette: AppPalette { AppPalette(theme: model.theme, system: scheme) }

    var body: some View {
        let startupToken = model.completedStartupToken
        Group {
            if model.ready && !lock.concealed {
                if model.settingsSyncRestartRequired {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                            .font(.system(size: 32)).accessibilityHidden(true)
                        Text("Sync could not be confirmed. Close and reopen Mindwtr before trying again.")
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
        .onAppear { lock.sceneChanged(phase) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            model.cancelStartupSync()
            model.clearSettingsSyncForPrivacy()
            model.stopTaskAudioForBackground()
            model.cancelTaskFileImport()
            model.cancelProjectFileImport()
            model.flushTaskDraftCheckpointInBackground()
            if model.appLockActive && !lock.authenticating { lock.readFailed() }
            lock.concealSnapshot()
        }
        .onChange(of: phase) { next in
            if next != .active {
                model.cancelStartupSync()
                model.clearSettingsSyncForPrivacy()
                model.stopTaskAudioForBackground()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.flushTaskDraftCheckpointInBackground()
            }
            if next != .active && model.appLockActive && !lock.authenticating { lock.readFailed() }
            lock.sceneChanged(next)
            if next == .active && !lock.concealed { Task { await model.refresh() } }
        }
        .onChange(of: lock.concealed) { concealed in
            if concealed {
                model.cancelStartupSync()
                model.clearSettingsSyncForPrivacy()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.dismissTaskShare()
            }
            if !concealed && phase == .active { Task { await model.refresh() } }
        }
        .task(id: "\(startupToken?.uuidString ?? "")-\(phase == .active)-\(lock.concealed)") {
            guard !Task.isCancelled else { return }
            model.requestStartupSync(token: startupToken, active: phase == .active)
        }
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
