import Foundation
import SQLite3
import XCTest
@testable import MindwtrNativeCore

final class SQLiteBridgeReadOnlyTests: XCTestCase {
    func testAISummaryPostNativePublicationRetirementLeavesNoAcceptedMarker() throws {
        #if DEBUG
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        let root = base.appendingPathComponent(".mindwtr-native-tests/summary-accept-" + UUID().uuidString.lowercased())
        let preferences = root.appendingPathComponent("Preferences", isDirectory: true)
        try FileManager.default.createDirectory(at: preferences, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let suite = "nativeUITests." + UUID().uuidString.lowercased(), plist = preferences.appendingPathComponent(suite + ".plist")
        let domain: [String: Any] = ["unknown": "artifact-only private cell"]
        try PropertyListSerialization.data(fromPropertyList: domain, format: .binary, options: 0).write(to: plist)
        let defaults = try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: plist, expectedDomain: NativeAISummaryEvidence.typedDomain(domain))
        let captureURL = root.appendingPathComponent("capture.json")
        try NativeAISummaryEvidence.writeExclusive(Data("{\"phase\":\"baseline\"}".utf8), to: captureURL)
        let capture = try XCTUnwrap(NativeAISummaryEvidence.readFile(captureURL, limit: 1024))
        let publication = NativeAISummaryEvidence.Publication(directory: root,
            directories: [root.path: try NativeAISummaryEvidence.directoryIdentity(root)], capture: capture,
            phase: "baseline", suite: suite, preferencesURL: plist, defaults: defaults)
        var admissions = 0
        XCTAssertThrowsError(try NativeAISummaryEvidence.accept(publication) { admissions += 1; return admissions == 1 })
        XCTAssertEqual(admissions, 2, "Retirement immediately before acceptance must refuse")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("accepted.json").path))
        XCTAssertEqual(try NativeAISummaryEvidence.readFile(captureURL, limit: 1024), capture)
        try NativeAISummaryEvidence.accept(publication) { true }
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("accepted.json").path))
        XCTAssertThrowsError(try NativeAISummaryEvidence.accept(publication) { true })
        #endif
    }

    @MainActor
    func testAISummaryActualIsolatedPreferencesNaturallyPersistWithoutPromotion() async throws {
        #if DEBUG
        let suite = "nativeUITests." + UUID().uuidString.lowercased()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let url = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Library/Preferences/" + suite + ".plist")
        defaults.setPersistentDomain(["unknown": "private checkpoint cell", "bool": true, "integer": 42, "data": Data([0, 255])], forName: suite)
        let expected = try NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))
        var observed: NativeAISummaryEvidence.Defaults?
        for _ in 0..<60 {
            guard try NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite)) == expected else { return XCTFail("Selected suite changed") }
            if let value = try? NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: expected) {
                observed = value; break
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        let captured = try XCTUnwrap(observed, "The actual platform preferences writer must naturally persist this isolated suite")
        XCTAssertNotNil(captured.durable)
        XCTAssertEqual(try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: expected), captured)
        defaults.set("changed", forKey: "unknown")
        XCTAssertNotEqual(try NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite)), expected)
        // This test never writes or substitutes the real system plist and never synchronizes it.
        #endif
    }

    func testAISummaryDefaultsRequiresActualDurableTypedDomainAndDetectsMirrorChange() throws {
        #if DEBUG
        let id = UUID().uuidString.lowercased(), suite = "nativeUITests." + id
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        let root = base.appendingPathComponent(".mindwtr-native-tests/" + id + "/Library/Preferences")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)), url = root.appendingPathComponent(suite + ".plist")
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.removePersistentDomain(forName: suite)
        XCTAssertNil(try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))).durable)
        let values: [String: Any] = ["unknown": "private", "present": true, "integer": 1, "bytes": Data([0, 255])]
        defaults.setPersistentDomain(values, forName: suite)
        XCTAssertThrowsError(try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))))
        try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0).write(to: url)
        let saved = try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite)))
        XCTAssertEqual(saved.durable?.bytes, try Data(contentsOf: url))
        XCTAssertNotEqual(try NativeAISummaryEvidence.typedDomain(["v": true]), try NativeAISummaryEvidence.typedDomain(["v": 1]))
        XCTAssertNotEqual(try NativeAISummaryEvidence.typedDomain(nil), try NativeAISummaryEvidence.typedDomain([:]))
        XCTAssertThrowsError(try NativeAISummaryEvidence.typedDomain(["entries": Array(repeating: true, count: 10000)]))
        defaults.set("changed", forKey: "unknown")
        XCTAssertThrowsError(try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))))
        defaults.setPersistentDomain(values, forName: suite)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: root.appendingPathComponent("foreign"))
        XCTAssertThrowsError(try NativeAISummaryEvidence.observeDefaults(suite: suite, preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))))
        XCTAssertThrowsError(try NativeAISummaryEvidence.observeDefaults(suite: "ordinary", preferencesURL: url, expectedDomain: NativeAISummaryEvidence.typedDomain(defaults.persistentDomain(forName: suite))))
        #endif
    }

    func testAISummaryBackupIncludesCommittedWALAndPreservesSourceWithoutPragmaOrOverwrite() throws {
        #if DEBUG
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        let root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.sqlite"), target = root.appendingPathComponent("evidence.sqlite")
        let db = try SQLiteBridge(url: source); defer { db.close() }
        _ = try db.execute("PRAGMA journal_mode = WAL")
        _ = try db.execute("PRAGMA wal_autocheckpoint = 0")
        _ = try db.execute("CREATE TABLE proof (id INTEGER PRIMARY KEY, unknown TEXT, private_cell BLOB)")
        _ = try db.execute("INSERT INTO proof VALUES (9223372036854775807, 'saved', X'00FF42')")
        let main = try Data(contentsOf: source)
        let wal = URL(fileURLWithPath: source.path + "-wal"), beforeWAL = try Data(contentsOf: wal)
        XCTAssertFalse(beforeWAL.isEmpty)
        try db.captureAISummaryEvidence(at: target)
        XCTAssertEqual(try Data(contentsOf: source), main)
        XCTAssertEqual(try Data(contentsOf: wal), beforeWAL)
        let evidence = try Data(contentsOf: target)
        XCTAssertThrowsError(try db.captureAISummaryEvidence(at: target))
        XCTAssertEqual(try Data(contentsOf: target), evidence)
        // Only a disposable exported working copy is opened by the offline auditor.
        let workingCopy = root.appendingPathComponent("offline-auditor-copy.sqlite")
        try FileManager.default.copyItem(at: target, to: workingCopy)
        var reader: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(workingCopy.path, &reader, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, nil), SQLITE_OK)
        defer { sqlite3_close(reader) }
        var row: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(reader, "SELECT id, unknown, hex(private_cell) FROM proof", -1, &row, nil), SQLITE_OK)
        defer { sqlite3_finalize(row) }
        XCTAssertEqual(sqlite3_step(row), SQLITE_ROW)
        XCTAssertEqual(sqlite3_column_int64(row, 0), Int64.max)
        XCTAssertEqual(String(cString: sqlite3_column_text(row, 1)), "saved")
        XCTAssertEqual(String(cString: sqlite3_column_text(row, 2)), "00FF42")
        XCTAssertEqual(sqlite3_step(row), SQLITE_DONE)
        XCTAssertThrowsError(try db.captureAISummaryEvidence(at: root.appendingPathComponent("oversize.sqlite"), maximumBytes: 1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("oversize.sqlite").path))
        // A failed capture rolled back only its own read transaction: ordinary writes remain available.
        _ = try db.execute("BEGIN IMMEDIATE")
        XCTAssertThrowsError(try db.captureAISummaryEvidence(at: root.appendingPathComponent("caller-transaction.sqlite")))
        _ = try db.execute("INSERT INTO proof VALUES (2, 'caller-owned', NULL)")
        _ = try db.execute("COMMIT")
        XCTAssertEqual(try db.execute("SELECT count(*) AS n FROM proof"), "[{\"n\":2}]")
        // Existing destination refusal also unwinds its own source transaction.
        XCTAssertThrowsError(try db.captureAISummaryEvidence(at: target))
        _ = try db.execute("BEGIN IMMEDIATE"); _ = try db.execute("ROLLBACK")
        #endif
    }

    func testReadOnlyExecutionRejectsWritesBeforeStepAndPreservesDefaultWrites() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        let root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try SQLiteBridge(url: root.appendingPathComponent("fixture.sqlite"))
        defer { database.close() }
        _ = try database.execute("CREATE TABLE fixture (value TEXT NOT NULL)")
        _ = try database.execute("INSERT INTO fixture (value) VALUES (?)", parametersJSON: "[\"before\"]")
        let before = try database.execute("SELECT value FROM fixture")
        for sql in ["INSERT INTO fixture (value) VALUES ('after')", "UPDATE fixture SET value = 'after'",
                    "DELETE FROM fixture", "CREATE TABLE forbidden (value TEXT)",
                    "WITH value(x) AS (SELECT 'after') INSERT INTO fixture SELECT x FROM value"] {
            XCTAssertThrowsError(try database.execute(sql, readOnly: true))
            XCTAssertEqual(try database.execute("SELECT value FROM fixture", readOnly: true), before)
        }
        _ = try database.execute("PRAGMA data_version", readOnly: true)
        _ = try database.execute("CREATE TABLE native_pomodoro_session (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL)")
        let schema = try database.execute("PRAGMA table_info(native_pomodoro_session)")
        XCTAssertNotEqual(schema, "[]")
        let observed = try database.execute("PRAGMA table_info(native_pomodoro_session)", readOnly: true)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(observed.utf8)) as? NSArray,
                       try JSONSerialization.jsonObject(with: Data(schema.utf8)) as? NSArray)
        XCTAssertThrowsError(try database.execute("PRAGMA table_info(native_pomodoro_session); PRAGMA query_only = ON", readOnly: true))
        XCTAssertThrowsError(try database.execute("PRAGMA foreign_keys = OFF", readOnly: true))
        XCTAssertThrowsError(try database.execute("PRAGMA query_only = ON", readOnly: true))
        _ = try database.execute("INSERT INTO fixture (value) VALUES (?)", parametersJSON: "[\"after\"]")
        XCTAssertEqual(try database.execute("SELECT COUNT(*) AS count FROM fixture", readOnly: true), "[{\"count\":2}]")
    }
}
