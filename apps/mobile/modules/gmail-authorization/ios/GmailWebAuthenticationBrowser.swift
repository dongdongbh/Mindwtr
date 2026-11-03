import AuthenticationServices
import Foundation
import UIKit

@MainActor
final class GmailWebAuthenticationBrowser: NSObject, GmailAuthorizationBrowser, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var completion: CheckedContinuation<URL, Error>?
    private var attempt = UUID()
    private var timeout: Task<Void, Never>?
    private var anchor: ASPresentationAnchor?
    private var latestGeneration: UInt64 = 0

    func authorize(_ url: URL, callbackScheme: String, generation: UInt64) async throws -> URL {
        guard generation >= latestGeneration else { throw GmailAuthorizationFailure.cancelled }
        latestGeneration = generation
        cancelSession()
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { throw GmailAuthorizationFailure.other }
        anchor = window
        let current = UUID()
        attempt = current
        return try await withCheckedThrowingContinuation { continuation in
            completion = continuation
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, _ in
                Task { @MainActor in
                    guard let self, self.attempt == current else { return }
                    self.finish(callback.map(Result.success) ?? .failure(GmailAuthorizationFailure.cancelled))
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
            if !session.start() { finish(.failure(GmailAuthorizationFailure.other)) }
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
        finish(.failure(GmailAuthorizationFailure.cancelled))
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
