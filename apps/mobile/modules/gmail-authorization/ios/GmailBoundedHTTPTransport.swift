import Foundation

final class GmailBoundedHTTPTransport: NSObject, GmailHTTPTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let responseLimit = 2 * 1024 * 1024
    private struct Pending {
        let continuation: CheckedContinuation<Data, Error>
        let task: URLSessionDataTask
        var data = Data()
        var failure: GmailAuthorizationFailure?
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
              ((request.httpMethod == "GET" && url.absoluteString.hasPrefix(GmailAuthorizationConfiguration.api))
                || (request.httpMethod == "POST" && [GmailAuthorizationConfiguration.token, GmailAuthorizationConfiguration.revoke].contains(url))) else {
            throw GmailAuthorizationFailure.config
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
        let failure: GmailAuthorizationFailure?
        if let response = response as? HTTPURLResponse {
            if response.statusCode == 401 || response.statusCode == 403
                || (response.statusCode == 400 && response.url == GmailAuthorizationConfiguration.token) {
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
        else if error != nil { value.continuation.resume(throwing: GmailAuthorizationFailure.network) }
        else { value.continuation.resume(returning: value.data) }
    }
}
