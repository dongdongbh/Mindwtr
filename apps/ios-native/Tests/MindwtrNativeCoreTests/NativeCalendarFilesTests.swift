import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class NativeCalendarFilesTests: XCTestCase {
    private var fixture: URL!
    private var library: URL!
    private var files: NativeAttachmentFiles!
    private var documents: URL!
    private var cache: URL!
    private let bytes = Data("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:世界 + résumé\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n".utf8)

    override func setUpWithError() throws {
        // Keep fixtures on the test account/container's disk, not a global temp directory.
        let candidate = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Library/MindwtrCalendarFileTests/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        fixture = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        library = fixture.appendingPathComponent("library", isDirectory: true)
        try configure(library)
    }

    override func tearDownWithError() throws {
        files = nil
        if let fixture { try FileManager.default.removeItem(at: fixture) }
    }

    private func configure(_ root: URL) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        let map = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(files.directoriesJSON.utf8)) as? [String: String])
        documents = try XCTUnwrap(URL(string: XCTUnwrap(map["document"])))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(map["cache"])))
        library = root
    }

    private var calendarRoot: URL { documents.appendingPathComponent("calendar-files", isDirectory: true) }
    private func picked(_ name: String = "Original + 世界.ics", data: Data? = nil) throws -> URL {
        let source = fixture.appendingPathComponent(name)
        try (data ?? bytes).write(to: source)
        return source
    }
    private func capture(_ source: URL, check: () throws -> Void = {}) throws -> NativeAttachmentFiles.CalendarFileSelection {
        try files.copyCalendarProviderSource(source, checkCancellation: check)
    }
    private func read(_ uri: String, check: () throws -> Void = {}) throws -> Data {
        try files.readCalendarFile(uri, checkCancellation: check)
    }
    private func names(_ root: URL) throws -> [String] {
        if !FileManager.default.fileExists(atPath: root.path) { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
    }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func info(_ url: URL) throws -> stat {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return value
    }
    private func refused(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line)
    }
    private func assertNoCopies(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try names(cache), [], file: file, line: line)
        XCTAssertEqual(try names(calendarRoot), [], file: file, line: line)
    }

    func testImportedSnapshotRetainsExactPickedNameAndBytesAfterProviderMutationAndRemoval() throws {
        let source = try picked(), selection = try capture(source), final = try XCTUnwrap(URL(string: selection.uri))
        XCTAssertEqual(selection.fileName, source.lastPathComponent)
        XCTAssertEqual(final.deletingLastPathComponent(), calendarRoot)
        XCTAssertTrue(final.lastPathComponent.hasSuffix("-" + digest(bytes) + ".ics"))
        let id = String(final.lastPathComponent.prefix(36))
        XCTAssertEqual(UUID(uuidString: id)?.uuidString.lowercased(), id)
        XCTAssertEqual(try info(final).st_mode & mode_t(0o777), mode_t(0o600))
        XCTAssertEqual(try final.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, false)
        #if os(iOS)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: final.path)[.protectionKey] as? FileProtectionType,
                       .completeUntilFirstUserAuthentication)
        #endif
        try Data("provider changed".utf8).write(to: source)
        try FileManager.default.removeItem(at: source)
        XCTAssertEqual(try read(selection.uri), bytes)
        XCTAssertEqual(try names(cache), [])
        XCTAssertEqual(try names(calendarRoot), [final.lastPathComponent])
        files = nil
        let cold = try NativeAttachmentFiles(libraryRoot: library)
        XCTAssertEqual(try cold.readCalendarFile(selection.uri, checkCancellation: {}), bytes)
        XCTAssertEqual(try names(calendarRoot), [final.lastPathComponent], "Reinitialization must retain published finals")
    }

    func testRepeatedPicksAreDistinctAndEmptyAndOpaqueBytesAreStorageValues() throws {
        let source = try picked(), first = try capture(source), second = try capture(source)
        XCTAssertNotEqual(first.uri, second.uri)
        XCTAssertEqual(try read(first.uri), bytes); XCTAssertEqual(try read(second.uri), bytes)
        let empty = try capture(picked("empty", data: Data()))
        XCTAssertEqual(try read(empty.uri), Data())
        let opaque = Data([0xff, 0xfe, 0, 0x80]), raw = try capture(picked("not-calendar.txt", data: opaque))
        XCTAssertEqual(raw.fileName, "not-calendar.txt")
        XCTAssertEqual(try read(raw.uri), opaque, "Decoding and ICS parsing belong to the binding/shared layer")
        XCTAssertEqual(try names(cache), [])
        XCTAssertEqual(try names(calendarRoot).count, 4)
    }

    func testExactEightMiBAcceptedAndOverflowRefusedBeforeCopyWhileAttachmentDefaultRemainsLarger() throws {
        let maximum = Data(repeating: 0x61, count: 8_388_608), source = try picked("maximum.ics", data: maximum)
        let selection = try capture(source)
        XCTAssertEqual(try read(selection.uri), maximum)
        let finals = try names(calendarRoot)
        let oversized = try picked("oversized.ics", data: maximum + Data([0x62]))
        XCTAssertThrowsError(try capture(oversized)) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge) }
        XCTAssertEqual(try names(calendarRoot), finals); XCTAssertEqual(try names(cache), [])
        let ordinary = try files.copyProviderSource(oversized, checkCancellation: {})
        XCTAssertEqual(ordinary.size, Int64(maximum.count + 1), "Calendar's cap must not change the attachment default")
        XCTAssertEqual(try files.retireProviderSource(ordinary, checkCancellation: {}), .removed)
    }

    func testUnsupportedSourceGenerationsAndAlreadyCancelledCaptureHaveNoFinalEffects() throws {
        let directory = fixture.appendingPathComponent("directory", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        refused { _ = try self.capture(directory) }
        let fifo = fixture.appendingPathComponent("unknown-stream.ics")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, mode_t(0o600)), 0)
        refused { _ = try self.capture(fifo) }
        refused { _ = try self.files.copyProviderSource(fifo, checkCancellation: {}) }
        let source = try picked()
        let symlink = fixture.appendingPathComponent("selected-link.ics")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
        refused { _ = try self.capture(symlink) }
        let hardlink = fixture.appendingPathComponent("selected-hardlink.ics")
        XCTAssertEqual(Darwin.link(source.path, hardlink.path), 0)
        refused { _ = try self.capture(source) }
        try FileManager.default.removeItem(at: hardlink)
        XCTAssertThrowsError(try capture(source, check: { throw CancellationError() })) { XCTAssertTrue($0 is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        try assertNoCopies()
    }

    func testOnlyExactOwnedFamilyAndCanonicalURISpellingCanBeRead() throws {
        let selected = try capture(picked()), final = try XCTUnwrap(URL(string: selected.uri))
        let foreign = try picked("private-settings.json")
        let sibling = documents.appendingPathComponent("calendar-files-peer/" + final.lastPathComponent)
        let root = calendarRoot.absoluteString
        let invalid = [foreign.absoluteString, sibling.absoluteString, root, "file://localhost" + final.path,
                       "content://provider/" + final.lastPathComponent, "https://example.invalid/a.ics", final.path,
                       selected.uri + "?private=query", selected.uri + "#fragment", selected.uri + "%00",
                       root + "../calendar-files/" + final.lastPathComponent,
                       root + "%2e%2e/calendar-files/" + final.lastPathComponent,
                       root + final.lastPathComponent.replacingOccurrences(of: ".ics", with: ".ICS"),
                       root + final.lastPathComponent.replacingOccurrences(of: "-", with: "%2d")]
        for uri in invalid { refused { _ = try self.read(uri) } }
        XCTAssertEqual(try read(selected.uri), bytes)
        let otherRoot = fixture.appendingPathComponent("other-library", isDirectory: true)
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: false)
        let other = try NativeAttachmentFiles(libraryRoot: otherRoot)
        refused { _ = try other.readCalendarFile(selected.uri, checkCancellation: {}) }
        XCTAssertEqual(try Data(contentsOf: foreign), bytes)
    }

    func testReaderRefusesMissingDigestTamperedHardlinkedSymlinkedAndOversizedFiles() throws {
        let source = try picked()
        let tampered = try capture(source), tamperedURL = try XCTUnwrap(URL(string: tampered.uri))
        try Data("same length is not the same bytes".utf8).write(to: tamperedURL)
        refused { _ = try self.read(tampered.uri) }
        let linked = try capture(source), linkedURL = try XCTUnwrap(URL(string: linked.uri))
        let otherName = fixture.appendingPathComponent("another-hardlink")
        XCTAssertEqual(Darwin.link(linkedURL.path, otherName.path), 0)
        refused { _ = try self.read(linked.uri) }
        let symbolic = try capture(source), symbolicURL = try XCTUnwrap(URL(string: symbolic.uri))
        try FileManager.default.removeItem(at: symbolicURL)
        try FileManager.default.createSymbolicLink(at: symbolicURL, withDestinationURL: source)
        refused { _ = try self.read(symbolic.uri) }
        let huge = try capture(source), hugeURL = try XCTUnwrap(URL(string: huge.uri))
        try Data(repeating: 0x61, count: 8_388_609).write(to: hugeURL)
        XCTAssertThrowsError(try read(huge.uri)) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge) }
        let missing = try capture(source), missingURL = try XCTUnwrap(URL(string: missing.uri))
        try FileManager.default.removeItem(at: missingURL)
        refused { _ = try self.read(missing.uri) }
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    #if DEBUG
    func testCaptureGrowthAndNamedSourceReplacementAreRefusedWithExactStageCleanup() throws {
        let source = try picked(), displaced = fixture.appendingPathComponent("displaced-provider")
        files.afterSourceOpened = { try Data(repeating: 0x61, count: 8_388_609).write(to: source, options: []) }
        refused { _ = try self.capture(source) }
        files.afterSourceOpened = nil
        try assertNoCopies()
        try bytes.write(to: source)
        files.afterSourceOpened = {
            try FileManager.default.moveItem(at: source, to: displaced)
            try Data("replacement provider".utf8).write(to: source)
        }
        refused { _ = try self.capture(source) }
        files.afterSourceOpened = nil
        try assertNoCopies()
        XCTAssertEqual(try Data(contentsOf: displaced), bytes)
        XCTAssertEqual(try Data(contentsOf: source), Data("replacement provider".utf8))
    }

    func testExclusiveFinalCollisionPreservesForeignGenerationAndCleansOnlyOwnedCopy() throws {
        var destination: URL?
        files.beforeCalendarPublish = { uri in
            let target = try XCTUnwrap(URL(string: uri)); destination = target
            try Data("foreign destination".utf8).write(to: target)
        }
        refused { _ = try self.capture(self.picked()) }
        files.beforeCalendarPublish = nil
        let target = try XCTUnwrap(destination)
        XCTAssertEqual(try Data(contentsOf: target), Data("foreign destination".utf8))
        XCTAssertEqual(try names(calendarRoot), [target.lastPathComponent])
        XCTAssertEqual(try names(cache), [])
    }

    func testCancellationBeforeAndAfterExclusivePromotionCleansOnlyUnreturnedGeneration() throws {
        let source = try picked()
        for phase in ["stream", "before-final", "after-final"] {
            var checks = 0, cancelled = false
            if phase == "before-final" { files.beforeCalendarPublish = { _ in cancelled = true } }
            XCTAssertThrowsError(try capture(source, check: {
                checks += 1
                if phase == "stream" && checks == 8 { throw CancellationError() }
                if cancelled { throw CancellationError() }
                if phase == "after-final", try self.names(self.calendarRoot).contains(where: { $0.hasSuffix(".ics") }) {
                    throw CancellationError()
                }
            })) { XCTAssertTrue($0 is CancellationError, phase) }
            files.beforeCalendarPublish = nil
            try assertNoCopies()
        }
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testFinalDirectoryReplacementCannotPublishIntoReplacementRootOrCleanForeignStage() throws {
        let displaced = documents.appendingPathComponent("displaced-calendar", isDirectory: true)
        let outside = fixture.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        var target: URL?
        files.beforeCalendarPublish = { uri in
            let url = try XCTUnwrap(URL(string: uri)); target = outside.appendingPathComponent(url.lastPathComponent)
            try Data("foreign".utf8).write(to: target!)
            try FileManager.default.moveItem(at: self.calendarRoot, to: displaced)
            try FileManager.default.createSymbolicLink(at: self.calendarRoot, withDestinationURL: outside)
        }
        refused { _ = try self.capture(self.picked()) }
        files.beforeCalendarPublish = nil
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(target)), Data("foreign".utf8))
        XCTAssertEqual(try names(outside).count, 1)
        XCTAssertEqual(try names(cache), [])
        XCTAssertFalse(try names(displaced).contains(where: { $0.hasSuffix(".ics") }))
    }

    func testReadRejectsReplacementSameInodeMutationGrowthAndCancellationAfterOpening() throws {
        let source = try picked()
        for phase in ["replacement", "mutation", "growth", "cancel"] {
            let selected = try capture(source), target = try XCTUnwrap(URL(string: selected.uri))
            let displaced = fixture.appendingPathComponent("displaced-" + phase)
            var cancelled = false
            files.afterSourceOpened = {
                switch phase {
                case "replacement":
                    try FileManager.default.moveItem(at: target, to: displaced)
                    try self.bytes.write(to: target)
                case "mutation": try Data(repeating: 0x61, count: self.bytes.count).write(to: target, options: [])
                case "growth": try Data(repeating: 0x61, count: 8_388_609).write(to: target, options: [])
                default: cancelled = true
                }
            }
            refused { _ = try self.read(selected.uri, check: { if cancelled { throw CancellationError() } }) }
            files.afterSourceOpened = nil
            if phase == "replacement" { XCTAssertEqual(try Data(contentsOf: displaced), bytes) }
            if phase == "cancel" { XCTAssertEqual(try read(selected.uri), bytes) }
        }
    }

    func testFrozenDocumentsAndCalendarDirectoryIdentityRefusesReplacement() throws {
        let selected = try capture(picked())
        let displaced = documents.appendingPathComponent("saved-calendar", isDirectory: true)
        try FileManager.default.moveItem(at: calendarRoot, to: displaced)
        try FileManager.default.createDirectory(at: calendarRoot, withIntermediateDirectories: false)
        let leaf = try XCTUnwrap(URL(string: selected.uri)).lastPathComponent
        try bytes.write(to: calendarRoot.appendingPathComponent(leaf))
        refused { _ = try self.read(selected.uri) }
        refused { _ = try self.capture(self.picked()) }
        XCTAssertEqual(try Data(contentsOf: calendarRoot.appendingPathComponent(leaf)), bytes)
        XCTAssertEqual(try names(cache), [])
    }

    func testCaptureRefusesFinalGenerationChangedByLastOwnerCallbackInsteadOfReturningSelection() throws {
        var target: URL?, armed = false, callbacks = 0, mutated = false
        files.beforeCalendarPublish = { uri in target = try XCTUnwrap(URL(string: uri)) }
        files.afterSourceOpened = {
            if let target, FileManager.default.fileExists(atPath: target.path) { armed = true }
        }
        refused {
            _ = try self.capture(self.picked(), check: {
                guard armed else { return }
                callbacks += 1
                if callbacks == 4 {
                    try Data("changed final generation".utf8).write(to: XCTUnwrap(target), options: [])
                    mutated = true
                }
            })
        }
        files.beforeCalendarPublish = nil; files.afterSourceOpened = nil
        XCTAssertTrue(mutated)
        // The mutation is no longer the exact unreturned generation; retain it.
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(target)), Data("changed final generation".utf8))
        XCTAssertEqual(try names(cache), [])
    }
    #endif

    #if os(macOS)
    func testOnlyApplicationContainerUUIDRelocationResolvesCurrentOwnedFileWithoutReadingOldPath() throws {
        let oldContainer = fixture.appendingPathComponent("Application/" + UUID().uuidString.lowercased(), isDirectory: true)
        let suffix = "Library/NativeUITests/" + UUID().uuidString.lowercased()
        try configure(oldContainer.appendingPathComponent(suffix, isDirectory: true))
        let selected = try capture(picked()), oldURL = try XCTUnwrap(URL(string: selected.uri))
        files = nil
        let newContainer = oldContainer.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.moveItem(at: oldContainer, to: newContainer)
        try configure(newContainer.appendingPathComponent(suffix, isDirectory: true))
        XCTAssertEqual(try read(selected.uri), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldURL.path))
        let current = calendarRoot.appendingPathComponent(oldURL.lastPathComponent)
        XCTAssertEqual(try Data(contentsOf: current), bytes)
        let foreign = selected.uri.replacingOccurrences(of: "/NativeUITests/", with: "/OtherLibrary/")
        refused { _ = try self.read(foreign) }
        let extra = selected.uri.replacingOccurrences(of: "/Library/", with: "/Library/Application/" + UUID().uuidString.lowercased() + "/Library/")
        refused { _ = try self.read(extra) }
        let siblingContainer = selected.uri.replacingOccurrences(of: "/Application/", with: "/Foreign/")
        refused { _ = try self.read(siblingContainer) }
    }
    #endif
}
