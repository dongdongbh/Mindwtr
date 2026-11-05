import Darwin
import Foundation

final class NativeGmailReceiptFiles {
    private static let names = try! NSRegularExpression(pattern: #"^(receipts(\.corrupt-[0-9]+)?\.sqlite(-wal|-shm|-journal)?|receipts-reset)$"#)
    private static let databases = try! NSRegularExpression(pattern: #"^receipts(\.corrupt-[0-9]+)?\.sqlite$"#)
    private let folder: URL
    private var open: [String: SQLiteBridge] = [:]

    init(folder: URL) { self.folder = folder }

    private static func matches(_ pattern: NSRegularExpression, _ name: String) -> Bool {
        pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }

    private func named(_ name: String) throws -> URL {
        guard Self.matches(Self.names, name) else { throw HostFailure("Not a Gmail receipts file") }
        return folder.appendingPathComponent(name, isDirectory: false)
    }

    private func info(_ url: URL) -> stat? {
        var value = stat()
        return lstat(url.path, &value) == 0 ? value : nil
    }

    func file(_ op: String, name: String, to: String) throws -> String {
        if op == "list" {
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
            let listed = entries.filter { Self.matches(Self.names, $0) }.sorted()
            return String(decoding: try JSONSerialization.data(withJSONObject: listed), as: UTF8.self)
        }
        let url = try named(name)
        switch op {
        case "exists":
            return info(url) == nil ? "false" : "true"
        case "size":
            guard let value = info(url) else { return "0" }
            guard value.st_mode & S_IFMT == S_IFREG else { throw HostFailure("Not a Gmail receipts file") }
            return String(value.st_size)
        case "create":
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let fd = Darwin.open(url.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw HostFailure("The file exists") }
            defer { Darwin.close(fd) }
            guard fsync(fd) == 0 else { throw HostFailure("The file was not created") }
        case "rename":
            let target = try named(to)
            guard renamex_np(url.path, target.path, UInt32(RENAME_EXCL)) == 0 else { throw HostFailure("The file was not renamed") }
        case "remove":
            guard unlink(url.path) == 0 || errno == ENOENT else { throw HostFailure("The file was not removed") }
        case "open":
            guard Self.matches(Self.databases, name), let value = info(url), value.st_mode & S_IFMT == S_IFREG else {
                throw HostFailure("Not a Gmail receipts database")
            }
            open.removeValue(forKey: name)?.close()
            open[name] = try SQLiteBridge(url: url)
        case "close":
            open.removeValue(forKey: name)?.close()
        default:
            throw HostFailure("Unsupported Gmail receipts call")
        }
        return ""
    }

    func sql(name: String, sql: String, parametersJSON: String) throws -> String {
        guard Self.matches(Self.databases, name), let connection = open[name] else { throw HostFailure("The Gmail receipts file is not open") }
        return try connection.execute(sql, parametersJSON: parametersJSON)
    }

    func close() {
        open.values.forEach { $0.close() }
        open.removeAll()
    }
}
