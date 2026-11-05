import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class NativeAttachmentFileJobsTests: XCTestCase {
    private var root: URL!
    private var jobs: NativeAttachmentFileJobs!
    private var documents: URL!
    private var cache: URL!

    override func setUpWithError() throws {
        let fixture = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/file-jobs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let directories = try object(jobs.directoriesJSON)
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"] as? String)))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))
    }
    override func tearDownWithError() throws {
        jobs?.shutdown()
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
    private func submit(_ request: [String: Any], installer: Bool = false) throws -> String {
        try jobs.submit(json(request), installer: installer)
    }
    private func answer() throws -> [String: Any] { jobs.drain(); return try object(jobs.next()) }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func useCandidateJobs() throws -> URL {
        jobs.shutdown()
        let container = root.appendingPathComponent("candidate", isDirectory: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Library"), withIntermediateDirectories: true)
        jobs = try NativeAttachmentFileJobs(rnAdoptionContainerURL: container)
        let directories = try object(jobs.directoriesJSON)
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"] as? String)))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))
        let managed = documents.appendingPathComponent("attachments", isDirectory: true)
        _ = try submit(["op": "makeDirectory", "uri": managed.absoluteString])
        XCTAssertNil(try answer()["error"])
        return managed
    }

    func testCandidateRawProviderFIFOInstallsHashesAndPreservesConflict() throws {
        let managed = try useCandidateJobs(), source = managed.appendingPathComponent(".mindwtr-download-jobs.staged")
        let target = managed.appendingPathComponent("file.txt"), bytes = Data("candidate bytes".utf8)
        _ = try submit(["op": "writeBytes", "uri": source.absoluteString, "base64": bytes.base64EncodedString()])
        let installed = try submit(["op": "install", "staged": source.absoluteString, "target": target.absoluteString,
            "expected": ["kind": "absent"], "expectedDownloadSha256": digest(bytes)], installer: true)
        let hashed = try submit(["op": "hash", "path": target.absoluteString], installer: true)
        jobs.drain()
        XCTAssertNil(try object(jobs.next())["error"])
        let install = try object(jobs.next()), hash = try object(jobs.next())
        XCTAssertEqual(install["id"] as? String, installed); XCTAssertEqual(hash["id"] as? String, hashed)
        XCTAssertEqual(try XCTUnwrap(install["value"] as? [String: Any]) as NSDictionary, ["status": "installed"] as NSDictionary)
        let snapshot = try XCTUnwrap(hash["value"] as? [String: Any])
        XCTAssertEqual(Set(snapshot.keys), ["sha256", "size", "modificationTimeMs"])
        XCTAssertEqual(snapshot["sha256"] as? String, digest(bytes)); XCTAssertEqual(snapshot["size"] as? Int, bytes.count)
        XCTAssertGreaterThan(try XCTUnwrap(snapshot["modificationTimeMs"] as? Double), 1_000_000_000_000)
        let conflict = managed.appendingPathComponent(".mindwtr-download-conflict.staged"), incoming = Data("incoming".utf8)
        try incoming.write(to: conflict)
        _ = try submit(["op": "install", "staged": conflict.absoluteString, "target": target.absoluteString,
            "expected": ["kind": "absent"], "expectedDownloadSha256": digest(incoming)], installer: true)
        XCTAssertEqual(try XCTUnwrap(answer()["value"] as? [String: Any]) as NSDictionary,
            ["status": "conflict", "preservedPath": conflict.absoluteString] as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try Data(contentsOf: conflict), incoming)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testCandidateStartedRawInstallerFinishesBeforeCancellationDrainReturns() throws {
        let managed = try useCandidateJobs(), stage = managed.appendingPathComponent(".mindwtr-download-drain.staged")
        let target = managed.appendingPathComponent("item"), bytes = Data("published candidate".utf8)
        try bytes.write(to: stage)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        jobs.afterWork = { _, installer in if installer { entered.signal(); release.wait() } }
        _ = try submit(["op": "install", "staged": stage.absoluteString, "target": target.absoluteString,
            "expected": ["kind": "absent"], "expectedDownloadSha256": digest(bytes)], installer: true)
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let owner = jobs!
        DispatchQueue.global().async { owner.cancelAndDrain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual((try object(jobs.next())["value"] as? [String: Any])?["status"] as? String, "installed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testFIFOBytesRangeAndBarrier() throws {
        let source = cache.appendingPathComponent("Source + 文.txt"), target = documents.appendingPathComponent("copy.txt")
        let bytes = Data("abcdef".utf8)
        let first = try submit(["op": "writeBytes", "uri": source.absoluteString, "base64": bytes.base64EncodedString()])
        let second = try submit(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString])
        let third = try submit(["op": "readBytesRange", "uri": target.absoluteString, "position": 2, "length": 3])
        let fourth = try submit(["op": "barrier"])
        jobs.drain()
        XCTAssertEqual(try object(jobs.next())["id"] as? String, first)
        XCTAssertEqual(try object(jobs.next())["id"] as? String, second)
        let read = try object(jobs.next())
        XCTAssertEqual(read["id"] as? String, third); XCTAssertEqual(read["body"] as? Bool, true)
        XCTAssertEqual(Data(base64Encoded: jobs.body()), Data("cde".utf8))
        XCTAssertEqual(try object(jobs.next())["id"] as? String, fourth)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }
    func testZeroByteBodyIsConsumedAndReservationReleased() throws {
        let file = cache.appendingPathComponent("empty")
        try Data().write(to: file)
        _ = try submit(["op": "readBytes", "uri": file.absoluteString])
        XCTAssertEqual(try answer()["body"] as? Bool, true)
        XCTAssertEqual(jobs.counters.jobs, 1)
        XCTAssertEqual(jobs.body(), "")
        XCTAssertEqual(jobs.counters.jobs, 0)
    }
    func testExactByteLimitRoundtrip() throws {
        let file = cache.appendingPathComponent("exact")
        let data = Data(repeating: 0x61, count: NativeAttachmentFiles.maximumBytes)
        _ = try submit(["op": "writeBytes", "uri": file.absoluteString, "base64": data.base64EncodedString()])
        XCTAssertNil(try answer()["error"])
        _ = try submit(["op": "readBytes", "uri": file.absoluteString])
        XCTAssertEqual(try answer()["body"] as? Bool, true)
        XCTAssertEqual(Data(base64Encoded: jobs.body()), data)
    }
    func testOutstandingAdmissionAndConsumedAnswersPermitReuse() throws {
        for _ in 0..<NativeAttachmentFileJobs.maximumJobs { _ = try submit(["op": "barrier"]) }
        jobs.drain()
        XCTAssertThrowsError(try submit(["op": "barrier"]))
        XCTAssertEqual(jobs.counters.jobs, 16)
        _ = jobs.next()
        _ = try submit(["op": "barrier"])
        jobs.drain()
        for _ in 0..<16 { XCTAssertFalse(jobs.next().isEmpty) }
        XCTAssertEqual(jobs.counters.jobs, 0)
    }
    func testHeldBodyRetainsByteAdmissionUntilConsumed() throws {
        let file = cache.appendingPathComponent("small")
        try Data([7]).write(to: file)
        let request: [String: Any] = ["op": "readBytes", "uri": file.absoluteString]
        _ = try submit(request); _ = try submit(request); jobs.drain()
        XCTAssertThrowsError(try submit(request))
        XCTAssertEqual(try object(jobs.next())["body"] as? Bool, true)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertThrowsError(try submit(request))
        XCTAssertEqual(Data(base64Encoded: jobs.body()), Data([7]))
        _ = try submit(request)
        jobs.drain()
        for _ in 0..<2 { _ = jobs.next(); _ = jobs.body() }
        XCTAssertEqual(jobs.counters.bytes, 0)
    }
    func testQueuedCancellationRunsNoWorkAndOwnerRemainsReusable() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } }
        _ = try submit(["op": "barrier"])
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let file = cache.appendingPathComponent("cancelled")
        let cancelled = try submit(["op": "writeBytes", "uri": file.absoluteString, "base64": "YWJj"])
        jobs.abort(cancelled); release.signal(); jobs.drain()
        _ = jobs.next()
        XCTAssertEqual(try object(jobs.next())["error"] as? String, "Attachment file operation was cancelled")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        jobs.cancelAndDrain()
        _ = try submit(["op": "barrier"])
        XCTAssertNil(try answer()["error"])
    }
    func testRunningCopyCancellationPreservesTarget() throws {
        let source = cache.appendingPathComponent("source"), target = documents.appendingPathComponent("target")
        try Data(repeating: 8, count: 200_000).write(to: source); try Data("old".utf8).write(to: target)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        jobs.beforeFilePublish = { entered.signal(); release.wait() }
        let id = try submit(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString])
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        jobs.abort(id); release.signal()
        XCTAssertEqual(try answer()["error"] as? String, "Attachment file operation was cancelled")
        XCTAssertEqual(try Data(contentsOf: target), Data("old".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: documents.path), ["target"])
    }
    func testInstallerObjectReplyHashUnitsAndConflict() throws {
        let managed = documents.appendingPathComponent("attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let stage = cache.appendingPathComponent("stage"), target = managed.appendingPathComponent("item.txt")
        let data = Data("first".utf8); try data.write(to: stage)
        let install: [String: Any] = ["op": "install", "staged": stage.absoluteString, "target": target.absoluteString,
                                      "expected": ["kind": "absent"], "expectedDownloadSha256": digest(data)]
        _ = try submit(install, installer: true)
        let installed = try XCTUnwrap(try answer()["value"] as? [String: Any])
        XCTAssertEqual(installed["status"] as? String, "installed")
        _ = try submit(["op": "hash", "path": target.absoluteString], installer: true)
        let hash = try XCTUnwrap(try answer()["value"] as? [String: Any])
        XCTAssertEqual(hash["sha256"] as? String, digest(data)); XCTAssertEqual(hash["size"] as? Int, 5)
        _ = try submit(["op": "getInfo", "uri": target.absoluteString])
        let info = try XCTUnwrap(try answer()["value"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(hash["modificationTimeMs"] as? Double),
                       try XCTUnwrap(info["modificationTime"] as? Double) * 1_000, accuracy: 1)
        try Data("next".utf8).write(to: stage)
        var conflict = install; conflict["expectedDownloadSha256"] = digest(Data("next".utf8))
        _ = try submit(conflict, installer: true)
        let result = try XCTUnwrap(try answer()["value"] as? [String: Any])
        XCTAssertEqual(result["status"] as? String, "conflict")
        let preserved = try XCTUnwrap(URL(string: XCTUnwrap(result["preservedPath"] as? String)))
        XCTAssertEqual(try Data(contentsOf: preserved), Data("next".utf8))
        XCTAssertEqual(try Data(contentsOf: target), data)
        conflict["expected"] = ["kind": "present", "sha256": digest(data)]
        _ = try submit(conflict, installer: true)
        let replacement = try XCTUnwrap(try answer()["value"] as? [String: Any])
        XCTAssertEqual(replacement["status"] as? String, "installed")
        let old = try XCTUnwrap(URL(string: XCTUnwrap(replacement["preservedPath"] as? String)))
        XCTAssertEqual(try Data(contentsOf: old), data)
        XCTAssertEqual(try Data(contentsOf: target), Data("next".utf8))
    }
    func testStartedInstallerFinishesBeforeCancellationDrainReturns() throws {
        let managed = documents.appendingPathComponent("attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let stage = cache.appendingPathComponent("stage"), target = managed.appendingPathComponent("item")
        let bytes = Data("published".utf8); try bytes.write(to: stage)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        jobs.afterWork = { _, installer in if installer { entered.signal(); release.wait() } }
        _ = try submit(["op": "install", "staged": stage.absoluteString, "target": target.absoluteString,
                        "expected": ["kind": "absent"], "expectedDownloadSha256": digest(bytes)], installer: true)
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let owner = jobs!
        DispatchQueue.global().async { owner.cancelAndDrain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual((try object(jobs.next())["value"] as? [String: Any])?["status"] as? String, "installed")
    }
    func testMissingUnauthorizedAndDriverErrorsRemainFixed() throws {
        _ = try submit(["op": "readBytes", "uri": cache.appendingPathComponent("missing").absoluteString])
        XCTAssertEqual(try answer()["error"] as? String, "ENOENT: no such file or directory")
        _ = try submit(["op": "getInfo", "uri": root.appendingPathComponent("core.sqlite").absoluteString])
        let unauthorized = try answer()
        XCTAssertNotEqual(unauthorized["error"] as? String, "ENOENT: no such file or directory")
        jobs.beforeWork = { _, _ in throw NSError(domain: "sensitive", code: 1, userInfo: [NSLocalizedDescriptionKey: "private-file-secret"]) }
        _ = try submit(["op": "barrier"])
        let failed = try answer()
        XCTAssertEqual(failed["error"] as? String, "Attachment file operation is unavailable")
        XCTAssertFalse(try json(failed).contains("private-file-secret"))
    }
    func testCrossLibraryAndSymlinkInitializationRefuse() throws {
        let sibling = root.appendingPathComponent("sibling")
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        let other = try NativeAttachmentFileJobs(libraryRoot: sibling)
        defer { other.shutdown() }
        let otherDirectories = try object(other.directoriesJSON)
        _ = try submit(["op": "getInfo", "uri": otherDirectories["cache"]!])
        XCTAssertNotNil(try answer()["error"])
        let link = root.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: sibling)
        XCTAssertThrowsError(try NativeAttachmentFileJobs(libraryRoot: link))
    }
    func testShutdownStopsAdmissionAndReleasesBodies() throws {
        let file = cache.appendingPathComponent("value"); try Data([1]).write(to: file)
        _ = try submit(["op": "readBytes", "uri": file.absoluteString]); jobs.drain(); _ = jobs.next()
        jobs.shutdown()
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertThrowsError(try submit(["op": "barrier"]))
        XCTAssertEqual(jobs.body(), "")
    }
}
