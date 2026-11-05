import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

final class NativeDropboxSelectedAdmissionTests: XCTestCase {
    private func json(_ input: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]), as: UTF8.self) }
    private func config() throws -> NativeDropboxConfiguration { try NativeDropboxConfiguration(clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect") }
    func testOnlySelectedLiteralContentPathAndFixedPostAreAdmitted() throws {
        let key = "attachments/源-e\u{0301}.txt"
        let input: [String: Any] = ["url": "https://content.dropboxapi.com/2/files/download", "method": "POST", "redirect": "error", "headers": [["authorization", "Bearer synthetic"], ["dropbox-api-arg", try json(["path": "/" + key])]]]
        try NativeDropboxSelectedAdmission.validateHTTP(json(input), configuration: config(), cloudKey: key)
        let changes: [[String: Any]] = [["url": "https://content.dropboxapi.com/2/files/upload"], ["method": "GET"], ["redirect": "follow"], ["text": ""], ["headers": [["authorization", "Bearer synthetic"], ["dropbox-api-arg", try json(["path": "/attachments/源-é.txt"])]]]]
        for change in changes {
            XCTAssertThrowsError(try NativeDropboxSelectedAdmission.validateHTTP(json(input.merging(change) { _, new in new }), configuration: config(), cloudKey: key))
        }
    }
    func testRefreshHasExactFormClientAndEndpoint() throws {
        let input: [String: Any] = ["url": "https://api.dropboxapi.com/oauth2/token", "method": "POST", "redirect": "error", "headers": [["content-type", "application/x-www-form-urlencoded"]], "text": "grant_type=refresh_token&refresh_token=synthetic%2Brefresh&client_id=SyntheticPublic123"]
        try NativeDropboxSelectedAdmission.validateHTTP(json(input), configuration: config(), cloudKey: "attachments/a")
        for text in ["grant_type=authorization_code&refresh_token=x&client_id=SyntheticPublic123", "grant_type=refresh_token&refresh_token=x&client_id=foreign", "grant_type=refresh_token&refresh_token=x&client_id=SyntheticPublic123&client_id=SyntheticPublic123", "grant_type=refresh_token&refresh_token=x&client_id=SyntheticPublic123&client_secret=x"] {
            XCTAssertThrowsError(try NativeDropboxSelectedAdmission.validateHTTP(json(input.merging(["text": text]) { _, new in new }), configuration: config(), cloudKey: "attachments/a"))
        }
    }
    func testSelectedSecretWritesAreOnlyExistingTokenAccountWhenUnlocked() throws {
        try NativeDropboxSelectedAdmission.validateSecret(json(["op": "get", "key": "mindwtr_dropbox_tokens"]))
        try NativeDropboxSelectedAdmission.validateSecret(json(["op": "set", "key": "mindwtr_dropbox_tokens", "value": "synthetic", "accessibility": "when-unlocked"]))
        let refused: [[String: Any]] = [["op": "delete", "key": "mindwtr_dropbox_tokens"], ["op": "get", "key": "other"], ["op": "get", "key": "mindwtr_dropbox_tokens", "extra": true], ["op": "set", "key": "mindwtr_dropbox_tokens", "value": "synthetic", "accessibility": "after-first-unlock"]]
        for input in refused {
            XCTAssertThrowsError(try NativeDropboxSelectedAdmission.validateSecret(json(input)))
        }
    }
}

/// URLProtocol and fault statuses keep selected production Host tests off network and real Keychain.
final class NativeDropboxSelectedHTTPFixture: @unchecked Sendable {
    private let lock = NSLock()
    let path: String
    let bytes: Data
    var notFound = false
    private var refreshes = 0, downloads = 0, unexpected = 0
    init(path: String, bytes: Data) { self.path = path; self.bytes = bytes }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [refreshes, downloads, unexpected] }
    func respond(_ request: URLRequest) -> (Int, Data) {
        lock.lock(); defer { lock.unlock() }
        guard request.httpMethod == "POST" else { unexpected += 1; return (400, Data()) }
        if request.url?.absoluteString == "https://api.dropboxapi.com/oauth2/token" {
            refreshes += 1
            return (200, Data("{\"access_token\":\"controlled-refreshed\",\"expires_in\":14400}".utf8))
        }
        if request.url?.absoluteString == "https://content.dropboxapi.com/2/files/download",
           request.value(forHTTPHeaderField: "Authorization") == "Bearer controlled-refreshed",
           let raw = request.value(forHTTPHeaderField: "Dropbox-API-Arg"),
           let arg = try? NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: String], arg["path"] == path {
            downloads += 1
            return notFound ? (409, Data("{\"error_summary\":\"path/not_found/fixture\",\"error\":{\".tag\":\"path\",\"path\":{\".tag\":\"not_found\"}}}".utf8)) : (200, bytes)
        }
        unexpected += 1; return (400, Data())
    }
    func configure(_ faults: HostIOFaults) {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [NativeDropboxSelectedHTTPProtocol.self]
        faults.httpConfiguration = configuration
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        // Simulate an available empty keystore and accepted synthetic writes; no SecItem call executes.
        faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : errSecSuccess }
        NativeDropboxSelectedHTTPProtocol.install(self)
    }
    static func binding() throws -> NativeDropboxAuthorizationBinding {
        NativeDropboxAuthorizationBinding(configuration: try NativeDropboxConfiguration(clientID: "SyntheticPublic123", redirectURI: "mindwtr-native-dev://redirect"), isCurrent: { true }, authorize: { _ in
            XCTFail("Selected download must never authorize or present a browser"); throw HostFailure("Unexpected browser")
        }, cancel: { _ in XCTFail("Selected download has no browser to cancel") })
    }
}
private final class NativeDropboxSelectedHTTPProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var fixture: NativeDropboxSelectedHTTPFixture?
    static func install(_ value: NativeDropboxSelectedHTTPFixture) { lock.lock(); fixture = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.fixture; Self.lock.unlock()
        guard let state, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        let (status, bytes) = state.respond(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
