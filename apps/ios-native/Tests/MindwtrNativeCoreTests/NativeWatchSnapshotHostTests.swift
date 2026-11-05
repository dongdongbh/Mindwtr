import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWatchSnapshotHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var phaseEnd: Date?
    private enum TimerMode { case absent, stopped, paused, running, expired }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("NativeWatchSnapshotHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
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
    private func seed(_ mode: TimerMode) async throws {
        let bootstrap = host(); _ = try await bootstrap.start()
        if mode != .absent {
            _ = try await bootstrap.writePomodoroTransition(requestJSON: json([
                "action": "initialize", "requestId": UUID().uuidString.lowercased(),
                "observedAtMs": Int64(Date().timeIntervalSince1970 * 1000), "localDayKey": "2026-10-30",
                "durations": ["focusMinutes": 25, "breakMinutes": 5]]))
        }
        await bootstrap.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let at = "2026-10-30T00:00:00.000Z"
        for index in 0..<23 {
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,checklist,isFocusedToday,createdAt,updatedAt,rev,revBy) VALUES (?,?,'next','[]','[]','Synthetic detail',?,1,?,?,1,'fixture')",
                                parametersJSON: json([String(format: "watch-%02d", index), "Synthetic Focus \(index)",
                                                      json([["id": "milk", "title": "Milk", "isCompleted": true]]), at, at]))
        }
        _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy) VALUES ('watch-linked','Synthetic linked task','waiting','[]','[]',?,?,1,'fixture')", parametersJSON: json([at, at]))
        let settingsRows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        var settings = try object(XCTUnwrap(settingsRows.first?["data"] as? String))
        var gtd = settings["gtd"] as? [String: Any] ?? [:]
        gtd["autoArchiveDays"] = 0
        gtd["pomodoro"] = ["linkTask": true, "completionAlert": false,
                           "customDurations": ["focusMinutes": 40, "breakMinutes": 8]]
        settings["gtd"] = gtd
        _ = try sql.execute("UPDATE settings SET data=? WHERE id=1", parametersJSON: json([json(settings)]))
        if mode != .absent {
            let saved = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT state_json FROM native_pomodoro_session").utf8)) as? [[String: Any]])
            var state = try object(XCTUnwrap(saved.first?["state_json"] as? String))
            var session = try XCTUnwrap(state["session"] as? [String: Any])
            var timer = try XCTUnwrap(session["timerState"] as? [String: Any])
            timer["remainingSeconds"] = mode == .stopped ? 1500 : 123
            timer["isRunning"] = mode == .running || mode == .expired
            session["timerState"] = timer; session["selectedTaskId"] = "watch-linked"
            if mode == .running || mode == .expired {
                let end = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) + (mode == .running ? 600 : -60))
                phaseEnd = end
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                session["phaseEndsAt"] = formatter.string(from: end)
            }
            state["session"] = session
            _ = try sql.execute("UPDATE native_pomodoro_session SET state_json=?", parametersJSON: json([json(state)]))
        }
    }
    private func durableRows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for row in names {
            let table = try XCTUnwrap(row["name"] as? String)
            let quoted = "\"" + table.replacingOccurrences(of: "\"", with: "\"\"") + "\""
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(" + quoted + ")").utf8)) as? [[String: Any]])
            // Encode FTS BLOBs as SQL literals; shadow tables may have no rowid.
            let projection = try columns.map { column -> String in
                let name = try XCTUnwrap(column["name"] as? String)
                let identifier = "\"" + name.replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "quote(" + identifier + ") AS " + identifier
            }.joined(separator: ",")
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT " + projection + " FROM " + quoted).utf8)) as? [[String: Any]])
            result[table] = try json(rows.map { try json($0) }.sorted())
        }
        return result
    }
    private func assertReadOnly(_ mode: TimerMode, file: StaticString = #filePath, line: UInt = #line) async throws {
        try await seed(mode)
        let faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let core = host(faults); _ = try await core.start(); writes = 0
        let before = try durableRows()
        let snapshot = try await core.watchSnapshot()
        let context = try snapshot.applicationContext()
        XCTAssertEqual(Set(context.keys), ["protocolVersion", "generatedAt", "focus", "pomodoro"], file: file, line: line)
        XCTAssertEqual(context["protocolVersion"] as? Int, 1, file: file, line: line)
        let focus = try XCTUnwrap(context["focus"] as? [[String: Any]])
        XCTAssertEqual(focus.count, 20, file: file, line: line)
        XCTAssertEqual(Set(focus.compactMap { $0["id"] as? String }).count, 20, file: file, line: line)
        for task in focus {
            XCTAssertTrue((task["id"] as? String)?.hasPrefix("watch-") == true, file: file, line: line)
            XCTAssertEqual(task["description"] as? String, "Synthetic detail", file: file, line: line)
            let checklist = try XCTUnwrap(task["checklist"] as? [[String: Any]])
            XCTAssertEqual(checklist.first?["isCompleted"] as? Bool, true, file: file, line: line)
        }
        let timer = try XCTUnwrap(context["pomodoro"] as? [String: Any])
        XCTAssertEqual(timer["phase"] as? String, "focus", file: file, line: line)
        XCTAssertEqual(timer["completionAlert"] as? Bool, false, file: file, line: line)
        XCTAssertEqual(timer["isRunning"] as? Bool, mode == .running || mode == .expired, file: file, line: line)
        let remaining = try XCTUnwrap(timer["remainingSeconds"] as? Int)
        switch mode {
        case .absent:
            XCTAssertEqual(remaining, 2400, file: file, line: line)
            XCTAssertNil(timer["taskId"], file: file, line: line); XCTAssertNil(timer["taskTitle"], file: file, line: line)
        case .stopped: XCTAssertEqual(remaining, 1500, file: file, line: line)
        case .paused: XCTAssertEqual(remaining, 123, file: file, line: line)
        case .running: XCTAssertTrue((1...600).contains(remaining), file: file, line: line)
        case .expired: XCTAssertEqual(remaining, 0, file: file, line: line)
        }
        if mode != .absent {
            XCTAssertEqual(timer["taskId"] as? String, "watch-linked", file: file, line: line)
            XCTAssertEqual(timer["taskTitle"] as? String, "Synthetic linked task", file: file, line: line)
        }
        if let phaseEnd {
            XCTAssertEqual((timer["phaseEndTime"] as? NSNumber)?.int64Value, Int64(phaseEnd.timeIntervalSince1970 * 1000), file: file, line: line)
        } else { XCTAssertNil(timer["phaseEndTime"], file: file, line: line) }
        XCTAssertLessThanOrEqual(try PropertyListSerialization.data(fromPropertyList: context, format: .binary, options: 0).count, 60 * 1024)
        XCTAssertEqual(try durableRows(), before, file: file, line: line)
        XCTAssertEqual(writes, 0, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }

    func testAbsentTimerProjectsConfiguredStoppedStateWithoutInitialization() async throws { try await assertReadOnly(.absent) }
    func testSavedStoppedTimerAndFocusReadWithoutWrites() async throws { try await assertReadOnly(.stopped) }
    func testSavedPausedTimerAndFocusReadWithoutWrites() async throws { try await assertReadOnly(.paused) }
    func testSavedRunningTimerCountsDownWithoutWrites() async throws { try await assertReadOnly(.running) }
    func testSavedExpiredTimerDoesNotTransitionOrCredit() async throws { try await assertReadOnly(.expired) }

    func testFacadeRequiresReadyPersonalOwnerAndZeroArguments() async throws {
        try await seed(.absent)
        let core = host()
        do { _ = try await core.watchSnapshot(); XCTFail("Startup is required") } catch {}
        _ = try await core.start(); let before = try durableRows()
        for raw in ["[null]", "[1]", "[{}]", "[\"private input\"]", "[]" + String(repeating: " ", count: 2047)] {
            do { _ = try await core.call("iosWatchSnapshot", argumentsJSON: raw); XCTFail("Invalid arguments must refuse") } catch {}
        }
        _ = try await core.watchSnapshot()
        XCTAssertEqual(try durableRows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        do { _ = try await core.watchSnapshot(); XCTFail("A closed Host cannot read") } catch {}
        let restricted = CoreHost(databaseURL: root.appendingPathComponent("restricted.sqlite"), bundleURL: bundle, workspaceMode: .restricted)
        do { _ = try await restricted.watchSnapshot(); XCTFail("Personal admission is required") } catch {}
        await restricted.close()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("restricted.sqlite").path))
    }
}
