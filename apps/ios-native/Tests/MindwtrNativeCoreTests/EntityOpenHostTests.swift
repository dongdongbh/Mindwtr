import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class EntityOpenHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private let at = "2026-10-09T00:00:00.000Z"
    private let taskID = "opaque task/漢+😀", projectID = "opaque project:漢/+"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("EntityOpenHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host() -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle)
        addTeardownBlock { await value.close() }
        return value
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func link(_ query: String) -> String { "mindwtr-native-dev://open?" + query }
    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    }
    private func route(_ core: CoreHost, _ url: String) async throws -> [String: String] {
        let raw = try await core.call("iosEntityOpen", argumentsJSON: json([url]))
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: String])
    }
    private func seed() async throws {
        let bootstrap = host(); _ = try await bootstrap.start(); await bootstrap.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        for (id, status, deleted) in [(taskID, "inbox", false), ("reference-task", "reference", false),
                                      ("deleted-task", "next", true), (String(repeating: "😀", count: 250), "inbox", false),
                                      (String(repeating: "😀", count: 250) + "x", "inbox", false)] {
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,deletedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'PRIVATE_TASK',?,'[]','[]','PRIVATE_NOTES',?,?,?,3,'fixture',0,0,0,0)",
                                parametersJSON: json([id, status, at, at, deleted ? at as Any : NSNull()]))
        }
        for (id, status, deleted) in [(projectID, "active", false), ("archived-project", "archived", false),
                                      ("deleted-project", "active", true), (String(repeating: "p", count: 500), "active", false),
                                      (String(repeating: "p", count: 501), "active", false)] {
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,'PRIVATE_PROJECT',?,'#123456',0,'[]',0,0,'PRIVATE_PROJECT_NOTES',?,?,?,4,'fixture')",
                                parametersJSON: json([id, status, at, at, deleted ? at as Any : NSNull()]))
        }
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        var result: [String: String] = [:]
        for table in ["tasks", "projects", "settings", "native_request_receipts"] {
            let raw = try sql.execute("SELECT * FROM " + table + " ORDER BY rowid", parametersJSON: "[]")
            result[table] = try json(NativeJSON.jsonObject(with: Data(raw.utf8)))
        }
        return result
    }

    func testActualEntityLookupUsesSharedPrecedenceAndWritesNoDomainRows() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let before = try rows()
        let cases: [(String, [String: String])] = [
            (link("task=" + encoded(taskID)), ["type": "task", "taskId": taskID]),
            (link("project=" + encoded(projectID)), ["type": "project", "projectId": projectID]),
            ("MINDWTR-NATIVE-DEV:///OPEN?task=" + encoded(taskID), ["type": "task", "taskId": taskID]),
            (link("task=reference-task"), ["type": "task", "taskId": "reference-task"]),
            (link("project=archived-project"), ["type": "project", "projectId": "archived-project"]),
            (link("project=" + encoded(projectID) + "&task=" + encoded(taskID)), ["type": "task", "taskId": taskID]),
            (link("task=" + encoded(taskID) + "&task=missing"), ["type": "task", "taskId": taskID]),
            (link("task=&task=" + encoded(taskID) + "&project=" + encoded(projectID)), ["type": "project", "projectId": projectID]),
            (link("task=%20" + encoded(taskID) + "%20"), ["type": "task", "taskId": taskID]),
            (link("task=" + encoded(taskID) + "&library=other&mode=rehearsal"), ["type": "task", "taskId": taskID]),
            (link("task=missing&project=" + encoded(projectID)), ["type": "inbox"]),
            (link("task=missing"), ["type": "inbox"]), (link("project=missing"), ["type": "inbox"]),
            (link("task=deleted-task"), ["type": "inbox"]), (link("project=deleted-project"), ["type": "inbox"]),
            (link("task=%20&project="), ["type": "inbox"]), (link("task=%E0%A4%A"), ["type": "inbox"]),
            (link("task=" + encoded(String(repeating: "😀", count: 250))), ["type": "task", "taskId": String(repeating: "😀", count: 250)]),
            (link("task=" + encoded(String(repeating: "😀", count: 250) + "x")), ["type": "none"]),
            (link("project=" + String(repeating: "p", count: 500)), ["type": "project", "projectId": String(repeating: "p", count: 500)]),
            (link("project=" + String(repeating: "p", count: 501)), ["type": "none"]),
        ]
        for (index, entry) in cases.enumerated() {
            let (url, expected) = entry
            let actual = try await route(core, url)
            XCTAssertEqual(actual, expected, "Synthetic entity-link case \(index)")
        }
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testUnsupportedSchemesAndCapabilitiesStayClosed() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let before = try rows()
        for url in ["mindwtr://open?task=reference-task", "https://open?task=reference-task",
                    "mindwtr-native-row://open?task=reference-task", "mindwtr-native-dev://capture?title=PRIVATE",
                    "mindwtr-native-dev://open-feature?feature=capture", "mindwtr-native-dev://global-search?q=PRIVATE",
                    "mindwtr-native-dev://share", "mindwtr-native-dev://oauth", "mindwtr-native-dev://focus",
                    link("area=a"), link("task=&project=%20&area=a"), "PRIVATE_BAD_URL", ""] {
            let actual = try await route(core, url)
            XCTAssertEqual(actual, ["type": "none"])
        }
        do {
            _ = try await core.call("menuRead", argumentsJSON: json(["entryPoint", "{}"]))
            XCTFail("Generic entryPoint must remain unavailable")
        } catch { XCTAssertTrue(error is HostFailure || error is CoreHostRejection) }
        XCTAssertEqual(try rows(), before)
    }

    func testReadWaitsForCanonicalStartup() async throws {
        try await seed()
        let core = host()
        do {
            _ = try await route(core, link("task=reference-task"))
            XCTFail("No destination may resolve before startup")
        } catch { XCTAssertTrue(error is HostFailure || error is CoreHostRejection) }
        _ = try await core.start()
        let actual = try await route(core, link("task=reference-task"))
        XCTAssertEqual(actual, ["type": "task", "taskId": "reference-task"])
    }

    func testTransportAndUTF16BoundsRejectBeforeInvokeWithoutPoisoningHost() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let before = try rows(), prefix = link("task=reference-task&ignored=")
        let available = 16_000 - prefix.utf16.count
        let exactURL = prefix + String(repeating: "😀", count: available / 2) + String(repeating: "x", count: available % 2)
        XCTAssertEqual(exactURL.utf16.count, 16_000)
        let exact = try await route(core, exactURL)
        XCTAssertEqual(exact, ["type": "task", "taskId": "reference-task"])
        let validArgs = try json([link("task=reference-task")])
        let transport = validArgs + String(repeating: " ", count: 128_000 - validArgs.utf8.count)
        XCTAssertEqual(transport.utf8.count, 128_000)
        let exactTransport = try await core.call("iosEntityOpen", argumentsJSON: transport)
        XCTAssertEqual(try XCTUnwrap(NativeJSON.jsonObject(with: Data(exactTransport.utf8)) as? [String: String]), ["type": "task", "taskId": "reference-task"])
        for raw in ["null", "{}", "[1]", "[true]", "[null]", "[{}]", "[]", "[\"one\",\"two\"]", "PRIVATE_BAD_JSON",
                    try json([exactURL + "x"]), transport + " "] {
            do {
                _ = try await core.call("iosEntityOpen", argumentsJSON: raw)
                XCTFail("Expected bounded entity input refusal")
            } catch let failure as HostFailure { XCTAssertTrue(failure.message.hasPrefix("INVALID_INPUT:")) }
        }
        let afterInvalid = try await route(core, link("task=reference-task"))
        XCTAssertEqual(afterInvalid, ["type": "task", "taskId": "reference-task"])
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    private func productionRoute(_ core: CoreHost, _ url: String) async throws -> [String: String] {
        let raw = try await core.call("iosProductionWidgetTaskOpen", argumentsJSON: json([url]))
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: String])
    }

    func testActualProductionTaskLookupUsesCurrentLibraryAndKeepsDevReadClosed() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let before = try rows()
        let values: [(String, [String: String])] = [
            ("mindwtr://open?task=" + encoded(taskID), ["type": "task", "taskId": taskID]),
            ("MINDWTR:///OPEN?task=" + encoded(taskID), ["type": "task", "taskId": taskID]),
            ("mindwtr://open?task=reference-task", ["type": "task", "taskId": "reference-task"]),
            ("mindwtr://open?task=missing", ["type": "inbox"]),
            ("mindwtr://open?task=deleted-task", ["type": "inbox"]),
            ("mindwtr://open?task=missing&project=" + encoded(projectID), ["type": "inbox"]),
            ("mindwtr://open?task=" + encoded(taskID) + "&library=other&mode=rehearsal", ["type": "task", "taskId": taskID])]
        for (url, expected) in values {
            let production = try await productionRoute(core, url), dev = try await route(core, url)
            XCTAssertEqual(production, expected)
            XCTAssertEqual(dev, ["type": "none"])
        }
        for url in [link("task=reference-task"), "https://open?task=reference-task", "mindwtr:///focus", "mindwtr:///inbox",
                    "mindwtr:///capture-quick?mode=text", "mindwtr:///waiting", "mindwtr:///someday",
                    "mindwtr:///widget-list/next", "mindwtr://open?project=" + encoded(projectID), "mindwtr://open?area=a"] {
            let value = try await productionRoute(core, url)
            XCTAssertEqual(value, ["type": "none"])
        }
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testProductionTaskReadRetainsStartupRestrictedAndTransportBounds() async throws {
        try await seed()
        let core = host(), url = "mindwtr://open?task=reference-task"
        do { _ = try await productionRoute(core, url); XCTFail("Canonical startup must precede resolution") } catch {}
        _ = try await core.start()
        let before = try rows(), prefix = url + "&ignored="
        let remaining = 16_000 - prefix.utf16.count
        let exact = prefix + String(repeating: "😀", count: remaining / 2) + String(repeating: "x", count: remaining % 2)
        let exactTarget = try await productionRoute(core, exact)
        XCTAssertEqual(exactTarget, ["type": "task", "taskId": "reference-task"])
        let valid = try json([url]), transport = valid + String(repeating: " ", count: 128_000 - valid.utf8.count)
        _ = try await core.call("iosProductionWidgetTaskOpen", argumentsJSON: transport)
        for input in ["null", "{}", "[]", "[true]", "[1]", "[null]", "[{}]", "[\"a\",\"b\"]", try json([exact + "x"]), transport + " "] {
            do { _ = try await core.call("iosProductionWidgetTaskOpen", argumentsJSON: input); XCTFail("Expected bounded production task URL refusal") } catch {}
        }
        let restricted = CoreHost(databaseURL: database, bundleURL: bundle, workspaceMode: .restricted)
        addTeardownBlock { await restricted.close() }
        do { _ = try await productionRoute(restricted, url); XCTFail("Restricted hosts cannot dispatch production links") } catch {}
        XCTAssertEqual(try rows(), before)
        let devTarget = try await route(core, link("task=reference-task"))
        XCTAssertEqual(devTarget, ["type": "task", "taskId": "reference-task"])
    }

    func testColdRetainedProductionTaskURLResolvesActualTaskBeforeExistingFinishReceipt() async throws {
        try await seed()
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/personal-intake/" + UUID().uuidString.lowercased() + "/home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home.deletingLastPathComponent()) }
        let fixtureRoute = try NativePersonalIntakeRoute.fixture(home: home)
        let intake = try NativePersonalIntake(route: fixtureRoute, diagnostic: { _ in })
        addTeardownBlock { await intake.close() }
        let event = try NativePersonalIntakeEvent.url("mindwtr://open?task=" + encoded(taskID))
        let captured = try await intake.capture(event)
        XCTAssertEqual(captured.stage, .captured)
        await intake.close()
        let cold = try NativePersonalIntake(route: fixtureRoute, diagnostic: { _ in })
        addTeardownBlock { await cold.close() }
        let pending = try await cold.pendingPage(), original = try XCTUnwrap(pending.items.first)
        XCTAssertEqual(Data(try XCTUnwrap(original.event?.text).utf8), Data(try XCTUnwrap(event.text).utf8))
        let admitting = try await cold.markAdmitting(original)
        let core = host(); _ = try await core.start()
        let before = try rows(), target = try await productionRoute(core, XCTUnwrap(admitting.event?.text))
        XCTAssertEqual(target, ["type": "task", "taskId": taskID])
        let viewJSON = try await core.call("taskView", argumentsJSON: json([json(["id": XCTUnwrap(target["taskId"])])]))
        let view = try XCTUnwrap(NativeJSON.jsonObject(with: Data(viewJSON.utf8)) as? [String: Any])
        let presentedRows = try XCTUnwrap(view["rows"] as? [[String: Any]])
        XCTAssertEqual(presentedRows.first?["type"] as? String, "title")
        XCTAssertEqual(presentedRows.first?["value"] as? String, "PRIVATE_TASK")
        XCTAssertFalse(try XCTUnwrap(view["revision"] as? String).isEmpty)
        try await cold.finish(admitting, outcome: .completed)
        let receipt = try await cold.settleFinish(admitting, outcome: .completed)
        XCTAssertEqual(receipt.id, event.id); XCTAssertEqual(receipt.sequence, admitting.sequence)
        XCTAssertEqual(receipt.outcome, .completed); XCTAssertEqual(receipt.kind, .url)
        XCTAssertEqual(try rows(), before)
        await cold.close(); await core.close()
        let terminal = try NativePersonalIntake(route: fixtureRoute, diagnostic: { _ in })
        addTeardownBlock { await terminal.close() }
        let page = try await terminal.pendingPage(); XCTAssertTrue(page.items.isEmpty)
        let replay = try await terminal.capture(event)
        XCTAssertEqual(replay.stage, .terminal); XCTAssertNil(replay.event); XCTAssertEqual(replay.outcome, .completed)
    }
}
