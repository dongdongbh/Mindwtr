import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class ReminderResponseRouteHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderResponseRouteHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host() async throws -> CoreHost {
        let value = CoreHost(databaseURL: root.appendingPathComponent("core.sqlite"), bundleURL: bundle)
        addTeardownBlock { await value.close() }
        _ = try await value.start()
        return value
    }
    private func arguments(_ payload: String) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: [payload]), as: UTF8.self)
    }
    private func route(_ core: CoreHost, _ payload: String) async throws -> [String: Any] {
        let raw = try await core.call("iosNotificationOpen", argumentsJSON: arguments(payload))
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    func testActualSharedRoutesUseReviewPrecedenceAndDoNotWriteDomainState() async throws {
        let core = try await host()
        let cases: [(String, String, String?, String?)] = [
            (#"{"actionIdentifier":"open","taskId":"task","kind":"task-review"}"#, "review", "taskId", "task"),
            (#"{"actionIdentifier":"open","projectId":"project","kind":"project-review"}"#, "review", "projectId", "project"),
            (#"{"actionIdentifier":"open","taskId":"task"}"#, "task", "taskId", "task"),
            (#"{"actionIdentifier":"open","projectId":"project"}"#, "project", "projectId", "project"),
            (#"{"actionIdentifier":"open","kind":"context-automation","context":"@home"}"#, "contexts", "token", "@home"),
            (#"{"actionIdentifier":"open","kind":"daily-digest"}"#, "daily-review", nil, nil),
            (#"{"actionIdentifier":"open","kind":"weekly-review"}"#, "weekly-review", nil, nil),
            (#"{"actionIdentifier":"open"}"#, "none", nil, nil),
        ]
        for (payload, type, field, expected) in cases {
            let value = try await route(core, payload)
            XCTAssertEqual(value["type"] as? String, type)
            if let field { XCTAssertEqual(value[field] as? String, expected) }
        }
        let bom = try await route(core, "\u{FEFF}" + #"{"actionIdentifier":"open","taskId":"\uFEFFtask"}"#)
        XCTAssertEqual(bom["taskId"] as? String, "\u{FEFF}task")
        let db = try SQLiteBridge(url: root.appendingPathComponent("core.sqlite")); defer { db.close() }
        for table in ["tasks", "native_request_receipts"] {
            let raw = try db.execute("SELECT COUNT(*) AS count FROM " + table, parametersJSON: "[]")
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [[String: Int]])
            XCTAssertEqual(rows.first?["count"], 0)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("core.sqlite.pending.json").path))
    }

    func testMalformedOrCommandPayloadNeverEntersReadRoute() async throws {
        let core = try await host()
        for raw in ["null", "[]", "{}", #"{"actionIdentifier":"complete","taskId":"task"}"#,
                    #"{"actionIdentifier":"open","taskId":1}"#,
                    #"{"actionIdentifier":"open","unexpected":"value"}"#,
                    #"{"actionIdentifier":"open","taskId":"one","taskId":"two"}"#,
                    #"{"actionIdentifier":"open","taskId":"one","task\u0049d":"two"}"#,
                    String(repeating: " ", count: 65_537) + #"{"actionIdentifier":"open"}"#] {
            do { _ = try await route(core, raw); XCTFail("Expected bounded read refusal") }
            catch { XCTAssertTrue(error is HostFailure || error is CoreHostRejection) }
        }
    }
}
