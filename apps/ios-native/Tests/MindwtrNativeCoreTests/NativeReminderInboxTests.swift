import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeReminderInboxTests: XCTestCase {
    private final class SealDiagnostics: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [NativeReminderInbox.SealDiagnostic] = []
        func receive(_ value: NativeReminderInbox.SealDiagnostic) { lock.lock(); defer { lock.unlock() }; values.append(value) }
        var events: [NativeReminderInbox.SealDiagnostic] { lock.lock(); defer { lock.unlock() }; return values }
    }
    private struct SealFixture {
        let home: URL
        let route: NativePersonalIntakeRoute
        let file: URL
    }
    private var container: URL!
    private var stores: [NativeReminderInbox] = []
    private var intakeStores: [NativePersonalIntake] = []
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
        for intake in intakeStores { await intake.close() }
        intakeStores.removeAll()
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
                          action: NativeReminderResponse.Action = .complete, namespace selectedNamespace: String? = nil) throws -> NativeReminderResponse {
        let namespace = selectedNamespace ?? self.namespace
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

    private func sealFixture(isolated: Bool = false) throws -> SealFixture {
        let parent = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/personal-intake/\(UUID().uuidString.lowercased())", isDirectory: true)
        let home = parent.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        additionalRoots.append(parent)
        let owned = home.resolvingSymlinksInPath()
        let route = try NativePersonalIntakeRoute.fixture(home: owned,
            arguments: isolated ? ["--native-ui-test-library", UUID().uuidString.lowercased()] : [], bundleIdentifier: namespace)
        let database: URL
        switch route.selection {
        case .production: throw Injected.failure
        case let .standard(value, _, _): database = value
        case let .isolated(value, container, _, _):
            try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
            database = value
        case .rehearsal: throw Injected.failure
        }
        return .init(home: owned, route: route,
            file: database.deletingLastPathComponent().appendingPathComponent("NotificationResponses/inbox.json"))
    }
    private func open(_ fixture: SealFixture) throws -> NativeReminderInbox {
        let store = try NativeReminderInbox(selection: fixture.route.selection); stores.append(store); return store
    }
    private func seedSeal(_ fixture: SealFixture, active: [[String: Any]] = [], tombstones: [[String: Any]] = [],
                          next: Int64 = 1, floor: String? = nil) throws {
        try FileManager.default.createDirectory(at: fixture.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var state: [String: Any] = ["version": 1, "namespace": fixture.route.namespace, "nextSequence": next,
                                  "active": active, "tombstones": tombstones]
        if let floor { state["retiredThrough"] = floor }
        try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(to: fixture.file)
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

    func testSealExportsOriginalSequencesClocksPhasesTerminalsAndFloorWithoutRewrite() async throws {
        let fixture = try sealFixture(), diagnostics = SealDiagnostics()
        let first = try response(delivered: 90, task: "\u{FEFF}e\u{301} 🧠"), second = try response(delivered: 200, action: .snooze)
        let terminalID = UUID().uuidString.lowercased(), floor = String(format: "%016llx", Double(100).bitPattern)
        let terminalBits = String(format: "%016llx", Double(150).bitPattern)
        try seedSeal(fixture, active: [record(second, sequence: 4, stage: "admitting"), record(first, sequence: 2)],
                     tombstones: [["requestID": terminalID, "deliveredAtBits": terminalBits]], next: 10, floor: floor)
        let original = try Data(contentsOf: fixture.file), store = try open(fixture)
        let token = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) }
        let repeated = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) }
        XCTAssertEqual(token, repeated)
        let exported = try await store.exportSealed(token, route: fixture.route)
        XCTAssertEqual(exported.namespace, fixture.route.namespace); XCTAssertEqual(exported.nextSequence, 10)
        XCTAssertEqual(exported.active.map(\.sequence), [2, 4])
        XCTAssertEqual(exported.active.map(\.item.response), [first, second])
        XCTAssertEqual(exported.active.map(\.item.stage), [.captured, .admitting])
        XCTAssertEqual(Data(try XCTUnwrap(exported.active.first).item.response.payloadJSON.utf8), Data(first.payloadJSON.utf8))
        XCTAssertEqual(exported.terminal.map(\.requestID), [terminalID])
        XCTAssertEqual(exported.terminal.map(\.deliveredAtBits), [terminalBits])
        XCTAssertEqual(exported.retiredThrough, floor); XCTAssertEqual(exported.sourceGeneration.count, 32)
        let again = try await store.exportSealed(token, route: fixture.route)
        XCTAssertEqual(again.sourceGeneration, exported.sourceGeneration)
        XCTAssertEqual(try Data(contentsOf: fixture.file), original)
        XCTAssertEqual(diagnostics.events.count, 1)
        let event = try XCTUnwrap(diagnostics.events.first)
        XCTAssertEqual(event.message, "Native iOS legacy reminder owner sealed")
        XCTAssertEqual(event.releaseCheck, "v1.3.9/ios-personal-intake-seal")
        XCTAssertEqual(event.operation, "seal"); XCTAssertEqual(event.outcome, "confirmed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.home.appendingPathComponent("Library/Application Support/NativePersonalIntake").path))
    }

    func testSealRefusesAllOriginalMutationReferencesWithoutChangingLegacyBytes() async throws {
        let fixture = try sealFixture(), store = try open(fixture)
        let first = try response(), second = try response(delivered: 101)
        _ = try await store.capture(first); _ = try await store.capture(second)
        let admitting = try await store.markAdmitting(second.requestID)
        let original = try Data(contentsOf: fixture.file), oldReference = store
        _ = try await store.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
        await fails { _ = try await oldReference.capture(response(delivered: 300)) }
        await fails { _ = try await oldReference.markAdmitting(first.requestID) }
        await fails { try await oldReference.finish(admitting) }
        await fails { try await oldReference.retry() }
        XCTAssertEqual(try Data(contentsOf: fixture.file), original)
        let retained = try await store.pending()
        XCTAssertEqual(retained.map(\.response), [first, second])
    }

    func testSealMissingSnapshotAndOrdinaryCloseNeverManufactureAuthority() async throws {
        let fixture = try sealFixture(), diagnostics = SealDiagnostics(), store = try open(fixture)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path))
        await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path)); XCTAssertTrue(diagnostics.events.isEmpty)
        _ = try await store.capture(response())
        await store.close()
        await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
        XCTAssertTrue(diagnostics.events.isEmpty)
        let reopened = try open(fixture)
        let token = try await reopened.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) }
        await reopened.close()
        await fails { _ = try await reopened.exportSealed(token, route: fixture.route) }
        await fails { _ = try await reopened.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
        XCTAssertEqual(diagnostics.events.count, 1)
    }

    func testExplicitFreshEmptyPreparationSealsImportsAndCapturesLateCallback() async throws {
        for isolated in [false, true] {
            let fixture = try sealFixture(isolated: isolated), original = try open(fixture)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path))
            try await original.prepareEmptySourceForPersonalIntake(route: fixture.route)
            let bytes = try Data(contentsOf: fixture.file)
            let expected: [String: Any] = ["version": 1, "namespace": fixture.route.namespace,
                "nextSequence": 1, "active": [], "tombstones": []]
            XCTAssertEqual(bytes, try JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys, .withoutEscapingSlashes]))
            var initial = stat(); XCTAssertEqual(lstat(fixture.file.path, &initial), 0)
            try await original.prepareEmptySourceForPersonalIntake(route: fixture.route)
            let seal = try await original.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
            try await original.prepareEmptySourceForPersonalIntake(route: fixture.route)
            let exported = try await original.exportSealed(seal, route: fixture.route)
            XCTAssertEqual(exported.nextSequence, 1); XCTAssertTrue(exported.active.isEmpty)
            XCTAssertTrue(exported.terminal.isEmpty); XCTAssertNil(exported.retiredThrough)
            var repeated = stat(); XCTAssertEqual(lstat(fixture.file.path, &repeated), 0)
            XCTAssertEqual(initial.st_ino, repeated.st_ino); XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
            let intake = try NativePersonalIntake(route: fixture.route, diagnostic: { _ in }); intakeStores.append(intake)
            try await original.handoverCaptures(into: intake, route: fixture.route)
            let imported = try await intake.importedLegacy()
            let progress = try XCTUnwrap(imported)
            XCTAssertEqual(progress.activeCount, 0); XCTAssertEqual(progress.importedCount, 0)
            let initialPage = try await intake.pendingPage(); XCTAssertTrue(initialPage.items.isEmpty)
            let late = try response(namespace: fixture.route.namespace)
            await fails { _ = try await original.capture(late) }
            guard case let .captured(item) = try await intake.captureReminder(late) else { return XCTFail("Late callback belongs to held intake") }
            let admitted = try await original.admitHeldReminder(item, in: intake, route: fixture.route)
            let dispatch = try await original.heldReminderDispatchItem(admitted, in: intake, route: fixture.route)
            XCTAssertEqual(dispatch.response, late)
            _ = try await original.finishHeldReminder(admitted, outcome: .ignored, in: intake, route: fixture.route)
            XCTAssertEqual(try Data(contentsOf: fixture.file), bytes, "Late callbacks never reopen the sealed legacy writer")
            await intake.close(); await original.close()
            let coldOriginal = try NativeReminderInbox.openExistingForHandover(selection: fixture.route.selection); stores.append(coldOriginal)
            let coldIntake = try XCTUnwrap(NativePersonalIntake.openExisting(route: fixture.route, diagnostic: { _ in })); intakeStores.append(coldIntake)
            try await coldOriginal.handoverCaptures(into: coldIntake, route: fixture.route)
            let coldPage = try await coldIntake.pendingPage(); XCTAssertTrue(coldPage.items.isEmpty)
            XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
        }
    }

    func testEmptyPreparationWrongRouteAndClosedOwnerNeverCreateSource() async throws {
        let fixture = try sealFixture(), other = try sealFixture(isolated: true), original = try open(fixture)
        do { try await original.prepareEmptySourceForPersonalIntake(route: other.route); XCTFail("Wrong route must refuse before publication") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .refused) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path))
        await original.close()
        do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("Closed owner has no initialization authority") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path))
    }

    func testEmptyPreparationRefusesSourceAppearingAtPublicationBoundary() async throws {
        let fixture = try sealFixture(), original = try open(fixture)
        let foreign: [String: Any] = ["version": 1, "namespace": fixture.route.namespace,
            "nextSequence": 2, "active": [try record(response(namespace: fixture.route.namespace), sequence: 1)], "tombstones": []]
        let bytes = try JSONSerialization.data(withJSONObject: foreign, options: [.sortedKeys, .withoutEscapingSlashes])
        await original.setIOFaults(beforePublication: { try bytes.write(to: fixture.file) })
        do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("A newly appeared source cannot be replaced by empty") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
        await original.setIOFaults()
        do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("Known source drift stays unavailable") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        await fails { try await original.retry() }
        XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
    }

    func testEmptyPreparationPublicationDebtRequiresExactOriginalRetry() async throws {
        for afterPublication in [false, true] {
            let fixture = try sealFixture(), original = try open(fixture)
            if afterPublication { await original.setIOFaults(afterPublication: { throw Injected.failure }) }
            else { await original.setIOFaults(beforePublication: { throw Injected.failure }) }
            do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("An uncertain empty publication cannot be acknowledged") }
            catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
            let uncertain = try? Data(contentsOf: fixture.file)
            do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("Preparation cannot settle a prior publication") }
            catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
            await fails { _ = try await original.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in }) }
            XCTAssertEqual(try? Data(contentsOf: fixture.file), uncertain)
            await original.setIOFaults(); try await original.retry()
            let settled = try Data(contentsOf: fixture.file)
            var before = stat(); XCTAssertEqual(lstat(fixture.file.path, &before), 0)
            try await original.prepareEmptySourceForPersonalIntake(route: fixture.route)
            _ = try await original.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
            var after = stat(); XCTAssertEqual(lstat(fixture.file.path, &after), 0)
            XCTAssertEqual(before.st_ino, after.st_ino); XCTAssertEqual(try Data(contentsOf: fixture.file), settled)
        }
    }

    func testEmptyPreparationNeverRewritesExistingHistoryOrRecreatesDisappearedSource() async throws {
        let fixture = try sealFixture(), active = try response(namespace: fixture.route.namespace)
        let tombstone = ["requestID": UUID().uuidString.lowercased(), "deliveredAtBits": String(format: "%016llx", Double(102).bitPattern)]
        try seedSeal(fixture, active: [record(active, sequence: 7)], tombstones: [tombstone], next: 8,
            floor: String(format: "%016llx", Double(101).bitPattern))
        let original = try open(fixture), bytes = try Data(contentsOf: fixture.file)
        var before = stat(); XCTAssertEqual(lstat(fixture.file.path, &before), 0)
        try await original.prepareEmptySourceForPersonalIntake(route: fixture.route)
        var after = stat(); XCTAssertEqual(lstat(fixture.file.path, &after), 0)
        XCTAssertEqual(before.st_ino, after.st_ino); XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
        try FileManager.default.removeItem(at: fixture.file)
        do { try await original.prepareEmptySourceForPersonalIntake(route: fixture.route); XCTFail("A known generation's disappearance cannot become empty") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.file.path))
    }

    func testSealRefusesActualPublicationUncertaintyUntilExactOriginalRetry() async throws {
        for afterPublication in [false, true] {
            let fixture = try sealFixture(), store = try open(fixture), diagnostics = SealDiagnostics(), item = try response()
            if afterPublication { await store.setIOFaults(afterPublication: { throw Injected.failure }) }
            else { await store.setIOFaults(beforePublication: { throw Injected.failure }) }
            await fails { _ = try await store.capture(item) }
            let uncertain = try? Data(contentsOf: fixture.file)
            await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
            XCTAssertEqual(try? Data(contentsOf: fixture.file), uncertain); XCTAssertTrue(diagnostics.events.isEmpty)
            await store.setIOFaults(); try await store.retry()
            let settled = try Data(contentsOf: fixture.file)
            let token = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) }
            let exported = try await store.exportSealed(token, route: fixture.route)
            XCTAssertEqual(exported.active.map(\.item.response), [item]); XCTAssertEqual(exported.nextSequence, 2)
            XCTAssertEqual(try Data(contentsOf: fixture.file), settled); XCTAssertEqual(diagnostics.events.count, 1)
        }
    }

    func testSealCannotAdoptForeignSameByteLostAcknowledgmentGeneration() async throws {
        let fixture = try sealFixture(), store = try open(fixture), diagnostics = SealDiagnostics()
        await store.setIOFaults(afterPublication: { throw Injected.failure })
        await fails { _ = try await store.capture(response()) }
        let original = try Data(contentsOf: fixture.file)
        try sameByteReplacement(fixture.file)
        await store.setIOFaults()
        await fails { try await store.retry() }
        await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
        await store.close()
        await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: fixture.file), original); XCTAssertTrue(diagnostics.events.isEmpty)
    }

    func testSealedExportChecksActualLiveFileLockAndRootGenerationEveryTime() async throws {
        for replacement in ["file", "lock", "root"] {
            let fixture = try sealFixture(), store = try open(fixture), diagnostics = SealDiagnostics()
            _ = try await store.capture(response())
            let token = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) }
            let original = try Data(contentsOf: fixture.file)
            if replacement == "root" {
                let moved = fixture.home.deletingLastPathComponent().appendingPathComponent("retained-home")
                try FileManager.default.moveItem(at: fixture.home, to: moved)
                try FileManager.default.copyItem(at: moved, to: fixture.home)
            } else {
                let target = replacement == "file" ? fixture.file : fixture.file.deletingLastPathComponent().appendingPathComponent(".lock")
                let permissions = try FileManager.default.attributesOfItem(atPath: target.path)[.posixPermissions]
                try sameByteReplacement(target)
                if let permissions { try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: target.path) }
            }
            await fails { _ = try await store.exportSealed(token, route: fixture.route) }
            await fails { _ = try await store.sealForPersonalIntake(route: fixture.route) { diagnostics.receive($0) } }
            XCTAssertEqual(try Data(contentsOf: fixture.file), original); XCTAssertEqual(diagnostics.events.count, 1)
        }
    }

    func testSealsCannotCrossValidRoutesOwnersOrColdMutatedSource() async throws {
        let fixture = try sealFixture(), other = try sealFixture(isolated: true)
        let store = try open(fixture), foreign = try open(other), first = try response()
        _ = try await store.capture(first)
        _ = try await foreign.capture(response(namespace: other.route.namespace))
        await fails { _ = try await store.sealForPersonalIntake(route: other.route, diagnostic: { _ in }) }
        let token = try await store.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
        let original = try await store.exportSealed(token, route: fixture.route)
        let foreignToken = try await foreign.sealForPersonalIntake(route: other.route, diagnostic: { _ in })
        await fails { _ = try await foreign.exportSealed(token, route: other.route) }
        await fails { _ = try await store.exportSealed(foreignToken, route: fixture.route) }
        await fails { _ = try await store.exportSealed(token, route: other.route) }
        await store.close()
        let cold = try open(fixture)
        await fails { _ = try await cold.exportSealed(token, route: fixture.route) }
        let coldToken = try await cold.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
        XCTAssertNotEqual(coldToken, token)
        let unchanged = try await cold.exportSealed(coldToken, route: fixture.route)
        XCTAssertEqual(unchanged.sourceGeneration, original.sourceGeneration)
        await cold.close()
        let changed = try response(id: first.requestID, requested: first.requestedAtMs + 1)
        try seedSeal(fixture, active: [record(changed, sequence: 1)], next: 2)
        let mutatedBytes = try Data(contentsOf: fixture.file), mutated = try open(fixture)
        await fails { _ = try await mutated.exportSealed(coldToken, route: fixture.route) }
        let newToken = try await mutated.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
        await fails { _ = try await mutated.exportSealed(token, route: fixture.route) }
        let current = try await mutated.exportSealed(newToken, route: fixture.route)
        XCTAssertNotEqual(current.sourceGeneration, original.sourceGeneration)
        XCTAssertEqual(current.active.first?.item.response.requestedAtMs, changed.requestedAtMs)
        XCTAssertEqual(try Data(contentsOf: fixture.file), mutatedBytes)
    }

    func testSealExportsFullExistingBoundedLegacyStateWithoutCompactionOrSerialization() async throws {
        let fixture = try sealFixture(), floor = String(format: "%016llx", Double(1).bitPattern)
        var active: [[String: Any]] = [], terminal: [[String: Any]] = []
        for index in 0..<128 { active.append(try record(response(delivered: Double(index + 10)), sequence: Int64(index + 1))) }
        for index in 0..<16_384 {
            terminal.append(["requestID": UUID().uuidString.lowercased(), "deliveredAtBits": String(format: "%016llx", Double(index + 2).bitPattern)])
        }
        try seedSeal(fixture, active: active, tombstones: terminal, next: 129, floor: floor)
        let bytes = try Data(contentsOf: fixture.file), store = try open(fixture)
        let token = try await store.sealForPersonalIntake(route: fixture.route, diagnostic: { _ in })
        let exported = try await store.exportSealed(token, route: fixture.route)
        XCTAssertEqual(exported.active.count, 128); XCTAssertEqual(exported.terminal.count, 16_384)
        XCTAssertEqual(exported.retiredThrough, floor); XCTAssertEqual(exported.nextSequence, 129)
        XCTAssertEqual(exported.terminal.map(\.requestID), terminal.compactMap { $0["requestID"] as? String })
        XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
    }
    func testProductionInboxUsesRNParentAndColdExactNamespace() async throws {
        let selected = NativeLaunchSelection.production(containerURL: container)
        let original = try response(namespace: NativeLaunchSelection.productionNamespace)
        let store = try NativeReminderInbox(selection: selected); stores.append(store)
        _ = try await store.capture(original)
        let rnFile = container.appendingPathComponent("Documents/SQLite/NotificationResponses/inbox.json")
        let bytes = try Data(contentsOf: rnFile)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        await store.close()
        let cold = try NativeReminderInbox(selection: selected); stores.append(cold)
        let pending = try await cold.pending()
        XCTAssertEqual(pending.map(\.response), [original])
        do { _ = try await cold.capture(response()); XCTFail("Foreign native namespace must refuse") } catch {}
        XCTAssertEqual(try Data(contentsOf: rnFile), bytes)
    }

}
