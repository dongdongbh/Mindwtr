import Foundation
import XCTest
@testable import MindwtrGmailAuthorizationCore

private final class MemoryVault: GmailCredentialVault {
    var credentials: GmailNativeCredentials?
    var fail = false
    var writes: [GmailNativeCredentials?] = []
    init(_ credentials: GmailNativeCredentials? = nil) { self.credentials = credentials }
    func read() throws -> GmailNativeCredentials? {
        if fail { throw GmailAuthorizationFailure.storage }
        return credentials
    }
    func write(_ credentials: GmailNativeCredentials?) throws {
        if fail { throw GmailAuthorizationFailure.storage }
        self.credentials = credentials
        writes.append(credentials)
    }
}
private final class HTTPStub: GmailHTTPTransport {
    let handler: (URLRequest) async throws -> Data
    private let lock = NSLock()
    private var cancellations = 0
    var cancelCount: Int { lock.lock(); defer { lock.unlock() }; return cancellations }
    init(_ handler: @escaping (URLRequest) async throws -> Data) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> Data { try await handler(request) }
    func cancel() { lock.lock(); cancellations += 1; lock.unlock() }
}
@MainActor
private final class BrowserStub: GmailAuthorizationBrowser {
    var count = 0
    var handler: ((URL) async throws -> URL)?
    func authorize(_ url: URL, callbackScheme: String, generation: UInt64) async throws -> URL {
        count += 1
        if let handler { return try await handler(url) }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value!) })
        XCTAssertEqual(values["scope"], GmailAuthorizationConfiguration.scope)
        XCTAssertEqual(values["code_challenge_method"], "S256")
        XCTAssertEqual(values["prompt"], "select_account consent")
        XCTAssertEqual(values["code_challenge"]?.count, 43)
        var callback = URLComponents(string: values["redirect_uri"]!)!
        XCTAssertEqual(callback.scheme, callbackScheme)
        callback.queryItems = [.init(name: "state", value: values["state"]!), .init(name: "code", value: "test-code")]
        return callback.url!
    }
    func cancel(generation: UInt64) {}
}
private actor Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

final class GmailAuthorizationTests: XCTestCase {
    private let configuration = GmailAuthorizationConfiguration(clientId: "123-test.apps.googleusercontent.com", enabled: true)!
    private func credentials(expired: Bool = false) throws -> GmailNativeCredentials {
        let identity = try GmailAuthorizationConfiguration.account("designated@example.test")
        return GmailNativeCredentials(accessToken: "old-access", refreshToken: "old-refresh",
            expiresAt: expired ? .distantPast : Date().addingTimeInterval(3600), account: identity.0, accountId: identity.1)
    }
    private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    private func token(scope: Bool = true) throws -> Data {
        var value: [String: Any] = ["access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600, "token_type": "Bearer"]
        if scope { value["scope"] = GmailAuthorizationConfiguration.scope }
        return try json(value)
    }
    private func client(vault: MemoryVault, http: HTTPStub) async -> (GmailAuthorizationClient, BrowserStub) {
        let browser = await MainActor.run { BrowserStub() }
        return (GmailAuthorizationClient(configuration: configuration, vault: vault, http: http, browser: browser), browser)
    }

    func testReadOnlyPathAllowlistRejectsAlternateHostsTraversalAndQueryEscapes() throws {
        for path in ["profile", "labels", "labels/Label_1", "messages?labelIds=Label_1&maxResults=25&pageToken=a%2Bb", "messages/abc123?format=full"] {
            let url = try GmailAuthorizationConfiguration.apiURL(path)
            XCTAssertEqual(url.host, "gmail.googleapis.com")
            XCTAssertTrue(url.path.hasPrefix("/gmail/v1/users/me/"))
        }
        XCTAssertTrue(try GmailAuthorizationConfiguration.apiURL("messages?pageToken=a%2Bb").absoluteString.contains("pageToken=a%2Bb"))
        for path in ["https://evil.test/profile", "//evil.test/profile", "/profile", "messages/../profile", "messages/%2E%2E", "messages/abc/attachments/id", "messages?maxResults=26", "messages?maxResults=25&maxResults=1", "messages/abc?format=raw", "profile#fragment", "labels?access_token=secret", "messages\\profile"] {
            XCTAssertThrowsError(try GmailAuthorizationConfiguration.apiURL(path), path)
        }
    }

    func testCallbackRequiresExactSchemePathStateAndOneCode() throws {
        let good = "\(configuration.redirect)?state=expected&code=test-code"
        XCTAssertEqual(try configuration.callbackCode(URL(string: good)!, state: "expected"), "test-code")
        for value in [good.replacingOccurrences(of: "/oauthredirect", with: "/other"), good.replacingOccurrences(of: "state=expected", with: "state=wrong"), good + "&state=expected", good + "&code=second", good + "&error=denied", "other:/oauthredirect?state=expected&code=test", "\(configuration.callbackScheme)://host/oauthredirect?state=expected&code=test"] {
            XCTAssertThrowsError(try configuration.callbackCode(URL(string: value)!, state: "expected"))
        }
    }

    func testConfigurationGateAndDesktopAccountIdentity() throws {
        XCTAssertNil(GmailAuthorizationConfiguration(clientId: configuration.clientId, enabled: false))
        XCTAssertNil(GmailAuthorizationConfiguration(clientId: "https://evil.test", enabled: true))
        let first = try GmailAuthorizationConfiguration.account("  Designated@Example.Test\n")
        let second = try GmailAuthorizationConfiguration.account("designated@example.test")
        XCTAssertEqual(first.0, second.0)
        XCTAssertEqual(first.1, second.1)
        XCTAssertEqual(first.1.count, 64)
        XCTAssertEqual(first.1, "3060599fb9a895dcfbbbff284ab2a08c740c5631edd78a83cc5402ebbca4b53c")
    }

    func testConnectUsesPKCEAndKeepsCredentialsNative() async throws {
        let vault = MemoryVault(try credentials())
        let http = HTTPStub { request in
            if request.url == GmailAuthorizationConfiguration.token {
                XCTAssertEqual(request.httpMethod, "POST")
                let form = String(data: request.httpBody!, encoding: .utf8)!
                XCTAssertTrue(form.contains("code_verifier="))
                XCTAssertFalse(form.contains("client_secret"))
                return try self.token()
            }
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/gmail/v1/users/me/profile")
            return try self.json(["emailAddress": "Designated@Example.Test"])
        }
        let (client, _) = await client(vault: vault, http: http)
        let status = try await client.connect()
        XCTAssertEqual(status["connected"] as? Bool, true)
        XCTAssertEqual(status["account"] as? String, "designated@example.test")
        XCTAssertEqual(Set(status.keys), ["available", "connected", "account", "accountId"])
        XCTAssertEqual(vault.writes.count, 2)
        XCTAssertNil(vault.writes[0])
        XCTAssertEqual(vault.credentials?.refreshToken, "new-refresh")
    }

    func testMissingGrantedScopeDoesNotPersistTokens() async throws {
        let vault = MemoryVault(try credentials())
        let (client, _) = await client(vault: vault, http: HTTPStub { _ in try self.token(scope: false) })
        do { _ = try await client.connect(); XCTFail("must reject unproved scope") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .auth) }
        XCTAssertNil(vault.credentials)
    }

    func testRefreshIdentityMismatchCannotSwitchAccountsOrPersistRotation() async throws {
        let vault = MemoryVault(try credentials(expired: true))
        let (client, _) = await client(vault: vault, http: HTTPStub { request in
            if request.url == GmailAuthorizationConfiguration.token { return try self.token() }
            return try self.json(["emailAddress": "other@example.test"])
        })
        do { _ = try await client.get("labels"); XCTFail("must reject account switch") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .auth) }
        XCTAssertNil(vault.credentials)
        XCTAssertFalse(vault.writes.compactMap { $0 }.contains { $0.refreshToken == "new-refresh" })
        let status = try await client.status()
        XCTAssertEqual(status["connected"] as? Bool, false)
    }

    func testStaleRefreshAfterDisconnectCannotRestoreTokens() async throws {
        let vault = MemoryVault(try credentials(expired: true))
        let entered = expectation(description: "refresh entered")
        let gate = Gate()
        let (client, _) = await client(vault: vault, http: HTTPStub { request in
            if request.url == GmailAuthorizationConfiguration.token {
                entered.fulfill(); await gate.wait(); return try self.token()
            }
            XCTAssertEqual(request.url, GmailAuthorizationConfiguration.revoke)
            throw GmailAuthorizationFailure.network
        })
        let request = Task { try await client.get("labels") }
        await fulfillment(of: [entered], timeout: 2)
        let result = try await client.disconnect()
        XCTAssertEqual(result["revoked"] as? Bool, false)
        await gate.release()
        do { _ = try await request.value; XCTFail("must reject stale refresh") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .cancelled) }
        XCTAssertNil(vault.credentials)
    }

    func testStaleConsentAfterCancelCannotExchangeOrPersistTokens() async throws {
        let vault = MemoryVault(try credentials())
        let entered = expectation(description: "consent entered")
        let gate = Gate()
        let (client, browser) = await client(vault: vault, http: HTTPStub { _ in XCTFail("cancelled consent must not use HTTP"); return Data() })
        await MainActor.run {
            browser.handler = { url in
                entered.fulfill(); await gate.wait()
                let values = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                return URL(string: "\(self.configuration.redirect)?state=\(values["state"]!)&code=test")!
            }
        }
        let connection = Task { try await client.connect() }
        await fulfillment(of: [entered], timeout: 2)
        await client.cancel()
        await gate.release()
        do { _ = try await connection.value; XCTFail("must reject late consent") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .cancelled) }
        XCTAssertNil(vault.credentials)
    }

    func testUnconnectedGetDoesNotRetirePendingConsent() async throws {
        let vault = MemoryVault(try credentials())
        let entered = expectation(description: "consent entered")
        let gate = Gate()
        let http = HTTPStub { request in
            if request.url == GmailAuthorizationConfiguration.token { return try self.token() }
            return try self.json(["emailAddress": "designated@example.test"])
        }
        let (client, browser) = await client(vault: vault, http: http)
        await MainActor.run {
            browser.handler = { url in
                entered.fulfill(); await gate.wait()
                let values = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                return URL(string: "\(self.configuration.redirect)?state=\(values["state"]!)&code=test")!
            }
        }
        let connection = Task { try await client.connect() }
        await fulfillment(of: [entered], timeout: 2)
        let cancellations = http.cancelCount
        do { _ = try await client.get("labels"); XCTFail("must require a connected account") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .auth) }
        XCTAssertEqual(http.cancelCount, cancellations)
        await gate.release()
        let status = try await connection.value
        XCTAssertEqual(status["connected"] as? Bool, true)
    }

    func testRevokeAdmissionGuardSurvivesCancelWithoutCancellingHTTPAndReleasesOnFailure() async throws {
        let vault = MemoryVault(try credentials())
        let entered = expectation(description: "revoke entered")
        let gate = Gate()
        let http = HTTPStub { request in
            XCTAssertEqual(request.url, GmailAuthorizationConfiguration.revoke)
            entered.fulfill(); await gate.wait(); throw GmailAuthorizationFailure.network
        }
        let (client, browser) = await client(vault: vault, http: http)
        let disconnection = Task { try await client.disconnect() }
        await fulfillment(of: [entered], timeout: 2)
        let cancellations = http.cancelCount
        await client.cancel()
        XCTAssertEqual(http.cancelCount, cancellations, "cancel must not abort an in-flight revocation")
        do { _ = try await client.connect(); XCTFail("must not start consent during revoke") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .network) }
        let count = await MainActor.run { browser.count }
        XCTAssertEqual(count, 0)
        await gate.release()
        _ = try await disconnection.value
        await MainActor.run { browser.handler = { _ in throw GmailAuthorizationFailure.cancelled } }
        do { _ = try await client.connect(); XCTFail("cancel test consent") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .cancelled) }
    }

    func testFailedSecureDeleteStopsCurrentConnection() async throws {
        let vault = MemoryVault(try credentials())
        let (client, _) = await client(vault: vault, http: HTTPStub { _ in XCTFail("delete failure must not use HTTP"); return Data() })
        _ = try await client.status()
        vault.fail = true
        do { _ = try await client.disconnect(); XCTFail("must fail closed") }
        catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .storage) }
        let status = try await client.status()
        XCTAssertEqual(status["connected"] as? Bool, false)
    }
}

private final class BoundedURLProtocol: URLProtocol {
    static var payloads: [Data] = []
    static var contentLength: Int?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let headers = Self.contentLength.map { ["Content-Length": String($0)] }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        Self.payloads.forEach { client?.urlProtocol(self, didLoad: $0) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class GmailHTTPBoundsTests: XCTestCase {
    func testStreamingLimitWithAndWithoutContentLength() async throws {
        for declaredLength in [nil, GmailBoundedHTTPTransport.responseLimit + 1] as [Int?] {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [BoundedURLProtocol.self]
            let http = GmailBoundedHTTPTransport(configuration: configuration)
            BoundedURLProtocol.contentLength = declaredLength
            BoundedURLProtocol.payloads = [Data(repeating: 32, count: GmailBoundedHTTPTransport.responseLimit), Data([32])]
            do {
                _ = try await http.send(URLRequest(url: URL(string: GmailAuthorizationConfiguration.api + "profile")!))
                XCTFail("must refuse oversized response")
            } catch { XCTAssertEqual(error as? GmailAuthorizationFailure, .other) }
        }
        BoundedURLProtocol.payloads = []
    }
}
