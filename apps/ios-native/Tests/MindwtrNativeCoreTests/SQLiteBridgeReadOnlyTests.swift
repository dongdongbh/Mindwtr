import Foundation
import XCTest
@testable import MindwtrNativeCore

final class SQLiteBridgeReadOnlyTests: XCTestCase {
    func testReadOnlyExecutionRejectsWritesBeforeStepAndPreservesDefaultWrites() throws {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
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
        XCTAssertThrowsError(try database.execute("PRAGMA foreign_keys = OFF", readOnly: true))
        XCTAssertThrowsError(try database.execute("PRAGMA query_only = ON", readOnly: true))
        _ = try database.execute("INSERT INTO fixture (value) VALUES (?)", parametersJSON: "[\"after\"]")
        XCTAssertEqual(try database.execute("SELECT COUNT(*) AS count FROM fixture", readOnly: true), "[{\"count\":2}]")
    }
}
