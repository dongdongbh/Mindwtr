import Foundation
import UserNotifications

public struct NativeAppIconBadgeSystem: Sendable {
    public let authorized: @Sendable () async -> Bool
    public let requestAuthorization: @Sendable () async throws -> Bool
    public let setCount: @Sendable (Int) async throws -> Void

    public init(authorized: @escaping @Sendable () async -> Bool,
                requestAuthorization: @escaping @Sendable () async throws -> Bool,
                setCount: @escaping @Sendable (Int) async throws -> Void) {
        self.authorized = authorized
        self.requestAuthorization = requestAuthorization
        self.setCount = setCount
    }

    public static let live: NativeAppIconBadgeSystem = {
        let authorized: @Sendable () async -> Bool = {
            await UNUserNotificationCenter.current().notificationSettings().badgeSetting == .enabled
        }
        return NativeAppIconBadgeSystem(authorized: authorized, requestAuthorization: {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.badge])
            return await authorized()
        }, setCount: { try await UNUserNotificationCenter.current().setBadgeCount($0) })
    }()
}

@MainActor
public final class NativeAppIconBadge {
    public enum Change: Sendable, Equatable { case enabled, disabled, denied }
    public enum Outcome: String, Sendable { case applied, denied, failed }
    public struct Publication: Sendable, Equatable {
        public let count: Int
        public let enabled: Bool
        public let result: Outcome
    }
    private struct Target: Equatable {
        let count: Int
        let enabled: Bool
        let denied: Bool
    }

    public static let legacyKey = "mindwtr:iosAppBadgeEnabled"
    public let key: String
    public private(set) var enabled: Bool
    public var report: ((Publication) -> Void)?
    private let defaults: UserDefaults
    private let system: NativeAppIconBadgeSystem
    private var generation = 0
    private var applied: Target?

    public init(selection: NativeLaunchSelection, defaults: UserDefaults, system: NativeAppIconBadgeSystem = .live) {
        self.defaults = defaults
        self.system = system
        if case let .isolated(_, _, namespace, _) = selection { key = namespace + ".notifications.appIconBadge" }
        else { key = "nativeFoundation.notifications.appIconBadge" }
        if let stored = defaults.object(forKey: key) {
            enabled = stored as? Bool ?? false
        } else if case let .production(container) = selection {
            let legacy = try? LegacyRNStorage(containerURL: container, bundleIdentifier: NativeLaunchSelection.productionNamespace)
            enabled = (try? legacy?.value(forKey: Self.legacyKey)) == "true"
        } else {
            enabled = false
        }
    }

    public func setEnabled(_ value: Bool) async throws -> Change {
        generation &+= 1
        let revision = generation
        if value {
            let allowed = try await system.requestAuthorization()
            guard revision == generation else { return enabled ? .enabled : .disabled }
            guard allowed else {
                store(false)
                await apply(Target(count: 0, enabled: false, denied: true), revision: revision)
                return .denied
            }
            store(true)
            return .enabled
        }
        store(false)
        await apply(Target(count: 0, enabled: false, denied: false), revision: revision)
        return .disabled
    }

    public func publish(count: () async throws -> Int) async {
        let revision = generation
        let allowed = await system.authorized()
        guard revision == generation else { return }
        guard enabled else {
            if allowed { await apply(Target(count: 0, enabled: false, denied: false), revision: revision) }
            return
        }
        guard allowed else {
            await apply(Target(count: 0, enabled: false, denied: true), revision: revision)
            return
        }
        guard let value = try? await count(), value >= 0, revision == generation, enabled else { return }
        await apply(Target(count: value, enabled: true, denied: false), revision: revision)
    }

    public func clear() async {
        generation &+= 1
        await apply(Target(count: 0, enabled: enabled, denied: false), revision: generation)
    }

    private func store(_ value: Bool) {
        defaults.set(value, forKey: key)
        enabled = value
        applied = nil
    }

    private func apply(_ target: Target, revision: Int) async {
        guard applied != target, revision == generation else { return }
        applied = target
        do {
            try await system.setCount(target.count)
            report?(Publication(count: target.count, enabled: target.enabled, result: target.denied ? .denied : .applied))
        } catch {
            report?(Publication(count: target.count, enabled: target.enabled, result: .failed))
        }
    }
}
