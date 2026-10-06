import Foundation

/// Plain records only. URLSession delegates never enter JSC or the database.
/// Two retained slots bound uploads, buffered downloads and undelivered replies.
final class NativeHTTPJobs: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let maximumBytes = 8 * 1024 * 1024
    private static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "PROPFIND", "MKCOL", "MOVE", "COPY"]
    private static let framing: Set<String> = ["host", "content-length", "transfer-encoding", "connection", "proxy-connection", "upgrade", "te", "trailer"]
    private let condition = NSCondition()
    private let registry: NativeAttachmentLocalRequests
    private let delegateQueue = OperationQueue()
    private var session: URLSession!
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var jobs: [String: Job] = [:]
    private var taskIDs: [Int: String] = [:]
    private var ready: [String] = []
    private var taken: String?
    private var accepting = true
    private var invalidated = false
    private var wake: (() -> Void)?
    private var byteLimit = NativeHTTPJobs.maximumBytes
    #if DEBUG
    private var loopbackOrigin: URL?
    var beforeCompletion: (() -> Void)?
    #endif

    private final class Job {
        let id: String, registryID: UUID, token: NativeAttachmentCancellation
        let method: String, redirect: String, origin: URL
        let authorization: String?
        let task: URLSessionDataTask
        var response: HTTPURLResponse?
        var data = Data()
        var expectedLength: Int64?
        var unsupportedEncoding = false
        var hops = 0
        var error: String?
        var responseTooLarge = false
        var cancelled = false
        var finished = false
        init(id: String, registryID: UUID, token: NativeAttachmentCancellation, method: String,
             redirect: String, origin: URL, authorization: String?, task: URLSessionDataTask) {
            self.id = id; self.registryID = registryID; self.token = token
            self.method = method; self.redirect = redirect; self.origin = origin; self.task = task
            self.authorization = authorization
        }
        var bodyless: Bool { method == "HEAD" || response?.statusCode == 204 || response?.statusCode == 304 }
    }

    convenience init(registry: NativeAttachmentLocalRequests) {
        self.init(registry: registry, configuration: .ephemeral, limit: Self.maximumBytes, timeout: 300)
    }
    #if DEBUG
    convenience init(registry: NativeAttachmentLocalRequests, faults: HostIOFaults?) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = faults?.httpConfiguration?.protocolClasses ?? configuration.protocolClasses
        let limit = faults?.httpByteLimit ?? Self.maximumBytes
        self.init(registry: registry, configuration: configuration,
                  limit: (1...Self.maximumBytes).contains(limit) ? limit : Self.maximumBytes, timeout: faults?.httpTimeout ?? 300)
        loopbackOrigin = faults?.httpLoopbackOrigin
    }
    #endif
    private init(registry: NativeAttachmentLocalRequests, configuration: URLSessionConfiguration, limit: Int, timeout: TimeInterval) {
        self.registry = registry
        super.init()
        byteLimit = limit
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForResource = timeout
        configuration.timeoutIntervalForRequest = timeout
        configuration.waitsForConnectivity = false
        delegateQueue.name = "tech.dongdongbh.mindwtr.native-http"
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    func setWake(_ callback: (() -> Void)?) { condition.lock(); wake = callback; condition.unlock() }

    private func failure(_ message: String = "HTTP request is invalid") -> HostFailure { HostFailure(message) }
    private func allowedURL(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else { return false }
        if parts.scheme?.lowercased() == "https" { return true }
        #if DEBUG
        if let origin = loopbackOrigin,
           origin.scheme == "http", origin.host == "127.0.0.1", origin.port != nil,
           parts.scheme == "http", parts.host == "127.0.0.1", sameOrigin(url, origin) { return true }
        #endif
        return false
    }
    private func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased()
            && (a.port ?? (a.scheme?.lowercased() == "https" ? 443 : 80)) == (b.port ?? (b.scheme?.lowercased() == "https" ? 443 : 80))
    }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= 12 * 1024 * 1024,
              let input = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(input.keys).isSubset(of: Set(["url", "method", "redirect", "headers", "text", "base64"])),
              ["url", "method", "redirect", "headers"].allSatisfy({ input[$0] != nil }),
              !(input["text"] != nil && input["base64"] != nil),
              let rawURL = input["url"] as? String, !rawURL.isEmpty, rawURL.utf8.count <= 16 * 1024,
              !rawURL.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let url = URL(string: rawURL), allowedURL(url),
              let method = input["method"] as? String, Self.methods.contains(method),
              let redirect = input["redirect"] as? String, ["follow", "manual", "error"].contains(redirect),
              let pairs = input["headers"] as? [[Any]], pairs.count <= 1024 else { throw failure() }
        var request = URLRequest(url: url)
        request.httpMethod = method
        var headerBytes = 0, names = Set<String>()
        for pair in pairs {
            guard pair.count == 2, let name = pair[0] as? String, let value = pair[1] as? String,
                  !name.isEmpty, name.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || Array("!#$%&'*+-.^_`|~".utf8).contains($0) }),
                  !value.unicodeScalars.contains(where: { ($0.value < 32 && $0.value != 9) || $0.value == 127 }),
                  !Self.framing.contains(name.lowercased()), names.insert(name.lowercased()).inserted else { throw failure() }
            headerBytes += name.utf8.count + value.utf8.count
            guard headerBytes <= 64 * 1024 else { throw failure() }
            if name.lowercased() == "accept-encoding", value.trimmingCharacters(in: .whitespaces).lowercased() != "identity" { throw failure() }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if !names.contains("accept-encoding") { request.setValue("identity", forHTTPHeaderField: "Accept-Encoding") }
        if input["text"] != nil {
            guard let text = input["text"] as? String, text.utf8.count <= byteLimit else { throw failure() }
            request.httpBody = Data(text.utf8)
        } else if input["base64"] != nil {
            guard let encoded = input["base64"] as? String, encoded.utf8.count <= ((byteLimit + 2) / 3) * 4,
                  let bytes = Data(base64Encoded: encoded), bytes.count <= byteLimit,
                  bytes.base64EncodedString() == encoded else { throw failure() }
            request.httpBody = bytes
        }
        guard !["GET", "HEAD"].contains(method) || request.httpBody == nil else { throw failure() }
        if request.httpBody == nil, ["POST", "PUT", "PATCH"].contains(method) { request.httpBody = Data() }
        let token = NativeAttachmentCancellation(), registryID = UUID()
        registry.register(token, id: registryID)
        condition.lock()
        guard accepting, !token.isCancelled, jobs.count < 2, sequence < UInt64.max else {
            condition.unlock(); registry.remove(registryID)
            throw failure("HTTP bridge is unavailable or at capacity")
        }
        sequence += 1
        let id = "net:\(generation):\(sequence)", task = session.dataTask(with: request)
        jobs[id] = Job(id: id, registryID: registryID, token: token, method: method, redirect: redirect,
                       origin: url, authorization: request.value(forHTTPHeaderField: "Authorization"), task: task)
        taskIDs[task.taskIdentifier] = id
        condition.unlock()
        token.setCancellationHandler { [weak self] in self?.abort(id) }
        task.resume()
        return id
    }

    func abort(_ id: String) {
        condition.lock(); let job = jobs[id]; job?.cancelled = true; job?.responseTooLarge = false; condition.unlock()
        job?.task.cancel()
    }

    /// Metadata and body stay paired until body() consumes the one retained slot.
    func next() throws -> (json: String, body: Bool)? {
        condition.lock(); defer { condition.unlock() }
        guard taken == nil else { throw failure("HTTP response body is unavailable") }
        guard !ready.isEmpty, let job = jobs[ready.removeFirst()] else { return nil }
        var input: [String: Any]
        if let error = job.error {
            input = ["id": job.id, "error": error]
            if job.responseTooLarge {
                input["errorCode"] = "response-too-large"; input["limitBytes"] = byteLimit
            }
            jobs.removeValue(forKey: job.id)
        } else if let response = job.response, let url = response.url {
            input = ["id": job.id, "status": response.statusCode, "statusText": "", "url": url.absoluteString,
                     "redirected": job.hops > 0, "headers": headers(response), "body": true]
            taken = job.id
        } else { throw failure("HTTP response is unavailable") }
        return (String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self), taken != nil)
    }

    func body() throws -> (base64: String, completed: Bool) {
        condition.lock(); defer { condition.unlock() }
        guard let id = taken, let job = jobs.removeValue(forKey: id), job.finished, job.error == nil else {
            throw failure("HTTP response body is unavailable")
        }
        taken = nil
        return (job.data.base64EncodedString(), !job.cancelled && !job.token.isCancelled)
    }

    private func headers(_ response: HTTPURLResponse) -> [[String]] {
        response.allHeaderFields.map { [String(describing: $0.key), String(describing: $0.value)] }.sorted { $0[0] < $1[0] }
    }
    private func value(_ name: String, in response: HTTPURLResponse) -> String? {
        headers(response).first { $0[0].lowercased() == name }?[1]
    }
    private func job(_ task: URLSessionTask) -> Job? { taskIDs[task.taskIdentifier].flatMap { jobs[$0] } }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        condition.lock()
        var next: URLRequest?
        if let job = job(task), !job.cancelled {
            if job.redirect == "manual" { /* Return the original complete 3xx response. */ }
            else if job.redirect == "error" { job.error = "fetch failed: unexpected redirect" }
            else if job.hops < 5, let url = request.url, allowedURL(url), sameOrigin(url, job.origin) {
                // URLSession can strip explicit Authorization even on a 307
                // within the same origin. Restore only the immutable admitted
                // value, after every origin/URL/hop guard has passed.
                var followed = request
                if let authorization = job.authorization { followed.setValue(authorization, forHTTPHeaderField: "Authorization") }
                job.hops += 1; next = followed
            } else { job.error = "fetch failed: unexpected redirect" }
        }
        condition.unlock(); completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        condition.lock()
        var disposition: URLSession.ResponseDisposition = .cancel
        if let job = job(dataTask), !job.cancelled, job.error == nil, let response = response as? HTTPURLResponse,
           let url = response.url, allowedURL(url), sameOrigin(url, job.origin), (100...599).contains(response.statusCode) {
            job.response = response
            let pairs = headers(response)
            if pairs.reduce(0, { $0 + $1[0].utf8.count + $1[1].utf8.count }) > 64 * 1024 { job.error = "HTTP response headers exceed the limit" }
            if let raw = value("content-length", in: response) {
                let text = raw.trimmingCharacters(in: .whitespaces)
                if text.isEmpty || !text.utf8.allSatisfy({ (48...57).contains($0) }) || Int64(text) == nil { job.error = "Network request failed" }
                else { job.expectedLength = Int64(text) }
            }
            let encoding = value("content-encoding", in: response)?.trimmingCharacters(in: .whitespaces).lowercased()
            job.unsupportedEncoding = encoding != nil && encoding != "identity"
            if !job.bodyless, let length = job.expectedLength, length > Int64(byteLimit) {
                job.error = "Response exceeds the \(byteLimit) byte download limit"; job.responseTooLarge = true
            }
            if job.error == nil { disposition = .allow }
        }
        condition.unlock(); completionHandler(disposition)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        condition.lock()
        var cancel = false
        if let job = job(dataTask), !job.finished, !job.cancelled, job.error == nil, !job.bodyless {
            if job.unsupportedEncoding { job.error = "HTTP response encoding is unsupported"; cancel = true }
            else if data.count > byteLimit - job.data.count {
                job.error = "Response exceeds the \(byteLimit) byte download limit"; job.responseTooLarge = true; cancel = true
            }
            else { job.data.append(data) }
        }
        condition.unlock(); if cancel { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        #if DEBUG
        beforeCompletion?()
        #endif
        condition.lock()
        guard let job = job(task), !job.finished else { condition.unlock(); return }
        if job.cancelled { job.error = "Request cancelled"; job.responseTooLarge = false }
        else if job.error == nil {
            if let error { job.error = (error as NSError).code == NSURLErrorTimedOut ? "Network request failed: request timed out" : "Network request failed" }
            else if job.response == nil || (!job.bodyless && job.expectedLength != nil && job.expectedLength != Int64(job.data.count)) { job.error = "Network request failed" }
        }
        if job.error != nil { job.data = Data() }
        job.finished = true; taskIDs.removeValue(forKey: task.taskIdentifier); ready.append(job.id)
        let callback = wake
        condition.broadcast(); condition.unlock()
        registry.remove(job.registryID); callback?()
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        condition.lock(); invalidated = true; condition.broadcast(); condition.unlock()
    }

    func cancelAndDrain() {
        condition.lock(); let active = jobs.values.filter { !$0.finished }.map { $0.task }; condition.unlock()
        active.forEach { $0.cancel() }
        condition.lock()
        while jobs.values.contains(where: { !$0.finished }) { condition.wait() }
        condition.unlock()
    }
    func shutdown() {
        condition.lock(); accepting = false; wake = nil; condition.unlock()
        session.invalidateAndCancel()
        condition.lock()
        // Invalidation can precede delivery of a registered task's terminal
        // callback. Neither signal alone grants library-lock release.
        while !invalidated || jobs.values.contains(where: { !$0.finished }) { condition.wait() }
        condition.unlock()
        delegateQueue.waitUntilAllOperationsAreFinished()
        condition.lock(); jobs.removeAll(); taskIDs.removeAll(); ready.removeAll(); taken = nil; condition.unlock()
    }
    #if DEBUG
    var counters: (jobs: Int, running: Int) {
        condition.lock(); defer { condition.unlock() }
        return (jobs.count, jobs.values.filter { !$0.finished }.count)
    }
    #endif
}
