import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAppleRemindersAccessTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.reminders-access-test"
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
    private func host(_ sdk: AppleRemindersTestSDK, permission: NativeAppleRemindersPermission = .granted, faults: HostIOFaults = .init()) -> CoreHost {
        faults.appleRemindersProviderFactory = { .init(status: { permission }, sdkFactory: { sdk }) }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, deviceStorage: (root, namespace))
        addTeardownBlock { [self] in callback(sdk)?(.success(())); await value.close() }; return value
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func callback(_ sdk: AppleRemindersTestSDK) -> ((Result<Void, NativeAppleRemindersError>) -> Void)? {
        sdk.lock.lock(); defer { sdk.lock.unlock() }; return sdk.permissionCompletion
    }
    private func accepted(_ sdk: AppleRemindersTestSDK) async throws -> (Result<Void, NativeAppleRemindersError>) -> Void {
        for _ in 0..<300 {
            if let reply = callback(sdk) { return reply }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Permission SDK was not called"); throw HostFailure("Missing callback")
    }
    private final class Calls: @unchecked Sendable {
        let lock = NSLock(); private var count = 0
        func firstOnly() -> Bool { lock.lock(); defer { lock.unlock() }; count += 1; return count == 1 }
    }

    func testRejectedReadmissionNeverCallsOSAndReleasesOwner() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        await refused { _ = try await core.chooseAppleRemindersLists { false } }
        XCTAssertEqual(sdk.requests, 0); _ = try await core.readAppleRemindersSettings()
    }

    func testGrantedCallbackReturnsFreshListsAndSavedDiagnostic() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk)
        sdk.listValues = [.init(identity: .init(id: "new", sourceID: "account"), title: "New", color: nil)]
        reply(.success(())); let result = try object(await run.value)
        XCTAssertEqual(result["permission"] as? String, "granted")
        XCTAssertEqual((result["lists"] as? [[String: Any]])?.first?["id"] as? String, "new")
        XCTAssertEqual(sdk.requests, 1)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("Native Reminders access request finished")); XCTAssertTrue(log.contains("v1.3.5/ios-reminders-access"))
        _ = try await core.readAppleRemindersSettings()
    }

    func testDeniedCallbackDoesNotReadLists() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk, permission: .denied); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk); reply(.success(()))
        let result = try object(await run.value)
        XCTAssertEqual(result["permission"] as? String, "denied"); XCTAssertEqual((result["lists"] as? [Any])?.count, 0)
        XCTAssertEqual(sdk.listReads, 0)
    }

    func testSDKFailureRetiresOwner() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk); reply(.failure(.failed))
        await refused { _ = try await run.value }; _ = try await core.readAppleRemindersSettings()
    }

    func testRetiredPageAfterOSCallbackDoesNotReadLists() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk), calls = Calls(); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { calls.firstOnly() } }
        let reply = try await accepted(sdk); reply(.success(()))
        await refused { _ = try await run.value }; XCTAssertEqual(sdk.listReads, 0)
        _ = try await core.readAppleRemindersSettings()
    }

    func testCancellationWaitsForAcceptedCallbackBeforeRetirement() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk), settled = NativeAttachmentCancellation(); _ = try await core.start()
        let run = Task { defer { settled.cancel() }; return try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk); run.cancel()
        try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(settled.isCancelled)
        reply(.success(())); await refused { _ = try await run.value }
        XCTAssertTrue(settled.isCancelled); XCTAssertEqual(sdk.listReads, 0)
        _ = try await core.readAppleRemindersSettings()
    }

    func testCloseDrainsAcceptedPermissionCallback() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk), closed = NativeAttachmentCancellation(); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk)
        let closing = Task { await core.close(); closed.cancel() }
        try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(closed.isCancelled)
        reply(.success(())); await closing.value
        await refused { _ = try await run.value }; XCTAssertTrue(closed.isCancelled)
        XCTAssertEqual(sdk.listReads, 0)
    }

    func testPermissionReadmissionOwnerRejectsConflictingHostCalls() async throws {
        let sdk = AppleRemindersTestSDK(), core = host(sdk); _ = try await core.start()
        let entered = expectation(description: "Readmission entered"), release = NativeAttachmentCancellation()
        let run = Task { try await core.chooseAppleRemindersLists {
            entered.fulfill()
            while !release.isCancelled && !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
            return false
        } }
        await fulfillment(of: [entered], timeout: 3)
        await refused { _ = try await core.readAppleRemindersSettings() }
        await refused { _ = try await core.importAppleReminders() }
        release.cancel(); await refused { _ = try await run.value }
        XCTAssertEqual(sdk.requests, 0); _ = try await core.readAppleRemindersSettings()
    }

    func testRegistryReplacementBeforeCallbackPreventsAcknowledgment() async throws {
        let sdk = AppleRemindersTestSDK(), faults = HostIOFaults(); var storage: NativeDeviceKV?
        faults.configureDeviceStorage = { storage = $0 }
        let core = host(sdk, faults: faults); _ = try await core.start()
        let run = Task { try await core.chooseAppleRemindersLists { true } }
        let reply = try await accepted(sdk)
        try XCTUnwrap(storage).compareAndSetAppleRemindersImportState(expected: nil, next: #"{"autoImportOnOpen":true}"#)
        reply(.success(())); await refused { _ = try await run.value }
        XCTAssertEqual(sdk.listReads, 0); await core.close()
        let cold = host(sdk); _ = try await cold.start()
        let settings = try object(await cold.readAppleRemindersSettings())
        XCTAssertEqual((settings["settings"] as? [String: Any])?["autoImportOnOpen"] as? Bool, true)
    }
}
