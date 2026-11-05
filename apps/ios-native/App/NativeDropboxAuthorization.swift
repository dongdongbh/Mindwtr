import AuthenticationServices
import CryptoKit
import Foundation
import MindwtrNativeCore
import Security
import UIKit

private final class NativeDropboxAuthorizationSnapshot: @unchecked Sendable {
    private let lock = NSLock()
    private var live = false
    private var request: String?
    private var cancelled = false
    var isCurrent: Bool { lock.lock(); defer { lock.unlock() }; return live && !cancelled }
    func update(_ current: Bool) { lock.lock(); live = current; lock.unlock() }
    func begin(_ id: String) { lock.lock(); request = id; cancelled = false; lock.unlock() }
    func cancel(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        if request == id { cancelled = true }
    }
    func cancelCurrent() {
        lock.lock(); defer { lock.unlock() }
        if request != nil { cancelled = true }
    }
    func settle(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        if request == id { request = nil; cancelled = false }
    }
}

@MainActor
protocol NativeDropboxBrowser: AnyObject {
    func start() -> Bool
    func cancel()
}

@MainActor
private final class NativeDropboxSystemBrowser: NSObject, NativeDropboxBrowser, ASWebAuthenticationPresentationContextProviding {
    private let session: ASWebAuthenticationSession
    private let anchor: ASPresentationAnchor
    init(url: URL, scheme: String, anchor: ASPresentationAnchor,
         completion: @escaping @Sendable (URL?, Error?) -> Void) {
        self.anchor = anchor
        session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: completion)
        super.init()
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = true
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
    func start() -> Bool { session.start() }
    func cancel() { session.cancel() }
}

@MainActor
final class NativeDropboxAuthorization {
    enum Failure: LocalizedError {
        case unavailable, cancelled, invalidCallback, alreadyUsed
        var errorDescription: String? {
            switch self {
            case .unavailable: return "Dropbox sign-in is unavailable."
            case .cancelled: return "Dropbox sign-in was cancelled."
            case .invalidCallback: return "Dropbox sign-in could not be verified."
            case .alreadyUsed: return "Start Dropbox sign-in again."
            }
        }
    }
    typealias BrowserFactory = @MainActor (URL, String, @escaping @Sendable (URL?, Error?) -> Void) throws -> any NativeDropboxBrowser
    let configuration: NativeDropboxConfiguration
    private let snapshot = NativeDropboxAuthorizationSnapshot()
    private let admission: @MainActor (String) -> Bool
    private let browserFactory: BrowserFactory
    private var applicationActive = false
    private var retired = false
    private var usedRequests = Set<String>()
    private final class Pending {
        let id: String
        let state: String
        let verifier: String
        var browser: (any NativeDropboxBrowser)?
        var code: String?
        var waiters: [CheckedContinuation<NativeDropboxAuthorizationGrant, Error>] = []
        init(id: String, state: String, verifier: String) { self.id = id; self.state = state; self.verifier = verifier }
    }
    private var pending: Pending?

    static func configuration(bundle: Bundle = .main) -> NativeDropboxConfiguration? {
        guard let id = bundle.object(forInfoDictionaryKey: "MindwtrDropboxAppKey") as? String,
              let redirect = bundle.object(forInfoDictionaryKey: "MindwtrDropboxRedirectURI") as? String,
              !id.isEmpty, id.utf8.count <= 512,
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }),
              redirect == "mindwtr-native-dev://redirect" else { return nil }
        return try? NativeDropboxConfiguration(clientID: id, redirectURI: redirect)
    }
    static func isCallbackRoute(_ url: URL, configuration: NativeDropboxConfiguration?) -> Bool {
        guard let configuration else { return false }
        let base = url.absoluteString.prefix { $0 != "?" && $0 != "#" }
        return base.utf8.elementsEqual(configuration.redirectURI.utf8)
    }
    static func shouldConsumeCallback(_ url: URL, configuration: NativeDropboxConfiguration?) -> Bool {
        guard let configuration, let configured = URLComponents(string: configuration.redirectURI),
              let callback = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return callback.scheme?.lowercased() == configured.scheme?.lowercased()
            && callback.host?.lowercased() == configured.host?.lowercased()
    }
    init(configuration: NativeDropboxConfiguration, admission: @escaping @MainActor (String) -> Bool,
         browserFactory: BrowserFactory? = nil) {
        self.configuration = configuration
        self.admission = admission
        self.browserFactory = browserFactory ?? { url, scheme, completion in
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
                  let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw Failure.unavailable }
            return NativeDropboxSystemBrowser(url: url, scheme: scheme, anchor: window, completion: completion)
        }
    }
    var binding: NativeDropboxAuthorizationBinding {
        let snapshot = snapshot
        return NativeDropboxAuthorizationBinding(configuration: configuration,
            isCurrent: { snapshot.isCurrent },
            authorize: { [weak self] requestID in
                guard let self else { throw Failure.unavailable }
                return try await self.authorize(requestID)
            }, cancel: { [weak self] requestID in
                snapshot.cancel(requestID)
                Task { @MainActor in self?.cancel(requestID) }
            })
    }
    var ownsBrowserPresentation: Bool {
        guard let pending else { return false }
        return !retired && snapshot.isCurrent && pending.browser != nil && admission(pending.id)
    }
    func update(current: Bool, active: Bool) {
        applicationActive = active
        snapshot.update(!retired && current)
        if !current { cancelPending() }
        else if active { deliverIfReadmitted() }
    }
    func cancelAuthorization() {
        snapshot.cancelCurrent()
        cancelPending()
    }
    func retire() {
        retired = true; snapshot.update(false); cancelAuthorization()
    }
    func settle(_ requestID: String) { snapshot.settle(requestID) }

    private func authorize(_ requestID: String) async throws -> NativeDropboxAuthorizationGrant {
        guard UUID(uuidString: requestID)?.uuidString.lowercased() == requestID,
              !retired, snapshot.isCurrent, applicationActive, admission(requestID), !Task.isCancelled else { throw Failure.cancelled }
        if let pending {
            guard pending.id == requestID, pending.code == nil else { throw Failure.alreadyUsed }
        } else {
            guard !usedRequests.contains(requestID) else { throw Failure.alreadyUsed }
            let state = try Self.randomComponent(), verifier = try Self.randomComponent()
            pending = Pending(id: requestID, state: state, verifier: verifier)
            snapshot.begin(requestID)
        }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                guard let pending, pending.id == requestID, snapshot.isCurrent, admission(requestID), !Task.isCancelled else {
                    continuation.resume(throwing: Failure.cancelled); return
                }
                pending.waiters.append(continuation)
                guard pending.browser == nil else { return }
                do {
                    let url = try Self.authorizationURL(configuration: configuration, state: pending.state, verifier: pending.verifier)
                    let browser = try browserFactory(url, "mindwtr-native-dev") { [weak self, weak pending] url, error in
                        Task { @MainActor in
                            guard let self, let pending, self.pending === pending else { return }
                            self.completed(url: url, failed: error != nil, pending: pending)
                        }
                    }
                    pending.browser = browser
                    guard browser.start() else { throw Failure.unavailable }
                } catch { finish(pending, result: .failure(Failure.unavailable)) }
            }
        }, onCancel: { [weak self, snapshot] in
            snapshot.cancel(requestID)
            Task { @MainActor in self?.cancel(requestID) }
        })
    }
    private func cancel(_ requestID: String) {
        guard let pending, pending.id == requestID else { return }
        finish(pending, result: .failure(Failure.cancelled))
    }
    private func cancelPending() {
        guard let pending else { return }
        finish(pending, result: .failure(Failure.cancelled))
    }
    private func completed(url: URL?, failed: Bool, pending: Pending) {
        guard self.pending === pending, snapshot.isCurrent, !retired, admission(pending.id) else {
            finish(pending, result: .failure(Failure.cancelled)); return
        }
        do {
            guard pending.code == nil else { throw Failure.invalidCallback }
            guard !failed, let url else { throw Failure.cancelled }
            pending.code = try Self.callbackCode(url, configuration: configuration, state: pending.state)
            deliverIfReadmitted()
        } catch { finish(pending, result: .failure(error is Failure ? error : Failure.invalidCallback)) }
    }
    private func deliverIfReadmitted() {
        guard let pending, let code = pending.code, applicationActive else { return }
        guard !retired, snapshot.isCurrent, admission(pending.id) else {
            finish(pending, result: .failure(Failure.cancelled)); return
        }
        let grant = NativeDropboxAuthorizationGrant(requestID: pending.id, clientID: configuration.clientID,
            redirectURI: configuration.redirectURI, code: code, codeVerifier: pending.verifier)
        finish(pending, result: .success(grant))
    }
    private func finish(_ pending: Pending, result: Result<NativeDropboxAuthorizationGrant, Error>) {
        guard self.pending === pending else { return }
        self.pending = nil; usedRequests.insert(pending.id)
        let waiters = pending.waiters; pending.waiters = []; pending.code = nil
        let browser = pending.browser; pending.browser = nil
        browser?.cancel()
        for waiter in waiters { waiter.resume(with: result) }
    }
    private static func randomComponent() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.unavailable }
        return base64URL(Data(bytes))
    }
    private static func base64URL(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func authorizationURL(configuration: NativeDropboxConfiguration, state: String, verifier: String) throws -> URL {
        var url = URLComponents(string: "https://www.dropbox.com/oauth2/authorize")!
        url.queryItems = [URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "token_access_type", value: "offline"),
            URLQueryItem(name: "scope", value: "files.content.read files.content.write files.metadata.read"),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
            URLQueryItem(name: "state", value: state)]
        guard let result = url.url else { throw Failure.unavailable }
        return result
    }
    static func callbackCode(_ url: URL, configuration: NativeDropboxConfiguration, state: String) throws -> String {
        guard url.absoluteString.utf8.count <= 16_384, isCallbackRoute(url, configuration: configuration),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.fragment == nil,
              parts.user == nil, parts.password == nil, parts.port == nil,
              let query = parts.percentEncodedQuery, !query.isEmpty,
              let items = parts.queryItems, !items.isEmpty else { throw Failure.invalidCallback }
        let bytes = Array(query.utf8)
        for index in bytes.indices where bytes[index] == 37 {
            guard index + 2 < bytes.count, bytes[index + 1].isHexDigit, bytes[index + 2].isHexDigit else { throw Failure.invalidCallback }
        }
        var values: [String: String] = [:]
        for item in items {
            guard ["state", "code", "error", "error_description", "error_uri"].contains(item.name),
                  values[item.name] == nil, let value = item.value else { throw Failure.invalidCallback }
            values[item.name] = value
        }
        guard values["state"]?.utf8.elementsEqual(state.utf8) == true, values["error"] == nil,
              values["error_description"] == nil, values["error_uri"] == nil,
              let code = values["code"], !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              code.utf8.count <= 8_192, code.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw Failure.invalidCallback
        }
        return code
    }
}

private extension UInt8 {
    var isHexDigit: Bool { (48...57).contains(self) || (65...70).contains(self) || (97...102).contains(self) }
}

#if DEBUG && targetEnvironment(simulator)
extension NativeDropboxAuthorization {
    static func runControlledFixture() async -> Bool {
        final class Browser: NativeDropboxBrowser {
            var cancelled = false
            func start() -> Bool { true }
            func cancel() { cancelled = true }
        }
        final class Fixture {
            var url: URL?
            var callback: (@Sendable (URL?, Error?) -> Void)?
            var browser: Browser?
            var admission = true
            var delivered = false
        }
        do {
            let config = try NativeDropboxConfiguration(clientID: "SyntheticDropboxClient", redirectURI: "mindwtr-native-dev://redirect")
            let state = String(repeating: "s", count: 43)
            let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            let url = try authorizationURL(configuration: config, state: state, verifier: verifier)
            let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            let query = Dictionary(uniqueKeysWithValues: parts.queryItems!.map { ($0.name, $0.value ?? "") })
            guard parts.scheme == "https", parts.host == "www.dropbox.com", parts.path == "/oauth2/authorize",
                  query["code_challenge"] == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                  query["scope"] == "files.content.read files.content.write files.metadata.read",
                  query["response_type"] == "code", query["token_access_type"] == "offline" else { return false }
            let valid = config.redirectURI + "?state=" + state + "&code=synthetic"
            guard try callbackCode(URL(string: valid)!, configuration: config, state: state) == "synthetic" else { return false }
            for invalid in [
                "mindwtr-native-dev://other?state=" + state + "&code=synthetic",
                config.redirectURI + "/other?state=" + state + "&code=synthetic",
                config.redirectURI + "?code=synthetic", config.redirectURI + "?state=wrong&code=synthetic",
                valid + "&state=" + state, valid + "&code=second", valid + "&error=denied", valid + "#code=other",
                config.redirectURI + "?state=" + state + "&code=" + String(repeating: "x", count: 8_193),
            ] {
                if (try? callbackCode(URL(string: invalid)!, configuration: config, state: state)) != nil { return false }
            }
            let fixture = Fixture()
            let owner = NativeDropboxAuthorization(configuration: config, admission: { _ in fixture.admission }, browserFactory: { url, _, callback in
                fixture.url = url; fixture.callback = callback
                let browser = Browser(); fixture.browser = browser; return browser
            })
            owner.update(current: true, active: true)
            let firstID = "00000000-0000-4000-8000-000000000001"
            let first = Task { () -> Bool in
                do { _ = try await owner.authorize(firstID); fixture.delivered = true; return true }
                catch { return false }
            }
            for _ in 0..<20 where fixture.callback == nil { await Task.yield() }
            guard let firstURL = fixture.url, let callback = fixture.callback,
                  let generated = URLComponents(url: firstURL, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "state" })?.value,
                  generated.utf8.count == 43 else { first.cancel(); return false }
            owner.update(current: true, active: false)
            callback(URL(string: config.redirectURI + "?state=" + generated + "&code=synthetic")!, nil)
            for _ in 0..<4 { await Task.yield() }
            guard !fixture.delivered, owner.ownsBrowserPresentation else { first.cancel(); return false }
            owner.update(current: true, active: true)
            guard await first.value else { return false }
            owner.settle(firstID)
            do { _ = try await owner.authorize(firstID); return false } catch { }

            fixture.url = nil; fixture.callback = nil
            let cancelledID = "00000000-0000-4000-8000-000000000002"
            let cancelled = Task { () -> Bool in
                do { _ = try await owner.authorize(cancelledID); return true } catch { return false }
            }
            for _ in 0..<20 where fixture.callback == nil { await Task.yield() }
            guard let late = fixture.callback, let sent = fixture.url,
                  let lateState = URLComponents(url: sent, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "state" })?.value else { cancelled.cancel(); return false }
            owner.snapshot.cancel(cancelledID)
            Task { @MainActor in owner.cancel(cancelledID) }
            guard !owner.snapshot.isCurrent else { cancelled.cancel(); return false }
            late(URL(string: config.redirectURI + "?state=" + lateState + "&code=synthetic")!, nil)
            guard await cancelled.value == false, fixture.browser?.cancelled == true else { return false }
            owner.settle(cancelledID)
            owner.retire(); owner.update(current: true, active: true)
            guard !owner.snapshot.isCurrent, shouldConsumeCallback(URL(string: valid)!, configuration: config),
                  shouldConsumeCallback(URL(string: config.redirectURI + "/wrong?code=synthetic")!, configuration: config) else { return false }
            return true
        } catch { return false }
    }
}
#endif
