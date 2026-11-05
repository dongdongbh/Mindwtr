import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class DropboxAuthorizationTestCurrent: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    func read() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    func retire() { lock.lock(); value = false; lock.unlock() }
}

final class NativeDropboxAuthorizationJobsTests: XCTestCase {
    private let requestID = "11111111-1111-4111-8111-111111111111"
    private func config() throws -> NativeDropboxConfiguration {
        try NativeDropboxConfiguration(clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect")
    }
    private func grant(_ id: String) -> NativeDropboxAuthorizationGrant {
        NativeDropboxAuthorizationGrant(requestID: id, clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect", code: "synthetic-code", codeVerifier: String(repeating: "v", count: 43))
    }
    private func input(_ id: String) -> String { "{\"version\":1,\"requestId\":\"\(id)\"}" }
    private func result(_ jobs: NativeDropboxAuthorizationJobs) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if let answer = jobs.next() { return try XCTUnwrap(NativeJSON.jsonObject(with: Data(answer.utf8)) as? [String: Any]) }
            Thread.sleep(forTimeInterval: 0.001)
        }
        throw HostFailure("Missing controlled Dropbox result")
    }
    func testPublicConfigurationRequiresExplicitExactBuildPair() throws {
        _ = try config()
        for id in ["", "has-dash", "has_underscore", "é", String(repeating: "a", count: 513)] {
            XCTAssertThrowsError(try NativeDropboxConfiguration(clientID: id, redirectURI: "mindwtr-native-dev://redirect"))
        }
        for uri in ["mindwtr://redirect", "mindwtr-native-dev://redirect/", "mindwtr-native-dev://other", "MINDWTR-NATIVE-DEV://redirect", "mindwtr-native-dev://redirect?state=x"] {
            XCTAssertThrowsError(try NativeDropboxConfiguration(clientID: "public123", redirectURI: uri))
        }
    }
    func testControlAndOnceOnlyGrantAreExactAndRequestBound() throws {
        let expected = grant(requestID)
        let jobs = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { true }, authorize: { _ in expected }, cancel: { _ in }), expectedRequestID: requestID)
        defer { jobs.closeAndDrain() }
        let configuration = try XCTUnwrap(NativeJSON.jsonObject(with: Data(jobs.control("{\"phase\":\"configuration\"}").utf8)) as? [String: Any])
        XCTAssertEqual(Set(configuration.keys), Set(["version", "clientId", "redirectUri"]))
        XCTAssertEqual(configuration["clientId"] as? String, "SyntheticPublic123")
        XCTAssertEqual(try jobs.control("{\"phase\":\"assertCurrent\"}"), "{\"current\":true}")
        let ticket = try jobs.submit(input(requestID))
        XCTAssertThrowsError(try jobs.submit(input(requestID)))
        let answer = try result(jobs)
        XCTAssertEqual(Set(answer.keys), Set(["id", "value"])); XCTAssertEqual(answer["id"] as? String, ticket)
        let wire = try XCTUnwrap(answer["value"] as? String)
        let value = try XCTUnwrap(NativeJSON.jsonObject(with: Data(wire.utf8)) as? [String: Any])
        XCTAssertEqual(Set(value.keys), Set(["version", "requestId", "clientId", "redirectUri", "code", "codeVerifier"]))
        XCTAssertEqual(value["requestId"] as? String, requestID)
        XCTAssertLessThanOrEqual(wire.utf8.count, 16_384)
        XCTAssertNil(jobs.next()); XCTAssertThrowsError(try jobs.submit(input(requestID)))
        jobs.closeAndDrain()
        XCTAssertThrowsError(try jobs.control("{\"phase\":\"configuration\"}"))
    }
    func testMalformedForeignOrNoAuthorizeInputNeverPresentsBrowser() throws {
        let entered = expectation(description: "browser must not present"); entered.isInverted = true
        let jobs = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { true }, authorize: { _ in entered.fulfill(); throw HostFailure("private") }, cancel: { _ in }), expectedRequestID: requestID)
        defer { jobs.closeAndDrain() }
        for raw in ["null", "[]", "{}", "{\"version\":true,\"requestId\":\"\(requestID)\"}", "{\"version\":1,\"requestId\":\"\(requestID)\",\"requestId\":\"\(requestID)\"}", "{\"version\":1,\"requestId\":\"\(requestID)\",\"url\":\"https://invalid.example\"}", input("22222222-2222-4222-8222-222222222222")] {
            XCTAssertThrowsError(try jobs.submit(raw))
        }
        for raw in ["{}", "{\"phase\":\"configuration\",\"extra\":true}", "{\"phase\":\"assertCurrent\",\"phase\":\"configuration\"}", "{\"phase\":\"authorize\"}"] { XCTAssertThrowsError(try jobs.control(raw)) }
        let noBrowser = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { true }, authorize: { _ in entered.fulfill(); throw HostFailure("private") }, cancel: { _ in }), expectedRequestID: nil)
        XCTAssertThrowsError(try noBrowser.submit(input(requestID))); noBrowser.closeAndDrain()
        wait(for: [entered], timeout: 0.01)
    }
    func testInvalidGrantCannotLeakPayloadOrProviderError() throws {
        let id = requestID
        let candidates = [
            NativeDropboxAuthorizationGrant(requestID: "22222222-2222-4222-8222-222222222222", clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect", code: "private-code", codeVerifier: String(repeating: "v", count: 43)),
            NativeDropboxAuthorizationGrant(requestID: id, clientID: "OtherPublic", redirectURI: "mindwtr-native-dev://redirect", code: "private-code", codeVerifier: String(repeating: "v", count: 43)),
            NativeDropboxAuthorizationGrant(requestID: id, clientID: "SyntheticPublic123", redirectURI: "mindwtr://redirect", code: "private-code", codeVerifier: String(repeating: "v", count: 43)),
            NativeDropboxAuthorizationGrant(requestID: id, clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect", code: String(repeating: "c", count: 8193), codeVerifier: String(repeating: "v", count: 43)),
            NativeDropboxAuthorizationGrant(requestID: id, clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect", code: "private-code", codeVerifier: String(repeating: "v", count: 42))
        ]
        for value in candidates {
            let jobs = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { true }, authorize: { _ in value }, cancel: { _ in }), expectedRequestID: id)
            _ = try jobs.submit(input(id))
            let answer = try result(jobs)
            XCTAssertEqual(Set(answer.keys), Set(["id", "error"]))
            XCTAssertEqual(answer["error"] as? String, "Dropbox authorization is unavailable")
            jobs.closeAndDrain()
        }
    }
    func testAbortAndCloseWaitForOriginalCallbackAndDiscardLateGrant() throws {
        let entered = expectation(description: "browser entered"), cancelled = expectation(description: "browser cancelled")
        let release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        let value = grant(requestID)
        let jobs = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { true }, authorize: { _ in
            entered.fulfill()
            guard release.wait(timeout: .now() + 5) == .success else { throw HostFailure("test timeout") }
            return value
        }, cancel: { id in XCTAssertEqual(id, value.requestID); cancelled.fulfill() }), expectedRequestID: requestID)
        let ticket = try jobs.submit(input(requestID))
        wait(for: [entered], timeout: 3)
        jobs.abort("unrelated-ticket")
        XCTAssertNil(jobs.next())
        DispatchQueue.global().async { jobs.abort(ticket); jobs.closeAndDrain(); drained.signal() }
        wait(for: [cancelled], timeout: 3)
        XCTAssertEqual(drained.wait(timeout: .now() + 0.03), .timedOut)
        XCTAssertThrowsError(try jobs.control("{\"phase\":\"assertCurrent\"}"))
        release.signal()
        XCTAssertEqual(drained.wait(timeout: .now() + 3), .success)
        let answer = try result(jobs)
        XCTAssertEqual(Set(answer.keys), Set(["id", "error"])); XCTAssertNil(answer["value"])
        jobs.closeAndDrain()
    }
    func testRetiredOwnerOrClosedRegistryCannotAuthorize() throws {
        let entered = expectation(description: "browser must not present"); entered.isInverted = true
        let binding = NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { false }, authorize: { _ in entered.fulfill(); throw HostFailure("private") }, cancel: { _ in })
        let registry = NativeAttachmentLocalRequests()
        let jobs = NativeDropboxAuthorizationJobs(registry: registry, binding: binding, expectedRequestID: requestID)
        XCTAssertThrowsError(try jobs.control("{\"phase\":\"configuration\"}"))
        XCTAssertThrowsError(try jobs.submit(input(requestID)))
        registry.close(); jobs.closeAndDrain()
        wait(for: [entered], timeout: 0.01)
    }
    func testCompletedUnconsumedGrantIsRemovedOnAbortCloseOrOwnerRetirement() throws {
        for mode in ["abort", "close", "owner"] {
            let owner = DropboxAuthorizationTestCurrent(), value = grant(requestID)
            let jobs = NativeDropboxAuthorizationJobs(registry: NativeAttachmentLocalRequests(), binding: NativeDropboxAuthorizationBinding(configuration: try config(), isCurrent: { owner.read() }, authorize: { _ in value }, cancel: { _ in }), expectedRequestID: requestID)
            let ticket = try jobs.submit(input(requestID))
            jobs.drain() // Authorize has finished; the successful grant is queued but unconsumed.
            if mode == "abort" { jobs.abort(ticket) }
            else if mode == "close" { jobs.closeAndDrain() }
            else { owner.retire() }
            let answer = try result(jobs)
            XCTAssertEqual(Set(answer.keys), Set(["id", "error"]), mode)
            XCTAssertEqual(answer["id"] as? String, ticket, mode)
            XCTAssertEqual(answer["error"] as? String, "Dropbox authorization is unavailable", mode)
            XCTAssertNil(answer["value"], mode)
            jobs.closeAndDrain()
        }
    }

}
