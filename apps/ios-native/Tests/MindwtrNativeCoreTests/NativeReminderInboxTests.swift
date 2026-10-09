import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeReminderInboxTests: XCTestCase {
    private var container: URL!
    private var stores: [NativeReminderInbox] = []
    private var additionalRoots: [URL] = []
    private let namespace = "tech.dongdongbh.mindwtr.response-tests"
    private enum Injected: Error { case failure }
    private var library: URL { container.appendingPathComponent("Library/NativeFoundation") }
    private var directory: URL { library.appendingPathComponent("NotificationResponses") }
    private var file: URL { directory.appendingPathComponent("inbox.json") }
    private var selection: NativeLaunchSelection {
        .standard(databaseURL: library.appendingPathComponent("mindwtr.sqlite"), containerURL: container, namespace: namespace)
    }

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        container = base.appendingPathComponent(".mindwtr-native-tests/reminder-inbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }
    override func tearDown() async throws {
        for store in stores { await store.close() }
        stores.removeAll()
        for root in [container].compactMap({ $0 }) + additionalRoots where FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        additionalRoots.removeAll()
    }
    private func open() throws -> NativeReminderInbox {
        let store = try NativeReminderInbox(selection: selection); stores.append(store); return store
    }
    private func response(id: String = UUID().uuidString.lowercased(), delivered: Double = 100,
                          requested: Int64 = 1_700_000_000_123, task: String = "task", title: String = "\u{FEFF}été 🧠", json: String? = nil,
                          action: NativeReminderResponse.Action = .complete) throws -> NativeReminderResponse {
        let payload: String
        if let json { payload = json }
        else {
            let fields: [String: Any]
            switch action {
            case .complete: fields = ["requestId": id, "taskId": task]
            case .dismiss: fields = [:]
            case .open: fields = ["notificationId": "mindwtr-native:\(namespace):1", "actionIdentifier": "open", "taskId": task]
            case .snooze:
                fields = ["requestId": id, "requestedAt": requested,
                    "details": ["title": title, "message": "body", "tag": "tag", "play_sound": true,
                                "snooze_interval": 10, "data": ["alarmKey": "task:task"], "extra": ["e\u{301}", "é"]]]
            }
            payload = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8))
        }
        return NativeReminderResponse(requestID: id, notificationIdentifier: "mindwtr-native:\(namespace):1", action: action,
            deliveredAtBits: String(format: "%016llx", delivered.bitPattern), requestedAtMs: requested, payloadJSON: payload)
    }
    private func fails(_ operation: () async throws -> Void, file expected: Data? = nil,
                       source: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected fixed unavailable failure", file: source, line: line) }
        catch { XCTAssertEqual(error.localizedDescription, "Native reminder response storage is unavailable", file: source, line: line) }
        if let expected {
            do { XCTAssertEqual(try Data(contentsOf: file), expected, file: source, line: line) }
            catch { XCTFail("Accepted file became unreadable", file: source, line: line) }
        }
    }
    private func seed(active: [[String: Any]] = [], tombstones: [[String: Any]] = [], next: Int64 = 1,
                      extra: [String: Any] = [:]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var state: [String: Any] = ["version": 1, "namespace": namespace, "nextSequence": next,
                                    "active": active, "tombstones": tombstones]
        for (field, value) in extra { state[field] = value }
        try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(to: file)
    }
    private func record(_ response: NativeReminderResponse, sequence: Int64, stage: String = "captured") throws -> [String: Any] {
        ["sequence": sequence, "stage": stage,
         "response": try JSONSerialization.jsonObject(with: JSONEncoder().encode(response))]
    }
    private func sameByteReplacement(_ url: URL) throws {
        let bytes = try Data(contentsOf: url)
        let foreign = url.deletingLastPathComponent().appendingPathComponent("foreign-\(UUID().uuidString)")
        try bytes.write(to: foreign)
        guard rename(foreign.path, url.path) == 0 else { throw Injected.failure }
    }

    func testCaptureRestartKeepsExactPayloadTimeAndInsertionOrder() async throws {
        let first = try response(task: "\u{FEFF}e\u{301} 🧠")
        let second = try response(delivered: 101, action: .snooze)
        let store = try open()
        let captured = try await store.capture(first)
        XCTAssertEqual(captured?.stage, .captured)
        _ = try await store.capture(second)
        let bytes = try Data(contentsOf: file)
        await store.close()
        let reopened = try open()
        let pending = try await reopened.pending()
        XCTAssertEqual(pending.map(\.response), [first, second])
        XCTAssertEqual(Data(pending[0].response.payloadJSON.utf8), Data(first.payloadJSON.utf8))
        XCTAssertEqual(Data(pending[1].response.payloadJSON.utf8), Data(second.payloadJSON.utf8))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testDuplicateCallbackPreservesFirstReceiptClockAndPayload() async throws {
        let first = try response(action: .snooze)
        let later = try response(id: first.requestID, requested: first.requestedAtMs + 10_000, action: .snooze)
        let store = try open()
        let original = try await store.capture(first)
        let bytes = try Data(contentsOf: file)
        let repeated = try await store.capture(later)
        XCTAssertEqual(repeated, original)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let inconsistent = try response(id: first.requestID, delivered: 102, action: .snooze)
        await fails({ _ = try await store.capture(inconsistent) }, file: bytes)
    }

    func testEmptySnoozeTitleRoundtripsWithoutAddingSchemaRestrictions() async throws {
        let item = try response(title: "", action: .snooze)
        let store = try open()
        let captured = try await store.capture(item)
        XCTAssertEqual(captured?.response, item)
        await store.close()
        let reopened = try open()
        let pending = try await reopened.pending()
        XCTAssertEqual(pending.map(\.response), [item])
    }

    func testAdmittingRestartAndFinishHaveContentFreeTerminalDuplicate() async throws {
        let item = try response(task: "Private task content")
        let store = try open()
        let captureResult = try await store.capture(item)
        let captured = try XCTUnwrap(captureResult)
        let capturedBytes = try Data(contentsOf: file)
        await fails({ try await store.finish(captured) }, file: capturedBytes)
        let admitted = try await store.markAdmitting(item.requestID)
        XCTAssertEqual(admitted.stage, .admitting)
        let admittedBytes = try Data(contentsOf: file)
        let altered = NativeReminderInbox.Item(response: try response(id: item.requestID, task: "changed"), stage: .admitting)
        await fails({ try await store.finish(altered) }, file: admittedBytes)
        let repeated = try await store.markAdmitting(item.requestID)
        XCTAssertEqual(repeated, admitted)
        XCTAssertEqual(try Data(contentsOf: file), admittedBytes)
        await store.close()
        let reopened = try open()
        let pending = try await reopened.pending()
        XCTAssertEqual(pending.map(\.stage), [.admitting])
        try await reopened.finish(admitted)
        let terminal = try Data(contentsOf: file)
        XCTAssertFalse(String(decoding: terminal, as: UTF8.self).contains("Private task content"))
        XCTAssertFalse(String(decoding: terminal, as: UTF8.self).contains("payloadJSON"))
        try await reopened.finish(admitted)
        let duplicate = try await reopened.capture(item)
        XCTAssertNil(duplicate)
        XCTAssertEqual(try Data(contentsOf: file), terminal)
        let unknown = NativeReminderInbox.Item(response: try response(), stage: .admitting)
        await fails({ try await reopened.finish(unknown) }, file: terminal)
    }

    func testBeforePublicationFailureBlocksUnrelatedWorkUntilExactRetry() async throws {
        let accepted = try response(), uncertain = try response(delivered: 102), unrelated = try response(delivered: 103)
        let store = try open()
        _ = try await store.capture(accepted)
        let before = try Data(contentsOf: file)
        await store.setIOFaults(beforePublication: { throw Injected.failure })
        await fails({ _ = try await store.capture(uncertain) }, file: before)
        await fails({ _ = try await store.pending() }, file: before)
        await fails({ _ = try await store.capture(unrelated) }, file: before)
        await fails({ _ = try await store.markAdmitting(accepted.requestID) }, file: before)
        await store.setIOFaults()
        try await store.retry()
        let pending = try await store.pending()
        XCTAssertEqual(pending.map(\.response), [accepted, uncertain])
        let repeated = try await store.capture(uncertain)
        XCTAssertEqual(repeated?.response, uncertain)
    }

    func testLostAfterPublicationAcknowledgmentRepairsWithoutSecondAcceptance() async throws {
        let item = try response(action: .snooze), unrelated = try response(delivered: 103)
        let store = try open()
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        await fails({ _ = try await store.capture(item) })
        let published = try Data(contentsOf: file)
        var generation = stat()
        XCTAssertEqual(lstat(file.path, &generation), 0)
        await fails({ _ = try await store.capture(unrelated) }, file: published)
        await fails({ _ = try await store.pending() }, file: published)
        await store.setIOFaults()
        try await store.retry()
        var repaired = stat()
        XCTAssertEqual(lstat(file.path, &repaired), 0)
        XCTAssertEqual(generation.st_ino, repaired.st_ino)
        XCTAssertEqual(try Data(contentsOf: file), published)
        let pending = try await store.pending()
        XCTAssertEqual(pending.map(\.response), [item])
        await store.close()
        let reopened = try open()
        let coldPending = try await reopened.pending()
        XCTAssertEqual(coldPending.map(\.response), [item])
    }

    func testUncertainStageAndFinishAreSettledExactly() async throws {
        let item = try response()
        let store = try open()
        _ = try await store.capture(item)
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        await fails({ _ = try await store.markAdmitting(item.requestID) })
        await store.setIOFaults()
        try await store.retry()
        let pending = try await store.pending()
        XCTAssertEqual(pending.map(\.stage), [.admitting])
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        let admitted = try await store.markAdmitting(item.requestID)
        await fails({ try await store.finish(admitted) })
        await store.setIOFaults()
        try await store.retry()
        let finished = try await store.pending()
        XCTAssertTrue(finished.isEmpty)
        let duplicate = try await store.capture(item)
        XCTAssertNil(duplicate)
    }

    func testExclusiveOwnerAndIdempotentClosePermitReopen() async throws {
        let store = try open()
        XCTAssertThrowsError(try NativeReminderInbox(selection: selection))
        let item = try response()
        _ = try await store.capture(item)
        await store.close(); await store.close()
        await fails({ _ = try await store.pending() })
        let reopened = try open()
        let pending = try await reopened.pending()
        XCTAssertEqual(pending.map(\.response), [item])
    }

    func testAbsentContainerRehearsalAndOutsideLibraryRefuseWithoutCreatingPaths() throws {
        let missing = container.appendingPathComponent("missing")
        XCTAssertThrowsError(try NativeReminderInbox(selection: .isolated(databaseURL: missing.appendingPathComponent("mindwtr.sqlite"),
            containerURL: missing, namespace: namespace, identifier: UUID())))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        XCTAssertThrowsError(try NativeReminderInbox(selection: .rehearsal(containerURL: container,
            databaseURL: library.appendingPathComponent("mindwtr.sqlite"), bundleIdentifier: namespace)))
        XCTAssertThrowsError(try NativeReminderInbox(selection: .standard(databaseURL: container.deletingLastPathComponent().appendingPathComponent("foreign.sqlite"),
            containerURL: container, namespace: namespace)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.path))
    }

    func testSameByteFileAndLockReplacementPoisonOwnerAndPreserveForeignBytes() async throws {
        let store = try open()
        _ = try await store.capture(response())
        let bytes = try Data(contentsOf: file)
        try sameByteReplacement(file)
        await fails({ _ = try await store.pending() }, file: bytes)
        await fails({ try await store.retry() }, file: bytes)
        await store.close()
        let reopened = try open()
        try sameByteReplacement(directory.appendingPathComponent(".lock"))
        await fails({ _ = try await reopened.capture(response()) }, file: bytes)
        await fails({ try await reopened.retry() }, file: bytes)
    }

    func testLostAcknowledgmentCannotAdoptForeignSameByteGeneration() async throws {
        let item = try response()
        let store = try open()
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        await fails({ _ = try await store.capture(item) })
        let bytes = try Data(contentsOf: file)
        try sameByteReplacement(file)
        await store.setIOFaults()
        await fails({ try await store.retry() }, file: bytes)
        await fails({ _ = try await store.pending() }, file: bytes)
    }

    func testMovedContainerAndForeignReplacementRemainUntouched() async throws {
        let store = try open()
        _ = try await store.capture(response())
        let accepted = try Data(contentsOf: file)
        let moved = container.deletingLastPathComponent().appendingPathComponent("moved-\(UUID().uuidString)")
        try FileManager.default.moveItem(at: container, to: moved); additionalRoots.append(moved)
        try seed(extra: ["foreign": true])
        let foreign = try Data(contentsOf: file)
        await fails({ _ = try await store.capture(response(delivered: 200)) }, file: foreign)
        XCTAssertEqual(try Data(contentsOf: moved.appendingPathComponent("Library/NativeFoundation/NotificationResponses/inbox.json")), accepted)
        await fails({ try await store.retry() }, file: foreign)
    }

    func testSymlinkAncestryAndUnsafeFileKindsRefuseWithoutMutation() async throws {
        let foreign = container.appendingPathComponent("foreign")
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: true)
        let link = container.appendingPathComponent("Library")
        XCTAssertEqual(symlink(foreign.path, link.path), 0)
        XCTAssertThrowsError(try open())
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: foreign.path).isEmpty)
        try FileManager.default.removeItem(at: link)
        try seed()
        let original = try Data(contentsOf: file)
        let target = container.appendingPathComponent("target.json")
        try original.write(to: target)
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(symlink(target.path, file.path), 0)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: target), original)
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(Darwin.link(target.path, file.path), 0)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: target), original)
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(mkfifo(file.path, 0o600), 0)
        XCTAssertThrowsError(try open())
        var shape = stat()
        XCTAssertEqual(lstat(file.path, &shape), 0)
        XCTAssertEqual(shape.st_mode & S_IFMT, S_IFIFO)
    }

    func testCorruptOversizedAndForeignNamespaceFilesRemainUnchanged() throws {
        try seed()
        for bytes in [Data("{bad".utf8), Data(repeating: 32, count: 24 * 1024 * 1024 + 1)] {
            try bytes.write(to: file)
            XCTAssertThrowsError(try open())
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
        try seed(extra: ["namespace": "foreign"])
        let foreign = try Data(contentsOf: file)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: file), foreign)
    }

    func testStrictSchemaIDsSequencesStagesAndPayloadsRefuse() throws {
        let item = try response(), good = try record(item, sequence: 1)
        let invalidActive: [[String: Any]] = [
            ["sequence": 1, "stage": "captured", "response": ["requestID": "bad"]],
            try record(item, sequence: 1, stage: "finished"),
            ["sequence": true, "stage": "captured", "response": good["response"]!],
        ]
        for active in invalidActive.map({ [$0] }) + [[good, good]] {
            try seed(active: active, next: 2)
            let bytes = try Data(contentsOf: file)
            XCTAssertThrowsError(try open())
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
        try seed(active: [good], next: 1)
        XCTAssertThrowsError(try open())
        try seed(active: [good], tombstones: [["requestID": item.requestID, "deliveredAtBits": item.deliveredAtBits]], next: 2)
        XCTAssertThrowsError(try open())
        for bits in ["7ff0000000000000", "7ff8000000000000", "405900000000000A", "bad"] {
            try seed(tombstones: [["requestID": item.requestID, "deliveredAtBits": bits]])
            XCTAssertThrowsError(try open())
        }
        let invalidFields: [[String: Any]] = [["version": true], ["nextSequence": 1.5], ["extra": 1]]
        for extra in invalidFields {
            try seed(extra: extra)
            XCTAssertThrowsError(try open())
        }
    }

    func testMalformedIncomingResponsesRefuseWithFixedErrorsAndNoPublication() async throws {
        let store = try open(), id = UUID().uuidString.lowercased()
        for item in [try response(id: "BAD"), try response(delivered: .infinity),
                     try response(id: id, json: "{bad"), try response(id: id, json: "{\"requestId\":\"\(id)\",\"taskId\":true}"),
                     try response(id: id, json: String(repeating: " ", count: 65_537)),
                     try response(id: id, requested: 8_640_000_000_000_001)] {
            await fails({ _ = try await store.capture(item) })
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        }
        let captured = try await store.capture(response())
        XCTAssertNotNil(captured)
    }

    func testCompleteRawPayloadCeilingRefusesPaddingWithoutChangingAcceptedFile() async throws {
        let store = try open(), boundaryID = UUID().uuidString.lowercased()
        let boundaryJSON = "{\"requestId\":\"\(boundaryID)\",\"taskId\":\"task\"}"
        let boundary = try response(id: boundaryID, json: boundaryJSON + String(repeating: " ", count: 4_096 - boundaryJSON.utf8.count))
        XCTAssertEqual(boundary.payloadJSON.utf8.count, 4_096)
        let captured = try await store.capture(boundary)
        XCTAssertNotNil(captured)
        let accepted = try Data(contentsOf: file)
        for size in [4_097, 65_536] {
            let id = UUID().uuidString.lowercased()
            let json = "{\"requestId\":\"\(id)\",\"taskId\":\"task\"}"
            let oversized = try response(id: id, json: json + String(repeating: " ", count: size - json.utf8.count))
            XCTAssertEqual(oversized.payloadJSON.utf8.count, size)
            await fails({ _ = try await store.capture(oversized) }, file: accepted)
        }
    }

    func testDuplicateCompletePayloadKeysRefuseWithoutChangingAcceptedFile() async throws {
        let store = try open()
        _ = try await store.capture(response())
        let accepted = try Data(contentsOf: file)
        let payloads: [(String) -> String] = [
            { id in "{\"requestId\":\"\(id)\",\"requestId\":\"\(id)\",\"taskId\":\"task\"}" },
            { id in "{\"requestId\":\"\(id)\",\"taskId\":\"task\",\"task\\u0049d\":\"task\"}" },
            { id in "{\"requestId\":\"\(id)\",\"taskId\":{\"nested\":1,\"nest\\u0065d\":2},\"taskId\":\"task\"}" },
        ]
        for payload in payloads {
            let id = UUID().uuidString.lowercased()
            let duplicate = try response(id: id, json: payload(id))
            await fails({ _ = try await store.capture(duplicate) }, file: accepted)
        }
    }

    func testDuplicateSnoozePayloadKeysRefuseWithoutChangingAcceptedFile() async throws {
        let store = try open()
        _ = try await store.capture(response(action: .snooze))
        let accepted = try Data(contentsOf: file)
        let details = #"{"title":"title","message":"body","tag":"tag","play_sound":true,"snooze_interval":10,"data":{"alarmKey":"task:task"},"extra":{"nested":1}}"#
        let payloads: [(String) -> String] = [
            { id in "{\"requestId\":\"\(id)\",\"requestId\":\"\(id)\",\"requestedAt\":1700000000123,\"details\":\(details)}" },
            { id in "{\"requestId\":\"\(id)\",\"requestedAt\":1700000000123,\"requested\\u0041t\":1700000000123,\"details\":\(details)}" },
            { id in "{\"requestId\":\"\(id)\",\"requestedAt\":1700000000123,\"details\":\(details.replacingOccurrences(of: #""nested":1"#, with: #""nested":1,"nested":2"#))}" },
            { id in "{\"requestId\":\"\(id)\",\"requestedAt\":1700000000123,\"details\":\(details.replacingOccurrences(of: #""nested":1"#, with: #""nested":1,"nest\u0065d":2"#))}" },
        ]
        for payload in payloads {
            let id = UUID().uuidString.lowercased()
            let duplicate = try response(id: id, json: payload(id), action: .snooze)
            await fails({ _ = try await store.capture(duplicate) }, file: accepted)
        }
    }

    func testDuplicateStoredStateKeysRefuseAndPreserveRawFile() async throws {
        try seed(active: [record(response(), sequence: 1)], next: 2)
        let original = String(decoding: try Data(contentsOf: file), as: UTF8.self)
        XCTAssertTrue(original.contains(#""version":1"#))
        XCTAssertTrue(original.contains(#""stage":"captured""#))
        let duplicateFiles = [
            original.replacingOccurrences(of: #""version":1"#, with: #""version":1,"version":1"#),
            original.replacingOccurrences(of: #""version":1"#, with: #""version":1,"vers\u0069on":1"#),
            original.replacingOccurrences(of: #""stage":"captured""#, with: #""stage":"captured","stage":"captured""#),
            original.replacingOccurrences(of: #""stage":"captured""#, with: #""stage":"captured","sta\u0067e":"captured""#),
        ]
        for duplicate in duplicateFiles {
            let bytes = Data(duplicate.utf8)
            try bytes.write(to: file)
            do {
                let unexpected = try open()
                await unexpected.close()
                XCTFail("Expected duplicate raw state to refuse")
            } catch { XCTAssertEqual(error.localizedDescription, "Native reminder response storage is unavailable") }
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
    }

    func testActiveCapacityRefusesWithoutChangingAcceptedBytes() async throws {
        let items = try (0..<128).map { try response(delivered: Double($0)) }
        try seed(active: items.enumerated().map { try record($0.element, sequence: Int64($0.offset + 1)) }, next: 129)
        let store = try open(), bytes = try Data(contentsOf: file)
        await fails({ _ = try await store.capture(response(delivered: 200)) }, file: bytes)
        let pending = try await store.pending()
        XCTAssertEqual(pending.map(\.response), items)
        let duplicate = try await store.capture(items[0])
        XCTAssertEqual(duplicate?.response, items[0])
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testTerminalCapacityCompactsAtomicallyProtectingActiveAndOldReplay() async throws {
        let finishing = try response(delivered: 20_000), active = try response(delivered: 0)
        let tombstones = (1...16_384).map { value -> [String: Any] in
            ["requestID": UUID().uuidString.lowercased(), "deliveredAtBits": String(format: "%016llx", Double(value).bitPattern)]
        }
        try seed(active: [record(finishing, sequence: 1, stage: "admitting"), record(active, sequence: 2)],
                 tombstones: tombstones, next: 3)
        let store = try open(), before = try Data(contentsOf: file)
        await store.setIOFaults(beforePublication: { throw Injected.failure })
        let finishingItem = try await store.markAdmitting(finishing.requestID)
        await fails({ try await store.finish(finishingItem) }, file: before)
        await store.setIOFaults()
        try await store.retry()
        let raw = try XCTUnwrap(try NativeJSON.jsonObject(with: Data(contentsOf: file)) as? NSDictionary)
        XCTAssertEqual(raw["retiredThrough"] as? String, String(format: "%016llx", Double(1).bitPattern))
        XCTAssertEqual((raw["tombstones"] as? NSArray)?.count, 16_384)
        let pending = try await store.pending()
        XCTAssertEqual(pending.map(\.response), [active])
        let existing = try await store.capture(active)
        XCTAssertEqual(existing?.response, active)
        let stale = try await store.capture(response(delivered: 1))
        XCTAssertNil(stale)
        let later = try await store.capture(response(delivered: 2))
        XCTAssertNotNil(later)
        let oldActive = try await store.markAdmitting(active.requestID)
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        await fails({ try await store.finish(oldActive) })
        await store.setIOFaults()
        try await store.retry()
        try await store.finish(oldActive)
        await store.close()
        let reopened = try open()
        try await reopened.finish(oldActive)
        let retiredActive = try await reopened.capture(active)
        XCTAssertNil(retiredActive)
        let surviving = try await reopened.pending()
        XCTAssertEqual(surviving.count, 1)
    }
}
