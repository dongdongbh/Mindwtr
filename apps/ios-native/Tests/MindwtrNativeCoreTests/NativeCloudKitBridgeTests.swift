import CloudKit
import CryptoKit
import Foundation
import XCTest
@testable import CloudKitAttachmentErrorClassifier
@testable import MindwtrNativeCore

final class NativeCloudKitBridgeTests: XCTestCase {
    private var root: URL!
    private var files: NativeAttachmentFileJobs!
    private var documents: URL!
    private var cache: URL!
    private let at = "2026-10-30T12:00:00.000Z"

    override func setUpWithError() throws {
        let temporary = try XCTUnwrap(ProcessInfo.processInfo.environment["TMPDIR"])
        root = URL(fileURLWithPath: temporary).resolvingSymlinksInPath()
            .appendingPathComponent("cloudkit-bridge-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        files = try NativeAttachmentFileJobs(libraryRoot: root)
        let directories = try object(files.directoriesJSON)
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"] as? String)))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))
        try FileManager.default.createDirectory(at: documents.appendingPathComponent("attachments"), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        files?.shutdown()
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func bridge(_ schedule: @escaping (CKDatabaseOperation) -> Void) -> NativeCloudKitBridge {
        let manager = CloudKitSyncManager(containerIdentifier: "iCloud.synthetic.native-tests", zoneName: "SyntheticZone", operationScheduler: schedule)
        return NativeCloudKitBridge(transport: NativeCloudKitTransport(manager: manager), files: files)
    }
    private func upload(_ source: URL, bytes: Data, hash: String? = nil) throws -> String {
        try json(["op": "saveAttachmentAsset", "recordName": "synthetic-asset", "filePath": source.absoluteString,
            "metadataJSON": json(["attachmentId": "asset", "ownerType": "task", "ownerId": "legacy-task", "title": "Synthetic asset",
                "updatedAt": at, "size": bytes.count, "fileHash": hash ?? digest(bytes)])])
    }
    private func download(_ target: URL) throws -> String {
        try json(["op": "fetchAttachmentAsset", "recordName": "synthetic-asset", "targetPath": target.absoluteString])
    }
    private func fail(_ operation: CKDatabaseOperation, _ error: Error) {
        if let op = operation as? CKFetchRecordsOperation { op.fetchRecordsResultBlock?(.failure(error)) }
        else if let op = operation as? CKModifyRecordsOperation { op.modifyRecordsResultBlock?(.failure(error)) }
        else { XCTFail("Unexpected CloudKit operation") }
    }
    private func cacheNames() throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted() }

    func testUploadSDKReadsFrozenPrivateCopyAndRetiresItAfterTerminalCallback() async throws {
        let bytes = Data("original upload".utf8), later = Data("later local edit".utf8)
        let source = documents.appendingPathComponent("attachments/task.txt")
        try bytes.write(to: source)
        let before = try cacheNames(), owned = CloudKitBridgeLocked<URL?>(nil)
        let selected = bridge { operation in
            DispatchQueue.global().async {
                do {
                    if let op = operation as? CKFetchRecordsOperation {
                        // Upload receipt is frozen before even the initial record lookup.
                        try later.write(to: source)
                        op.fetchRecordsResultBlock?(.success(()))
                    } else if let op = operation as? CKModifyRecordsOperation {
                        let record = try XCTUnwrap(op.recordsToSave?.first)
                        let asset = try XCTUnwrap(record["asset"] as? CKAsset)
                        let privateURL = try XCTUnwrap(asset.fileURL)
                        owned.update { $0 = privateURL }
                        XCTAssertNotEqual(privateURL, source)
                        XCTAssertEqual(Data(privateURL.deletingLastPathComponent().standardizedFileURL.path.utf8), Data(self.cache.standardizedFileURL.path.utf8))
                        XCTAssertEqual(try Data(contentsOf: privateURL), bytes)
                        op.perRecordSaveBlock?(record.recordID, .success(record))
                        op.modifyRecordsResultBlock?(.success(()))
                    } else { throw HostFailure("Unexpected CloudKit operation") }
                } catch { self.fail(operation, error) }
            }
        }
        let response = try await selected.call(upload(source, bytes: bytes))
        XCTAssertEqual(try object(response)["recordName"] as? String, "synthetic-asset")
        let privateURL = try XCTUnwrap(owned.value)
        XCTAssertFalse(FileManager.default.fileExists(atPath: privateURL.path))
        XCTAssertEqual(try Data(contentsOf: source), later)
        XCTAssertEqual(try cacheNames(), before)
        await selected.cancel()
    }

    func testUploadHashMismatchAndOutsidePathRefuseBeforeSDKEntry() async throws {
        let calls = CloudKitBridgeLocked(0), bytes = Data("owned upload".utf8)
        let selected = bridge { operation in
            calls.update { $0 += 1 }
            DispatchQueue.global().async { self.fail(operation, HostFailure("Unexpected SDK entry")) }
        }
        let source = documents.appendingPathComponent("attachments/task.txt"), outside = root.appendingPathComponent("outside.txt")
        try bytes.write(to: source); try bytes.write(to: outside)
        let before = try cacheNames()
        for input in [try upload(source, bytes: bytes, hash: String(repeating: "0", count: 64)), try upload(outside, bytes: bytes)] {
            do { _ = try await selected.call(input); XCTFail("Unowned or changed source must refuse") } catch {}
        }
        XCTAssertEqual(calls.value, 0)
        XCTAssertEqual(try cacheNames(), before)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try Data(contentsOf: outside), bytes)
        await selected.cancel()
    }

    func testDownloadConsumesSDKAssetIntoFreshScratchWithoutReplacingExistingOrCanonicalFile() async throws {
        let bytes = Data("SDK download".utf8), provider = root.appendingPathComponent("sdk-asset")
        try bytes.write(to: provider)
        let selected = bridge { operation in
            DispatchQueue.global().async {
                guard let op = operation as? CKFetchRecordsOperation, let id = op.recordIDs?.first else {
                    self.fail(operation, HostFailure("Expected asset lookup")); return
                }
                let record = CKRecord(recordType: "MindwtrAttachment", recordID: id)
                record["asset"] = CKAsset(fileURL: provider)
                record["title"] = "Synthetic asset" as CKRecordValue
                op.perRecordResultBlock?(id, .success(record)); op.fetchRecordsResultBlock?(.success(()))
            }
        }
        let before = try cacheNames()
        let stage = documents.appendingPathComponent("attachments/.mindwtr-download-100-1-abcd-task.staged")
        let canonical = documents.appendingPathComponent("attachments/task.txt"), original = Data("preserve canonical".utf8)
        try original.write(to: canonical)
        let response = try await selected.call(download(stage))
        XCTAssertEqual(try object(response)["recordName"] as? String, "synthetic-asset")
        XCTAssertNil(try object(response)["filePath"], "SDK source is consumed natively, never returned as a device path")
        XCTAssertEqual(try Data(contentsOf: stage), bytes)
        for target in [stage, canonical, cache.appendingPathComponent(stage.lastPathComponent)] {
            do { _ = try await selected.call(download(target)); XCTFail("Only fresh managed scratch may receive bytes") } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: stage), bytes)
        XCTAssertEqual(try Data(contentsOf: canonical), original)
        XCTAssertEqual(try Data(contentsOf: provider), bytes)
        XCTAssertEqual(try cacheNames(), before)
        await selected.cancel()
    }

    func testCancelHeldUploadRetainsSDKCopyUntilCallbackDrainsThenRetiresOnlyOwnedCopy() async throws {
        let bytes = Data("upload held by SDK".utf8), source = documents.appendingPathComponent("attachments/task.txt")
        try bytes.write(to: source)
        let entered = expectation(description: "SDK holds owned asset")
        let held = CloudKitBridgeLocked<CKModifyRecordsOperation?>(nil), completed = CloudKitBridgeLocked(false)
        let calls = CloudKitBridgeLocked(0)
        let selected = bridge { operation in
            calls.update { $0 += 1 }
            DispatchQueue.global().async {
                if let op = operation as? CKFetchRecordsOperation { op.fetchRecordsResultBlock?(.success(())) }
                else if let op = operation as? CKModifyRecordsOperation { held.update { $0 = op }; entered.fulfill() }
                else { self.fail(operation, HostFailure("Unexpected SDK operation")) }
            }
        }
        let input = try upload(source, bytes: bytes), before = try cacheNames()
        let running = Task { defer { completed.update { $0 = true } }; return try await selected.call(input) }
        await fulfillment(of: [entered], timeout: 3)
        let op = try XCTUnwrap(held.value)
        let record = try XCTUnwrap(op.recordsToSave?.first)
        let privateURL = try XCTUnwrap((record["asset"] as? CKAsset)?.fileURL)
        await selected.cancel()
        XCTAssertTrue(op.isCancelled)
        XCTAssertFalse(completed.value, "Cancellation signal is not terminal SDK callback completion")
        XCTAssertEqual(try Data(contentsOf: privateURL), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        DispatchQueue.global().async { op.modifyRecordsResultBlock?(.failure(CancellationError())) }
        do { _ = try await running.value; XCTFail("Retired bridge must refuse") }
        catch { XCTAssertEqual((error as? NativeCloudKitTransportError)?.code, .cancelled) }
        XCTAssertTrue(completed.value)
        XCTAssertFalse(FileManager.default.fileExists(atPath: privateURL.path))
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try cacheNames(), before)
        let count = calls.value
        do { _ = try await selected.call(input); XCTFail("Retired bridge must refuse future work") } catch {}
        XCTAssertEqual(calls.value, count)
    }

    func testMissingAssetReachesActualJobsAsTypedSafeNotFoundWithoutPublishingScratch() async throws {
        let selected = bridge { operation in
            DispatchQueue.global().async {
                guard let op = operation as? CKFetchRecordsOperation else { self.fail(operation, HostFailure("Expected fetch")); return }
                // Genuine record absence: no matched record and successful fetch completion.
                op.fetchRecordsResultBlock?(.success(()))
            }
        }
        let jobs = NativeCloudKitJobs(registry: NativeAttachmentLocalRequests(), perform: selected.call, cancel: selected.cancel)
        defer { jobs.closeAndDrain() }
        let target = documents.appendingPathComponent("attachments/.mindwtr-download-100-1-abcd-task.staged")
        let id = try jobs.submit(download(target))
        let deadline = Date().addingTimeInterval(3)
        var raw: String?
        while raw == nil && Date() < deadline { raw = jobs.next(); if raw == nil { try await Task.sleep(nanoseconds: 1_000_000) } }
        let answer = try object(XCTUnwrap(raw))
        XCTAssertEqual(answer["id"] as? String, id)
        XCTAssertEqual(answer["error"] as? String, "CloudKit operation failed")
        XCTAssertEqual(answer["code"] as? String, "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND")
        XCTAssertNil(answer["value"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}

private final class CloudKitBridgeLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ body: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; body(&stored) }
}
