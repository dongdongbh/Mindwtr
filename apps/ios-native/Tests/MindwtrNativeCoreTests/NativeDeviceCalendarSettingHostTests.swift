import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class DeviceCalendarSettingIO: @unchecked Sendable {
    private let lock = NSLock()
    private var failure: String?, journals = 0, promotions = 0, receiptAttempts = 0, providerCalls = 0
    func arm(_ value: String?) { lock.lock(); failure = value; journals = 0; lock.unlock() }
    private func check(_ cut: String) throws {
        lock.lock(); let failed = failure == cut; lock.unlock()
        if failed { throw HostFailure("PRIVATE_CALENDAR_SETTING_FAULT") }
    }
    func beforePromotion() throws { try check("beforeKV") }
    func afterPromotion() throws { lock.lock(); promotions += 1; lock.unlock(); try check("afterKV") }
    func beforeSQL(_ statement: String) throws {
        if statement.hasPrefix("INSERT INTO native_request_receipts") {
            lock.lock(); receiptAttempts += 1; lock.unlock(); try check("receipt")
        }
    }
    func beforeJournal() throws {
        lock.lock(); journals += 1; let terminal = journals == 2; lock.unlock()
        if terminal { try check("terminal") }
    }
    func beforeClear() throws { try check("clear") }
    func provider() { lock.lock(); providerCalls += 1; lock.unlock(); XCTFail("Device Calendar Settings cannot access a provider") }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [promotions, receiptAttempts, providerCalls] }
}

private final class DeviceCalendarSettingNoReader: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { XCTFail("Calendar permission read is forbidden"); throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { XCTFail("Calendar enumeration is forbidden"); throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { XCTFail("Calendar events are forbidden"); throw NativeCalendarReadError.unavailable }
}

private final class DeviceCalendarSettingNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Device Calendar Settings cannot access HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

final class NativeDeviceCalendarSettingHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.example.mindwtr.device-calendar-settings"
    private let settingName = "mindwtr-system-calendar-settings", markerName = "mindwtr:native:calendar-setting:v1"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private var disabled: [String: Any] { ["enabled": false, "selectAll": true, "selectedCalendarIds": [], "areaIdsByCalendar": [:]] }
    private var enabled: [String: Any] { ["enabled": true, "selectAll": true, "selectedCalendarIds": [], "areaIdsByCalendar": [:]] }
    private var originalResult: [String: Any] { ["changed": true, "toasts": [], "open": "device", "clearDraft": false] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/device-calendar-settings/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Device Calendar fixture is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try seed()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func seed(setting: String? = nil, marker: String? = nil) throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        var values = ["@mindwtr_sync_backend": "off", "unknown-calendar-preference": "PRIVATE_CALENDAR 文"]
        values[settingName] = setting; values[markerName] = marker
        try Data(json(values).utf8).write(to: manifest)
    }
    private func cells() throws -> [String: Any] { try object(String(contentsOf: manifest, encoding: .utf8)) }
    private func request(before: [String: Any]? = nil, value: [String: Any]? = nil) throws -> String {
        try json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "deviceCalendars", "before": before ?? disabled, "value": value ?? enabled]])
    }
    private func host(_ io: DeviceCalendarSettingIO = DeviceCalendarSettingIO(), bundle supplied: URL? = nil) -> CoreHost {
        let faults = HostIOFaults()
        faults.configureDeviceStorage = { storage in
            storage.faults.beforePromotion = { try io.beforePromotion() }; storage.faults.afterPromotion = { try io.afterPromotion() }
        }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { try io.beforeJournal() }; faults.journalRemove = { try io.beforeClear() }
        faults.calendarReaderFactory = { io.provider(); return DeviceCalendarSettingNoReader() }
        faults.notificationAuthorizationRequest = { io.provider() }
        faults.notificationPermissionRead = { io.provider(); return .init(status: "denied", granted: false, canAskAgain: false) }
        faults.secretBeforeOperation = { _, _ in io.provider() }; faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in io.provider() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DeviceCalendarSettingNoHTTP.self]; faults.httpConfiguration = config
        let value = CoreHost(databaseURL: database, bundleURL: supplied ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func instrumentedBundle(_ suffix: String) throws -> URL {
        let url = root.appendingPathComponent("calendar-probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n;" + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
    private func domainRows() throws -> [String: String] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'native_request_receipts'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func receiptCount() throws -> Int {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT count(*) AS count FROM native_request_receipts").utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first?["count"] as? Int)
    }
    private func markers() throws -> Int {
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(text.contains("PRIVATE_CALENDAR")); XCTAssertFalse(text.contains(namespace))
        return text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-calendar-setting") }.count
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained Calendar save uncertainty") }
        catch { XCTAssertTrue(error is HostFailure, "Unexpected failure \(error)") }
    }
    private func assertResult(_ raw: String, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try json(object(raw)), try json(originalResult), file: file, line: line)
    }

    func testTypedBoundaryAndGenericWriterDispatchRefuseWithoutEffects() async throws {
        let io = DeviceCalendarSettingIO(), core = host(io); _ = try await core.start()
        let raw = try request(), input = try object(raw), before = try domainRows(), local = try Data(contentsOf: manifest)
        var unknown = input; unknown["authority"] = true
        var numeric = input; numeric["edit"] = ["type": "deviceCalendars", "before": disabled, "value": ["enabled": 1, "selectAll": true, "selectedCalendarIds": []]]
        var variant = input; variant["edit"] = ["type": "push", "before": disabled, "value": enabled]
        var badUUID = input; badUUID["requestId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".uppercased()
        var extra = enabled; extra["permissionGranted"] = true
        var extraSettings = input; extraSettings["edit"] = ["type": "deviceCalendars", "before": disabled, "value": extra]
        let duplicate = raw.dropLast() + ",\"requestId\":\"" + (input["requestId"] as! String) + "\"}"
        for invalid in try [json(unknown), json(numeric), json(variant), json(badUUID), json(extraSettings), String(duplicate), raw + String(repeating: " ", count: 1024 * 1024)] {
            do { _ = try await core.setDeviceCalendarSetting(requestJSON: invalid); XCTFail("Malformed typed edit must refuse") }
            catch { XCTAssertTrue(error is CoreHostRejection) }
        }
        for method in ["deviceCalendarSetting", "deviceCalendarSettingPrepare", "deviceCalendarSettingValidate", "deviceCalendarSettingCommit", "deviceCalendarSettingRetryOutcome", "deviceCalendarSettingAcknowledged"] {
            do { _ = try await core.call(method, argumentsJSON: json([raw])); XCTFail("Generic writer dispatch must refuse") }
            catch { XCTAssertTrue(error is CoreHostRejection) }
        }
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertEqual(try domainRows(), before); XCTAssertEqual(try Data(contentsOf: manifest), local)
        XCTAssertEqual(try receiptCount(), 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testWarmExactRetryAcrossKVReceiptTerminalAndClearCuts() async throws {
        for cut in ["beforeKV", "afterKV", "receipt", "terminal", "clear"] {
            try seed()
            let io = DeviceCalendarSettingIO(), core = host(io); _ = try await core.start()
            let raw = try request(), before = try domainRows(), receipts = try receiptCount(), logs = try markers()
            io.arm(cut)
            await uncertain { try await core.setDeviceCalendarSetting(requestJSON: raw) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), logs)
            let originalJournal = try Data(contentsOf: journal)
            let altered = try request()
            await uncertain { try await core.setDeviceCalendarSetting(requestJSON: altered) }
            XCTAssertEqual(try Data(contentsOf: journal), originalJournal)
            io.arm(nil)
            try assertResult(await core.setDeviceCalendarSetting(requestJSON: raw))
            XCTAssertEqual(io.counts[0], 1, "\(cut): exact retained retry must publish only once")
            XCTAssertEqual(io.counts[2], 0); XCTAssertEqual(try receiptCount(), receipts + 1)
            XCTAssertEqual(try domainRows(), before); XCTAssertEqual(try markers(), logs + 1)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let baseline = try Data(contentsOf: manifest), counts = io.counts
            try assertResult(await core.setDeviceCalendarSetting(requestJSON: raw))
            try assertResult(await core.probeDeviceCalendarSettingOutcome(requestJSON: raw))
            XCTAssertEqual(try Data(contentsOf: manifest), baseline); XCTAssertEqual(io.counts, counts)
            await core.close()
        }
    }

    func testNoopBoundaryAndOriginalRawLegacyWitnessStayUnchanged() async throws {
        let identifier = " \u{feff}opaque 文 "
        let legacy = " { \"selectedCalendarIds\" : [\" \\ufeffopaque 文 \"], \"selectAll\" : false, \"enabled\" : false } \n"
        try seed(setting: legacy)
        let before: [String: Any] = ["enabled": false, "selectAll": false, "selectedCalendarIds": [identifier]]
        let io = DeviceCalendarSettingIO(), core = host(io); _ = try await core.start()
        let noop = try request(before: before, value: before), local = try Data(contentsOf: manifest), domain = try domainRows()
        let boundary = noop + String(repeating: " ", count: 1024 * 1024 - noop.utf8.count)
        let result = try object(await core.setDeviceCalendarSetting(requestJSON: boundary))
        XCTAssertEqual(try json(result), try json(["changed": false, "toasts": [], "open": NSNull(), "clearDraft": false]))
        do { _ = try await core.setDeviceCalendarSetting(requestJSON: boundary + " "); XCTFail("Request max plus one must refuse") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        XCTAssertEqual(try Data(contentsOf: manifest), local); XCTAssertEqual(try domainRows(), domain)
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertEqual(try receiptCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        var next = before; next["enabled"] = true
        let changed = try request(before: before, value: next); io.arm("beforeKV")
        await uncertain { try await core.setDeviceCalendarSetting(requestJSON: changed) }
        let wrapper = try object(String(contentsOf: journal, encoding: .utf8))
        let arguments = try XCTUnwrap(wrapper["argumentsJSON"] as? String)
        let raw = try XCTUnwrap((NativeJSON.jsonObject(with: Data(arguments.utf8)) as? [String])?.first)
        let prepared = try XCTUnwrap(object(raw)["prepared"] as? [String: Any])
        XCTAssertEqual((prepared["storedBefore"] as? String).map { Data($0.utf8) }, Data(legacy.utf8))
        XCTAssertTrue(prepared["markerBefore"] is NSNull)
        io.arm(nil); try assertResult(await core.setDeviceCalendarSetting(requestJSON: changed))
        let stored = try object(XCTUnwrap(cells()[settingName] as? String))
        XCTAssertEqual((stored["selectedCalendarIds"] as? [String])?.map { Data($0.utf8) }, [Data(identifier.utf8)])
    }

    func testMarkerWithoutOriginalJournalCannotFabricateUnreceiptedRecovery() async throws {
        let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
        let raw = try request(); io.arm("afterKV")
        await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: raw) }; await writer.close()
        try FileManager.default.removeItem(at: journal)
        let baseline = try Data(contentsOf: manifest), coldIO = DeviceCalendarSettingIO(), cold = host(coldIO)
        _ = try await cold.start()
        do { _ = try await cold.setDeviceCalendarSetting(requestJSON: raw); XCTFail("A marker alone cannot fabricate original before witnesses") }
        catch { XCTAssertTrue(error is CoreHostRejection); XCTAssertTrue(error.localizedDescription.hasPrefix("STALE_REVISION:")) }
        XCTAssertEqual(try Data(contentsOf: manifest), baseline); XCTAssertEqual(coldIO.counts, [0, 0, 0])
        XCTAssertEqual(try receiptCount(), 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPureValidationRefusalPrecedesSettlingRetainedAmbiguousKV() async throws {
        let probe = try instrumentedBundle("""
        (()=>{
          const n=__mindwtrNative,cas=n.calendarSettingCAS,validate=MindwtrHost.deviceCalendarSettingValidate;let refuse=false;
          n.calendarSettingCAS=(...args)=>{const result=cas(...args);if(typeof result==='string'&&result.startsWith('!MindwtrNativeError:'))refuse=true;return result;};
          MindwtrHost.deviceCalendarSettingValidate=(...args)=>{
            if(refuse){refuse=false;throw Error('Calendar validation cut before retained CAS');}return validate(...args);
          };
        })();
        """)
        let io = DeviceCalendarSettingIO(), core = host(io, bundle: probe); _ = try await core.start()
        let raw = try request(); io.arm("afterKV")
        await uncertain { try await core.setDeviceCalendarSetting(requestJSON: raw) }
        let originalJournal = try Data(contentsOf: journal), landed = try Data(contentsOf: manifest)
        io.arm(nil); await uncertain { try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), originalJournal); XCTAssertEqual(try Data(contentsOf: manifest), landed)
        XCTAssertEqual(try receiptCount(), 0); XCTAssertEqual(io.counts, [1, 0, 0])
        let acknowledgment = try await core.retryPending(); try assertResult(XCTUnwrap(acknowledgment))
        XCTAssertEqual(io.counts, [1, 1, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdOriginalJournalRecoversFrozenChangedAndOpenAcrossEveryCut() async throws {
        for cut in ["beforeKV", "afterKV", "receipt", "terminal", "clear"] {
            try seed()
            let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
            let raw = try request(), before = try domainRows(), receipts = try receiptCount()
            io.arm(cut); await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: raw) }; await writer.close()
            let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO), startup = try object(await cold.start())
            let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
            XCTAssertEqual(try json(recovery), try json(["method": "deviceCalendarSettingCommit", "result": originalResult]))
            XCTAssertEqual(io.counts[0] + coldIO.counts[0], 1); XCTAssertEqual(coldIO.counts[2], 0)
            XCTAssertEqual(try domainRows(), before); XCTAssertEqual(try receiptCount(), receipts + 1)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let repeated = try object(await cold.start()); XCTAssertNil(repeated["recovery"])
            try assertResult(await cold.setDeviceCalendarSetting(requestJSON: raw))
            await cold.close()
        }
    }

    func testSavedReceiptWinsOverLaterEditWithoutReapplyingOldJournal() async throws {
        let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
        let old = try request(); io.arm("clear")
        await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: old) }
        let retained = try Data(contentsOf: journal)
        io.arm(nil); let acknowledgment = try await writer.retryPending(); try assertResult(XCTUnwrap(acknowledgment))
        let later = try request(before: enabled, value: disabled)
        let result = try object(await writer.setDeviceCalendarSetting(requestJSON: later)); XCTAssertEqual(result["open"] as? NSNull, NSNull())
        await writer.close()
        let baseline = try Data(contentsOf: manifest), before = try domainRows(), receipts = try receiptCount()
        try retained.write(to: journal)
        let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO), startup = try object(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(startup["recovery"])), try json(["method": "deviceCalendarSettingCommit", "result": originalResult]))
        try assertResult(await cold.setDeviceCalendarSetting(requestJSON: old))
        XCTAssertEqual(coldIO.counts, [0, 0, 0]); XCTAssertEqual(try Data(contentsOf: manifest), baseline)
        XCTAssertEqual(try domainRows(), before); XCTAssertEqual(try receiptCount(), receipts)
    }

    func testOldUnreceiptedJournalCannotOverwriteLaterMarkerInABAState() async throws {
        let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
        let old = try request(); io.arm("afterKV")
        await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: old) }; await writer.close()
        let retained = try Data(contentsOf: journal)
        let laterRequest = try object(request(before: enabled, value: disabled))
        try seed(marker: json(["version": 1, "request": laterRequest, "result": ["changed": true, "toasts": [], "open": NSNull(), "clearDraft": false]]))
        let baseline = try Data(contentsOf: manifest), before = try domainRows()
        let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO)
        do { _ = try await cold.start(); XCTFail("Unknown old operation must not reapply across a later marker") }
        catch { XCTAssertTrue(error.localizedDescription.hasPrefix("STALE_REVISION:"), "\(error)") }
        XCTAssertEqual(try Data(contentsOf: manifest), baseline); XCTAssertEqual(try Data(contentsOf: journal), retained)
        XCTAssertEqual(try domainRows(), before); XCTAssertEqual(try receiptCount(), 0); XCTAssertEqual(coldIO.counts, [0, 0, 0])
    }

    func testRealJSCAndKVRoundtripPreservesBothUnicodeAreaKeysAndSelectedIDs() async throws {
        let composed = "\u{e9}", decomposed = "e\u{301}"
        let areas = try XCTUnwrap(NativeJSON.jsonObject(with: Data("{\"\\u00e9\":[\"area-composed\"],\"e\\u0301\":[\"area-decomposed\"]}".utf8)) as? NSDictionary)
        let value: [String: Any] = ["enabled": true, "selectAll": false, "selectedCalendarIds": [composed, decomposed], "areaIdsByCalendar": areas]
        let io = DeviceCalendarSettingIO(), core = host(io); _ = try await core.start()
        let raw = try request(value: value); io.arm("receipt")
        await uncertain { try await core.setDeviceCalendarSetting(requestJSON: raw) }; await core.close()
        let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO); _ = try await cold.start()
        try assertResult(await cold.setDeviceCalendarSetting(requestJSON: raw))
        let stored = try object(XCTUnwrap(cells()[settingName] as? String))
        XCTAssertEqual((stored["selectedCalendarIds"] as? [String])?.map { Data($0.utf8) }, [Data(composed.utf8), Data(decomposed.utf8)])
        let map = try XCTUnwrap(stored["areaIdsByCalendar"] as? NSDictionary)
        XCTAssertEqual(map.count, 2)
        XCTAssertEqual(map.object(forKey: composed as NSString) as? [String], ["area-composed"])
        XCTAssertEqual(map.object(forKey: decomposed as NSString) as? [String], ["area-decomposed"])
        XCTAssertEqual(io.counts[0], 1); XCTAssertEqual(coldIO.counts, [0, 1, 0])
        let marker = try object(XCTUnwrap(cells()[markerName] as? String)), original = try object(raw)
        XCTAssertEqual(try json(XCTUnwrap(marker["request"])), try json(original))
        XCTAssertEqual(try cells()["unknown-calendar-preference"] as? String, "PRIVATE_CALENDAR 文")
    }

    func testHeavilyEscapedEnvelopeUsesActualJournalSerializerAndColdRetry() async throws {
        let ids = (0..<180).map { String(repeating: "\0\"\\", count: 100) + String($0) }
        let value: [String: Any] = ["enabled": true, "selectAll": false, "selectedCalendarIds": ids, "areaIdsByCalendar": [:]]
        let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
        let raw = try request(value: value); io.arm("beforeKV")
        await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: raw) }
        let bytes = try Data(contentsOf: journal), wrapper = try object(String(decoding: bytes, as: UTF8.self))
        let arguments = try XCTUnwrap(wrapper["argumentsJSON"] as? String)
        let envelope = try XCTUnwrap((NativeJSON.jsonObject(with: Data(arguments.utf8)) as? [String])?.first)
        XCTAssertGreaterThan(bytes.count, arguments.utf8.count); XCTAssertGreaterThan(arguments.utf8.count, envelope.utf8.count)
        XCTAssertLessThanOrEqual(bytes.count, 24_000_000); XCTAssertLessThanOrEqual(arguments.utf8.count, 12_000_000)
        XCTAssertLessThanOrEqual(envelope.utf8.count, 4 * 1024 * 1024)
        await writer.close()
        let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO); _ = try await cold.start()
        try assertResult(await cold.setDeviceCalendarSetting(requestJSON: raw))
        let stored = try object(XCTUnwrap(cells()[settingName] as? String))
        XCTAssertEqual(stored["selectedCalendarIds"] as? [String], ids); XCTAssertEqual(coldIO.counts, [1, 1, 0])
    }

    func testMalformedAndOversizedOriginalEnvelopesRefuseBeforeAnyKVSettlement() async throws {
        let io = DeviceCalendarSettingIO(), writer = host(io); _ = try await writer.start()
        io.arm("beforeKV"); await uncertain { try await writer.setDeviceCalendarSetting(requestJSON: request()) }; await writer.close()
        let saved = try Data(contentsOf: journal), original = try object(String(decoding: saved, as: UTF8.self))
        let args = try XCTUnwrap(original["argumentsJSON"] as? String)
        let envelopeRaw = try XCTUnwrap((NativeJSON.jsonObject(with: Data(args.utf8)) as? [String])?.first)
        let envelope = try object(envelopeRaw), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        var candidates: [String] = []
        for field in ["unknown", "storedBefore", "storedAfter", "markerAfter", "result"] {
            var changed = prepared
            if field == "unknown" { changed[field] = true }
            if field == "storedBefore" { changed[field] = 1 }
            if field == "storedAfter" { changed[field] = "{}" }
            if field == "markerAfter" { changed[field] = String(repeating: "x", count: 1024 * 1024 + 1) }
            if field == "result" { changed[field] = ["changed": 1, "toasts": [], "open": "device", "clearDraft": false] }
            var altered = envelope; altered["prepared"] = changed; candidates.append(try json(altered))
        }
        candidates.append(envelopeRaw + String(repeating: " ", count: 4 * 1024 * 1024 + 1 - envelopeRaw.utf8.count))
        candidates.append(String(envelopeRaw.dropLast()) + ",\"request\":" + (try json(XCTUnwrap(envelope["request"]))) + "}")
        let before = try Data(contentsOf: manifest), domain = try domainRows()
        var journals = try candidates.map { candidate -> String in
            var wrapper = original; wrapper["argumentsJSON"] = try json([candidate]); return try json(wrapper)
        }
        var oversizedArguments = original; oversizedArguments["argumentsJSON"] = args + String(repeating: " ", count: 12_000_001 - args.utf8.count)
        journals.append(try json(oversizedArguments))
        let wrapperRaw = String(decoding: saved, as: UTF8.self)
        journals.append(wrapperRaw + String(repeating: " ", count: 24_000_001 - wrapperRaw.utf8.count))
        for malformed in journals {
            try Data(malformed.utf8).write(to: journal)
            let coldIO = DeviceCalendarSettingIO(), cold = host(coldIO)
            do { _ = try await cold.start(); XCTFail("Malformed original envelope must refuse") } catch {}
            XCTAssertEqual(coldIO.counts, [0, 0, 0]); XCTAssertEqual(try Data(contentsOf: manifest), before)
            XCTAssertEqual(try domainRows(), domain); XCTAssertEqual(try receiptCount(), 0)
            XCTAssertEqual(try Data(contentsOf: journal), Data(malformed.utf8)); await cold.close()
        }
    }

    func testPreparationAndCommitRawBridgesKeepGenericKVAndProvidersForbidden() async throws {
        let probe = try instrumentedBundle("""
        (()=>{
          const n=__mindwtrNative,blocked=()=>{
            const replies=[n.kvGet('mindwtr-system-calendar-settings'),n.kvSet('mindwtr-system-calendar-settings','{}'),
              n.calendarCall('{"op":"permissions"}'),n.secretCall('{"op":"get","key":"mindwtr_cloud_token"}'),
              n.calendarSettingCAS('[null,null]','["{}","{}"]')];
            if(!replies.every(x=>typeof x==='string'&&x.startsWith('!MindwtrNativeError:')))throw Error('Calendar owner leaked authority');
          };
          const prepare=MindwtrHost.deviceCalendarSettingPrepare,validate=MindwtrHost.deviceCalendarSettingValidate,commit=MindwtrHost.deviceCalendarSettingCommit;
          MindwtrHost.deviceCalendarSettingPrepare=(...args)=>{blocked();return prepare(...args);};
          MindwtrHost.deviceCalendarSettingValidate=(...args)=>{
            blocked();if(!n.calendarSettingRead().startsWith('!MindwtrNativeError:'))throw Error('Pure validation read live cells');return validate(...args);
          };
          MindwtrHost.deviceCalendarSettingCommit=(...args)=>{
            blocked();const envelope=JSON.parse(args[0]),after=JSON.stringify([envelope.prepared.storedAfter+' ',envelope.prepared.markerAfter]);
            if(!n.calendarSettingCAS(JSON.stringify([envelope.prepared.storedBefore,envelope.prepared.markerBefore]),after)?.startsWith('!MindwtrNativeError:'))throw Error('CAS accepted different bytes');
            return commit(...args);
          };
        })();
        """)
        let io = DeviceCalendarSettingIO(), core = host(io, bundle: probe); _ = try await core.start()
        try assertResult(await core.setDeviceCalendarSetting(requestJSON: request()))
        XCTAssertEqual(io.counts, [1, 1, 0]); XCTAssertEqual(try receiptCount(), 1)
    }
}
