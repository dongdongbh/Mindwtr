import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CalendarFileHostNoNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { XCTFail("Local Calendar must not fetch HTTP"); client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}
private final class CalendarFileHostIO: @unchecked Sendable {
    let provider = CalendarTestReader()
    private let lock = NSLock()
    private var cut: String?, journalWrites = 0, completed = false, closed = false, factories = 0
    private var calendar: NativeCalendarJobs?
    private var device: NativeDeviceKV?
    func storage(_ value: NativeDeviceKV) { lock.lock(); device = value; lock.unlock() }
    func changeLegacy(_ raw: String) throws { lock.lock(); let storage = device; lock.unlock(); try XCTUnwrap(storage).set("mindwtr-external-calendars", raw) }
    func arm(_ value: String?) { lock.lock(); cut = value; journalWrites = 0; lock.unlock() }
    func beforeSQL(_ sql: String) throws {
        lock.lock(); let fail = cut == "commit" && sql == "COMMIT" || cut == "lostBlocked" && sql.hasPrefix("BEGIN")
        let legacy = cut == "legacy" && sql == "COMMIT", storage = device; if legacy { cut = nil }; lock.unlock()
        if legacy { try XCTUnwrap(storage).set("mindwtr-external-calendars", "[]") }
        if fail { throw HostFailure("Local Calendar fixture COMMIT failure") }
    }
    func afterSQL(_ sql: String) throws {
        lock.lock(); let fail = cut == "lost" && sql == "COMMIT"; if fail { cut = "lostBlocked" }; lock.unlock()
        if fail { throw HostFailure("Local Calendar fixture lost COMMIT reply") }
    }
    func journal() throws {
        lock.lock(); journalWrites += 1; let fail = cut == "journal" || cut == "terminal" && journalWrites == 2; lock.unlock()
        if fail { throw HostFailure("Local Calendar fixture journal failure") }
    }
    func clear() throws { lock.lock(); let fail = cut == "clear"; lock.unlock(); if fail { throw HostFailure("Local Calendar fixture clear failure") } }
    func reader() -> any NativeCalendarReading { lock.lock(); factories += 1; lock.unlock(); return provider }
    func capture(_ jobs: NativeCalendarJobs) { lock.lock(); calendar = jobs; lock.unlock() }
    func settled() { lock.lock(); completed = true; lock.unlock() }
    func didClose() { lock.lock(); closed = true; lock.unlock() }
    var hasSettled: Bool { lock.lock(); defer { lock.unlock() }; return completed }
    var hasClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
    var readerCount: Int { lock.lock(); defer { lock.unlock() }; return factories }
    var counters: (jobs: Int, running: Int)? { lock.lock(); let value = calendar; lock.unlock(); return value?.counters }
}

final class NativeCalendarLocalFileHostTests: XCTestCase {
    private struct Library {
        let root: URL
        let namespace = "tech.example.mindwtr.calendar-file"
        var database: URL { root.appendingPathComponent("core.sqlite") }
        var journal: URL { database.appendingPathExtension("pending.json") }
        var container: URL { root.appendingPathComponent("container") }
        var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    }
    private var root: URL!, bundle: URL!
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let pathRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/calendar-local-files/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: pathRoot, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(pathRoot.path, nil) else { throw HostFailure("Local Calendar fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func library(_ name: String) throws -> Library {
        let value = Library(root: root.appendingPathComponent(name))
        try FileManager.default.createDirectory(at: value.manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown-device-cell": "raw 文",
            "mindwtr-system-calendar-settings": json(["enabled": false, "selectAll": false, "selectedCalendarIds": []])]).utf8).write(to: value.manifest)
        return value
    }
    private func host(_ library: Library, io: CalendarFileHostIO = CalendarFileHostIO(),
                      configure: (HostIOFaults) -> Void = { _ in }) -> CoreHost {
        let faults = HostIOFaults()
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.afterSQL = { try io.afterSQL($0) }
        faults.journalWrite = { try io.journal() }; faults.journalRemove = { try io.clear() }
        faults.calendarReaderFactory = { io.reader() }; faults.configureCalendarJobs = { io.capture($0) }
        faults.configureDeviceStorage = { io.storage($0) }
        faults.calendarAuthorizationRequest = { XCTFail("Local Calendar cannot prompt EventKit"); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.secretBeforeOperation = { _, _ in XCTFail("Local Calendar cannot access secrets") }
        faults.cryptoBeforeOperation = { _ in XCTFail("Local Calendar cannot access crypto") }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CalendarFileHostNoNetwork.self]; faults.httpConfiguration = config
        configure(faults)
        let core = CoreHost(databaseURL: library.database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: library.container, bundleIdentifier: library.namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func sql(_ library: Library, _ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: library.database); defer { db.close() }; return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func settings(_ library: Library) throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql(library, "SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
    }
    private func receiptCount(_ library: Library) throws -> Int {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql(library, "SELECT count(*) AS count FROM native_request_receipts").utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first?["count"] as? Int)
    }
    private func replaceSubscriptions(_ core: CoreHost, _ library: Library, _ feeds: [[String: Any]]?) async throws {
        let export = try await core.prepareDataBackup(); var document = try object(String(contentsOf: export.url, encoding: .utf8))
        await core.discardDataBackup(export.id)
        var values = try XCTUnwrap(document["settings"] as? [String: Any]); values["externalCalendars"] = feeds; document["settings"] = values
        let selected = library.root.appendingPathComponent("replace-" + UUID().uuidString + ".json")
        try json(document).write(to: selected, atomically: true, encoding: .utf8)
        let preview = try await core.prepareBackupImport(selected, action: .replace); _ = try await core.mergeBackupImport(preview.id)
    }
    private func request(_ core: CoreHost, name: String = "", defaultName: String = "Captured Calendar") async throws -> String {
        let options = try object(await core.getCalendarSubscriptionOptions()), expected = try XCTUnwrap(options["expected"] as? [String: Any])
        return try json(["requestId": UUID().uuidString.lowercased(), "name": name, "defaultName": defaultName, "expected": expected])
    }
    private func source(_ library: Library, name: String = "PRIVATE_PICKED_CALENDAR.ICS", bytes: Data? = nil) throws -> URL {
        let selected = library.root.appendingPathComponent(name); try (bytes ?? ics()).write(to: selected); return selected
    }
    private func ics() -> Data {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        let start = Date(), end = start.addingTimeInterval(3600)
        return Data("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-local-fixture\r\nDTSTART:\(formatter.string(from: start))\r\nDTEND:\(formatter.string(from: end))\r\nSUMMARY:PRIVATE_LOCAL_EVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n".utf8)
    }
    private func result(_ raw: String) throws {
        XCTAssertEqual(try json(object(raw)), try json(["changed": true, "toasts": [], "open": NSNull(), "clearDraft": true]))
    }
    private func toast(_ core: CoreHost, tone: String) async throws {
        let value = try object(await core.calendarRead(requestJSON: "{\"op\":\"testSettings\"}"))
        let toasts = try XCTUnwrap(value["toasts"] as? [[String: Any]])
        XCTAssertEqual(toasts.count, 1); XCTAssertEqual(toasts.first?["tone"] as? String, tone)
    }
    private func file(_ raw: String) throws -> URL { try XCTUnwrap(URL(string: XCTUnwrap(object(raw)["url"] as? String))) }
    private func privacy(_ library: Library) throws {
        let receipts = try sql(library, "SELECT request_id,method,reply FROM native_request_receipts")
        let logs = (try? String(contentsOf: library.root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        for text in [receipts, logs] { for forbidden in ["PRIVATE_PICKED", "PRIVATE_LOCAL_EVENT", "calendar-files/", library.root.path] { XCTAssertFalse(text.contains(forbidden)) } }
    }
    private func canLock(_ library: Library) -> Bool {
        let fd = Darwin.open(library.database.appendingPathExtension("host-lock").path, O_RDWR | O_NOFOLLOW)
        guard fd >= 0 else { return false }; defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { return false }; _ = flock(fd, LOCK_UN); return true
    }

    func testActualCaptureAddReadAndReviewUseImmutableBytesAndSharedFilenameNaming() async throws {
        let library = try library("capture-read"), io = CalendarFileHostIO(), core = host(library, io: io)
        _ = try await core.start(); let selected = try source(library), original = try Data(contentsOf: selected), local = try Data(contentsOf: library.manifest)
        let receipts = try receiptCount(library), input = try await request(core)
        let added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input); try result(added.resultJSON)
        let frozen = try object(added.requestJSON), owned = try file(added.requestJSON)
        XCTAssertEqual(frozen["name"] as? String, "PRIVATE_PICKED_CALENDAR")
        XCTAssertEqual(frozen["defaultName"] as? String, "Captured Calendar"); XCTAssertTrue(owned.path.contains("/attachment-files/documents/calendar-files/"))
        XCTAssertEqual(try Data(contentsOf: owned), original); XCTAssertEqual(try Data(contentsOf: library.manifest), local)
        try Data("provider changed".utf8).write(to: selected); try FileManager.default.removeItem(at: selected)
        XCTAssertEqual(io.readerCount, 0)
        _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}")
        let providerReads = io.provider.operations; try await toast(core, tone: "success")
        let formatter = ISO8601DateFormatter(), start = Date().addingTimeInterval(-86_400), end = Date().addingTimeInterval(86_400)
        for slot in ["calendar", "dailyReview", "weeklyReview"] {
            let feed = try object(await core.calendarRead(requestJSON: json(["op": "feed", "slot": slot, "start": formatter.string(from: start), "end": formatter.string(from: end), "refresh": true])))
            XCTAssertEqual(feed["status"] as? String, "ready")
            XCTAssertTrue(try json(feed).contains("PRIVATE_LOCAL_EVENT"))
        }
        XCTAssertEqual(io.provider.operations, providerReads); XCTAssertEqual(io.counters?.jobs, 0); XCTAssertEqual(try receiptCount(library), receipts + 1)
        try result(await core.addCalendarSubscription(requestJSON: added.requestJSON)); XCTAssertEqual(try receiptCount(library), receipts + 1)
        XCTAssertEqual(try Data(contentsOf: owned), original); try privacy(library)
    }

    func testPrivateInputRawDuplicatesBlankDefaultAndOversizeRefuseBeforeCopy() async throws {
        let library = try library("capture-invalid"), core = host(library); _ = try await core.start()
        let selected = try source(library), input = try await request(core), value = try object(input), before = try json(settings(library)), receipts = try receiptCount(library)
        var unknown = value; unknown["url"] = selected.absoluteString
        var blank = value; blank["defaultName"] = " \u{FEFF} "
        var long = value; long["name"] = String(repeating: "😀", count: 251)
        let duplicate = String(input.dropLast()) + ",\"requestId\":\"" + (try XCTUnwrap(value["requestId"] as? String)) + "\"}"
        for invalid in try [json(unknown), json(blank), json(long), duplicate, input + String(repeating: " ", count: 1_048_577 - input.utf8.count)] {
            do { _ = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: invalid); XCTFail("Invalid capture request must refuse") }
            catch let failure as NativeCalendarFileAddFailure { XCTAssertNil(failure.requestJSON); XCTAssertEqual(failure.localizedDescription, "Local calendar subscription could not be added") }
        }
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        let directory = library.root.appendingPathComponent("attachment-files/documents/calendar-files")
        XCTAssertTrue((try? FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty) ?? true)
        do { _ = try await core.call("calendarSubscriptionFileAddRequest", argumentsJSON: json([input])); XCTFail("Generic call cannot mint captured Add request") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
    }

    func testCapturedAddJournalCommitTerminalAndCleanupCutsRetainExactFileAndRetryRequest() async throws {
        for cut in ["journal", "commit", "terminal", "clear"] {
            let library = try library(cut), io = CalendarFileHostIO(), core = host(library, io: io)
            _ = try await core.start(); let selected = try source(library), bytes = try Data(contentsOf: selected), input = try await request(core), receipts = try receiptCount(library)
            io.arm(cut); var frozen: String?
            do { _ = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input); XCTFail("Cut must retain exact uncertainty") }
            catch let failure as NativeCalendarFileAddFailure { frozen = failure.requestJSON; XCTAssertEqual(failure.localizedDescription, "Local calendar subscription could not be added") }
            let raw = try XCTUnwrap(frozen), owned = try file(raw); XCTAssertEqual(try Data(contentsOf: owned), bytes)
            try FileManager.default.removeItem(at: selected)
            io.arm(nil); try result(await core.addCalendarSubscription(requestJSON: raw))
            XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
            try result(await core.probeCalendarSubscriptionAddOutcome(requestJSON: raw)); XCTAssertEqual(try Data(contentsOf: owned), bytes)
            XCTAssertEqual(io.readerCount, 0); try privacy(library); await core.close()
        }
    }

    func testCapturedLostCommitKeepsFreshRuntimeSignalAndColdReceiptWithoutRecopy() async throws {
        let library = try library("lost"), io = CalendarFileHostIO(), core = host(library, io: io)
        _ = try await core.start(); let selected = try source(library), input = try await request(core), receipts = try receiptCount(library)
        io.arm("lost"); var frozen: String?
        do { _ = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input); XCTFail("Lost reply is uncertain") }
        catch let failure as NativeCalendarFileAddFailure { frozen = failure.requestJSON }
        let raw = try XCTUnwrap(frozen), owned = try file(raw), bytes = try Data(contentsOf: owned)
        XCTAssertEqual(try receiptCount(library), receipts + 1)
        var later = try settings(library); later["externalCalendars"] = []; later["unrelatedLater"] = "preserve later SQL"
        _ = try sql(library, "UPDATE settings SET data=? WHERE id=1", [json(later)])
        do { _ = try await core.addCalendarSubscription(requestJSON: raw); XCTFail("Dirty receipt requires runtime retirement") }
        catch { XCTAssertEqual(error.localizedDescription, "SAVE_FAILED: Calendar subscription save requires fresh runtime recovery") }
        io.arm(nil); let startup = try object(await core.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionAddCommit"); try result(json(try XCTUnwrap(recovery["result"])))
        XCTAssertEqual(try json(settings(library)), try json(later)); XCTAssertEqual(try receiptCount(library), receipts + 1)
        XCTAssertEqual(try Data(contentsOf: owned), bytes); try privacy(library)
    }

    func testTypedCaptureFailurePreservesExactFreshRuntimeDescriptionAndFrozenRequest() async throws {
        let library = try library("typed-fresh"), io = CalendarFileHostIO(), core = host(library, io: io)
        _ = try await core.start(); try await replaceSubscriptions(core, library, nil)
        let input = try await request(core), selected = try source(library), before = try json(settings(library)), receipts = try receiptCount(library)
        XCTAssertEqual((try object(input)["expected"] as? [String: Any])?["source"] as? String, "legacy")
        io.arm("legacy"); var frozen: String?
        do { _ = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input); XCTFail("Changed legacy lease retires runtime") }
        catch let failure as NativeCalendarFileAddFailure {
            XCTAssertEqual(failure.localizedDescription, "SAVE_FAILED: Calendar subscription save requires fresh runtime recovery")
            frozen = failure.requestJSON
        }
        let raw = try XCTUnwrap(frozen); XCTAssertTrue(FileManager.default.fileExists(atPath: try file(raw).path))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
        io.arm(nil); let startup = try object(await core.start()); XCTAssertNil(startup["recovery"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path)); XCTAssertTrue(FileManager.default.fileExists(atPath: try file(raw).path))
        try privacy(library)
    }

    func testColdCapturedCommitTerminalAndCleanupRecoveryNeverRecopiesProvider() async throws {
        for cut in ["commit", "terminal", "clear"] {
            let library = try library("cold-" + cut), io = CalendarFileHostIO(), writer = host(library, io: io)
            _ = try await writer.start(); let selected = try source(library), input = try await request(writer), receipts = try receiptCount(library)
            io.arm(cut); var frozen: String?
            do { _ = try await writer.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input); XCTFail("Cut requires cold recovery") }
            catch let failure as NativeCalendarFileAddFailure { frozen = failure.requestJSON }
            let raw = try XCTUnwrap(frozen), owned = try file(raw), bytes = try Data(contentsOf: owned)
            await writer.close(); try FileManager.default.removeItem(at: selected)
            let cold = host(library), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
            XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionAddCommit"); try result(json(try XCTUnwrap(recovery["result"])))
            XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertEqual(try Data(contentsOf: owned), bytes)
            try result(await cold.probeCalendarSubscriptionAddOutcome(requestJSON: raw)); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
            let options = try object(await cold.getCalendarSubscriptionOptions()), expected = try XCTUnwrap(options["expected"] as? [String: Any])
            let remove = try json(["requestId": UUID().uuidString.lowercased(), "expected": expected,
                "edit": ["type": "removeFeed", "feedId": try XCTUnwrap(object(raw)["requestId"] as? String), "revision": try XCTUnwrap(expected["revision"] as? String)]])
            _ = try await cold.setCalendarSubscriptionSetting(requestJSON: remove)
            XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.count, 0)
            XCTAssertEqual(try Data(contentsOf: owned), bytes); try result(await cold.addCalendarSubscription(requestJSON: raw))
            XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.count, 0); try privacy(library); await cold.close()
        }
    }

    func testHeldCaptureCancellationAndCloseDrainBeforeReleaseAndNeverStartAdd() async throws {
        for close in [false, true] {
            let library = try library(close ? "capture-close" : "capture-cancel"), io = CalendarFileHostIO(), core = host(library, io: io)
            let entered = expectation(description: "Physical provider copy held"), release = DispatchSemaphore(value: 0)
            defer { release.signal() }
            let hooks = NativeAttachmentHostHooks(); var held = false
            hooks.configureJobs = { jobs in jobs.beforeProviderOutputNamedStat = { _ in
                if !held { held = true; entered.fulfill(); _ = release.wait(timeout: .now() + 25) }
            } }
            try await core.configureAttachmentHost(hooks); _ = try await core.start()
            let selected = try source(library), input = try await request(core), before = try json(settings(library)), receipts = try receiptCount(library)
            let pending = Task { defer { io.settled() }; return try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input) }
            await fulfillment(of: [entered], timeout: 3)
            do { _ = try await core.call("captureSubmit", argumentsJSON: json(["Cannot borrow capture owner"])); XCTFail("Capture excludes ordinary writers") }
            catch { XCTAssertTrue(error is CoreHostRejection) }
            do { _ = try await core.calendarRead(requestJSON: "{\"op\":\"testSettings\"}"); XCTFail("Capture excludes native reads") }
            catch { XCTAssertTrue(error is HostFailure) }
            var closing: Task<Void, Never>?
            if close { closing = Task { await core.close(); io.didClose() } } else { pending.cancel() }
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertFalse(io.hasSettled); XCTAssertFalse(io.hasClosed); XCTAssertFalse(canLock(library))
            release.signal(); if let closing { await closing.value }
            do { _ = try await pending.value; XCTFail("Cancelled capture cannot Add") }
            catch let failure as NativeCalendarFileAddFailure { XCTAssertNil(failure.requestJSON) }
            XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
            XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
            if close { XCTAssertTrue(canLock(library)) }
            else {
                let next = try await request(core); let added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: next)
                try result(added.resultJSON); await core.close()
            }
        }
    }

    func testWitnessChangedDuringCaptureRefusesAddAndRetainsReturnedSnapshot() async throws {
        let library = try library("stale-copy"), io = CalendarFileHostIO(), core = host(library, io: io)
        let entered = expectation(description: "Capture held across source replacement"), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let hooks = NativeAttachmentHostHooks(); var held = false
        hooks.configureJobs = { jobs in jobs.beforeProviderOutputNamedStat = { _ in
            if !held { held = true; entered.fulfill(); _ = release.wait(timeout: .now() + 25) }
        } }
        try await core.configureAttachmentHost(hooks); _ = try await core.start(); try await replaceSubscriptions(core, library, nil)
        let selected = try source(library), input = try await request(core), before = try json(settings(library)), receipts = try receiptCount(library)
        let pending = Task { try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input) }
        await fulfillment(of: [entered], timeout: 3)
        try io.changeLegacy(try json([["id": "later", "name": "Later source", "url": "https://later.invalid/a.ics", "enabled": true]]))
        release.signal(); var frozen: String?
        do { _ = try await pending.value; XCTFail("Old witness cannot append after capture") }
        catch let failure as NativeCalendarFileAddFailure { frozen = failure.requestJSON }
        let raw = try XCTUnwrap(frozen); XCTAssertTrue(FileManager.default.fileExists(atPath: try file(raw).path))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path)); XCTAssertEqual(io.readerCount, 0)
        let next = try await request(core), added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: next)
        try result(added.resultJSON); try privacy(library)
    }

    func testActualEightMiBEscapedOwnedBodyReadsWithoutJSONExpansionFailure() async throws {
        let library = try library("body-limit"), io = CalendarFileHostIO(), core = host(library, io: io)
        _ = try await core.start(); let bytes = Data(repeating: 1, count: 8 * 1024 * 1024)
        let selected = try source(library, bytes: bytes), input = try await request(core), added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input)
        XCTAssertEqual(try Data(contentsOf: file(added.requestJSON)), bytes)
        _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"); let receipts = try receiptCount(library), providerReads = io.provider.operations
        try await toast(core, tone: "success")
        XCTAssertEqual(io.counters?.jobs, 0); XCTAssertEqual(io.provider.operations, providerReads); XCTAssertEqual(try receiptCount(library), receipts); try privacy(library)
    }

    func testMissingInvalidUTF8AndArbitraryLegacyFileRemainVisibleWithPartialWarning() async throws {
        for mode in ["missing", "invalid", "legacy"] {
            let library = try library(mode), io = CalendarFileHostIO(), core = host(library, io: io); _ = try await core.start()
            let selected = try source(library, bytes: mode == "invalid" ? Data([0xff, 0xfe, 0x80]) : nil)
            let input = try await request(core), added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input), owned = try file(added.requestJSON)
            if mode == "missing" { try FileManager.default.removeItem(at: owned) }
            if mode == "legacy" {
                var values = try settings(library), rows = try XCTUnwrap(values["externalCalendars"] as? [[String: Any]])
                rows[0]["url"] = selected.absoluteString; values["externalCalendars"] = rows
                _ = try sql(library, "UPDATE settings SET data=? WHERE id=1", [json(values)])
                await core.close()
            }
            let reading = mode == "legacy" ? host(library, io: io) : core
            if mode == "legacy" { _ = try await reading.start() }
            let before = try json(settings(library)), receipts = try receiptCount(library)
            _ = try await reading.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"); let providerReads = io.provider.operations
            try await toast(reading, tone: "warning")
            XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.count, 1)
            XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
            XCTAssertEqual(io.provider.operations, providerReads); XCTAssertEqual(io.counters?.jobs, 0); try privacy(library)
        }
    }

    func testActualHeldLocalTestCancelAndDeadlineDrainBeforeResultThenRetry() async throws {
        for deadline in [false, true] {
            let library = try library(deadline ? "read-deadline" : "read-cancel"), io = CalendarFileHostIO()
            let entered = expectation(description: "Physical local read held"), release = DispatchSemaphore(value: 0)
            defer { release.signal() }
            var held = false
            let core = host(library, io: io) { faults in faults.configureCalendarJobs = { jobs in
                io.capture(jobs); jobs.beforeFileRead = { if !held { held = true; entered.fulfill(); _ = release.wait(timeout: .now() + 25) } }
            } }
            _ = try await core.start(); let selected = try source(library), input = try await request(core)
            let added = try await core.addLocalCalendarSubscription(selectedURL: selected, requestJSON: input)
            _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}")
            let before = try json(settings(library)), receipts = try receiptCount(library), providerReads = io.provider.operations
            let pending = Task { defer { io.settled() }; return try await core.calendarRead(requestJSON: "{\"op\":\"testSettings\"}") }
            await fulfillment(of: [entered], timeout: 3)
            if deadline { try await Task.sleep(nanoseconds: 15_300_000_000) } else { pending.cancel(); try await Task.sleep(nanoseconds: 100_000_000) }
            XCTAssertFalse(io.hasSettled); XCTAssertEqual(io.counters?.running, 1); XCTAssertFalse(canLock(library))
            release.signal()
            if deadline {
                let value = try object(await pending.value), toasts = try XCTUnwrap(value["toasts"] as? [[String: Any]])
                XCTAssertEqual(toasts.count, 1); XCTAssertEqual(toasts.first?["tone"] as? String, "warning")
            } else { do { _ = try await pending.value; XCTFail("Cancelled read cannot publish late events") } catch is CancellationError {} }
            XCTAssertEqual(io.counters?.jobs, 0); XCTAssertEqual(io.counters?.running, 0); XCTAssertEqual(io.provider.operations, providerReads)
            try await toast(core, tone: "success"); try result(await core.probeCalendarSubscriptionAddOutcome(requestJSON: added.requestJSON))
            XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts); try privacy(library)
        }
    }
}
