import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class AttachmentDraftFileJobsTests: XCTestCase {
    private typealias SourceProof = NativeAttachmentFiles.CacheSourceProof
    private typealias StageProof = NativeAttachmentFiles.ReservedAttachmentStageProof
    private var root: URL!
    private var jobs: NativeAttachmentFileJobs!
    private var documents: URL!
    private var cache: URL!
    private var managed: URL!
    private let operationID = String(repeating: "a", count: 32)
    private let sourceFields: Set<String> = ["sourceURI", "sha256", "size", "identity", "cacheRootIdentity", "parentIdentity"]
    private let stageFields: Set<String> = ["stageURI", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]
    private let fillFields: Set<String> = ["sha256", "size", "identity"]

    override func setUpWithError() throws {

        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task223-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let directories = try object(jobs.directoriesJSON)
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"] as? String)))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))
        managed = documents.appendingPathComponent("attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws {
        jobs?.shutdown()
        if let root { try FileManager.default.removeItem(at: root) }
    }

    func testFreshManagedDirectoryTypedEnsureThenPrepare() throws {
        try FileManager.default.removeItem(at: managed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        _ = try run(.ensureManagedDirectory, fields: [])
        let target = managed.appendingPathComponent("fresh.bin")
        let proof = try prepare(target)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try stageURL(proof).path))
    }
    func testTypedEnsureRefusesSymlinkManagedDirectoryWithoutOutsideMutation() throws {
        try FileManager.default.removeItem(at: managed)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: managed, withDestinationURL: outside)
        let answer = try takeDraft(jobs.submitDraft(.ensureManagedDirectory))
        XCTAssertNotNil(answer["error"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
        var info = stat()
        XCTAssertEqual(lstat(managed.path, &info), 0)
        XCTAssertEqual(info.st_mode & S_IFMT, S_IFLNK)
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ encoded: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [String: Any])
    }
    private func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private func identity(_ url: URL) throws -> String {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func file(_ bytes: Data, name: String = "source + 世界.bin") throws -> URL {
        let url = cache.appendingPathComponent(name)
        try bytes.write(to: url)
        return url
    }
    private func raw(_ request: [String: Any], installer: Bool = false) throws -> String {
        try jobs.submit(json(request), installer: installer)
    }
    private func takeDraft(_ id: String) throws -> [String: Any] {
        jobs.drain()
        let answer = try object(jobs.takeDraft(id))
        XCTAssertEqual(answer["id"] as? String, id)
        return answer
    }
    private func takeRaw(_ id: String) throws -> [String: Any] {
        jobs.drain()
        let answer = try object(jobs.next())
        XCTAssertEqual(answer["id"] as? String, id)
        return answer
    }
    private func value(_ id: String, fields: Set<String>) throws -> [String: Any] {
        let answer = try takeDraft(id)
        XCTAssertEqual(Set(answer.keys), ["id", "value"])
        XCTAssertNil(answer["error"])
        let result = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), fields)
        return result
    }
    private func run(_ request: NativeAttachmentDraftFileRequest, fields: Set<String>) throws -> [String: Any] {
        try value(jobs.submitDraft(request), fields: fields)
    }
    private func sourceProof(_ value: [String: Any]) throws -> SourceProof {
        SourceProof(sourceURI: try XCTUnwrap(value["sourceURI"] as? String),
                    sha256: try XCTUnwrap(value["sha256"] as? String),
                    size: try XCTUnwrap(value["size"] as? NSNumber).int64Value,
                    identity: try XCTUnwrap(value["identity"] as? String),
                    cacheRootIdentity: try XCTUnwrap(value["cacheRootIdentity"] as? String),
                    parentIdentity: try XCTUnwrap(value["parentIdentity"] as? String))
    }
    private func snapshot(_ url: URL) throws -> SourceProof {
        try sourceProof(run(.snapshotSource(sourceURI: url.absoluteString), fields: sourceFields))
    }
    private func prepare(_ target: URL) throws -> StageProof {
        let token = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let value = try run(.prepareStage(targetURI: target.absoluteString, operationID: token), fields: stageFields)
        return StageProof(stageURI: try XCTUnwrap(value["stageURI"] as? String),
                          stagedIdentity: try XCTUnwrap(value["stagedIdentity"] as? String),
                          directoryIdentity: try XCTUnwrap(value["directoryIdentity"] as? String),
                          privateDirectoryIdentity: try XCTUnwrap(value["privateDirectoryIdentity"] as? String))
    }
    private func stageURL(_ proof: StageProof) throws -> URL { try XCTUnwrap(URL(string: proof.stageURI)) }
    private func filled(_ source: SourceProof, _ stage: StageProof) throws {
        let value = try run(.fillStage(source: source, stage: stage), fields: fillFields)
        XCTAssertEqual(value["sha256"] as? String, source.sha256)
        XCTAssertEqual((value["size"] as? NSNumber)?.int64Value, source.size)
        XCTAssertEqual(value["identity"] as? String, stage.stagedIdentity)
    }

    func testTypedAndCompatibilityJobsShareFIFOAndExactProofReplies() throws {
        var execution: [String] = []
        jobs.beforeWork = { id, _ in execution.append(id) }
        let bytes = Data([0, 255, 1]) + Data("captured + 世界".utf8)
        let source = cache.appendingPathComponent("source + 世界.bin")
        let write = try raw(["op": "writeBytes", "uri": source.absoluteString, "base64": bytes.base64EncodedString()])
        let snapshotID = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let barrier = try raw(["op": "barrier"])
        XCTAssertEqual([write, snapshotID, barrier], ["1", "2", "3"])
        XCTAssertNil(try takeRaw(write)["error"])
        XCTAssertEqual(execution, [write, snapshotID, barrier])
        let proof = try sourceProof(value(snapshotID, fields: sourceFields))
        XCTAssertEqual(proof.sourceURI, source.absoluteString)
        XCTAssertEqual(proof.sha256, digest(bytes)); XCTAssertEqual(proof.size, Int64(bytes.count))
        XCTAssertEqual(proof.identity, try identity(source))
        XCTAssertEqual(proof.cacheRootIdentity, try identity(cache))
        XCTAssertEqual(proof.parentIdentity, try identity(cache))
        XCTAssertNil(try takeRaw(barrier)["error"])
        let target = managed.appendingPathComponent("target.bin")
        let stage = try prepare(target), stageFile = try stageURL(stage)
        XCTAssertEqual(stage.stagedIdentity, try identity(stageFile))
        XCTAssertEqual(stage.directoryIdentity, try identity(managed))
        XCTAssertEqual(stage.privateDirectoryIdentity, try identity(stageFile.deletingLastPathComponent()))
        let fill = try jobs.submitDraft(.fillStage(source: proof, stage: stage))
        let info = try raw(["op": "getInfo", "uri": stage.stageURI])
        let fillValue = try value(fill, fields: fillFields)
        XCTAssertEqual(fillValue["sha256"] as? String, proof.sha256)
        XCTAssertEqual(fillValue["identity"] as? String, stage.stagedIdentity)
        XCTAssertEqual((fillValue["size"] as? NSNumber)?.int64Value, proof.size)
        XCTAssertNil(try takeRaw(info)["error"])
        let published = try run(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256), fields: ["status"])
        XCTAssertEqual(published["status"] as? String, "published")
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stageFile.path))
        let hash = try raw(["op": "hash", "path": target.absoluteString], installer: true)
        let hashValue = try XCTUnwrap(try takeRaw(hash)["value"] as? [String: Any])
        XCTAssertEqual(hashValue["sha256"] as? String, proof.sha256)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testExistingSameAndDifferentHashTargetsAreNeverAdoptedOrReplaced() throws {
        let bytes = Data("incoming".utf8), source = try file(Data("incoming".utf8))
        let proof = try snapshot(source)
        for (name, existing) in [("same.bin", bytes), ("different.bin", Data("existing".utf8))] {
            let target = managed.appendingPathComponent(name)
            let stage = try prepare(target), stageFile = try stageURL(stage)
            try filled(proof, stage)
            try existing.write(to: target)
            let targetIdentity = try identity(target)
            let result = try run(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256), fields: ["status"])
            XCTAssertEqual(result["status"] as? String, "alreadyExists")
            XCTAssertEqual(try Data(contentsOf: target), existing)
            XCTAssertEqual(try identity(target), targetIdentity)
            XCTAssertEqual(try Data(contentsOf: stageFile), bytes)
            XCTAssertEqual(try identity(stageFile), stage.stagedIdentity)
        }
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testTypedStreamingIsNotLimitedByCompatibilityBinaryReplyCap() throws {
        let bytes = Data(repeating: 0x61, count: 18 * 1024 * 1024)
        let source = try file(bytes), proof = try snapshot(source)
        XCTAssertGreaterThan(proof.size, Int64(NativeAttachmentFiles.maximumBytes))
        let target = managed.appendingPathComponent("large.bin"), stage = try prepare(target)
        try filled(proof, stage)
        let result = try run(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256), fields: ["status"])
        XCTAssertEqual(result["status"] as? String, "published")
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testVerificationSharesPublicationFIFOAndSurvivesColdOwner() throws {
        let bytes = Data("published".utf8), source = try file(Data("published".utf8))
        let proof = try snapshot(source), target = managed.appendingPathComponent("target")
        let stage = try prepare(target)
        try filled(proof, stage)
        let publication = try jobs.submitDraft(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256))
        let verification = try jobs.submitDraft(.verifyPublication(targetURI: target.absoluteString, stage: stage,
                                                                  sha256: proof.sha256, size: proof.size))
        XCTAssertEqual(try value(publication, fields: ["status"])["status"] as? String, "published")
        let fields: Set<String> = ["sha256", "size", "identity", "directoryIdentity"]
        let result = try value(verification, fields: fields)
        XCTAssertEqual(result["sha256"] as? String, proof.sha256)
        XCTAssertEqual((result["size"] as? NSNumber)?.int64Value, proof.size)
        XCTAssertEqual(result["identity"] as? String, stage.stagedIdentity)
        XCTAssertEqual(result["directoryIdentity"] as? String, stage.directoryIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        jobs.shutdown()
        jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let cold = try run(.verifyPublication(targetURI: target.absoluteString, stage: stage,
                                              sha256: proof.sha256, size: proof.size), fields: fields)
        XCTAssertEqual(cold["identity"] as? String, stage.stagedIdentity)
        XCTAssertEqual(cold["sha256"] as? String, proof.sha256)
        XCTAssertEqual((cold["size"] as? NSNumber)?.int64Value, proof.size)
        XCTAssertEqual(cold["directoryIdentity"] as? String, stage.directoryIdentity)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testVerificationRefusesSameHashReplacementWithDifferentInode() throws {
        let bytes = Data("published".utf8), source = try file(Data("published".utf8))
        let proof = try snapshot(source), target = managed.appendingPathComponent("target")
        let stage = try prepare(target)
        try filled(proof, stage)
        XCTAssertEqual(try run(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256),
                               fields: ["status"])["status"] as? String, "published")
        try bytes.write(to: target, options: [.atomic])
        let replacementIdentity = try identity(target)
        XCTAssertNotEqual(replacementIdentity, stage.stagedIdentity)
        jobs.shutdown()
        jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let id = try jobs.submitDraft(.verifyPublication(targetURI: target.absoluteString, stage: stage,
                                                         sha256: proof.sha256, size: proof.size))
        let refusal = try takeDraft(id)
        XCTAssertEqual(Set(refusal.keys), ["id", "error"])
        XCTAssertEqual(refusal["error"] as? String, "Attachment file operation is unavailable")
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try identity(target), replacementIdentity)
        XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testRunningFillCancellationDrainsWithoutLosingProofAndCanRetry() throws {
        let bytes = Data(repeating: 0x4f, count: 200_000)
        let source = try file(bytes), proof = try snapshot(source)
        let target = managed.appendingPathComponent("target.bin"), stage = try prepare(target)
        let stageFile = try stageURL(stage)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.beforeStageSync = { entered.signal(); release.wait() }
        let id = try jobs.submitDraft(.fillStage(source: proof, stage: stage))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        jobs.abort(id)
        let owner = jobs!
        DispatchQueue.global().async { owner.cancelAndDrain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(jobs.counters.jobs, 1)
        XCTAssertGreaterThan(jobs.counters.bytes, 64 * 1024)
        XCTAssertEqual(try takeDraft(id)["error"] as? String, "Attachment file operation was cancelled")
        XCTAssertEqual(try Data(contentsOf: source), bytes)

        XCTAssertEqual(try Data(contentsOf: stageFile), bytes)
        XCTAssertEqual(try identity(stageFile), stage.stagedIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(jobs.counters.bytes, 0)
        jobs.beforeStageSync = nil
        try filled(proof, stage)
        jobs.cancelAndDrain()
        XCTAssertNil(try takeRaw(raw(["op": "barrier"]))["error"])
    }

    func testQueuedTypedCancellationDoesNotCreateStageAndOwnerRemainsReusable() throws {
        let source = try file(Data("source".utf8))
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } }
        let first = try raw(["op": "barrier"])
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let snapshotID = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let stageID = try jobs.submitDraft(.prepareStage(targetURI: managed.appendingPathComponent("target").absoluteString, operationID: operationID))
        jobs.abort(snapshotID); jobs.abort(stageID); release.signal()
        XCTAssertNil(try takeRaw(first)["error"])
        for id in [snapshotID, stageID] {
            XCTAssertEqual(try takeDraft(id)["error"] as? String, "Attachment file operation was cancelled")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), [])
        XCTAssertEqual(try Data(contentsOf: source), Data("source".utf8))
        XCTAssertEqual(jobs.counters.bytes, 0)
        jobs.cancelAndDrain(); jobs.beforeWork = nil
        XCTAssertEqual(try snapshot(source).sha256, digest(Data("source".utf8)))
    }

    func testCompletedPrepareRetainsActualProofAfterCancellationAndDrain() throws {
        let target = managed.appendingPathComponent("target")
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.afterWork = { _, installer in if installer { entered.signal(); release.wait() } }
        let id = try jobs.submitDraft(.prepareStage(targetURI: target.absoluteString, operationID: operationID))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let owner = jobs!
        DispatchQueue.global().async { owner.cancelAndDrain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(jobs.counters.jobs, 1)
        let result = try value(id, fields: stageFields)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(result["stageURI"] as? String)))
        XCTAssertEqual(result["stagedIdentity"] as? String, try identity(stage))
        XCTAssertEqual(result["directoryIdentity"] as? String, try identity(managed))
        XCTAssertEqual(result["privateDirectoryIdentity"] as? String, try identity(stage.deletingLastPathComponent()))
        XCTAssertEqual(try Data(contentsOf: stage), Data())
        XCTAssertEqual(jobs.counters.bytes, 0)
        jobs.afterWork = nil
        XCTAssertNil(try takeRaw(raw(["op": "barrier"]))["error"])
    }

    func testCompletedPublishRetainsActualOutcomeAfterCancellationAndDrain() throws {
        let bytes = Data("published".utf8), source = try file(Data("published".utf8))
        let proof = try snapshot(source), target = managed.appendingPathComponent("target")
        let stage = try prepare(target), stageFile = try stageURL(stage)
        try filled(proof, stage)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.afterWork = { _, installer in if installer { entered.signal(); release.wait() } }
        let id = try jobs.submitDraft(.publishStage(stage: stage, targetURI: target.absoluteString, sha256: proof.sha256))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        let owner = jobs!
        DispatchQueue.global().async { owner.cancelAndDrain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(jobs.counters.jobs, 1)
        XCTAssertEqual(try value(id, fields: ["status"])["status"] as? String, "published")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stageFile.path))
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(jobs.counters.bytes, 0)
        jobs.afterWork = nil
        XCTAssertNil(try takeRaw(raw(["op": "barrier"]))["error"])
    }

    func testTypedAnswersRetainCountAndInputPlusReplyReservationUntilConsumed() throws {
        let source = try file(Data([7]))
        var ids: [String] = []
        for _ in 0..<NativeAttachmentFileJobs.maximumJobs {
            ids.append(try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString)))
        }
        jobs.drain()
        XCTAssertEqual(jobs.counters.jobs, 16)
        XCTAssertGreaterThan(jobs.counters.bytes, 16 * 64 * 1024)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 16)
        XCTAssertThrowsError(try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))) { error in
            XCTAssertEqual(error.localizedDescription, "Attachment file bridge capacity is unavailable")
        }
        _ = try value(ids.removeFirst(), fields: sourceFields)
        ids.append(try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString)))
        for id in ids { _ = try value(id, fields: sourceFields) }
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testTypedJobsShareByteReservationAndCannotConsumeHeldCompatibilityBody() throws {
        let source = try file(Data([7]))
        let read: [String: Any] = ["op": "readBytes", "uri": source.absoluteString]
        let first = try raw(read), second = try raw(read)
        let typed = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        jobs.drain()
        XCTAssertGreaterThan(jobs.counters.bytes, 32 * 1024 * 1024)
        XCTAssertThrowsError(try raw(read))
        XCTAssertEqual(try takeRaw(first)["body"] as? Bool, true)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 3)
        XCTAssertThrowsError(try raw(read))
        let heldBytes = jobs.counters.bytes
        _ = try value(typed, fields: sourceFields)
        XCTAssertEqual(jobs.counters.jobs, 2)
        XCTAssertLessThan(jobs.counters.bytes, heldBytes)
        XCTAssertGreaterThan(jobs.counters.bytes, 32 * 1024 * 1024)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(Data(base64Encoded: jobs.body()), Data([7]))
        let last = try raw(read)
        XCTAssertEqual(try takeRaw(second)["body"] as? Bool, true)
        XCTAssertEqual(Data(base64Encoded: jobs.body()), Data([7]))
        XCTAssertEqual(try takeRaw(last)["body"] as? Bool, true)
        XCTAssertEqual(Data(base64Encoded: jobs.body()), Data([7]))
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testMalformedAndOversizedTypedInputRefusesBeforeWorkerOrFileIO() throws {
        let target = managed.appendingPathComponent("target")
        let sha = String(repeating: "a", count: 64)
        let stage = StageProof(stageURI: target.absoluteString, stagedIdentity: "1:2", directoryIdentity: "1:3", privateDirectoryIdentity: "1:4")
        let source = SourceProof(sourceURI: cache.appendingPathComponent("missing").absoluteString, sha256: sha, size: 0,
                                 identity: "1:2", cacheRootIdentity: "1:3", parentIdentity: "1:3")
        let badToken = StageProof(stageURI: stage.stageURI, stagedIdentity: "01:2", directoryIdentity: "1:3", privateDirectoryIdentity: "1:4")
        let longToken = StageProof(stageURI: stage.stageURI, stagedIdentity: String(repeating: "1", count: 42), directoryIdentity: "1:3", privateDirectoryIdentity: "1:4")
        let badSize = SourceProof(sourceURI: source.sourceURI, sha256: sha, size: 9_007_199_254_740_992,
                                  identity: "1:2", cacheRootIdentity: "1:3", parentIdentity: "1:3")
        let negative = SourceProof(sourceURI: source.sourceURI, sha256: sha, size: -1,
                                   identity: "1:2", cacheRootIdentity: "1:3", parentIdentity: "1:3")
        jobs.beforeWork = { _, _ in XCTFail("Invalid typed input reached the worker") }
        let requests: [NativeAttachmentDraftFileRequest] = [
            .snapshotSource(sourceURI: String(repeating: "a", count: 16 * 1024 + 1)),
            .snapshotSource(sourceURI: "file:///bad\0path"),
            .prepareStage(targetURI: target.absoluteString, operationID: String(repeating: "A", count: 32)),
            .fillStage(source: source, stage: badToken), .fillStage(source: source, stage: longToken),
            .fillStage(source: badSize, stage: stage), .fillStage(source: negative, stage: stage),
            .publishStage(stage: stage, targetURI: target.absoluteString, sha256: String(repeating: "A", count: 64)),
            .verifyPublication(targetURI: target.absoluteString, stage: stage, sha256: sha, size: -1),
            .verifyPublication(targetURI: target.absoluteString, stage: stage, sha256: sha, size: 9_007_199_254_740_992)
        ]
        for request in requests {
            XCTAssertThrowsError(try jobs.submitDraft(request)) { error in
                XCTAssertTrue(error is NativeAttachmentFilesError || error is NativeAttachmentInstallerError)
            }
        }


        let escaped = String(repeating: "\"", count: 16 * 1024)
        let encodedSource = SourceProof(sourceURI: escaped, sha256: sha, size: 0,
                                       identity: "1:2", cacheRootIdentity: "1:3", parentIdentity: "1:3")
        let encodedStage = StageProof(stageURI: escaped, stagedIdentity: "1:2", directoryIdentity: "1:3", privateDirectoryIdentity: "1:4")
        XCTAssertThrowsError(try jobs.submitDraft(.fillStage(source: encodedSource, stage: encodedStage))) { error in
            XCTAssertEqual(error.localizedDescription, "Attachment file bridge capacity is unavailable")
        }
        XCTAssertThrowsError(try jobs.submitDraft(.verifyPublication(targetURI: escaped, stage: encodedStage, sha256: sha, size: 0))) { error in
            XCTAssertEqual(error.localizedDescription, "Attachment file bridge capacity is unavailable")
        }
        jobs.drain()
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), [])
    }

    func testTypedNativeFailuresRemainFixedAndRespectExistingURLAdmission() throws {
        let source = try file(Data("source".utf8)), secret = "private-source-secret"
        let malformed = try jobs.submitDraft(.snapshotSource(sourceURI: "https://name:private-source-secret@example.test/file"))
        XCTAssertEqual(try takeDraft(malformed)["error"] as? String, "Attachment file request is invalid")
        let missing = try jobs.submitDraft(.snapshotSource(sourceURI: cache.appendingPathComponent("missing").absoluteString))
        XCTAssertEqual(try takeDraft(missing)["error"] as? String, "ENOENT: no such file or directory")
        let foreign = try jobs.submitDraft(.snapshotSource(sourceURI: documents.appendingPathComponent("unowned").absoluteString))
        XCTAssertNotNil(try takeDraft(foreign)["error"])
        let link = cache.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        XCTAssertNotNil(try takeDraft(jobs.submitDraft(.snapshotSource(sourceURI: link.absoluteString)))["error"])
        let badTarget = try jobs.submitDraft(.prepareStage(targetURI: "https://name:private-source-secret@example.test/target", operationID: operationID))
        let refusal = try takeDraft(badTarget)
        XCTAssertEqual(refusal["error"] as? String, "Attachment installer request is invalid")
        XCTAssertFalse(try json(refusal).contains(secret))
        jobs.beforeWork = { _, _ in throw NSError(domain: "sensitive", code: 1, userInfo: [NSLocalizedDescriptionKey: secret]) }
        let failed = try takeDraft(jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString)))
        XCTAssertEqual(failed["error"] as? String, "Attachment file operation is unavailable")
        XCTAssertFalse(try json(failed).contains(secret))
        XCTAssertEqual(try Data(contentsOf: source), Data("source".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), [])
    }

    func testCompatibilityJSONAllowlistsDoNotExposeTypedOperations() throws {
        for op in ["snapshotSource", "prepareStage", "fillStage", "publishStage", "verifyPublication", "cleanupImmutableStage"] {
            XCTAssertEqual(try takeRaw(raw(["op": op]))["error"] as? String, "Attachment file request is invalid")
            XCTAssertEqual(try takeRaw(raw(["op": op], installer: true))["error"] as? String, "Attachment installer request is invalid")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), [])
        XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testInterleavedConsumersPreserveExecutionAndRawFIFOWithoutExposingTypedProofs() throws {
        let source = try file(Data("source".utf8))
        var execution: [String] = []
        jobs.beforeWork = { id, _ in execution.append(id) }
        let first = try raw(["op": "barrier"])
        let typed = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let second = try raw(["op": "barrier"])
        let typedError = try jobs.submitDraft(.snapshotSource(sourceURI: cache.appendingPathComponent("missing").absoluteString))
        jobs.drain()
        XCTAssertEqual(execution, [first, typed, second, typedError])
        let initialBytes = jobs.counters.bytes
        XCTAssertEqual(jobs.takeDraft("unknown"), "")
        XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(jobs.takeDraft(second), "")
        XCTAssertEqual(jobs.counters.jobs, 4)
        XCTAssertEqual(jobs.counters.bytes, initialBytes)
        XCTAssertEqual(try takeRaw(first)["id"] as? String, first)
        XCTAssertEqual(try takeRaw(second)["id"] as? String, second)
        let retainedBytes = jobs.counters.bytes
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 2)
        XCTAssertEqual(jobs.counters.bytes, retainedBytes)


        XCTAssertEqual(try takeDraft(typedError)["error"] as? String, "ENOENT: no such file or directory")
        XCTAssertEqual(jobs.counters.jobs, 1)
        _ = try value(typed, fields: sourceFields)
        XCTAssertEqual(jobs.takeDraft(typed), "")
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testPendingTypedAndWrongIDsCannotTakeRawAnswersOrOtherReservations() throws {
        let source = try file(Data("source".utf8))
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.beforeWork = { id, _ in if id == "2" { entered.signal(); release.wait() } }
        let first = try raw(["op": "barrier"])
        let typed = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let last = try raw(["op": "barrier"])
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let reserved = jobs.counters.bytes
        XCTAssertEqual(jobs.takeDraft(typed), "")
        XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(jobs.takeDraft(last), "")
        XCTAssertEqual(jobs.counters.jobs, 3)
        XCTAssertEqual(jobs.counters.bytes, reserved)
        let firstAnswer = try object(jobs.next())
        XCTAssertEqual(firstAnswer["id"] as? String, first)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 2)
        release.signal(); jobs.drain()
        XCTAssertEqual(try takeRaw(last)["id"] as? String, last)
        _ = try value(typed, fields: sourceFields)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testTypedErrorsAndCancellationStayIsolatedAndDrainOwnerRemainsReusable() throws {
        let source = try file(Data("source".utf8))
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } }
        let first = try raw(["op": "barrier"])
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        let typedError = try jobs.submitDraft(.snapshotSource(sourceURI: cache.appendingPathComponent("missing").absoluteString))
        let typedCancelled = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let rawError = try raw(["op": "unknown"])
        jobs.abort(typedCancelled)
        release.signal(); jobs.drain()
        XCTAssertEqual(jobs.takeDraft(rawError), "")
        XCTAssertNil(try takeRaw(first)["error"])
        XCTAssertEqual(try takeRaw(rawError)["error"] as? String, "Attachment file request is invalid")
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.counters.jobs, 2)
        XCTAssertEqual(try takeDraft(typedCancelled)["error"] as? String, "Attachment file operation was cancelled")
        XCTAssertEqual(try takeDraft(typedError)["error"] as? String, "ENOENT: no such file or directory")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        jobs.cancelAndDrain(); jobs.beforeWork = nil
        let newTyped = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        let newRaw = try raw(["op": "barrier"])
        XCTAssertNil(try takeRaw(newRaw)["error"])
        _ = try value(newTyped, fields: sourceFields)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
    }

    func testShutdownClearsHeldRawBodyAndTypedRepliesTogether() throws {
        let bytes = Data("retained bytes".utf8), source = try file(Data("retained bytes".utf8))
        let read = try raw(["op": "readBytes", "uri": source.absoluteString])
        let typed = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        _ = try raw(["op": "barrier"])
        XCTAssertEqual(try takeRaw(read)["body"] as? Bool, true)
        XCTAssertEqual(jobs.counters.jobs, 3)
        XCTAssertGreaterThan(jobs.counters.bytes, NativeAttachmentFiles.maximumBytes)
        jobs.shutdown()
        XCTAssertEqual(jobs.next(), "")
        XCTAssertEqual(jobs.body(), "")
        XCTAssertEqual(jobs.takeDraft(typed), "")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertThrowsError(try raw(["op": "barrier"]))
        XCTAssertThrowsError(try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString)))
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testShutdownDiscardsTypedMailboxAndRefusesFurtherTypedAdmission() throws {
        let source = try file(Data([1]))
        _ = try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString))
        jobs.drain()
        XCTAssertEqual(jobs.counters.jobs, 1)
        jobs.shutdown()
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertEqual(jobs.next(), "")
        XCTAssertThrowsError(try jobs.submitDraft(.snapshotSource(sourceURI: source.absoluteString)))
        XCTAssertEqual(try Data(contentsOf: source), Data([1]))
    }
}
