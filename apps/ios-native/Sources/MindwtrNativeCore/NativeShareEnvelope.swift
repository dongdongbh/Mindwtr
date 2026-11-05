import Foundation

public enum NativeShareError: Error, Sendable { case unavailable, invalidInput, changedSource, full }

/// Raw provider text only. The containing App's canonical core builds the capture title/note.
public struct NativeShareEnvelope: Codable, Equatable, Sendable {
    public static let maximumBytes = 240 * 1024
    public static let textLimit = 50_000, subjectLimit = 10_000, webURLLimit = 16_000
    public let version: Int
    public let id: String
    public let receivedAtMs: Int64
    public let subject: String?
    public let text: String?
    public let webUrl: String?

    public init(id: UUID = UUID(), receivedAt: Date = Date(), subject: String?, text: String?, webUrl: String?) throws {
        let clock = floor(receivedAt.timeIntervalSince1970 * 1000)
        guard clock.isFinite, abs(clock) <= 8_640_000_000_000_000 else { throw NativeShareError.invalidInput }
        version = 1; self.id = id.uuidString.lowercased(); receivedAtMs = Int64(clock)
        self.subject = subject; self.text = text; self.webUrl = webUrl
        try validate()
        _ = try encoded()
    }

    func validate() throws {
        guard version == 1, UUID(uuidString: id)?.uuidString.lowercased() == id,
              abs(Double(receivedAtMs)) <= 8_640_000_000_000_000,
              subject.map({ $0.utf16.count <= Self.subjectLimit }) ?? true,
              text.map({ $0.utf16.count <= Self.textLimit }) ?? true,
              webUrl.map({ $0.utf16.count <= Self.webURLLimit }) ?? true,
              [subject, text, webUrl].contains(where: { $0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }) else {
            throw NativeShareError.invalidInput
        }
        if let webUrl {
            guard let value = URLComponents(string: webUrl), ["http", "https"].contains(value.scheme?.lowercased() ?? ""),
                  value.host?.isEmpty == false else { throw NativeShareError.invalidInput }
        }
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = try encoder.encode(self)
        guard bytes.count <= Self.maximumBytes else { throw NativeShareError.invalidInput }
        return bytes
    }
    public static func decode(_ bytes: Data) throws -> Self {
        guard bytes.count <= maximumBytes else { throw NativeShareError.invalidInput }
        let value = try JSONDecoder().decode(Self.self, from: bytes)
        try value.validate()
        guard try value.encoded() == bytes else { throw NativeShareError.invalidInput }
        return value
    }
}
