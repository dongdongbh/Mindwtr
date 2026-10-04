import Foundation
import Darwin

/// The bridge exposes operations, never paths. All names below are host-owned.
/// Shared core owns logging policy, sanitization, rotation and serialization.
final class NativeDiagnosticsLogFile {
    private let root: URL
    var mainURL: URL { root.appendingPathComponent("logs", isDirectory: true).appendingPathComponent("mindwtr.log") }
    #if DEBUG
    var beforeOperation: ((String) throws -> Void)?
    var beforeReplace: (() throws -> Void)?
    #endif

    init(libraryRoot: URL) {
        root = Self.normalizingSystemVarAlias(libraryRoot)
    }

    private static func normalizingSystemVarAlias(_ url: URL) -> URL {
        // Normalize only this verified OS alias, never a library-owned link.
        if url.pathComponents.dropFirst().first == "var",
           let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
           ["private/var", "/private/var"].contains(destination) {
            return URL(fileURLWithPath: "/private" + url.path, isDirectory: true)
        }
        return url
    }

    func perform(_ operation: String, text: String) throws -> String {
        guard ["path", "ensure", "exists", "read", "write", "delete", "append", "size", "moveAside", "isAbsent"].contains(operation),
              ["write", "append"].contains(operation) || text.isEmpty else { throw failure() }
        #if DEBUG
        try beforeOperation?(operation)
        #endif
        let directory = try logs(create: ["ensure", "write", "append"].contains(operation))
        guard directory >= 0 else {
            switch operation {
            case "path": return mainURL.absoluteString
            case "exists", "delete": return ""
            case "isAbsent": return "1"
            default: throw failure()
            }
        }
        defer { Darwin.close(directory) }
        let kind = try entry(directory, "mindwtr.log")
        switch operation {
        case "path": return mainURL.absoluteString
        case "exists": return kind == .regular ? "1" : ""
        case "isAbsent": return kind == .absent ? "1" : ""
        case "ensure":
            guard kind != .other else { throw failure() }
            if kind == .absent {
                let fd = Darwin.openat(directory, "mindwtr.log", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
                guard fd >= 0 else { throw failure() }
                guard Darwin.close(fd) == 0 else { throw failure() }
            }
            return mainURL.absoluteString
        case "read":
            let fd = try openRegular(directory, "mindwtr.log", O_RDONLY)
            defer { Darwin.close(fd) }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 16_384)
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count == 0 { break }
                if count < 0 { if errno == EINTR { continue }; throw failure() }
                data.append(contentsOf: buffer.prefix(count))
            }
            guard let value = String(data: data, encoding: .utf8) else { throw failure() }
            return value
        case "size":
            let fd = try openRegular(directory, "mindwtr.log", O_RDONLY)
            defer { Darwin.close(fd) }
            var info = stat()
            guard Darwin.fstat(fd, &info) == 0, info.st_size >= 0 else { throw failure() }
            return String(info.st_size)
        case "append":
            // Shared rotation may have just moved an unreadable main aside.
            guard kind != .other else { throw failure() }
            let fd = try openRegular(directory, "mindwtr.log", O_WRONLY | O_APPEND | O_CREAT)
            defer { Darwin.close(fd) }
            try writeAll(Data(text.utf8), fd)
            return ""
        case "write":
            guard kind != .other, try entry(directory, "mindwtr.log.partial") != .other else { throw failure() }
            let fd = Darwin.openat(directory, "mindwtr.log.partial", O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
            guard fd >= 0 else { throw failure() }
            var closed = false
            defer { if !closed { Darwin.close(fd) } }
            var info = stat()
            guard Darwin.fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw failure() }
            try writeAll(Data(text.utf8), fd)
            guard Darwin.fsync(fd) == 0 else { throw failure() }
            let closeResult = Darwin.close(fd)
            closed = true
            guard closeResult == 0 else { throw failure() }
            #if DEBUG
            try beforeReplace?()
            #endif
            guard try entry(directory, "mindwtr.log") != .other,
                  Darwin.renameat(directory, "mindwtr.log.partial", directory, "mindwtr.log") == 0 else { throw failure() }
            return ""
        case "delete":
            guard kind == .regular else { return "" }
            guard Darwin.unlinkat(directory, "mindwtr.log", 0) == 0 else {
                if errno == ENOENT { return "" }
                throw failure()
            }
            return "1"
        case "moveAside":
            guard kind == .regular, try entry(directory, "mindwtr.log.unreadable") != .other,
                  Darwin.renameat(directory, "mindwtr.log", directory, "mindwtr.log.unreadable") == 0 else { throw failure() }
            return ""
        default: throw failure()
        }
    }

    func validatedShareURL(_ path: String) throws -> URL {
        guard Array(path.utf8) == Array(mainURL.absoluteString.utf8),
              try perform("exists", text: "") == "1" else { throw failure() }
        return mainURL
    }

    private enum Entry { case absent, regular, other }
    private func entry(_ directory: Int32, _ name: String) throws -> Entry {
        var info = stat()
        if Darwin.fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return .absent }
            throw failure()
        }
        // A symlink is present, but cannot be read, overwritten or shared.
        guard info.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK) else { throw failure() }
        return info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) ? .regular : .other
    }

    private func logs(create: Bool) throws -> Int32 {
        // iOS permits opening its own container, but denies reading ancestors
        // such as /private/var. Trust only the OS-provided home as the anchor;
        // every library-owned component below it still uses O_NOFOLLOW.
        let home = Self.normalizingSystemVarAlias(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        let components = root.pathComponents
        let homeComponents = home.pathComponents
        guard !components.contains(".."), !components.contains(".") else { throw failure() }
        let insideHome = components.count >= homeComponents.count
            && zip(components, homeComponents).allSatisfy { Array($0.utf8) == Array($1.utf8) }
        let anchor = insideHome ? home.path : "/"
        let prefixCount = insideHome ? homeComponents.count : 1
        var current = Darwin.open(anchor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard current >= 0 else { throw failure() }
        for component in components.dropFirst(prefixCount) {
            let next = Darwin.openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let code = errno
            Darwin.close(current)
            guard next >= 0 else {
                if !create && code == ENOENT { return -1 }
                throw failure()
            }
            current = next
        }
        defer { Darwin.close(current) }
        if create {
            if Darwin.mkdirat(current, "logs", mode_t(0o700)) != 0 && errno != EEXIST { throw failure() }
        }
        let result = Darwin.openat(current, "logs", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard result >= 0 else {
            if !create && errno == ENOENT { return -1 }
            throw failure()
        }
        return result
    }

    private func openRegular(_ directory: Int32, _ name: String, _ flags: Int32) throws -> Int32 {
        let fd = Darwin.openat(directory, name, flags | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw failure() }
        var info = stat()
        guard Darwin.fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
            Darwin.close(fd)
            throw failure()
        }
        return fd
    }

    private func writeAll(_ data: Data, _ fd: Int32) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure() }
                offset += count
            }
        }
    }

    private func failure() -> HostFailure { HostFailure("Diagnostics file operation unavailable") }
}
