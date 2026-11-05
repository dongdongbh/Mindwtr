import CoreFoundation
import Foundation
import JavaScriptCore
import Security

public enum NativeSandboxMethod: String, CaseIterable, Sendable {
    case inbox, next, today, projects, project, task, editor, editDraft, saveDraft, capture, complete
    case createProject, renameOptions, renameProject
}

public enum NativeSandboxRuntimeError: LocalizedError, Sendable, Equatable {
    case closed, notReady, invalidInput, unavailable, busy
    case core(code: String, message: String)
    public var errorDescription: String? {
        switch self {
        case .closed: return "The sample workspace is closed"
        case .notReady: return "The sample workspace is not ready"
        case .invalidInput: return "Invalid sample input"
        case .unavailable: return "The sample workspace is unavailable"
        case .busy: return "The sample workspace is busy"
        case .core(_, let message): return message
        }
    }
}

public final class NativeSandboxRuntime: @unchecked Sendable {
    public let identity = UUID()
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.native-sandbox", qos: .userInitiated)
    private let engine = SandboxEngine()
    private let lock = NSLock()
    private var closing: Task<Void, Error>?

    public init() {}

    public func start(displaySettingsJSON: String = "{}") async throws -> String {
        try await run(.start(displaySettingsJSON))
    }
    public func call(_ method: NativeSandboxMethod, argumentsJSON: String = "{}") async throws -> String {
        try await run(.call(method, argumentsJSON))
    }
    public func closeAndDrain() async throws { try await closeOperation().value }

    private func existingClose() -> Task<Void, Error>? { lock.lock(); defer { lock.unlock() }; return closing }
    private func closeOperation() -> Task<Void, Error> {
        lock.lock(); defer { lock.unlock() }
        if let closing { return closing }
        let operation = Task { try await self.drainAndDiscard() }
        closing = operation; return operation
    }
    private func drainAndDiscard() async throws {
        guard let ticket = try await perform({ try $0.beginClose() }) else { return }
        while try await perform({ try $0.pollClose(ticket) }) == false { await pause() }
    }
    private func run(_ command: SandboxEngine.Command) async throws -> String {
        guard existingClose() == nil else { throw NativeSandboxRuntimeError.closed }
        let id = UUID(), cancellation = NativeAttachmentCancellation()
        if Task.isCancelled { cancellation.cancel() }
        return try await withTaskCancellationHandler {
            do {
                try await perform { try $0.submit(id, command: command, cancellation: cancellation) }
                while true {
                    let result = try await perform { engine in
                        if cancellation.isCancelled { engine.abort(id) }
                        return try engine.poll(id)
                    }
                    if let result {
                        try cancellation.check()
                        return result
                    }
                    await pause()
                }
            } catch {
                if error as? NativeSandboxRuntimeError == .closed, let closing = existingClose() { _ = try? await closing.value }
                throw error
            }
        } onCancel: {
            cancellation.cancel()
            self.queue.async { [engine = self.engine] in engine.abort(id) }
        }
    }
    private func pause() async {
        await withCheckedContinuation { continuation in queue.asyncAfter(deadline: .now() + .milliseconds(5)) { continuation.resume() } }
    }
    private func perform<T: Sendable>(_ work: @escaping @Sendable (SandboxEngine) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [engine] in
                continuation.resume(with: Result { try autoreleasepool { try work(engine) } })
            }
        }
    }
    deinit { queue.async { [engine] in engine.discard() } }

    #if DEBUG
    func inspectForTests() async throws -> NativeSandboxRuntimeInspection { try await perform { try $0.inspectForTests() } }
    func observeForTests(_ observer: @escaping @Sendable (NativeSandboxRuntimeTestEvent) -> Void) async throws {
        try await perform { $0.observerForTests = observer }
    }
    var closingForTests: Bool { existingClose() != nil }
    #endif
}

private final class SandboxEngine: @unchecked Sendable {
    enum Command: Sendable { case start(String), call(NativeSandboxMethod, String) }
    private enum Phase { case fresh, starting, ready, failed, closing, closed }
    private struct Operation { let ticket: String; let start: Bool }
    private var context: JSContext?
    private var phase = Phase.fresh
    private var operations: [UUID: Operation] = [:]
    #if DEBUG
    private weak var discardedContext: JSContext?
    var observerForTests: (@Sendable (NativeSandboxRuntimeTestEvent) -> Void)?
    #endif

    func submit(_ id: UUID, command: Command, cancellation: NativeAttachmentCancellation) throws {
        guard phase != .closing, phase != .closed else { throw NativeSandboxRuntimeError.closed }
        guard operations.count < 64 else { throw NativeSandboxRuntimeError.busy }
        try cancellation.check()
        let method: String, arguments: [Any], start: Bool
        switch command {
        case .start(let input):
            guard phase == .fresh else { throw NativeSandboxRuntimeError.notReady }
            phase = .starting; start = true; method = "start"; arguments = [input]
            do { try validateDisplay(input); try createContext() }
            catch { phase = .failed; throw error }
        case .call(let selected, let input):
            guard phase == .ready else { throw NativeSandboxRuntimeError.notReady }
            try validateObject(input, maximum: 128 * 1024)
            start = false; method = "call"; arguments = [selected.rawValue, input]
        }
        do {
            operations[id] = Operation(ticket: try invokeTicket(method, arguments: arguments), start: start)
            #if DEBUG
            if case .call(let selected, _) = command { observerForTests?(.admitted(selected)) }
            #endif
        }
        catch { if start { phase = .failed }; throw error }
    }
    func abort(_ id: UUID) {
        guard phase != .closing, phase != .closed, let operation = operations[id], let context else { return }
        context.exception = nil
        _ = context.objectForKeyedSubscript("MindwtrSandboxHost")?.invokeMethod("abort", withArguments: [operation.ticket])
        context.exception = nil
        #if DEBUG
        observerForTests?(.aborted)
        #endif
    }
    func poll(_ id: UUID) throws -> String? {
        guard phase != .closing, phase != .closed else { throw NativeSandboxRuntimeError.closed }
        guard let operation = operations[id] else { throw NativeSandboxRuntimeError.unavailable }
        guard let reply = try pollTicket(operation.ticket) else { return nil }
        operations.removeValue(forKey: id)
        #if DEBUG
        observerForTests?(.settled)
        #endif
        do {
            let result = try value(reply)
            if operation.start {
                let object = try NativeJSON.jsonObject(with: Data(result.utf8)) as? [String: Any]
                guard let object, Set(object.keys) == Set(["version", "workspace", "volatile"]),
                      integer(object["version"], equals: 1), object["workspace"] as? String == "sandbox", boolean(object["volatile"]) == true else {
                    throw NativeSandboxRuntimeError.unavailable
                }
                phase = .ready
            }
            return result
        } catch { if operation.start { phase = .failed }; throw error }
    }
    func beginClose() throws -> String? {
        guard phase != .closed else { return nil }
        phase = .closing; operations.removeAll()
        guard context != nil else { discard(); return nil }
        return try invokeTicket("close", arguments: [])
    }
    func pollClose(_ ticket: String) throws -> Bool {
        guard phase == .closing else { return phase == .closed }
        guard let reply = try pollTicket(ticket) else { return false }
        let raw = try value(reply)
        guard let object = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any], Set(object.keys) == Set(["closed"]),
              boolean(object["closed"]) == true else { throw NativeSandboxRuntimeError.unavailable }
        discard(); return true
    }
    func discard() {
        #if DEBUG
        discardedContext = context
        #endif
        context?.exception = nil; context = nil; operations.removeAll(); phase = .closed
    }

    private func createContext() throws {
        guard let sourceURL = Bundle.module.url(forResource: "sandbox-host", withExtension: "js"),
              let source = try? String(contentsOf: sourceURL, encoding: .utf8), source.utf8.count <= 32 * 1024 * 1024,
              let runtime = JSContext() else { throw NativeSandboxRuntimeError.unavailable }
        let bridge = JSValue(newObjectIn: runtime)!
        let now: @convention(block) () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
        let log: @convention(block) (String) -> Void = { _ in }
        let random: @convention(block) (Double) -> String = { count in
            guard count.isFinite, count.rounded() == count, (0...65536).contains(count) else { return "!MindwtrNativeError:Invalid entropy count" }
            let length = Int(count)
            if length == 0 { return "[]" }
            var bytes = [UInt8](repeating: 0, count: length)
            guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }) == errSecSuccess,
                  let encoded = try? JSONEncoder().encode(bytes) else { return "!MindwtrNativeError:Entropy unavailable" }
            return String(decoding: encoded, as: UTF8.self)
        }
        bridge.setObject(now, forKeyedSubscript: "nowMs" as NSString)
        bridge.setObject(log, forKeyedSubscript: "log" as NSString)
        bridge.setObject(random, forKeyedSubscript: "randomBytes" as NSString)
        runtime.setObject(bridge, forKeyedSubscript: "__mindwtrNative" as NSString)
        runtime.evaluateScript("Object.freeze(globalThis.__mindwtrNative);")
        guard runtime.exception == nil else { throw NativeSandboxRuntimeError.unavailable }
        runtime.evaluateScript(source, withSourceURL: sourceURL)
        guard runtime.exception == nil, let host = runtime.objectForKeyedSubscript("MindwtrSandboxHost"), !host.isUndefined, !host.isNull else {
            runtime.exception = nil; throw NativeSandboxRuntimeError.unavailable
        }
        context = runtime
    }
    private func invokeTicket(_ method: String, arguments: [Any]) throws -> String {
        guard let context else { throw NativeSandboxRuntimeError.unavailable }
        context.exception = nil
        let result = context.objectForKeyedSubscript("MindwtrSandboxHost")?.invokeMethod(method, withArguments: arguments)
        guard context.exception == nil, let result, result.isString, let ticket = result.toString(),
              ticket.utf8.count <= 32, let number = UInt64(ticket), number > 0, String(number) == ticket else {
            context.exception = nil; throw NativeSandboxRuntimeError.unavailable
        }
        return ticket
    }
    private func pollTicket(_ ticket: String) throws -> String? {
        guard let context else { throw NativeSandboxRuntimeError.unavailable }
        context.exception = nil
        _ = context.objectForKeyedSubscript("__pumpTimers")?.call(withArguments: [])
        guard context.exception == nil else { context.exception = nil; throw NativeSandboxRuntimeError.unavailable }
        let reply = context.objectForKeyedSubscript("MindwtrSandboxHost")?.invokeMethod("poll", withArguments: [ticket])
        guard context.exception == nil else { context.exception = nil; throw NativeSandboxRuntimeError.unavailable }
        guard let reply else { throw NativeSandboxRuntimeError.unavailable }
        if reply.isNull || reply.isUndefined { return nil }
        guard reply.isString, let result = reply.toString(), result.utf16.count <= 1024 * 1024,
              result.utf8.count <= 4 * 1024 * 1024, try NativeJSON.hasUniqueObjectKeys(result) else { throw NativeSandboxRuntimeError.unavailable }
        return result
    }
    private func value(_ reply: String) throws -> String {
        guard let envelope = try NativeJSON.jsonObject(with: Data(reply.utf8)) as? [String: Any], let ok = boolean(envelope["ok"]) else { throw NativeSandboxRuntimeError.unavailable }
        if !ok {
            guard Set(envelope.keys) == Set(["ok", "error"]), let error = envelope["error"] as? [String: Any], Set(error.keys) == Set(["code", "message"]),
                  let code = error["code"] as? String, !code.isEmpty, code.utf16.count <= 64,
                  let message = error["message"] as? String, message.utf16.count <= 4096 else { throw NativeSandboxRuntimeError.unavailable }
            if code == "CANCELLED" { throw CancellationError() }
            throw NativeSandboxRuntimeError.core(code: code, message: message)
        }
        guard Set(envelope.keys) == Set(["ok", "value"]), let value = envelope["value"] else { throw NativeSandboxRuntimeError.unavailable }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), as: UTF8.self)
    }
    private func validateObject(_ raw: String, maximum: Int) throws {
        guard raw.utf16.count <= maximum, raw.utf8.count <= maximum * 4, try NativeJSON.hasUniqueObjectKeys(raw),
              try NativeJSON.jsonObject(with: Data(raw.utf8)) is [String: Any] else { throw NativeSandboxRuntimeError.invalidInput }
    }
    private func validateDisplay(_ raw: String) throws {
        try validateObject(raw, maximum: 4096)
        let object = try NativeJSON.jsonObject(with: Data(raw.utf8)) as! [String: Any]
        guard Set(object.keys).isSubset(of: Set(["language", "theme", "dateFormat", "calendarSystem", "timeFormat", "appearance"])) else { throw NativeSandboxRuntimeError.invalidInput }
        if let appearance = object["appearance"] {
            guard let appearance = appearance as? [String: Any], Set(appearance.keys).isSubset(of: Set(["density", "textSize", "showTaskAge", "showFutureStarts"])) else { throw NativeSandboxRuntimeError.invalidInput }
        }
    }
    private func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }; return number.boolValue
    }
    private func integer(_ value: Any?, equals expected: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }; return number.doubleValue == Double(expected)
    }

    #if DEBUG
    func inspectForTests() throws -> NativeSandboxRuntimeInspection {
        guard let context else { return .init(contextPresent: false, discardedReferenceAlive: discardedContext != nil, bridgeNames: [], personalHostPresent: false) }
        let raw = context.evaluateScript("JSON.stringify({bridge:Object.keys(globalThis.__mindwtrNative).sort(),personal:typeof globalThis.MindwtrHost!=='undefined'})")?.toString()
        guard context.exception == nil, let raw, let object = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              let names = object["bridge"] as? [String], let personal = object["personal"] as? Bool else { throw NativeSandboxRuntimeError.unavailable }
        return .init(contextPresent: true, discardedReferenceAlive: discardedContext != nil, bridgeNames: names, personalHostPresent: personal)
    }
    #endif
}

#if DEBUG
enum NativeSandboxRuntimeTestEvent: Sendable, Equatable {
    case admitted(NativeSandboxMethod), aborted, settled
}
struct NativeSandboxRuntimeInspection: Sendable {
    let contextPresent: Bool, discardedReferenceAlive: Bool
    let bridgeNames: [String]
    let personalHostPresent: Bool
}
#endif
