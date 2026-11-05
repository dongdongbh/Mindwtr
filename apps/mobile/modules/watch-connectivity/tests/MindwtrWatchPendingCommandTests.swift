import Foundation
import XCTest
@testable import MindwtrWatchPayloadValidation

final class MindwtrWatchPendingCommandTests: XCTestCase {
    private var root: URL!, directory: URL!
    private let sourceName = "00000000-0000-4000-8000-000000000001.json"
    private let body = "{\"synthetic\":true}"
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("watch-pending-" + UUID().uuidString, isDirectory: true)
        directory = root.appendingPathComponent("queue", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(body.utf8).write(to: directory.appendingPathComponent(sourceName))
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    func testExactSourceRetiresOnlyAfterSettlementAndRetryIsIdempotent() throws {
        let source = try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName)
        XCTAssertEqual(source.name, sourceName); XCTAssertEqual(source.body, body)
        var called = false
        try source.retire {
            XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(sourceName).path))
            called = true
        }
        XCTAssertTrue(called)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(sourceName).path))
        try source.retire()
    }
    func testFailedSettlementKeepsSource() throws {
        let source = try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName)
        XCTAssertThrowsError(try source.retire { throw CocoaError(.fileWriteUnknown) })
        XCTAssertEqual(try String(contentsOf: directory.appendingPathComponent(sourceName), encoding: .utf8), body)
    }
    func testSameBytesReplacementCannotRetireOrSettle() throws {
        let source = try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName)
        try FileManager.default.moveItem(at: directory.appendingPathComponent(sourceName), to: root.appendingPathComponent("retained"))
        try Data(body.utf8).write(to: directory.appendingPathComponent(sourceName))
        var settled = false
        XCTAssertThrowsError(try source.retire { settled = true })
        XCTAssertFalse(settled)
        XCTAssertEqual(try String(contentsOf: directory.appendingPathComponent(sourceName), encoding: .utf8), body)
    }
    func testChangedBytesOrReplacedDirectoryRemainOwnedByTheirNewSource() throws {
        let source = try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName)
        try Data("changed".utf8).write(to: directory.appendingPathComponent(sourceName))
        XCTAssertThrowsError(try source.retire())
        try FileManager.default.moveItem(at: directory, to: root.appendingPathComponent("retained-queue"))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try Data(body.utf8).write(to: directory.appendingPathComponent(sourceName))
        XCTAssertThrowsError(try source.retire())
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(sourceName).path))
    }
    func testOversizeSymlinkAndNoncanonicalNamesRefuse() throws {
        XCTAssertThrowsError(try MindwtrWatchPendingCommand.read(directory: directory, name: "../" + sourceName))
        try Data(repeating: 65, count: 32 * 1024 + 1).write(to: directory.appendingPathComponent(sourceName))
        XCTAssertThrowsError(try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName))
        try FileManager.default.removeItem(at: directory.appendingPathComponent(sourceName))
        let external = root.appendingPathComponent("other"); try Data(body.utf8).write(to: external)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent(sourceName), withDestinationURL: external)
        XCTAssertThrowsError(try MindwtrWatchPendingCommand.read(directory: directory, name: sourceName))
        XCTAssertEqual(try String(contentsOf: external, encoding: .utf8), body)
    }
}
