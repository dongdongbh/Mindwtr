import Foundation

struct MindwtrWatchPendingCapture: Equatable {
    enum Content: Equatable {
        case text(String)
        case audio(URL)
    }

    let id: UUID
    let createdAt: Date
    let content: Content
    let outboxRetried: Bool

    init(id: UUID, createdAt: Date, content: Content, outboxRetried: Bool = false) {
        self.id = id
        self.createdAt = createdAt
        self.content = content
        self.outboxRetried = outboxRetried
    }
}

struct MindwtrWatchPendingCaptureOwner {
    private(set) var pending: MindwtrWatchPendingCapture?

    mutating func prepareText(
        _ text: String,
        id: UUID = UUID(),
        createdAt: Date = Date()
    ) -> MindwtrWatchPendingCapture {
        if let pending, pending.content == .text(text) {
            return pending
        }
        let capture = MindwtrWatchPendingCapture(id: id, createdAt: createdAt, content: .text(text))
        pending = capture
        return capture
    }

    mutating func prepareAudio(
        fileURL: URL,
        id: UUID,
        createdAt: Date
    ) -> MindwtrWatchPendingCapture {
        let capture = MindwtrWatchPendingCapture(id: id, createdAt: createdAt, content: .audio(fileURL))
        pending = capture
        return capture
    }

    mutating func persistPending(
        using persist: (MindwtrWatchPendingCapture) -> Bool
    ) -> Bool {
        guard let pending else { return false }
        guard persist(pending) else {
            self.pending = MindwtrWatchPendingCapture(
                id: pending.id,
                createdAt: pending.createdAt,
                content: pending.content,
                outboxRetried: true
            )
            return false
        }
        if self.pending == pending {
            self.pending = nil
        }
        return true
    }

    mutating func discardPending() {
        pending = nil
    }
}

enum MindwtrWatchOutbox {
    enum Transport: String {
        case userInfo
        case command
        case audio
    }

    struct Record {
        let id: String
        let createdAt: String
        let transport: Transport
        let payload: [String: Any]
        let audioURL: URL?
    }

    static func save(payload: [String: Any], transport: Transport, audioURL: URL? = nil) throws {
        guard let rawId = payload["id"] as? String,
              let uuid = UUID(uuidString: rawId)
        else {
            throw OutboxError.invalidIdentifier
        }
        let id = uuid.uuidString.lowercased()
        var canonicalPayload = payload
        canonicalPayload["id"] = id
        var value: [String: Any] = [
            "id": id,
            "transport": transport.rawValue,
            "payload": canonicalPayload,
        ]
        if let audioURL { value["audioFileName"] = audioURL.lastPathComponent }
        guard JSONSerialization.isValidJSONObject(value) else { throw OutboxError.invalidPayload }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.write(to: recordURL(id: id), options: .atomic)
    }

    static func records() -> [Record] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }

        return files
            .filter { $0.pathExtension == "json" }
            .compactMap(load)
            .sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
                return lhs.id < rhs.id
            }
    }

    static func remove(id: String, removeAudio: Bool) {
        try? FileManager.default.removeItem(at: recordURL(id: id))
        if removeAudio {
            try? FileManager.default.removeItem(at: audioURL(id: id))
        }
    }

    static func audioURL(id: String) -> URL {
        let canonicalId = UUID(uuidString: id)?.uuidString.lowercased() ?? id.lowercased()
        return directory.appendingPathComponent("\(canonicalId).m4a", isDirectory: false)
    }

    static func prepareAudioURL(id: UUID) throws -> URL {
        _ = directory
        return audioURL(id: id.uuidString)
    }

    private static func load(_ url: URL) -> Record? {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawId = value["id"] as? String,
              let uuid = UUID(uuidString: rawId),
              let transportRaw = value["transport"] as? String,
              let transport = Transport(rawValue: transportRaw),
              let payload = value["payload"] as? [String: Any],
              let createdAt = payload["createdAt"] as? String
        else { return nil }

        let id = uuid.uuidString.lowercased()
        let audioURL: URL?
        if transport == .audio,
           let fileName = value["audioFileName"] as? String,
           fileName == "\(id).m4a" {
            audioURL = directory.appendingPathComponent(fileName, isDirectory: false)
        } else {
            audioURL = nil
        }
        return Record(id: id, createdAt: createdAt, transport: transport, payload: payload, audioURL: audioURL)
    }

    private static func recordURL(id: String) -> URL {
        directory.appendingPathComponent("\(id).json", isDirectory: false)
    }

    private static var directory: URL {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let directory = documents.appendingPathComponent("watch-outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private enum OutboxError: Error {
        case invalidIdentifier
        case invalidPayload
    }
}
