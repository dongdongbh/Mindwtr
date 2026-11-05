import CryptoKit
import Foundation

/// Canonical row capabilities travel with the unchanged read-only display snapshot.
public struct NativeWidgetNextActionSnapshot: Sendable {
    public let snapshot: NativeWidgetNextSnapshot
    public let tokens: [String?]
    public let completeLabel: String
    public let undoLabel: String

    public init(json: String) throws {
        guard json.utf8.count <= 2 * 1_024 * 1_024,
              try NativeJSON.hasUniqueObjectKeys(json),
              let root = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(root.keys) == ["snapshot", "tokens", "completeLabel", "undoLabel"],
              let raw = root["snapshot"] as? String,
              let values = root["tokens"] as? [Any],
              let completeLabel = root["completeLabel"] as? String,
              let undoLabel = root["undoLabel"] as? String else {
            throw HostFailure("INVALID_INPUT: Native widget action snapshot is invalid")
        }
        var tokens: [String?] = []
        for value in values {
            if value is NSNull { tokens.append(nil) }
            else if let token = value as? String { tokens.append(token) }
            else { throw HostFailure("INVALID_INPUT: Native widget action snapshot is invalid") }
        }
        try self.init(snapshot: NativeWidgetNextSnapshot(json: raw), tokens: tokens,
                      completeLabel: completeLabel, undoLabel: undoLabel)
    }

    init(snapshot: NativeWidgetNextSnapshot, tokens: [String?], completeLabel: String, undoLabel: String) throws {
        let invalid = HostFailure("INVALID_INPUT: Native widget action snapshot is invalid")
        guard tokens.count == snapshot.items.count,
              !completeLabel.isEmpty, completeLabel.utf16.count <= 16_384,
              !undoLabel.isEmpty, undoLabel.utf16.count <= 16_384 else { throw invalid }
        let scope = SHA256.hash(data: Data(NativeWidgetNextCache.namespace.utf8)).map { String(format: "%02x", $0) }.joined()
        for (item, token) in zip(snapshot.items, tokens) {
            guard let token else { continue }
            let suffix = Data(item.id.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            guard NativeWidgetActionStore.validOperation(scope + "." + suffix, token) else { throw invalid }
        }
        self.snapshot = snapshot; self.tokens = tokens
        self.completeLabel = completeLabel; self.undoLabel = undoLabel
    }
}
