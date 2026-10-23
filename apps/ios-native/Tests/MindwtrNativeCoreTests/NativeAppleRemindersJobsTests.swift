import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAppleRemindersJobsTests: XCTestCase {
    private let read = "{\"op\":\"read\",\"listId\":\"list\",\"sourceId\":\"account\"}"
    private func result(_ jobs: NativeAppleRemindersJobs) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(jobs.next()).json.utf8)) as? [String: Any])
    }
    // Start, callback handoff, then drained settlement; this is not a provider drain.
    private func barrier(_ jobs: NativeAppleRemindersJobs) { jobs.workerBarrier(); jobs.workerBarrier(); jobs.workerBarrier() }

    func testAcceptedRemovalCancellationAndCloseWaitForSDKReturn() async throws {
        let sdk = AppleRemindersTestSDK(); let row = AppleRemindersTestSDK.row(); sdk.immediate = [row]
        let entered = expectation(description: "SDK removal accepted"), drained = expectation(description: "close drained")
        let gate = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        sdk.afterRemove = { entered.fulfill(); _ = gate.wait(timeout: .now() + 5) }
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let json = try JSONSerialization.data(withJSONObject: ["op": "remove", "listId": "list", "sourceId": "account", "source": row.source.providerValue])
        let id = try jobs.submit(String(decoding: json, as: UTF8.self))
        await fulfillment(of: [entered], timeout: 3)
        jobs.cancel(id); XCTAssertFalse(jobs.isDrained(id)); XCTAssertNil(jobs.next())
        Task { await jobs.closeAndDrain(); finished.signal(); drained.fulfill() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.05), .timedOut)
        gate.signal(); await fulfillment(of: [drained], timeout: 3)
        XCTAssertTrue(jobs.isDrained(id)); XCTAssertEqual(sdk.removals, ["item"])
        XCTAssertEqual(jobs.counters.active, 0); XCTAssertNil(jobs.next())
    }

    func testQueuedRemovalCancellationNeverCallsSDK() throws {
        let sdk = AppleRemindersTestSDK(), row = AppleRemindersTestSDK.row()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let a = try jobs.submit(read); barrier(jobs)
        let data = try JSONSerialization.data(withJSONObject: ["op": "remove", "listId": "list", "sourceId": "account", "source": row.source.providerValue])
        let b = try jobs.submit(String(decoding: data, as: UTF8.self)); jobs.cancel(b); jobs.cancel(a); barrier(jobs)
        XCTAssertEqual(sdk.removals, [])
        XCTAssertNotNil(jobs.next()); XCTAssertNotNil(jobs.next())
    }

    func testClosedGrammarEscapedDuplicatesAndByteIDsRefuseBeforeFactory() throws {
        var factories = 0
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { factories += 1; return .init() })
        let invalid = ["null", "[]", "{\"op\":\"delete\"}", "{\"op\":\"permission\",\"extra\":true}",
            "{\"op\":\"permission\",\"\\u006fp\":\"permission\"}", "{\"op\":\"read\",\"listId\":\"list\"}",
            "{\"op\":\"read\",\"listId\":false,\"sourceId\":\"account\"}",
            "{\"op\":\"read\",\"listId\":\"\",\"sourceId\":\"account\"}",
            "{\"op\":\"read\",\"listId\":\"\(String(repeating: "é", count: 513))\",\"sourceId\":\"account\"}"]
        for json in invalid { XCTAssertThrowsError(try jobs.submit(json)) }
        XCTAssertThrowsError(try jobs.submit(String(repeating: " ", count: 1_048_577)))
        XCTAssertEqual(factories, 0); XCTAssertEqual(jobs.counters.accepted, 0)
    }

    func testPassivePermissionAndTwoReadySlotsBoundAdmission() throws {
        let sdk = AppleRemindersTestSDK()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let a = try jobs.submit("{\"op\":\"permission\"}"), b = try jobs.submit("{\"op\":\"lists\"}")
        barrier(jobs); XCTAssertThrowsError(try jobs.submit(read))
        XCTAssertEqual(try result(jobs)["id"] as? String, a)
        XCTAssertEqual(try result(jobs)["id"] as? String, b)
        XCTAssertEqual(sdk.requests, 0); XCTAssertEqual(sdk.fetches, 0)
        XCTAssertEqual(jobs.counters.accepted, 0)
    }

    func testHeldReadSerializesQueuedWorkAndEmptySuccess() throws {
        let sdk = AppleRemindersTestSDK()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let a = try jobs.submit(read), b = try jobs.submit(read)
        barrier(jobs); XCTAssertEqual(sdk.fetches, 1); XCTAssertNil(jobs.next())
        sdk.deliver([]); barrier(jobs); XCTAssertEqual(sdk.fetches, 2)
        XCTAssertEqual(try result(jobs)["id"] as? String, a)
        sdk.deliver([]); barrier(jobs)
        XCTAssertEqual(try result(jobs)["id"] as? String, b)
    }

    func testCancellationBeforeQueuedEntryAndActiveCancelNeedNoSDKCallback() throws {
        let sdk = AppleRemindersTestSDK()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let a = try jobs.submit(read), b = try jobs.submit(read)
        barrier(jobs); jobs.cancel(b); jobs.cancel(a); barrier(jobs); barrier(jobs)
        let answers = [try result(jobs), try result(jobs)]
        XCTAssertEqual(Set(answers.compactMap { $0["id"] as? String }), Set([a, b]))
        XCTAssertTrue(answers.allSatisfy { $0["error"] as? String == "Apple Reminders request cancelled" })
        XCTAssertEqual(sdk.fetches, 1); XCTAssertEqual(sdk.cancellations.count, 1)
        XCTAssertEqual(jobs.counters.active, 0)
    }

    func testCancelBeforeTokenPublicationSuppressesConversionAndCancelsExactHandle() throws {
        let sdk = AppleRemindersTestSDK(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        sdk.beforeFetchReturn = { entered.signal(); _ = release.wait(timeout: .now() + 5) }
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let id = try jobs.submit(read)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        jobs.cancel(id); var conversions = 0
        sdk.receive? { conversions += 1; return [] }
        release.signal(); barrier(jobs); barrier(jobs)
        XCTAssertEqual(try result(jobs)["error"] as? String, "Apple Reminders request cancelled")
        XCTAssertEqual(conversions, 0); XCTAssertEqual(sdk.cancellations.count, 1)
    }

    func testCancelAfterReadyRefusesSuccessAndDuplicateCallbackDoesNotRepublish() throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = []
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let id = try jobs.submit(read); barrier(jobs); barrier(jobs)
        jobs.cancel(id); sdk.deliver([]); barrier(jobs)
        XCTAssertNotNil(try result(jobs)["error"]); XCTAssertNil(jobs.next())
    }

    func testFreshPermissionAndSourceReplacementRefuseCallbackAdoption() throws {
        for changePermission in [false, true] {
            let sdk = AppleRemindersTestSDK(); var permission = NativeAppleRemindersPermission.granted
            let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { permission }, sdkFactory: { sdk }) })
            _ = try jobs.submit(read); barrier(jobs)
            if changePermission { permission = .denied }
            else { sdk.listValues = [.init(identity: .init(id: "list", sourceID: "replacement"), title: "List", color: nil)] }
            sdk.deliver([AppleRemindersTestSDK.row()]); barrier(jobs)
            XCTAssertNotNil(try result(jobs)["error"])
        }
    }

    func testCloseDrainsSuppressedFetchWithoutWakeAndRejectsAdmission() async throws {
        let sdk = AppleRemindersTestSDK(); var wakes = 0
        let registry = NativeAttachmentLocalRequests()
        let jobs = NativeAppleRemindersJobs(registry: registry, providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        jobs.setWake { wakes += 1 }
        _ = try jobs.submit(read); barrier(jobs)
        await jobs.closeAndDrain()
        sdk.deliver([]); barrier(jobs)
        XCTAssertEqual(wakes, 0); XCTAssertEqual(sdk.cancellations.count, 1)
        XCTAssertEqual(jobs.counters.accepted, 0); XCTAssertEqual(jobs.counters.active, 0)
        XCTAssertThrowsError(try jobs.submit(read)); XCTAssertNil(jobs.next())
    }

    func testClosePermissionRetainsRealCallbackAndReturnsOnlyAfterIt() async throws {
        let sdk = AppleRemindersTestSDK(), entered = expectation(description: "close entered")
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        _ = try jobs.submit("{\"op\":\"requestPermission\"}"); barrier(jobs)
        let drained = Task { entered.fulfill(); await jobs.closeAndDrain() }
        await fulfillment(of: [entered], timeout: 2); barrier(jobs)
        XCTAssertEqual(jobs.counters.active, 1)
        sdk.permissionCompletion?(.success(())); await drained.value
        XCTAssertEqual(jobs.counters.active, 0); XCTAssertEqual(jobs.counters.accepted, 0)
    }

    func testConsumedCancelledPermissionStillOwnsSlotUntilRealCallback() throws {
        let sdk = AppleRemindersTestSDK()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        let permission = try jobs.submit("{\"op\":\"requestPermission\"}")
        let queued = try jobs.submit("{\"op\":\"permission\"}"); barrier(jobs)
        jobs.cancel(permission); barrier(jobs)
        XCTAssertEqual(try result(jobs)["id"] as? String, permission)
        XCTAssertEqual(jobs.counters.accepted, 2); XCTAssertEqual(jobs.counters.active, 1)
        XCTAssertThrowsError(try jobs.submit(read))
        sdk.permissionCompletion?(.success(())); barrier(jobs)
        XCTAssertEqual(try result(jobs)["id"] as? String, queued)
        XCTAssertNil(jobs.next()); XCTAssertEqual(jobs.counters.accepted, 0)
    }

    func testCloseDuringConversionWaitsAndDoesNotPublishOrRecheckSDK() async throws {
        let sdk = AppleRemindersTestSDK(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let closeStarted = expectation(description: "close started"), closeReturned = DispatchSemaphore(value: 0)
        let registry = NativeAttachmentLocalRequests()
        let jobs = NativeAppleRemindersJobs(registry: registry, providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        _ = try jobs.submit(read); barrier(jobs)
        DispatchQueue.global().async {
            sdk.receive? { entered.signal(); _ = release.wait(timeout: .now() + 5); return [] }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        let listReads = sdk.listReads
        registry.close(); barrier(jobs)
        let closing = Task { closeStarted.fulfill(); await jobs.closeAndDrain(); closeReturned.signal() }
        await fulfillment(of: [closeStarted], timeout: 2); barrier(jobs)
        XCTAssertEqual(closeReturned.wait(timeout: .now()), .timedOut)
        release.signal(); await closing.value
        XCTAssertEqual(jobs.counters.active, 0); XCTAssertNil(jobs.next())
        XCTAssertEqual(sdk.cancellations.count, 1)
        XCTAssertEqual(sdk.listReads, listReads)
    }

    func testWholeReplyByteLimitFailsWithoutPartialValue() throws {
        let sdk = AppleRemindersTestSDK()
        let jobs = NativeAppleRemindersJobs(registry: .init(), providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        // Each note fits its field cap. The second case exceeds only after JSON escaping.
        for note in [String(repeating: "x", count: 1_048_576), String(repeating: "\n", count: 524_288)] {
            _ = try jobs.submit(read); barrier(jobs)
            sdk.deliver((0..<8).map { AppleRemindersTestSDK.row(String($0), notes: note) })
            barrier(jobs); let answer = try result(jobs)
            XCTAssertEqual(answer["error"] as? String, "Apple Reminders reply exceeds the limit")
            XCTAssertNil(answer["value"])
        }
    }

    func testRegistryCloseCancelsExactOwnedJobsAndLaterCallbacksCannotAdopt() throws {
        let sdk = AppleRemindersTestSDK(), registry = NativeAttachmentLocalRequests()
        let jobs = NativeAppleRemindersJobs(registry: registry, providerFactory: { .init(status: { .granted }, sdkFactory: { sdk }) })
        _ = try jobs.submit(read); barrier(jobs); registry.close(); barrier(jobs); barrier(jobs)
        sdk.deliver([]); barrier(jobs)
        XCTAssertNotNil(try result(jobs)["error"]); XCTAssertEqual(jobs.counters.active, 0)
        XCTAssertThrowsError(try jobs.submit(read))
    }
}
