import Foundation
import MindwtrWatchPayloadValidation

public struct NativeWatchSnapshot: Sendable {
    private let propertyList: Data

    public init(json: String) throws {
        do {
            let bytes = Data(json.utf8)
            guard bytes.count <= 512 * 1024, Self.hasBoundedNesting(bytes),
                  let raw = try NativeJSON.jsonObject(with: bytes) as? [String: Any],
                  try NativeJSON.hasUniqueObjectKeys(json) else { throw Self.invalid }
            let context = try MindwtrWatchPayloadValidator.normalizeApplicationContext(raw)
            propertyList = try PropertyListSerialization.data(fromPropertyList: context, format: .binary, options: 0)
        } catch { throw Self.invalid }
    }

    public func applicationContext() throws -> [String: Any] {
        guard let context = try PropertyListSerialization.propertyList(from: propertyList, options: [], format: nil)
                as? [String: Any] else { throw Self.invalid }
        return context
    }

    private static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native Watch snapshot is invalid") }

    private static func hasBoundedNesting(_ bytes: Data) -> Bool {
        var depth = 0, quoted = false, escaped = false
        for byte in bytes {
            if quoted {
                if escaped { escaped = false }
                else if byte == 92 { escaped = true }
                else if byte == 34 { quoted = false }
            } else if byte == 34 { quoted = true }
            else if byte == 123 || byte == 91 {
                depth += 1
                if depth > 32 { return false }
            } else if byte == 125 || byte == 93 { depth -= 1 }
        }
        return true
    }
}
