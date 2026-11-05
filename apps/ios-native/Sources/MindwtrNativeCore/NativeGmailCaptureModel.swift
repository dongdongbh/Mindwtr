import Combine
import Foundation

@MainActor
public final class NativeGmailCaptureModel: ObservableObject {
    public struct Port {
        let request: (String, [String: Any]) async throws -> [String: Any]
        let lifecycle: (String) async throws -> Void
        let canCycle: () -> Bool
        let imported: () -> Void

        public init(request: @escaping (String, [String: Any]) async throws -> [String: Any],
                    lifecycle: @escaping (String) async throws -> Void,
                    canCycle: @escaping () -> Bool, imported: @escaping () -> Void) {
            self.request = request; self.lifecycle = lifecycle; self.canCycle = canCycle; self.imported = imported
        }
    }

    public struct Label: Equatable { public let id: String; public let name: String }

    private struct Failure: Error { let key: String }

    public static let interval: TimeInterval = 300
    public static let receiptsResetKey = "settings.gmailCaptureReceiptsReset"

    @Published public private(set) var bound = false
    @Published public private(set) var config: [String: Any]?
    @Published public private(set) var labels: [Label] = []
    @Published public private(set) var labelId = ""
    @Published public var pickerOpen = false
    @Published public var open = false
    @Published public private(set) var operation: String?
    @Published public private(set) var error: String?
    @Published public private(set) var notice: String?
    @Published public private(set) var receiptsReset = false
    @Published public private(set) var status: [String: Any] = [:]

    private var port: Port?
    private var portGeneration = 0
    private var settingsGeneration = 0
    private var active = false
    private var lifecycleSent: String?
    private var cycleDue = false
    private var cycleTask: Task<Void, Never>?
    private var wake: Task<Void, Never>?
    private let sleep: (TimeInterval) async throws -> Void

    public init(sleep: @escaping (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.sleep = sleep
    }

    public var pendingTask: Task<Void, Never>? { cycleTask }
    public var busy: Bool { operation != nil }
    public var connected: Bool { (config?["connected"] as? Bool) == true }
    public var available: Bool { bound && (config.map { ($0["available"] as? Bool) == true } ?? true) }
    public var enabled: Bool { (config?["enabled"] as? Bool) == true }
    public var account: String { config?["account"] as? String ?? "" }
    public var terminal: Bool { (status["terminal"] as? Bool) == true }
    public var lastPollText: String? { status["lastPollText"] as? String }
    public var lastImportCount: Int { (status["lastImportCount"] as? NSNumber)?.intValue ?? 0 }
    public var lastErrorKey: String? { status["lastErrorKey"] as? String }
    public var shownError: String? { error ?? (receiptsReset ? Self.receiptsResetKey : nil) ?? lastErrorKey }
    public var labelName: String? { labels.first(where: { $0.id == labelId })?.name }

    public func bind(_ next: Port?) {
        portGeneration += 1; settingsGeneration += 1
        cycleTask?.cancel(); cycleTask = nil
        wake?.cancel(); wake = nil
        port = next; bound = next != nil
        lifecycleSent = nil; cycleDue = false
        config = nil; labels = []; labelId = ""; pickerOpen = false
        operation = nil; error = nil; notice = nil; receiptsReset = false; status = [:]
        if active, next != nil { schedule(after: 1) }
    }

    public func setActive(_ value: Bool) {
        guard value != active else { return }
        active = value
        if value { schedule(after: 1) } else { wake?.cancel(); wake = nil; cycleDue = false; admit() }
    }

    public func admit() {
        guard cycleTask == nil, let port else { return }
        let wanted = active ? "active" : "background"
        let lifecycle = lifecycleSent != wanted && (active || lifecycleSent != nil) ? wanted : nil
        let cycle = active && cycleDue && operation == nil && port.canCycle()
        guard lifecycle != nil || cycle else { return }
        if cycle { cycleDue = false }
        let current = portGeneration
        cycleTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.portGeneration == current { self.cycleTask = nil; self.admit() } }
            do {
                if let lifecycle {
                    try await port.lifecycle(lifecycle)
                    guard self.portGeneration == current else { return }
                    self.lifecycleSent = lifecycle
                }
                guard cycle, self.active, !Task.isCancelled else { return }
                let imported = try await self.check(port, current: current)
                guard self.portGeneration == current else { return }
                self.schedule(after: imported ? 1 : Self.interval)
            } catch {
                guard self.portGeneration == current else { return }
                self.schedule(after: Self.interval)
            }
        }
    }

    private func schedule(after seconds: TimeInterval) {
        guard active, port != nil else { return }
        wake?.cancel()
        let current = portGeneration
        wake = Task { [weak self] in
            do { try await self?.sleep(seconds) } catch { return }
            guard let self, !Task.isCancelled, self.portGeneration == current else { return }
            self.wake = nil; self.cycleDue = true; self.admit()
        }
    }

    private func check(_ port: Port, current: Int) async throws -> Bool {
        _ = try await value(port, "checkNow")
        let next = try await value(port, "status") as? [String: Any] ?? [:]
        guard portGeneration == current else { return false }
        status = next
        let imported = lastImportCount > 0 && next["lastError"] is NSNull
        if imported { port.imported() }
        return imported
    }

    private func value(_ port: Port, _ name: String, _ input: [String: Any] = [:]) async throws -> Any? {
        let reply: [String: Any]
        do { reply = try await port.request(name, input) } catch { throw Failure(key: "settings.gmailCaptureFailed") }
        if let key = reply["errorKey"] as? String { throw Failure(key: key) }
        return reply["value"]
    }

    private func readLabels(_ port: Port, current: Int, next: [String: Any]) async throws {
        let raw = try await value(port, "labels") as? [[String: Any]] ?? []
        guard settingsGeneration == current else { return }
        labels = raw.compactMap { item in
            guard let id = item["id"] as? String, let name = item["name"] as? String else { return nil }
            return Label(id: id, name: name)
        }
        labelId = next["labelId"] as? String ?? labels.first(where: { $0.name == "Mindwtr" })?.id ?? ""
    }

    public func mount() async {
        guard let port, config == nil, operation == nil else { return }
        settingsGeneration += 1
        let current = settingsGeneration
        do {
            if let read = try? await value(port, "status") as? [String: Any], settingsGeneration == current { status = read }
            let next = try await value(port, "config") as? [String: Any] ?? [:]
            guard settingsGeneration == current else { return }
            let reset = try await value(port, "receiptsReset") as? Bool == true
            guard settingsGeneration == current else { return }
            config = next; receiptsReset = reset
            if (next["connected"] as? Bool) == true { try await readLabels(port, current: current, next: next) }
        } catch let failure as Failure {
            if settingsGeneration == current { error = failure.key }
        } catch {
            if settingsGeneration == current { self.error = "settings.gmailCaptureFailed" }
        }
    }

    public func leave() {
        settingsGeneration += 1
        open = false; config = nil; labels = []; labelId = ""; pickerOpen = false
        operation = nil; error = nil; notice = nil; receiptsReset = false
        admit()
    }

    public func toggle() { open.toggle() }
    public func choose(_ id: String) { labelId = id; pickerOpen = false }

    private func run(_ name: String, before: () -> Void = {}, _ work: @escaping (Port, Int) async throws -> Void) {
        guard let port, operation == nil else { return }
        settingsGeneration += 1
        let current = settingsGeneration
        operation = name; error = nil; notice = nil
        before()
        Task { [weak self] in
            guard let self else { return }
            do { try await work(port, current) }
            catch let failure as Failure { if self.settingsGeneration == current { self.error = failure.key } }
            catch { if self.settingsGeneration == current { self.error = "settings.gmailCaptureFailed" } }
            if self.settingsGeneration == current {
                if let read = try? await self.value(port, "status") as? [String: Any], self.settingsGeneration == current { self.status = read }
                self.operation = nil
                self.admit()
            }
        }
    }

    private func retireAccount() {
        if var next = config {
            next["connected"] = false; next["account"] = NSNull(); next["accountId"] = NSNull()
            next["labelId"] = NSNull(); next["enabled"] = false
            config = next
        }
        labels = []; labelId = ""; pickerOpen = false
    }

    public func connect() {
        run("connect", before: retireAccount) { [weak self] port, current in
            guard let self else { return }
            let next = try await self.value(port, "connect") as? [String: Any] ?? [:]
            guard self.settingsGeneration == current else { return }
            self.config = next
            try await self.readLabels(port, current: current, next: next)
        }
    }

    public func save() {
        let label = labelId
        run("save", before: { [weak self] in self?.config?["enabled"] = false }) { [weak self] port, current in
            guard let self else { return }
            let next = try await self.value(port, "configure", ["labelId": label, "enabled": true]) as? [String: Any] ?? [:]
            _ = try await self.value(port, "clearReceiptsReset")
            self.receiptsReset = false
            guard self.settingsGeneration == current else { return }
            self.config = next
            self.labelId = next["labelId"] as? String ?? ""
            if (next["enabled"] as? Bool) == true { self.cycleDue = true }
        }
    }

    public func disconnect() {
        run("disconnect", before: retireAccount) { [weak self] port, current in
            guard let self else { return }
            let result = try await self.value(port, "disconnect") as? [String: Any] ?? [:]
            _ = try await self.value(port, "clearReceiptsReset")
            self.receiptsReset = false
            guard self.settingsGeneration == current else { return }
            self.notice = (result["revoked"] as? Bool) == true ? "settings.gmailCaptureDisconnected" : "settings.gmailCaptureRevokeManually"
        }
    }

    public func checkNow() {
        run("check") { [weak self] port, _ in
            guard let self else { return }
            _ = try await self.check(port, current: self.portGeneration)
        }
    }
}
