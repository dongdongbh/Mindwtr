import Foundation
import UniformTypeIdentifiers

public enum NativeShareError: Error, Sendable { case unavailable, invalidInput, changedSource, full }

public struct NativeShareEnvelope: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public static let maximumBytes: Int64 = 50 * 1024 * 1024
        public let id: String
        public let name: String
        public let mimeType: String
        public let size: Int64
        public let sha256: String

        public init(id: UUID = UUID(), name: String, mimeType: String, size: Int64, sha256: String) throws {
            self.id = id.uuidString.lowercased(); self.name = name; self.mimeType = mimeType; self.size = size; self.sha256 = sha256
            try validate()
        }
        public var managedFileName: String {
            let query = name.split(separator: "?", omittingEmptySubsequences: false).first ?? ""
            let fragment = query.split(separator: "#", omittingEmptySubsequences: false).first ?? ""
            let leaf = fragment.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? ""
            guard let dot = leaf.lastIndex(of: ".") else { return id }
            let suffix = leaf[leaf.index(after: dot)...]
            guard (1...8).contains(suffix.count), suffix.unicodeScalars.allSatisfy({ $0.isASCII && CharacterSet.alphanumerics.contains($0) }) else { return id }
            return id + "." + suffix.lowercased()
        }
        func validate() throws {
            guard UUID(uuidString: id)?.uuidString.lowercased() == id,
                  !name.isEmpty, name.utf16.count <= 1024, !name.contains("/"), !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  !mimeType.isEmpty, mimeType.utf8.count <= 255, mimeType.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
                  (0...Self.maximumBytes).contains(size),
                  sha256.utf8.count == 64, sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw NativeShareError.invalidInput
            }
        }
    }
    public static let maximumBytes = 240 * 1024
    public static let textLimit = 50_000, subjectLimit = 10_000, webURLLimit = 16_000
    public static let fileLimit = 6
    public let version: Int
    public let id: String
    public let receivedAtMs: Int64
    public let subject: String?
    public let text: String?
    public let webUrl: String?
    public let files: [File]?
    public let skippedFiles: Int?

    public init(id: UUID = UUID(), receivedAt: Date = Date(), subject: String?, text: String?, webUrl: String?,
                files: [File]? = nil, skippedFiles: Int? = nil) throws {
        let clock = floor(receivedAt.timeIntervalSince1970 * 1000)
        guard clock.isFinite, abs(clock) <= 8_640_000_000_000_000 else { throw NativeShareError.invalidInput }
        let carriesFiles = files != nil || skippedFiles != nil
        version = carriesFiles ? 2 : 1; self.id = id.uuidString.lowercased(); receivedAtMs = Int64(clock)
        self.subject = subject; self.text = text; self.webUrl = webUrl
        self.files = carriesFiles ? files ?? [] : nil; self.skippedFiles = carriesFiles ? skippedFiles ?? 0 : nil
        try validate()
        _ = try encoded()
    }

    public var sharedFiles: [File] { files ?? [] }

    func validate() throws {
        let fileShape: Bool
        switch version {
        case 1: fileShape = files == nil && skippedFiles == nil
        case 2:
            fileShape = files.map { $0.count <= Self.fileLimit && Set($0.map(\.id)).count == $0.count && !$0.contains { $0.id == id } } == true
                && skippedFiles.map { (0...64).contains($0) } == true
        default: fileShape = false
        }
        guard fileShape, UUID(uuidString: id)?.uuidString.lowercased() == id,
              abs(Double(receivedAtMs)) <= 8_640_000_000_000_000,
              subject.map({ $0.utf16.count <= Self.subjectLimit }) ?? true,
              text.map({ $0.utf16.count <= Self.textLimit }) ?? true,
              webUrl.map({ $0.utf16.count <= Self.webURLLimit }) ?? true,
              !sharedFiles.isEmpty || [subject, text, webUrl].contains(where: { $0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }) else {
            throw NativeShareError.invalidInput
        }
        try sharedFiles.forEach { try $0.validate() }
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

public enum NativeSharedFileRule {
    public static func fileType(_ registered: [String]) -> UTType? {
        let types = registered.compactMap { UTType($0) }
        for target in [UTType.image, .movie, .fileURL, .pdf] {
            if let match = types.first(where: { $0.conforms(to: target) }) { return match }
        }
        guard !types.contains(where: { $0.conforms(to: .url) || $0.conforms(to: .plainText) }) else { return nil }
        return types.first { $0.conforms(to: .data) }
    }
    public static func name(original: URL, suggested: String?, type: UTType) -> (name: String, mimeType: String) {
        let fileExtension = original.pathExtension.isEmpty ? type.preferredFilenameExtension ?? "" : original.pathExtension
        var name = original.lastPathComponent
        if let suggested, !suggested.isEmpty, !type.conforms(to: .fileURL) {
            name = (suggested as NSString).pathExtension.isEmpty && !fileExtension.isEmpty ? suggested + "." + fileExtension : suggested
        }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: name.replacingOccurrences(of: "/", with: "-").unicodeScalars.filter { $0.value >= 32 && $0.value != 127 }.prefix(255))
        name = String(scalars)
        if name.isEmpty { name = "Shared file" + (fileExtension.isEmpty ? "" : "." + fileExtension) }
        let mimeType = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType
            ?? type.preferredMIMEType ?? "application/octet-stream"
        return (name, mimeType)
    }
}
