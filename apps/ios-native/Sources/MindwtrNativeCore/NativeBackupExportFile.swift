import Foundation
import Darwin

public enum NativeBackupFormat: String, Sendable { case json, csv, tasknotes }

public struct NativeBackupExport: Sendable, Identifiable {
    public let id: UUID
    public let url: URL
}

/// Each share owns a different file. A later export never replaces bytes being shared.
/// All filesystem names except the strictly checked core filename are native-owned.
final class NativeBackupExportFile {
    private let root: URL
    private var owned: [UUID: (parent: Int32, directory: Int32, name: String)] = [:]
    #if DEBUG
    var beforeWrite: (() throws -> Void)?
    #endif

    init(libraryRoot: URL) { root = Self.normalized(libraryRoot) }

    deinit { for id in Array(owned.keys) { discard(id) } }

    func prepare(fileName: String, content: String) throws -> NativeBackupExport {
        try prepare(fileName: fileName, bytes: Data(content.utf8))
    }

    func prepare(fileName: String, bytes: Data) throws -> NativeBackupExport {
        guard Self.isBackupName(fileName) else { throw failure() }
        let parent = try openRoot()
        let id = UUID()
        let directoryName = "backup-export-" + id.uuidString.lowercased()
        guard Darwin.mkdirat(parent, directoryName, mode_t(0o700)) == 0 else {
            Darwin.close(parent); throw failure()
        }
        let directory = Darwin.openat(parent, directoryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else {
            Darwin.unlinkat(parent, directoryName, AT_REMOVEDIR)
            Darwin.close(parent); throw failure()
        }
        owned[id] = (parent, directory, fileName)
        var completed = false
        defer { if !completed { discard(id) } }
        var directoryURL = root.appendingPathComponent(directoryName, isDirectory: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try directoryURL.setResourceValues(resourceValues)
        let fd = Darwin.openat(directory, fileName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw failure() }
        var closed = false
        defer { if !closed { Darwin.close(fd) } }
        #if DEBUG
        try beforeWrite?()
        #endif
        try bytes.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure() }
                offset += count
            }
        }
        guard Darwin.fsync(fd) == 0 else { throw failure() }
        let result = Darwin.close(fd)
        closed = true
        guard result == 0 else { throw failure() }
        completed = true
        return NativeBackupExport(id: id, url: directoryURL.appendingPathComponent(fileName))
    }

    func discard(_ id: UUID) {
        guard let file = owned.removeValue(forKey: id) else { return }
        // Never recurse or follow links, including on a failed write.
        Darwin.unlinkat(file.directory, file.name, 0)
        Darwin.close(file.directory)
        Darwin.unlinkat(file.parent, "backup-export-" + id.uuidString.lowercased(), AT_REMOVEDIR)
        Darwin.close(file.parent)
    }

    /// Startup only, after CoreHost has acquired this library's exclusive host lock.
    /// An interrupted share cannot still have a live owner at that point.
    func discardInterruptedExports() throws {
        guard owned.isEmpty else { return }
        let parent = try openRoot()
        defer { Darwin.close(parent) }
        for name in try names(parent) where name.hasPrefix("backup-export-") {
            let suffix = String(name.dropFirst("backup-export-".count))
            guard let id = UUID(uuidString: suffix), id.uuidString.lowercased() == suffix else { continue }
            let directory = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directory >= 0 else { continue }
            defer { Darwin.close(directory) }
            let children = try names(directory)
            // Refuse unknown content; never recurse, follow a link, or remove another file family.
            guard children.allSatisfy({ Self.isBackupName($0) }), children.allSatisfy({ child in
                var info = stat()
                return Darwin.fstatat(directory, child, &info, AT_SYMLINK_NOFOLLOW) == 0
                    && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
            }) else { continue }
            for child in children { _ = Darwin.unlinkat(directory, child, 0) }
            _ = Darwin.unlinkat(parent, name, AT_REMOVEDIR)
        }
    }

    private static func isBackupName(_ name: String) -> Bool {
        name.range(of: #"\Amindwtr-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z(?:\.(json|csv)|-tasknotes\.zip)\z"#,
                   options: .regularExpression) != nil
    }

    private func names(_ fd: Int32) throws -> [String] {
        let copied = Darwin.dup(fd)
        guard copied >= 0 else { throw failure() }
        guard let stream = Darwin.fdopendir(copied) else { Darwin.close(copied); throw failure() }
        defer { Darwin.closedir(stream) }
        var result: [String] = []
        while true {
            errno = 0
            guard let entry = Darwin.readdir(stream) else {
                guard errno == 0 else { throw failure() }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name != "." && name != ".." { result.append(name) }
        }
        return result
    }

    private static func normalized(_ url: URL) -> URL {
        if url.pathComponents.dropFirst().first == "var",
           let target = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
           ["private/var", "/private/var"].contains(target) {
            return URL(fileURLWithPath: "/private" + url.path, isDirectory: true)
        }
        return url
    }

    private func openRoot() throws -> Int32 {
        let home = Self.normalized(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        let parts = root.pathComponents
        let homeParts = home.pathComponents
        guard !parts.contains("."), !parts.contains("..") else { throw failure() }
        let inside = parts.count >= homeParts.count
            && zip(parts, homeParts).allSatisfy { Array($0.utf8) == Array($1.utf8) }
        var fd = Darwin.open(inside ? home.path : "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw failure() }
        for part in parts.dropFirst(inside ? homeParts.count : 1) {
            let next = Darwin.openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(fd)
            guard next >= 0 else { throw failure() }
            fd = next
        }
        return fd
    }

    private func failure() -> HostFailure { HostFailure("Backup file operation unavailable") }
}
