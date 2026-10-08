import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

private final class AttachmentHostJobCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var jobs: NativeAttachmentFileJobs?
    func set(_ value: NativeAttachmentFileJobs) { lock.lock(); jobs = value; lock.unlock() }
    func get() -> NativeAttachmentFileJobs? { lock.lock(); defer { lock.unlock() }; return jobs }
}

final class AttachmentFileHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private let taskID = "local-attachment-task"
    private let at = "2026-10-04T12:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let fixture = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/attachment-host-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
    private func core(bundleURL: URL? = nil, faults: HostIOFaults? = nil) -> CoreHost {
        let result: CoreHost
        if let faults { result = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults) }
        else { result = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle) }
        addTeardownBlock { await result.close() }; return result
    }
    private func seed() async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks (id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'inbox','[]','[]','[]',?,?,1,'fixture',0,0,0,0)",
                            parametersJSON: json([taskID, "Retained task", at, at]))
    }
    private func owner(_ rows: [[String: Any]] = [], id: String? = nil) -> [String: Any] {
        ["kind": "task", "taskId": id ?? taskID, "attachments": rows]
    }
    private func add(_ id: String, source: URL, owner: [String: Any]? = nil) -> [String: Any] {
        ["requestId": id, "owner": owner ?? self.owner(), "source": "file",
         "picked": ["uri": source.absoluteString, "name": "private + 文.txt", "mimeType": "text/plain", "size": NSNull()]]
    }
    private func request(_ host: CoreHost, _ name: String, _ input: [String: Any]) async throws -> [String: Any] {
        try object(await host.localAttachmentRequest(name: name, requestJSON: json(input)))
    }
    private func attachment(_ id: String, uri: String) -> [String: Any] {
        ["id": id, "kind": "file", "title": "private-file", "uri": uri, "createdAt": at, "updatedAt": at, "localStatus": "available"]
    }
    private func storedAttachments() throws -> String {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let rows = try NativeJSON.jsonObject(with: Data(sql.execute("SELECT attachments FROM tasks WHERE id=?", parametersJSON: json([taskID])).utf8)) as? [[String: Any]]
        return try XCTUnwrap(rows?.first?["attachments"] as? String)
    }
    private func markerCount() throws -> Int {
        let file = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: file.path) else { return 0 }
        return try String(contentsOf: file).components(separatedBy: "v1.3.4/ios-local-attachment-host").count - 1
    }

    func testProductionLocalDraftCopyAvailabilityRemoveAndColdBytes() async throws {
        try await seed()
        let host = core(); _ = try await host.start()
        let source = cache.appendingPathComponent("private + 文.txt"), bytes = Data("local bytes".utf8)
        try bytes.write(to: source)
        let id = UUID().uuidString.lowercased(), before = try storedAttachments(), markers = try markerCount()
        let added = try await request(host, "draftAddFile", add(id, source: source))
        XCTAssertEqual(added["kind"] as? String, "saved")
        let rows = try XCTUnwrap(added["attachments"] as? [[String: Any]])
        let file = try XCTUnwrap(URL(string: XCTUnwrap(rows.first?["uri"] as? String)))
        XCTAssertEqual(file.deletingLastPathComponent().path, managed.path)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try storedAttachments(), before) // draft, not durable task mutation
        let opened = try await request(host, "openAttachment", ["owner": owner(rows), "attachmentId": id])
        XCTAssertEqual(opened["status"] as? String, "available")
        let removed = try await request(host, "draftRemove", ["owner": owner(rows), "attachmentId": id, "requestId": UUID().uuidString.lowercased()])
        let removedRows = try XCTUnwrap(removed["attachments"] as? [[String: Any]])
        XCTAssertNotNil(removedRows.first?["deletedAt"])
        XCTAssertEqual(try storedAttachments(), before)
        XCTAssertEqual(try markerCount() - markers, 3)
        await host.close()
        let cold = core(); _ = try await cold.start()
        let coldOpen = try await request(cold, "openAttachment", ["owner": owner(rows), "attachmentId": id])
        XCTAssertEqual(coldOpen["status"] as? String, "available")
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try storedAttachments(), before)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertFalse(log.contains(source.absoluteString)); XCTAssertFalse(log.contains("private + 文.txt"))
        // No AsyncStorage/Sync/AI is fabricated by the local binding.
        do { _ = try await cold.call("syncSettings"); XCTFail("Sync must remain unavailable") } catch { }
        await cold.close()
    }
    func testMissingUnreadableAndForeignLocalBytesRemainUnavailable() async throws {
        try await seed()
        let host = core(); _ = try await host.start()
        let markers = try markerCount(), before = try storedAttachments()
        let missing = attachment("missing", uri: managed.appendingPathComponent("missing.txt").absoluteString)
        let outside = root.appendingPathComponent("outside.txt"); try Data([1]).write(to: outside)
        let foreign = attachment("foreign", uri: outside.absoluteString)
        let link = cache.appendingPathComponent("unreadable")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        let unreadable = attachment("unreadable", uri: link.absoluteString)
        for item in [missing, foreign, unreadable] {
            let result = try await request(host, "openAttachment", ["owner": owner([item]), "attachmentId": item["id"]!])
            XCTAssertEqual(result["status"] as? String, "unavailable")
        }
        XCTAssertEqual(try storedAttachments(), before); XCTAssertEqual(try markerCount(), markers)
        XCTAssertEqual(try Data(contentsOf: outside), Data([1]))
        await host.close()
    }
    func testMalformedProjectNonexistentAndArchivedAdmissionCopiesNothing() async throws {
        try await seed()
        let sql = try SQLiteBridge(url: database)
        _ = try sql.execute("INSERT INTO projects(id,title,status,color,createdAt,updatedAt,rev) VALUES ('archived-local','Archived','archived','#94a3b8',?,?,1)", parametersJSON: json([at, at]))
        _ = try sql.execute("INSERT INTO tasks(id,title,status,projectId,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES ('archived-task','Archived task','next','archived-local','[]','[]','[]',?,?,1,'fixture')", parametersJSON: json([at, at])); sql.close()
        let host = core(); _ = try await host.start()
        let source = cache.appendingPathComponent("source.txt"); try Data("source".utf8).write(to: source)
        let markers = try markerCount()
        for task in ["nonexistent", "archived-task"] {
            let id = UUID().uuidString.lowercased()
            do {
                let result = try await request(host, "draftAddFile", add(id, source: source, owner: owner(id: task)))
                XCTAssertTrue(["refused", "blocked"].contains(result["kind"] as? String ?? ""))
            } catch { }
            XCTAssertFalse(FileManager.default.fileExists(atPath: managed.appendingPathComponent(id + ".txt").path))
        }
        var invalid = add(UUID().uuidString.lowercased(), source: source)
        invalid["owner"] = ["kind": "project", "projectId": "archived-local"]
        do { _ = try await request(host, "draftAddFile", invalid); XCTFail("Project owner must refuse") } catch { }
        invalid = add(UUID().uuidString.lowercased(), source: source); invalid["extra"] = true
        do { _ = try await request(host, "draftAddFile", invalid); XCTFail("Extra field must refuse") } catch { }
        invalid = add(UUID().uuidString.lowercased(), source: source)
        var picked = try XCTUnwrap(invalid["picked"] as? [String: Any]); picked["size"] = true; invalid["picked"] = picked
        do { _ = try await request(host, "draftAddFile", invalid); XCTFail("Boolean size must refuse") } catch { }
        XCTAssertEqual(try markerCount(), markers); XCTAssertEqual(try Data(contentsOf: source), Data("source".utf8))
        await host.close()
    }
    func testSharedSettlementDeletesOnlyUnreferencedManagedDraftAndRetainsLiveFile() async throws {
        try await seed()
        let host = core(); _ = try await host.start()
        let source = cache.appendingPathComponent("source.txt"); try Data([2, 3]).write(to: source)
        let id = UUID().uuidString.lowercased()
        let added = try await request(host, "draftAddFile", add(id, source: source))
        let rows = try XCTUnwrap(added["attachments"] as? [[String: Any]])
        let file = try XCTUnwrap(URL(string: XCTUnwrap(rows.first?["uri"] as? String)))
        let view = try object(await host.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        let revision = try XCTUnwrap(view["taskRevision"] as? String)
        let deleted = try await request(host, "settleTaskDraftAttachments", ["taskId": taskID, "taskRevision": revision,
                                                                          "baseline": [], "draft": rows, "committed": []])
        XCTAssertEqual(deleted["deleted"] as? Int, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        // Seed a canonical live reference and recreate the owner so keep() sees it.
        await host.close(); try Data([2, 3]).write(to: file)
        let sql = try SQLiteBridge(url: database)
        _ = try sql.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([json(rows), taskID])); sql.close()
        let cold = core(); _ = try await cold.start()
        let coldView = try object(await cold.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        let kept = try await request(cold, "settleTaskDraftAttachments", ["taskId": taskID, "taskRevision": coldView["taskRevision"]!,
                                                                       "baseline": [], "draft": rows, "committed": []])
        XCTAssertEqual(kept["deleted"] as? Int, 0); XCTAssertEqual(try Data(contentsOf: file), Data([2, 3]))
        await cold.close()
    }
    func testEnginePumpsWhileFileWorkerHeldAndCancellationDrainsBeforeClose() async throws {
        try await seed()
        let host = core(), hooks = NativeAttachmentHostHooks()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), pumped = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } } }
        hooks.pump = { if entered.wait(timeout: .now()) == .success { entered.signal(); pumped.signal() } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let source = cache.appendingPathComponent("source.txt"); try Data([9]).write(to: source)
        let id = UUID().uuidString.lowercased(), input = try json(add(id, source: source))
        let task = Task { try await host.localAttachmentRequest(name: "draftAddFile", requestJSON: input) }
        XCTAssertEqual(pumped.wait(timeout: .now() + 5), .success)
        task.cancel()
        let closed = DispatchSemaphore(value: 0)
        let closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("Old worker must retain the library lock") } catch { }
        release.signal()
        do { _ = try await task.value; XCTFail("Cancelled operation must not succeed") } catch is CancellationError { } catch { XCTFail("Expected cancellation, got fixed failure") }
        await closeTask.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.appendingPathComponent(id + ".txt").path))
        XCTAssertEqual(try markerCount(), 0)
        _ = try await replacement.start(); await replacement.close()
    }
    func testCancelledLocalRequestDoesNotPoisonNextOperation() async throws {
        try await seed()
        let host = core(), hooks = NativeAttachmentHostHooks()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let source = cache.appendingPathComponent("source.txt"); try Data([3]).write(to: source)
        let input = try json(add(UUID().uuidString.lowercased(), source: source))
        let task = Task { try await host.localAttachmentRequest(name: "draftAddFile", requestJSON: input) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success); task.cancel(); release.signal()
        do { _ = try await task.value } catch { }
        let next = try await request(host, "draftAddFile", add(UUID().uuidString.lowercased(), source: source))
        XCTAssertEqual(next["kind"] as? String, "saved")
        await host.close()
    }
    func testLateStartupJobHooksThrowWithoutReplacingExistingHooksAndLatePumpStillRuns() async throws {
        try await seed()
        let host = core(), hooks = NativeAttachmentHostHooks()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let originalPumped = DispatchSemaphore(value: 0), dynamicPumped = DispatchSemaphore(value: 0)
        var configured = 0, work = 0, holdNext = true, lateConfigured = false, latePump = false
        hooks.configureJobs = { jobs in
            configured += 1
            jobs.beforeWork = { _, _ in
                work += 1
                if holdNext { holdNext = false; entered.signal(); release.wait() }
            }
        }
        hooks.pump = { if entered.wait(timeout: .now()) == .success { entered.signal(); originalPumped.signal() } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start(); XCTAssertEqual(configured, 1)
        let invalid = NativeAttachmentHostHooks()
        invalid.configureJobs = { _ in lateConfigured = true }; invalid.pump = { latePump = true }
        do { try await host.configureAttachmentHost(invalid); XCTFail("Late startup-only hooks must throw") }
        catch { XCTAssertEqual(error.localizedDescription, "Attachment file job hooks require an unstarted host") }
        XCTAssertFalse(lateConfigured)
        let source = cache.appendingPathComponent("startup-hook.txt"), bytes = Data([7, 8, 9]); try bytes.write(to: source)
        let first = try json(add(UUID().uuidString.lowercased(), source: source))
        let cancelled = Task { try await host.localAttachmentRequest(name: "draftAddFile", requestJSON: first) }
        XCTAssertEqual(originalPumped.wait(timeout: .now() + 5), .success, "Refusal must preserve the original dynamic pump")
        cancelled.cancel(); release.signal()
        do { _ = try await cancelled.value; XCTFail("The held request must cancel") } catch {}
        XCTAssertGreaterThan(work, 0, "The original installed worker hook must run"); XCTAssertFalse(latePump)

        while entered.wait(timeout: .now()) == .success {}
        let dynamic = NativeAttachmentHostHooks()
        dynamic.pump = { if entered.wait(timeout: .now()) == .success { entered.signal(); dynamicPumped.signal() } }
        try await host.configureAttachmentHost(dynamic)
        let before = work, id = UUID().uuidString.lowercased(); holdNext = true
        let next = try json(add(id, source: source))
        let operation = Task { try await host.localAttachmentRequest(name: "draftAddFile", requestJSON: next) }
        XCTAssertEqual(dynamicPumped.wait(timeout: .now() + 5), .success, "A pump-only hook remains dynamically replaceable")
        release.signal(); let answer = try object(await operation.value)
        XCTAssertEqual(answer["kind"] as? String, "saved"); XCTAssertGreaterThan(work, before)
        XCTAssertEqual(configured, 1); XCTAssertFalse(lateConfigured); XCTAssertFalse(latePump)
        XCTAssertEqual(try Data(contentsOf: managed.appendingPathComponent(id + ".txt")), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try storedAttachments(), "[]")
        try await host.configureAttachmentHost(NativeAttachmentHostHooks()); await host.close()
    }
    func testCorruptJournalAndOptionalCapabilityFailurePreserveLibrary() async throws {
        try await seed()
        let source = cache.appendingPathComponent("retained"); try Data("retained".utf8).write(to: source)
        try Data("corrupt journal".utf8).write(to: journal)
        let host = core()
        do { _ = try await host.start(); XCTFail("Corrupt journal must fail closed") } catch { }
        do { _ = try await request(host, "openAttachment", ["owner": owner(), "attachmentId": "x"]); XCTFail("Recovery gate") } catch { }
        XCTAssertEqual(try Data(contentsOf: journal), Data("corrupt journal".utf8))
        XCTAssertEqual(try Data(contentsOf: source), Data("retained".utf8)); await host.close()
        try FileManager.default.removeItem(at: journal)
        // A malformed optional namespace disables the capability, not SQLite.
        let isolated = root.appendingPathComponent("isolated", isDirectory: true)
        try FileManager.default.createDirectory(at: isolated, withIntermediateDirectories: true)
        try Data([1]).write(to: isolated.appendingPathComponent("attachment-files"))
        let degraded = CoreHost(databaseURL: isolated.appendingPathComponent("core.sqlite"), bundleURL: bundle)
        _ = try await degraded.start()
        do { _ = try await degraded.localAttachmentRequest(name: "openAttachment", requestJSON: "{}"); XCTFail("Capability unavailable") } catch { }
        await degraded.close()
        let cold = CoreHost(databaseURL: isolated.appendingPathComponent("core.sqlite"), bundleURL: bundle)
        _ = try await cold.start(); await cold.close()
        XCTAssertEqual(try Data(contentsOf: isolated.appendingPathComponent("attachment-files")), Data([1]))
    }

    // Test-only bundle extension uses the real production polyfill/bridge. It
    // exposes no production evaluator or extra CoreHost command.
    private func probeBundle(_ expression: String) throws -> URL {
        let suffix = """
        ;(() => {
          const oldPoll = MindwtrHost.poll, replies = new Map(); let next = 1000000000;
          MindwtrHost.attachmentRequest = () => {
            const id = String(++next);
            Promise.resolve().then(async () => { \(expression) }).then(
              value => replies.set(id, JSON.stringify({ok:true,value})),
              () => replies.set(id, JSON.stringify({ok:false,error:'Probe failed'})));
            return id;
          };
          MindwtrHost.poll = id => {
            if (Number(id) > 1000000000) { const value = replies.get(id); if (!value) return null; replies.delete(id); return value; }
            return oldPoll(id);
          };
        })();
        """
        let result = root.appendingPathComponent("probe.js")
        try (String(contentsOf: bundle) + suffix).write(to: result, atomically: true, encoding: .utf8)
        return result
    }
    func testActualJSCTransportBytesInstallerObjectAndTrailingIdleAnswer() async throws {
        try await seed()
        let target = managed.appendingPathComponent("installed"), stage = cache.appendingPathComponent("stage")
        let targetJSON = try json([target.absoluteString]), stageJSON = try json([stage.absoluteString])
        let expression = """
        const file = globalThis.__mindwtrFileCall, installer = globalThis.__mindwtrInstallerCall;
        const target = \(targetJSON)[0], stage = \(stageJSON)[0];
        await file({op:'makeDirectory',uri:target.slice(0,target.lastIndexOf('/')+1)});
        const empty = new Uint8Array(0); await file({op:'writeBytes',uri:stage},empty);
        const read = await file({op:'readBytes',uri:stage});
        const sha = await file({op:'sha256'},empty);
        const result = await installer({op:'install',staged:stage,target,expected:{kind:'absent'},expectedDownloadSha256:sha});
        const hash = await installer({op:'hash',path:target});
        void file({op:'syncParent',uri:target}).then(() => globalThis.__attachmentTrailingFinished = true);
        return {empty:read.length,status:result.status,sha:hash.sha256,size:hash.size,
                syncBridge:typeof globalThis.__mindwtrNative.kvMultiGet === 'function'};
        """
        let probe = try probeBundle(expression), host = core(bundleURL: probe), hooks = NativeAttachmentHostHooks()
        let captured = AttachmentHostJobCapture()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in
            captured.set(jobs)
            jobs.beforeWork = { id, _ in if id == "7" { entered.signal(); release.wait() } }
            jobs.afterWork = { id, _ in if id == "7" { completed.signal() } }
        }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let result = try await request(host, "openAttachment", ["owner": owner(), "attachmentId": "probe"])
        XCTAssertEqual(result["empty"] as? Int, 0); XCTAssertEqual(result["status"] as? String, "installed")
        XCTAssertEqual(result["size"] as? Int, 0)
        XCTAssertEqual(result["syncBridge"] as? Bool, false)
        XCTAssertEqual(result["sha"] as? String, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(captured.get()?.counters.jobs, 1)
        release.signal(); XCTAssertEqual(completed.wait(timeout: .now() + 5), .success)
        // No subsequent CoreHost call pumps JS here. The idle pump must consume
        // the metadata and release admission after the top-level result returned.
        let deadline = Date().addingTimeInterval(5)
        while captured.get()?.counters.jobs != 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.001) }
        XCTAssertEqual(captured.get()?.counters.jobs, 0)
        await host.close()
        XCTAssertEqual(try Data(contentsOf: target), Data())
    }
    func testActualJSCRunningInstallerCancellationRetainsPublishedBytesAndLockUntilDrain() async throws {
        try await seed()
        let target = managed.appendingPathComponent("installed"), stage = cache.appendingPathComponent("stage")
        let expression = """
        const file = globalThis.__mindwtrFileCall, installer = globalThis.__mindwtrInstallerCall;
        const target = \(try json([target.absoluteString]))[0], stage = \(try json([stage.absoluteString]))[0];
        await file({op:'makeDirectory',uri:target.slice(0,target.lastIndexOf('/')+1)});
        const bytes = new Uint8Array([4,5,6]); await file({op:'writeBytes',uri:stage},bytes);
        const sha = await file({op:'sha256'},bytes);
        return await installer({op:'install',staged:stage,target,expected:{kind:'absent'},expectedDownloadSha256:sha});
        """
        let probe = try probeBundle(expression), host = core(bundleURL: probe), hooks = NativeAttachmentHostHooks()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.afterWork = { _, installer in if installer { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let input = try json(["owner": owner(), "attachmentId": "probe"])
        let task = Task { try await host.localAttachmentRequest(name: "openAttachment", requestJSON: input) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try Data(contentsOf: target), Data([4, 5, 6]))
        task.cancel()
        let closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("Installer drain must retain the old lock") } catch { }
        release.signal()
        do { _ = try await task.value; XCTFail("Pending caller was cancelled") } catch is CancellationError { } catch { XCTFail("Expected cancellation") }
        await closeTask.value
        // A completed install cannot be undone by caller cancellation. No
        // arbitrary pathname cleanup or false rollback acknowledgment occurs.
        XCTAssertEqual(try Data(contentsOf: target), Data([4, 5, 6]))
        _ = try await replacement.start(); await replacement.close()
        XCTAssertEqual(try Data(contentsOf: target), Data([4, 5, 6]))
    }
    func testActualJSCExactByteLimitAndOversizeRefusalPreservePriorBytes() async throws {
        try await seed()
        let file = cache.appendingPathComponent("exact")
        let expression = """
        const file = globalThis.__mindwtrFileCall, uri = \(try json([file.absoluteString]))[0];
        const bytes = new Uint8Array(16*1024*1024); bytes[0]=19; bytes[bytes.length-1]=23;
        await file({op:'writeBytes',uri},bytes);
        const read = await file({op:'readBytes',uri});
        let refused = false;
        try { await file({op:'writeBytes',uri},new Uint8Array(bytes.length+1)); }
        catch (error) { refused = error.message === 'Attachment file exceeds the bridge byte limit'; }
        return {length:read.length,first:read[0],last:read[read.length-1],refused};
        """
        let probe = try probeBundle(expression), host = core(bundleURL: probe)
        _ = try await host.start()
        let result = try await request(host, "openAttachment", ["owner": owner(), "attachmentId": "probe"])
        XCTAssertEqual(result["length"] as? Int, 16 * 1024 * 1024)
        XCTAssertEqual(result["first"] as? Int, 19); XCTAssertEqual(result["last"] as? Int, 23)
        XCTAssertEqual(result["refused"] as? Bool, true)
        let data = try Data(contentsOf: file)
        XCTAssertEqual(data.count, 16 * 1024 * 1024); XCTAssertEqual(data.first, 19); XCTAssertEqual(data.last, 23)
        await host.close()
    }
    func testHeldSharedBarrierRechecksReferenceRestoredByActualSaveDraft() async throws {
        try await seed()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased(), file = managed.appendingPathComponent(id + ".txt")
        let bytes = Data("keep the restored live bytes".utf8); try bytes.write(to: file)
        let row = attachment(id, uri: file.absoluteString)
        let save = try json(["id": taskID, "base": [:] as [String: Any], "patch": [:] as [String: Any],
                             "attachments": ["base": [] as [[String: Any]], "value": [row]],
                             "requestId": UUID().uuidString.lowercased()])
        let saveString = try json([save])
        // Test-only transport instrumentation forwards every request unchanged.
        // A timer invokes a valid existing production shared save method; no
        // direct store mutation or new production domain hook is introduced.
        let prefix = """
        (() => {
          const original = globalThis.__mindwtrNative.fileCall;
          let scheduled = false;
          globalThis.__mindwtrNative.fileCall = payload => {
            const ticket = original(payload);
            if (!scheduled && JSON.parse(payload).op === 'barrier') {
              scheduled = true;
              setTimeout(() => {
                const saveTicket = MindwtrHost.saveDraft(\(saveString)[0]);
                const check = () => {
                  const reply = MindwtrHost.poll(saveTicket);
                  if (reply === null) { setTimeout(check,1); return; }
                  globalThis.__attachmentRestoreSucceeded = JSON.parse(reply).ok;
                };
                check();
              },0);
            }
            return ticket;
          };
        })();
        """
        let instrumented = root.appendingPathComponent("barrier.js")
        try (prefix + String(contentsOf: bundle)).write(to: instrumented, atomically: true, encoding: .utf8)
        let host = core(bundleURL: instrumented), hooks = NativeAttachmentHostHooks()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { ticket, _ in if ticket == "2" { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let view = try object(await host.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        let input = try json(["taskId": taskID, "taskRevision": view["taskRevision"]!,
                              "baseline": [] as [[String: Any]], "draft": [row], "committed": [] as [[String: Any]]])
        let settlement = Task { try await host.localAttachmentRequest(name: "settleTaskDraftAttachments", requestJSON: input) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let deadline = Date().addingTimeInterval(5)
        while !(try storedAttachments()).contains(id) && Date() < deadline { Thread.sleep(forTimeInterval: 0.001) }
        XCTAssertTrue(try storedAttachments().contains(id)) // actual shared durable save occurred while barrier waited
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        release.signal()
        let result = try object(await settlement.value)
        XCTAssertEqual(result["deleted"] as? Int, 0)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        await host.close()
        let cold = core(); _ = try await cold.start()
        XCTAssertTrue(try storedAttachments().contains(id)); XCTAssertEqual(try Data(contentsOf: file), bytes)
        await cold.close()
    }
    func testWarmPendingAndColdFailedReplayRefuseLocalWorkAndRetainBytes() async throws {
        try await seed()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let file = managed.appendingPathComponent("retained.txt"), bytes = Data("pending recovery bytes".utf8)
        try bytes.write(to: file)
        let row = attachment("retained", uri: file.absoluteString)
        let open = try json(["owner": owner([row]), "attachmentId": "retained"])
        let faults = HostIOFaults(), warm = core(faults: faults)
        _ = try await warm.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected attachment recovery COMMIT failure") } }
        do { _ = try await warm.call("complete", argumentsJSON: json([taskID])); XCTFail("COMMIT refusal must retain journal") } catch { }
        let frozen = try Data(contentsOf: journal)
        let saved = try object(String(decoding: frozen, as: UTF8.self))
        do { _ = try await warm.localAttachmentRequest(name: "openAttachment", requestJSON: open); XCTFail("Pending warm request must refuse") } catch { }
        do { _ = try await warm.retryPending(); XCTFail("Failed replay must remain pending") } catch { }
        do { _ = try await warm.localAttachmentRequest(name: "openAttachment", requestJSON: open); XCTFail("Failed warm replay must refuse") } catch { }
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markerCount(), 0)
        await warm.close()
        let coldFaults = HostIOFaults(); coldFaults.beforeSQL = faults.beforeSQL
        let cold = core(faults: coldFaults)
        do { _ = try await cold.start(); XCTFail("Cold replay COMMIT refusal must remain unresolved") } catch { }
        do { _ = try await cold.localAttachmentRequest(name: "openAttachment", requestJSON: open); XCTFail("Failed cold replay must refuse") } catch { }
        let after = try object(String(contentsOf: journal))
        XCTAssertEqual(after["method"] as? String, saved["method"] as? String)
        XCTAssertEqual(after["argumentsJSON"] as? String, saved["argumentsJSON"] as? String)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markerCount(), 0)
        await cold.close()
        let recovered = core(); _ = try await recovered.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let available = try await recovered.localAttachmentRequest(name: "openAttachment", requestJSON: open)
        XCTAssertEqual(try object(available)["status"] as? String, "available")
        XCTAssertEqual(try markerCount(), 1)
        await recovered.close()
    }
}
