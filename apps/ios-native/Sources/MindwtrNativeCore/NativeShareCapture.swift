import Foundation
import CoreFoundation
import CryptoKit

enum NativeShareCaptureJSON {
    static let maximumBytes = 32 * 1024 * 1024
    static func encoded(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    static func object(_ raw: String) throws -> [String: Any] {
        guard raw.utf8.count <= maximumBytes, try NativeJSON.hasUniqueObjectKeys(raw),
              let value = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw NativeShareError.invalidInput }
        return value
    }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func identity(_ envelope: NativeShareEnvelope) throws -> String {
        try envelope.validate()
        return try encoded(["id": envelope.id, "fingerprint": digest(envelope.encoded())])
    }
    static func makeRequest(_ envelope: NativeShareEnvelope, method: String, requestJSON: String) throws -> String {
        let capture = try object(requestJSON), source = try object(identity(envelope))
        return try encoded(["source": source, "method": method, "requestFingerprint": digest(Data(encoded(capture).utf8)), "capture": capture])
    }
    static func request(_ raw: String) throws -> [String: Any] {
        let value = try object(raw)
        guard Set(value.keys) == Set(["source", "method", "requestFingerprint", "capture"]),
              let source = value["source"] as? [String: Any], Set(source.keys) == Set(["id", "fingerprint"]),
              let id = source["id"] as? String, IntakeWire.uuid(id),
              let fingerprint = source["fingerprint"] as? String, hash(fingerprint),
              let method = value["method"] as? String, ["captureSubmit", "captureCopilotSubmit", "captureLinesSubmit"].contains(method),
              let capture = value["capture"] as? [String: Any],
              let selected = value["requestFingerprint"] as? String, hash(selected),
              selected == (try digest(Data(encoded(capture).utf8))) else { throw NativeShareError.invalidInput }
        let payload = method == "captureCopilotSubmit" ? capture["capture"] as? [String: Any] : capture
        guard let payload, (method == "captureLinesSubmit" ? (payload["captureIds"] as? [String])?.first == id : payload["captureId"] as? String == id) else {
            throw NativeShareError.invalidInput
        }
        return value
    }
    static func plan(_ raw: String) throws -> [String: Any] {
        let value = try object(raw)
        guard Set(value.keys) == Set(["version", "request", "capture"]), let version = value["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1, version.doubleValue == 1,
              let selected = value["request"] as? [String: Any], let capture = value["capture"] as? [String: Any],
              Set(capture.keys) == Set(["request", "prepared"]), capture["prepared"] is [String: Any] else { throw NativeShareError.invalidInput }
        let checked = try request(encoded(selected))
        guard let actual = capture["request"], let expected = checked["capture"],
              try encoded(actual) == encoded(expected) else { throw NativeShareError.invalidInput }
        return value
    }
    private static func hash(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
}
