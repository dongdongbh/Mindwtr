import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAppleRemindersSettingsTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.reminders-settings-test"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func seed(_ raw: String) throws {
        let storage = try NativeDeviceKV(containerURL: root, bundleIdentifier: namespace); defer { storage.close() }
        try storage.compareAndSetAppleRemindersImportState(expected: storage.readAppleRemindersImportState(), next: raw)
    }
    private func host(_ sdk: AppleRemindersTestSDK = .init(), faults: HostIOFaults = .init(), permission: NativeAppleRemindersPermission = .granted) -> CoreHost {
        faults.appleRemindersProviderFactory = { NativeAppleRemindersProvider(status: { permission }, sdkFactory: { sdk }) }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, deviceStorage: (root, namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private let initial = #"{"selectedListId":"old","selectedListTitle":"Old","importedReminderIds":["one","two"],"autoImportOnOpen":false,"deleteImportedReminders":true}"#
    private let enable = #"{"type":"autoImportOnOpen","value":true}"#
    private let select = #"{"type":"selectedList","id":"list","sourceId":"account","title":"List"}"#
    private func assertNoTaskWrites() throws {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT * FROM tasks").utf8)) as? [[String: Any]])
        XCTAssertTrue(rows.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testAbsentSettingsReadDoesNotPromoteOrReadProvider() async throws {
        let sdk = AppleRemindersTestSDK(), faults = HostIOFaults(); var kv: NativeDeviceKV?
        faults.configureDeviceStorage = { kv = $0 }
        let core = host(sdk, faults: faults); _ = try await core.start()
        var promotions = 0; try XCTUnwrap(kv).faults.beforePromotion = { promotions += 1 }
        let value = try object(await core.readAppleRemindersSettings())
        XCTAssertTrue(value["expectedRaw"] is NSNull)
        let settings = try XCTUnwrap(value["settings"] as? [String: Any])
        XCTAssertEqual(settings["autoImportOnOpen"] as? Bool, false); XCTAssertNil(settings["importedReminderIds"])
        XCTAssertEqual(promotions, 0); XCTAssertEqual(sdk.requests, 0); XCTAssertEqual(sdk.listReads, 0)
    }

    func testPreferenceEditsPreserveRegistryAndSavePrivateDiagnostic() async throws {
        try seed(initial); let core = host(); _ = try await core.start()
        let value = try object(await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: initial))
        let raw = try XCTUnwrap(value["expectedRaw"] as? String), saved = try object(raw)
        XCTAssertEqual(saved["importedReminderIds"] as? [String], ["one", "two"])
        XCTAssertEqual(saved["deleteImportedReminders"] as? Bool, true); XCTAssertEqual(saved["selectedListId"] as? String, "old")
        XCTAssertEqual(saved["autoImportOnOpen"] as? Bool, true)
        let cleared = try object(await core.setAppleRemindersSetting(editJSON: #"{"type":"deleteImportedReminders","value":false}"#, expectedRaw: raw))
        XCTAssertEqual((cleared["settings"] as? [String: Any])?["deleteImportedReminders"] as? Bool, false)
        let enabled = try object(await core.setAppleRemindersSetting(editJSON: #"{"type":"deleteImportedReminders","value":true}"#,
            expectedRaw: try XCTUnwrap(cleared["expectedRaw"] as? String)))
        XCTAssertEqual((enabled["settings"] as? [String: Any])?["deleteImportedReminders"] as? Bool, true)
        XCTAssertEqual(try object(XCTUnwrap(enabled["expectedRaw"] as? String))["importedReminderIds"] as? [String], ["one", "two"])
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("Native Reminders preference saved")); XCTAssertTrue(log.contains("v1.3.5/ios-reminders-setting"))
        await core.close(); try assertNoTaskWrites()
    }

    func testFreshListSelectionPreservesRegistry() async throws {
        try seed(initial); let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        let value = try object(await core.setAppleRemindersSetting(editJSON: select, expectedRaw: initial))
        let saved = try object(XCTUnwrap(value["expectedRaw"] as? String))
        XCTAssertEqual(saved["selectedListId"] as? String, "list"); XCTAssertEqual(saved["selectedListTitle"] as? String, "List")
        XCTAssertEqual(saved["importedReminderIds"] as? [String], ["one", "two"])
        XCTAssertEqual(sdk.requests, 0); XCTAssertGreaterThan(sdk.listReads, 0)
        await core.close(); try assertNoTaskWrites()
    }

    func testStaleWitnessDoesNotOverwriteNewPreferenceOrRegistry() async throws {
        try seed(initial); let core = host(); _ = try await core.start()
        let accepted = try await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: initial)
        await refused { _ = try await core.setAppleRemindersSetting(editJSON: #"{"type":"autoImportOnOpen","value":false}"#, expectedRaw: initial) }
        let current = try await core.readAppleRemindersSettings()
        XCTAssertEqual(try object(current)["expectedRaw"] as? String, try object(accepted)["expectedRaw"] as? String)
    }

    func testChangedOrDeniedListSelectionDoesNotSave() async throws {
        try seed(initial); let sdk = AppleRemindersTestSDK(); sdk.listValues = []
        let core = host(sdk); _ = try await core.start()
        await refused { _ = try await core.setAppleRemindersSetting(editJSON: select, expectedRaw: initial) }
        let current = try await core.readAppleRemindersSettings()
        XCTAssertEqual(try object(current)["expectedRaw"] as? String, initial)
        await core.close()
        let denied = host(sdk, permission: .denied); _ = try await denied.start()
        await refused { _ = try await denied.setAppleRemindersSetting(editJSON: select, expectedRaw: initial) }
        XCTAssertEqual(sdk.requests, 0)
        let deniedCurrent = try await denied.readAppleRemindersSettings()
        XCTAssertEqual(try object(deniedCurrent)["expectedRaw"] as? String, initial)
    }

    func testMalformedEditsCannotMutate() async throws {
        try seed(initial); let core = host(); _ = try await core.start()
        for edit in [#"{"type":"autoImportOnOpen","value":true,"value":false}"#,
                     #"{"type":"autoImportOnOpen","value":1}"#, #"{"type":"importedReminderIds","value":[]}"#,
                     #"{"type":"deleteImportedReminders","value":"true"}"#] {
            await refused { _ = try await core.setAppleRemindersSetting(editJSON: edit, expectedRaw: initial) }
        }
        let current = try await core.readAppleRemindersSettings()
        XCTAssertEqual(try object(current)["expectedRaw"] as? String, initial)
        await core.close(); try assertNoTaskWrites()
    }

    func testMalformedStoredRegistryCannotBecomeDefaults() async throws {
        let raw = #"{"autoImportOnOpen":true,"autoImportOnOpen":false}"#; try seed(raw)
        let core = host(); _ = try await core.start()
        await refused { _ = try await core.readAppleRemindersSettings() }
        await refused { _ = try await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: raw) }
        await core.close(); let storage = try NativeDeviceKV(containerURL: root, bundleIdentifier: namespace); defer { storage.close() }
        XCTAssertEqual(try storage.readAppleRemindersImportState(), raw)
    }

    func testUncertainCASRequiresExactWarmRetryAndColdReadsSavedState() async throws {
        for cut in ["before", "after", "readback"] {
            try seed(initial); let faults = HostIOFaults(); var kv: NativeDeviceKV?
            faults.configureDeviceStorage = { kv = $0 }
            let core = host(faults: faults); _ = try await core.start(); let storage = try XCTUnwrap(kv)
            if cut == "before" { storage.faults.beforePromotion = { throw HostFailure("Injected") } }
            if cut == "after" { storage.faults.afterPromotion = { throw HostFailure("Injected") } }
            if cut == "readback" { storage.faults.beforeReadback = { throw HostFailure("Injected") } }
            await refused { _ = try await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: initial) }
            await refused { _ = try await core.readAppleRemindersSettings() }
            await refused { _ = try await core.setAppleRemindersSetting(editJSON: #"{"type":"autoImportOnOpen","value":false}"#, expectedRaw: initial) }
            storage.faults.beforePromotion = nil; storage.faults.afterPromotion = nil; storage.faults.beforeReadback = nil
            let saved = try await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: initial)
            await core.close(); let cold = host(); _ = try await cold.start()
            let current = try await cold.readAppleRemindersSettings()
            XCTAssertEqual(try object(current)["expectedRaw"] as? String, try object(saved)["expectedRaw"] as? String)
            await cold.close(); try assertNoTaskWrites()
        }
    }
    func testColdRestartReadsUncertainPreferenceWithoutReplaying() async throws {
        for cut in ["before", "after"] {
            try seed(initial); let faults = HostIOFaults(); var kv: NativeDeviceKV?
            faults.configureDeviceStorage = { kv = $0 }
            let core = host(faults: faults); _ = try await core.start(); let storage = try XCTUnwrap(kv)
            if cut == "before" { storage.faults.beforePromotion = { throw HostFailure("Injected") } }
            else { storage.faults.afterPromotion = { throw HostFailure("Injected") } }
            await refused { _ = try await core.setAppleRemindersSetting(editJSON: enable, expectedRaw: initial) }
            await core.close()
            let cold = host(); _ = try await cold.start()
            let value = try object(await cold.readAppleRemindersSettings())
            let raw = try object(XCTUnwrap(value["expectedRaw"] as? String))
            XCTAssertEqual(raw["autoImportOnOpen"] as? Bool, cut == "after")
            XCTAssertEqual(raw["importedReminderIds"] as? [String], ["one", "two"])
            await cold.close(); try assertNoTaskWrites()
        }
    }

}
