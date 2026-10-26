import Combine
import Foundation
import MindwtrNativeCore

/// The first Sandbox unit retires this personal owner only. It cannot create or select a sample.
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

    let model: CoreModel
    @Published private(set) var phase: Phase = .personal
    @Published private(set) var outcome = "none"
    private(set) var receipt: Receipt?
    // A successful diagnostic is buffered: writing the retired personal log would cross its endpoint.
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

    private static func diagnostic(_ outcome: String) -> [String: String] {
        ["releaseCheck": "v1.3.8/ios-sandbox-lifecycle", "operation": "retire",
         "outcome": outcome, "workspace": "personal"]
    }
}
