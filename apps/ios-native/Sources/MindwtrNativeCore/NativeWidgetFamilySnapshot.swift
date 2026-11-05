import CoreFoundation
import Foundation

public struct NativeWidgetFamilySnapshot: Sendable {
    public enum SystemColorScheme: String, Sendable {
        case light
        case dark
    }

    public struct Payloads: Sendable {
        public let defaultPayload: String
        public let small: String
        public let medium: String
        public let large: String
        public let extraLarge: String
    }

    static let maximumBytes = 2_000_000
    public let json: String
    public let version: Int
    public let payloads: Payloads

    public init(json: String) throws {
        guard json.utf8.count <= Self.maximumBytes else { throw Self.invalid }
        let root = try Self.object(json)
        guard Set(root.keys) == ["version", "payloads"],
              let version = root["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let values = root["payloads"] as? [String: Any],
              Set(values.keys) == ["default", "small", "medium", "large", "extraLarge"],
              let defaultPayload = values["default"] as? String,
              let small = values["small"] as? String,
              let medium = values["medium"] as? String,
              let large = values["large"] as? String,
              let extraLarge = values["extraLarge"] as? String else { throw Self.invalid }
        let complete = try JSONSerialization.data(withJSONObject: ["ok": true, "value": root], options: [.withoutEscapingSlashes])
        guard complete.count <= Self.maximumBytes else { throw Self.invalid }
        for value in [defaultPayload, small, medium, large, extraLarge] {
            _ = try Self.object(value)
        }
        self.json = json
        self.version = 1
        payloads = Payloads(defaultPayload: defaultPayload, small: small, medium: medium, large: large, extraLarge: extraLarge)
    }

    private static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native widget family snapshot is invalid") }

    private static func object(_ json: String) throws -> [String: Any] {
        do {
            guard try NativeJSON.hasUniqueObjectKeys(json),
                  let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw invalid }
            return value
        } catch { throw invalid }
    }
}
