import Foundation

public protocol NativeBackgroundSyncScheduling: AnyObject {
    func submit(identifier: String, earliestBeginDate: Date) throws
    func cancel(identifier: String)
}

public final class NativeBackgroundSync: @unchecked Sendable {
    public enum Outcome: String, Sendable { case finished, failed, expired, skipped }

    public static let identifier = "com.expo.modules.backgroundtask.processing"
    public static let interval: TimeInterval = 15 * 60
    public static let deadline: TimeInterval = 4 * 60
    static let maximumCooldown: TimeInterval = 8 * interval
    static let failureRecordName = "mindwtr:native-background-sync:failures"

    private let scheduler: NativeBackgroundSyncScheduling
    private let defaults: UserDefaults
    let now: () -> Date

    public init(scheduler: NativeBackgroundSyncScheduling, defaults: UserDefaults = .standard, now: @escaping () -> Date = { Date() }) {
        self.scheduler = scheduler
        self.defaults = defaults
        self.now = now
    }

    public static func backend(stored: String?, cloudProvider: String?, cloudKitAvailable: Bool) -> String? {
        switch stored?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "webdav": return "webdav"
        case "cloud":
            let provider = cloudProvider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return provider.isEmpty || provider == "selfhosted" ? "selfhosted" : nil
        case "cloudkit": return cloudKitAvailable ? "cloudkit" : nil
        default: return nil
        }
    }

    static func cooldown(consecutiveFailures: Int) -> TimeInterval {
        min(maximumCooldown, interval * pow(2, Double(max(1, consecutiveFailures) - 1)))
    }

    public func schedule(_ wanted: Bool) {
        if wanted { try? scheduler.submit(identifier: Self.identifier, earliestBeginDate: now().addingTimeInterval(Self.interval)) }
        else { scheduler.cancel(identifier: Self.identifier) }
    }

    public var coolingDown: Bool {
        guard let record = defaults.dictionary(forKey: Self.failureRecordName),
              let failedAt = record["failedAt"] as? Double, let failures = record["failures"] as? Int, failures > 0 else { return false }
        let waited = now().timeIntervalSince1970 - failedAt
        return waited >= 0 && waited < Self.cooldown(consecutiveFailures: failures)
    }

    func record(_ outcome: Outcome) {
        switch outcome {
        case .finished: defaults.removeObject(forKey: Self.failureRecordName)
        case .failed, .expired:
            let failures = (defaults.dictionary(forKey: Self.failureRecordName)?["failures"] as? Int) ?? 0
            defaults.set(["failedAt": now().timeIntervalSince1970, "failures": failures + 1], forKey: Self.failureRecordName)
        case .skipped: break
        }
    }

    public func begin(complete: @escaping (Bool) -> Void) -> Run { Run(owner: self, complete: complete) }

    public final class Run: @unchecked Sendable {
        private let lock = NSLock()
        private let owner: NativeBackgroundSync
        private let complete: (Bool) -> Void
        private let startedAt: Date
        private var cancelWork: (() -> Void)?
        private var ended: Outcome?
        private var wanted = true
        private var chosenBackend = "unknown"

        init(owner: NativeBackgroundSync, complete: @escaping (Bool) -> Void) {
            self.owner = owner
            self.complete = complete
            startedAt = owner.now()
        }

        public var outcome: Outcome? { lock.lock(); defer { lock.unlock() }; return ended }
        public var durationMs: Int { Int(owner.now().timeIntervalSince(startedAt) * 1_000) }

        public func unwanted() { lock.lock(); wanted = false; lock.unlock() }
        public var backend: String {
            get { lock.lock(); defer { lock.unlock() }; return chosenBackend }
            set { lock.lock(); chosenBackend = newValue; lock.unlock() }
        }

        @discardableResult
        public func onCancel(_ work: @escaping () -> Void) -> Bool {
            lock.lock()
            guard ended == nil else { lock.unlock(); work(); return false }
            cancelWork = work
            lock.unlock()
            return true
        }

        public func armDeadline(after seconds: TimeInterval, expired: @escaping () -> Void) {
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                if self?.end(.expired) == true { expired() }
            }
        }

        @discardableResult
        public func end(_ outcome: Outcome) -> Bool {
            lock.lock()
            guard ended == nil else { lock.unlock(); return false }
            ended = outcome
            let cancel = outcome == .expired ? cancelWork : nil
            cancelWork = nil
            let reschedule = wanted
            lock.unlock()
            cancel?()
            owner.record(outcome)
            owner.schedule(reschedule)
            complete(outcome != .expired)
            return true
        }
    }
}
