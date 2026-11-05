import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class SandboxAdmissionState: @unchecked Sendable {
    private let lock = NSLock()
    private var held = false, finished = false
    private var values: [NativeSandboxRuntimeTestEvent] = []
    func observe(_ event: NativeSandboxRuntimeTestEvent) -> Bool {
        lock.lock(); defer { lock.unlock() }; values.append(event)
        guard event == .admitted(.capture), !held else { return false }; held = true; return true
    }
    func finish() { lock.lock(); finished = true; lock.unlock() }
    var completed: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    var events: [NativeSandboxRuntimeTestEvent] { lock.lock(); defer { lock.unlock() }; return values }
}

/// Real packaged sample bundle in a fresh JSC context. No personal CoreHost is constructed.
final class NativeSandboxRuntimeTests: XCTestCase {
    private func runtime(start: Bool = true) async throws -> NativeSandboxRuntime {
        let runtime = NativeSandboxRuntime()
        addTeardownBlock { try? await runtime.closeAndDrain() }
        if start { _ = try await runtime.start() }
        return runtime
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func call(_ runtime: NativeSandboxRuntime, _ method: NativeSandboxMethod, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        try object(await runtime.call(method, argumentsJSON: json(input)))
    }
    private func failure(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected sample refusal", file: file, line: line) } catch {}
    }
    private func coreFailure(_ code: String, _ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected sample refusal", file: file, line: line) }
        catch NativeSandboxRuntimeError.core(let actual, _) { XCTAssertEqual(actual, code, file: file, line: line) }
        catch { XCTFail("Unexpected sample error: \(error)", file: file, line: line) }
    }
    private func window(_ runtime: NativeSandboxRuntime, _ method: NativeSandboxMethod = .inbox) async throws -> [String: Any] {
        try await call(runtime, method, ["offset": 0, "limit": 100])
    }
    private func capture(_ runtime: NativeSandboxRuntime, id: String = UUID().uuidString.lowercased(), title: String = "Volatile sample task") async throws -> String {
        let result = try await call(runtime, .capture, ["title": title, "captureId": id])
        return try XCTUnwrap(result["id"] as? String)
    }

    func testActualSampleActivationAndAllLocalReadSurfacesHaveOnlyPrimitiveCapabilities() async throws {
        let runtime = try await runtime(start: false)
        let started = try object(await runtime.start(displaySettingsJSON: #"{"language":"en","theme":"dark","appearance":{"textSize":"large"}}"#))
        XCTAssertEqual(started["version"] as? Int, 1); XCTAssertEqual(started["workspace"] as? String, "sandbox"); XCTAssertEqual(started["volatile"] as? Bool, true)
        let capability = try await runtime.inspectForTests()
        XCTAssertTrue(capability.contextPresent); XCTAssertEqual(capability.bridgeNames, ["log", "nowMs", "randomBytes"]); XCTAssertFalse(capability.personalHostPresent)
        for method in [NativeSandboxMethod.inbox, .next, .today] {
            let model = try await window(runtime, method), rows = try XCTUnwrap(model["rows"] as? [Any])
            XCTAssertFalse(rows.isEmpty)
            if method == .next { XCTAssertEqual(model["key"] as? String, "next") }
            if method == .today { XCTAssertEqual(model["key"] as? String, "schedule") }
        }
        let projects = try await call(runtime, .projects); XCTAssertFalse(projects.isEmpty)
        let id = try await capture(runtime)
        let task = try await call(runtime, .task, ["id": id]), editor = try await call(runtime, .editor, ["id": id])
        XCTAssertFalse(task.isEmpty); XCTAssertNotNil(editor["draft"])
        try await runtime.closeAndDrain()
        let closed = try await runtime.inspectForTests(); XCTAssertFalse(closed.contextPresent); XCTAssertFalse(closed.discardedReferenceAlive)
    }

    func testCaptureEditSaveCompletionAndProjectCreateRenameUseSharedMemoryWriters() async throws {
        let runtime = try await runtime(), project = try await call(runtime, .createProject, ["title": "Sample project", "areaId": NSNull(), "requestId": UUID().uuidString.lowercased()])
        let projectID = try XCTUnwrap(project["id"] as? String)
        let detail = try await call(runtime, .project, ["projectId": projectID, "offset": 0, "limit": 100]); XCTAssertFalse(detail.isEmpty)
        let options = try await call(runtime, .renameOptions, ["projectId": projectID])
        var expected = try XCTUnwrap(options["project"] as? [String: Any]); expected.removeValue(forKey: "id")
        let rename: [String: Any] = ["projectId": projectID, "title": "Renamed sample", "expected": expected, "requestId": UUID().uuidString.lowercased()]
        let renamed = try await call(runtime, .renameProject, rename), replay = try await call(runtime, .renameProject, rename)
        XCTAssertEqual(try json(renamed), try json(replay)); XCTAssertEqual(renamed["title"] as? String, "Renamed sample")
        let id = try await capture(runtime), editor = try await call(runtime, .editor, ["id": id]), draft = try XCTUnwrap(editor["draft"] as? [String: Any])
        let edited = try await call(runtime, .editDraft, ["id": id, "draft": draft, "edit": ["type": "fields", "patch": ["title": "Edited sample", "projectId": projectID]]])
        let next = try XCTUnwrap(edited["draft"] as? [String: Any])
        _ = try await call(runtime, .saveDraft, ["id": id, "base": ["title": XCTUnwrap(draft["title"]), "projectId": XCTUnwrap(draft["projectId"])],
            "patch": ["title": XCTUnwrap(next["title"]), "projectId": XCTUnwrap(next["projectId"])], "requestId": UUID().uuidString.lowercased()])
        let task = try await call(runtime, .task, ["id": id]), revision = try XCTUnwrap(task["taskRevision"] as? String)
        let completion: [String: Any] = ["id": id, "taskRevision": revision, "requestId": UUID().uuidString.lowercased()]
        let done = try await call(runtime, .complete, completion), again = try await call(runtime, .complete, completion)
        XCTAssertEqual(try json(done), try json(again))
        let final = try await call(runtime, .editor, ["id": id]); XCTAssertEqual((final["draft"] as? [String: Any])?["status"] as? String, "done")
        try await runtime.closeAndDrain()
    }

    func testExactRequestRetryAndStaleTaskAndListRevisionsRemainEnforced() async throws {
        let runtime = try await runtime(), before = try await window(runtime), id = UUID().uuidString.lowercased()
        let request: [String: Any] = ["title": "Original capture", "captureId": id]
        let saved = try await call(runtime, .capture, request), replay = try await call(runtime, .capture, request)
        XCTAssertEqual(try json(saved), try json(replay))
        await coreFailure("INVALID_INPUT") { _ = try await self.call(runtime, .capture, ["title": "Other text", "captureId": id]) }
        await coreFailure("INVALID_INPUT") { _ = try await self.call(runtime, .createProject, ["title": "Wrong action", "areaId": NSNull(), "requestId": id]) }
        await coreFailure("STALE_REVISION") { _ = try await self.call(runtime, .inbox, ["offset": 0, "limit": 100, "revision": XCTUnwrap(before["revision"])]) }
        let task = try await call(runtime, .task, ["id": id])
        let edit: [String: Any] = ["id": id, "base": ["title": "Original capture"], "patch": ["title": "Saved edit"], "requestId": UUID().uuidString.lowercased()]
        _ = try await call(runtime, .saveDraft, edit)
        await coreFailure("STALE_REVISION") { _ = try await self.call(runtime, .saveDraft, ["id": id, "base": ["title": "Original capture"], "patch": ["title": "Stale edit"], "requestId": UUID().uuidString.lowercased()]) }
        await coreFailure("STALE_REVISION") { _ = try await self.call(runtime, .complete, ["id": id, "taskRevision": XCTUnwrap(task["taskRevision"]), "requestId": UUID().uuidString.lowercased()]) }
        let current = try await window(runtime); XCTAssertEqual(current["total"] as? Int, (before["total"] as? Int).map { $0 + 1 })
        try await runtime.closeAndDrain()
    }

    func testDisplayAndLocalInputBoundariesDenyPersonalAndNonlocalCapabilities() async throws {
        for forbidden in ["boot", "sync", "fetch", "settings", "attachments", "openURL", "activate", "__proto__", "constructor", "getTaskShare"] {
            XCTAssertNil(NativeSandboxMethod(rawValue: forbidden))
        }
        for settings in [#"{"sync":{"token":"PRIVATE"}}"#, #"{"ai":{"enabled":true}}"#, #"{"appearance":{"secret":"PRIVATE"}}"#] {
            let invalid = try await runtime(start: false)
            await failure { _ = try await invalid.start(displaySettingsJSON: settings) }
            await failure { _ = try await invalid.start() }
            let inspection = try await invalid.inspectForTests(); XCTAssertFalse(inspection.contextPresent)
            try await invalid.closeAndDrain()
        }
        let runtime = try await runtime(), before = try await window(runtime)
        for raw in ["[]", "{", "{\"id\":\"one\",\"id\":\"two\"}", String(repeating: "x", count: 128 * 1024 + 1)] {
            await failure { _ = try await runtime.call(.projects, argumentsJSON: raw) }
        }
        await coreFailure("INVALID_INPUT") { _ = try await self.call(runtime, .capture, ["title": "No", "captureId": UUID().uuidString.lowercased(), "url": "https://invalid.test"]) }
        let after = try await window(runtime); XCTAssertEqual(after["total"] as? Int, before["total"] as? Int)
        try await runtime.closeAndDrain()
    }

    func testCancellationDrainsAndExactRetryCreatesAtMostOneMemoryTask() async throws {
        let runtime = try await runtime(), before = try await window(runtime), id = UUID().uuidString.lowercased()
        let arguments = try json(["title": "Cancelled or committed sample", "captureId": id])
        let admitted = expectation(description: "Real capture ticket admitted"), release = DispatchSemaphore(value: 0), state = SandboxAdmissionState()
        try await runtime.observeForTests { event in
            if state.observe(event) { admitted.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        }
        let task = Task { () async throws -> String in
            defer { state.finish() }
            return try await runtime.call(.capture, argumentsJSON: arguments)
        }
        await fulfillment(of: [admitted], timeout: 5)
        task.cancel()
        try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(state.completed)
        release.signal()
        do { _ = try await task.value; XCTFail("Admitted cancelled call must not publish success") }
        catch is CancellationError {}
        catch NativeAttachmentFileJobsError.cancelled {}
        catch { XCTFail("Unexpected cancellation result: \(error)") }
        XCTAssertTrue(state.completed); XCTAssertTrue(state.events.contains(.aborted)); XCTAssertTrue(state.events.contains(.settled))
        let first = try await runtime.call(.capture, argumentsJSON: arguments), second = try await runtime.call(.capture, argumentsJSON: arguments)
        XCTAssertEqual(first, second)
        let current = try await window(runtime), rows = try XCTUnwrap(current["rows"] as? [[String: Any]])
        XCTAssertEqual(current["total"] as? Int, (before["total"] as? Int).map { $0 + 1 }); XCTAssertEqual(rows.filter { $0["id"] as? String == id }.count, 1)
        try await runtime.closeAndDrain()
    }

    func testConcurrentCloseDrainsAdmittedCallsAndDiscardsTheOriginalContext() async throws {
        let runtime = try await runtime(), admitted = expectation(description: "Capture admitted before close")
        let release = DispatchSemaphore(value: 0), state = SandboxAdmissionState()
        try await runtime.observeForTests { event in
            if state.observe(event) { admitted.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        }
        let initial = try json(["title": "Known admitted sample", "captureId": UUID().uuidString.lowercased()])
        let accepted = Task { () async throws -> String in
            defer { state.finish() }
            return try await runtime.call(.capture, argumentsJSON: initial)
        }
        await fulfillment(of: [admitted], timeout: 5)
        let tasks = try (0..<23).map { number in
            let input = try json(["title": "Queued sample \(number)", "captureId": UUID().uuidString.lowercased()])
            return Task { try await runtime.call(.capture, argumentsJSON: input) }
        }
        let first = Task { try await runtime.closeAndDrain() }, second = Task { try await runtime.closeAndDrain() }
        let deadline = Date().addingTimeInterval(2)
        while !runtime.closingForTests, Date() < deadline { await Task.yield() }
        XCTAssertTrue(runtime.closingForTests); XCTAssertFalse(state.completed)
        release.signal()
        for task in [accepted] + tasks {
            do { _ = try await task.value }
            catch NativeSandboxRuntimeError.closed {}
            catch { XCTFail("Unexpected close race result: \(error)") }
        }
        XCTAssertTrue(state.completed); XCTAssertTrue(state.events.contains(.admitted(.capture)))
        try await first.value; try await second.value; try await runtime.closeAndDrain()
        await failure { _ = try await runtime.call(.projects) }; await failure { _ = try await runtime.start() }
        let inspection = try await runtime.inspectForTests(); XCTAssertFalse(inspection.contextPresent); XCTAssertFalse(inspection.discardedReferenceAlive)
    }

    func testResetRequiresFreshIdentityAndDiscardsAllOldEditsAndRequests() async throws {
        let original = try await runtime(), before = try await window(original), id = try await capture(original, title: "Discard on reset")
        let oldIdentity = original.identity; try await original.closeAndDrain()
        let fresh = try await runtime(), reset = try await window(fresh)
        XCTAssertNotEqual(fresh.identity, oldIdentity); XCTAssertEqual(reset["total"] as? Int, before["total"] as? Int)
        await failure { _ = try await original.call(.task, argumentsJSON: self.json(["id": id])) }
        await coreFailure("TASK_NOT_FOUND") { _ = try await self.call(fresh, .task, ["id": id]) }
        try await fresh.closeAndDrain()
        let unopened = try await runtime(start: false); try await unopened.closeAndDrain()
        await failure { _ = try await unopened.start() }
        let inspection = try await unopened.inspectForTests(); XCTAssertFalse(inspection.contextPresent)
    }

    func testSampleEditsLeavePopulatedPersonalDatabaseSettingsAndSidecarsByteExact() async throws {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/sandbox-isolation-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let personal = root.appendingPathComponent("personal.sqlite"), sqlite = try SQLiteBridge(url: personal)
        _ = try sqlite.execute("CREATE TABLE personal (id TEXT PRIMARY KEY, value TEXT)")
        _ = try sqlite.execute("INSERT INTO personal VALUES ('private','personal state must remain unchanged')"); sqlite.close()
        try Data("PRIVATE SETTINGS".utf8).write(to: root.appendingPathComponent("settings.json"))
        try Data("PRIVATE RETAINED JOURNAL".utf8).write(to: root.appendingPathComponent("personal.sqlite.pending.json"))
        func snapshot() throws -> [String: Data] {
            try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(atPath: root.path).map { name in (name, try Data(contentsOf: root.appendingPathComponent(name))) })
        }
        let before = try snapshot(), runtime = try await runtime()
        _ = try await capture(runtime); _ = try await call(runtime, .createProject, ["title": "Volatile project", "areaId": NSNull(), "requestId": UUID().uuidString.lowercased()])
        try await runtime.closeAndDrain(); XCTAssertEqual(try snapshot(), before)
        let inspection = try await runtime.inspectForTests(); XCTAssertFalse(inspection.contextPresent); XCTAssertFalse(inspection.discardedReferenceAlive)
    }
}
