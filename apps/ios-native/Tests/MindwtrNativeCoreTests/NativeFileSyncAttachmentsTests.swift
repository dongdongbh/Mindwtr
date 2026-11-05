import CryptoKit
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeFileSyncAttachmentsTests: XCTestCase {
    private var root: URL!
    private var owner: NativeFileSyncAttachments!
    private var folder: String { root.absoluteString + "attachments/" }
    private let operation = String(repeating: "a", count: 32)

    override func setUpWithError() throws {
        let created = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: created, withIntermediateDirectories: true)
        root = URL(fileURLWithPath: created.resolvingSymlinksInPath().path, isDirectory: true)
        owner = NativeFileSyncAttachments(root: root, rootURI: root.absoluteString)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func run(_ op: String, _ fields: [String: Any]) async throws -> (Any, Data?) {
        try await owner.perform(op, fields)
    }

    private func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func publish(_ name: String, _ bytes: Data, operation: String) async throws -> String {
        let stage = folder + ".mindwtr-install-" + operation + ".candidate/stage", target = folder + name
        let preparedReply = try await run("attachmentPrepare", ["uri": target, "operationId": operation])
        let prepared = try XCTUnwrap(preparedReply.0 as? [String: String])
        _ = try await run("attachmentWrite", ["uri": stage, "base64": bytes.base64EncodedString()])
        let snapshotReply = try await run("attachmentSnapshot", ["uri": stage, "target": target, "sha256": hex(bytes)])
        let snapshot = try XCTUnwrap(snapshotReply.0 as? [String: String])
        XCTAssertEqual(snapshot["stagedIdentity"], prepared["stagedIdentity"])
        let published = try await run("attachmentPublish", ["uri": stage, "target": target, "sha256": hex(bytes),
            "stagedIdentity": snapshot["stagedIdentity"]!, "directoryIdentity": snapshot["directoryIdentity"]!,
            "privateDirectoryIdentity": prepared["privateDirectoryIdentity"]!])
        return try XCTUnwrap(published.0 as? String)
    }

    func testPublishesThroughThePrivateStageAndReadsTheGenerationBack() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        let absentReply = try await run("attachmentInfo", ["uri": folder + "a.txt"])
        let absent = try XCTUnwrap(absentReply.0 as? [String: Any])
        XCTAssertEqual(absent["exists"] as? Bool, false)
        let bytes = Data("attachment bytes".utf8)

        let outcome = try await publish("a.txt", bytes, operation: operation)
        XCTAssertEqual(outcome, "published")

        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("attachments/a.txt")), bytes)
        let entries = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("attachments").path)
        XCTAssertFalse(entries.contains { $0.hasPrefix(".mindwtr-install-") })
        let read = try await run("attachmentRead", ["uri": folder + "a.txt", "position": 0, "length": NSNull()])
        XCTAssertEqual(read.0 as? String, "bytes")
        XCTAssertEqual(read.1, bytes)
        let head = try await run("attachmentRead", ["uri": folder + "a.txt", "position": 0, "length": 4])
        XCTAssertEqual(head.1, Data("atta".utf8))
        let infoReply = try await run("attachmentInfo", ["uri": folder + "a.txt"])
        let info = try XCTUnwrap(infoReply.0 as? [String: Any])
        XCTAssertEqual(info["size"] as? Int64, Int64(bytes.count))
    }

    func testAnExistingCanonicalGenerationIsNeverReplaced() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        let peer = Data("peer".utf8)
        try peer.write(to: root.appendingPathComponent("attachments/a.txt"))

        let outcome = try await publish("a.txt", Data("mine".utf8), operation: operation)
        XCTAssertEqual(outcome, "alreadyExists")

        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("attachments/a.txt")), peer)
    }

    func testAnInterruptedStageIsRetiredByItsRecordedOperation() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        let stage = folder + ".mindwtr-install-" + operation + ".candidate/stage", target = folder + "a.txt"
        let preparedReply = try await run("attachmentPrepare", ["uri": target, "operationId": operation])
        let prepared = try XCTUnwrap(preparedReply.0 as? [String: String])
        await owner.close()
        owner = NativeFileSyncAttachments(root: root, rootURI: root.absoluteString)

        let outcome = try await run("attachmentCleanup", ["uri": stage, "target": target, "operationId": operation,
            "sha256": NSNull(), "stagedIdentity": prepared["stagedIdentity"]!, "directoryIdentity": prepared["directoryIdentity"]!,
            "privateDirectoryIdentity": prepared["privateDirectoryIdentity"]!])

        XCTAssertEqual(outcome.0 as? String, "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("attachments/.mindwtr-install-\(operation).candidate").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("attachments/a.txt").path))
    }

    func testAStageAcceptsOneWriteOnly() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        let stage = folder + ".mindwtr-install-" + operation + ".candidate/stage"
        _ = try await run("attachmentPrepare", ["uri": folder + "a.txt", "operationId": operation])
        _ = try await run("attachmentWrite", ["uri": stage, "base64": Data("one".utf8).base64EncodedString()])
        do {
            _ = try await run("attachmentWrite", ["uri": stage, "base64": Data("two".utf8).base64EncodedString()])
            XCTFail("A second write must be refused")
        } catch {}
    }

    func testAnOversizeWholeReadIsReportedWithoutBytes() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        try Data(count: NativeFileSyncAttachments.maximumBytes + 1).write(to: root.appendingPathComponent("attachments/big.bin"))

        let read = try await run("attachmentRead", ["uri": folder + "big.bin", "position": 0, "length": NSNull()])

        XCTAssertEqual(read.0 as? String, "tooLarge")
        XCTAssertNil(read.1)
    }

    func testListsDirectNamesAndRefusesPathsOutsideTheFolder() async throws {
        _ = try await run("attachmentDirectory", ["uri": folder])
        try Data("b".utf8).write(to: root.appendingPathComponent("attachments/b.txt"))
        try Data("a".utf8).write(to: root.appendingPathComponent("attachments/A.txt"))
        try Data("doc".utf8).write(to: root.appendingPathComponent("data.json"))

        let listed = try await run("attachmentList", ["uri": folder])
        XCTAssertEqual(listed.0 as? [String], ["A.txt", "b.txt"])
        for uri in [folder + "../data.json", root.absoluteString + "data.json", folder + "./b.txt", "file:///etc/hosts"] {
            do {
                _ = try await run("attachmentRead", ["uri": uri, "position": 0, "length": NSNull()])
                XCTFail("Expected refusal for \(uri)")
            } catch {}
        }
        let missing = try await run("attachmentRead", ["uri": folder + "gone.txt", "position": 0, "length": NSNull()])
        XCTAssertEqual(missing.0 as? String, "absent")
    }

    func testAClosedOwnerRefusesEveryOperation() async throws {
        await owner.close()
        do {
            _ = try await run("attachmentDirectory", ["uri": folder])
            XCTFail("A closed owner must refuse")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("attachments").path))
    }
}
