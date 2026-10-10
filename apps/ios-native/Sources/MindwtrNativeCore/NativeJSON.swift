import Foundation

/// Preserves leading U+FEFF in JSON strings without changing Foundation's
/// object, number, and distinct NSString-key semantics.
public enum NativeJSON {
    public static func jsonObject(with data: Data,
                                  options: JSONSerialization.ReadingOptions = []) throws -> Any {
        let supported: JSONSerialization.ReadingOptions = [.fragmentsAllowed, .mutableContainers]
        guard options.subtracting(supported).isEmpty else {
            throw HostFailure("Unsupported native JSON reading option")
        }
        // Keep the ordinary path byte-for-byte compatible with Foundation.
        guard containsBOM(data) else {
            return try JSONSerialization.jsonObject(with: data, options: options)
        }
        let parsed = try JSONSerialization.jsonObject(with: protectStrings(data), options: options)
        return try restoreStrings(parsed, mutableContainers: options.contains(.mutableContainers))
    }

    /// Checks member uniqueness after ordinary JSON validation, preserving decoded key bytes.
    static func hasUniqueObjectKeys(_ text: String) throws -> Bool {
        let bytes = Array(text.utf8)
        var index = 0, objects: [Set<Data>] = []
        while index < bytes.count {
            if bytes[index] == 0x7b { objects.append([]); index += 1; continue }
            if bytes[index] == 0x7d {
                guard !objects.isEmpty else { return false }
                objects.removeLast(); index += 1; continue
            }
            guard bytes[index] == 0x22 else { index += 1; continue }
            let start = index; index += 1
            while index < bytes.count {
                if bytes[index] == 0x5c { index += 2; continue }
                if bytes[index] == 0x22 { index += 1; break }
                index += 1
            }
            let end = index
            var next = end
            while next < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[next]) { next += 1 }
            if next < bytes.count, bytes[next] == 0x3a {
                guard !objects.isEmpty,
                      let key = try NativeJSON.jsonObject(with: Data(bytes[start..<end]), options: [.fragmentsAllowed]) as? String,
                      objects[objects.count - 1].insert(Data(key.utf8)).inserted else { return false }
            }
        }
        return objects.isEmpty
    }

    private static func containsBOM(_ data: Data) -> Bool {
        let bytes = data
        for index in bytes.indices {
            if index + 2 < bytes.endIndex, bytes[index] == 0xEF,
               bytes[index + 1] == 0xBB, bytes[index + 2] == 0xBF { return true }
            if index + 5 < bytes.endIndex, bytes[index] == 0x5C,
               bytes[index + 1] == 0x75,
               bytes[index + 2] == 0x46 || bytes[index + 2] == 0x66,
               bytes[index + 3] == 0x45 || bytes[index + 3] == 0x65,
               bytes[index + 4] == 0x46 || bytes[index + 4] == 0x66,
               bytes[index + 5] == 0x46 || bytes[index + 5] == 0x66 { return true }
        }
        return false
    }

    /// Only tracks quote and backslash state; JSONSerialization validates JSON.
    private static func protectStrings(_ data: Data) -> Data {
        var result = Data()
        result.reserveCapacity(data.count)
        var quoted = false
        var escaped = false
        for byte in data {
            result.append(byte)
            if quoted {
                if escaped { escaped = false }
                else if byte == 0x5C { escaped = true }
                else if byte == 0x22 { quoted = false }
            } else if byte == 0x22 {
                quoted = true
                result.append(0x78) // ASCII x precedes every string's first byte.
            }
        }
        return result
    }

    private static func restoreText(_ value: String) throws -> String {
        guard value.utf8.first == 0x78 else { throw HostFailure("Invalid protected native JSON string") }
        // Drop a UTF-8 byte, never a Swift Character (which may include a
        // leading combining mark or U+FEFF in the same grapheme cluster).
        return String(decoding: value.utf8.dropFirst(), as: UTF8.self)
    }

    private static func restoreStrings(_ value: Any, mutableContainers: Bool) throws -> Any {
        if let text = value as? String { return try restoreText(text) }
        if let object = value as? NSDictionary {
            let restored = NSMutableDictionary(capacity: object.count)
            for (key, child) in object {
                guard let key = key as? String else { throw HostFailure("Invalid native JSON object key") }
                restored.setObject(try restoreStrings(child, mutableContainers: mutableContainers),
                                   forKey: try restoreText(key) as NSString)
            }
            if mutableContainers { return restored }
            return restored.copy()
        }
        if let array = value as? NSArray {
            let restored = NSMutableArray(capacity: array.count)
            for child in array { restored.add(try restoreStrings(child, mutableContainers: mutableContainers)) }
            if mutableContainers { return restored }
            return restored.copy()
        }
        return value
    }
}
