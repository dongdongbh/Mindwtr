import Foundation
import XCTest
import Darwin
@testable import MindwtrNativeCore

final class NativeBackupImportFileTests: XCTestCase {
    private func withRoot(_ body: (URL) throws -> Void) throws {
        let root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-import-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func source(_ root: URL, bytes: Data = Data("{}".utf8)) throws -> URL {
        let url = root.appendingPathComponent("selected.json")
        try bytes.write(to: url)
        return url
    }

    func testOwnedUnicodeCopySurvivesProviderChangeAndOwnerRecreation() throws {
        try withRoot { root in
            let text = Data("{\"notes\":\"日本語 🦉 مرحبا\"}".utf8)
            let url = try source(root, bytes: text)
            let port = NativeBackupImportFile(libraryRoot: root)
            let first = try port.stage(url)
            XCTAssertEqual(first.reference.byteCount, text.count)
            XCTAssertEqual(first.fileName, "selected.json")
            XCTAssertTrue(first.modifiedAtMilliseconds.isFinite)
            try Data("{}".utf8).write(to: url)
            let second = try port.stage(url)
            XCTAssertNotEqual(first.reference.id, second.reference.id)
            let recreated = NativeBackupImportFile(libraryRoot: root)
            XCTAssertEqual(try recreated.read(first.reference), text)
            XCTAssertEqual(try recreated.read(second.reference), Data("{}".utf8))
            try recreated.discard(first.reference)
            XCTAssertThrowsError(try recreated.read(first.reference))
            XCTAssertEqual(try recreated.read(second.reference), Data("{}".utf8))
            try recreated.discard(second.reference)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-imports").path), [])
        }
    }

    func testRefusesForgedReferenceTamperedBytesAndSymlinksWithoutTouchingTarget() throws {
        try withRoot { root in
            let url = try source(root)
            let port = NativeBackupImportFile(libraryRoot: root)
            let picked = try port.stage(url).reference
            let forged = NativeBackupImportReference(id: "../selected", sha256: picked.sha256, byteCount: picked.byteCount)
            XCTAssertThrowsError(try port.read(forged))
            let upper = NativeBackupImportReference(id: picked.id.uppercased(), sha256: picked.sha256, byteCount: picked.byteCount)
            XCTAssertThrowsError(try port.read(upper))
            let saved = root.appendingPathComponent("backup-imports").appendingPathComponent(picked.id + ".json")
            try Data("[]".utf8).write(to: saved)
            XCTAssertThrowsError(try port.read(picked))
            XCTAssertThrowsError(try port.discard(picked))
            try FileManager.default.removeItem(at: saved)
            try FileManager.default.createSymbolicLink(at: saved, withDestinationURL: url)
            XCTAssertThrowsError(try port.read(picked))
            XCTAssertThrowsError(try port.discard(picked))
            XCTAssertEqual(try Data(contentsOf: url), Data("{}".utf8))
            let inputLink = root.appendingPathComponent("provider-link.json")
            try FileManager.default.createSymbolicLink(at: inputLink, withDestinationURL: url)
            XCTAssertThrowsError(try port.stage(inputLink))
        }
    }

    func testFailureBeforePromotionLeavesNoAcceptedOrPendingCopy() throws {
        try withRoot { root in
            let url = try source(root)
            let port = NativeBackupImportFile(libraryRoot: root)
            port.beforePromote = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try port.stage(url))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-imports").path), [])
            XCTAssertEqual(try Data(contentsOf: url), Data("{}".utf8))
        }
    }

    func testRefusesDirectorySymlinkedLibraryAndChangedOpenedSource() throws {
        try withRoot { root in
            let url = try source(root)
            let port = NativeBackupImportFile(libraryRoot: root)
            XCTAssertThrowsError(try port.stage(root))
            let link = root.appendingPathComponent("library-link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
            XCTAssertThrowsError(try NativeBackupImportFile(libraryRoot: link).stage(url))
            port.afterSourceOpened = {
                let fd = Darwin.open(url.path, O_WRONLY)
                guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
                defer { Darwin.close(fd) }
                XCTAssertEqual(Darwin.ftruncate(fd, 1), 0)
            }
            XCTAssertThrowsError(try port.stage(url))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-imports").path), [])
        }
    }

    func testStartupCleanupRetainsJournalOwnedCopyAndRefusesUnknownFamilies() throws {
        try withRoot { root in
            let url = try source(root)
            let port = NativeBackupImportFile(libraryRoot: root)
            let accepted = try port.stage(url).reference
            let orphan = try port.stage(url).reference
            let directory = root.appendingPathComponent("backup-imports")
            let pending = directory.appendingPathComponent(".pending-" + UUID().uuidString.lowercased())
            try Data("partial".utf8).write(to: pending)
            let unrelated = directory.appendingPathComponent("unrelated.json")
            try Data("untouched".utf8).write(to: unrelated)
            let linked = directory.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: url)
            let recreated = NativeBackupImportFile(libraryRoot: root)
            XCTAssertThrowsError(try recreated.discardUnreferencedCopies(retaining: ["invalid"]))
            XCTAssertEqual(try recreated.read(orphan), Data("{}".utf8))
            try recreated.discardUnreferencedCopies(retaining: [accepted.id])
            XCTAssertEqual(try recreated.read(accepted), Data("{}".utf8))
            XCTAssertThrowsError(try recreated.read(orphan))
            XCTAssertFalse(FileManager.default.fileExists(atPath: pending.path))
            XCTAssertEqual(try String(contentsOf: unrelated), "untouched")
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: linked.path), url.path)
            XCTAssertEqual(try Data(contentsOf: url), Data("{}".utf8))
        }
    }

    func testExact128MiBBoundAndGrowthAfterInitialStat() throws {
        try withRoot { root in
            let url = try source(root)
            let fd = Darwin.open(url.path, O_WRONLY)
            guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
            defer { Darwin.close(fd) }
            let limit = NativeBackupImportFile.maximumBytes
            XCTAssertEqual(limit, 134217728)
            XCTAssertEqual(Darwin.ftruncate(fd, off_t(limit)), 0)
            let port = NativeBackupImportFile(libraryRoot: root)
            let exact = try port.stage(url).reference
            XCTAssertEqual(exact.byteCount, limit)
            XCTAssertEqual(try port.read(exact).count, limit)
            try port.discard(exact)
            XCTAssertEqual(Darwin.ftruncate(fd, off_t(limit + 1)), 0)
            XCTAssertThrowsError(try port.stage(url)) { error in
                XCTAssertEqual(error as? NativeBackupImportFileError, .tooLarge)
            }
            XCTAssertEqual(Darwin.ftruncate(fd, 2), 0)
            port.afterSourceOpened = { XCTAssertEqual(Darwin.ftruncate(fd, off_t(limit + 1)), 0) }
            XCTAssertThrowsError(try port.stage(url)) { error in
                XCTAssertEqual(error as? NativeBackupImportFileError, .tooLarge)
            }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-imports").path), [])
        }
    }
}
