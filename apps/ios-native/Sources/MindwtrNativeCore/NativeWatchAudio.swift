import CoreFoundation
import Foundation
import MindwtrWatchPayloadValidation

/// A pre-journal refusal leaves the receiver's audio available for a later attempt.
public struct NativeWatchAudioRetryable: Error, Sendable { public init() {} }

/// A successful parse selected a truthy value that Watch cannot admit as transcript text.
struct NativeWatchAudioInvalidParsedTranscript: Error, Sendable {}

struct NativeWatchAudio: Sendable {
    let name: String
    let body: String
    let id: String

    init(name: String, body: String) throws {
        let source = try NativeVoiceJSON.object(body, maximum: 32 * 1024)
        let normalized = try MindwtrWatchPayloadValidator.normalizePendingAudio(source)
        guard let id = normalized["id"] as? String, source["id"] as? String == id,
              name == id + ".json" else { throw Self.invalid }
        self.name = name; self.body = body; self.id = id
    }

    func envelope(transcript: String?) throws -> String {
        if let transcript { try Self.validateTranscript(transcript) }
        return try NativeVoiceJSON.encode(["version": 1, "requestId": id, "name": name,
            "body": body, "transcript": transcript.map { $0 as Any } ?? NSNull()])
    }

    static func readEnvelope(_ json: String) throws -> (source: Self, transcript: String?) {
        let value = try NativeVoiceJSON.object(json, maximum: 768 * 1024)
        guard Set(value.keys) == ["version", "requestId", "name", "body", "transcript"],
              integer(value["version"], equals: 1), let name = value["name"] as? String,
              let body = value["body"] as? String else { throw invalid }
        let source = try Self(name: name, body: body)
        guard value["requestId"] as? String == source.id else { throw invalid }
        if value["transcript"] is NSNull { return (source, nil) }
        guard let transcript = value["transcript"] as? String else { throw invalid }
        try validateTranscript(transcript)
        return (source, transcript)
    }

    static func validateTranscript(_ transcript: String) throws {
        guard !transcript.isEmpty, transcript.utf8.count <= 64 * 1024,
              transcript.trimmingCharacters(in: .whitespacesAndNewlines) == transcript else { throw invalid }
    }

    func validateResult(_ json: String) throws {
        let result = try NativeVoiceJSON.object(json, maximum: 4096)
        guard Set(result.keys) == ["version", "ingested", "completed"], Self.integer(result["version"], equals: 1),
              Self.integer(result["ingested"], equals: 1), let completed = result["completed"] as? [[String: Any]],
              completed.count == 1, Set(completed[0].keys) == ["name"],
              completed[0]["name"] as? String == name else { throw Self.invalid }
    }

    private static func integer(_ value: Any?, equals expected: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == Double(expected)
    }
    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native Watch audio is invalid") }
    static var ownerChanged: CoreHostRejection { CoreHostRejection(message: "NOT_READY: Watch audio owner changed") }
}

/// The production receiver supplies both the frozen bytes and its synchronous generation check.
struct NativeWatchAudioBytes: Sendable {
    let bytes: Data
    let validate: @Sendable () throws -> Void
}

/// This private read carries endpoint policy without changing the recorder/settings read shapes.
struct NativeWatchOpenAIRuntime: Sendable {
    let enabled: Bool
    let model: String
    let language: String
    let mode: NativeVoiceMode
    let fieldStrategy: NativeVoiceFieldStrategy
    let endpoint: String
    let credentialRequired: Bool
    let parseModel: String
    let retryModel: String

    static func validated(_ raw: String) throws -> Self {
        let value = try NativeVoiceJSON.object(raw, maximum: 32768)
        guard Set(value.keys) == ["version", "provider", "enabled", "model", "language", "mode", "fieldStrategy", "endpoint", "credentialRequired", "parseModel", "retryModel"],
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              value["provider"] as? String == "openai", let enabled = NativeVoiceJSON.boolean(value["enabled"]),
              let required = NativeVoiceJSON.boolean(value["credentialRequired"]),
              let model = field(value["model"], maximum: 2000), !model.trimmingCharacters(in: .whitespaces).isEmpty,
              let language = field(value["language"], maximum: 200), !language.isEmpty,
              let mode = (value["mode"] as? String).flatMap(NativeVoiceMode.init(rawValue:)),
              let strategy = (value["fieldStrategy"] as? String).flatMap(NativeVoiceFieldStrategy.init(rawValue:)),
              let endpoint = field(value["endpoint"], maximum: 4096), !endpoint.isEmpty,
              !endpoint.unicodeScalars.contains(where: { $0.value <= 32 }),
              let url = URL(string: endpoint), NativeHTTPJobs.allowedURL(url),
              let parseModel = field(value["parseModel"], maximum: 2000), !parseModel.trimmingCharacters(in: .whitespaces).isEmpty,
              let retryModel = field(value["retryModel"], maximum: 2000), !retryModel.trimmingCharacters(in: .whitespaces).isEmpty else { throw NativeWatchAudio.invalid }
        return .init(enabled: enabled, model: model, language: language, mode: mode, fieldStrategy: strategy,
                     endpoint: endpoint, credentialRequired: required, parseModel: parseModel, retryModel: retryModel)
    }

    private static func field(_ input: Any?, maximum: Int) -> String? {
        guard let value = input as? String, value.utf8.count <= maximum,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return value
    }

    func multipart(fields: [[String]], bytes: Data, sourceID: String, format: NativeVoiceAudioFormat = .wave) throws -> (contentType: String, body: Data) {
        var expected = [["model", model]]
        if language != "auto" { expected.append([model.hasPrefix("gpt-transcribe") ? "languages[]" : "language", language]) }
        expected.append(["response_format", "json"])
        guard try Data(NativeVoiceJSON.encode(fields).utf8) == Data(NativeVoiceJSON.encode(expected).utf8),
              UUID(uuidString: sourceID)?.uuidString.lowercased() == sourceID,
              !bytes.isEmpty, bytes.count <= 4 * 1024 * 1024 else { throw NativeWatchAudio.invalid }
        let boundary = "Mindwtr-" + UUID().uuidString.lowercased()
        var body = Data()
        for pair in fields {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(pair[0])\"\r\n\r\n\(pair[1])\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(sourceID).\(format.extensionName)\"\r\nContent-Type: \(format.mimeType)\r\n\r\n".utf8))
        body.append(bytes); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        guard body.count <= 8 * 1024 * 1024 else { throw NativeWatchAudio.invalid }
        return ("multipart/form-data; boundary=" + boundary, body)
    }
}

enum NativeVoiceAudioFormat: Sendable {
    case wave, m4a
    var extensionName: String { self == .wave ? "wav" : "m4a" }
    var mimeType: String { self == .wave ? "audio/wav" : "audio/mp4" }
}

enum NativeOpenAISpeechAPI: String, CaseIterable, Sendable {
    case responses, chat
    var endpoint: String { "https://api.openai.com/v1/" + (self == .responses ? "responses" : "chat/completions") }
}
