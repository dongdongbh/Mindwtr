import Combine
import Foundation
import MindwtrNativeCore

@MainActor
final class NativeSandboxSession: ObservableObject {
    enum Phase: String { case personal, draining, retired, unavailable }
    struct Receipt {
        let native: CoreHostRetirementReceipt
        let scope = "APP_HOST_RETIREMENT_ONLY"
    }
    enum Result {
        case retired(CoreHostRetirementReceipt)
        case refused
        case unavailable
    }

    enum CaptureHandoverResult { case confirmed, refused, held }
    @Published private(set) var captureHandoverPhase = "legacy"
    private(set) var captureHandoverDiagnostic: [String: String]?
    private var captureHandover: Task<Void, Never>?

    let model: CoreModel
    @Published private(set) var phase: Phase = .personal
    @Published private(set) var outcome = "none"
    private(set) var receipt: Receipt?
    private(set) var diagnostic: [String: String]?
    private var retirement: Task<Void, Never>?

    init(model: CoreModel) { self.model = model }

    func requestRetirement() {
        guard phase == .personal, retirement == nil else { return }
        guard model.reserveWorkspaceRetirement() else {
            outcome = "refused"
            diagnostic = Self.diagnostic("refused")
            retirement = Task { await model.recordWorkspaceRetirementRefusal(); retirement = nil }
            return
        }
        phase = .draining
        outcome = "pending"
        retirement = Task {
            let result = await model.finishWorkspaceRetirement()
            switch result {
            case .retired(let native):
                receipt = Receipt(native: native)
                phase = .retired
                outcome = "retired"
            case .refused:
                phase = .personal
                outcome = "refused"
                await model.recordWorkspaceRetirementRefusal()
            case .unavailable:
                phase = .unavailable
                outcome = "pending"
            }
            diagnostic = Self.diagnostic(outcome)
            retirement = nil
        }
    }

    func requestReminderCaptureHandover() {
        guard captureHandover == nil else { return }
        guard model.reserveReminderCaptureHandover() else { captureHandoverPhase = "refused"; return }
        captureHandoverPhase = "preparing"
        captureHandover = Task {
            switch await model.finishReminderCaptureHandover() {
            case .confirmed:
                captureHandoverPhase = "held"
                captureHandoverDiagnostic = await NativeNotificationResponses.shared.handoverDiagnostic
            case .refused: captureHandoverPhase = "refused"
            case .held: captureHandoverPhase = "unavailable"
            }
            captureHandover = nil
        }
    }

    @Published private(set) var navigationCapturePhase = "ordinary"
    private var navigationCapture: Task<Void, Never>?
    func requestNavigationCapture() {
        guard navigationCapture == nil else { return }
        guard model.reserveNavigationCapture() else { navigationCapturePhase = "refused"; return }
        navigationCapturePhase = "preparing"
        navigationCapture = Task {
            switch await model.finishNavigationCapture() {
            case .confirmed: navigationCapturePhase = "held"
            case .refused: navigationCapturePhase = "refused"
            case .held: navigationCapturePhase = "unavailable"
            }
            navigationCapture = nil
        }
    }

    @Published private(set) var navigationReplayPhase = "idle"
    private var navigationReplay: Task<Void, Never>?
    func requestNavigationReplay() {
        guard navigationReplay == nil else { return }
        guard model.reserveNavigationReplay() else { navigationReplayPhase = "held"; return }
        navigationReplayPhase = "preparing"
        navigationReplay = Task {
            await model.finishNavigationReplay()
            navigationReplayPhase = model.navigationReplayPhase
            navigationReplay = nil
        }
    }

    enum WorkspaceState { case personal, preparing, starting, sample, resetting, returning, sampleFailed, returnFailed, held }
    @Published private(set) var state: WorkspaceState = .personal
    @Published private(set) var sample: NativeSandboxModel?
    @Published private var transition: Task<Void, Never>?
    private enum Destination { case sample, personal }
    private var destination: Destination = .sample
    private var displayInput = "{}"
    private var failedRuntime: NativeSandboxRuntime?
    private(set) var sampleActivated = false
    private(set) var sampleResetCount = 0
    var isActive: Bool { state != .personal }
    var working: Bool { transition != nil }
    var failure: Bool { state == .sampleFailed || state == .returnFailed || state == .held }
    var canReturn: Bool { !working && failedRuntime == nil && (receipt != nil || phase == .personal) }
    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    @Published private(set) var fixtureTransitionState = "step=idle"
    private var fixtureTransitionStep = "idle"
    var fixtureTransitionEnabled: Bool {
        guard NativeAppLaunch.arguments.filter({ $0 == "--native-ui-test-library" }).count == 1,
              let selection = try? NativeAppLaunch.selection.get(), case .isolated = selection else { return false }
        return true
    }
    private func recordTransitionFixture(_ step: String? = nil, failure: Error? = nil) {
        guard fixtureTransitionEnabled else { return }
        if let step { fixtureTransitionStep = step }
        let code: String
        switch failure {
        case nil: code = "none"
        case is CancellationError: code = "cancelled"
        case let value as NativeSandboxRuntimeError:
            switch value {
            case .closed: code = "closed"
            case .notReady: code = "not-ready"
            case .invalidInput: code = "invalid-input"
            case .unavailable: code = "unavailable"
            case .busy: code = "busy"
            case .core(let value, _):
                code = ["INVALID_INPUT", "NOT_READY", "SAVE_FAILED", "CANCELLED"].contains(value) ? "core-" + value : "core-other"
            }
        default: code = "other"
        }
        fixtureTransitionState = "step=\(fixtureTransitionStep)|failure=\(code)|session=\(state)|retirement=\(phase.rawValue):\(outcome)|receipt=\(receipt != nil)|\(model.sandboxPreparationFixtureDiagnostic)"
    }
    #endif

    func enter() {
        guard state == .personal, transition == nil, model.sandboxEntryEnabled else { return }
        do { displayInput = try model.sandboxDisplayInput() }
        catch { return }
        destination = .sample; state = .preparing
        runTransition()
    }
    func reset() {
        guard state == .sample, transition == nil else { return }
        destination = .sample; sampleResetCount += 1; state = .resetting
        runTransition()
    }
    func exit() {
        guard transition == nil else { return }
        destination = .personal; state = .returning
        runTransition()
    }
    func retryTransition() { guard failure, transition == nil else { return }; runTransition() }
    private func runTransition() {
        guard transition == nil else { return }
        transition = Task {
            defer { transition = nil }
            do {
                if let failedRuntime {
                    try await failedRuntime.closeAndDrain()
                    self.failedRuntime = nil
                }
                if let sample {
                    state = destination == .personal ? .returning : .resetting
                    try await sample.closeAndDrain()
                    self.sample = nil
                }
                if destination == .personal {
                    state = .returning
                    let restored: Bool
                    if let receipt { restored = await model.returnPersonalFromSandbox(after: receipt.native) }
                    else if phase == .personal { restored = await model.resumePersonalAfterSandboxRefusal() }
                    else { restored = false }
                    guard restored else { state = .returnFailed; return }
                    phase = .personal; receipt = nil; outcome = "none"; state = .personal
                    return
                }
                if receipt == nil {
                    state = .preparing
                    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                    recordTransitionFixture("prepare")
                    #endif
                    guard await model.prepareSandboxEntry() else {
                        state = .held
                        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                        recordTransitionFixture("prepare-refused")
                        #endif
                        return
                    }
                    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                    recordTransitionFixture("retirement")
                    #endif
                    requestRetirement()
                    await retirement?.value
                    guard phase == .retired, receipt != nil else {
                        state = .held
                        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                        recordTransitionFixture("retirement-unconfirmed")
                        #endif
                        return
                    }
                }
                state = .starting
                let runtime = NativeSandboxRuntime()
                failedRuntime = runtime
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                recordTransitionFixture("runtime-start")
                #endif
                let raw = try await runtime.start(displaySettingsJSON: displayInput)
                guard let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                      Set(value.keys) == Set(["version", "workspace", "volatile"]),
                      value["version"] as? Int == 1, value["workspace"] as? String == "sandbox", value["volatile"] as? Bool == true else {
                    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                    recordTransitionFixture("invalid-start-reply")
                    #endif
                    throw NativeSandboxRuntimeError.unavailable
                }
                failedRuntime = nil
                let sample = NativeSandboxModel(runtime: runtime, strings: model.strings)
                self.sample = sample; sampleActivated = true; state = .sample
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                recordTransitionFixture("sample-ready")
                #endif
                sample.refresh()
            } catch {
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                recordTransitionFixture(failure: error)
                #endif
                if let failedRuntime {
                    do { try await failedRuntime.closeAndDrain(); self.failedRuntime = nil }
                    catch {
                        state = .held
                        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                        recordTransitionFixture("runtime-close-unconfirmed", failure: error)
                        #endif
                        return
                    }
                }
                state = destination == .personal ? .returnFailed : .sampleFailed
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                recordTransitionFixture(failure: error)
                #endif
            }
        }
    }

    private static func diagnostic(_ outcome: String) -> [String: String] {
        ["releaseCheck": "v1.3.9/ios-sandbox-lifecycle", "operation": "retire",
         "outcome": outcome, "workspace": "personal"]
    }
}
