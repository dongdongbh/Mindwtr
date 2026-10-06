import Foundation
import Darwin
import CryptoKit
import CoreFoundation
import UniformTypeIdentifiers

enum NativeAttachmentFilesError: LocalizedError, Equatable {
    case invalidRequest, unavailable, missing, tooLarge, providerTooLarge
    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Attachment file request is invalid"
        case .unavailable: return "Attachment file operation is unavailable"
        case .missing: return "ENOENT: no such file or directory"
        case .tooLarge: return "Attachment file exceeds the bridge byte limit"
        case .providerTooLarge: return "Attachment file exceeds the upload byte limit"
        }
    }
}

/// Platform IO only. The library owner serializes calls and same-turn deletion;
/// shared core continues to own attachment persistence, cleanup and sync policy.
final class NativeAttachmentFiles {
    struct Reply { let value: Any?; let bytes: Data? }
    struct CacheSourceProof: Sendable {
        let sourceURI: String
        let sha256: String
        let size: Int64
        let identity: String
        let cacheRootIdentity: String
        let parentIdentity: String
    }
    /// Creation authority is minted here, never decoded from a borrowed proof.
    struct ProviderCacheCopyReceipt: Sendable {
        fileprivate let proof: CacheSourceProof
        fileprivate let modificationSeconds: Int64
        fileprivate let modificationNanoseconds: Int64
        fileprivate let changeSeconds: Int64
        fileprivate let changeNanoseconds: Int64
        fileprivate let mode: mode_t
        let fileName: String
        let mimeType: String?
        var sourceURI: String { proof.sourceURI }
        var size: Int64 { proof.size }
        fileprivate init(proof: CacheSourceProof, generation: stat, fileName: String, mimeType: String?) {
            self.proof = proof; self.fileName = fileName; self.mimeType = mimeType
            modificationSeconds = Int64(generation.st_mtimespec.tv_sec)
            modificationNanoseconds = Int64(generation.st_mtimespec.tv_nsec)
            changeSeconds = Int64(generation.st_ctimespec.tv_sec)
            changeNanoseconds = Int64(generation.st_ctimespec.tv_nsec); mode = generation.st_mode
        }
        func matches(_ source: CacheSourceProof) -> Bool {
            proof.sourceURI == source.sourceURI && proof.sha256 == source.sha256 && proof.size == source.size
                && proof.identity == source.identity && proof.cacheRootIdentity == source.cacheRootIdentity
                && proof.parentIdentity == source.parentIdentity
        }
    }
    struct ReservedAttachmentStageProof: Sendable {
        let stageURI: String
        let stagedIdentity: String
        let directoryIdentity: String
        let privateDirectoryIdentity: String
    }
    struct AttachmentStageContent: Sendable, Equatable {
        let sha256: String
        let size: Int64
    }
    struct PublishedAttachmentProof: Sendable, Equatable {
        let sha256: String
        let size: Int64
        let identity: String
        let directoryIdentity: String
    }
    enum PublishedAttachmentRetirementOutcome: Sendable, Equatable { case removed, absent }
    enum BaselineAttachmentRetirementOutcome: String, Sendable, Equatable {
        case removed, absent, generationChanged, unsafeEntry
    }
    /// Current eligible managed generation, separate from Add publication proof.
    struct BaselineAttachmentProof: Sendable, Equatable {
        let targetURI: String
        let sha256: String
        let size: Int64
        let identity: String
        let directoryIdentity: String
    }
    enum BaselineAttachmentAbsence: Sendable, Equatable {
        case leafAbsent(directoryIdentity: String)
        case managedDirectoryAbsent(documentsIdentity: String)
    }
    /// No case grants deletion or domain authority. In particular an absent
    /// observation must never adopt a generation which appears afterward.
    enum BaselineAttachmentObservation: Sendable, Equatable {
        case present(BaselineAttachmentProof)
        case noOwnedGeneration(targetURI: String, absence: BaselineAttachmentAbsence)
        case unmanaged(targetURI: String)
        case unsafeEntry(targetURI: String)
    }
    static let maximumBytes = 16 * 1024 * 1024
    static let maximumProviderBytes: Int64 = 50 * 1024 * 1024
    private static let chunkBytes = 64 * 1024
    private let libraryRoot: URL
    private let documents: URL
    private let cache: URL
    private let libraryIdentity: Identity
    private let namespaceIdentity: Identity
    private let documentsIdentity: Identity
    private let cacheIdentity: Identity

    var managedRoot: URL { documents.appendingPathComponent("attachments", isDirectory: true) }
    var sourceRoots: [URL] { [documents, cache] }
    var directoriesJSON: String {
        // URLs are native-owned strings; JSON serialization cannot fail.
        let object = ["document": documents.absoluteString, "cache": cache.absoluteString]
        return String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
    #if DEBUG
    var beforeProviderOutputNamedStat: ((Bool) throws -> Void)?
    var afterSourceOpened: (() throws -> Void)?
    var beforePublish: (() throws -> Void)?
    var beforeStageSync: (() throws -> Void)?
    var beforeRetirementUnlink: (() throws -> Void)?
    var afterRetirementUnlink: (() throws -> Void)?
    var beforeRetirementSync: (() throws -> Void)?
    #endif

    init(libraryRoot: URL) throws {
        guard libraryRoot.isFileURL else { throw NativeAttachmentFilesError.invalidRequest }
        let path = try Self.filePath(libraryRoot.absoluteString)
        let root = URL(fileURLWithPath: path, isDirectory: true)
        let ownerURL = root.appendingPathComponent("attachment-files", isDirectory: true)
        self.libraryRoot = root
        documents = ownerURL.appendingPathComponent("documents", isDirectory: true)
        cache = ownerURL.appendingPathComponent("cache", isDirectory: true)
        let library: Int32
        do { library = try Self.openAbsoluteDirectory(path) }
        catch { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(library) }
        libraryIdentity = try Self.identity(library)
        let owner = try Self.childDirectory(library, "attachment-files", create: true)
        defer { Darwin.close(owner) }
        namespaceIdentity = try Self.identity(owner)
        let documentFD = try Self.childDirectory(owner, "documents", create: true)
        defer { Darwin.close(documentFD) }
        documentsIdentity = try Self.identity(documentFD)
        let cacheFD = try Self.childDirectory(owner, "cache", create: true)
        defer { Darwin.close(cacheFD) }
        cacheIdentity = try Self.identity(cacheFD)
    }

    func call(_ json: String, checkCancellation: () throws -> Void = {}) throws -> Reply {
        guard json.utf8.count <= 24 * 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let request = object as? [String: Any], let op = request["op"] as? String else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let fields: [String]
        switch op {
        case "barrier": fields = ["op"]
        case "sha256": fields = ["op", "base64"]
        case "writeBytes": fields = ["op", "uri", "base64"]
        case "copy", "move": fields = ["op", "uri", "to"]
        case "readBytesRange": fields = ["op", "uri", "position", "length"]
        case "getInfo", "makeDirectory", "readDirectory", "readBytes", "delete", "syncParent", "sha256File":
            fields = ["op", "uri"]
        default: throw NativeAttachmentFilesError.invalidRequest
        }
        guard Set(request.keys) == Set(fields), ["writeBytes", "sha256"].contains(op) || json.utf8.count <= 64 * 1024 else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        try checkCancellation()
        if op == "barrier" { return Reply(value: nil, bytes: nil) }
        if op == "sha256" {
            let bytes = try Self.decodeBytes(request["base64"])
            try checkCancellation()
            return Reply(value: Self.digest(bytes), bytes: nil)
        }
        let path = try reference(request["uri"])
        switch op {
        case "getInfo": return Reply(value: try info(path), bytes: nil)
        case "makeDirectory":
            let directory = try openDirectory(path, create: true)
            defer { Darwin.close(directory) }
            let named = try openDirectory(path); defer { Darwin.close(named) }
            guard try Self.identity(directory) == Self.identity(named) else { throw NativeAttachmentFilesError.unavailable }
        case "readDirectory": return Reply(value: try list(path, checkCancellation: checkCancellation), bytes: nil)
        case "readBytes": return Reply(value: nil, bytes: try read(path, position: 0, length: nil, checkCancellation: checkCancellation))
        case "readBytesRange":
            let position = try Self.integer(request["position"]), length = try Self.integer(request["length"])
            guard length <= Self.maximumBytes else { throw NativeAttachmentFilesError.tooLarge }
            return Reply(value: nil, bytes: try read(path, position: position, length: length, checkCancellation: checkCancellation))
        case "writeBytes":
            let bytes = try Self.decodeBytes(request["base64"])
            try publish(path, checkCancellation: checkCancellation) { output in
                var offset = 0
                while offset < bytes.count {
                    try checkCancellation()
                    let end = min(bytes.count, offset + Self.chunkBytes)
                    try Self.write(output, bytes.subdata(in: offset..<end))
                    offset = end
                }
            }
        case "copy": try copy(path, to: reference(request["to"]), checkCancellation: checkCancellation)
        case "move": try move(path, to: reference(request["to"]), checkCancellation: checkCancellation)
        case "delete": try remove(path, directories: true, sync: true)
        case "syncParent":
            let parent = try openParent(path); defer { Darwin.close(parent.fd) }
            try verify(parent, path: path)
            guard Darwin.fsync(parent.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
        case "sha256File": return Reply(value: try hash(path, checkCancellation: checkCancellation), bytes: nil)
        default: throw NativeAttachmentFilesError.invalidRequest
        }
        return Reply(value: nil, bytes: nil)
    }

    /// Only one named regular file or symlink entry; folder durability is a
    /// separate file-thread syncParent call after the core ownership decision.
    func deleteNow(_ uri: String) throws { try remove(reference(uri), directories: false, sync: false) }

    // Matches readNativeAttachments' nonempty 500-character ID bound. Swift's
    // UTF-16 count preserves JS string-length semantics without a UUID grammar.
    static func validBaselineAttachmentID(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= 500 && !value.utf8.contains(0)
    }

    /// Captures a shared-selected baseline candidate's current local generation.
    /// This never creates directories, reads unmanaged targets, or retires bytes.
    func snapshotBaselineAttachment(attachmentID: String, targetURI: String,
                                    checkCancellation: () throws -> Void = {}) throws -> BaselineAttachmentObservation {
        guard Self.validBaselineAttachmentID(attachmentID), !targetURI.isEmpty,
              targetURI.utf8.count <= 16 * 1024, !targetURI.utf8.contains(0),
              let uri = URLComponents(string: targetURI), let scheme = uri.scheme, !scheme.isEmpty else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        func observed(_ value: BaselineAttachmentObservation) -> BaselineAttachmentObservation {
            NSLog("Native iOS attachment baseline file observed releaseCheck=v1.3.5/ios-baseline-file-observed outcome=observed")
            return value
        }
        try checkCancellation()
        // Cross-platform provider/remote records carry no native file authority.
        // Preserve the URI without attempting resolution or any target IO.
        guard scheme.lowercased() == "file" else { return observed(.unmanaged(targetURI: targetURI)) }
        guard let leaf = try baselineLeaf(attachmentID: attachmentID, targetURI: targetURI) else {
            return observed(.unmanaged(targetURI: targetURI))
        }
        let documentFD = try openRoot(false); defer { Darwin.close(documentFD) }
        let managedEntry = Parent(fd: documentFD, leaf: "attachments")
        func namedIfPresent(_ parent: Parent) throws -> stat? {
            do { return try Self.named(parent) }
            catch NativeAttachmentFilesError.missing { return nil }
        }
        func validateDocuments() throws {
            let named = try openRoot(false); defer { Darwin.close(named) }
            guard try Self.identity(documentFD) == documentsIdentity,
                  try Self.identity(named) == Self.identity(documentFD) else { throw NativeAttachmentFilesError.unavailable }
        }
        guard let entry = try namedIfPresent(managedEntry) else {
            func validateAbsence() throws {
                try validateDocuments()
                guard try namedIfPresent(managedEntry) == nil else { throw NativeAttachmentFilesError.unavailable }
            }
            try validateAbsence(); try checkCancellation(); try validateAbsence()
            return observed(.noOwnedGeneration(targetURI: targetURI,
                absence: .managedDirectoryAbsent(documentsIdentity: try Self.token(Self.identity(documentFD)))))
        }
        guard entry.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw NativeAttachmentFilesError.unavailable }
        let managedFD: Int32
        do { managedFD = try Self.childDirectory(documentFD, "attachments", create: false) }
        catch { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(managedFD) }
        guard try Self.identity(managedFD) == Identity(entry) else { throw NativeAttachmentFilesError.unavailable }
        let path = Reference(cache: false, components: ["attachments", leaf]), parent = Parent(fd: managedFD, leaf: leaf)
        func validateManaged() throws { try validateDocuments(); try verify(parent, path: path) }
        guard let named = try namedIfPresent(parent) else {
            func validateAbsence() throws {
                try validateManaged()
                guard try namedIfPresent(parent) == nil else { throw NativeAttachmentFilesError.unavailable }
            }
            try validateAbsence(); try checkCancellation(); try validateAbsence()
            return observed(.noOwnedGeneration(targetURI: targetURI,
                absence: .leafAbsent(directoryIdentity: try Self.token(Self.identity(managedFD)))))
        }
        if named.st_mode & mode_t(S_IFMT) != mode_t(S_IFREG) || named.st_nlink != 1 {
            func validateUnsafe() throws {
                try validateManaged()
                guard let current = try namedIfPresent(parent), Self.unchanged(named, current),
                      named.st_nlink == current.st_nlink else { throw NativeAttachmentFilesError.unavailable }
            }
            try validateUnsafe(); try checkCancellation(); try validateUnsafe()
            return observed(.unsafeEntry(targetURI: targetURI))
        }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        guard Self.unchanged(named, before), before.st_nlink == 1,
              before.st_size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.unavailable }
        func validatePresent() throws {
            try stable(fd, before: before, parent: parent, path: path)
            guard try Self.regular(fd).st_nlink == 1, try Self.named(parent).st_nlink == 1 else {
                throw NativeAttachmentFilesError.unavailable
            }
        }
        // Cancellation callbacks can mutate bytes and any ancestor. Compare
        // retained descriptors with the named tree on both sides of each call.
        func check() throws { try validatePresent(); try checkCancellation(); try validatePresent() }
        try check()
        let content = try hashContents(fd, checkCancellation: check)
        try check()
        guard content.size == before.st_size else { throw NativeAttachmentFilesError.unavailable }
        return observed(.present(.init(targetURI: targetURI, sha256: content.sha256, size: content.size,
            identity: Self.token(Identity(before)), directoryIdentity: try Self.token(Self.identity(managedFD)))))
    }

    private func baselineLeaf(attachmentID: String, targetURI: String) throws -> String? {
        let pathBytes = Array(try Self.filePath(targetURI).utf8), prefix = Array((managedRoot.path + "/").utf8)
        let leafBytes = Array(pathBytes.dropFirst(prefix.count))
        // Empty components cannot expand RN's exact flat ID-name admission.
        guard pathBytes.starts(with: prefix), !leafBytes.isEmpty, !leafBytes.contains(47),
              leafBytes == Array(attachmentID.utf8) || leafBytes.starts(with: Array((attachmentID + ".").utf8)) else { return nil }
        return String(decoding: leafBytes, as: UTF8.self)
    }

    /// Native-only evidence for a future durable copy intent, not editor ownership.
    /// Native Project Add captures the descriptor used by the actual directory
    /// creation; later pathname observations cannot substitute a replacement.
    func ensureManagedDirectoryProof(checkCancellation: () throws -> Void) throws -> String {
        try checkCancellation()
        let path = try reference(managedRoot.absoluteString)
        let directory = try openDirectory(path, create: true)
        defer { Darwin.close(directory) }
        try checkCancellation()
        let named = try openDirectory(path); defer { Darwin.close(named) }
        let identity = try Self.identity(directory)
        guard identity == (try Self.identity(named)) else { throw NativeAttachmentFilesError.unavailable }
        return Self.token(identity)
    }

    func copyProviderSource(_ selectedURL: URL, checkCancellation: () throws -> Void) throws -> ProviderCacheCopyReceipt {
        try copyProviderSource(selectedURL, photo: nil, checkCancellation: checkCancellation)
    }
    func copyPhotoProviderSource(_ selectedURL: URL, selection: NativeAttachmentPhotoSelection,
                                 checkCancellation: () throws -> Void) throws -> ProviderCacheCopyReceipt {
        try copyProviderSource(selectedURL, photo: selection, checkCancellation: checkCancellation)
    }
    private func copyProviderSource(_ selectedURL: URL, photo: NativeAttachmentPhotoSelection?,
                                    checkCancellation: () throws -> Void) throws -> ProviderCacheCopyReceipt {
        guard selectedURL.isFileURL else { throw NativeAttachmentFilesError.invalidRequest }
        _ = try Self.filePath(selectedURL.absoluteString)
        try checkCancellation()
        let accessed = selectedURL.startAccessingSecurityScopedResource()
        defer { if accessed { selectedURL.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var result: Result<ProviderCacheCopyReceipt, Error>?
        NSFileCoordinator().coordinate(readingItemAt: selectedURL, options: .withoutChanges, error: &coordinationError) { url in
            result = Result { try self.copyCoordinatedProviderSource(url, fallbackName: selectedURL.lastPathComponent, photo: photo,
                                                                   checkCancellation: checkCancellation) }
        }
        if coordinationError != nil {
            if let result, case .success(let receipt) = result { _ = try? retireProviderSource(receipt, checkCancellation: {}) }
            throw NativeAttachmentFilesError.unavailable
        }
        guard let result else { throw NativeAttachmentFilesError.unavailable }
        do { return try result.get() }
        catch is CancellationError { throw CancellationError() }
        catch let error as NativeAttachmentFilesError { throw error }
        catch { throw NativeAttachmentFilesError.unavailable }
    }

    private func copyCoordinatedProviderSource(_ url: URL, fallbackName: String, photo: NativeAttachmentPhotoSelection?,
                                             checkCancellation: () throws -> Void) throws -> ProviderCacheCopyReceipt {
        try checkCancellation()
        let sourcePath = try Self.filePath(url.absoluteString)
        let sourceURL = URL(fileURLWithPath: sourcePath)
        let sourceParentPath = sourceURL.deletingLastPathComponent().path
        // Provider scope can grant this file without parent-directory reads.
        // Parent metadata stays mandatory; every file open refuses all symlinks.
        func sourceParentIdentity() throws -> Identity {
            var value = stat()
            guard Darwin.lstat(sourceParentPath, &value) == 0 else { throw Self.failure() }
            guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw NativeAttachmentFilesError.unavailable }
            return Identity(value)
        }
        let parentIdentity = try sourceParentIdentity()
        func openSource() throws -> Int32 {
            let fd = Darwin.open(sourcePath, O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw Self.failure() }
            do { _ = try Self.regular(fd); return fd }
            catch { Darwin.close(fd); throw error }
        }
        let input = try openSource(); defer { Darwin.close(input) }
        let before = try Self.regular(input)
        guard before.st_nlink == 1 else { throw NativeAttachmentFilesError.unavailable }
        guard before.st_size <= (photo == nil ? Self.maximumProviderBytes : NativeAttachmentPhotoEncoder.maximumInputBytes) else { throw NativeAttachmentFilesError.providerTooLarge }
        func validateSource() throws {
            guard try sourceParentIdentity() == parentIdentity else { throw NativeAttachmentFilesError.unavailable }
            let named = try openSource(); defer { Darwin.close(named) }
            let retained = try Self.regular(input), current = try Self.regular(named)
            guard Self.unchanged(before, retained), Self.unchanged(before, current),
                  retained.st_nlink == 1, current.st_nlink == 1,
                  try sourceParentIdentity() == parentIdentity else { throw NativeAttachmentFilesError.unavailable }
        }
        let metadata = try? url.resourceValues(forKeys: [.nameKey, .contentTypeKey])
        var fileName = metadata?.name.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
        var mimeType = metadata?.contentType?.preferredMIMEType
        try validateSource()
        var encodedPhoto: NativeAttachmentPhotoEncoder.Encoded?
        if let photo {
            var borrowed = Data()
            let read = try hashContents(input, checkCancellation: {
                try validateSource(); try checkCancellation()
            }) { bytes in
                guard Int64(borrowed.count) <= NativeAttachmentPhotoEncoder.maximumInputBytes - Int64(bytes.count) else {
                    throw NativeAttachmentFilesError.providerTooLarge
                }
                borrowed.append(bytes)
            }
            guard read.size == before.st_size else { throw NativeAttachmentFilesError.unavailable }
            try validateSource(); try checkCancellation()
            encodedPhoto = try NativeAttachmentPhotoEncoder.encode(borrowed, selection: photo) {
                try validateSource(); try checkCancellation()
            }
            try validateSource(); try checkCancellation()
        }
        let leaf = UUID().uuidString.lowercased(), partial = UUID().uuidString.lowercased()
        if let photo, let encodedPhoto {
            fileName = (photo.suggestedName ?? leaf) + "." + encodedPhoto.fileExtension
            mimeType = encodedPhoto.mimeType
        }
        let path = Reference(cache: true, components: [leaf]), partialPath = Reference(cache: true, components: [partial])
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let output = Darwin.openat(parent.fd, partial, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard output >= 0 else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(output) }
        let created = try Self.identity(output)
        var promoted = false, complete = false, outputFrozen = false
        defer {
            if !complete {
                // A pathname is insufficient even in a failure defer: ancestors
                // and the exact created single-link inode must still match.
                let cleanupPath = promoted ? path : partialPath
                let named = Parent(fd: parent.fd, leaf: promoted ? leaf : partial)
                if (try? verify(named, path: cleanupPath)) != nil,
                   let current = try? Self.named(named), let retained = try? Self.regular(output),
                   Identity(current) == created, Identity(retained) == created,
                   current.st_nlink == 1, retained.st_nlink == 1,
                   current.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) {
                    _ = Darwin.unlinkat(named.fd, named.leaf, 0)
                    _ = Darwin.fsync(named.fd)
                }
            }
        }
        func validateOutput() throws {
            let named = Parent(fd: parent.fd, leaf: promoted ? leaf : partial)
            try verify(named, path: promoted ? path : partialPath)
            let retained = try Self.regular(output)
            #if DEBUG
            try beforeProviderOutputNamedStat?(outputFrozen)
            #endif
            let current = try Self.named(named)
            // Creation authority owns this output while it is being filled.
            // After sync/capture, every generation check includes ctime again.
            let sameGeneration = outputFrozen ? Self.unchanged(retained, current)
                : Identity(retained) == Identity(current) && retained.st_size == current.st_size
                    && retained.st_mode == current.st_mode
                    && retained.st_mtimespec.tv_sec == current.st_mtimespec.tv_sec
                    && retained.st_mtimespec.tv_nsec == current.st_mtimespec.tv_nsec
            guard Identity(retained) == created, sameGeneration,
                  retained.st_nlink == 1, current.st_nlink == 1 else { throw NativeAttachmentFilesError.unavailable }
        }
        func check() throws {
            try validateSource(); try validateOutput(); try checkCancellation(); try validateSource(); try validateOutput()
        }
        try check()
        let partialURL = cache.appendingPathComponent(partial)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: partialURL.path)
        try check()
        #endif
        var privateURL = partialURL, attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true
        try privateURL.setResourceValues(attributes)
        try check()
        #if DEBUG
        try afterSourceOpened?()
        #endif
        try check()
        var written: Int64 = 0
        let content: AttachmentStageContent
        if let encodedPhoto {
            var digest = SHA256()
            for offset in stride(from: 0, to: encodedPhoto.bytes.count, by: 64 * 1024) {
                let bytes = encodedPhoto.bytes.subdata(in: offset..<min(offset + 64 * 1024, encodedPhoto.bytes.count))
                try check(); try Self.write(output, bytes); written += Int64(bytes.count); digest.update(data: bytes)
            }
            content = AttachmentStageContent(sha256: digest.finalize().map { String(format: "%02x", $0) }.joined(), size: written)
        } else {
            content = try hashContents(input, checkCancellation: check) { bytes in
                guard written <= Self.maximumProviderBytes - Int64(bytes.count) else {
                    throw NativeAttachmentFilesError.providerTooLarge
                }
                try check(); try Self.write(output, bytes); written += Int64(bytes.count)
            }
            guard content.size == before.st_size else { throw NativeAttachmentFilesError.unavailable }
        }
        try check()
        guard written == content.size else { throw NativeAttachmentFilesError.unavailable }
        #if DEBUG
        try beforeStageSync?()
        #endif
        try check()
        guard Darwin.fsync(output) == 0, Darwin.fcntl(output, F_FULLFSYNC) == 0 else { throw NativeAttachmentFilesError.unavailable }
        let filled = try Self.regular(output)
        outputFrozen = true
        #if DEBUG
        try beforePublish?()
        #endif
        try check()
        guard try Self.unchanged(filled, Self.regular(output)),
              Darwin.renameatx_np(parent.fd, partial, parent.fd, leaf, UInt32(RENAME_EXCL)) == 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        promoted = true
        try check()
        guard Darwin.fsync(parent.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
        try check()
        let uri = cache.appendingPathComponent(leaf).absoluteString
        let observed = try snapshotCacheSource(uri, checkCancellation: check)
        try check()
        guard observed.identity == Self.token(created), observed.sha256 == content.sha256, observed.size == content.size,
              observed.cacheRootIdentity == Self.token(cacheIdentity),
              observed.parentIdentity == (try Self.token(Self.identity(parent.fd))) else {
            throw NativeAttachmentFilesError.unavailable
        }
        complete = true
        return ProviderCacheCopyReceipt(proof: observed, generation: try Self.regular(output), fileName: fileName, mimeType: mimeType)
    }

    /// A cheap immutable-generation fence for the existing Add owner checks.
    /// Content was hashed at minting; same-inode writes change the bound ctime.
    func requireProviderSource(_ receipt: ProviderCacheCopyReceipt) throws {
        let proof = receipt.proof, path = try reference(proof.sourceURI)
        guard path.cache, path.components.count == 1, proof.cacheRootIdentity == Self.token(cacheIdentity),
              proof.parentIdentity == proof.cacheRootIdentity else { throw NativeAttachmentFilesError.invalidRequest }
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        try stable(fd, before: before, parent: parent, path: path)
        guard Self.token(Identity(before)) == proof.identity, before.st_size == proof.size,
              before.st_nlink == 1, try Self.named(parent).st_nlink == 1,
              before.st_mode == receipt.mode,
              Int64(before.st_mtimespec.tv_sec) == receipt.modificationSeconds,
              Int64(before.st_mtimespec.tv_nsec) == receipt.modificationNanoseconds,
              Int64(before.st_ctimespec.tv_sec) == receipt.changeSeconds,
              Int64(before.st_ctimespec.tv_nsec) == receipt.changeNanoseconds else {
            throw NativeAttachmentFilesError.unavailable
        }
    }

    /// Caller must first settle/drain all consumers in the same library turn.
    func retireProviderSource(_ receipt: ProviderCacheCopyReceipt,
                              checkCancellation: () throws -> Void) throws -> BaselineAttachmentRetirementOutcome {
        let proof = receipt.proof, path = try reference(proof.sourceURI)
        guard path.cache, path.components.count == 1, proof.cacheRootIdentity == Self.token(cacheIdentity),
              proof.parentIdentity == proof.cacheRootIdentity else { throw NativeAttachmentFilesError.invalidRequest }
        return try retireGeneration(path: path,
            proof: .init(sha256: proof.sha256, size: proof.size, identity: proof.identity, directoryIdentity: proof.parentIdentity),
            retainDifferent: true, checkCancellation: checkCancellation)
    }

    func snapshotCacheSource(_ uri: String, checkCancellation: () throws -> Void = {}) throws -> CacheSourceProof {
        let path = try reference(uri)
        guard path.cache, !path.components.isEmpty else { throw NativeAttachmentFilesError.invalidRequest }
        let root = try openRoot(true); defer { Darwin.close(root) }
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        #if DEBUG
        try afterSourceOpened?()
        #endif
        let content = try hashContents(fd, checkCancellation: checkCancellation)
        try stable(fd, before: before, parent: parent, path: path)
        guard content.size == before.st_size, content.size <= 9_007_199_254_740_991 else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        return CacheSourceProof(sourceURI: uri, sha256: content.sha256, size: content.size,
                                identity: Self.token(Identity(before)), cacheRootIdentity: try Self.token(Self.identity(root)),
                                parentIdentity: try Self.token(Self.identity(parent.fd)))
    }

    /// Fills only a recorded exclusive immutable stage. Failure retains its inode
    /// and partial bytes; the caller must persist intent/proof before invoking.
    func fillReservedAttachmentStage(sourceProof: CacheSourceProof, stageProof: ReservedAttachmentStageProof,
                                     checkCancellation: () throws -> Void = {}) throws -> AttachmentStageContent {
        guard Self.validDigest(sourceProof.sha256), sourceProof.size >= 0, sourceProof.size <= 9_007_199_254_740_991,
              [sourceProof.identity, sourceProof.cacheRootIdentity, sourceProof.parentIdentity,
               stageProof.stagedIdentity, stageProof.directoryIdentity, stageProof.privateDirectoryIdentity].allSatisfy(Self.validToken) else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let sourcePath = try reference(sourceProof.sourceURI), stagePath = try reference(stageProof.stageURI)
        guard sourcePath.cache, !sourcePath.components.isEmpty,
              !stagePath.cache, stagePath.components.count == 3, stagePath.components[0] == "attachments",
              stagePath.components[1].range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z", options: .regularExpression) != nil,
              stagePath.components[2] == "stage" else { throw NativeAttachmentFilesError.invalidRequest }
        let cacheRoot = try openRoot(true); defer { Darwin.close(cacheRoot) }
        let source = try openParent(sourcePath); defer { Darwin.close(source.fd) }
        let input = try openFile(source); defer { Darwin.close(input) }
        let before = try Self.regular(input)
        let managedPath = Reference(cache: false, components: ["attachments"])
        let managed = try openDirectory(managedPath); defer { Darwin.close(managed) }
        let stage = try openParent(stagePath); defer { Darwin.close(stage.fd) }
        let output = Darwin.openat(stage.fd, stage.leaf, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard output >= 0 else { throw Self.failure() }
        defer { Darwin.close(output) }
        #if DEBUG
        try afterSourceOpened?()
        #endif
        func validate() throws {
            try stable(input, before: before, parent: source, path: sourcePath)
            let currentManaged = try openDirectory(managedPath); defer { Darwin.close(currentManaged) }
            let currentCache = try openRoot(true); defer { Darwin.close(currentCache) }
            try verify(stage, path: stagePath)
            let outputInfo = try Self.regular(output), namedStage = try Self.named(stage)
            guard Self.token(Identity(before)) == sourceProof.identity, before.st_size == sourceProof.size,
                  try Self.token(Self.identity(cacheRoot)) == sourceProof.cacheRootIdentity,
                  try Self.identity(currentCache) == Self.identity(cacheRoot),
                  try Self.token(Self.identity(source.fd)) == sourceProof.parentIdentity,
                  try Self.token(Self.identity(managed)) == stageProof.directoryIdentity,
                  try Self.identity(currentManaged) == Self.identity(managed),
                  try Self.token(Self.identity(stage.fd)) == stageProof.privateDirectoryIdentity,
                  Self.token(Identity(outputInfo)) == stageProof.stagedIdentity,
                  Self.unchanged(outputInfo, namedStage), outputInfo.st_nlink == 1, namedStage.st_nlink == 1,
                  Identity(before) != Identity(outputInfo) else { throw NativeAttachmentFilesError.unavailable }
        }
        // Cancellation callbacks can mutate paths too. Always validate after them,
        // including before each write to avoid using a newly hard-linked stage.
        func checkedCancellation() throws { try checkCancellation(); try validate() }
        try checkedCancellation()
        guard Darwin.ftruncate(output, 0) == 0, Darwin.lseek(output, 0, SEEK_SET) == 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        let content = try hashContents(input, checkCancellation: checkedCancellation) { try Self.write(output, $0) }
        guard content.sha256 == sourceProof.sha256, content.size == sourceProof.size else {
            throw NativeAttachmentFilesError.unavailable
        }
        let written = try Self.regular(output)
        #if DEBUG
        try beforeStageSync?()
        #endif
        try checkedCancellation()
        guard written.st_size == content.size, try Self.unchanged(written, Self.regular(output)),
              try Self.unchanged(written, Self.named(stage)), Darwin.lseek(output, 0, SEEK_SET) == 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        // The source digest proves what was read, not what is still in the stage:
        // a cancellation callback may have rewritten an earlier copied chunk.
        let stagedContent = try hashContents(output, checkCancellation: checkedCancellation)
        guard stagedContent == content, try Self.unchanged(written, Self.regular(output)),
              try Self.unchanged(written, Self.named(stage)), Darwin.fsync(output) == 0,
              Darwin.fcntl(output, F_FULLFSYNC) == 0, Darwin.fsync(stage.fd) == 0,
              Darwin.fsync(managed) == 0 else { throw NativeAttachmentFilesError.unavailable }
        try validate()
        guard try Self.unchanged(written, Self.regular(output)), try Self.unchanged(written, Self.named(stage)) else {
            throw NativeAttachmentFilesError.unavailable
        }
        return content
    }

    /// Positive present-stage observation only; this does not prove that
    /// publication was never attempted or grant cleanup authority. Refusal is
    /// unclassified, and this path never opens a source or public target.
    func observeFilledAttachmentStage(stageProof: ReservedAttachmentStageProof, sha256: String, size: Int64,
                                      checkCancellation: () throws -> Void = {}) throws -> AttachmentStageContent {
        guard Self.validDigest(sha256), size >= 0, size <= 9_007_199_254_740_991,
              [stageProof.stagedIdentity, stageProof.directoryIdentity,
               stageProof.privateDirectoryIdentity].allSatisfy(Self.validToken) else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let path = try reference(stageProof.stageURI)
        guard !path.cache, path.components.count == 3, path.components[0] == "attachments",
              path.components[1].range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z", options: .regularExpression) != nil,
              path.components[2] == "stage" else { throw NativeAttachmentFilesError.invalidRequest }
        try checkCancellation()
        let managedPath = Reference(cache: false, components: ["attachments"])
        let managed = try openDirectory(managedPath); defer { Darwin.close(managed) }
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        func validate() throws {
            try stable(fd, before: before, parent: parent, path: path)
            let currentManaged = try openDirectory(managedPath); defer { Darwin.close(currentManaged) }
            let opened = try Self.regular(fd), named = try Self.named(parent)
            guard try Self.token(Self.identity(managed)) == stageProof.directoryIdentity,
                  try Self.identity(currentManaged) == Self.identity(managed),
                  try Self.token(Self.identity(parent.fd)) == stageProof.privateDirectoryIdentity,
                  Self.token(Identity(before)) == stageProof.stagedIdentity,
                  before.st_size == size, opened.st_nlink == 1, named.st_nlink == 1 else {
                throw NativeAttachmentFilesError.unavailable
            }
        }
        // Cancellation predicates may mutate content and any ancestor. Retain
        // descriptors and compare the named tree again after every callback.
        func check() throws { try checkCancellation(); try validate() }
        try check()
        let content = try hashContents(fd, checkCancellation: check)
        try check()
        guard content.sha256 == sha256, content.size == size else { throw NativeAttachmentFilesError.unavailable }
        try validate()
        NSLog("Native iOS attachment filled stage observed releaseCheck=v1.3.5/ios-filled-stage-observed outcome=present")
        return content
    }

    /// Re-proves a lost publication acknowledgment from the recorded stage inode.
    /// Equal content alone is never ownership. This reads/flushes and retains every
    /// uncertain file/namespace for the future durable draft owner.
    func verifyPublishedAttachment(targetURI: String, stageProof: ReservedAttachmentStageProof,
                                   sha256: String, size: Int64,
                                   checkCancellation: () throws -> Void = {}) throws -> PublishedAttachmentProof {
        guard Self.validDigest(sha256), size >= 0, size <= 9_007_199_254_740_991,
              [stageProof.stagedIdentity, stageProof.directoryIdentity,
               stageProof.privateDirectoryIdentity].allSatisfy(Self.validToken) else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let targetPath = try reference(targetURI), stagePath = try reference(stageProof.stageURI)
        guard !targetPath.cache, targetPath.components.count == 2, targetPath.components[0] == "attachments",
              !stagePath.cache, stagePath.components.count == 3, stagePath.components[0] == "attachments",
              stagePath.components[1].range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z", options: .regularExpression) != nil,
              stagePath.components[2] == "stage" else { throw NativeAttachmentFilesError.invalidRequest }
        let parent = try openParent(targetPath); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        func validate(flushNamespace: Bool = false) throws {
            try stable(fd, before: before, parent: parent, path: targetPath)
            guard Self.token(Identity(before)) == stageProof.stagedIdentity, before.st_size == size,
                  before.st_nlink == 1,
                  try Self.token(Self.identity(parent.fd)) == stageProof.directoryIdentity else {
                throw NativeAttachmentFilesError.unavailable
            }
            // A completed publication removes its private directory. If a crash
            // retained it, only that exact directory with an absent stage agrees
            // with rename publication. Never remove it here.
            var namespace = stat()
            let name = stagePath.components[1]
            if Darwin.fstatat(parent.fd, name, &namespace, AT_SYMLINK_NOFOLLOW) != 0 {
                guard errno == ENOENT else { throw NativeAttachmentFilesError.unavailable }
                return
            }
            guard namespace.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  Self.token(Identity(namespace)) == stageProof.privateDirectoryIdentity else {
                throw NativeAttachmentFilesError.unavailable
            }
            let privateFD = Darwin.openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard privateFD >= 0 else { throw NativeAttachmentFilesError.unavailable }
            defer { Darwin.close(privateFD) }
            guard try Self.token(Self.identity(privateFD)) == stageProof.privateDirectoryIdentity else {
                throw NativeAttachmentFilesError.unavailable
            }
            var stage = stat()
            guard Darwin.fstatat(privateFD, "stage", &stage, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
                throw NativeAttachmentFilesError.unavailable
            }
            if flushNamespace, Darwin.fsync(privateFD) != 0 { throw NativeAttachmentFilesError.unavailable }
            var named = stat()
            guard Darwin.fstatat(parent.fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  named.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  Self.token(Identity(named)) == stageProof.privateDirectoryIdentity else {
                throw NativeAttachmentFilesError.unavailable
            }
        }
        func check() throws { try checkCancellation(); try validate() }
        try check()
        let content = try hashContents(fd, checkCancellation: check)
        try check()
        guard content.sha256 == sha256, content.size == size,
              Darwin.fsync(fd) == 0, Darwin.fcntl(fd, F_FULLFSYNC) == 0, Darwin.fsync(parent.fd) == 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        try validate(flushNamespace: true)
        return PublishedAttachmentProof(sha256: content.sha256, size: content.size,
                                        identity: stageProof.stagedIdentity, directoryIdentity: stageProof.directoryIdentity)
    }

    /// Native-only retirement of one recorded publication. The caller must
    /// separately own the durable retirement decision and latest shared keep
    /// check, and serialize this whole operation under the same library owner.
    /// A failure after unlink is uncertain; an exact missing retry still syncs.
    func retirePublishedAttachment(targetURI: String, proof: PublishedAttachmentProof,
                                   checkCancellation: () throws -> Void = {}) throws -> PublishedAttachmentRetirementOutcome {
        guard Self.validDigest(proof.sha256), proof.size >= 0, proof.size <= 9_007_199_254_740_991,
              Self.validToken(proof.identity), Self.validToken(proof.directoryIdentity) else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let path = try reference(targetURI)
        guard !path.cache, path.components.count == 2, path.components[0] == "attachments",
              !path.components[1].hasPrefix(".") else { throw NativeAttachmentFilesError.invalidRequest }
        switch try retireGeneration(path: path, proof: proof, retainDifferent: false, checkCancellation: checkCancellation) {
        case .removed: return .removed
        case .absent: return .absent
        case .generationChanged, .unsafeEntry: throw NativeAttachmentFilesError.unavailable
        }
    }

    /// Only a separately journaled candidate and latest shared keep decision
    /// may call this typed facade. An observation of absence is not a proof.
    func retireBaselineAttachment(attachmentID: String, proof: BaselineAttachmentProof,
                                  checkCancellation: () throws -> Void = {},
                                  checkOwnership: () throws -> Void = {}) throws -> BaselineAttachmentRetirementOutcome {
        try checkOwnership()
        guard Self.validBaselineAttachmentID(attachmentID), !proof.targetURI.isEmpty,
              proof.targetURI.utf8.count <= 16 * 1024, !proof.targetURI.utf8.contains(0),
              Self.validDigest(proof.sha256), proof.size >= 0, proof.size <= 9_007_199_254_740_991,
              Self.validToken(proof.identity), Self.validToken(proof.directoryIdentity),
              let leaf = try baselineLeaf(attachmentID: attachmentID, targetURI: proof.targetURI) else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        let outcome = try retireGeneration(path: Reference(cache: false, components: ["attachments", leaf]),
            proof: PublishedAttachmentProof(sha256: proof.sha256, size: proof.size,
                identity: proof.identity, directoryIdentity: proof.directoryIdentity),
            retainDifferent: true, checkCancellation: checkCancellation, checkOwnership: checkOwnership)
        let diagnostic = outcome == .removed ? "removed" : outcome == .absent ? "absent" : "retained"
        NSLog("Native iOS attachment baseline file settled releaseCheck=v1.3.5/ios-baseline-file-settled outcome=%@", diagnostic)
        return outcome
    }

    // One descriptor-bound retirement engine. Legacy publication mode retains
    // its refusal/hook order; only baseline mode can positively keep a generation.
    private func retireGeneration(path: Reference, proof: PublishedAttachmentProof, retainDifferent: Bool,
                                  checkCancellation: () throws -> Void,
                                  checkOwnership: () throws -> Void = {}) throws -> BaselineAttachmentRetirementOutcome {
        try checkOwnership()
        try checkCancellation()
        let parent: Parent
        do { parent = try openParent(path) }
        catch { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(parent.fd) }
        func validateParent() throws {
            try checkOwnership()
            try verify(parent, path: path)
            guard try Self.token(Self.identity(parent.fd)) == proof.directoryIdentity else {
                throw NativeAttachmentFilesError.unavailable
            }
        }
        func validateAbsence() throws {
            try validateParent()
            var named = stat()
            guard Darwin.fstatat(parent.fd, parent.leaf, &named, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
                throw NativeAttachmentFilesError.unavailable
            }
            try validateParent()
        }
        try validateParent()
        if retainDifferent {
            let named: stat?
            do { named = try Self.named(parent) }
            catch NativeAttachmentFilesError.missing { named = nil }
            if let before = named, before.st_mode & mode_t(S_IFMT) != mode_t(S_IFREG) || before.st_nlink != 1 {
                func validateUnsafe() throws {
                    try validateParent()
                    let current = try Self.named(parent)
                    guard Self.unchanged(before, current), before.st_nlink == current.st_nlink else {
                        throw NativeAttachmentFilesError.unavailable
                    }
                }
                try validateUnsafe(); try checkCancellation(); try validateUnsafe()
                return .unsafeEntry
            }
        }
        let fd: Int32
        do { fd = try openFile(parent) }
        catch NativeAttachmentFilesError.missing {
            try checkCancellation()
            try validateAbsence()
            do {
                #if DEBUG
                try beforeRetirementSync?()
                #endif
                try validateAbsence()
                guard Darwin.fsync(parent.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
                try validateAbsence()
                return .absent
            } catch { throw NativeAttachmentFilesError.unavailable }
        }
        defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        func validateFile() throws {
            try stable(fd, before: before, parent: parent, path: path)
            try validateParent()
            guard before.st_nlink == 1 else { throw NativeAttachmentFilesError.unavailable }
            if !retainDifferent, Self.token(Identity(before)) != proof.identity || before.st_size != proof.size {
                throw NativeAttachmentFilesError.unavailable
            }
            if retainDifferent, try Self.regular(fd).st_nlink != 1 || Self.named(parent).st_nlink != 1 {
                throw NativeAttachmentFilesError.unavailable
            }
        }
        func check() throws {
            if retainDifferent { try validateFile() }
            try checkCancellation(); try validateFile()
        }
        try check()
        if retainDifferent, Self.token(Identity(before)) != proof.identity || before.st_size != proof.size {
            return .generationChanged
        }
        let content = try hashContents(fd, checkCancellation: check)
        try check()
        guard content.sha256 == proof.sha256, content.size == proof.size else {
            if retainDifferent { return .generationChanged }
            throw NativeAttachmentFilesError.unavailable
        }
        #if DEBUG
        try checkOwnership()
        try beforeRetirementUnlink?()
        #endif
        // The final cancellation/identity check and unlink have no intervening
        // await. Once unlink starts, a late cancellation cannot undo its effect.
        try check()
        guard Darwin.unlinkat(parent.fd, parent.leaf, 0) == 0 else { throw NativeAttachmentFilesError.unavailable }
        do {
            try checkOwnership()
            #if DEBUG
            try afterRetirementUnlink?()
            #endif
            try validateAbsence()
            #if DEBUG
            try beforeRetirementSync?()
            #endif
            try validateAbsence()
            guard Darwin.fsync(parent.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
            try validateAbsence()
            return .removed
        } catch { throw NativeAttachmentFilesError.unavailable }
    }

    private static func token(_ identity: Identity) -> String { "\(UInt64(identity.device)):\(UInt64(identity.inode))" }
    private static func validToken(_ value: String) -> Bool {
        guard value.utf8.count <= 41 else { return false }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { part in
            guard let number = UInt64(part) else { return false }
            return String(number) == part
        }
    }
    private static func validDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private struct Identity: Equatable {
        let device: dev_t; let inode: ino_t
        init(_ value: stat) { device = value.st_dev; inode = value.st_ino }
    }
    private struct Reference { let cache: Bool; let components: [String] }
    private struct Parent { let fd: Int32; let leaf: String }

    private func reference(_ value: Any?) throws -> Reference {
        guard let text = value as? String, text.utf8.count <= 16 * 1024 else { throw NativeAttachmentFilesError.invalidRequest }
        let path = try Self.filePath(text)
        let parts = Self.parts(path)
        for (root, isCache) in [(documents, false), (cache, true)] {
            let prefix = Self.parts(root.path)
            if parts.count >= prefix.count && zip(parts, prefix).allSatisfy({ Self.equalName($0.0, $0.1) }) {
                return Reference(cache: isCache, components: Array(parts.dropFirst(prefix.count)))
            }
        }
        throw NativeAttachmentFilesError.invalidRequest
    }

    static func filePath(_ text: String) throws -> String {
        guard !text.isEmpty, !text.utf8.contains(0), let url = URLComponents(string: text),
              url.scheme?.lowercased() == "file", url.host == nil || url.host == "",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              let path = url.percentEncodedPath.removingPercentEncoding,
              path.hasPrefix("/"), !path.utf8.contains(0),
              !parts(path).contains("."), !parts(path).contains("..") else { throw NativeAttachmentFilesError.invalidRequest }
        // Only Apple's fixed system alias is normalized. User paths are never
        // resolved through symlinks to gain authorization.
        if parts(path).first == "var", let target = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
           ["private/var", "/private/var"].contains(target) { return "/private" + path }
        return path
    }
    private static func parts(_ path: String) -> [String] { path.split(separator: "/").map(String.init) }
    private static func equalName(_ a: String, _ b: String) -> Bool { Array(a.utf8) == Array(b.utf8) }

    private static func integer(_ value: Any?) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw NativeAttachmentFilesError.invalidRequest }
        let count = number.doubleValue
        guard count.isFinite, count >= 0, count <= 9_007_199_254_740_991, count.rounded() == count else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        return Int(count)
    }
    private static func decodeBytes(_ value: Any?) throws -> Data {
        guard let text = value as? String else { throw NativeAttachmentFilesError.invalidRequest }
        guard text.utf8.count <= ((maximumBytes + 2) / 3) * 4 else { throw NativeAttachmentFilesError.tooLarge }
        // Bound decoded size before allocation, including the padded boundary.
        let padding = text.hasSuffix("==") ? 2 : text.hasSuffix("=") ? 1 : 0
        guard text.utf8.count / 4 * 3 - padding <= maximumBytes else { throw NativeAttachmentFilesError.tooLarge }
        guard let bytes = Data(base64Encoded: text), bytes.count <= maximumBytes,
              bytes.base64EncodedString() == text else { throw NativeAttachmentFilesError.invalidRequest }
        return bytes
    }

    private static func identity(_ fd: Int32) throws -> Identity {
        var value = stat()
        guard Darwin.fstat(fd, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return Identity(value)
    }
    private static func failure() -> NativeAttachmentFilesError { errno == ENOENT ? .missing : .unavailable }
    private static func openAbsoluteDirectory(_ path: String) throws -> Int32 {
        // iOS permits the owned directory but can deny reading its ancestors.
        // The kernel still refuses every symlink in the complete path.
        let directory = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard directory >= 0 else { throw failure() }
        return directory
    }
    private static func childDirectory(_ parent: Int32, _ name: String, create: Bool) throws -> Int32 {
        if create {
            if Darwin.mkdirat(parent, name, mode_t(0o700)) == 0 {
                guard Darwin.fsync(parent) == 0 else { throw NativeAttachmentFilesError.unavailable }
            } else if errno != EEXIST { throw failure() }
        }
        let fd = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw failure() }
        return fd
    }
    private func openRoot(_ isCache: Bool) throws -> Int32 {
        let library: Int32
        do { library = try Self.openAbsoluteDirectory(libraryRoot.path) }
        catch { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(library) }
        guard try Self.identity(library) == libraryIdentity else { throw NativeAttachmentFilesError.unavailable }
        let owner: Int32
        do { owner = try Self.childDirectory(library, "attachment-files", create: false) }
        catch { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.close(owner) }
        guard try Self.identity(owner) == namespaceIdentity else { throw NativeAttachmentFilesError.unavailable }
        let directory: Int32
        do { directory = try Self.childDirectory(owner, isCache ? "cache" : "documents", create: false) }
        catch { throw NativeAttachmentFilesError.unavailable }
        do {
            guard try Self.identity(directory) == (isCache ? cacheIdentity : documentsIdentity) else {
                throw NativeAttachmentFilesError.unavailable
            }
            return directory
        } catch { Darwin.close(directory); throw error }
    }
    private func openDirectory(_ path: Reference, create: Bool = false) throws -> Int32 {
        var directory = try openRoot(path.cache)
        do {
            for component in path.components {
                let next = try Self.childDirectory(directory, component, create: create)
                Darwin.close(directory); directory = next
            }
            return directory
        } catch { Darwin.close(directory); throw error }
    }
    private func openParent(_ path: Reference, create: Bool = false) throws -> Parent {
        guard let leaf = path.components.last else { throw NativeAttachmentFilesError.invalidRequest }
        let parent = Reference(cache: path.cache, components: Array(path.components.dropLast()))
        return Parent(fd: try openDirectory(parent, create: create), leaf: leaf)
    }
    private func verify(_ parent: Parent, path: Reference) throws {
        let current = try openParent(path)
        defer { Darwin.close(current.fd) }
        guard try Self.identity(current.fd) == Self.identity(parent.fd) else { throw NativeAttachmentFilesError.unavailable }
    }
    private static func named(_ parent: Parent) throws -> stat {
        var value = stat()
        guard Darwin.fstatat(parent.fd, parent.leaf, &value, AT_SYMLINK_NOFOLLOW) == 0 else { throw failure() }
        return value
    }
    private static func regular(_ fd: Int32) throws -> stat {
        var value = stat()
        guard Darwin.fstat(fd, &value) == 0, value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), value.st_size >= 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        return value
    }
    private static func unchanged(_ a: stat, _ b: stat) -> Bool {
        Identity(a) == Identity(b) && a.st_size == b.st_size && a.st_mode == b.st_mode
            && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
            && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func openFile(_ parent: Parent) throws -> Int32 {
        let fd = Darwin.openat(parent.fd, parent.leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Self.failure() }
        do { _ = try Self.regular(fd); return fd } catch { Darwin.close(fd); throw error }
    }
    private func stable(_ fd: Int32, before: stat, parent: Parent, path: Reference) throws {
        guard try Self.unchanged(before, Self.regular(fd)), try Self.unchanged(before, Self.named(parent)) else {
            throw NativeAttachmentFilesError.unavailable
        }
        try verify(parent, path: path)
    }

    private func info(_ path: Reference) throws -> [String: Any] {
        do {
            let value: stat
            if path.components.isEmpty {
                let fd = try openRoot(path.cache); defer { Darwin.close(fd) }
                var root = stat(); guard Darwin.fstat(fd, &root) == 0 else { throw NativeAttachmentFilesError.unavailable }; value = root
            } else {
                let parent = try openParent(path); defer { Darwin.close(parent.fd) }
                value = try Self.named(parent); try verify(parent, path: path)
            }
            let kind = value.st_mode & mode_t(S_IFMT)
            guard kind == mode_t(S_IFREG) || kind == mode_t(S_IFDIR) else { throw NativeAttachmentFilesError.unavailable }
            return ["exists": true, "isDirectory": kind == mode_t(S_IFDIR), "size": kind == mode_t(S_IFDIR) ? 0 : value.st_size,
                    "modificationTime": Double(value.st_mtimespec.tv_sec) + Double(value.st_mtimespec.tv_nsec) / 1_000_000_000]
        } catch NativeAttachmentFilesError.missing { return ["exists": false] }
    }
    private func list(_ path: Reference, checkCancellation: () throws -> Void) throws -> [String] {
        let fd = try openDirectory(path)
        guard let stream = Darwin.fdopendir(fd) else { Darwin.close(fd); throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.closedir(stream) }
        var names: [String] = []
        while true {
            try checkCancellation(); errno = 0
            guard let entry = Darwin.readdir(stream) else {
                guard errno == 0 else { throw NativeAttachmentFilesError.unavailable }; break
            }
            let decoded = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(validatingUTF8: $0) }
            }
            guard let name = decoded else { throw NativeAttachmentFilesError.unavailable }
            if name != "." && name != ".." { names.append(name) }
        }
        let current = try openDirectory(path); defer { Darwin.close(current) }
        guard try Self.identity(fd) == Self.identity(current) else { throw NativeAttachmentFilesError.unavailable }
        return names
    }
    private func read(_ path: Reference, position: Int, length: Int?, checkCancellation: () throws -> Void) throws -> Data {
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        if length == nil && before.st_size > Self.maximumBytes { throw NativeAttachmentFilesError.tooLarge }
        guard Darwin.lseek(fd, off_t(position), SEEK_SET) >= 0 else { throw NativeAttachmentFilesError.unavailable }
        #if DEBUG
        try afterSourceOpened?()
        #endif
        var bytes = Data()
        let capacity = min(max(0, before.st_size - Int64(position)), Int64(length ?? Self.maximumBytes))
        bytes.reserveCapacity(Int(capacity))
        try consume(fd, limit: length, checkCancellation: checkCancellation) { chunk in
            guard bytes.count <= Self.maximumBytes - chunk.count else { throw NativeAttachmentFilesError.tooLarge }
            bytes.append(chunk)
        }
        guard bytes.count <= Self.maximumBytes else { throw NativeAttachmentFilesError.tooLarge }
        try stable(fd, before: before, parent: parent, path: path)
        return bytes
    }
    private func hash(_ path: Reference, checkCancellation: () throws -> Void) throws -> String {
        let parent = try openParent(path); defer { Darwin.close(parent.fd) }
        let fd = try openFile(parent); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        #if DEBUG
        try afterSourceOpened?()
        #endif
        let content = try hashContents(fd, checkCancellation: checkCancellation)
        try stable(fd, before: before, parent: parent, path: path)
        return content.sha256
    }
    private func hashContents(_ fd: Int32, checkCancellation: () throws -> Void,
                              chunk: (Data) throws -> Void = { _ in }) throws -> AttachmentStageContent {
        var digest = SHA256(), size: Int64 = 0
        try consume(fd, checkCancellation: checkCancellation) { bytes in
            let next = size.addingReportingOverflow(Int64(bytes.count))
            guard !next.overflow else { throw NativeAttachmentFilesError.unavailable }
            size = next.partialValue
            digest.update(data: bytes)
            try chunk(bytes)
        }
        return AttachmentStageContent(sha256: digest.finalize().map { String(format: "%02x", $0) }.joined(), size: size)
    }
    private func copy(_ from: Reference, to: Reference, checkCancellation: () throws -> Void) throws {
        let source = try openParent(from); defer { Darwin.close(source.fd) }
        let fd = try openFile(source); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        #if DEBUG
        try afterSourceOpened?()
        #endif
        try publish(to, checkCancellation: checkCancellation,
                    beforePromotionValidation: { try self.stable(fd, before: before, parent: source, path: from) }) { output in
            try consume(fd, checkCancellation: checkCancellation) { try Self.write(output, $0) }
            try stable(fd, before: before, parent: source, path: from)
        }
    }
    private func validTarget(_ parent: Parent) throws {
        do {
            guard try Self.named(parent).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
                throw NativeAttachmentFilesError.unavailable
            }
        } catch NativeAttachmentFilesError.missing { }
    }
    private func publish(_ path: Reference, checkCancellation: () throws -> Void,
                         beforePromotionValidation: () throws -> Void = {}, fill: (Int32) throws -> Void) throws {
        let parent = try openParent(path, create: true); defer { Darwin.close(parent.fd) }
        try validTarget(parent)
        let pending = ".mindwtr-native-file-" + UUID().uuidString.lowercased() + ".tmp"
        let output = Darwin.openat(parent.fd, pending, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard output >= 0 else { throw NativeAttachmentFilesError.unavailable }
        var promoted = false
        defer {
            if !promoted {
                var named = stat()
                if Darwin.fstatat(parent.fd, pending, &named, AT_SYMLINK_NOFOLLOW) == 0,
                   (try? Self.identity(output)) == Identity(named) {
                    _ = Darwin.unlinkat(parent.fd, pending, 0)
                    _ = Darwin.fsync(parent.fd)
                }
            }
            Darwin.close(output)
        }
        try fill(output)
        #if DEBUG
        try beforeStageSync?()
        #endif
        guard Darwin.fsync(output) == 0, Darwin.fcntl(output, F_FULLFSYNC) == 0 else { throw NativeAttachmentFilesError.unavailable }
        let written = try Self.regular(output)
        #if DEBUG
        try beforePublish?()
        #endif
        // A caller-supplied check may itself observe or change native state.
        // Run it before the complete publication proof, never after that proof.
        try checkCancellation()
        try verify(parent, path: path)
        try validTarget(parent)
        try beforePromotionValidation()
        // The exclusive stage must still be the inode this operation wrote.
        var staged = stat()
        guard Darwin.fstatat(parent.fd, pending, &staged, AT_SYMLINK_NOFOLLOW) == 0,
              try Self.unchanged(written, Self.regular(output)), Self.unchanged(written, staged) else {
            throw NativeAttachmentFilesError.unavailable
        }
        guard Darwin.renameat(parent.fd, pending, parent.fd, parent.leaf) == 0 else { throw NativeAttachmentFilesError.unavailable }
        promoted = true
        guard Darwin.fsync(parent.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
        try verify(parent, path: path)
    }
    private func move(_ from: Reference, to: Reference, checkCancellation: () throws -> Void) throws {
        let source = try openParent(from); defer { Darwin.close(source.fd) }
        let fd = try openFile(source); defer { Darwin.close(fd) }
        let before = try Self.regular(fd)
        let target = try openParent(to, create: true); defer { Darwin.close(target.fd) }
        #if DEBUG
        try beforePublish?()
        #endif
        try checkCancellation(); try stable(fd, before: before, parent: source, path: from)
        try verify(target, path: to); try validTarget(target)
        guard Darwin.renameat(source.fd, source.leaf, target.fd, target.leaf) == 0,
              Darwin.fsync(target.fd) == 0, Darwin.fsync(source.fd) == 0 else { throw NativeAttachmentFilesError.unavailable }
        try verify(source, path: from); try verify(target, path: to)
    }
    private func remove(_ path: Reference, directories: Bool, sync: Bool) throws {
        do {
            let parent = try openParent(path); defer { Darwin.close(parent.fd) }
            let before = try Self.named(parent)
            let kind = before.st_mode & mode_t(S_IFMT)
            guard kind == mode_t(S_IFREG) || kind == mode_t(S_IFLNK) || (directories && kind == mode_t(S_IFDIR)) else {
                throw NativeAttachmentFilesError.unavailable
            }
            try verify(parent, path: path)
            guard try Self.unchanged(before, Self.named(parent)) else { throw NativeAttachmentFilesError.unavailable }
            guard Darwin.unlinkat(parent.fd, parent.leaf, kind == mode_t(S_IFDIR) ? AT_REMOVEDIR : 0) == 0 else { throw Self.failure() }
            if sync && Darwin.fsync(parent.fd) != 0 { throw NativeAttachmentFilesError.unavailable }
        } catch NativeAttachmentFilesError.missing { }
    }
    private func consume(_ fd: Int32, limit: Int? = nil, checkCancellation: () throws -> Void, chunk: (Data) throws -> Void) throws {
        var buffer = [UInt8](repeating: 0, count: Self.chunkBytes)
        var total = 0
        while limit == nil || total < limit! {
            try checkCancellation()
            let requested = min(buffer.count, limit.map { $0 - total } ?? buffer.count)
            let count = Darwin.read(fd, &buffer, requested)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw NativeAttachmentFilesError.unavailable }
            if count == 0 { break }
            total += count
            try chunk(Data(buffer.prefix(count)))
        }
    }
    private static func write(_ fd: Int32, _ bytes: Data) throws {
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeAttachmentFilesError.unavailable }
                offset += count
            }
        }
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
