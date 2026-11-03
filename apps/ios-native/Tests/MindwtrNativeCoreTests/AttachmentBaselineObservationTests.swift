import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore


final class AttachmentBaselineObservationTests: XCTestCase {
    private typealias Observation = NativeAttachmentFiles.BaselineAttachmentObservation
    private enum Cancelled: Error { case stopped }
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var documents: URL!
    private var cache: URL!
    private let attachmentID = "historical-import-7"

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task253-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        let directories = try object(files.directoriesJSON)
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"] as? String)))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))

    }
    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func token(_ url: URL) throws -> String {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func managed() throws -> URL {
        let directory = try XCTUnwrap(files).managedRoot
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        }
        return directory
    }
    private func target(_ name: String? = nil, bytes: Data = Data("Current bytes + 世界".utf8)) throws -> URL {
        let file = try managed().appendingPathComponent(name ?? attachmentID + ".old-extension")
        try bytes.write(to: file); return file
    }
    @discardableResult
    private func observe(_ target: URL, id: String? = nil, check: () throws -> Void = {}) throws -> Observation {
        try files.snapshotBaselineAttachment(attachmentID: id ?? attachmentID,
            targetURI: target.absoluteString, checkCancellation: check)
    }
    private func refused(_ work: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertNotNil($0 as? NativeAttachmentFilesError, file: file, line: line)
            XCTAssertFalse($0.localizedDescription.contains(self.attachmentID), file: file, line: line)
            XCTAssertFalse($0.localizedDescription.contains("file:///"), file: file, line: line)
        }
    }
    private func replaceExact(_ url: URL) throws -> URL {
        let held = root.appendingPathComponent("held-" + UUID().uuidString)
        let bytes = try Data(contentsOf: url), original = try token(url)
        try FileManager.default.moveItem(at: url, to: held); try bytes.write(to: url)
        XCTAssertNotEqual(try token(url), original); return held
    }

    func testPresentHistoricalNonUUIDFlatNamesMeasureCurrentBytesWithoutTitleExtensionPolicy() throws {
        for name in [attachmentID, attachmentID + ".previous.archive"] {
            let bytes = Data("Measured current generation / 文 / \(name)".utf8), file = try target(name, bytes: bytes)
            let before = try token(file), directory = try token(files.managedRoot)
            guard case .present(let proof) = try observe(file) else { return XCTFail("Expected present generation") }
            XCTAssertEqual(proof.targetURI, file.absoluteString); XCTAssertEqual(proof.sha256, digest(bytes))
            XCTAssertEqual(proof.size, Int64(bytes.count)); XCTAssertEqual(proof.identity, before)
            XCTAssertEqual(proof.directoryIdentity, directory)
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), before)
        }
    }

    func testEmptyAndStreamingAboveBridgeByteLimitReturnOnlyMeasuredProof() throws {
        for bytes in [Data(), Data(repeating: 0x71, count: 17 * 1024 * 1024)] {
            let file = try target(bytes: bytes), identity = try token(file)
            guard case .present(let proof) = try observe(file) else { return XCTFail("Expected measured generation") }
            XCTAssertEqual(proof.sha256, digest(bytes)); XCTAssertEqual(proof.size, Int64(bytes.count))
            XCTAssertEqual(proof.identity, identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
    }

    func testNeverCreatedManagedDirectoryIsPositiveNoOwnedGenerationAndCreatesNothing() throws {
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt"), identity = try token(documents)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertEqual(try observe(file), .noOwnedGeneration(targetURI: file.absoluteString,
            absence: .managedDirectoryAbsent(documentsIdentity: identity)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertEqual(try token(documents), identity); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: documents.path), [])
    }

    func testAbsentLeafBindsExistingManagedDirectoryWithoutCreatingLeaf() throws {
        let directory = try managed(), file = directory.appendingPathComponent(attachmentID + ".txt"), identity = try token(directory)
        XCTAssertEqual(try observe(file), .noOwnedGeneration(targetURI: file.absoluteString,
            absence: .leafAbsent(directoryIdentity: identity)))
        XCTAssertEqual(try token(directory), identity); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testLaterDirectoryOrLeafAppearanceCannotChangeCapturedNoDeleteRightsObservation() throws {
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt")
        let directoryAbsent = try observe(file), documentIdentity = try token(documents)
        _ = try managed(); let leafAbsent = try observe(file), directoryIdentity = try token(files.managedRoot)
        let bytes = Data("Later foreign generation must remain".utf8); try bytes.write(to: file)
        let identity = try token(file)
        XCTAssertEqual(directoryAbsent, .noOwnedGeneration(targetURI: file.absoluteString,
            absence: .managedDirectoryAbsent(documentsIdentity: documentIdentity)))
        XCTAssertEqual(leafAbsent, .noOwnedGeneration(targetURI: file.absoluteString,
            absence: .leafAbsent(directoryIdentity: directoryIdentity)))
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), identity)
    }

    func testUnmanagedProviderCacheSiblingNestedAndWrongIDPathsNeedNoTargetIO() throws {
        let directory = try managed(), fifo = cache.appendingPathComponent(attachmentID + ".txt")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, mode_t(0o600)), 0)
        let fifoIdentity = try token(fifo), sibling = root.appendingPathComponent("picked", isDirectory: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: false)
        let external = sibling.appendingPathComponent(attachmentID + ".txt"), bytes = Data("Picked untouched".utf8)
        try bytes.write(to: external)
        let nested = directory.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
        let urls = [fifo, external, documents.appendingPathComponent(attachmentID + ".txt"),
            nested.appendingPathComponent(attachmentID + ".txt"), directory.appendingPathComponent(attachmentID + "other.txt")]
        for url in urls { XCTAssertEqual(try observe(url), .unmanaged(targetURI: url.absoluteString)) }
        for uri in ["content://android.provider/documents/17", "https://example.invalid/file?credential=private", "data:text/plain,provider"] {
            XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: uri), .unmanaged(targetURI: uri))
        }
        XCTAssertEqual(try token(fifo), fifoIdentity); XCTAssertEqual(try Data(contentsOf: external), bytes)


        let held = root.appendingPathComponent("held-documents")
        try FileManager.default.moveItem(at: documents, to: held)
        defer { try? FileManager.default.moveItem(at: held, to: documents) }
        XCTAssertEqual(try observe(fifo), .unmanaged(targetURI: fifo.absoluteString))
        XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: "content://provider/1"),
            .unmanaged(targetURI: "content://provider/1"))
    }

    func testIDBoundUsesJSUTF16CountAndFilenameComparisonUsesExactBytes() throws {
        let uri = cache.appendingPathComponent("unmanaged").absoluteString
        for id in [String(repeating: "é", count: 500), String(repeating: "😀", count: 250), "old/path", ".", "historical item"] {
            XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: id, targetURI: uri), .unmanaged(targetURI: uri))
        }
        for id in ["", "bad\0id", String(repeating: "a", count: 501), String(repeating: "😀", count: 251)] {
            XCTAssertThrowsError(try files.snapshotBaselineAttachment(attachmentID: id, targetURI: uri)) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
        }
        let file = try target("é.txt"), identity = try token(file)


        let parent = files.managedRoot.absoluteString
        XCTAssertTrue(parent.hasSuffix("/"))
        let composedURI = parent + "%C3%A9.txt", decomposedURI = parent + "e%CC%81.txt"
        let composedPath = try XCTUnwrap(URLComponents(string: composedURI)?.percentEncodedPath)
        let decomposedPath = try XCTUnwrap(URLComponents(string: decomposedURI)?.percentEncodedPath)
        XCTAssertTrue(composedPath.hasSuffix("%C3%A9.txt")); XCTAssertTrue(decomposedPath.hasSuffix("e%CC%81.txt"))
        XCTAssertEqual(Array(try XCTUnwrap(composedPath.removingPercentEncoding).utf8.suffix("é.txt".utf8.count)), Array("é.txt".utf8))
        XCTAssertEqual(Array(try XCTUnwrap(decomposedPath.removingPercentEncoding).utf8.suffix("e\u{301}.txt".utf8.count)), Array("e\u{301}.txt".utf8))
        XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: "e\u{301}", targetURI: composedURI), .unmanaged(targetURI: composedURI))
        XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: "é", targetURI: decomposedURI), .unmanaged(targetURI: decomposedURI))
        XCTAssertEqual(try token(file), identity)
    }

    func testTrailingDoubledAndEncodedSlashPathsAreUnmanagedWithoutReadingEligibleFile() throws {
        let file = try target(), bytes = try Data(contentsOf: file), identity = try token(file)
        for uri in [file.absoluteString + "/", file.absoluteString.replacingOccurrences(of: "/attachments/", with: "/attachments//"),
                    file.absoluteString.replacingOccurrences(of: "/attachments/", with: "/attachments/%2F"),
                    file.absoluteString + "%2F"] {
            XCTAssertEqual(try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: uri), .unmanaged(targetURI: uri))
        }
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), identity)
    }

    func testMalformedFileURIRefusesWithoutCreatingManagedDirectory() throws {
        let uri = files.managedRoot.appendingPathComponent(attachmentID + ".txt").absoluteString
        for invalid in ["", "relative/path", "file://foreign.invalid/path", uri + "?value=1", uri + "#fragment",
                        uri.replacingOccurrences(of: "/attachments/", with: "/attachments/../"), "file:///bad%00name",
                        "file:///bad\0name", "file://[broken", String(repeating: "x", count: 16 * 1024 + 1)] {
            XCTAssertThrowsError(try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: invalid)) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
    }

    func testDirectoryAndLeafAppearanceDuringAbsentObservationRefuseWithoutAdoptingBytes() throws {
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt"), bytes = Data("New entry during callback".utf8)
        var callbacks = 0
        refused { _ = try self.observe(file) {
            callbacks += 1
            if callbacks == 2 { _ = try self.managed(); try bytes.write(to: file) }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: file), bytes)
        try FileManager.default.removeItem(at: file); callbacks = 0
        refused { _ = try self.observe(file) {
            callbacks += 1
            if callbacks == 2 { try bytes.write(to: file) }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testKnownDocumentsMissingOrReplacedRefusesInsteadOfPositiveDirectoryAbsence() throws {
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt"), held = root.appendingPathComponent("held-documents")
        try FileManager.default.moveItem(at: documents, to: held)
        defer { try? FileManager.default.removeItem(at: documents); try? FileManager.default.moveItem(at: held, to: documents) }
        refused { _ = try self.observe(file) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.path))
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: false)
        refused { _ = try self.observe(file) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: documents.path), [])
    }

    func testSameContentInodeReplacementDuringPresentObservationRefusesAndKeepsBothFiles() throws {
        let file = try target(), bytes = try Data(contentsOf: file), original = try token(file)
        var callbacks = 0, held: URL?
        refused { _ = try self.observe(file) {
            callbacks += 1
            if callbacks == 2 { held = try self.replaceExact(file) }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(held)), bytes); XCTAssertEqual(try token(XCTUnwrap(held)), original)
    }

    func testManagedAndKnownAncestorReplacementDuringPresentObservationRefuse() throws {
        for level in ["managed", "documents", "namespace"] {
            let file = try target(), bytes = try Data(contentsOf: file)
            let directory = level == "managed" ? files.managedRoot : level == "documents" ? try XCTUnwrap(documents) : root.appendingPathComponent("attachment-files")
            let held = root.appendingPathComponent("held-" + level), suffix = level == "managed" ? file.lastPathComponent
                : level == "documents" ? "attachments/" + file.lastPathComponent : "documents/attachments/" + file.lastPathComponent
            var callbacks = 0
            refused { _ = try self.observe(file) {
                callbacks += 1
                if callbacks == 2 {
                    try FileManager.default.moveItem(at: directory, to: held)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                }
            } }
            XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent(suffix)), bytes)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
            try FileManager.default.removeItem(at: directory); try FileManager.default.moveItem(at: held, to: directory)
        }
    }

    func testEarlierHashedChunkAndFinalCallbackInPlaceMutationRefuse() throws {
        for mutateAt in [4, 7] {
            let bytes = Data(repeating: 0x73, count: 3 * 64 * 1024), file = try target(bytes: bytes), identity = try token(file)
            var callbacks = 0, changed = bytes; changed[0] = 0x58
            refused { _ = try self.observe(file) {
                callbacks += 1
                if callbacks == mutateAt {
                    let fd = Darwin.open(file.path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC)
                    guard fd >= 0 else { throw NativeAttachmentFilesError.unavailable }
                    defer { Darwin.close(fd) }
                    var byte: UInt8 = 0x58; XCTAssertEqual(Darwin.write(fd, &byte, 1), 1)
                }
            } }
            XCTAssertEqual(callbacks, mutateAt); XCTAssertEqual(try token(file), identity)
            XCTAssertEqual(try Data(contentsOf: file), changed)
        }
    }

    func testKnownManagedDirectoryDisappearanceDuringPresentObservationIsNotPositiveAbsence() throws {
        let file = try target(), bytes = try Data(contentsOf: file), held = root.appendingPathComponent("held-managed")
        var callbacks = 0
        refused { _ = try self.observe(file) {
            callbacks += 1
            if callbacks == 2 { try FileManager.default.moveItem(at: self.files.managedRoot, to: held) }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent(file.lastPathComponent)), bytes)
    }

    func testSymlinkFIFOFolderAndMultilinkReturnUnsafeWithoutReadingOrMutation() throws {
        let directory = try managed(), external = root.appendingPathComponent("external"), bytes = Data("External sentinel".utf8)
        try bytes.write(to: external)
        for kind in ["symlink", "fifo", "directory", "hardlink"] {
            let file = directory.appendingPathComponent(attachmentID + "." + kind)
            switch kind {
            case "symlink": try FileManager.default.createSymbolicLink(at: file, withDestinationURL: external)
            case "fifo": XCTAssertEqual(Darwin.mkfifo(file.path, mode_t(0o600)), 0)
            case "directory": try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
            default: XCTAssertEqual(Darwin.link(external.path, file.path), 0)
            }
            let identity = try token(file)
            XCTAssertEqual(try observe(file), .unsafeEntry(targetURI: file.absoluteString))
            XCTAssertEqual(try token(file), identity); XCTAssertEqual(try Data(contentsOf: external), bytes)
            if kind == "directory" { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.path), []) }
        }
    }

    func testUnsafeEntryReplacementAndPresentHardlinkAppearanceDuringCallbackRefuse() throws {
        let directory = try managed(), fifo = directory.appendingPathComponent(attachmentID + ".fifo"), held = root.appendingPathComponent("held-fifo")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, mode_t(0o600)), 0); let identity = try token(fifo)
        var callbacks = 0
        refused { _ = try self.observe(fifo) {
            callbacks += 1
            if callbacks == 2 {
                try FileManager.default.moveItem(at: fifo, to: held); try Data("Replacement".utf8).write(to: fifo)
            }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try token(held), identity)
        XCTAssertEqual(try Data(contentsOf: fifo), Data("Replacement".utf8))
        let file = try target(), bytes = try Data(contentsOf: file), alias = root.appendingPathComponent("new-alias")
        callbacks = 0
        refused { _ = try self.observe(file) {
            callbacks += 1
            if callbacks == 2 { XCTAssertEqual(Darwin.link(file.path, alias.path), 0) }
        } }
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: alias), bytes)
    }

    func testNonDirectoryManagedNamespaceRefusesWithoutUnsafeLeafOrAbsenceClaim() throws {
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt"), external = root.appendingPathComponent("external-root")
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: files.managedRoot, withDestinationURL: external)
        let identity = try token(files.managedRoot)
        refused { _ = try self.observe(file) }
        XCTAssertEqual(try token(files.managedRoot), identity); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: external.path), [])
        try FileManager.default.removeItem(at: files.managedRoot); try Data("Not a directory".utf8).write(to: files.managedRoot)
        refused { _ = try self.observe(file) }
        XCTAssertEqual(try Data(contentsOf: files.managedRoot), Data("Not a directory".utf8))
    }

    func testCancellationDuringPresentAndAbsentObservationRetainsBytesAndCreatesNothing() throws {
        let missing = files.managedRoot.appendingPathComponent(attachmentID + ".missing")
        var callbacks = 0
        XCTAssertThrowsError(try observe(missing) { callbacks += 1; if callbacks == 2 { throw Cancelled.stopped } }) {
            XCTAssertTrue($0 is Cancelled)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        let file = try target(bytes: Data(repeating: 0x71, count: 3 * 64 * 1024)), bytes = try Data(contentsOf: file), identity = try token(file)
        callbacks = 0
        XCTAssertThrowsError(try observe(file) { callbacks += 1; if callbacks == 4 { throw Cancelled.stopped } }) {
            XCTAssertTrue($0 is Cancelled)
        }
        XCTAssertEqual(callbacks, 4); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), identity)
        guard case .present(let proof) = try observe(file) else { return XCTFail("Retry must independently observe present generation") }
        XCTAssertEqual(proof.sha256, digest(bytes))
    }

    func testTypedSnapshotUsesSharedFIFOExactMailboxAndBoundedPresentShape() throws {
        let file = try target(), bytes = try Data(contentsOf: file), identity = try token(file)
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        var execution: [String] = []
        jobs.beforeWork = { id, installer in XCTAssertFalse(installer); execution.append(id) }
        let first = try jobs.submit("{\"op\":\"barrier\"}")
        let typed = try jobs.submitDraft(.snapshotBaseline(attachmentID: attachmentID, targetURI: file.absoluteString))
        let last = try jobs.submit("{\"op\":\"barrier\"}"); jobs.drain()
        XCTAssertEqual(execution, [first, typed, last]); XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(try object(jobs.next())["id"] as? String, first)
        XCTAssertEqual(try object(jobs.next())["id"] as? String, last); XCTAssertEqual(jobs.next(), "")
        let encoded = jobs.takeDraft(typed), answer = try object(encoded), value = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertLessThan(encoded.utf8.count, 1024); XCTAssertEqual(Set(answer.keys), Set(["id", "value"]))
        XCTAssertEqual(answer["id"] as? String, typed)
        XCTAssertEqual(Set(value.keys), Set(["kind", "targetURI", "sha256", "size", "identity", "directoryIdentity"]))
        XCTAssertEqual(value["kind"] as? String, "present"); XCTAssertEqual(value["targetURI"] as? String, file.absoluteString)
        XCTAssertEqual(value["sha256"] as? String, digest(bytes)); XCTAssertEqual((value["size"] as? NSNumber)?.int64Value, Int64(bytes.count))
        XCTAssertEqual(value["identity"] as? String, identity); XCTAssertEqual(value["directoryIdentity"] as? String, try token(files.managedRoot))
        XCTAssertEqual(jobs.takeDraft(typed), ""); XCTAssertEqual(jobs.body(), "")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), identity)
    }

    func testTypedAbsentUnmanagedAndUnsafeShapesRemainExplicitWithoutByteBodies() throws {
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        let file = files.managedRoot.appendingPathComponent(attachmentID + ".txt")
        func result(_ uri: String) throws -> [String: Any] {
            let id = try jobs.submitDraft(.snapshotBaseline(attachmentID: attachmentID, targetURI: uri)); jobs.drain()
            let answer = try object(jobs.takeDraft(id)); XCTAssertEqual(Set(answer.keys), Set(["id", "value"]))
            XCTAssertEqual(answer["id"] as? String, id); XCTAssertEqual(jobs.body(), "")
            return try XCTUnwrap(answer["value"] as? [String: Any])
        }
        let directoryMissing = try result(file.absoluteString)
        XCTAssertEqual(Set(directoryMissing.keys), Set(["kind", "targetURI", "absence"]))
        XCTAssertEqual(directoryMissing["kind"] as? String, "noOwnedGeneration")
        XCTAssertEqual(directoryMissing["targetURI"] as? String, file.absoluteString)
        let directoryAbsence = try XCTUnwrap(directoryMissing["absence"] as? [String: Any])
        XCTAssertEqual(Set(directoryAbsence.keys), Set(["kind", "documentsIdentity"]))
        XCTAssertEqual(directoryAbsence["kind"] as? String, "managedDirectoryAbsent")
        XCTAssertEqual(directoryAbsence["documentsIdentity"] as? String, try token(documents))
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path)); _ = try managed()
        let leafMissing = try result(file.absoluteString), leafAbsence = try XCTUnwrap(leafMissing["absence"] as? [String: Any])
        XCTAssertEqual(Set(leafMissing.keys), Set(["kind", "targetURI", "absence"]))
        XCTAssertEqual(leafMissing["kind"] as? String, "noOwnedGeneration"); XCTAssertEqual(leafMissing["targetURI"] as? String, file.absoluteString)
        XCTAssertEqual(Set(leafAbsence.keys), Set(["kind", "directoryIdentity"]))
        XCTAssertEqual(leafAbsence["kind"] as? String, "leafAbsent"); XCTAssertEqual(leafAbsence["directoryIdentity"] as? String, try token(files.managedRoot))
        let uri = "content://provider/private-file", unmanaged = try result(uri)
        XCTAssertEqual(Set(unmanaged.keys), Set(["kind", "targetURI"]))
        XCTAssertEqual(unmanaged["kind"] as? String, "unmanaged"); XCTAssertEqual(unmanaged["targetURI"] as? String, uri)
        XCTAssertEqual(Darwin.mkfifo(file.path, mode_t(0o600)), 0); let identity = try token(file), unsafe = try result(file.absoluteString)
        XCTAssertEqual(Set(unsafe.keys), Set(["kind", "targetURI"]))
        XCTAssertEqual(unsafe["kind"] as? String, "unsafeEntry"); XCTAssertEqual(unsafe["targetURI"] as? String, file.absoluteString)
        XCTAssertEqual(try token(file), identity); XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testTypedCancellationAdmissionBoundsAndRawAllowlistStaySealed() throws {
        let file = try target(), bytes = try Data(contentsOf: file), identity = try token(file)
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        for id in ["", "bad\0id", String(repeating: "a", count: 501)] {
            XCTAssertThrowsError(try jobs.submitDraft(.snapshotBaseline(attachmentID: id, targetURI: file.absoluteString))) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
        }
        XCTAssertThrowsError(try jobs.submitDraft(.snapshotBaseline(attachmentID: attachmentID,
            targetURI: "content:" + String(repeating: "x", count: 16 * 1024))))
        XCTAssertThrowsError(try jobs.submitDraft(.snapshotBaseline(attachmentID: attachmentID,
            targetURI: "content:" + String(repeating: "\u{1}", count: 12_000)))) {
            guard let error = $0 as? NativeAttachmentFileJobsError, case .capacity = error else {
                return XCTFail("Expected bounded typed admission refusal")
            }
        }
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0); defer { release.signal() }
        jobs.beforeWork = { _, installer in XCTAssertFalse(installer); entered.signal(); release.wait() }
        let cancelled = try jobs.submitDraft(.snapshotBaseline(attachmentID: attachmentID, targetURI: file.absoluteString))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        jobs.abort(cancelled); release.signal(); jobs.drain(); jobs.beforeWork = nil
        let cancellation = try object(jobs.takeDraft(cancelled))
        XCTAssertEqual(Set(cancellation.keys), Set(["id", "error"]))
        XCTAssertEqual(cancellation["error"] as? String, "Attachment file operation was cancelled")
        let raw = try jobs.submit("{\"op\":\"snapshotBaseline\"}"); jobs.drain()
        let refusal = try object(jobs.next()); XCTAssertEqual(refusal["id"] as? String, raw)
        XCTAssertEqual(refusal["error"] as? String, "Attachment file request is invalid")
        XCTAssertThrowsError(try files.call("{\"op\":\"snapshotBaseline\"}")) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
        }
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try token(file), identity)
    }
}
