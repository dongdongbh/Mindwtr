import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeBackupExportFileTests: XCTestCase {
    private let backupName = "mindwtr-backup-2026-10-04T12-34-56-789Z.json"

    private func withRoot(_ body: (URL) throws -> Void) throws {
        let root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-export-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    func testIndependentImmutableUnicodeFilesAndOwnedCleanup() throws {
        try withRoot { root in
            let port = NativeBackupExportFile(libraryRoot: root)
            let text = "{\"notes\":\"日本語 🦉\\nمرحبا\"}"
            let first = try port.prepare(fileName: backupName, content: text)
            let second = try port.prepare(fileName: backupName, content: "{}")
            XCTAssertNotEqual(first.url, second.url)
            XCTAssertEqual(try Data(contentsOf: first.url), Data(text.utf8))
            XCTAssertEqual(try Data(contentsOf: second.url), Data("{}".utf8))
            port.discard(UUID())
            port.discard(first.id)
            XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: second.url.path))
            port.discard(second.id)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        }
    }

    func testCSVBytesAreImmutableAndInterruptedCSVIsCleaned() throws {
        try withRoot { root in
            let port = NativeBackupExportFile(libraryRoot: root)
            let name = backupName.replacingOccurrences(of: ".json", with: ".csv")
            let text = "Title,Description\n\"日本語, \"\"quoted\"\"\",\"two\nlines\""
            let file = try port.prepare(fileName: name, content: text)
            XCTAssertEqual(try Data(contentsOf: file.url), Data(text.utf8))
            port.discard(file.id)
            let orphan = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
            try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: false)
            try Data(text.utf8).write(to: orphan.appendingPathComponent(name))
            try port.discardInterruptedExports()
            XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
            port.beforeWrite = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try port.prepare(fileName: name, content: text))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        }
    }

    func testTaskNotesBinaryBytesAndInterruptedCleanup() throws {
        try withRoot { root in
            let port = NativeBackupExportFile(libraryRoot: root)
            let name = backupName.replacingOccurrences(of: ".json", with: "-tasknotes.zip")
            let bytes = Data([0x50, 0x4b, 0, 255, 128, 13, 10, 0])
            let file = try port.prepare(fileName: name, bytes: bytes)
            XCTAssertEqual(try Data(contentsOf: file.url), bytes)
            port.discard(file.id)
            let orphan = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
            try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: false)
            try bytes.write(to: orphan.appendingPathComponent(name))
            try port.discardInterruptedExports()
            XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
            port.beforeWrite = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try port.prepare(fileName: name, bytes: bytes))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
            XCTAssertThrowsError(try port.prepare(fileName: backupName.replacingOccurrences(of: ".json", with: ".zip"), bytes: bytes))
        }
    }

    func testFailedWriteLeavesNoFileOrDirectory() throws {
        try withRoot { root in
            let port = NativeBackupExportFile(libraryRoot: root)
            port.beforeWrite = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try port.prepare(fileName: backupName, content: "private"))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        }
    }

    func testInterruptedCleanupRemovesOnlyOwnedRegularBackupFamily() throws {
        try withRoot { root in
            let orphan = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
            try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: false)
            try Data("interrupted".utf8).write(to: orphan.appendingPathComponent(backupName))
            let unrelated = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
            try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: false)
            let retained = unrelated.appendingPathComponent("retained.txt")
            try Data("retained".utf8).write(to: retained)
            let linked = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased())
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: unrelated)
            let port = NativeBackupExportFile(libraryRoot: root)
            try port.discardInterruptedExports()
            XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
            XCTAssertEqual(try String(contentsOf: retained), "retained")
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: linked.path), unrelated.path)
            let active = try port.prepare(fileName: backupName, content: "{}")
            try port.discardInterruptedExports()
            XCTAssertTrue(FileManager.default.fileExists(atPath: active.url.path))
            port.discard(active.id)
        }
    }

    func testRejectsCallerPathsAndSymlinkedLibraryWithoutTouchingTarget() throws {
        try withRoot { root in
            let port = NativeBackupExportFile(libraryRoot: root)
            for invalidName in ["../private.json", "/private.json", "mindwtr-backup-x.json", self.backupName + "/other", self.backupName + "\n"] {
                XCTAssertThrowsError(try port.prepare(fileName: invalidName, content: "private"))
            }
            let target = root.appendingPathComponent("target", isDirectory: true)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            let link = root.appendingPathComponent("link", isDirectory: true)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
            XCTAssertThrowsError(try NativeBackupExportFile(libraryRoot: link).prepare(fileName: backupName, content: "private"))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), [])
        }
    }
}
