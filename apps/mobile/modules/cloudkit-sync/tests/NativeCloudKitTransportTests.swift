import CloudKit
import Foundation
import XCTest
@testable import CloudKitAttachmentErrorClassifier

final class NativeCloudKitTransportTests: XCTestCase {
    private func manager(_ scheduler: @escaping (CKDatabaseOperation) -> Void) -> CloudKitSyncManager {
        CloudKitSyncManager(containerIdentifier: "iCloud.synthetic.native-tests", zoneName: "SyntheticZone", operationScheduler: scheduler)
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func ck(_ code: CKError.Code, userInfo: [String: Any] = [:]) -> NSError {
        NSError(domain: CKErrorDomain, code: code.rawValue, userInfo: userInfo)
    }
    private func failure(_ operation: CKDatabaseOperation) {
        let error = CancellationError()
        if let op = operation as? CKQueryOperation { op.queryResultBlock?(.failure(error)) }
        else if let op = operation as? CKFetchRecordsOperation { op.fetchRecordsResultBlock?(.failure(error)) }
        else if let op = operation as? CKModifyRecordsOperation { op.modifyRecordsResultBlock?(.failure(error)) }
        else if let op = operation as? CKModifyRecordZonesOperation { op.modifyRecordZonesResultBlock?(.failure(error)) }
        else { XCTFail("Unexpected SDK operation") }
    }

    func testExplicitConfigurationAndRNSharedDefaultsRemainSeparate() throws {
        XCTAssertEqual(CloudKitSyncManager.shared.containerID, "iCloud.tech.dongdongbh.mindwtr")
        XCTAssertEqual(CloudKitSyncManager.shared.zoneName, "MindwtrZone")
        XCTAssertEqual(CloudKitSyncManager.shared.subscriptionID, "MindwtrZoneSubscription")
        XCTAssertNoThrow(try NativeCloudKitTransport(containerIdentifier: "iCloud.synthetic.native-tests", zoneName: "SyntheticZone"))
        for value in ["", "iCloud.", "iCloud..synthetic", "https://example.invalid", "iCloud.synthetic\n"] {
            XCTAssertThrowsError(try NativeCloudKitTransport(containerIdentifier: value, zoneName: "SyntheticZone"))
        }
        XCTAssertThrowsError(try NativeCloudKitTransport(containerIdentifier: "iCloud.synthetic", zoneName: ""))
    }

    func testClosedInputsAndTypedMetadataRefuseBeforeSDKAdmission() async throws {
        let calls = CloudKitTestLocked(0)
        let original = manager { operation in calls.update { $0 += 1 }; DispatchQueue.global().async { self.failure(operation) } }
        let transport = NativeCloudKitTransport(manager: original)
        for text in ["{}", "null", "[1]", "[{}]", "[{\"id\":\"one\",\"rev\":true}]", "[{\"id\":\"one\",\"tags\":[1]}]",
                     "[{\"id\":\"one\",\"isFocusedToday\":1}]", "[{\"id\":\"one\"},{\"id\":\"one\"}]"] {
            do { _ = try await transport.saveRecords(recordType: "MindwtrTask", recordsJSON: text); XCTFail("Invalid input must refuse") }
            catch { XCTAssertEqual((error as? NativeCloudKitTransportError)?.code, .invalidInput) }
        }
        do { _ = try await transport.fetchAllRecords(recordType: "Unknown"); XCTFail("Unknown type must refuse") } catch {}
        for path in ["relative", "file:///synthetic/asset", "/synthetic/../asset", "/synthetic/./asset", "/synthetic/"] {
            do { _ = try await transport.fetchAttachmentAsset(recordName: "asset", targetPath: path); XCTFail("Plain owned path required") } catch {}
        }
        for metadata in ["[]", "{}", "{\"attachmentId\":\"a\",\"ownerId\":\"o\",\"ownerType\":\"unknown\",\"title\":\"t\",\"updatedAt\":\"now\"}"] {
            do { _ = try await transport.saveAttachmentAsset(recordName: "asset", filePath: "/synthetic/asset", metadataJSON: metadata); XCTFail("Typed metadata required") } catch {}
        }
        do { _ = try await transport.saveRecords(recordType: "MindwtrTask", recordsJSON: String(repeating: " ", count: NativeCloudKitTransport.maximumJSONBytes + 1)); XCTFail("Bounded JSON required") } catch {}
        XCTAssertEqual(calls.value, 0)
    }

    func testCanonicalMapperRoundtripPreservesBOMNestedAttachmentAndDistinctUnicodeIDs() throws {
        let raw = #"[{"id":"\uFEFFfirst","title":"\uFEFFtitle","status":"next","rev":3,"isFocusedToday":true,"description":"note","contexts":["@home"],"attachments":[{"id":"asset","title":"\uFEFFasset"}]},{"id":"é","title":"Composed"},{"id":"e\u0301","title":"Decomposed"}]"#
        let values = try NativeCloudKitTransport.records(raw, recordType: "MindwtrTask")
        XCTAssertEqual(values.count, 3)
        let expected = String(decoding: [0xef, 0xbb, 0xbf] + Array("first".utf8), as: UTF8.self)
        XCTAssertEqual(Data(try XCTUnwrap(values[0]["id"] as? String).utf8), Data(expected.utf8))
        let zone = CKRecordZone.ID(zoneName: "SyntheticZone", ownerName: CKCurrentUserDefaultName)
        let record = try XCTUnwrap(CloudKitRecordMapper.record(from: values[0], recordType: "MindwtrTask", zoneID: zone))
        XCTAssertEqual(record["taskDescription"] as? String, "note")
        let mapped = NativeCloudKitTransport.mappedRecord(record)
        XCTAssertEqual(Data(try XCTUnwrap(mapped["id"] as? String).utf8), Data(expected.utf8))
        XCTAssertEqual(Data(try XCTUnwrap(mapped["title"] as? String).utf8), Data("\u{FEFF}title".utf8))
        let attachments = try XCTUnwrap(mapped["attachments"] as? [[String: Any]])
        XCTAssertEqual(Data(try XCTUnwrap(attachments[0]["title"] as? String).utf8), Data("\u{FEFF}asset".utf8))
        XCTAssertEqual(Set(values.compactMap { ($0["id"] as? String).map { Data($0.utf8) } }).count, 3)
        let metadata = try NativeCloudKitTransport.metadata(#"{"attachmentId":"asset","ownerType":"task","ownerId":"one","title":"\uFEFFasset","updatedAt":"now"}"#, recordName: "asset-record")
        XCTAssertEqual(Data(try XCTUnwrap(metadata["title"] as? String).utf8), Data("\u{FEFF}asset".utf8))
        let stable = try NativeCloudKitTransport.records(NativeCloudKitTransport.encode([mapped]), recordType: "MindwtrTask")
        XCTAssertEqual(Data(try XCTUnwrap(stable[0]["id"] as? String).utf8), Data(expected.utf8))
    }

    func testQueryCollectorNeverReturnsPartialOrEmptyAfterMatchedFailure() throws {
        let zone = CKRecordZone.ID(zoneName: "SyntheticZone", ownerName: CKCurrentUserDefaultName)
        let record = CKRecord(recordType: "MindwtrTask", recordID: CKRecord.ID(recordName: "one", zoneID: zone))
        for hasRecord in [false, true] {
            let collector = NativeCloudKitQueryCollector()
            if hasRecord { collector.matched(.success(record)) }
            collector.matched(.failure(self.ck(.unknownItem)))
            XCTAssertThrowsError(try collector.finish(.success(nil))) { error in
                XCTAssertEqual((error as NSError).code, CKError.Code.partialFailure.rawValue)
            }
        }
        let partial = NativeCloudKitQueryCollector(); partial.matched(.success(record))
        XCTAssertThrowsError(try partial.finish(.failure(self.ck(.unknownItem))))
        let good = NativeCloudKitQueryCollector(); good.matched(.success(record))
        XCTAssertEqual(try good.finish(.success(nil)).records.map { $0.recordID.recordName }, ["one"])
    }

    func testActualManagerDistinguishesInitialAbsentSchemaFromPartialQueryFailure() async throws {
        for matchedFailure in [false, true] {
            let original = manager { operation in
                DispatchQueue.global().async {
                    guard let op = operation as? CKQueryOperation else { XCTFail("Query operation expected"); self.failure(operation); return }
                    if matchedFailure { op.recordMatchedBlock?(CKRecord.ID(recordName: "failed"), .failure(self.ck(.unknownItem))) }
                    op.queryResultBlock?(.failure(self.ck(.unknownItem)))
                }
            }
            do {
                let records = try await original.fetchAllRecords(recordType: "MindwtrTask")
                XCTAssertFalse(matchedFailure, "A matched failure must never become absent schema")
                XCTAssertTrue(records.isEmpty)
            } catch { XCTAssertTrue(matchedFailure) }
        }
    }

    func testRegistryRetirementCancelsOwnedOperationsAndRefusesFurtherAdmission() throws {
        let registry = NativeCloudKitOperationRegistry(), operation = CKModifyRecordsOperation()
        var admitted = 0
        try registry.schedule(operation) { _ in admitted += 1 }
        XCTAssertEqual(registry.count, 1); registry.cancelOperations()
        XCTAssertTrue(operation.isCancelled); XCTAssertEqual(registry.count, 1)
        XCTAssertThrowsError(try registry.schedule(CKModifyRecordsOperation()) { _ in admitted += 1 })
        XCTAssertEqual(admitted, 1); XCTAssertThrowsError(try registry.checkActive())
        registry.complete(operation); XCTAssertEqual(registry.count, 0)
    }

    func testCancellationDuringPrefetchPreventsAnyLaterSaveBatch() async throws {
        let entered = expectation(description: "prefetch admitted"), operation = CloudKitTestLocked<CKFetchRecordsOperation?>(nil)
        let writes = CloudKitTestLocked(0)
        let original = manager { op in
            if let fetch = op as? CKFetchRecordsOperation { operation.update { $0 = fetch }; entered.fulfill() }
            else { writes.update { $0 += 1 }; DispatchQueue.global().async { self.failure(op) } }
        }
        let running = Task { try await original.saveRecords([["id": "one", "title": "Synthetic"]], recordType: "MindwtrTask") }
        await fulfillment(of: [entered], timeout: 2)
        original.cancelOperations()
        let fetch = try XCTUnwrap(operation.value); XCTAssertTrue(fetch.isCancelled)
        fetch.fetchRecordsResultBlock?(.success(()))
        do { _ = try await running.value; XCTFail("Retired owner must refuse") } catch {}
        XCTAssertEqual(writes.value, 0)
    }

    func testNativeAssetConsumerReceivesSDKURLAndMetadataAndCancellationIsSticky() async throws {
        for cancelInsideConsumer in [false, true] {
            let providerURL = URL(fileURLWithPath: "/synthetic/cloudkit-provider-asset")
            let original = manager { operation in
                DispatchQueue.global().async {
                    guard let op = operation as? CKFetchRecordsOperation, let id = op.recordIDs?.first else {
                        XCTFail("Asset record fetch expected"); self.failure(operation); return
                    }
                    let record = CKRecord(recordType: "MindwtrAttachment", recordID: id)
                    record["asset"] = CKAsset(fileURL: providerURL)
                    record["title"] = "\u{FEFF}asset" as CKRecordValue
                    op.perRecordResultBlock?(id, .success(record))
                    op.fetchRecordsResultBlock?(.success(()))
                }
            }
            let transport = NativeCloudKitTransport(manager: original), calls = CloudKitTestLocked(0)
            do {
                let result = try await transport.fetchAttachmentAsset(recordName: "asset-record") { source, metadata in
                    calls.update { $0 += 1 }
                    XCTAssertEqual(source, providerURL)
                    let value = try JSONDecoder().decode([String: String].self, from: Data(metadata.utf8))
                    XCTAssertEqual(value["recordName"], "asset-record")
                    XCTAssertEqual(Data(try XCTUnwrap(value["title"]).utf8), Data("\u{FEFF}asset".utf8))
                    XCTAssertNil(value["filePath"], "SDK source is separate from returned metadata")
                    if cancelInsideConsumer { await transport.cancelOperations() }
                }
                XCTAssertFalse(cancelInsideConsumer)
                XCTAssertFalse(result.isEmpty)
            } catch {
                XCTAssertTrue(cancelInsideConsumer)
                XCTAssertEqual((error as? NativeCloudKitTransportError)?.code, .cancelled)
            }
            XCTAssertEqual(calls.value, 1)
            if cancelInsideConsumer {
                do { _ = try await transport.fetchAllRecords(recordType: "MindwtrTask"); XCTFail("Retired owner must refuse") }
                catch { XCTAssertEqual((error as? NativeCloudKitTransportError)?.code, .cancelled) }
            }
        }
    }

    func testSanitizedErrorClassificationRetainsOnlyStableCodeAndRetryDelay() {
        let zone = ck(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: ["one": ck(.zoneNotFound)]])
        XCTAssertEqual(NativeCloudKitTransport.classify(zone).code, .zoneGone)
        XCTAssertEqual(NativeCloudKitTransport.classify(NSError(domain: "MindwtrCloudKit", code: 1002), attachment: true).code, .attachmentNotFound)
        let limited = ck(.requestRateLimited, userInfo: [CKErrorRetryAfterKey: 7, NSLocalizedDescriptionKey: "PRIVATE provider detail"])
        let mapped = NativeCloudKitTransport.classify(limited)
        XCTAssertEqual(mapped.code, .transient); XCTAssertEqual(mapped.retryAfterSeconds, 7)
        XCTAssertFalse(mapped.localizedDescription.contains("PRIVATE"))
        XCTAssertEqual(NativeCloudKitTransport.classify(CancellationError()).code, .cancelled)
    }
}

private final class CloudKitTestLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ body: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; body(&stored) }
}
