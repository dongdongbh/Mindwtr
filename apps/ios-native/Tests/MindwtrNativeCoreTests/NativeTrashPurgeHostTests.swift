import XCTest
@testable import MindwtrNativeCore

/// Actual JSC bundle, ordinary native journal, SQLite transaction and UUID receipt.
final class NativeTrashPurgeHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let at = "2026-10-09T12:00:00.000Z"
    private let otherAt = "2026-10-09T11:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual core-host.js bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("clock.js")
        let clock = """
        (() => { const NativeDate = Date; const at = NativeDate.parse('\(at)');
          globalThis.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [at])); }
            static now() { return at; }
          };
        })();
        """
        try (clock + "\n" + String(contentsOfFile: path, encoding: .utf8)).write(to: bundle, atomically: true, encoding: .utf8)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func assertJournalContentUnchanged(_ saved: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let before = try object(String(decoding: saved, as: UTF8.self))
        let after = try object(String(contentsOf: journal, encoding: .utf8))
        // Recovery can re-encode outer object order. The accepted arguments remain byte-exact.
        XCTAssertEqual(try json(after), try json(before), file: file, line: line)
        XCTAssertEqual(Data(try XCTUnwrap(after["argumentsJSON"] as? String).utf8),
                       Data(try XCTUnwrap(before["argumentsJSON"] as? String).utf8), file: file, line: line)
    }
    @discardableResult private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(args)).utf8)) as? [[String: Any]])
    }
    private func row(_ table: String, _ id: String) throws -> [String: Any] {
        try XCTUnwrap(rows("SELECT * FROM \(table) WHERE id = ?", [id]).first)
    }
    private func snapshot() throws -> String {
        var result: [String: Any] = [:]
        for table in ["tasks", "projects", "sections", "areas", "people", "settings", "saved_filters", "schema_migrations", "calendar_sync", "native_request_receipts"] {
            result[table] = try rows("SELECT * FROM \(table) ORDER BY rowid")
        }
        return try json(result)
    }
    private func domainWrite(_ sql: String) -> Bool {
        sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|projects|areas|people|sections|settings|saved_filters|schema_migrations|calendar_sync|native_request_receipts)\b"#, options: .regularExpression) != nil
    }
    private func failure(_ contains: String? = nil, _ work: () async throws -> Void,
                         file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) }
        catch { if let contains { XCTAssertTrue(error.localizedDescription.contains(contains), error.localizedDescription, file: file, line: line) } }
    }
    private func seed(extra: Int = 0) async throws {
        let boot = host(); _ = try await boot.start(); await boot.close()
        for (id, name) in [("area-a", "Alpha"), ("area-b", "Beta")] {
            try rows("INSERT INTO areas (id,name,orderNum,createdAt,updatedAt,rev) VALUES (?,?,0,?,?,1)", [id, name, at, at])
        }
        try rows("INSERT INTO projects (id,title,status,color,areaId,isSequential,isFocused,createdAt,updatedAt,deletedAt,rev) VALUES ('parent','Deleted parent','active','#94a3b8','area-a',0,0,?,?,?,1)", [at, at, at])
        try rows("INSERT INTO sections (id,projectId,title,orderNum,isCollapsed,createdAt,updatedAt,deletedAt,rev) VALUES ('section','parent','Section',0,0,?,?,?,1)", [at, at, at])
        for (id, status, parent, section, area, deletion) in [
            ("overlap", "done", "parent", "section", "area-a", at),
            ("cascade", "waiting", "parent", "section", "area-a", at),
            ("independent", "archived", "parent", "section", "area-a", otherAt),
            ("standalone", "reference", "", "", "area-b", at),
            ("protected", "next", "", "", "area-b", ""),
        ] {
            try rows("INSERT INTO tasks (id,title,status,projectId,sectionId,areaId,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES (?,?,?,?,?,?,'[]','[]',?,?,?,1)",
                [id, id, status, parent.isEmpty ? NSNull() : parent as Any, section.isEmpty ? NSNull() : section as Any,
                 area, at, at, deletion.isEmpty ? NSNull() : deletion as Any])
        }
        for index in 0..<extra {
            try rows("INSERT INTO tasks (id,title,status,areaId,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES (?,?,'next','area-a','[]','[]',?,?,?,1)",
                ["page-\(index)", "Page \(index)", at, at, at])
        }
    }
    private func selection(_ core: CoreHost) async throws -> [String: Any] {
        let view = try object(await core.call("menuRead", argumentsJSON: json(["trash", json(["offset": 0, "limit": 1])])))
        return try object(await core.call("trashSelection", argumentsJSON: json([json(["revision": XCTUnwrap(view["revision"])])])))
    }
    private func request(_ core: CoreHost, tasks: [String] = ["overlap", "standalone"], projects: [String] = ["parent"]) async throws -> [String: Any] {
        let selected = try await selection(core)
        let taskRevisions = try XCTUnwrap(selected["taskRevisions"] as? [String: String])
        let projectRevisions = try XCTUnwrap(selected["projectRevisions"] as? [String: String])
        return ["requestId": UUID().uuidString.lowercased(), "taskIds": tasks, "projectIds": projects,
            "taskRevisions": try Dictionary(uniqueKeysWithValues: tasks.map { ($0, try XCTUnwrap(taskRevisions[$0])) }),
            "projectRevisions": try Dictionary(uniqueKeysWithValues: projects.map { ($0, try XCTUnwrap(projectRevisions[$0])) })]
    }
    private func write(_ core: CoreHost, _ request: [String: Any]) async throws -> String {
        try await core.call("trashItemsPurgeWrite", argumentsJSON: json([json(request)]))
    }
    private func envelope() throws -> [String: Any] {
        let saved = try object(String(contentsOf: journal, encoding: .utf8))
        XCTAssertEqual(saved["method"] as? String, "trashItemsPurgeCommit")
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(saved["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(args.first))
    }
    private func assertEffect() throws {
        for id in ["overlap", "standalone"] {
            let task = try row("tasks", id)
            XCTAssertEqual(task["purgedAt"] as? String, at); XCTAssertEqual(task["deletedAt"] as? String, at)
            XCTAssertEqual(task["title"] as? String, "(deleted)"); XCTAssertEqual(task["status"] as? String, "inbox")
            XCTAssertEqual(task["rev"] as? Int, 2)
        }
        for id in ["cascade", "independent"] {
            let task = try row("tasks", id)
            XCTAssertTrue(task["purgedAt"] is NSNull); XCTAssertEqual(task["projectId"] as? String, "parent")
            XCTAssertEqual(task["rev"] as? Int, 1)
        }
        XCTAssertEqual(try row("projects", "parent")["purgedAt"] as? String, at)
        XCTAssertEqual(try row("projects", "parent")["title"] as? String, "(deleted)")
        XCTAssertEqual(try row("sections", "section")["title"] as? String, "")
    }

    func testMixedPurgeCompactsSelectedParentsAndPreservesDeletedChildren() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let request = try await request(core), protected = try json(row("tasks", "protected"))
        var sawJournal = false
        faults.beforeSQL = { sql in if sql == "COMMIT" {
            let envelope = try self.envelope(), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            XCTAssertEqual(try self.json(XCTUnwrap(envelope["request"])), try self.json(request))
            XCTAssertEqual(prepared.keys.count, 8)
            let effects = try XCTUnwrap(prepared["effect"] as? [String: Any]), pairs = try XCTUnwrap(effects["tasks"] as? [[String: Any]])
            XCTAssertEqual(pairs.filter { ($0["before"] as? [String: Any])?["id"] as? String == "overlap" }.count, 1)
            sawJournal = true
        } }
        let answer1 = try object(await write(core, request))["count"] as? Int
        XCTAssertEqual(answer1, 3)
        XCTAssertTrue(sawJournal); try assertEffect(); XCTAssertEqual(try json(row("tasks", "protected")), protected)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testRepeatedCommitFailureRetainsExactEnvelopeAndRetriesOnce() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let request = try await request(core), before = try snapshot()
        #if DEBUG
        var diagnostics: [String] = []
        faults.commandDiagnostic = { diagnostics.append($0) }
        #endif
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Task507 COMMIT") } }
        await failure("SAVE_FAILED") { _ = try await self.write(core, request) }
        let saved = try Data(contentsOf: journal), frozen = try json(envelope())
        XCTAssertEqual(try snapshot(), before)
        await failure("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(try json(envelope()), frozen); try assertJournalContentUnchanged(saved)
        XCTAssertEqual(try snapshot(), before)
        #if DEBUG
        XCTAssertTrue(diagnostics.isEmpty, "Failed COMMIT never confirms purge")
        #endif
        await failure("exact retry") { _ = try await core.call("captureOpen") }
        faults.beforeSQL = nil
        let reply = try await core.retryPending()
        XCTAssertEqual(try object(XCTUnwrap(reply))["count"] as? Int, 3); try assertEffect()
        let repeated = try await core.retryPending(); XCTAssertNil(repeated)
        #if DEBUG
        XCTAssertEqual(diagnostics, ["trashItemsPurge"], "Only exact settled retry confirms once")
        #endif
        let opened = try object(await core.call("captureOpen"))
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "After purge", "options": XCTUnwrap(opened["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])]))
        let outcome = try object(await core.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(request)])))
        XCTAssertEqual(outcome["kind"] as? String, "confirmed"); XCTAssertEqual(try json(XCTUnwrap(outcome["result"])), try json(["count": 3]))
        var unused = request; unused["requestId"] = UUID().uuidString.lowercased()
        let answer2 = try object(await core.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(unused)])))["kind"] as? String
        XCTAssertEqual(answer2, "unproven")
    }

    func testColdCompleteBeforeReplaysFrozenCommandAndReportsRecovery() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let request = try await request(writer), protected = try json(row("tasks", "protected"))
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Task507 COMMIT") } }
        await failure { _ = try await self.write(writer, request) }
        let frozen = try json(envelope()); await writer.close()
        let reopened = host(); let started = try object(await reopened.start())
        let recovery = try XCTUnwrap(started["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "trashItemsPurgeCommit")
        XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), try json(["count": 3])); try assertEffect()
        XCTAssertEqual(try json(row("tasks", "protected")), protected)
        XCTAssertFalse(frozen.isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let answer3 = try object(await reopened.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(request)])))["kind"] as? String
        XCTAssertEqual(answer3, "confirmed")
    }

    func testColdChangedMembershipRefusesWholeBatchWithoutWrites() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let request = try await request(writer)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Task507 COMMIT") } }
        await failure { _ = try await self.write(writer, request) }; await writer.close()
        try rows("INSERT INTO tasks (id,title,status,projectId,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES ('new-member','New saved member','next','parent','[]','[]',?,?,?,1)", [at, at, at])
        let before = try snapshot(), pending = try Data(contentsOf: journal)
        let replay = HostIOFaults(); var writes: [String] = []
        replay.beforeSQL = { if self.domainWrite($0) { writes.append($0) } }
        await failure("STALE_REVISION") { _ = try await self.host(replay).start() }
        XCTAssertEqual(writes, ["INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)"])
        XCTAssertEqual(try snapshot(), before); try assertJournalContentUnchanged(pending)
    }

    func testLostCommitReplyUsesReceiptAndPreservesLaterSavedEdits() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let request = try await request(writer)
        var committedReplies = 0
        // The shared save retries a one-shot lost COMMIT reply. Keep every reply lost
        // so the native command genuinely remains owed while its SQL receipt is durable.
        faults.afterSQL = { if $0 == "COMMIT" { committedReplies += 1; throw HostFailure("Injected committed ACK") } }
        await failure("SAVE_FAILED") { _ = try await self.write(writer, request) }
        XCTAssertGreaterThan(committedReplies, 1); try assertEffect()
        XCTAssertEqual(try rows("SELECT request_id FROM native_request_receipts").compactMap { $0["request_id"] as? String }, [try XCTUnwrap(request["requestId"] as? String)])
        let pending = try object(String(contentsOf: journal, encoding: .utf8))
        XCTAssertNil(pending["terminal"]); XCTAssertEqual(pending["method"] as? String, "trashItemsPurgeCommit")
        await writer.close()
        try rows("UPDATE tasks SET title = 'Later selected edit', rev = rev + 1 WHERE id = 'overlap'")
        try rows("UPDATE projects SET title = 'Later project edit', rev = rev + 1 WHERE id = 'parent'")
        try rows("UPDATE tasks SET title = 'Later unrelated edit', rev = rev + 1 WHERE id = 'protected'")
        var laterSettings = try settings()
        laterSettings["attachments"] = ["pendingRemoteDeletes": [["cloudKey": "later", "title": "Later queue edit", "attempts": 4, "lastErrorAt": otherAt]]]
        try saveSettings(laterSettings)
        let before = try snapshot(), replay = HostIOFaults(); var taskWrites = 0
        replay.beforeSQL = { if self.domainWrite($0), !$0.contains("schema_migrations") { taskWrites += 1 } }
        let reopened = host(replay); _ = try await reopened.start()
        XCTAssertEqual(taskWrites, 0); XCTAssertEqual(try snapshot(), before)
        let answer4 = try object(await reopened.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(request)])))["kind"] as? String
        XCTAssertEqual(answer4, "confirmed")
        var changed = request; changed["taskIds"] = ["overlap"]
        changed["taskRevisions"] = ["overlap": (request["taskRevisions"] as? [String: String])?["overlap"] ?? ""]
        let answer5 = try object(await reopened.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(changed)])))["kind"] as? String
        XCTAssertEqual(answer5, "unproven")
    }

    func testTerminalWriteAndClearFailureSettleWithoutRewritingLaterEdits() async throws {
        for clear in [false, true] {
            try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
            let request = try await request(writer)
            if clear { faults.journalRemove = { throw HostFailure("Injected terminal cleanup") } }
            else { var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected terminal write") } } }
            await failure { _ = try await self.write(writer, request) }; await writer.close()
            try rows("UPDATE tasks SET title = 'Later edit', rev = rev + 1 WHERE id = 'overlap'")
            let before = try snapshot(), replay = HostIOFaults(); var writes = 0
            replay.beforeSQL = { if self.domainWrite($0), !$0.contains("schema_migrations") { writes += 1 } }
            let reopened = host(replay); _ = try await reopened.start()
            XCTAssertEqual(writes, 0); XCTAssertEqual(try snapshot(), before)
            let answer6 = try object(await reopened.call("trashItemsPurgeRetryOutcome", argumentsJSON: json([json(request)])))["kind"] as? String
            XCTAssertEqual(answer6, "confirmed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await reopened.close()
            for suffix in ["", "-wal", "-shm", ".pending.json"] {
                let url = URL(fileURLWithPath: database.path + suffix)
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            }
        }
    }

    func testUnusedUUIDMissingOrChangedReceiptNeverProvesEqualAfterOrMixture() async throws {
        for mode in ["unused", "absent", "changed-payload", "changed-reply", "mixture"] {
            try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
            let request = try await request(writer); faults.journalRemove = { throw HostFailure("Injected cleanup") }
            await failure { _ = try await self.write(writer, request) }; await writer.close()
            var saved = try object(String(contentsOf: journal, encoding: .utf8)), envelope = try self.envelope()
            if mode == "unused" {
                var newRequest = request; newRequest["requestId"] = UUID().uuidString.lowercased()
                var prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]); prepared["request"] = newRequest
                envelope["request"] = newRequest; envelope["prepared"] = prepared
                saved["argumentsJSON"] = try json([json(envelope)])
            } else if mode == "changed-payload" {
                try rows("UPDATE native_request_receipts SET method = 'trashItemsPurge:changed'")
            } else if mode == "changed-reply" {
                try rows("UPDATE native_request_receipts SET reply = ?", [json(["count": 2])])
            } else { try rows("DELETE FROM native_request_receipts") }
            if mode == "mixture" {
                saved.removeValue(forKey: "terminal")
                try rows("UPDATE tasks SET purgedAt = NULL, deletedAt = ?, projectId = 'parent', sectionId = 'section', rev = 1, revBy = NULL, updatedAt = ? WHERE id = 'overlap'", [at, at])
            }
            try Data(json(saved).utf8).write(to: journal)
            let before = try snapshot(), pending = try Data(contentsOf: journal), replay = HostIOFaults(); var writes: [String] = []
            replay.beforeSQL = { if self.domainWrite($0) { writes.append($0) } }
            await failure(mode.hasPrefix("changed") ? nil : "STALE_REVISION") { _ = try await self.host(replay).start() }
            XCTAssertEqual(writes, ["INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)"])
            XCTAssertEqual(try snapshot(), before); try assertJournalContentUnchanged(pending)
            for suffix in ["", "-wal", "-shm", ".pending.json"] {
                let url = URL(fileURLWithPath: database.path + suffix)
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            }
        }
    }

    func testMalformedForgedOversizedJournalsRefuseBeforeSQLite() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let request = try await request(writer); faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected COMMIT") } }
        await failure { _ = try await self.write(writer, request) }; await writer.close()
        let original = try object(String(contentsOf: journal, encoding: .utf8)), envelope = try self.envelope(), before = try snapshot()
        let sentinels = try gcSentinels(), databaseBytes = try Data(contentsOf: database)
        for part in ["result", "after", "scope", "extra", "oversize", "duplicate"] {
            var saved = original, value = envelope, prepared = try XCTUnwrap(value["prepared"] as? [String: Any])
            switch part {
            case "result": prepared["result"] = ["count": 2]
            case "after":
                var effect = try XCTUnwrap(prepared["effect"] as? [String: Any]), pairs = try XCTUnwrap(effect["tasks"] as? [[String: Any]])
                var after = try XCTUnwrap(pairs[0]["after"] as? [String: Any]); after["status"] = "next"; pairs[0]["after"] = after; effect["tasks"] = pairs; prepared["effect"] = effect
            case "scope":
                var scope = try XCTUnwrap(prepared["scope"] as? [String: Any]); scope["areas"] = []; prepared["scope"] = scope
            case "extra": prepared["preparedLocalDay"] = "2026-10-09"
            case "oversize": prepared["updateAt"] = String(repeating: "é", count: 1_000_001)
            default: break
            }
            value["prepared"] = prepared
            let raw = part == "duplicate" ? try json(value).replacingOccurrences(of: "\"count\":3", with: "\"\\u0063ount\":3,\"count\":3") : try json(value)
            saved["argumentsJSON"] = try json([raw]); let bytes = Data(try json(saved).utf8); try bytes.write(to: journal)
            let replay = HostIOFaults(); var statements = 0; replay.beforeSQL = { _ in statements += 1 }
            await failure { _ = try await self.host(replay).start() }
            XCTAssertEqual(statements, 0, part); XCTAssertEqual(try snapshot(), before, part); XCTAssertEqual(try Data(contentsOf: journal), bytes, part)
            XCTAssertEqual(try Data(contentsOf: database), databaseBytes, part)
            for (path, owned) in sentinels { XCTAssertEqual(try Data(contentsOf: path), owned, part) }
        }
    }

    func testMalformedOuterAndTerminalJournalsRefuseBeforeSQLite() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let request = try await request(writer)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected COMMIT") } }
        await failure { _ = try await self.write(writer, request) }; await writer.close()
        let original = try object(String(contentsOf: journal, encoding: .utf8)), before = try snapshot()
        let databaseBytes = try Data(contentsOf: database)
        XCTAssertNil(original["terminal"], "Use a real complete BEFORE journal, without a receipt or terminal")
        let base = String(try json(original).dropLast())
        let count = try json(["count": 3])
        func terminal(_ value: String, rejected: Bool = false) throws -> String {
            try json([(rejected ? "rejected" : "success"): ["_0": value]])
        }
        func saved(_ terminal: String) -> String { base + ",\"terminal\":" + terminal + "}" }
        let success = try terminal(count)
        let method = "\"method\":\"trashItemsPurgeCommit\""
        let outer = try json(original)
        var variants: [(String, String)] = [
            ("duplicate outer method", outer.replacingOccurrences(of: method, with: method + "," + method)),
            ("escaped duplicate outer method", outer.replacingOccurrences(of: method,
                with: method + ",\"m\\u0065thod\":\"trashItemsPurgeCommit\"")),
            ("duplicate outer terminal", base + ",\"terminal\":" + success + ",\"terminal\":" + success + "}"),
            ("extra terminal case", saved(success.replacingOccurrences(of: "\"success\":", with: "\"extra\":true,\"success\":"))),
            ("extra success payload", saved(success.replacingOccurrences(of: "\"_0\":", with: "\"extra\":true,\"_0\":"))),
            ("duplicate success payload", saved("{\"success\":{\"_0\":\"{\\\"count\\\":3}\",\"_0\":\"{\\\"count\\\":3}\"}}")),
            ("null terminal", saved("null")),
        ]
        XCTAssertNotEqual(variants[0].1, outer); XCTAssertNotEqual(variants[1].1, outer)
        for (name, value) in [
            ("duplicate count", "{\"count\":3,\"count\":3}"),
            ("escaped duplicate count", "{\"count\":3,\"\\u0063ount\":3}"),
            ("extra count member", "{\"count\":3,\"extra\":true}"),
            ("boolean count", "{\"count\":true}"),
            ("mismatched count", "{\"count\":2}"),
            ("oversized success", String(repeating: " ", count: 1_025) + count),
        ] { variants.append((name, saved(try terminal(value)))) }
        variants.append(("extra rejected payload", saved(try terminal("STALE_REVISION: refused", rejected: true)
            .replacingOccurrences(of: "\"_0\":", with: "\"extra\":true,\"_0\":"))))
        variants.append(("uncertain refusal", saved(try terminal("SAVE_FAILED: uncertain", rejected: true))))
        variants.append(("oversized refusal", saved(try terminal("STALE_REVISION: " + String(repeating: "r", count: 4_097), rejected: true))))
        for (name, raw) in variants {
            let bytes = Data(raw.utf8); try bytes.write(to: journal)
            let replay = HostIOFaults(); var statements = 0
            replay.beforeSQL = { _ in statements += 1 }
            let reopened = host(replay)
            await failure { _ = try await reopened.start() }
            await reopened.close()
            XCTAssertEqual(statements, 0, name)
            XCTAssertEqual(try Data(contentsOf: database), databaseBytes, name)
            XCTAssertEqual(try snapshot(), before, name)
            XCTAssertEqual(try Data(contentsOf: journal), bytes, name)
        }
    }

    func testClosedRequestsAndPrivateFacadeDenialNeverWriteOrJournal() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let request = try await request(core), before = try snapshot(); var writes = 0, journals = 0
        faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }; faults.journalWrite = { journals += 1 }
        var duplicate = request; duplicate["taskIds"] = ["overlap", "overlap"]
        var missing = request; missing["projectRevisions"] = [:]
        var extra = request; extra["extra"] = true
        var upper = request; upper["requestId"] = UUID().uuidString
        var stale = request; stale["taskRevisions"] = ["overlap": "stale", "standalone": "stale"]
        var empty = request; empty["taskIds"] = []; empty["taskRevisions"] = [:]; empty["projectIds"] = []; empty["projectRevisions"] = [:]
        var longID = request; let oversizedID = String(repeating: "t", count: 501)
        longID["taskIds"] = [oversizedID]; longID["taskRevisions"] = [oversizedID: "r"]
        var longRevision = request; longRevision["projectRevisions"] = ["parent": String(repeating: "r", count: 201)]
        var longProjectID = request; let oversizedProjectID = String(repeating: "p", count: 201)
        longProjectID["projectIds"] = [oversizedProjectID]; longProjectID["projectRevisions"] = [oversizedProjectID: "r"]
        var tooMany = request; let many = (0..<10_001).map { "many-\($0)" }
        tooMany["taskIds"] = many; tooMany["taskRevisions"] = Dictionary(uniqueKeysWithValues: many.map { ($0, "r") })
        tooMany["projectIds"] = []; tooMany["projectRevisions"] = [:]
        for input in [duplicate, missing, extra, upper, stale, empty, longID, longRevision, longProjectID, tooMany] {
            await failure { _ = try await self.write(core, input) }
        }
        let raw = try json(request).replacingOccurrences(of: "\"requestId\":", with: "\"\\u0072equestId\":\"duplicate\",\"requestId\":")
        await failure { _ = try await core.call("trashItemsPurgeWrite", argumentsJSON: self.json([raw])) }
        for method in ["trashItemsPurgePrepare", "trashItemsPurgeValidate", "trashItemsPurgeCommit", "trashItemsPurgeOutcome"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
        }
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOrdinaryEditorAndRetainedAttachmentAdmissionPreserveOwnedBytes() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "protected", generation: 1,
            payloadJSON: try json(["version": 2, "taskID": "protected", "attachmentsOwned": true,
                "attachmentsBase": [], "attachments": [], "raw": ["title": "Uncommitted draft"]]))
        try await core.checkpointEditorDraft(checkpoint)
        let editor = EditorDraftStore(databaseURL: database), store = NativeAttachmentDraftStore(databaseURL: database)
        _ = try await core.beginAttachmentDraftV3(expectedSession: checkpoint.sessionID, expectedGeneration: 1)
        let cache = root.appendingPathComponent("attachment-files/cache"), source = cache.appendingPathComponent("borrowed.txt")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let borrowed = Data("Borrowed sentinel / 文".utf8); try borrowed.write(to: source)
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == .afterStageProof { throw HostFailure("Retain unproven attachment stage") } }
        await core.configureAttachmentDraftHost(hooks)
        let add = try json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": checkpoint.sessionID, "generation": checkpoint.generation,
            "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
        await failure { _ = try await core.addAttachmentDraftV3(requestJSON: add) }
        await core.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let record = try XCTUnwrap(store.readMixed())
        guard case .add(let op) = try XCTUnwrap(record.operations.first) else { throw HostFailure("Retained fixture Add required") }
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), target = try XCTUnwrap(URL(string: op.targetURI))
        let unproven = Data("Unproven target sentinel / 文".utf8); try unproven.write(to: target)
        let current = try XCTUnwrap(editor.read()?.snapshot)
        let detach = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": current.sessionID, "generation": current.generation])
        let detached = try object(await core.discardAttachmentDraftV3(requestJSON: detach))
        XCTAssertEqual(detached["status"] as? String, "cleanupPending")
        XCTAssertNil(try editor.read())
        let retained = try Data(contentsOf: store.url), staged = try Data(contentsOf: stage)
        let independent = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "protected", generation: 1,
            payloadJSON: checkpoint.payloadJSON)
        try await core.checkpointEditorDraft(independent)
        let owned = try Data(contentsOf: editor.url), request = try await request(core), before = try snapshot()
        // Archive admission refuses to replace an independent saved editor.
        await failure("saved editor draft") { _ = try await self.write(core, request) }
        XCTAssertEqual(try Data(contentsOf: editor.url), owned); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try await core.discardEditorDraft(expectedSession: independent.sessionID)
        let answer = try object(await write(core, request))
        XCTAssertEqual(answer["count"] as? Int, 3); XCTAssertNil(try editor.read())
        XCTAssertEqual(try Data(contentsOf: store.url), retained)
        XCTAssertEqual(try Data(contentsOf: stage), staged)
        XCTAssertEqual(try Data(contentsOf: target), unproven)
        XCTAssertEqual(try Data(contentsOf: source), borrowed)
        XCTAssertEqual(try row("tasks", "protected")["title"] as? String, "protected")
    }

    #if DEBUG && os(iOS) && targetEnvironment(simulator)
    func testIsolatedRealTerminalCleanupInjectorAlsoOwnsPurge() async throws {
        let originalRoot = root!
        let identifier = UUID().uuidString.lowercased()
        root = originalRoot.appendingPathComponent("NativeUITests/" + identifier)
        defer { root = originalRoot }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // The audited fixture requires this exact basename, canonical namespace
        // and secret-service owner; every normal test remains on core.sqlite.
        let isolatedDatabase = root.appendingPathComponent("mindwtr.sqlite")
        let faults = HostIOFaults(); faults.secretService = "mindwtr.native-keychain.fixture." + identifier
        let boot = CoreHost(databaseURL: isolatedDatabase, bundleURL: bundle, faults: faults)
        _ = try await boot.start(); await boot.close()
        let source = try SQLiteBridge(url: isolatedDatabase)
        _ = try source.execute("INSERT INTO tasks (id,title,status,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES ('isolated-trash','Isolated Trash','next','[]','[]',?,?,?,1)", parametersJSON: json([at, at, at]))
        source.close()
        let core = CoreHost(databaseURL: isolatedDatabase, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }
        try await core.configureIsolatedCaptureTerminalFailureOnce(); _ = try await core.start()
        let view = try object(await core.call("menuRead", argumentsJSON: json(["trash", json(["offset": 0, "limit": 50])])))
        let selected = try object(await core.call("trashSelection", argumentsJSON: json([json(["revision": XCTUnwrap(view["revision"])])])))
        var request = selected; request["requestId"] = UUID().uuidString.lowercased()
        await failure("terminal cleanup interrupted") { _ = try await self.write(core, request) }
        let retry = try await core.retryPending()
        XCTAssertEqual(try object(XCTUnwrap(retry))["count"] as? Int, 1)
        let check = try SQLiteBridge(url: isolatedDatabase); defer { check.close() }
        let result = try XCTUnwrap(NativeJSON.jsonObject(with: Data(check.execute("SELECT purgedAt,rev FROM tasks WHERE id = 'isolated-trash'").utf8)) as? [[String: Any]])
        XCTAssertEqual(result.first?["purgedAt"] as? String, at); XCTAssertEqual(result.first?["rev"] as? Int, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: isolatedDatabase.appendingPathExtension("pending.json").path))
        let repeated = try await core.retryPending(); XCTAssertNil(repeated)
    }
    #endif

    func testOversizedCascadeRefusesWithGuidanceBeforeJournal() async throws {
        try await seed(); let note = String(repeating: "x", count: 10_000)
        for index in 0..<220 {
            try rows("INSERT INTO tasks (id,title,description,status,projectId,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES (?,? ,?,'next','parent','[]','[]',?,?,?,1)",
                ["large-\(index)", "Large context", note, at, at, at])
        }
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let request = try await request(core, tasks: [], projects: ["parent"]), before = try snapshot(); var writes = 0, journals = 0
        faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }; faults.journalWrite = { journals += 1 }
        await failure("select fewer") { _ = try await self.write(core, request) }
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    private func removeDatabase() throws {
        for suffix in ["", "-wal", "-shm", ".pending.json"] {
            let path = URL(fileURLWithPath: database.path + suffix)
            if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
        }
    }
    private func attachment(_ id: String, cloud: String) -> [String: Any] {
        ["id": id, "kind": "file", "title": id, "uri": "file:///owned/" + id,
         "cloudKey": cloud, "createdAt": at, "updatedAt": at]
    }
    private func attach(_ table: String, _ id: String, _ values: [[String: Any]]) throws {
        try rows("UPDATE \(table) SET attachments = ? WHERE id = ?", [json(values), id])
    }
    private func settings() throws -> [String: Any] {
        try object(XCTUnwrap(rows("SELECT data FROM settings LIMIT 1").first?["data"] as? String))
    }
    private func saveSettings(_ value: [String: Any]) throws {
        try rows("UPDATE settings SET data = ?", [json(value)])
    }
    private func gcSentinels() throws -> [(URL, Data)] {
        let files = NativeBackupOperationFiles(libraryRoot: root)
        let orphan = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{\"sentinel\":true}",
            newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{\"sentinel\":\"文\"}"), existingSnapshot: nil)
        let operation = root.appendingPathComponent("backup-operations/" + orphan.id)
        let export = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
        let imports = root.appendingPathComponent("backup-imports")
        try FileManager.default.createDirectory(at: export, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: imports, withIntermediateDirectories: true)
        let exportFile = export.appendingPathComponent("mindwtr-backup-2026-10-09T12-00-00-000Z.json")
        let importFile = imports.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
        try Data("export sentinel / 文".utf8).write(to: exportFile)
        try Data("import sentinel / 文".utf8).write(to: importFile)
        var paths = [operation.appendingPathComponent("manifest.json"), operation.appendingPathComponent("plan.json"), exportFile, importFile]
        let snapshot = try files.read(orphan).snapshot
        paths.append(root.appendingPathComponent("backup-snapshots/" + snapshot.id + "/" + snapshot.name))
        return try paths.map { ($0, try Data(contentsOf: $0)) }
    }

    func testTaskAndProjectOnlyPurgePoliciesDetachOnlyLiveLegacyLinks() async throws {
        for mode in ["task", "project"] {
            try await seed(); let core = host(); _ = try await core.start()
            // Boot normally repairs these links. Stage and verify real saved legacy
            // links after boot so the purge itself must apply the detach formula.
            for (id, parent, section) in [("legacy-live", "parent", "section"), ("legacy-section", "", "section")] {
                try rows("INSERT INTO tasks (id,title,status,projectId,sectionId,tags,contexts,createdAt,updatedAt,rev) VALUES (?,?,'next',?,?,'[]','[]',?,?,1)",
                    [id, id, parent.isEmpty ? NSNull() : parent as Any, section, at, at])
            }
            XCTAssertEqual(try row("tasks", "legacy-live")["projectId"] as? String, "parent")
            XCTAssertEqual(try row("tasks", "legacy-section")["sectionId"] as? String, "section")
            let selected = try await request(core, tasks: mode == "task" ? ["standalone"] : [], projects: mode == "task" ? [] : ["parent"])
            let answer = try object(await write(core, selected)); XCTAssertEqual(answer["count"] as? Int, 1)
            for id in ["legacy-live", "legacy-section"] {
                let result = try row("tasks", id)
                if mode == "project" {
                    XCTAssertTrue(result["projectId"] is NSNull); XCTAssertTrue(result["sectionId"] is NSNull)
                    XCTAssertEqual(result["status"] as? String, "next"); XCTAssertEqual(result["rev"] as? Int, 2)
                } else { XCTAssertEqual(result["sectionId"] as? String, "section"); XCTAssertEqual(result["rev"] as? Int, 1) }
                XCTAssertTrue(result["purgedAt"] is NSNull)
            }
            XCTAssertTrue(try row("tasks", "cascade")["purgedAt"] is NSNull)
            if mode == "project" { XCTAssertEqual(try row("sections", "section")["title"] as? String, "") }
            else { XCTAssertTrue(try row("projects", "parent")["purgedAt"] is NSNull) }
            await core.close(); try removeDatabase()
        }
    }

    func testTaskFirstQueueOrderAndOutsideActiveDeletedAttachmentSharing() async throws {
        for mode in ["order", "active-task", "deleted-task", "active-project", "deleted-project"] {
            try await seed(); let core = host(); _ = try await core.start()
            try attach("tasks", "overlap", [attachment("z-task", cloud: "z-task"), attachment("t-shared", cloud: "shared"), attachment("a-task", cloud: "a-task")])
            try attach("projects", "parent", [attachment("z-parent", cloud: "z-parent"), attachment("p-shared", cloud: "shared"), attachment("a-parent", cloud: "a-parent")])
            if mode != "order" {
                var retained = attachment("outside", cloud: "shared"); retained["deletedAt"] = at
                if mode.hasSuffix("task") {
                    try rows("INSERT INTO tasks (id,title,status,tags,contexts,createdAt,updatedAt,deletedAt,rev,attachments) VALUES ('outside','Outside','next','[]','[]',?,?,?,1,?)",
                        [at, at, mode.hasPrefix("active") ? NSNull() : at as Any, json([retained])])
                } else {
                    try rows("INSERT INTO projects (id,title,status,color,orderNum,createdAt,updatedAt,deletedAt,rev,attachments) VALUES ('outside','Outside','active','#94a3b8',0,?,?,?,1,?)",
                        [at, at, mode.hasPrefix("active") ? NSNull() : at as Any, json([retained])])
                }
            }
            var saved = try settings()
            let existing: [[String: Any]] = [["cloudKey": "existing", "title": "Retain metadata", "attempts": 2, "lastErrorAt": otherAt], ["cloudKey": "existing"]]
            saved["attachments"] = ["pendingRemoteDeletes": existing, "lastCleanupAt": otherAt]
            saved["theme"] = "dark"; try saveSettings(saved)
            try rows("UPDATE tasks SET pushCount = NULL WHERE id = 'protected'")
            let protected = try json(row("tasks", "protected")), selected = try await request(core)
            let reply = try object(await write(core, selected)); XCTAssertEqual(reply["count"] as? Int, 3)
            let after = try settings(), attachmentSettings = try XCTUnwrap(after["attachments"] as? [String: Any])
            let queue = try XCTUnwrap(attachmentSettings["pendingRemoteDeletes"] as? [[String: Any]])
            // RN's cleanup Map keeps the last existing duplicate when it adds new work.
            let expected = mode == "order" ? ["existing", "z-task", "a-task", "z-parent", "shared", "a-parent"]
                : ["existing", "z-task", "a-task", "z-parent", "a-parent"]
            XCTAssertEqual(queue.compactMap { $0["cloudKey"] as? String }, expected, mode)
            XCTAssertEqual(try json(queue[0]), try json(existing[1]), "RN's last duplicate wins without inventing absent metadata")
            XCTAssertEqual(after["theme"] as? String, "dark")
            XCTAssertEqual(attachmentSettings["lastCleanupAt"] as? String, otherAt)
            XCTAssertEqual(try json(row("tasks", "protected")), protected); try assertEffect()
            if mode != "order" { XCTAssertTrue(try row(mode.hasSuffix("task") ? "tasks" : "projects", "outside")["purgedAt"] is NSNull) }
            await core.close(); try removeDatabase()
        }
    }

    func testColdChangedReferenceQueueDeviceAndRowsRejectWithoutDomainMutation() async throws {
        for mode in ["reference", "queue", "device", "row", "section"] {
            try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
            try attach("tasks", "overlap", [attachment("candidate", cloud: "candidate")])
            let selected = try await request(writer)
            faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected purge COMMIT") } }
            await failure { _ = try await self.write(writer, selected) }; await writer.close()
            switch mode {
            case "reference": try attach("tasks", "protected", [attachment("new-reference", cloud: "candidate")])
            case "queue": var saved = try settings(); saved["attachments"] = ["pendingRemoteDeletes": [["cloudKey": "concurrent", "attempts": 1]]]; try saveSettings(saved)
            case "device": var saved = try settings(); saved["deviceId"] = UUID().uuidString.lowercased(); try saveSettings(saved)
            case "row": try rows("UPDATE tasks SET title = 'Same revision changed raw row' WHERE id = 'overlap'")
            default: try rows("INSERT INTO sections (id,projectId,title,orderNum,createdAt,updatedAt,rev) VALUES ('new-section','parent','New section',0,?,?,1)", [at, at])
            }
            let before = try snapshot(), bytes = try Data(contentsOf: journal), replay = HostIOFaults(); var mutations: [String] = []
            replay.beforeSQL = { if self.domainWrite($0), !$0.contains("schema_migrations") { mutations.append($0) } }
            let reopened = host(replay); await failure("STALE_REVISION") { _ = try await reopened.start() }; await reopened.close()
            XCTAssertTrue(mutations.isEmpty, mode); XCTAssertEqual(try snapshot(), before, mode); try assertJournalContentUnchanged(bytes)
            try removeDatabase()
        }
    }

    func testSemanticReferenceQueueDeviceForgeriesStopBeforeSQLAndGC() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        try attach("tasks", "overlap", [attachment("candidate", cloud: "candidate")])
        let selected = try await request(writer)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected purge COMMIT") } }
        await failure { _ = try await self.write(writer, selected) }; await writer.close()
        let original = try object(String(contentsOf: journal, encoding: .utf8)), envelope = try self.envelope()
        let before = try snapshot(), databaseBytes = try Data(contentsOf: database), sentinels = try gcSentinels()
        for mode in ["reference", "reference-extra", "queue", "queue-extra", "queue-boolean", "device", "boolean", "reference-size", "queue-size"] {
            var value = envelope, prepared = try XCTUnwrap(value["prepared"] as? [String: Any])
            if mode == "reference" || mode == "reference-extra" {
                var scope = try XCTUnwrap(prepared["scope"] as? [String: Any]), references = try XCTUnwrap(scope["references"] as? [[String: Any]])
                if mode == "reference-extra" { references[0]["extra"] = true }
                else { references[0]["cloudKeys"] = ["forged"] }
                scope["references"] = references; prepared["scope"] = scope
            } else if mode == "device" { prepared["deviceIdBefore"] = "forged-device" }
            else if mode == "boolean" { prepared["result"] = ["count": true] }
            else if mode == "reference-size" {
                var scope = try XCTUnwrap(prepared["scope"] as? [String: Any]); scope["references"] = [["kind": "task", "id": "overlap", "cloudKeys": [String(repeating: "é", count: 1_000_001)]]]; prepared["scope"] = scope
            } else {
                var effect = try XCTUnwrap(prepared["effect"] as? [String: Any])
                var entry: [String: Any] = ["cloudKey": mode == "queue-size" ? String(repeating: "é", count: 1_000_001) : "forged"]
                if mode == "queue-extra" { entry["extra"] = true }
                if mode == "queue-boolean" { entry["attempts"] = true }
                effect["pendingRemoteDeletes"] = [entry]; prepared["effect"] = effect
            }
            value["prepared"] = prepared; var saved = original; saved["argumentsJSON"] = try json([json(value)])
            let bytes = Data(try json(saved).utf8); try bytes.write(to: journal)
            let replay = HostIOFaults(); var queries = 0; replay.beforeSQL = { _ in queries += 1 }
            let reopened = host(replay); await failure { _ = try await reopened.start() }; await reopened.close()
            XCTAssertEqual(queries, 0, mode); XCTAssertEqual(try snapshot(), before, mode)
            XCTAssertEqual(try Data(contentsOf: database), databaseBytes, mode); XCTAssertEqual(try Data(contentsOf: journal), bytes, mode)
            for (path, owned) in sentinels { XCTAssertEqual(try Data(contentsOf: path), owned, mode) }
        }
    }

    func testInternallyConsistentOmittedDeletedChildStillFailsSavedRecollection() async throws {
        try await seed(); let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let selected = try await request(writer)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected purge COMMIT") } }
        await failure { _ = try await self.write(writer, selected) }; await writer.close()
        var saved = try object(String(contentsOf: journal, encoding: .utf8)), value = try envelope()
        var prepared = try XCTUnwrap(value["prepared"] as? [String: Any]), scope = try XCTUnwrap(prepared["scope"] as? [String: Any])
        let tasks = try XCTUnwrap(scope["tasks"] as? [[String: Any]])
        XCTAssertTrue(tasks.contains { $0["id"] as? String == "cascade" })
        scope["tasks"] = tasks.filter { $0["id"] as? String != "cascade" }; prepared["scope"] = scope
        // The omitted deleted child has no row effect or attachment: the shared
        // pure effect remains consistent, but it cannot grant saved membership.
        value["prepared"] = prepared; saved["argumentsJSON"] = try json([json(value)])
        let bytes = Data(try json(saved).utf8); try bytes.write(to: journal)
        let before = try snapshot(), replay = HostIOFaults(); var mutations = 0
        replay.beforeSQL = { if self.domainWrite($0), !$0.contains("schema_migrations") { mutations += 1 } }
        let reopened = host(replay); await failure("STALE_REVISION") { _ = try await reopened.start() }; await reopened.close()
        XCTAssertEqual(mutations, 0); XCTAssertEqual(try snapshot(), before); try assertJournalContentUnchanged(bytes)
    }

    func testExactFEFFIdentityAndLossyCanonicalRevisionDictionaryRefusal() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let id = "\u{feff}exact-é"
        try rows("INSERT INTO tasks (id,title,status,tags,contexts,createdAt,updatedAt,deletedAt,rev) VALUES (?,?,'next','[]','[]',?,?,?,1)", [id, id, at, at, at])
        // Request comes from a fresh native projection, preserving its exact ID.
        await core.close(); let reopened = host(); _ = try await reopened.start()
        let selected = try await request(reopened, tasks: [id], projects: [])
        let answer = try object(await write(reopened, selected)); XCTAssertEqual(answer["count"] as? Int, 1)
        XCTAssertEqual(try row("tasks", id)["id"] as? String, id); XCTAssertEqual(try row("tasks", id)["purgedAt"] as? String, at)
        let before = try snapshot(), raw = "{\"requestId\":\"" + UUID().uuidString.lowercased() + "\",\"taskIds\":[\"é\",\"e\\u0301\"],\"taskRevisions\":{\"é\":\"r\",\"e\\u0301\":\"r\"},\"projectIds\":[],\"projectRevisions\":{}}"
        await failure("INVALID_INPUT") { _ = try await reopened.call("trashItemsPurgeWrite", argumentsJSON: self.json([raw])) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

}
