import ExpoModulesCore
import Foundation

@MainActor
private enum GmailNativeClient {
    static let shared = GmailAuthorizationClient(
        configuration: GmailAuthorizationConfiguration(
            clientId: Bundle.main.object(forInfoDictionaryKey: "MindwtrGmailClientId") as? String,
            enabled: Bundle.main.object(forInfoDictionaryKey: "MindwtrGmailEnabled") as? Bool == true),
        vault: GmailKeychainVault(service: "\(Bundle.main.bundleIdentifier ?? "Mindwtr").gmail-authorization"),
        http: GmailBoundedHTTPTransport(), browser: GmailWebAuthenticationBrowser())
}

public final class MindwtrGmailAuthorizationModule: Module {
    public func definition() -> ModuleDefinition {
        Name("MindwtrGmailAuthorization")
        AsyncFunction("status") { () async throws -> [String: Any] in
            try await self.sanitized { try await GmailNativeClient.shared.status() }
        }
        AsyncFunction("connect") { () async throws -> [String: Any] in
            try await self.sanitized { try await GmailNativeClient.shared.connect() }
        }
        AsyncFunction("cancel") { () async -> Void in
            await GmailNativeClient.shared.cancel()
        }
        AsyncFunction("disconnect") { () async throws -> [String: Any] in
            try await self.sanitized { try await GmailNativeClient.shared.disconnect() }
        }
        AsyncFunction("get") { (path: String) async throws -> [String: Any] in
            try await self.sanitized { try await GmailNativeClient.shared.get(path) }
        }
    }

    private func sanitized<T>(_ operation: () async throws -> T) async throws -> T {
        do { return try await operation() }
        catch {
            let failure = error as? GmailAuthorizationFailure ?? .other
            throw Exception(name: "GmailAuthorizationException", description: failure.message, code: failure.rawValue)
        }
    }
}
