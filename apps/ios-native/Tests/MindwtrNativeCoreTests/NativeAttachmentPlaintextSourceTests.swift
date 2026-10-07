import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

/// Native Files/Jobs evidence only: no selected lease, shared producer or HTTP.
final class NativeAttachmentPlaintextSourceTests: XCTestCase {
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var jobs: NativeAttachmentFileJobs?
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private enum FixtureFault: Error { case refused }

    override func setUpWithError() throws {
        let support = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let fixture = support.appendingPathComponent("NativeAttachmentPlaintextSourceTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw FixtureFault.refused }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
    }
    override func tearDownWithError() throws {
        jobs?.shutdown()
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private func info(_ url: URL) throws -> stat {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw FixtureFault.refused }
        return value
    }
    private func identity(_ url: URL) throws -> String {
        let value = try info(url)
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func entries(_ directory: URL? = nil) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory ?? cache, includingPropertiesForKeys: nil)
    }
    private func create(_ bytes: Data) throws -> (receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt,
                                                source: NativeAttachmentFiles.CacheSourceProof) {
        try files.createPlaintextDownloadSource(bytes: bytes, checkCancellation: {})
    }
    private func replace(_ url: URL, bytes: Data) throws -> URL {
        let retained = root.appendingPathComponent("retained-" + UUID().uuidString)
        try FileManager.default.moveItem(at: url, to: retained)
        try bytes.write(to: url)
        return retained
    }
    // Same deterministic metadata-only fixture used by the accepted provider test.
    private func changeOnlyCtime(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDWR | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw FixtureFault.refused }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat()
        guard Darwin.fstat(fd, &before) == 0 else { throw FixtureFault.refused }
        let marker = Data([0x2a])
        let changed = marker.withUnsafeBytes {
            Darwin.fsetxattr(fd, "com.mindwtr.fixture.ctime", $0.baseAddress, $0.count, 0, 0)
        }
        guard changed == 0, Darwin.fstat(fd, &after) == 0 else { throw FixtureFault.refused }
        XCTAssertTrue(before.st_dev == after.st_dev && before.st_ino == after.st_ino
            && before.st_size == after.st_size && before.st_mode == after.st_mode && before.st_nlink == after.st_nlink
            && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec)
        XCTAssertFalse(before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec)
    }

    func testActualPlaintextBytesMintPrivateReceiptAndExactSourceDescriptor() throws {
        let bytes = Data("Plaintext bytes / é / 文".utf8), result = try create(bytes)
        let url = try XCTUnwrap(URL(string: result.source.sourceURI)), value = try info(url)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertEqual(result.source.sha256, digest(bytes)); XCTAssertEqual(result.source.size, Int64(bytes.count))
        XCTAssertTrue(result.receipt.matches(result.source)); XCTAssertEqual(result.receipt.sourceURI, result.source.sourceURI)
        XCTAssertEqual(result.source.identity, try identity(url)); XCTAssertEqual(result.source.cacheRootIdentity, try identity(cache))
        XCTAssertEqual(result.source.parentIdentity, result.source.cacheRootIdentity)
        XCTAssertEqual(url.deletingLastPathComponent(), cache); XCTAssertEqual(url.pathExtension, "")
        XCTAssertEqual(url.lastPathComponent, url.lastPathComponent.lowercased()); XCTAssertNotNil(UUID(uuidString: url.lastPathComponent))
        XCTAssertEqual(result.receipt.fileName, url.lastPathComponent); XCTAssertNil(result.receipt.mimeType)
        XCTAssertEqual(value.st_mode & 0o777, 0o600); XCTAssertEqual(value.st_nlink, 1)
        XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        try files.requireProviderSource(result.receipt)
        XCTAssertEqual(try entries().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path), "Scratch creation must not make the managed target directory")
    }
    func testDataSliceUsesItsActualBytesWithoutAssumingZeroBasedIndices() throws {
        let bytes = Data([0, 1, 2, 3, 4]).dropFirst(2).dropLast()
        let result = try create(bytes), url = try XCTUnwrap(URL(string: result.source.sourceURI))
        XCTAssertEqual(try Data(contentsOf: url), Data([2, 3]))
        XCTAssertEqual(result.source.sha256, digest(Data([2, 3]))); XCTAssertEqual(result.source.size, 2)
        XCTAssertTrue(result.receipt.matches(result.source))
    }
    func testEmptyAndExactEightMiBRemainHashedAndRetirable() throws {
        for size in [0, NativeAttachmentFiles.maximumPlaintextSourceBytes] {
            let bytes = Data(repeating: 0x61, count: size), result = try create(bytes)
            let url = try XCTUnwrap(URL(string: result.source.sourceURI))
            XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(result.source.sha256, digest(bytes))
            XCTAssertEqual(result.source.size, Int64(size)); XCTAssertTrue(result.receipt.matches(result.source))
            XCTAssertEqual(try files.retireProviderSource(result.receipt, checkCancellation: {}), .removed)
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)); XCTAssertTrue(try entries().isEmpty)
        }
    }
    func testOversizedDataRefusesBeforeAnyOutputOnFilesAndJobs() throws {
        let sentinel = cache.appendingPathComponent("foreign-sentinel"), bytes = Data([1, 2, 3])
        try bytes.write(to: sentinel); let before = try identity(sentinel)
        let oversized = Data(repeating: 0x61, count: NativeAttachmentFiles.maximumPlaintextSourceBytes + 1)
        XCTAssertThrowsError(try create(oversized)) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge) }
        let selected = try NativeAttachmentFileJobs(libraryRoot: root); jobs = selected
        XCTAssertThrowsError(try selected.createPlaintextDownloadSource(bytes: oversized, cancellation: .init())) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge)
        }
        XCTAssertEqual(try entries().map(\.lastPathComponent), [sentinel.lastPathComponent])
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes); XCTAssertEqual(try identity(sentinel), before)
        XCTAssertEqual(selected.counters.jobs, 0); XCTAssertEqual(selected.counters.bytes, 0)
    }
    func testAlreadyCancelledCreatorDoesNotOpenAnOutput() throws {
        let token = NativeAttachmentCancellation(); token.cancel()
        XCTAssertThrowsError(try files.createPlaintextDownloadSource(bytes: Data([1]), checkCancellation: token.check)) {
            XCTAssertEqual($0 as? NativeAttachmentFileJobsError, .cancelled)
        }
        let selected = try NativeAttachmentFileJobs(libraryRoot: root); jobs = selected
        XCTAssertThrowsError(try selected.createPlaintextDownloadSource(bytes: Data([1]), cancellation: token)) {
            XCTAssertEqual($0 as? NativeAttachmentFileJobsError, .cancelled)
        }
        XCTAssertTrue(try entries().isEmpty)
    }
    func testCancellationDuringChunkFillRetiresOnlyItsCreatedPartial() throws {
        let token = NativeAttachmentCancellation(), bytes = Data(repeating: 0x62, count: 3 * 64 * 1024)
        var canceledDuringFill = false
        XCTAssertThrowsError(try files.createPlaintextDownloadSource(bytes: bytes, checkCancellation: {
            if !canceledDuringFill, let output = try self.entries().first {
                let size = try self.info(output).st_size
                if size > 0 && size < Int64(bytes.count) { canceledDuringFill = true; token.cancel() }
            }
            try token.check()
        })) { XCTAssertEqual($0 as? NativeAttachmentFileJobsError, .cancelled) }
        XCTAssertTrue(canceledDuringFill); XCTAssertTrue(try entries().isEmpty)
    }
    func testMutableCtimeChangePreservesFullFrozenContentProof() throws {
        var changed = false
        files.beforeProviderOutputNamedStat = { frozen in
            guard !frozen && !changed else { return }
            try self.changeOnlyCtime(XCTUnwrap(self.entries().first)); changed = true
        }
        let bytes = Data("mutable generation".utf8), result = try create(bytes)
        XCTAssertTrue(changed); XCTAssertEqual(result.source.sha256, digest(bytes))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: result.source.sourceURI))), bytes)
        try files.requireProviderSource(result.receipt)
    }
    func testFrozenCtimeChangeRefusesBeforeCachePromotion() throws {
        var changed = false
        files.beforeProviderOutputNamedStat = { frozen in
            guard frozen && !changed else { return }
            try self.changeOnlyCtime(XCTUnwrap(self.entries().first)); changed = true
        }
        XCTAssertThrowsError(try create(Data("frozen generation".utf8))) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, .unavailable)
        }
        XCTAssertTrue(changed); XCTAssertTrue(try entries().isEmpty)
    }
    func testMatchingForeignInodeAtPromotionIsNeitherAdoptedNorUnlinked() throws {
        let bytes = Data("matching foreign bytes".utf8)
        var changed: URL?, displaced: URL?, foreignIdentity: String?, createdIdentity: String?
        files.beforePublish = {
            let output = try XCTUnwrap(self.entries().first); changed = output; createdIdentity = try self.identity(output)
            displaced = try self.replace(output, bytes: bytes); foreignIdentity = try self.identity(output)
        }
        XCTAssertThrowsError(try create(bytes)) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .unavailable) }
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(changed)), bytes)
        XCTAssertEqual(try identity(XCTUnwrap(changed)), try XCTUnwrap(foreignIdentity))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(displaced)), bytes)
        XCTAssertEqual(try identity(XCTUnwrap(displaced)), try XCTUnwrap(createdIdentity))
        XCTAssertNotEqual(foreignIdentity, createdIdentity); XCTAssertEqual(try entries().count, 1)
    }
    func testReplacedCacheAncestorRetainsForeignTreeAndOriginalPartial() throws {
        let bytes = Data("retained anchored bytes".utf8), retainedCache = root.appendingPathComponent("retained-cache", isDirectory: true)
        var created: String?
        files.beforeStageSync = {
            created = try self.identity(XCTUnwrap(self.entries().first))
            try FileManager.default.moveItem(at: self.cache, to: retainedCache)
            try FileManager.default.createDirectory(at: self.cache, withIntermediateDirectories: false)
            try Data("foreign tree".utf8).write(to: self.cache.appendingPathComponent("sentinel"))
        }
        XCTAssertThrowsError(try create(bytes)) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .unavailable) }
        XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("sentinel")), Data("foreign tree".utf8))
        let displaced = try XCTUnwrap(entries(retainedCache).first)
        XCTAssertEqual(try Data(contentsOf: displaced), bytes); XCTAssertEqual(try identity(displaced), try XCTUnwrap(created))
    }
    func testSameByteReplacementCannotUseOriginalReceiptForRetirement() throws {
        let bytes = Data("same-byte replacement".utf8), result = try create(bytes)
        let url = try XCTUnwrap(URL(string: result.source.sourceURI)), retained = try replace(url, bytes: bytes), foreign = try identity(url)
        XCTAssertNotEqual(foreign, result.source.identity)
        XCTAssertThrowsError(try files.requireProviderSource(result.receipt))
        XCTAssertEqual(try files.retireProviderSource(result.receipt, checkCancellation: {}), .generationChanged)
        XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(try identity(url), foreign)
        XCTAssertEqual(try Data(contentsOf: retained), bytes); XCTAssertEqual(try identity(retained), result.source.identity)
    }
    func testSameInodeContentChangeRemainsUnretired() throws {
        let original = Data("original bytes".utf8), changed = Data("modified bytes".utf8), result = try create(original)
        let url = try XCTUnwrap(URL(string: result.source.sourceURI))
        let handle = try FileHandle(forWritingTo: url); try handle.write(contentsOf: changed); try handle.truncate(atOffset: UInt64(changed.count)); try handle.close()
        XCTAssertEqual(try identity(url), result.source.identity)
        XCTAssertThrowsError(try files.requireProviderSource(result.receipt))
        XCTAssertEqual(try files.retireProviderSource(result.receipt, checkCancellation: {}), .generationChanged)
        XCTAssertEqual(try Data(contentsOf: url), changed)
    }
    func testPersistentHardlinkOrSymlinkNeverGrantsReceiptRetirement() throws {
        for hardlink in [false, true] {
            let child = root.appendingPathComponent(hardlink ? "hardlink" : "symlink", isDirectory: true)
            try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false)
            let owner = try NativeAttachmentFiles(libraryRoot: child)
            let result = try owner.createPlaintextDownloadSource(bytes: Data("private inode".utf8), checkCancellation: {})
            let url = try XCTUnwrap(URL(string: result.source.sourceURI)), alias = child.appendingPathComponent("alias")
            if hardlink { try FileManager.default.linkItem(at: url, to: alias) }
            else {
                try FileManager.default.moveItem(at: url, to: alias)
                try FileManager.default.createSymbolicLink(at: url, withDestinationURL: alias)
            }
            XCTAssertThrowsError(try owner.requireProviderSource(result.receipt))
            XCTAssertEqual(try owner.retireProviderSource(result.receipt, checkCancellation: {}), .unsafeEntry)
            XCTAssertEqual(try Data(contentsOf: url), Data("private inode".utf8)); XCTAssertEqual(try Data(contentsOf: alias), Data("private inode".utf8))
        }
    }
    func testJobsReceiptCleanupRequiresCurrentOwnerAndShutdownRefusesFreshCreation() throws {
        let selected = try NativeAttachmentFileJobs(libraryRoot: root); jobs = selected
        let bytes = Data("live cleanup".utf8), token = NativeAttachmentCancellation()
        let result = try selected.createPlaintextDownloadSource(bytes: bytes, cancellation: token)
        token.cancel() // Successful creation knowledge must survive later cancellation.
        let url = try XCTUnwrap(URL(string: result.source.sourceURI)), before = try identity(url)
        selected.drain()
        XCTAssertThrowsError(try selected.retireProviderSource(result.receipt, requireOwner: { throw FixtureFault.refused }))
        XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(try identity(url), before)
        var checked = 0
        XCTAssertEqual(try selected.retireProviderSource(result.receipt, requireOwner: { checked += 1 }), .removed)
        XCTAssertGreaterThan(checked, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(try selected.retireProviderSource(result.receipt, requireOwner: {}), .absent)
        XCTAssertEqual(selected.counters.jobs, 0); XCTAssertEqual(selected.counters.bytes, 0)
        selected.shutdown()
        XCTAssertThrowsError(try selected.createPlaintextDownloadSource(bytes: bytes, cancellation: .init())) {
            XCTAssertEqual($0 as? NativeAttachmentFileJobsError, .unavailable)
        }
        XCTAssertTrue(try entries().isEmpty)
    }
    func testColdDroppedReceiptIsRetainedWithoutAutomaticAdoptionOrDeletion() throws {
        let bytes = Data("unknown pre-intent plaintext".utf8)
        let descriptor = try { () throws -> NativeAttachmentFiles.CacheSourceProof in
            let temporary = try NativeAttachmentFileJobs(libraryRoot: root)
            let result = try temporary.createPlaintextDownloadSource(bytes: bytes, cancellation: .init())
            temporary.shutdown()
            return result.source // Creation receipt intentionally does not survive this scope.
        }()
        let url = try XCTUnwrap(URL(string: descriptor.sourceURI)), before = try identity(url)
        let cold = try NativeAttachmentFileJobs(libraryRoot: root); jobs = cold
        cold.drain()
        XCTAssertEqual(try entries().count, 1); XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(try identity(url), before)
        XCTAssertEqual(cold.counters.jobs, 0); XCTAssertEqual(cold.counters.bytes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("core.sqlite.pending.json").path))
    }
}
