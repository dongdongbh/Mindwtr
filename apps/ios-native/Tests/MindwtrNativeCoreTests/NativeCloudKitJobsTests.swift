import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCloudKitJobsTests: XCTestCase {
    private func result(_ jobs: NativeCloudKitJobs) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if let value = jobs.next() {
                return try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
            }
            Thread.sleep(forTimeInterval: 0.001)
        }
        throw HostFailure("Missing CloudKit test result")
    }

    func testMalformedAndDuplicateJSONNeverEntersTransport() throws {
        let entered = expectation(description: "transport must not run"); entered.isInverted = true
        let jobs = NativeCloudKitJobs(registry: NativeAttachmentLocalRequests(), perform: { _ in
            entered.fulfill(); return "null"
        }, cancel: {})
        defer { jobs.closeAndDrain() }
        for input in ["null", "[]", "bad", "{\"op\":1,\"op\":2}", "{\"op\":1,\"\\u006fp\":2}"] {
            XCTAssertThrowsError(try jobs.submit(input))
        }
        wait(for: [entered], timeout: 0.01)
    }

    func testRepliesRemainOwnedUntilConsumedAndErrorsHideProviderDetails() throws {
        let jobs = NativeCloudKitJobs(registry: NativeAttachmentLocalRequests(), perform: { input in
            if input == "{}" { return "\"available\"" }
            throw NSError(domain: "private-account-and-record", code: 1)
        }, cancel: {})
        defer { jobs.closeAndDrain() }
        let id = try jobs.submit("{}")
        XCTAssertThrowsError(try jobs.submit("{}"))
        let answer = try result(jobs)
        XCTAssertEqual(answer["id"] as? String, id)
        XCTAssertEqual(answer["value"] as? String, "\"available\"")
        _ = try jobs.submit("{\"op\":\"fail\"}")
        let failure = try result(jobs)
        XCTAssertEqual(failure["error"] as? String, "CloudKit operation failed")
        XCTAssertNil(failure["value"])
    }

    func testCloseCancelsSDKButWaitsForOriginalCallbackAndRefusesLaterCalls() throws {
        let entered = expectation(description: "SDK entered"), cancelled = expectation(description: "SDK cancelled")
        let drained = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let jobs = NativeCloudKitJobs(registry: NativeAttachmentLocalRequests(), perform: { _ in
            entered.fulfill()
            guard release.wait(timeout: .now() + 5) == .success else { throw HostFailure("test timed out") }
            return "null"
        }, cancel: { cancelled.fulfill() })
        _ = try jobs.submit("{}")
        wait(for: [entered], timeout: 3)
        DispatchQueue.global().async { jobs.closeAndDrain(); drained.signal() }
        wait(for: [cancelled], timeout: 3)
        XCTAssertThrowsError(try jobs.submit("{}"))
        XCTAssertNil(jobs.next(), "An SDK cancellation request is not callback completion")
        XCTAssertEqual(drained.wait(timeout: .now() + 0.03), .timedOut)
        release.signal()
        XCTAssertEqual(drained.wait(timeout: .now() + 3), .success)
        let answer = try result(jobs)
        XCTAssertEqual(answer["error"] as? String, "CloudKit operation was cancelled")
        XCTAssertNil(answer["value"])
        jobs.closeAndDrain()
    }

    func testClosingRegistryRetiresTransportEvenWithoutPendingOperation() throws {
        let registry = NativeAttachmentLocalRequests()
        let cancelled = expectation(description: "SDK retired")
        let jobs = NativeCloudKitJobs(registry: registry, perform: { _ in "null" }, cancel: { cancelled.fulfill() })
        registry.close()
        wait(for: [cancelled], timeout: 3)
        XCTAssertThrowsError(try jobs.submit("{}"))
        jobs.closeAndDrain()
    }
}
