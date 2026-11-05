import CoreFoundation
import CryptoKit
import Foundation

public struct NativeWidgetNextCache: Sendable {
    public static let kind = "MindwtrNativeNextWidget"
    public static let namespace = "tech.dongdongbh.mindwtr.native.dev"
    public static let group = "group." + namespace
    private static let maximumBytes = 2 * 1_024 * 1_024
    private let directory: URL
    private var file: URL { directory.appendingPathComponent("next.json") }

    public struct Record: Sendable {
        public let snapshot: NativeWidgetNextSnapshot
        public let identifiers: [String]
        public let actions: NativeWidgetNextActionSnapshot?
        public let publishedAtMs: Double
        public let expiresAtMs: Double

        public init(json: String) throws {
            let invalid = HostFailure("INVALID_INPUT: Native widget cache is invalid")
            guard json.utf8.count <= NativeWidgetNextCache.maximumBytes,
                  try NativeJSON.hasUniqueObjectKeys(json),
                  let root = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
                  let version = NativeWidgetNextCache.number(root["version"]),
                  version == 1 || version == 2,
                  Set(root.keys) == Set(["version", "namespace", "snapshot", "identifiers", "publishedAtMs", "expiresAtMs"]
                    + (version == 2 ? ["tokens", "completeLabel", "undoLabel"] : [])),
                  root["namespace"] as? String == NativeWidgetNextCache.namespace,
                  let raw = root["snapshot"] as? String, let identifiers = root["identifiers"] as? [String],
                  let published = NativeWidgetNextCache.number(root["publishedAtMs"]),
                  let expires = NativeWidgetNextCache.number(root["expiresAtMs"]),
                  expires > published, expires - published <= 86_400_000 else { throw invalid }
            let snapshot = try NativeWidgetNextSnapshot(json: raw)
            let scope = SHA256.hash(data: Data(NativeWidgetNextCache.namespace.utf8)).map { String(format: "%02x", $0) }.joined()
            guard identifiers.count == snapshot.items.count else { throw invalid }
            for (identifier, item) in zip(identifiers, snapshot.items) {
                guard identifier.hasPrefix(scope + "."),
                      let id = NativeWidgetTaskLink.decodedTaskID(identifier), Data(id.utf8) == Data(item.id.utf8),
                      NativeWidgetTaskLink.url(identifier: identifier) != nil else { throw invalid }
            }
            if version == 2 {
                guard let values = root["tokens"] as? [Any],
                      let completeLabel = root["completeLabel"] as? String,
                      let undoLabel = root["undoLabel"] as? String else { throw invalid }
                var tokens: [String?] = []
                for value in values {
                    if value is NSNull { tokens.append(nil) }
                    else if let token = value as? String { tokens.append(token) }
                    else { throw invalid }
                }
                actions = try NativeWidgetNextActionSnapshot(snapshot: snapshot, tokens: tokens,
                    completeLabel: completeLabel, undoLabel: undoLabel)
                for (identifier, token) in zip(identifiers, tokens) {
                    if let token, !NativeWidgetActionStore.validOperation(identifier, token) { throw invalid }
                }
            } else { actions = nil }
            self.snapshot = snapshot; self.identifiers = identifiers
            publishedAtMs = published; expiresAtMs = expires
        }

        public func contains(identifier: String, token: String) -> Bool {
            guard let actions else { return false }
            return zip(identifiers, actions.tokens).contains { current, capability in
                guard let capability else { return false }
                return Data(current.utf8) == Data(identifier.utf8) && Data(capability.utf8) == Data(token.utf8)
            }
        }

        public func available(at nowMs: Double) -> Bool {
            nowMs.isFinite && nowMs >= publishedAtMs && nowMs < expiresAtMs
        }
    }

    public static func live() -> NativeWidgetNextCache? {
        #if os(iOS)
        guard [namespace, namespace + ".capture-widget"].contains(Bundle.main.bundleIdentifier ?? ""),
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return NativeWidgetNextCache(groupURL: root)
        #else
        return nil
        #endif
    }

    init(groupURL: URL) { directory = groupURL.appendingPathComponent("NativeWidgets", isDirectory: true) }

    public func read(nowMs: Double = Date().timeIntervalSince1970 * 1_000) throws -> Record? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= Self.maximumBytes else {
            throw HostFailure("Native widget cache is unavailable")
        }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= Self.maximumBytes, let json = String(data: bytes, encoding: .utf8) else {
            throw HostFailure("Native widget cache is unavailable")
        }
        let record = try Record(json: json)
        return record.available(at: nowMs) ? record : nil
    }

    public func publish(_ snapshot: NativeWidgetNextSnapshot, identifiers: [String], publishedAtMs: Double, expiresAtMs: Double) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "namespace": Self.namespace,
            "snapshot": snapshot.json, "identifiers": identifiers, "publishedAtMs": publishedAtMs, "expiresAtMs": expiresAtMs])
        try publish(bytes)
    }

    public func publish(_ actions: NativeWidgetNextActionSnapshot, identifiers: [String], publishedAtMs: Double, expiresAtMs: Double) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 2, "namespace": Self.namespace,
            "snapshot": actions.snapshot.json, "identifiers": identifiers, "publishedAtMs": publishedAtMs, "expiresAtMs": expiresAtMs,
            "tokens": actions.tokens.map { $0.map { $0 as Any } ?? NSNull() },
            "completeLabel": actions.completeLabel, "undoLabel": actions.undoLabel])
        try publish(bytes)
    }

    private func publish(_ bytes: Data) throws {
        guard let json = String(data: bytes, encoding: .utf8) else { throw HostFailure("Native widget cache is unavailable") }
        _ = try Record(json: json)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var path = directory; try path.setResourceValues(excluded)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        try bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
    }

    public func invalidate() throws {
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.doubleValue
    }
}
