import Foundation
import MindwtrWatchPayloadValidation

public struct NativeWatchPomodoro: Sendable {
    public let name: String
    public let body: String
    let id: String

    public init(name: String, body: String) throws {
        guard body.utf8.count <= 32 * 1024, try NativeJSON.hasUniqueObjectKeys(body),
              let raw = try NativeJSON.jsonObject(with: Data(body.utf8)) as? [String: Any] else { throw Self.invalid }
        let normalized = try MindwtrWatchPayloadValidator.normalizePendingPomodoro(raw)
        guard let id = normalized["id"] as? String, raw["id"] as? String == id, name == id + ".json" else { throw Self.invalid }
        self.name = name; self.body = body; self.id = id
    }
    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native Watch timer source is invalid") }
}
