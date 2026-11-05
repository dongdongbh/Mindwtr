import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWidgetCompletionHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "widget-completion-fixture"
    private let tap = Date(timeIntervalSince1970: 1_793_188_800) // 2026-10-28T12:00:00Z

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        guard let temporary = ProcessInfo.processInfo.environment["TMPDIR"], !temporary.isEmpty else {
            throw XCTSkip("Set a disk-backed TMPDIR for native widget completion tests")
        }
        root = URL(fileURLWithPath: temporary, isDirectory: true)
            .appendingPathComponent("NativeWidgetCompletionHostTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
        bundle = root.appendingPathComponent("fixed-clock-core-host.js")
        let clock = """
        (() => {
            const NativeDate = Date;
            const instant = NativeDate.parse('2026-10-30T12:00:00.000Z');
            globalThis.Date = class extends NativeDate {
                constructor(...args) { super(...(args.length ? args : [instant])); }
                static now() { return instant; }
            };
        })();
        """
        try (clock + "\n" + String(contentsOfFile: path, encoding: .utf8)).write(to: bundle, atomically: true, encoding: .utf8)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; return core
    }
    private func execute(_ sql: String, _ parameters: [Any] = []) throws -> String {
        let bridge = try SQLiteBridge(url: database); defer { bridge.close() }
        return try bridge.execute(sql, parametersJSON: json(parameters))
    }
    private func rows(_ table: String) throws -> String {
        try json(NativeJSON.jsonObject(with: Data(execute("SELECT * FROM " + table + " ORDER BY rowid").utf8)))
    }
    private func tasks() throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(rows("tasks").utf8)) as? [[String: Any]])
    }
    private func receiptCount() throws -> Int {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(rows("native_request_receipts").utf8)) as? [[String: Any]]).count
    }
    private func task(_ id: String) throws -> [String: Any] {
        try XCTUnwrap(tasks().first { $0["id"] as? String == id })
    }
    private func taskWrite(_ sql: String) -> Bool {
        sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil
    }
    private func seed(recurring: Bool = false) async throws {
        let bootstrap = host(); _ = try await bootstrap.start(); await bootstrap.close()
        let recurrence: Any = recurring ? try json(["rule": "daily", "strategy": "fluid", "seriesId": "widget-fixture-series",
                                                   "count": 3, "completedOccurrences": 0]) : NSNull()
        // Recurrence without a start defers until due; a past start plus future due belongs to canonical Next.
        _ = try execute("INSERT INTO tasks(id,title,status,contexts,tags,description,startTime,dueDate,recurrence,createdAt,updatedAt,rev,revBy,isFocusedToday,showFutureRecurrence,suppressMindwtrReminders,pushCount) VALUES (?,?,'next','[]','[]',?,?,?,?, ?,?,1,'fixture',0,0,0,0)",
            [taskID, "Synthetic widget task", "Preserve private fixture note", recurring ? "2026-10-01" as Any : NSNull(),
             recurring ? "2026-11-01" as Any : NSNull(), recurrence,
             "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"])
    }
    private func action(_ core: CoreHost) async throws -> (NativeWidgetActionStore, NativeWidgetPendingAction) {
        let snapshot = try await core.widgetNextActionSnapshot()
        guard let index = snapshot.snapshot.items.firstIndex(where: { $0.id == taskID }) else {
            let stored = try execute("SELECT id,status,startTime,dueDate,reviewAt,recurrence,isFocusedToday,deletedAt,purgedAt FROM tasks WHERE id=?", [taskID])
            let search = try await core.call("iosSearchSnapshot")
            throw HostFailure("Synthetic fixture missing from canonical Next: snapshot=" + String(snapshot.snapshot.json.prefix(4_096))
                + "; stored=" + String(stored.prefix(4_096)) + "; search=" + String(search.prefix(4_096)))
        }
        let token = try XCTUnwrap(snapshot.tokens[index])
        let selection = NativeLaunchSelection.standard(databaseURL: database, containerURL: root, namespace: NativeWidgetNextCache.namespace)
        let identifier = try await NativeSearchIndex.identifier(taskID: taskID, selection: selection)
        let store = NativeWidgetActionStore(directory: root.appendingPathComponent("NativeWidgets/Actions", isDirectory: true))
        try store.enqueue(identifier: identifier, token: token, now: tap)
        let claimed = try XCTUnwrap(store.claimReady(now: tap.addingTimeInterval(3)).first)
        XCTAssertTrue(claimed.claimed); XCTAssertEqual(claimed.createdAt, tap.timeIntervalSince1970 * 1_000)
        return (store, claimed)
    }
    private func submit(_ core: CoreHost, _ action: NativeWidgetPendingAction) async throws -> String {
        try await core.submitWidgetCompletion(action: action, lease: NativeTaskAIEditorLease(), readmit: { true })
    }
    private func assertResult(_ raw: String, _ action: NativeWidgetPendingAction, _ outcome: String,
                              file: StaticString = #filePath, line: UInt = #line) throws {
        let value = try object(raw)
        XCTAssertEqual(Set(value.keys), ["actionId", "outcome"], file: file, line: line)
        XCTAssertEqual(value["actionId"] as? String, action.id, file: file, line: line)
        XCTAssertEqual(value["outcome"] as? String, outcome, file: file, line: line)
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch {}
    }
    private func laterEdit() throws {
        _ = try execute("UPDATE tasks SET title='Later retained edit',status='next',completedAt=NULL,updatedAt='2026-10-31T12:00:00.000Z',rev=rev+1 WHERE id=?", [taskID])
    }

    func testCanonicalTapTimeAndFluidRecurrenceThroughActualClaimedOutbox() async throws {
        try await seed(recurring: true)
        let core = host(); _ = try await core.start()
        let (store, action) = try await action(core)
        try assertResult(await submit(core, action), action, "completed")
        let completed = try task(taskID)
        XCTAssertEqual(completed["status"] as? String, "done")
        XCTAssertEqual(completed["completedAt"] as? String, "2026-10-28T12:00:00.000Z")
        XCTAssertEqual(completed["description"] as? String, "Preserve private fixture note")
        let children = try tasks().filter { $0["id"] as? String != taskID }
        let child = try XCTUnwrap(children.first)
        XCTAssertEqual(children.count, 1); XCTAssertEqual(child["status"] as? String, "next")
        XCTAssertEqual(child["dueDate"] as? String, "2026-10-29")
        let recurrence = try object(XCTUnwrap(child["recurrence"] as? String))
        XCTAssertEqual(recurrence["seriesId"] as? String, "widget-fixture-series")
        XCTAssertEqual(recurrence["completedOccurrences"] as? Int, 1)
        XCTAssertEqual(try store.pendingActions().map(\.id), [action.id])
        try store.acknowledge(id: action.id); XCTAssertTrue(try store.pendingActions().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSaveFailureRetriesSameActionWithoutDuplicateTaskOrReceipt() async throws {
        try await seed(recurring: true)
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (_, action) = try await action(core), before = try rows("tasks")
        var failedCommits = 0
        faults.beforeSQL = { if $0 == "COMMIT" { failedCommits += 1; throw HostFailure("Injected widget save failure") } }
        await refused { _ = try await self.submit(core, action) }
        XCTAssertGreaterThan(failedCommits, 0); XCTAssertEqual(try rows("tasks"), before)
        XCTAssertEqual(try execute("SELECT request_id FROM native_request_receipts"), "[]")
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        faults.beforeSQL = nil
        let recovered = try await submit(core, action)
        try assertResult(recovered, action, "completed")
        let saved = try rows("tasks"), receipts = try rows("native_request_receipts")
        try assertResult(await submit(core, action), action, "completed")
        XCTAssertEqual(try rows("tasks"), saved); XCTAssertEqual(try rows("native_request_receipts"), receipts)
        XCTAssertEqual(try tasks().count, 2); XCTAssertEqual(try receiptCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdSavedReceiptSurvivesLaterTaskReopenWithoutCompletingItAgain() async throws {
        try await seed(recurring: true)
        let core = host(); _ = try await core.start()
        let (_, action) = try await action(core)
        let original = try await submit(core, action)
        await core.close(); try laterEdit()
        let before = try rows("tasks"), receipts = try rows("native_request_receipts")
        let faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
        let reopened = host(faults); _ = try await reopened.start()
        let repeated = try await submit(reopened, action)
        XCTAssertEqual(try json(object(repeated)), try json(object(original)))
        try assertResult(repeated, action, "completed")
        XCTAssertEqual(try rows("tasks"), before); XCTAssertEqual(try rows("native_request_receipts"), receipts)
        XCTAssertEqual(writes, 0); XCTAssertEqual(try task(taskID)["status"] as? String, "next")
        XCTAssertEqual(try tasks().count, 2); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPostSavePreClearJournalUsesColdReceiptProofBeforeLaterTaskState() async throws {
        try await seed(recurring: true)
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (_, action) = try await action(core)
        var journalWrites = 0
        faults.journalWrite = { journalWrites += 1; if journalWrites == 2 { throw HostFailure("Injected widget lost acknowledgment") } }
        await refused { _ = try await self.submit(core, action) }
        XCTAssertEqual(journalWrites, 2)
        XCTAssertEqual(try task(taskID)["status"] as? String, "done"); XCTAssertEqual(try tasks().count, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try receiptCount(), 1)
        await core.close(); try laterEdit()
        let before = try rows("tasks"), receipts = try rows("native_request_receipts")
        let replay = HostIOFaults(); var writes = 0
        replay.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
        let reopened = host(replay); _ = try await reopened.start()
        try assertResult(await submit(reopened, action), action, "completed")
        XCTAssertEqual(writes, 0); XCTAssertEqual(try rows("tasks"), before)
        XCTAssertEqual(try rows("native_request_receipts"), receipts)
        XCTAssertEqual(try task(taskID)["title"] as? String, "Later retained edit")
        XCTAssertEqual(try task(taskID)["status"] as? String, "next")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testChangedSourceIsDiscardedWithoutWritingAnyTask() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let (_, action) = try await action(core)
        await core.close(); try laterEdit()
        let before = try rows("tasks"), faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
        let reopened = host(faults); _ = try await reopened.start()
        try assertResult(await submit(reopened, action), action, "discarded")
        XCTAssertEqual(writes, 0); XCTAssertEqual(try rows("tasks"), before)
        XCTAssertEqual(try tasks().count, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testInvalidLeaseReadmissionAndGenericPrivateFacadesNeverCreateJournal() async throws {
        try await seed()
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (store, action) = try await action(core), before = try rows("tasks")
        var journalWrites = 0, statements = 0
        faults.journalWrite = { journalWrites += 1 }; faults.beforeSQL = { _ in statements += 1 }
        let expired = NativeTaskAIEditorLease(); expired.invalidate()
        await refused { _ = try await core.submitWidgetCompletion(action: action, lease: expired, readmit: { true }) }
        await refused { _ = try await core.submitWidgetCompletion(action: action, lease: NativeTaskAIEditorLease(), readmit: { false }) }
        for name in ["widgetCompletionSubmit", "iosWidgetCompletionPrepare", "iosWidgetCompletionValidate", "iosWidgetCompletionCommit", "iosWidgetCompletionOutcome"] {
            await refused { _ = try await core.call(name, argumentsJSON: "[\"{}\"]") }
        }
        XCTAssertEqual(statements, 0); XCTAssertEqual(journalWrites, 0)
        XCTAssertEqual(try rows("tasks"), before); XCTAssertEqual(try store.pendingActions().map(\.id), [action.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    private func productionSource(_ core: CoreHost) async throws -> NativeProductionWidgetCompletionSource {
        let snapshot = try await core.widgetNextActionSnapshot()
        let index = try XCTUnwrap(snapshot.snapshot.items.firstIndex(where: { $0.id == taskID }))
        return try NativeProductionWidgetCompletionSource(queueID: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
            taskID: taskID, token: XCTUnwrap(snapshot.tokens[index]), createdAt: tap.timeIntervalSince1970 * 1_000)
    }

    func testProductionAdapterRetainsOriginalQueueIDAndClosedRawUnicodeSource() async throws {
        let queueID = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", rawID = "\u{FEFF}e\u{301} legacy/ID ?#😀"
        let token = " " + (try json([rawID, 3, "2026-10-26T00:00:00.000Z", "next"])) + " "
        let source = try NativeProductionWidgetCompletionSource(queueID: queueID, taskID: rawID, token: token, createdAt: 100)
        XCTAssertEqual(Data(source.queueID.utf8), Data(queueID.utf8))
        XCTAssertEqual(source.receiptID, "abcdefab-cdef-4abc-8def-abcdefabcdef")
        let value = try NativeWidgetCompletionJSON.source(source.json)
        XCTAssertEqual(Set(value.keys), ["namespace", "actionId", "identifier", "token", "createdAt"])
        XCTAssertEqual(value["namespace"] as? String, "tech.dongdongbh.mindwtr")
        XCTAssertEqual(value["actionId"] as? String, source.receiptID)
        XCTAssertEqual(Data(try XCTUnwrap(value["identifier"] as? String).utf8), Data(rawID.utf8))
        XCTAssertEqual(Data(try XCTUnwrap(value["token"] as? String).utf8), Data(token.utf8))
        for invalid in [" " + queueID, queueID + "x", "{" + queueID + "}", "invalid"] {
            XCTAssertThrowsError(try NativeProductionWidgetCompletionSource(queueID: invalid, taskID: rawID, token: token, createdAt: 100))
        }
        for invalid in [-1.0, Double.nan, Double.infinity, 8_640_000_000_000_001] {
            XCTAssertThrowsError(try NativeProductionWidgetCompletionSource(queueID: queueID, taskID: rawID, token: token, createdAt: invalid))
        }
        XCTAssertThrowsError(try NativeProductionWidgetCompletionSource(queueID: queueID,
            taskID: rawID.precomposedStringWithCanonicalMapping, token: token, createdAt: 100))
        let selection = NativeLaunchSelection.standard(databaseURL: database, containerURL: root, namespace: NativeWidgetNextCache.namespace)
        let scoped = try await NativeSearchIndex.identifier(taskID: rawID, selection: selection)
        let edits: [[String: Any]] = [["extra": true], ["namespace": NativeWidgetActionStore.namespace],
            ["identifier": scoped], ["actionId": queueID], ["createdAt": true], ["namespace": "foreign.app"],
            ["token": try json([rawID, true, "updated", "next"])], ["token": try json([rawID, 3, "updated", "unknown"])]]
        for edit in edits {
            var changed = value
            changed.merge(edit) { _, new in new }
            XCTAssertThrowsError(try NativeWidgetCompletionJSON.source(json(changed)))
        }
        var dev = value
        dev["namespace"] = NativeWidgetActionStore.namespace; dev["identifier"] = scoped
        XCTAssertNoThrow(try NativeWidgetCompletionJSON.source(json(dev)))
    }

    func testProductionSourceSaveFailureThenColdReceiptNeverCompletesRecurringTaskTwice() async throws {
        try await seed(recurring: true)
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let source = try await productionSource(core), before = try rows("tasks")
        var failures = 0
        faults.beforeSQL = { if $0 == "COMMIT" { failures += 1; throw HostFailure("Injected production widget save failure") } }
        await refused { _ = try await core.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true }) }
        XCTAssertGreaterThan(failures, 0); XCTAssertEqual(try rows("tasks"), before)
        XCTAssertEqual(try receiptCount(), 0); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        faults.beforeSQL = nil
        let saved = try await core.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual(try object(saved)["actionId"] as? String, source.receiptID)
        XCTAssertEqual(try object(saved)["outcome"] as? String, "completed")
        XCTAssertEqual(try task(taskID)["completedAt"] as? String, "2026-10-28T12:00:00.000Z")
        XCTAssertEqual(try tasks().count, 2); XCTAssertEqual(try receiptCount(), 1)
        let receipt = try XCTUnwrap((NativeJSON.jsonObject(with: Data(rows("native_request_receipts").utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(receipt["request_id"] as? String, source.receiptID)
        let tuple = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(receipt["method"] as? String).utf8)) as? [Any])
        XCTAssertEqual(tuple.first as? String, "iosWidgetCompletion")
        let retained = try XCTUnwrap(tuple.last as? [String: Any])
        XCTAssertEqual(retained["namespace"] as? String, "tech.dongdongbh.mindwtr")
        XCTAssertEqual(retained["identifier"] as? String, taskID)
        await core.close(); try laterEdit()
        let tasksBefore = try rows("tasks"), receiptsBefore = try rows("native_request_receipts")
        let coldFaults = HostIOFaults(); var writes = 0
        coldFaults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
        let cold = host(coldFaults); _ = try await cold.start()
        let replay = try await cold.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual(try json(object(replay)), try json(object(saved)))
        XCTAssertEqual(writes, 0); XCTAssertEqual(try rows("tasks"), tasksBefore)
        XCTAssertEqual(try rows("native_request_receipts"), receiptsBefore)
        XCTAssertEqual(try task(taskID)["status"] as? String, "next"); XCTAssertEqual(try tasks().count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let changed = try await productionSource(cold)
        await refused { _ = try await cold.submitWidgetCompletion(source: changed, lease: NativeTaskAIEditorLease(), readmit: { true }) }
        XCTAssertEqual(try rows("tasks"), tasksBefore); XCTAssertEqual(try rows("native_request_receipts"), receiptsBefore)
    }

    func testProductionChangedTokenDiscardSurvivesColdReopenWithoutTaskWrite() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let source = try await productionSource(core)
        await core.close(); try laterEdit()
        let faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
        let changed = host(faults); _ = try await changed.start()
        let before = try rows("tasks")
        let result = try await changed.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual(try object(result)["actionId"] as? String, source.receiptID)
        XCTAssertEqual(try object(result)["outcome"] as? String, "discarded")
        XCTAssertEqual(writes, 0); XCTAssertEqual(try rows("tasks"), before); XCTAssertEqual(try receiptCount(), 1)
        await changed.close()
        let receipts = try rows("native_request_receipts"), cold = host(); _ = try await cold.start()
        let replay = try await cold.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual(try json(object(replay)), try json(object(result)))
        XCTAssertEqual(try rows("tasks"), before); XCTAssertEqual(try rows("native_request_receipts"), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testProductionOverloadRefusesExpiredLeaseReadmissionRestrictedHostAndGenericFacades() async throws {
        try await seed()
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let source = try await productionSource(core), before = try rows("tasks")
        var statements = 0, journals = 0
        faults.beforeSQL = { _ in statements += 1 }; faults.journalWrite = { journals += 1 }
        let expired = NativeTaskAIEditorLease(); expired.invalidate()
        await refused { _ = try await core.submitWidgetCompletion(source: source, lease: expired, readmit: { true }) }
        await refused { _ = try await core.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { false }) }
        let restricted = CoreHost(databaseURL: database, bundleURL: bundle, workspaceMode: .restricted)
        addTeardownBlock { await restricted.close() }
        await refused { _ = try await restricted.submitWidgetCompletion(source: source, lease: NativeTaskAIEditorLease(), readmit: { true }) }
        for method in ["widgetCompletionSubmit", "iosWidgetCompletionPrepare", "iosWidgetCompletionValidate", "iosWidgetCompletionCommit", "iosWidgetCompletionOutcome"] {
            await refused { _ = try await core.call(method, argumentsJSON: self.json([source.json])) }
        }
        XCTAssertEqual(statements, 0); XCTAssertEqual(journals, 0)
        XCTAssertEqual(try rows("tasks"), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
