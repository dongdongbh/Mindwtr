import CryptoKit
import Darwin
import Foundation

public struct MindwtrWatchPendingCommand: Sendable {
    public let name: String
    public let body: String
    let directory: URL
    let proof: MindwtrWatchFileProof

    static func read(directory: URL, name: String) throws -> Self {
        guard name.hasSuffix(".json"), let id = UUID(uuidString: String(name.dropLast(5))),
              id.uuidString.lowercased() + ".json" == name,
              let file = try MindwtrWatchFileProof.read(directory: directory, name: name, maximumBytes: 32 * 1024),
              let body = String(data: file.bytes, encoding: .utf8) else { throw MindwtrWatchFileProof.unavailable }
        return Self(name: name, body: body, directory: directory, proof: file.proof)
    }

    func validate() throws { try proof.validate(directory: directory, name: name, maximumBytes: 32 * 1024) }

    func retire(beforeRemoval: () throws -> Void = {}) throws {
        try proof.retire(directory: directory, name: name, maximumBytes: 32 * 1024, beforeRemoval: beforeRemoval)
    }
}

struct MindwtrWatchFileProof: Codable, Equatable, Sendable {
    struct Generation: Codable, Equatable, Sendable {
        let device: Int64, inode: UInt64, size: Int64
        let modifiedSeconds: Int64, modifiedNanos: Int64, changedSeconds: Int64, changedNanos: Int64
        init(_ value: stat) {
            device = Int64(value.st_dev); inode = UInt64(value.st_ino); size = Int64(value.st_size)
            modifiedSeconds = Int64(value.st_mtimespec.tv_sec); modifiedNanos = Int64(value.st_mtimespec.tv_nsec)
            changedSeconds = Int64(value.st_ctimespec.tv_sec); changedNanos = Int64(value.st_ctimespec.tv_nsec)
        }
    }
    let directoryDevice: Int64
    let directoryInode: UInt64
    let generation: Generation
    let digest: String
    static var unavailable: CocoaError { CocoaError(.fileReadCorruptFile) }

    static func read(directory: URL, name: String, maximumBytes: Int,
                     afterRead: () throws -> Void = {}) throws -> (bytes: Data, proof: Self)? {
        try withParent(directory) { parent, parentInfo in
            guard let read = try read(parent: parent, name: name, maximumBytes: maximumBytes, afterRead: afterRead) else { return nil }
            return (read.0, Self(directoryDevice: Int64(parentInfo.st_dev), directoryInode: UInt64(parentInfo.st_ino),
                                 generation: read.1, digest: SHA256.hash(data: read.0).map { String(format: "%02x", $0) }.joined()))
        }
    }

    func validate(directory: URL, name: String, maximumBytes: Int) throws {
        guard let current = try Self.read(directory: directory, name: name, maximumBytes: maximumBytes),
              current.proof == self else { throw Self.unavailable }
    }

    func validateForRetirement(directory: URL, name: String, maximumBytes: Int) throws {
        try Self.withParent(directory) { parent, info in
            guard Int64(info.st_dev) == directoryDevice, UInt64(info.st_ino) == directoryInode else { throw Self.unavailable }
            if let current = try Self.read(parent: parent, name: name, maximumBytes: maximumBytes) {
                guard current.1 == generation,
                      SHA256.hash(data: current.0).map({ String(format: "%02x", $0) }).joined() == digest else { throw Self.unavailable }
            }
        }
    }

    func retire(directory: URL, name: String, maximumBytes: Int, beforeRemoval: () throws -> Void = {}) throws {
        try Self.withParent(directory) { parent, parentInfo in
            guard Int64(parentInfo.st_dev) == directoryDevice, UInt64(parentInfo.st_ino) == directoryInode else { throw Self.unavailable }
            let current = try Self.read(parent: parent, name: name, maximumBytes: maximumBytes)
            if let current {
                guard current.1 == generation,
                      SHA256.hash(data: current.0).map({ String(format: "%02x", $0) }).joined() == digest else { throw Self.unavailable }
            }
            try beforeRemoval()
            try Self.requireParent(directory, matches: parentInfo)
            if current != nil {
                var named = stat()
                guard fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                      Generation(named) == generation, named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1,
                      unlinkat(parent, name, 0) == 0 else { throw Self.unavailable }
            } else {
                var named = stat()
                guard fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw Self.unavailable }
            }
            guard fsync(parent) == 0 else { throw Self.unavailable }
        }
    }

    private static func withParent<T>(_ directory: URL, _ body: (Int32, stat) throws -> T) throws -> T {
        let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw unavailable }; defer { close(parent) }
        var info = stat(); guard fstat(parent, &info) == 0 else { throw unavailable }
        let result = try body(parent, info)
        try requireParent(directory, matches: info)
        return result
    }

    private static func requireParent(_ directory: URL, matches original: stat) throws {
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw unavailable }; defer { close(fd) }
        var named = stat()
        guard fstat(fd, &named) == 0, named.st_dev == original.st_dev, named.st_ino == original.st_ino else { throw unavailable }
    }

    private static func read(parent: Int32, name: String, maximumBytes: Int,
                             afterRead: () throws -> Void = {}) throws -> (Data, Generation)? {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else { throw unavailable }
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw unavailable }
        defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_size > 0, before.st_size <= maximumBytes else { throw unavailable }
        var buffer = [UInt8](repeating: 0, count: Int(before.st_size) + 1), count = 0
        while count < buffer.count {
            let size = buffer.count - count
            let result = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: count), size) }
            if result < 0 { if errno == EINTR { continue }; throw unavailable }
            if result == 0 { break }
            count += result
        }
        try afterRead()
        var after = stat(), named = stat()
        guard count == before.st_size, fstat(fd, &after) == 0, fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
              Generation(before) == Generation(after), Generation(before) == Generation(named),
              named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1 else { throw unavailable }
        return (Data(buffer.prefix(count)), Generation(before))
    }
}
