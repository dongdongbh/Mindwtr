#if DEBUG && targetEnvironment(simulator)
import Foundation

enum NativeVoiceUIFixture {
    static func taskAIConfiguration() -> URLSessionConfiguration {
        let value = URLSessionConfiguration.ephemeral
        value.protocolClasses = [NativeTaskAIUIFixtureProtocol.self]
        return value
    }
    static func configuration() -> URLSessionConfiguration {
        let value = URLSessionConfiguration.ephemeral
        value.protocolClasses = [NativeVoiceUIFixtureProtocol.self]
        return value
    }
}

private final class NativeVoiceUIFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.scheme == "https",
              request.url?.host == "generativelanguage.googleapis.com",
              request.httpMethod == "POST",
              request.value(forHTTPHeaderField: "x-goog-api-key") == "SYNTHETIC-NATIVE-VOICE-UI" else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let speech = "{\"title\":\"Synthetic voice transcript\",\"transcript\":\"Synthetic voice transcript\",\"description\":\"Synthetic voice detail\"}"
        let body: [String: Any] = ["candidates": [["content": ["parts": [["text": speech]]]]]]
        do {
            let data = try JSONSerialization.data(withJSONObject: body)
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json", "Content-Length": String(data.count)]) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)) }
    }
    override func stopLoading() { }
}


private final class NativeTaskAIUIFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func requestBytes() throws -> Data {
        if let bytes = request.httpBody {
            guard bytes.count <= 1_048_576 else { throw URLError(.dataLengthExceedsMaximum) }
            return bytes
        }
        guard let stream = request.httpBodyStream else { throw URLError(.badServerResponse) }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: 4096)
            guard count >= 0 else { throw URLError(.badServerResponse) }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
            guard bytes.count <= 1_048_576 else { throw URLError(.dataLengthExceedsMaximum) }
        }
        return bytes
    }
    override func startLoading() {
        do {
            guard let url = request.url, url.scheme == "http", url.host == "127.0.0.1",
                  url.path == "/v1/chat/completions", url.query == nil, url.fragment == nil,
                  url.user == nil, url.password == nil, request.httpMethod == "POST",
                  request.value(forHTTPHeaderField: "Authorization") == nil,
                  let body = try JSONSerialization.jsonObject(with: requestBytes()) as? [String: Any],
                  body["model"] as? String == "capture-ai-fixture",
                  let messages = body["messages"] as? [[String: Any]],
                  let user = messages.first(where: { $0["role"] as? String == "user" })?["content"] as? String else {
                throw URLError(.unsupportedURL)
            }
            let lines = user.components(separatedBy: "\n")
            let answer: [String: Any]
            if let marker = lines.firstIndex(of: "Items:") {
                guard marker + 1 < lines.count,
                      let run = ProcessInfo.processInfo.environment["MINDWTR_REVIEW_AI_UI_RUN"],
                      let token = UUID(uuidString: run), token.uuidString.lowercased() == run,
                      let bytes = lines[marker + 1].data(using: .utf8),
                      let items = try JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], items.count <= 16 else {
                    throw URLError(.badServerResponse)
                }
                var suggestions: [[String: Any]] = []
                for role in ["someday", "archive"] {
                    let id = "review-ai-" + run + "-" + role, title = "Synthetic review AI " + run + " " + role
                    if let item = items.first(where: { $0["id"] as? String == id }) {
                        guard item["title"] as? String == title, item["status"] as? String == "next",
                              ((item["daysStale"] as? NSNumber)?.doubleValue ?? 0) > 14 else { throw URLError(.badServerResponse) }
                        suggestions.append(["id": id, "action": role, "reason": role == "someday" ? "Reconsider this synthetic task later" : "Archive this synthetic task if selected"])
                    }
                }
                answer = ["suggestions": suggestions]
            } else {
                guard let marker = lines.firstIndex(of: "Task:"), marker + 1 < lines.count,
                      let inputData = lines[marker + 1].data(using: .utf8),
                      let input = try JSONSerialization.jsonObject(with: inputData) as? [String: Any],
                      let title = input["title"] as? String else { throw URLError(.badServerResponse) }
                let inbox = title.hasPrefix("Synthetic inbox AI ")
                let normalized = inbox && title.hasSuffix(" local") ? String(title.dropLast(6)) : title
                let original = normalized.hasSuffix(" clarified") ? String(normalized.dropLast(10)) : normalized
                let prefix = inbox ? "Synthetic inbox AI " : "Synthetic task AI "
                guard original.hasPrefix(prefix), UUID(uuidString: String(original.dropFirst(prefix.count))) != nil else {
                    throw URLError(.badServerResponse)
                }
                if lines.contains("Goal: turn this into a concrete next action.") {
                    answer = ["question": "Choose a synthetic next action", "options": [
                        ["label": "Use synthetic rewrite", "action": original + " rewrite"]],
                        "suggestedAction": ["title": original + " clarified", "context": "@home", "timeEstimate": "15min"]]
                } else if lines.contains("Goal: break this into 3-8 actionable next steps.") {
                    answer = ["steps": ["Synthetic task AI inspect scope", "Synthetic task AI prepare result", "Synthetic task AI check result"]]
                } else { throw URLError(.badServerResponse) }
            }
            let content = String(decoding: try JSONSerialization.data(withJSONObject: answer), as: UTF8.self)
            let data = try JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": content]]]])
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json", "Content-Length": String(data.count)]) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)) }
    }
    override func stopLoading() { }
}

struct NativeVoiceUIFixtureBackend: NativeVoiceRecorderBackend {
    func requestPermission() async throws -> Bool { true }
    func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws -> any NativeVoiceRecordingAdapter {
        try NativeVoiceUIFixtureAdapter(url: url)
    }
}
private final class NativeVoiceUIFixtureAdapter: NativeVoiceRecordingAdapter {
    private let writer: FileHandle
    private var closed = false
    init(url: URL) throws { writer = try FileHandle(forWritingTo: url) }
    func start() throws {
        guard let data = Data(base64Encoded: "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAAy21kYXTcAExhdmM2My4xLjEwMgACMEAOARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAOubW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAACsRAAArEQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAtl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAArEQAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAKxEAAAEAAABAAAAAAJRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAACsRAAAsERVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAAB/G1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABwHN0YmwAAABqc3RzZAAAAAAAAAABAAAAWm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAACsRAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAH0AAAABfQFgICABRIIVuUABoCAgAECAAAAIHN0dHMAAAAAAAAAAgAAACwAAAQAAAAAAQAAAEQAAAAcc3RzYwAAAAAAAAABAAAAAQAAAC0AAAABAAAAyHN0c3oAAAAAAAAAAAAAAC0AAAATAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAUc3RjbwAAAAAAAAABAAAALAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAAtAAAAAQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDI=") else { throw NativeVoiceRecordingError.unavailable }
        try writer.write(contentsOf: data)
    }
    func close() throws { if !closed { closed = true; try writer.close() } }
}
#endif
