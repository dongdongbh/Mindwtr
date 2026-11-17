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
    static func makeRequest(_ envelope: NativeShareEnvelope, method: String, requestJSON: String, attachmentsJSON: String? = nil) throws -> String {
        let capture = try object(requestJSON), source = try object(identity(envelope))
        var request: [String: Any] = ["source": source, "method": method, "requestFingerprint": digest(Data(try encoded(capture).utf8)), "capture": capture]
        if let attachmentsJSON {
            guard let attachments = try NativeJSON.jsonObject(with: Data(attachmentsJSON.utf8)) as? [[String: Any]], self.attachments(attachments),
                  attachments.allSatisfy({ attachment in envelope.sharedFiles.contains { file in
                      attachment["id"] as? String == file.id && attachment["fileHash"] as? String == file.sha256
                          && (attachment["size"] as? NSNumber)?.int64Value == file.size } }) else { throw NativeShareError.invalidInput }
            request["attachments"] = attachments
        }
        return try encoded(request)
    }
    private static func attachments(_ value: Any?) -> Bool {
        guard let list = value as? [[String: Any]], (1...NativeShareEnvelope.fileLimit).contains(list.count) else { return false }
        let ids = list.compactMap { $0["id"] as? String }
        return ids.count == list.count && Set(ids).count == ids.count && list.allSatisfy { $0["kind"] as? String == "file" }
    }
    static func request(_ raw: String) throws -> [String: Any] {
        let value = try object(raw)
        let fields: Set<String> = ["source", "method", "requestFingerprint", "capture"]
        guard Set(value.keys) == fields || Set(value.keys) == fields.union(["attachments"]) && attachments(value["attachments"]),
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

extension NativeVoiceFiles {
    func materializeShareFile(source: URL, targetURI: String, sha256: String, size: Int64) throws {
        guard let target = URL(string: targetURI), target.isFileURL,
              target.deletingLastPathComponent().standardizedFileURL.path == managedRoot.standardizedFileURL.path else { throw NativeShareError.invalidInput }
        if let existing = try? installer.handle(NativeShareCaptureJSON.encoded(["op": "hash", "path": targetURI])) {
            let value = try NativeShareCaptureJSON.object(existing)
            guard value["sha256"] as? String == sha256, (value["size"] as? NSNumber)?.int64Value == size else { throw NativeShareError.changedSource }
            return
        }
        let receipt = try files.copyProviderSource(source, checkCancellation: {})
        defer { _ = try? files.retireProviderSource(receipt, checkCancellation: {}) }
        let proof = try files.snapshotCacheSource(receipt.sourceURI)
        guard receipt.matches(proof), proof.sha256 == sha256, proof.size == size else { throw NativeShareError.changedSource }
        var state = NativeVoiceFileSettlement(source: .init(proof), targetURI: targetURI,
            operationID: UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""), stage: nil)
        state.stage = try reserve(state)
        defer { retireStage(state) }
        try publish(state)
        try verify(state)
    }
    func discardShareFile(_ uri: String) throws {
        guard let target = URL(string: uri), target.isFileURL,
              target.deletingLastPathComponent().standardizedFileURL.path == managedRoot.standardizedFileURL.path else { throw NativeShareError.invalidInput }
        try files.deleteNow(uri)
    }
}
