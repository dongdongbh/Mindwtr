import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class ForegroundCleanupJobs: @unchecked Sendable {
    private let lock = NSLock()
    private var value: NativeAttachmentFileJobs?
    private var count = 0
    func set(_ jobs: NativeAttachmentFileJobs) { lock.lock(); value = jobs; lock.unlock() }
    func record() { lock.lock(); count += 1; lock.unlock() }
    var submitted: Int { lock.lock(); defer { lock.unlock() }; return count }
    var jobs: NativeAttachmentFileJobs? { lock.lock(); defer { lock.unlock() }; return value }
}

final class NativeForegroundCleanupTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let at = "2026-10-06T12:00:00.000Z"
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let bytes = Data("Synthetic foreground cleanup generation".utf8)
    private let cleanupFailure = "Attachment cleanup could not be confirmed; retry the retained request"
    private let foregroundFailure = "Foreground sync could not be confirmed"
    private var marker: String { "!MindwtrNativeError:" + cleanupFailure }
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build the production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured foreground cleanup bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeForegroundCleanupTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Foreground cleanup fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func core(faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func attachment(id: String, uri: String, deleted: Bool) -> [String: Any] {
        var row: [String: Any] = ["id": id, "kind": "file", "uri": uri, "title": "Private synthetic foreground title",
            "localStatus": "available", "createdAt": at, "updatedAt": at]
        if deleted { row["deletedAt"] = at }; return row
    }
    private func insertTask(id: String, attachments: [[String: Any]]) throws {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Synthetic foreground task','inbox','[]','[]',?,?,?,1,'fixture',0,0,0,0)",
            parametersJSON: json([id, try json(attachments), at, at]))
    }
    private func seed() async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        try insertTask(id: taskID, attachments: [attachment(id: attachmentID, uri: target.absoluteString, deleted: true)])
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try bytes.write(to: target)
    }
    private func request(attachment: String? = nil, target: URL? = nil) throws -> String {
        try json(["version": 1, "requestID": UUID().uuidString.lowercased(), "attachmentID": attachment ?? attachmentID,
                  "targetURI": (target ?? self.target).absoluteString])
    }
    private func input(_ requests: [String], mode: String = "cleanup", extra: [String: Any] = [:]) throws -> String {
        var row = extra; row["mode"] = mode; row["requests"] = requests; return try json(row)
    }
    private func configured(_ value: CoreHost, counter: ForegroundCleanupJobs) async throws {
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
        try await value.configureAttachmentHost(hooks)
    }
    private func assertFailure(_ expected: String, _ work: () async throws -> String,
                               file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await work(); XCTFail("Foreground authority must refuse", file: file, line: line) }
        catch { XCTAssertEqual(error.localizedDescription, expected, file: file, line: line) }
    }
    private func assertReply(_ reply: Any, input: String, outcome: String,
                             file: StaticString = #filePath, line: UInt = #line) throws {
        let row = try XCTUnwrap(reply as? [String: Any], file: file, line: line), request = try object(input)
        XCTAssertEqual(Set(row.keys), Set(["version", "requestID", "outcome"]), file: file, line: line)
        XCTAssertEqual(row["version"] as? Int, 1, file: file, line: line)
        XCTAssertEqual(row["requestID"] as? String, request["requestID"] as? String, file: file, line: line)
        XCTAssertEqual(row["outcome"] as? String, outcome, file: file, line: line)
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func markers() throws -> [[String: Any]] {
        let file = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
            .filter { $0.contains("v1.3.5/ios-cleanup-owned-retirement") }.map { try object(String($0)) }
    }

    // Only the supplied test bundle is extended. All cleanup preparation,
    // retirement, native binding and file jobs remain the production paths.
    private func probeBundle(absent: Bool = false) throws -> URL {
        let suffix = """
        ;(() => {
          const host = MindwtrHost, oldPoll = host.poll, oldMenu = host.menuRead;
          const oldAck = host.attachmentDraftAcknowledged, oldPrepare = host.attachmentCleanupPrepare;
          const replies = new Map(), callbacks = [], acknowledgements = [];
          let next = 1000000000, phase = 'idle', last = null, reenter = false, current = null, currentRequest = null;
          const marker = '!' + 'MindwtrNativeError:' + 'Attachment cleanup could not be confirmed; retry the retained request';
          const submit = work => {
            const id = String(++next);
            Promise.resolve().then(work).then(value => replies.set(id, JSON.stringify({ok:true,value})),
              () => replies.set(id, JSON.stringify({ok:false,error:'Private foreground probe failed'})));
            return id;
          };
          host.poll = id => {
            if (Number(id) > 1000000000) {
              const value = replies.get(id); if (!value) return null; replies.delete(id); return value;
            }
            return oldPoll(id);
          };
          host.attachmentDraftAcknowledged = (operation, outcome) => {
            if (operation === 'cleanup-owned-retirement') acknowledgements.push({phase,operation,outcome});
            return oldAck(operation, outcome);
          };
          host.attachmentCleanupPrepare = (projection, candidate) => {
            if (reenter) { reenter = false; last.reentrant = current(currentRequest); }
            return oldPrepare(projection, candidate);
          };
          host.iosForegroundSync = (command, json, cleanup) => submit(async () => {
            const input = JSON.parse(json), previous = callbacks[callbacks.length - 1];
            callbacks.push(cleanup); phase = 'callback'; current = cleanup; last = {command,results:[]};
            if (input.mode === 'throwSecret') throw new Error(input.secret);
            if (input.mode === 'old') last.old = previous(input.requests[0]);
            else if (input.mode !== 'noop') {
              for (const request of input.requests) {
                currentRequest = request; reenter = input.mode === 'reentrant';
                const value = cleanup(request);
                if (value === marker) {
                  const n = __mindwtrNative, uri = JSON.parse(request).targetURI;
                  const refused = [n.sqlRun("UPDATE tasks SET title='Forbidden foreground mutation'",'[]'),
                    n.sqlExec("UPDATE tasks SET title='Forbidden foreground mutation'"),n.sqlAll('SELECT id FROM tasks','[]'),
                    n.fileCall(JSON.stringify({op:'readBytes',uri})),n.fileDeleteNow(uri),n.installerCall('{}'),
                    n.ioNext(),n.ioBody(),typeof n.kvMultiGet === 'function' ? n.kvMultiGet('[]') : marker,
                    n.netFetch('{}'),n.secretCall('{}'),n.cryptoCall('{}')];
                  last.deviceStoragePresent = typeof n.kvMultiGet === 'function';
                  last.refused = refused.map(answer => typeof answer === 'string' && answer.startsWith('!MindwtrNativeError:'));
                  last.failure = value; phase = 'failed'; throw new Error(value);
                }
                last.results.push(JSON.parse(value));
              }
            }
            phase = 'awaiting'; await new Promise(resolve => setTimeout(resolve, 5));
            phase = 'finished'; return last;
          });
          host.menuRead = (name, params) => name !== 'dataSettings' ? oldMenu(name, params) : submit(() => {
            const latest = callbacks[callbacks.length - 1];
            return {phase,last,acknowledgements,late: latest && currentRequest ? latest(currentRequest) : null};
          });
          \(absent ? "delete host.iosForegroundSync;" : "")
        })();
        """
        let result = root.appendingPathComponent(absent ? "absent.js" : "probe.js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: result, atomically: true, encoding: .utf8)
        return result
    }
    private func probeState(_ value: CoreHost) async throws -> [String: Any] {
        try object(await value.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }

    func testSelectedCleanupInsideOuterInvocationDefersAcknowledgementAndInvalidatesRetainedCallback() async throws {
        try await seed(); let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start()
        let before = try rows(), selected = try request()
        let result = try object(await value.foregroundSync(command: "syncNow", requestJSON: input([selected])))
        let replies = try XCTUnwrap(result["results"] as? [Any]); XCTAssertEqual(replies.count, 1)
        try assertReply(try XCTUnwrap(replies.first), input: selected, outcome: "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(counter.submitted, 2); XCTAssertEqual(try rows(), before)
        let state = try await probeState(value), acknowledgements = try XCTUnwrap(state["acknowledgements"] as? [[String: String]])
        XCTAssertEqual(acknowledgements, [["phase": "finished", "operation": "cleanup-owned-retirement", "outcome": "removed"]])
        XCTAssertEqual(state["late"] as? String, marker); XCTAssertEqual(counter.submitted, 2)
        let replacement = Data("Replacement outside the completed scope".utf8); try replacement.write(to: target)
        let old = try object(await value.foregroundSync(command: "syncNow", requestJSON: input([selected], mode: "old")))
        XCTAssertEqual(old["old"] as? String, marker); XCTAssertEqual(try Data(contentsOf: target), replacement)
        XCTAssertEqual(counter.submitted, 2); XCTAssertEqual(try rows(), before); await value.close()
        XCTAssertEqual(try markers().count, 1)
    }

    func testSequentialSelectionsReuseOneOuterScopeAndOneFinalAcknowledgement() async throws {
        try await seed()
        let otherID = UUID().uuidString.lowercased(), otherFile = managed.appendingPathComponent(otherID + ".txt")
        try insertTask(id: UUID().uuidString.lowercased(), attachments: [attachment(id: otherID, uri: otherFile.absoluteString, deleted: true)])
        try bytes.write(to: otherFile)
        let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start()
        let before = try rows(), inputs = [try request(), try request(attachment: otherID, target: otherFile)]
        let result = try object(await value.foregroundSync(command: "syncNow", requestJSON: input(inputs)))
        let replies = try XCTUnwrap(result["results"] as? [Any]); XCTAssertEqual(replies.count, 2)
        for (reply, selected) in zip(replies, inputs) { try assertReply(reply, input: selected, outcome: "removed") }
        XCTAssertEqual(counter.submitted, 4); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: otherFile.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let state = try await probeState(value), acknowledgements = try XCTUnwrap(state["acknowledgements"] as? [[String: String]])
        XCTAssertEqual(acknowledgements, [["phase": "finished", "operation": "cleanup-owned-retirement", "outcome": "removed"]])
        XCTAssertEqual(try rows(), before); await value.close()
    }

    func testLiveReferenceControlRetainsBytesWithoutJournalOrFileJob() async throws {
        try await seed()
        try insertTask(id: UUID().uuidString.lowercased(), attachments: [attachment(id: UUID().uuidString.lowercased(), uri: target.absoluteString, deleted: false)])
        let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start()
        let before = try rows(), selected = try request()
        let result = try object(await value.foregroundSync(command: "syncNow", requestJSON: input([selected])))
        try assertReply(try XCTUnwrap((result["results"] as? [Any])?.first), input: selected, outcome: "retained")
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(counter.submitted, 0); XCTAssertEqual(try rows(), before)
        let state = try await probeState(value); XCTAssertEqual((state["acknowledgements"] as? [Any])?.count, 0)
        await value.close(); XCTAssertEqual(try markers().count, 0)
    }

    func testReentrantCallbackRefusesDuringActualPureCleanupPreparation() async throws {
        try await seed(); let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start()
        let before = try rows(), selected = try request()
        let result = try object(await value.foregroundSync(command: "syncNow", requestJSON: input([selected], mode: "reentrant")))
        XCTAssertEqual(result["reentrant"] as? String, marker)
        try assertReply(try XCTUnwrap((result["results"] as? [Any])?.first), input: selected, outcome: "removed")
        XCTAssertEqual(counter.submitted, 2); XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await value.close()
    }

    func testAfterIntentFailureFencesFurtherIOAndRetainsOriginalProofForExactRetry() async throws {
        try await seed(); let faults = HostIOFaults(); var fired = false
        faults.cleanupBoundary = { if $0 == "afterIntent" && !fired { fired = true; throw HostFailure("Synthetic foreground interruption") } }
        let value = core(faults: faults, bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start()
        let before = try rows(), selected = try request(), secret = "Synthetic secret excluded from retained cleanup"
        await assertFailure(cleanupFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: self.input([selected], extra: ["secret": secret])) }
        let frozen = try Data(contentsOf: journal), outer = try object(String(decoding: frozen, as: UTF8.self))
        let inner = try object(try XCTUnwrap(outer["argumentsJSON"] as? String))
        XCTAssertEqual(inner["requestJSON"] as? String, selected); XCTAssertNotNil(inner["proof"]); XCTAssertNotNil(inner["witnessJSON"])
        XCTAssertNil(outer["terminal"]); XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(secret))
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(counter.submitted, 1)
        await assertFailure(cleanupFailure) { try await value.foregroundSync(command: "syncSettings", requestJSON: "{}") }
        await assertFailure(cleanupFailure) { try await value.call("menuRead", argumentsJSON: self.json(["dataSettings", "{}"])) }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 0)
        // Only an exact existing cleanup retry releases the original owner.
        try assertReply(object(await value.retireAttachmentCleanup(selected)), input: selected, outcome: "removed")
        let state = try await probeState(value), last = try XCTUnwrap(state["last"] as? [String: Any])
        XCTAssertEqual(last["refused"] as? [Bool], Array(repeating: true, count: 12))
        XCTAssertEqual(last["deviceStoragePresent"] as? Bool, false, "The ordinary test host keeps device KV unbound")
        XCTAssertEqual(last["failure"] as? String, marker)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(counter.submitted, 2); XCTAssertEqual(try rows(), before); await value.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertFalse(log.contains(secret)); XCTAssertFalse(log.contains(target.absoluteString))
    }

    func testAfterIntentFailureColdRecoveryUsesOriginalCleanupOwner() async throws {
        try await seed(); let faults = HostIOFaults()
        faults.cleanupBoundary = { if $0 == "afterIntent" { throw HostFailure("Synthetic foreground interruption") } }
        let value = core(faults: faults, bundleURL: try probeBundle()); _ = try await value.start()
        let before = try rows(), selected = try request()
        await assertFailure(cleanupFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: self.input([selected])) }
        let frozen = try Data(contentsOf: journal); XCTAssertFalse(frozen.isEmpty); XCTAssertEqual(try markers().count, 0)
        await value.close()
        let cold = core(), counter = ForegroundCleanupJobs(); try await configured(cold, counter: counter); _ = try await cold.start()
        XCTAssertEqual(counter.submitted, 1, "Cold recovery retires the captured proof without a new baseline snapshot")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), before); await cold.close(); XCTAssertEqual(try markers().count, 1)
    }

    func testCancelAndCloseReachOuterTokenDrainAndRetainReplacementGeneration() async throws {
        let base = root!; defer { root = base }
        for mode in ["cancel", "close"] {
            root = base.appendingPathComponent(mode, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let reached = expectation(description: mode + " foreground retirement entered"), release = DispatchSemaphore(value: 0)
            let counter = ForegroundCleanupJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in
                counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() }
                jobs.beforeRetirementUnlink = {
                    reached.fulfill()
                    guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Foreground fixture barrier timed out") }
                }
            }
            let value = core(bundleURL: try probeBundle()); try await value.configureAttachmentHost(hooks); _ = try await value.start()
            let before = try rows(), selected = try request(), outer = try input([selected])
            let operation = Task { try await value.foregroundSync(command: "syncNow", requestJSON: outer) }
            defer { release.signal() }; await fulfillment(of: [reached], timeout: 10)
            var closing: Task<Void, Never>?
            if mode == "cancel" { operation.cancel() }
            else {
                let closeStarted = expectation(description: "Foreground close entered")
                closing = Task { closeStarted.fulfill(); await value.close() }
                await fulfillment(of: [closeStarted], timeout: 2)
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            let replacementHost = core()
            do { _ = try await replacementHost.start(); XCTFail("The in-flight owner must retain the library lock") } catch { }
            release.signal(); await assertFailure(cleanupFailure) { try await operation.value }
            if let closing { await closing.value } else { await value.close() }
            XCTAssertEqual(counter.jobs?.counters.jobs, 0); XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
            XCTAssertEqual(try rows(), before)
            let replacement = Data("Replacement after the cancelled runtime closed".utf8)
            try replacement.write(to: target, options: .atomic)
            do {
                _ = try await value.foregroundSync(command: "syncNow", requestJSON: outer)
                XCTFail("A closed host must refuse before cleanup admission")
            } catch is CancellationError {} catch { XCTFail("Expected cancellation before dispatcher admission") }
            let cold = core(); _ = try await cold.start()
            XCTAssertEqual(try Data(contentsOf: target), replacement); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertEqual(try rows(), before); await cold.close()
            XCTAssertEqual(try markers().count, 1)
        }
    }

    func testOuterAdmissionIsBoundedFixedAndDoesNotPersistSecretBearingFields() async throws {
        try await seed(); let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start(); let before = try rows()
        for (command, request) in [("unsupported", "{}"), ("syncNow", "[]"), ("syncNow", "null"), ("syncNow", "broken"),
                                   ("syncNow", try json(["secret": String(repeating: "é", count: 65_536)]))] {
            await assertFailure(foregroundFailure) { try await value.foregroundSync(command: command, requestJSON: request) }
        }
        let secret = "Synthetic password never appears in errors or journals"
        await assertFailure(foregroundFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: self.input([], mode: "throwSecret", extra: ["secret": secret])) }
        for command in ["syncSettings", "openSyncSettings", "closeSyncSettings", "selectSyncBackend", "saveSyncBackend", "syncNow", "testSyncConnection"] {
            let result = try object(await value.foregroundSync(command: command, requestJSON: input([], mode: "noop")))
            XCTAssertEqual(result["command"] as? String, command)
        }
        let exact = try input([], mode: "noop", extra: ["pad": ""]), count = 128 * 1024 - exact.utf8.count
        let bounded = try input([], mode: "noop", extra: ["pad": String(repeating: "x", count: count)])
        XCTAssertEqual(bounded.utf8.count, 128 * 1024)
        _ = try await value.foregroundSync(command: "syncNow", requestJSON: bounded)
        await assertFailure(foregroundFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: bounded + " ") }
        XCTAssertEqual(counter.submitted, 0); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
        let absent = core(bundleURL: try probeBundle(absent: true)); _ = try await absent.start()
        await assertFailure(foregroundFailure) { try await absent.foregroundSync(command: "syncNow", requestJSON: "{}") }
        XCTAssertEqual(try rows(), before); await absent.close()
        let logFile = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: logFile.path) { XCTAssertFalse(try String(contentsOf: logFile, encoding: .utf8).contains(secret)) }
    }

    func testActualEditorSidecarAndPhysicalJournalRefuseBeforeCallbackIO() async throws {
        try await seed(); let value = core(bundleURL: try probeBundle()), counter = ForegroundCleanupJobs()
        try await configured(value, counter: counter); _ = try await value.start(); let before = try rows(), outer = try input([request()])
        let pending = try json(["version": 2, "method": "complete", "argumentsJSON": json([taskID])])
        try Data(pending.utf8).write(to: journal)
        await assertFailure(foregroundFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: outer) }
        XCTAssertEqual(try Data(contentsOf: journal), Data(pending.utf8)); try FileManager.default.removeItem(at: journal)
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "",
            "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
            "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload: [String: Any] = ["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:]]
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: try json(payload))
        try await value.checkpointEditorDraft(snapshot)
        let editor = EditorDraftStore(databaseURL: database), editorBefore = try Data(contentsOf: editor.url)
        await assertFailure(foregroundFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: outer) }
        _ = try await value.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1)
        let sidecar = NativeAttachmentDraftStore(databaseURL: database), sidecarBefore = try Data(contentsOf: sidecar.url)
        await assertFailure(foregroundFailure) { try await value.foregroundSync(command: "syncNow", requestJSON: outer) }
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore); XCTAssertEqual(try Data(contentsOf: sidecar.url), sidecarBefore)
        XCTAssertEqual(counter.submitted, 0); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
    }
}
