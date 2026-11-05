import XCTest
import Foundation
import Darwin
import CryptoKit
import AttachmentFileInstallerEngine
@testable import MindwtrNativeCore

final class NativeVoiceRecordingFilesTests: XCTestCase {
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private enum FixtureError: Error { case failed }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    override func setUpWithError() throws {
        let support = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let fixture = support.appendingPathComponent("NativeVoiceRecordingFilesTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw FixtureError.failed }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func entries(_ directory: URL? = nil) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory ?? cache, includingPropertiesForKeys: nil)
    }
    private func identity(_ url: URL) throws -> String {
        var value = stat(); guard Darwin.lstat(url.path, &value) == 0 else { throw FixtureError.failed }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func write(_ reservation: NativeAttachmentFiles.VoiceRecordingReservation, bytes: Data) throws -> URL {
        try files.withVoiceRecordingURL(reservation, discard: { _ in }) { url in
            let writer = try FileHandle(forWritingTo: url)
            do { try writer.write(contentsOf: bytes); try writer.truncate(atOffset: UInt64(bytes.count)); try writer.close() }
            catch { try? writer.close(); throw error }
            return url
        }
    }
    private func finish(_ reservation: NativeAttachmentFiles.VoiceRecordingReservation) throws
        -> (receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt, source: NativeAttachmentFiles.CacheSourceProof) {
        try files.finishVoiceRecording(reservation, maximumBytes: NativeVoiceRecorder.maximumAudioBytes)
    }
    /// Diagnostic fixture wrapper only. Retain an independent descriptor and
    /// compare fixed stat fields across a refusal, without paths or contents.
    private func probe<T>(_ stage: String, url: URL, expected: NativeAttachmentFilesError? = nil,
                          _ operation: () throws -> T) throws -> T {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw FixtureError.failed }
        defer { Darwin.close(fd) }
        var beforeFD = stat(), beforeName = stat()
        guard Darwin.fstat(fd, &beforeFD) == 0, Darwin.lstat(url.path, &beforeName) == 0 else { throw FixtureError.failed }
        let started = ProcessInfo.processInfo.systemUptime
        do { return try operation() }
        catch {
            if let expected, error as? NativeAttachmentFilesError == expected { throw error }
            var afterFD = stat(), afterName = stat()
            let hasFD = Darwin.fstat(fd, &afterFD) == 0, hasName = Darwin.lstat(url.path, &afterName) == 0
            let elapsed = Int((ProcessInfo.processInfo.systemUptime - started) * 1_000)
            let category = error is NativeAttachmentFilesError ? "attachment" : "other"
            XCTFail("voice-file-probe stage=\(stage) elapsedMs=\(elapsed) category=\(category) fdAvailable=\(hasFD) nameAvailable=\(hasName) beforeFDToName=\(statChanges(beforeFD, beforeName)) fdDelta=\(hasFD ? statChanges(beforeFD, afterFD) : "absent") nameDelta=\(hasName ? statChanges(beforeName, afterName) : "absent") afterFDToName=\(hasFD && hasName ? statChanges(afterFD, afterName) : "absent")")
            throw error
        }
    }
    private func statChanges(_ first: stat, _ next: stat) -> String {
        var fields: [String] = []
        if first.st_dev != next.st_dev { fields.append("device") }
        if first.st_ino != next.st_ino { fields.append("inode") }
        if first.st_size != next.st_size { fields.append("size") }
        if first.st_mode != next.st_mode { fields.append("mode") }
        if first.st_nlink != next.st_nlink { fields.append("links") }
        if first.st_mtimespec.tv_sec != next.st_mtimespec.tv_sec || first.st_mtimespec.tv_nsec != next.st_mtimespec.tv_nsec {
            fields.append("mtime")
        }
        if first.st_ctimespec.tv_sec != next.st_ctimespec.tv_sec || first.st_ctimespec.tv_nsec != next.st_ctimespec.tv_nsec {
            fields.append("ctime")
        }
        return fields.isEmpty ? "unchanged" : fields.joined(separator: ",")
    }

    func testReservationIsSelectedPrivateSingleLinkCacheInodeAndFreezesExistingReceipt() throws {
        let reservation = try files.reserveVoiceRecording(), bytes = Data("synthetic m4a bytes".utf8)
        let url = try write(reservation, bytes: bytes)
        var value = stat(); XCTAssertEqual(Darwin.lstat(url.path, &value), 0)
        XCTAssertEqual(url.deletingLastPathComponent(), cache); XCTAssertEqual(url.pathExtension, "m4a")
        XCTAssertNotNil(UUID(uuidString: url.deletingPathExtension().lastPathComponent))
        XCTAssertEqual(value.st_mode & 0o777, 0o600); XCTAssertEqual(value.st_nlink, 1)
        XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try files.voiceRecordingSize(reservation), Int64(bytes.count))
        let frozen = try finish(reservation)
        XCTAssertEqual(frozen.source.identity, try identity(url)); XCTAssertEqual(frozen.source.cacheRootIdentity, try identity(cache))
        XCTAssertEqual(frozen.source.parentIdentity, frozen.source.cacheRootIdentity)
        XCTAssertEqual(frozen.source.sha256, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(frozen.source.size, Int64(bytes.count)); XCTAssertTrue(frozen.receipt.matches(frozen.source))
        XCTAssertEqual(frozen.receipt.mimeType, "audio/mp4"); XCTAssertEqual(frozen.receipt.fileName, url.lastPathComponent)
        try files.requireProviderSource(frozen.receipt)
        XCTAssertThrowsError(try finish(reservation)); XCTAssertThrowsError(try files.cancelVoiceRecording(reservation))
        XCTAssertEqual(try files.retireProviderSource(frozen.receipt, checkCancellation: {}), .removed)
    }

    func testCandidateRecordingPublishesFromRNCacheIntoRNManagedRootAndColdVerifies() throws {
        let container = root.appendingPathComponent("candidate", isDirectory: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Library"), withIntermediateDirectories: false)
        let voice = try NativeVoiceFiles(rnAdoptionContainerURL: container)
        let reservation = try voice.files.reserveVoiceRecording(), bytes = Data("candidate synthetic m4a".utf8)
        let sourceURL = try voice.files.withVoiceRecordingURL(reservation, discard: { _ in }) { url in
            let writer = try FileHandle(forWritingTo: url)
            try writer.write(contentsOf: bytes); try writer.truncate(atOffset: UInt64(bytes.count)); try writer.close()
            return url
        }
        XCTAssertEqual(sourceURL.deletingLastPathComponent(), container.appendingPathComponent("Library/Caches", isDirectory: true))
        let source = try voice.files.finishVoiceRecording(reservation, maximumBytes: NativeVoiceRecorder.maximumAudioBytes)
        let target = container.appendingPathComponent("Documents/attachments", isDirectory: true).appendingPathComponent(UUID().uuidString.lowercased() + ".m4a")
        var settlement = NativeVoiceFileSettlement(source: .init(source.source), targetURI: target.absoluteString,
            operationID: UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))
        settlement.stage = try voice.reserve(settlement)
        try voice.publish(settlement); try voice.publish(settlement)
        let cold = try NativeVoiceFiles(rnAdoptionContainerURL: container)
        try cold.verify(settlement)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try entries(target.deletingLastPathComponent()).filter { $0.pathExtension == "m4a" }, [target])
        XCTAssertThrowsError(try cold.files.snapshotCacheSource(target.absoluteString))
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.appendingPathComponent("Documents/SQLite/attachment-files").path))
        XCTAssertEqual(try voice.files.retireProviderSource(source.receipt, checkCancellation: {}), .removed)
    }

    func testCandidateVoiceWrapperCannotRecaptureReplacedCacheAuthority() throws {
        let container = root.appendingPathComponent("candidate", isDirectory: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Library"), withIntermediateDirectories: false)
        let port = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
        let cache = container.appendingPathComponent("Library/Caches", isDirectory: true)
        let held = container.appendingPathComponent("held-cache", isDirectory: true)
        try FileManager.default.moveItem(at: cache, to: held)
        try FileManager.default.copyItem(at: held, to: cache)
        XCTAssertThrowsError(try NativeVoiceFiles(files: port))
        XCTAssertThrowsError(try port.reserveVoiceRecording())
        XCTAssertEqual(try entries(cache), [])
    }
    func testAnotherSelectedLibraryCannotBorrowReservationAndOriginalRemainsUsable() throws {
        let otherRoot = root.appendingPathComponent("other-library", isDirectory: true)
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: false)
        let other = try NativeAttachmentFiles(libraryRoot: otherRoot), reservation = try files.reserveVoiceRecording()
        let url = try write(reservation, bytes: Data("selected".utf8))
        XCTAssertThrowsError(try other.voiceRecordingSize(reservation))
        XCTAssertThrowsError(try other.cancelVoiceRecording(reservation))
        XCTAssertThrowsError(try other.finishVoiceRecording(reservation, maximumBytes: 100))
        XCTAssertEqual(try Data(contentsOf: url), Data("selected".utf8))
        XCTAssertEqual(try files.cancelVoiceRecording(reservation), .removed)
    }
    func testCancelledReservationRemovesOnlyCreatedSourceAndNoManagedDirectory() throws {
        let sentinel = cache.appendingPathComponent("sentinel"); try Data("keep".utf8).write(to: sentinel)
        let reservation = try files.reserveVoiceRecording(); _ = try write(reservation, bytes: Data("discard".utf8))
        XCTAssertEqual(try files.cancelVoiceRecording(reservation), .removed)
        XCTAssertEqual(try entries(), [sentinel]); XCTAssertEqual(try Data(contentsOf: sentinel), Data("keep".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
    }
    func testDroppedReservationDoesNotInferDeletionOrAdoptionAuthority() throws {
        let url = try { () throws -> URL in
            let reservation = try files.reserveVoiceRecording()
            return try write(reservation, bytes: Data("unclaimed recording".utf8))
        }()
        XCTAssertEqual(try Data(contentsOf: url), Data("unclaimed recording".utf8))
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        XCTAssertEqual(try entries().count, 1); XCTAssertEqual(cold.sourceRoots.last, cache)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
    }
    func testStoppedRawSizeIsBoundedBeforeHashAndOversizedSourceIsExactlyCancellable() throws {
        let invalid = try files.reserveVoiceRecording()
        let invalidURL = try files.withVoiceRecordingURL(invalid, discard: { _ in }) { $0 }
        for limit in [0, NativeVoiceRecorder.maximumAudioBytes + 1] {
            XCTAssertThrowsError(try files.finishVoiceRecording(invalid, maximumBytes: limit)) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
        }
        _ = try probe("invalid.cancel", url: invalidURL) { try files.cancelVoiceRecording(invalid) }
        for size in [NativeVoiceRecorder.maximumAudioBytes, NativeVoiceRecorder.maximumAudioBytes + 1] {
            let reservation = try files.reserveVoiceRecording()
            let url = try write(reservation, bytes: Data(repeating: 0x5a, count: size))
            if size == NativeVoiceRecorder.maximumAudioBytes {
                let frozen = try probe("exact.finish", url: url) { try finish(reservation) }
                XCTAssertEqual(frozen.source.size, Int64(size))
                let outcome = try probe("exact.retire", url: url) {
                    try files.retireProviderSource(frozen.receipt, checkCancellation: {})
                }
                XCTAssertEqual(outcome, .removed)
            } else {
                XCTAssertThrowsError(try probe("oversized.finish", url: url, expected: .tooLarge) { try finish(reservation) }) {
                    XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge)
                }
                let outcome = try probe("oversized.cancel", url: url) { try files.cancelVoiceRecording(reservation) }
                XCTAssertEqual(outcome, .removed)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        }
    }
    func testChangedInodeIsNeitherFrozenNorDeletedEvenWithSameBytes() throws {
        let reservation = try files.reserveVoiceRecording(), bytes = Data("same bytes".utf8)
        let url = try write(reservation, bytes: bytes), original = root.appendingPathComponent("original")
        let created = try identity(url)
        try FileManager.default.moveItem(at: url, to: original); try bytes.write(to: url)
        let replacement = try identity(url); XCTAssertNotEqual(created, replacement)
        XCTAssertThrowsError(try finish(reservation)); XCTAssertThrowsError(try files.cancelVoiceRecording(reservation))
        XCTAssertEqual(try identity(url), replacement); XCTAssertEqual(try identity(original), created)
        XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(try Data(contentsOf: original), bytes)
    }
    func testChangedCacheAncestorRetainsBothOriginalRecordingAndForeignTree() throws {
        let reservation = try files.reserveVoiceRecording(), bytes = Data("anchored recording".utf8)
        let url = try write(reservation, bytes: bytes), retained = root.appendingPathComponent("retained-cache", isDirectory: true)
        try FileManager.default.moveItem(at: cache, to: retained)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: false)
        let foreign = cache.appendingPathComponent(url.lastPathComponent); try Data("foreign".utf8).write(to: foreign)
        XCTAssertThrowsError(try finish(reservation)); XCTAssertThrowsError(try files.cancelVoiceRecording(reservation))
        XCTAssertEqual(try Data(contentsOf: foreign), Data("foreign".utf8))
        XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent(url.lastPathComponent)), bytes)
    }
    func testFinalUnlinkRechecksReplacedGenerationAfterHook() throws {
        let reservation = try files.reserveVoiceRecording(), url = try write(reservation, bytes: Data("created".utf8))
        let retained = root.appendingPathComponent("retained-created")
        files.beforeRetirementUnlink = {
            try FileManager.default.moveItem(at: url, to: retained)
            try Data("foreign".utf8).write(to: url)
        }
        XCTAssertThrowsError(try files.cancelVoiceRecording(reservation))
        XCTAssertEqual(try Data(contentsOf: url), Data("foreign".utf8))
        XCTAssertEqual(try Data(contentsOf: retained), Data("created".utf8))
    }
    func testHardlinkAndSymlinkRefuseFreezeAndCleanup() throws {
        for hardlink in [true, false] {
            let reservation = try files.reserveVoiceRecording(), bytes = Data("recording".utf8)
            let url = try write(reservation, bytes: bytes), alias = root.appendingPathComponent(UUID().uuidString)
            if hardlink { try FileManager.default.linkItem(at: url, to: alias) }
            else {
                try FileManager.default.moveItem(at: url, to: alias)
                try FileManager.default.createSymbolicLink(at: url, withDestinationURL: alias)
            }
            XCTAssertThrowsError(try finish(reservation)); XCTAssertThrowsError(try files.cancelVoiceRecording(reservation))
            XCTAssertEqual(try Data(contentsOf: url), bytes); XCTAssertEqual(try Data(contentsOf: alias), bytes)
        }
    }
    func testFrozenRecordingUsesExistingStageFillPublishAndVerificationWithoutDeletingManagedFile() throws {
        let reservation = try files.reserveVoiceRecording(), bytes = Data("stopped AAC fixture".utf8)
        _ = try write(reservation, bytes: bytes); let frozen = try finish(reservation)
        _ = try files.ensureManagedDirectoryProof(checkCancellation: {})
        let target = files.managedRoot.appendingPathComponent(UUID().uuidString.lowercased() + ".m4a")
        let installer = try AttachmentFileInstaller(targetRoot: files.managedRoot, sourceRoots: files.sourceRoots)
        let stage = try installer.prepareImmutableStage(targetInput: target,
            operationId: UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))
        let proof = NativeAttachmentFiles.ReservedAttachmentStageProof(stageURI: stage.stagedUrl.absoluteString,
            stagedIdentity: stage.stagedIdentity, directoryIdentity: stage.directoryIdentity,
            privateDirectoryIdentity: stage.privateDirectoryIdentity)
        let filled = try files.fillReservedAttachmentStage(sourceProof: frozen.source, stageProof: proof)
        XCTAssertEqual(filled.sha256, frozen.source.sha256); XCTAssertEqual(filled.size, frozen.source.size)
        let published = try installer.publishImmutable(stagedInput: stage.stagedUrl, targetInput: target,
            expectedStagedSha256: filled.sha256, expectedStagedIdentity: stage.stagedIdentity,
            expectedDirectoryIdentity: stage.directoryIdentity, expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity)
        guard case .published = published else { return XCTFail("Expected existing exclusive publication") }
        let verified = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: proof,
            sha256: filled.sha256, size: filled.size)
        XCTAssertEqual(verified.sha256, frozen.source.sha256); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try files.retireProviderSource(frozen.receipt, checkCancellation: {}), .removed)
        XCTAssertEqual(try Data(contentsOf: target), bytes, "Source retirement must not retire a potentially adopted managed file")
    }
}
