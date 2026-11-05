import Foundation

@MainActor
public protocol NativeQuickCaptureIntentTarget: AnyObject {
    func requestQuickCaptureIntent()
}

@MainActor
public final class NativeQuickCaptureRequests {
    public static let shared = NativeQuickCaptureRequests()

    public struct Claim: Equatable, Sendable {
        fileprivate let request: UUID
        fileprivate let registration: UUID
    }

    private weak var target: (any NativeQuickCaptureIntentTarget)?
    private var registration = UUID()
    private var pending: UUID?

    public init() {}
    public var isPending: Bool { pending != nil }

    public func request() {
        if pending == nil { pending = UUID() }
        target?.requestQuickCaptureIntent()
    }

    public func register(_ target: any NativeQuickCaptureIntentTarget) {
        if self.target !== target {
            registration = UUID()
            self.target = target
        }
        if pending != nil { target.requestQuickCaptureIntent() }
    }

    public func unregister(_ target: any NativeQuickCaptureIntentTarget) {
        guard self.target === target else { return }
        self.target = nil
        registration = UUID()
    }

    public func claim(for target: any NativeQuickCaptureIntentTarget) -> Claim? {
        guard self.target === target, let pending else { return nil }
        return Claim(request: pending, registration: registration)
    }

    public func isCurrent(_ claim: Claim, for target: any NativeQuickCaptureIntentTarget) -> Bool {
        self.target === target && pending == claim.request && registration == claim.registration
    }

    @discardableResult
    public func confirm(_ claim: Claim, for target: any NativeQuickCaptureIntentTarget) -> Bool {
        guard isCurrent(claim, for: target) else { return false }
        pending = nil
        return true
    }
}
