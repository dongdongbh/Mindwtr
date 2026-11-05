import Foundation
import XCTest
@testable import MindwtrNativeCore

final class WidgetNextPublicationHostTests: XCTestCase {
    func testActualPublicationAndOpenDiagnosticsAreClosedAndDoNotWriteDomainData() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("WidgetNextPublicationHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = root.appendingPathComponent("mindwtr.sqlite"), faults = HostIOFaults()
        var writes = 0
        faults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\b"#, options: .regularExpression) != nil { writes += 1 } }
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), faults: faults)
        addTeardownBlock { await core.close(); try FileManager.default.removeItem(at: root) }
        _ = try await core.start()
        func json(_ value: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
        }
        func rows() throws -> [String: String] {
            let sql = try SQLiteBridge(url: database); defer { sql.close() }
            return try Dictionary(uniqueKeysWithValues: ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"].map {
                ($0, try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + $0 + " ORDER BY rowid").utf8))))
            })
        }
        _ = try await core.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
        ])]))
        writes = 0
        let before = try rows()
        for count in [0, 13] {
            _ = try await core.call("logLine", argumentsJSON: json(["Native iOS Next widget published",
                try json(["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": count])]))
        }
        _ = try await core.call("logLine", argumentsJSON: json(["Native iOS Next widget task opened",
            #"{"releaseCheck":"v1.3.8/ios-widget-next-open","outcome":"opened"}"#]))
        let share = try await core.diagnosticsFileAction("logShare")
        let export = try XCTUnwrap(NativeJSON.jsonObject(with: Data(share.utf8)) as? [String: Any])
        let log = try await core.validatedDiagnosticsShareURL(XCTUnwrap(export["path"] as? String))
        let logBefore = try Data(contentsOf: log)
        let entries = try String(decoding: logBefore, as: UTF8.self).split(separator: "\n").map {
            try XCTUnwrap(NativeJSON.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
        XCTAssertEqual(entries.filter { $0["message"] as? String == "Native iOS Next widget published" }.count, 2)
        XCTAssertEqual(entries.filter { $0["message"] as? String == "Native iOS Next widget task opened" }.count, 1)
        let invalid: [(String, [String: Any])] = [
            ("Native iOS Next widget published", ["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": true]),
            ("Native iOS Next widget published", ["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": -1]),
            ("Native iOS Next widget published", ["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": 14]),
            ("Native iOS Next widget published", ["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": "1"]),
            ("Native iOS Next widget published", ["releaseCheck": "v1.3.8/ios-widget-next-publication", "count": 1, "id": "synthetic"]),
            ("Native iOS Next widget task opened", ["releaseCheck": "v1.3.8/ios-widget-next-open", "outcome": "refused"]),
            ("Native iOS Next widget task opened", ["releaseCheck": "v1.3.8/ios-widget-next-open", "outcome": "opened", "url": "synthetic"]),
        ]
        for (message, context) in invalid {
            do { _ = try await core.call("logLine", argumentsJSON: json([message, try json(context)])); XCTFail("Unaudited diagnostic must refuse") }
            catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), logBefore)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(writes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }
}
