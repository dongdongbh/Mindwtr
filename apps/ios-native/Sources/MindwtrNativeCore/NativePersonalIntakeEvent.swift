import CryptoKit
import Foundation

public struct NativePersonalIntakeEvent: Sendable, Equatable, Codable {
    public enum Kind: String, Sendable, Codable { case reminder, url, spotlight, share }
    public let id: String
    public let kind: Kind
    public let receivedAtMs: Int64
    public let text: String?
    public let response: NativeReminderResponse?
    public let share: NativeShareEnvelope?

    private init(id: String, kind: Kind, receivedAtMs: Int64, text: String?, response: NativeReminderResponse?, share: NativeShareEnvelope? = nil) {
        self.id = id; self.kind = kind; self.receivedAtMs = receivedAtMs; self.text = text; self.response = response; self.share = share
    }

    public static func reminder(_ response: NativeReminderResponse) -> Self {
        Self(id: response.requestID, kind: .reminder, receivedAtMs: response.requestedAtMs, text: nil, response: response)
    }
    public static func url(_ text: String, id: UUID = UUID(), receivedAt: Date = Date()) throws -> Self {
        try navigation(text, id: id, receivedAt: receivedAt, kind: .url)
    }
    public static func shared(_ envelope: NativeShareEnvelope) throws -> Self {
        try envelope.validate()
        return Self(id: envelope.id, kind: .share, receivedAtMs: envelope.receivedAtMs, text: nil, response: nil, share: envelope)
    }
    public static func spotlight(_ identifier: String, id: UUID = UUID(), receivedAt: Date = Date()) throws -> Self {
        try navigation(identifier, id: id, receivedAt: receivedAt, kind: .spotlight)
    }
    private static func navigation(_ text: String, id: UUID, receivedAt: Date, kind: Kind) throws -> Self {
        let ms = floor(receivedAt.timeIntervalSince1970 * 1_000)
        guard ms.isFinite, abs(ms) <= 8_640_000_000_000_000,
              !text.isEmpty, text.utf16.count <= (kind == .url ? 16_000 : 8_000) else {
            throw NativePersonalIntakeError.unavailable
        }
        return Self(id: id.uuidString.lowercased(), kind: kind, receivedAtMs: Int64(ms), text: text, response: nil)
    }
    func validate(namespace: String) throws {
        guard IntakeWire.uuid(id), abs(Double(receivedAtMs)) <= 8_640_000_000_000_000 else {
            throw NativePersonalIntakeError.unavailable
        }
        switch kind {
        case .reminder:
            guard share == nil, text == nil, let response, response.requestID == id, response.requestedAtMs == receivedAtMs else {
                throw NativePersonalIntakeError.unavailable
            }
            try NativeReminderInbox.validateForPersonalIntake(response, namespace: namespace)
        case .url, .spotlight:
            guard share == nil, response == nil, let text, !text.isEmpty,
                  text.utf16.count <= (kind == .url ? 16_000 : 8_000) else { throw NativePersonalIntakeError.unavailable }
        case .share:
            guard text == nil, response == nil, let share, share.id == id, share.receivedAtMs == receivedAtMs else {
                throw NativePersonalIntakeError.unavailable
            }
            try share.validate()
        }
    }
    var notificationIdentity: IntakeNotificationIdentity? {
        response.map { .init(notificationIdentifier: $0.notificationIdentifier, action: $0.action, deliveredAtBits: $0.deliveredAtBits) }
    }
}

struct IntakeNotificationIdentity: Codable, Equatable, Sendable {
    let notificationIdentifier: String
    let action: NativeReminderResponse.Action
    let deliveredAtBits: String
}

enum IntakeWire {
    static let recordLimit = 256 * 1024
    static let headerLimit = 512 * 1024
    static let pageLimit = 32
    static let maximumSequence: Int64 = 9_007_199_254_740_991
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func encode<T: Encodable>(_ value: T, limit: Int) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = try encoder.encode(value)
        guard bytes.count <= limit else { throw NativePersonalIntakeError.unavailable }; return bytes
    }
    static func decode<T: Codable>(_ type: T.Type, _ bytes: Data, limit: Int) throws -> T {
        guard bytes.count <= limit else { throw NativePersonalIntakeError.unavailable }
        let value = try JSONDecoder().decode(type, from: bytes)
        guard try encode(value, limit: limit) == bytes else { throw NativePersonalIntakeError.unavailable }; return value
    }
}
