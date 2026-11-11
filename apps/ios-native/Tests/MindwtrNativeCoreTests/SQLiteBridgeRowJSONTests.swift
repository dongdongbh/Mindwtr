import Foundation
import SQLite3
import XCTest
@testable import MindwtrNativeCore

final class SQLiteBridgeRowJSONTests: XCTestCase {
    private var root: URL!
    private var database: SQLiteBridge!

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/row-json-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        database = try SQLiteBridge(url: root.appendingPathComponent("fixture.sqlite"))
    }

    override func tearDownWithError() throws {
        database.close()
        try? FileManager.default.removeItem(at: root)
    }

    private func dictionaryRows(_ sql: String) throws -> NSArray {
        var connection: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(root.appendingPathComponent("fixture.sqlite").path, &connection, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(connection) }
        var statement: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(connection, sql, -1, &statement, nil), SQLITE_OK)
        defer { sqlite3_finalize(statement) }
        var rows: [[String: Any]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            var row: [String: Any] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_NULL: row[name] = NSNull()
                case SQLITE_INTEGER: row[name] = sqlite3_column_int64(statement, column)
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, column)
                default:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    row[name] = String(decoding: Data(bytes: sqlite3_column_text(statement, column)!, count: count), as: UTF8.self)
                }
            }
            rows.append(row)
        }
        return try XCTUnwrap(NativeJSON.jsonObject(with: JSONSerialization.data(withJSONObject: rows)) as? NSArray)
    }

    func testRowJSONParsesToTheDictionaryEncodingForEveryCellKind() throws {
        _ = try database.execute("CREATE TABLE cells (id INTEGER PRIMARY KEY, text TEXT, number, real REAL)")
        let texts = ["plain", "quote \" backslash \\ slash /", "line\nfeed\rreturn\ttab", "\u{01}\u{08}\u{0C}\u{1F}\u{7F}",
                     "nul\u{0}inside", "é ü 中文 😀", "\u{FEFF}leading bom", "sep\u{2028}\u{2029}", "", " "]
        for (index, text) in texts.enumerated() {
            let parameters = String(decoding: try JSONSerialization.data(withJSONObject: [index, text]), as: UTF8.self)
            _ = try database.execute("INSERT INTO cells (id, text) VALUES (?, ?)", parametersJSON: parameters)
        }
        let numbers = ["0", "-1", "9223372036854775807", "-9223372036854775808", "9007199254740993", "0.1", "2.0", "-0.0",
                       "1e300", "5e-324", "-3.25", "1e16", "123456789.123456789", "NULL"]
        for (offset, number) in numbers.enumerated() {
            _ = try database.execute("INSERT INTO cells (id, number, real) VALUES (\(100 + offset), \(number), \(number))")
        }
        let sql = "SELECT rowid AS _rowid, * FROM cells ORDER BY id"
        let encoded = try database.execute(sql)
        XCTAssertEqual(try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? NSArray), try dictionaryRows(sql))
        XCTAssertTrue(encoded.hasPrefix("[{\"_rowid\":0,\"id\":0,\"text\":\"plain\",\"number\":null,\"real\":null}"))
        let parsedTexts = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [[String: Any]]).prefix(texts.count)
        XCTAssertEqual(parsedTexts.map { $0["text"] as? String }, texts)
    }

    func testDuplicateColumnNamesKeepFirstPositionAndLastValue() throws {
        let encoded = try database.execute("SELECT 1 AS a, 2 AS b, 3 AS a")
        XCTAssertEqual(encoded, "[{\"a\":3,\"b\":2}]")
        XCTAssertEqual(try database.execute("SELECT 1 AS \"we\"\"ird\\\\name\""), "[{\"we\\\"ird\\\\\\\\name\":1}]")
    }

    func testEmptyResultsInvalidTextAndInfiniteRealsKeepTheirContract() throws {
        _ = try database.execute("CREATE TABLE empty (value TEXT)")
        XCTAssertEqual(try database.execute("SELECT value FROM empty"), "[]")
        XCTAssertThrowsError(try database.execute("SELECT CAST(X'C328' AS TEXT) AS broken"))
        XCTAssertThrowsError(try database.execute("SELECT CAST(X'EDA080' AS TEXT) AS surrogate"))
        XCTAssertThrowsError(try database.execute("SELECT 1e999 AS infinite"))
        XCTAssertThrowsError(try database.execute("SELECT X'00' AS blob"))
    }
}
