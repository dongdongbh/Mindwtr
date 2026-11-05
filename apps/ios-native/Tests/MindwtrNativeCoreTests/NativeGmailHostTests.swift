import Foundation
import XCTest
@testable import MindwtrNativeCore

private struct StubGmail: NativeGmailAuthorizing {
    var getError: NativeGmailFailure?
    func status() async throws -> [String: Any] { ["available": true, "connected": true, "account": "tester@example.invalid", "accountId": "a"] }
    func connect() async throws -> [String: Any] { throw NativeGmailFailure.cancelled }
    func cancel() async {}
    func disconnect() async throws -> [String: Any] { ["revoked": true] }
    func get(_ path: String) async throws -> [String: Any] {
        if let getError { throw getError }
        return ["path": path]
    }
}

final class NativeGmailJobsTests: XCTestCase {
    private func answer(_ jobs: NativeGmailJobs) async throws -> [String: Any] {
        for _ in 0..<2_000 {
            if let text = jobs.next() { return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Gmail job did not answer")
        throw CancellationError()
    }

    func testAnswersValueAndFixedErrorCodesOnly() async throws {
        let jobs = NativeGmailJobs(client: StubGmail())
        let get = try jobs.submit(#"{"op":"get","path":"labels"}"#)
        let first = try await answer(jobs)
        XCTAssertEqual(first["id"] as? String, get)
        XCTAssertEqual((first["value"] as? [String: Any])?["path"] as? String, "labels")
        _ = try jobs.submit(#"{"op":"connect"}"#)
        let second = try await answer(jobs)
        XCTAssertEqual(second["error"] as? String, "E_GMAIL_CANCELLED")
        XCTAssertNil(second["value"])
    }

    func testRejectsMalformedRequests() throws {
        let jobs = NativeGmailJobs(client: StubGmail())
        for json in [#"{"op":"get"}"#, #"{"op":"status","path":"x"}"#, #"{"op":"post"}"#, #"{"op":"get","path":""}"#,
                     #"{"op":"status","op":"get"}"#, "[]", String(repeating: "x", count: NativeGmailJobs.maximumRequestBytes + 1)] {
            XCTAssertThrowsError(try jobs.submit(json), json)
        }
    }

    func testClosedJobsDropLateAnswersAndRefuseNewWork() async throws {
        let jobs = NativeGmailJobs(client: StubGmail())
        _ = try jobs.submit(#"{"op":"status"}"#)
        jobs.close()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertNil(jobs.next())
        XCTAssertThrowsError(try jobs.submit(#"{"op":"status"}"#))
    }

    func testUnavailableClientReportsUnavailableWithoutNetwork() async throws {
        let status = try await NativeGmailUnavailable().status()
        XCTAssertEqual(status["available"] as? Bool, false)
        do { _ = try await NativeGmailUnavailable().get("labels"); XCTFail("must refuse") }
        catch { XCTAssertEqual(error as? NativeGmailFailure, .config) }
    }

    func testReceiptFolderMatchesReactNativeDocuments() {
        let container = URL(fileURLWithPath: "/private/var/mobile/Containers/Data/Application/X", isDirectory: true)
        XCTAssertEqual(NativeGmail.receiptFolder(databaseURL: container.appendingPathComponent("Documents/SQLite/mindwtr.db"),
            rnAdoptionContainerURL: container).path, container.path + "/Documents/GmailCapture")
        let support = URL(fileURLWithPath: "/tmp/NativeFoundation/mindwtr.sqlite")
        XCTAssertEqual(NativeGmail.receiptFolder(databaseURL: support, rnAdoptionContainerURL: nil).path, "/tmp/NativeFoundation/GmailCapture")
    }
}

final class NativeGmailReceiptFilesTests: XCTestCase {
    private var folder: URL!
    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("gmail-receipts-" + UUID().uuidString, isDirectory: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    func testFileSeamMatchesTheCoreContract() throws {
        let files = NativeGmailReceiptFiles(folder: folder)
        XCTAssertEqual(try files.file("list", name: "", to: ""), "[]")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        XCTAssertEqual(try files.file("exists", name: "receipts.sqlite", to: ""), "false")
        XCTAssertEqual(try files.file("size", name: "receipts.sqlite", to: ""), "0")
        _ = try files.file("create", name: "receipts.sqlite", to: "")
        XCTAssertThrowsError(try files.file("create", name: "receipts.sqlite", to: ""))
        _ = try files.file("open", name: "receipts.sqlite", to: "")
        _ = try files.sql(name: "receipts.sqlite", sql: "CREATE TABLE receipts (account TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (account, message))", parametersJSON: "[]")
        _ = try files.sql(name: "receipts.sqlite", sql: "INSERT OR IGNORE INTO receipts VALUES (?, ?)", parametersJSON: #"["a","m1"]"#)
        let rows = try JSONSerialization.jsonObject(with: Data(try files.sql(name: "receipts.sqlite", sql: "SELECT account, message FROM receipts", parametersJSON: "[]").utf8)) as? [[String: String]]
        XCTAssertEqual(rows, [["account": "a", "message": "m1"]])
        _ = try files.file("close", name: "receipts.sqlite", to: "")
        XCTAssertThrowsError(try files.sql(name: "receipts.sqlite", sql: "SELECT 1", parametersJSON: "[]"))
        XCTAssertGreaterThan(Int(try files.file("size", name: "receipts.sqlite", to: "")) ?? 0, 100)
        _ = try files.file("create", name: "receipts-reset", to: "")
        _ = try files.file("rename", name: "receipts.sqlite", to: "receipts.corrupt-5.sqlite")
        _ = try files.file("create", name: "receipts.sqlite", to: "")
        XCTAssertThrowsError(try files.file("rename", name: "receipts.sqlite", to: "receipts.corrupt-5.sqlite"))
        XCTAssertEqual(try files.file("list", name: "", to: ""), #"["receipts-reset","receipts.corrupt-5.sqlite","receipts.sqlite"]"#)
        _ = try files.file("remove", name: "receipts-reset", to: "")
        _ = try files.file("remove", name: "receipts-reset", to: "")
        XCTAssertEqual(try files.file("exists", name: "receipts-reset", to: ""), "false")
        files.close()
    }

    func testRefusesNamesOutsideTheReceiptFamily() throws {
        let files = NativeGmailReceiptFiles(folder: folder)
        for name in ["../mindwtr.db", "receipts.sqlite/../x", "mindwtr.sqlite", "receipts.corrupt-x.sqlite", ""] {
            XCTAssertThrowsError(try files.file("exists", name: name, to: ""), name)
        }
        _ = try files.file("create", name: "receipts-reset", to: "")
        XCTAssertThrowsError(try files.file("open", name: "receipts-reset", to: ""))
        XCTAssertThrowsError(try files.file("rename", name: "receipts-reset", to: "other"))
        XCTAssertThrowsError(try files.file("delete", name: "receipts-reset", to: ""))
    }
}

@MainActor
final class NativeGmailCaptureModelTests: XCTestCase {
    private final class Host {
        var calls: [String] = []
        var replies: [String: [String: Any]] = [:]
        var allowed = true
        var imports = 0
        var port: NativeGmailCaptureModel.Port {
            .init(request: { [unowned self] name, input in
                    self.calls.append(input.isEmpty ? name : "\(name) \(input["labelId"] as? String ?? "")")
                    return self.replies[name] ?? ["value": NSNull()]
                }, lifecycle: { [unowned self] state in self.calls.append("lifecycle " + state) },
                canCycle: { [unowned self] in self.allowed }, imported: { [unowned self] in self.imports += 1 })
        }
    }
    private var sleeps: [TimeInterval] = []
    private var gates: [CheckedContinuation<Void, Error>] = []
    private func model() -> NativeGmailCaptureModel {
        NativeGmailCaptureModel(sleep: { [unowned self] seconds in
            self.sleeps.append(seconds)
            try await withCheckedThrowingContinuation { self.gates.append($0) }
        })
    }
    private func settle() async { for _ in 0..<50 { await Task.yield() } }
    private func fire() async { if !gates.isEmpty { gates.removeFirst().resume() }; await settle() }

    func testForegroundStartsAfterOneSecondThenEveryFiveMinutesAndStopsBehind() async {
        let host = Host(), gmail = model()
        host.replies["status"] = ["value": ["lastImportCount": 0, "lastError": NSNull(), "terminal": false]]
        gmail.bind(host.port)
        gmail.setActive(true)
        await settle()
        XCTAssertEqual(sleeps, [1])
        XCTAssertEqual(host.calls, [])
        await fire()
        XCTAssertEqual(host.calls, ["lifecycle active", "checkNow", "status"])
        XCTAssertEqual(sleeps, [1, 300])
        gmail.setActive(false)
        await settle()
        XCTAssertEqual(host.calls.last, "lifecycle background")
        await fire()
        XCTAssertEqual(host.calls.filter { $0 == "checkNow" }.count, 1)
    }

    func testImportedPageContinuesSoonAndRefreshesLists() async {
        let host = Host(), gmail = model()
        host.replies["status"] = ["value": ["lastImportCount": 3, "lastError": NSNull(), "terminal": false]]
        gmail.bind(host.port); gmail.setActive(true)
        await settle(); await fire()
        XCTAssertEqual(host.imports, 1)
        XCTAssertEqual(sleeps, [1, 1])
    }

    func testBusyAppDefersTheCycleUntilAdmitted() async {
        let host = Host(), gmail = model()
        host.allowed = false
        gmail.bind(host.port); gmail.setActive(true)
        await settle(); await fire()
        XCTAssertEqual(host.calls, ["lifecycle active"])
        host.allowed = true
        gmail.admit()
        await settle()
        XCTAssertEqual(host.calls.filter { $0 == "checkNow" }.count, 1)
    }

    func testResetNoticeStaysThroughConnectAndCheckAndGoesOnlyWhenCaptureStarts() async {
        let host = Host(), gmail = model()
        host.replies["config"] = ["value": ["available": true, "connected": true, "account": "a@b.c", "accountId": "x", "labelId": NSNull(), "enabled": false]]
        host.replies["receiptsReset"] = ["value": true]
        host.replies["labels"] = ["value": [["id": "L1", "name": "Mindwtr"]]]
        host.replies["connect"] = host.replies["config"]
        host.replies["configure"] = ["value": ["available": true, "connected": true, "account": "a@b.c", "accountId": "x", "labelId": "L1", "enabled": true]]
        gmail.bind(host.port)
        await gmail.mount()
        XCTAssertEqual(gmail.labelId, "L1")
        XCTAssertEqual(gmail.shownError, NativeGmailCaptureModel.receiptsResetKey)
        gmail.connect(); await settle()
        XCTAssertEqual(gmail.shownError, NativeGmailCaptureModel.receiptsResetKey)
        gmail.checkNow(); await settle()
        XCTAssertEqual(gmail.shownError, NativeGmailCaptureModel.receiptsResetKey)
        gmail.save(); await settle()
        XCTAssertNil(gmail.shownError)
        XCTAssertTrue(gmail.enabled)
        XCTAssertTrue(host.calls.contains("configure L1"))
        XCTAssertTrue(host.calls.contains("clearReceiptsReset"))
    }

    func testFailedSaveKeepsTheNoticeAndShowsTheFixedError() async {
        let host = Host(), gmail = model()
        host.replies["config"] = ["value": ["available": true, "connected": true, "account": "a@b.c", "accountId": "x", "labelId": "L1", "enabled": false]]
        host.replies["receiptsReset"] = ["value": true]
        host.replies["labels"] = ["value": [["id": "L1", "name": "Inbox"]]]
        host.replies["configure"] = ["errorKey": "settings.gmailCaptureNetworkFailed"]
        gmail.bind(host.port)
        await gmail.mount()
        gmail.save(); await settle()
        XCTAssertEqual(gmail.shownError, "settings.gmailCaptureNetworkFailed")
        XCTAssertTrue(gmail.receiptsReset)
        XCTAssertFalse(host.calls.contains("clearReceiptsReset"))
    }

    func testRebindingRetiresEveryOldAnswer() async {
        let host = Host(), gmail = model()
        host.replies["config"] = ["value": ["available": false, "connected": false, "enabled": false]]
        gmail.bind(host.port)
        await gmail.mount()
        XCTAssertFalse(gmail.available)
        gmail.bind(nil)
        XCTAssertNil(gmail.config)
        XCTAssertFalse(gmail.available)
        gmail.connect()
        XCTAssertNil(gmail.operation)
    }
}
