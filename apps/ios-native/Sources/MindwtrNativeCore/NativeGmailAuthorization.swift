import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
import AuthenticationServices
import UIKit
#endif

enum NativeGmailFailure: String, Error {
    case auth = "E_GMAIL_AUTH"
    case network = "E_GMAIL_NETWORK"
    case config = "E_GMAIL_CONFIG"
    case cancelled = "E_GMAIL_CANCELLED"
    case storage = "E_GMAIL_STORAGE"
    case other = "E_GMAIL_OTHER"

    var message: String {
        switch self {
        case .auth: return "Reconnect Gmail to restore access."
        case .network: return "Gmail is temporarily unreachable."
        case .config: return "Check your Gmail connection and configuration."
        case .cancelled: return "Gmail connection cancelled."
        case .storage: return "Gmail credentials could not be saved securely."
        case .other: return "Gmail returned an unsupported or oversized response."
        }
    }
}

struct NativeGmailConfiguration {
    static let scope = "https://www.googleapis.com/auth/gmail.readonly"
    static let api = "https://gmail.googleapis.com/gmail/v1/users/me/"
    static let token = URL(string: "https://oauth2.googleapis.com/token")!
    static let revoke = URL(string: "https://oauth2.googleapis.com/revoke")!
    let clientId: String
    let callbackScheme: String
    var redirect: String { "\(callbackScheme):/oauthredirect" }

    init?(clientId: String?, enabled: Bool) {
        guard enabled, let clientId, clientId.hasSuffix(".apps.googleusercontent.com"),
              clientId.utf8.allSatisfy({ $0.isASCIIAlphaNumeric || $0 == 45 || $0 == 46 }),
              clientId.count > ".apps.googleusercontent.com".count else { return nil }
        self.clientId = clientId
        self.callbackScheme = clientId.split(separator: ".").reversed().joined(separator: ".")
    }

    static func account(_ email: String) throws -> (String, String) {
        let email = String(decoding: email.trimmingCharacters(in: .whitespacesAndNewlines).utf8.map {
            (65...90).contains($0) ? $0 + 32 : $0
        }, as: UTF8.self)
        guard email.utf8.count <= 320, email.contains("@"),
              !email.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw NativeGmailFailure.other
        }
        return (email, SHA256.hash(data: Data(email.utf8)).map { String(format: "%02x", $0) }.joined())
    }

    static func randomSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NativeGmailFailure.other
        }
        return Data(bytes).base64URL
    }

    static func apiURL(_ path: String) throws -> URL {
        guard !path.isEmpty, path.utf8.count <= 8192, !path.hasPrefix("/"),
              !path.contains("\\"), !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              let relative = URLComponents(string: path), relative.scheme == nil,
              relative.host == nil, relative.fragment == nil, relative.user == nil,
              relative.password == nil, relative.port == nil, !relative.percentEncodedPath.contains("%") else {
            throw NativeGmailFailure.config
        }
        let parts = relative.path.split(separator: "/", omittingEmptySubsequences: false)
        guard (parts.count == 1 && ["profile", "labels", "messages"].contains(String(parts[0])))
                || (parts.count == 2 && ["labels", "messages"].contains(String(parts[0])) && validId(String(parts[1]))) else {
            throw NativeGmailFailure.config
        }
        let query = relative.queryItems ?? []
        guard Set(query.map(\.name)).count == query.count else { throw NativeGmailFailure.config }
        for item in query {
            guard let value = item.value else { throw NativeGmailFailure.config }
            switch (String(parts[0]), parts.count, item.name) {
            case ("messages", 1, "labelIds"):
                guard validId(value) else { throw NativeGmailFailure.config }
            case ("messages", 1, "maxResults"):
                guard let count = Int(value), (1...25).contains(count) else { throw NativeGmailFailure.config }
            case ("messages", 1, "pageToken"):
                guard !value.isEmpty, value.utf8.count <= 4096,
                      !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw NativeGmailFailure.config }
            case ("messages", 2, "format"):
                guard value == "full" else { throw NativeGmailFailure.config }
            default: throw NativeGmailFailure.config
            }
        }
        var url = URLComponents(string: api + relative.path)!
        url.queryItems = query.isEmpty ? nil : query

        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let result = url.url else { throw NativeGmailFailure.config }
        return result
    }

    func callbackCode(_ url: URL, state: String) throws -> String {
        guard let value = URLComponents(url: url, resolvingAgainstBaseURL: false),
              value.scheme == callbackScheme, value.host == nil, value.path == "/oauthredirect",
              value.fragment == nil, value.user == nil, value.password == nil, value.port == nil else {
            throw NativeGmailFailure.cancelled
        }
        let query = value.queryItems ?? []
        let states = query.filter { $0.name == "state" }
        let codes = query.filter { $0.name == "code" }
        let errors = query.filter { $0.name == "error" }
        guard states.count == 1, states[0].value == state else { throw NativeGmailFailure.cancelled }
        if codes.isEmpty && errors.count == 1 { throw NativeGmailFailure.cancelled }
        guard errors.isEmpty, codes.count == 1, let code = codes[0].value,
              !code.isEmpty, code.utf8.count <= 4096 else { throw NativeGmailFailure.cancelled }
        return code
    }

    private static func validId(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256
            && value.utf8.allSatisfy { $0.isASCIIAlphaNumeric || $0 == 45 || $0 == 95 }
    }
}

private extension UInt8 {
    var isASCIIAlphaNumeric: Bool { (48...57).contains(self) || (65...90).contains(self) || (97...122).contains(self) }
}
private extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}

struct NativeGmailCredentials: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var account: String
    var accountId: String
}
protocol NativeGmailCredentialVault {
    func read() throws -> NativeGmailCredentials?
    func write(_ credentials: NativeGmailCredentials?) throws
}
struct NativeGmailKeychainVault: NativeGmailCredentialVault {
    let service: String
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "gmail-oauth", kSecAttrSynchronizable as String: false]
    }
    func read() throws -> NativeGmailCredentials? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let credentials = try? JSONDecoder().decode(NativeGmailCredentials.self, from: data),
              !credentials.accessToken.isEmpty, !credentials.refreshToken.isEmpty,
              credentials.accessToken.utf8.count <= 16_384, credentials.refreshToken.utf8.count <= 16_384,
              let account = try? NativeGmailConfiguration.account(credentials.account),
              account.0 == credentials.account, account.1 == credentials.accountId else { throw NativeGmailFailure.storage }
        return credentials
    }
    func write(_ credentials: NativeGmailCredentials?) throws {
        if let credentials {
            let data = try JSONEncoder().encode(credentials)
            let attributes: [String: Any] = [kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw NativeGmailFailure.storage }
        } else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeGmailFailure.storage }
        }
        guard try read() == credentials else { throw NativeGmailFailure.storage }
    }
}

protocol NativeGmailHTTPTransport {
    func send(_ request: URLRequest) async throws -> Data
    func cancel()
}
protocol NativeGmailBrowser {
    @MainActor func authorize(_ url: URL, callbackScheme: String, generation: UInt64) async throws -> URL
    @MainActor func cancel(generation: UInt64)
}

actor NativeGmailClient {
    private let configuration: NativeGmailConfiguration?
    private let vault: NativeGmailCredentialVault
    private let http: NativeGmailHTTPTransport
    private let browser: NativeGmailBrowser
    private var credentials: NativeGmailCredentials?
    private var loaded = false
    private var generation: UInt64 = 0
    private var refreshing = false
    private var revoking = false

    init(configuration: NativeGmailConfiguration?, vault: NativeGmailCredentialVault, http: NativeGmailHTTPTransport, browser: NativeGmailBrowser) {
        self.configuration = configuration; self.vault = vault; self.http = http; self.browser = browser
    }
    func status() throws -> [String: Any] {
        try load()
        return ["available": configuration != nil, "connected": credentials != nil,
                "account": credentials?.account as Any? ?? NSNull(), "accountId": credentials?.accountId as Any? ?? NSNull()]
    }
    private func load() throws {
        if !loaded && configuration != nil { credentials = try vault.read(); loaded = true }
    }
    private func invalidate() -> UInt64 {
        generation &+= 1
        refreshing = false

        if !revoking { http.cancel() }
        return generation
    }
    private func check(_ value: UInt64) throws {
        guard generation == value else { throw NativeGmailFailure.cancelled }
    }
    func cancel() async {
        let current = invalidate()
        await browser.cancel(generation: current)
    }
    func connect() async throws -> [String: Any] {
        guard let configuration else { throw NativeGmailFailure.config }
        guard !revoking else { throw NativeGmailFailure.network }
        let current = invalidate()
        credentials = nil; loaded = true
        try vault.write(nil)
        let verifier = try NativeGmailConfiguration.randomSecret()
        let state = try NativeGmailConfiguration.randomSecret()
        var authorization = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        authorization.queryItems = [
            .init(name: "client_id", value: configuration.clientId), .init(name: "redirect_uri", value: configuration.redirect),
            .init(name: "response_type", value: "code"), .init(name: "scope", value: NativeGmailConfiguration.scope),
            .init(name: "state", value: state), .init(name: "code_challenge", value: Data(SHA256.hash(data: Data(verifier.utf8))).base64URL),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "access_type", value: "offline"),
            .init(name: "prompt", value: "select_account consent")]
        do {
            let callback = try await browser.authorize(authorization.url!, callbackScheme: configuration.callbackScheme, generation: current)
            try check(current)
            let code = try configuration.callbackCode(callback, state: state)
            let token = try await tokenRequest([
                "grant_type": "authorization_code", "code": code, "redirect_uri": configuration.redirect,
                "code_verifier": verifier, "client_id": configuration.clientId], current: current, initial: true)
            let identity = try await profile(token.accessToken, current: current)
            try check(current)
            let value = NativeGmailCredentials(accessToken: token.accessToken, refreshToken: token.refreshToken!,
                expiresAt: Date().addingTimeInterval(min(token.expiresIn, 86_400)), account: identity.0, accountId: identity.1)
            try vault.write(value)
            credentials = value
            return try status()
        } catch {
            try check(current)
            throw error as? NativeGmailFailure ?? .other
        }
    }
    func disconnect() async throws -> [String: Any] {
        guard !revoking else { return ["revoked": false] }
        try load()
        let current = invalidate()
        let token = credentials?.refreshToken
        credentials = nil; loaded = true; revoking = true
        defer { revoking = false }
        do { try vault.write(nil) } catch {
            await browser.cancel(generation: current)
            throw NativeGmailFailure.storage
        }
        await browser.cancel(generation: current)
        guard let token else { return ["revoked": true] }
        do {
            _ = try await http.send(Self.formRequest(NativeGmailConfiguration.revoke, ["token": token]))
            return ["revoked": true]
        } catch { return ["revoked": false] }
    }
    func get(_ path: String) async throws -> [String: Any] {
        guard configuration != nil else { throw NativeGmailFailure.config }
        try load()
        guard credentials != nil else { throw NativeGmailFailure.auth }
        let url = try NativeGmailConfiguration.apiURL(path)
        let current = generation
        do {
            let token = try await access(current)
            return try await jsonRequest(url, token: token, current: current)
        } catch {
            try check(current)
            if (error as? NativeGmailFailure) == .auth {
                _ = invalidate(); credentials = nil
                try? vault.write(nil)
            }
            throw error as? NativeGmailFailure ?? .other
        }
    }
    private func access(_ current: UInt64) async throws -> String {
        try check(current)
        guard let value = credentials, let configuration else { throw NativeGmailFailure.auth }
        if value.expiresAt.timeIntervalSinceNow > 60 { return value.accessToken }
        guard !refreshing else { throw NativeGmailFailure.network }
        refreshing = true
        defer { if generation == current { refreshing = false } }
        let token = try await tokenRequest(["grant_type": "refresh_token", "refresh_token": value.refreshToken,
            "client_id": configuration.clientId], current: current, initial: false)
        let identity = try await profile(token.accessToken, current: current)
        try check(current)
        guard identity.0 == value.account, identity.1 == value.accountId else { throw NativeGmailFailure.auth }
        var updated = value
        updated.accessToken = token.accessToken
        updated.refreshToken = token.refreshToken ?? value.refreshToken
        updated.expiresAt = Date().addingTimeInterval(min(token.expiresIn, 86_400))
        try vault.write(updated)
        credentials = updated
        return updated.accessToken
    }
    private func profile(_ token: String, current: UInt64) async throws -> (String, String) {
        let profile = try await jsonRequest(URL(string: NativeGmailConfiguration.api + "profile")!, token: token, current: current)
        guard let email = profile["emailAddress"] as? String else { throw NativeGmailFailure.other }
        return try NativeGmailConfiguration.account(email)
    }
    private func jsonRequest(_ url: URL, token: String, current: UInt64) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data = try await http.send(request)
        try check(current)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeGmailFailure.other }
        return object
    }
    private struct Token: Decodable {
        let accessToken: String
        let refreshToken: String?
        let expiresIn: Double
        let scope: String?
        let tokenType: String
        enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", scope, tokenType = "token_type" }
    }
    private func tokenRequest(_ form: [String: String], current: UInt64, initial: Bool) async throws -> Token {
        let data = try await http.send(Self.formRequest(NativeGmailConfiguration.token, form))
        try check(current)
        guard let token = try? JSONDecoder().decode(Token.self, from: data), !token.accessToken.isEmpty,
              token.accessToken.utf8.count <= 16_384, token.expiresIn.isFinite, token.expiresIn > 0,
              token.tokenType.lowercased() == "bearer", token.refreshToken?.isEmpty != true,
              (token.refreshToken?.utf8.count ?? 0) <= 16_384,
              token.scope.map({ $0.split(whereSeparator: \.isWhitespace).contains(Substring(NativeGmailConfiguration.scope)) }) != false,
              (!initial || (token.scope != nil && token.refreshToken != nil)) else { throw NativeGmailFailure.auth }
        return token
    }
    private static func formRequest(_ url: URL, _ form: [String: String]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.httpBody = form.sorted { $0.key < $1.key }.map {
            "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }.joined(separator: "&").data(using: .utf8)
        return request
    }
}

final class NativeGmailBoundedHTTPTransport: NSObject, NativeGmailHTTPTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let responseLimit = 2 * 1024 * 1024
    private struct Pending {
        let continuation: CheckedContinuation<Data, Error>
        let task: URLSessionDataTask
        var data = Data()
        var failure: NativeGmailFailure?
    }
    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private var session: URLSession!

    init(configuration: URLSessionConfiguration = .ephemeral) {
        super.init()
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func send(_ request: URLRequest) async throws -> Data {
        guard let url = request.url, url.scheme == "https", url.user == nil, url.password == nil,
              url.fragment == nil, url.port == nil,
              ((request.httpMethod == "GET" && url.absoluteString.hasPrefix(NativeGmailConfiguration.api))
                || (request.httpMethod == "POST" && [NativeGmailConfiguration.token, NativeGmailConfiguration.revoke].contains(url))) else {
            throw NativeGmailFailure.config
        }
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request)
            lock.lock()
            pending[task.taskIdentifier] = Pending(continuation: continuation, task: task)
            lock.unlock()
            task.resume()
        }
    }

    func cancel() {
        lock.lock()
        let tasks = pending.values.map(\.task)
        lock.unlock()
        tasks.forEach { $0.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock()
        pending[task.taskIdentifier]?.failure = .other
        lock.unlock()
        completionHandler(nil)
        task.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let failure: NativeGmailFailure?
        if let response = response as? HTTPURLResponse {
            if response.statusCode == 401 || response.statusCode == 403
                || (response.statusCode == 400 && response.url == NativeGmailConfiguration.token) {
                failure = .auth
            } else if response.statusCode == 429 || response.statusCode >= 500 {
                failure = .network
            } else if !(200...299).contains(response.statusCode) || response.expectedContentLength > Int64(Self.responseLimit) {
                failure = .other
            } else { failure = nil }
        } else { failure = .other }
        if let failure {
            lock.lock()
            pending[dataTask.taskIdentifier]?.failure = failure
            lock.unlock()
            completionHandler(.cancel)
        } else { completionHandler(.allow) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard var value = pending[dataTask.taskIdentifier], value.failure == nil else { lock.unlock(); return }
        let oversized = data.count > Self.responseLimit - value.data.count
        if oversized { value.failure = .other } else { value.data.append(data) }
        pending[dataTask.taskIdentifier] = value
        lock.unlock()
        if oversized { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let value = pending.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let value else { return }
        if let failure = value.failure { value.continuation.resume(throwing: failure) }
        else if error != nil { value.continuation.resume(throwing: NativeGmailFailure.network) }
        else { value.continuation.resume(returning: value.data) }
    }
}

#if canImport(UIKit)
@MainActor
final class NativeGmailWebBrowser: NSObject, NativeGmailBrowser, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var completion: CheckedContinuation<URL, Error>?
    private var attempt = UUID()
    private var timeout: Task<Void, Never>?
    private var anchor: ASPresentationAnchor?
    private var latestGeneration: UInt64 = 0

    func authorize(_ url: URL, callbackScheme: String, generation: UInt64) async throws -> URL {
        guard generation >= latestGeneration else { throw NativeGmailFailure.cancelled }
        latestGeneration = generation
        cancelSession()
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { throw NativeGmailFailure.other }
        anchor = window
        let current = UUID()
        attempt = current
        return try await withCheckedThrowingContinuation { continuation in
            completion = continuation
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, _ in
                Task { @MainActor in
                    guard let self, self.attempt == current else { return }
                    self.finish(callback.map(Result.success) ?? .failure(NativeGmailFailure.cancelled))
                }
            }
            self.session = session
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 180_000_000_000)
                guard !Task.isCancelled, let self, self.attempt == current else { return }
                self.cancelSession()
            }
            if !session.start() { finish(.failure(NativeGmailFailure.other)) }
        }
    }

    func cancel(generation: UInt64) {
        guard generation >= latestGeneration else { return }
        latestGeneration = generation
        cancelSession()
    }

    private func cancelSession() {
        let previous = session
        attempt = UUID()
        finish(.failure(NativeGmailFailure.cancelled))
        previous?.cancel()
    }

    private func finish(_ result: Result<URL, Error>) {
        let continuation = completion
        completion = nil
        timeout?.cancel(); timeout = nil
        session = nil; anchor = nil
        continuation?.resume(with: result)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }
}

extension NativeGmailClient {
    @MainActor static func device(_ bundle: Bundle = .main) -> NativeGmailClient? {
        guard let configuration = NativeGmailConfiguration(
            clientId: bundle.object(forInfoDictionaryKey: "MindwtrGmailClientId") as? String,
            enabled: bundle.object(forInfoDictionaryKey: "MindwtrGmailEnabled") as? Bool == true) else { return nil }
        return NativeGmailClient(configuration: configuration,
            vault: NativeGmailKeychainVault(service: "\(bundle.bundleIdentifier ?? "Mindwtr").gmail-authorization"),
            http: NativeGmailBoundedHTTPTransport(), browser: NativeGmailWebBrowser())
    }
}
#endif
