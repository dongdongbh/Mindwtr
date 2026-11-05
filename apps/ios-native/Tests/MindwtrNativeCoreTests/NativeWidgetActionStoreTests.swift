import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
final class NativeWidgetActionStoreTests: XCTestCase {
    private let at = Date(timeIntervalSince1970: 1_800_000_000)
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func operation(_ id: String, revision: Int = 0) throws -> (String, String) {
        let selection = NativeLaunchSelection.standard(databaseURL: URL(fileURLWithPath: "/synthetic/db"),
            containerURL: URL(fileURLWithPath: "/synthetic"), namespace: NativeWidgetActionStore.namespace)
        let rawID = String(decoding: id.utf8, as: UTF8.self) as NSString
        return (try NativeSearchIndex.identifier(taskID: id, selection: selection),
                String(decoding: try json([rawID, revision, "2026-10-30T00:00:00.000Z", "next"]), as: UTF8.self))
    }
    private func fixture() throws -> (NativeWidgetActionStore, URL) {
        guard let temporary = ProcessInfo.processInfo.environment["TMPDIR"], !temporary.isEmpty else {
            throw XCTSkip("Set a disk-backed TMPDIR for native widget store tests")
        }
        let root = URL(fileURLWithPath: temporary, isDirectory: true).appendingPathComponent("NativeWidgetActionStoreTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let canonical = root.resolvingSymlinksInPath()
        addTeardownBlock { try FileManager.default.removeItem(at: canonical) }
        return (NativeWidgetActionStore(directory: canonical.appendingPathComponent("NativeWidgets/Actions", isDirectory: true)), canonical)
    }
    private func stateFile(_ root: URL) -> URL { root.appendingPathComponent("NativeWidgets/Actions/" + NativeWidgetActionStore.stateFileName) }
    private func read(_ root: URL) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: stateFile(root))) as? [String: Any])
    }
    private func write(_ value: Any, root: URL) throws { try json(value).write(to: stateFile(root)) }
    private func record(_ identifier: String, _ token: String, index: Int = 0) -> [String: Any] {
        ["id": String(format: "00000000-0000-4000-8000-%012d", index), "identifier": identifier, "token": token,
         "createdAt": at.timeIntervalSince1970 * 1_000, "notBefore": at.timeIntervalSince1970 * 1_000 + 3_000, "claimed": false]
    }

    func testReopenDeduplicatesExactTokensAndPreservesSiblingsPermissionsAndBytes() throws {
        let (store, root) = try fixture(), (identifier, token) = try operation("legacy/é😀")
        let sibling = root.appendingPathComponent("NativeWidgets/next.json"), share = root.appendingPathComponent("NativeShare/synthetic.json")
        try FileManager.default.createDirectory(at: sibling.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: share.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("synthetic cache".utf8).write(to: sibling); try Data("synthetic share".utf8).write(to: share)
        XCTAssertTrue(try store.pendingActions().isEmpty)
        try store.enqueue(identifier: identifier, token: token, now: at)
        let action = try XCTUnwrap(store.pendingActions().first), bytes = try Data(contentsOf: stateFile(root))
        XCTAssertEqual(UUID(uuidString: action.id)?.uuidString.lowercased(), action.id)
        XCTAssertEqual(Data(action.token.utf8), Data(token.utf8)); XCTAssertEqual(action.notBefore, action.createdAt + 3_000)
        let reopened = NativeWidgetActionStore(directory: stateFile(root).deletingLastPathComponent())
        try reopened.enqueue(identifier: identifier, token: token, now: at.addingTimeInterval(1))
        XCTAssertEqual(try reopened.pendingActions().map(\.id), [action.id]); XCTAssertEqual(try Data(contentsOf: stateFile(root)), bytes)
        XCTAssertEqual(try Data(contentsOf: sibling), Data("synthetic cache".utf8)); XCTAssertEqual(try Data(contentsOf: share), Data("synthetic share".utf8))
        let mode = try FileManager.default.attributesOfItem(atPath: stateFile(root).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: stateFile(root).deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testStrictUndoBoundaryDurableClaimReplayAndAcknowledgement() throws {
        let (store, root) = try fixture(), (identifier, token) = try operation("one")
        try store.enqueue(identifier: identifier, token: token, now: at)
        let id = try XCTUnwrap(store.pendingActions().first).id
        XCTAssertThrowsError(try store.acknowledge(id: id)) { XCTAssertEqual($0 as? NativeWidgetActionStoreError, .unclaimedAcknowledgement) }
        XCTAssertTrue(try store.claimReady(now: at.addingTimeInterval(2.999)).isEmpty)
        XCTAssertFalse(try store.cancel(id: id, now: at.addingTimeInterval(3)))
        XCTAssertEqual(try store.claimReady(now: at.addingTimeInterval(3)).map(\.id), [id]); XCTAssertNil(try store.nextReadyAt())
        let reopened = NativeWidgetActionStore(directory: stateFile(root).deletingLastPathComponent())
        XCTAssertEqual(try reopened.claimReady(now: at).map(\.id), [id])
        XCTAssertFalse(try reopened.cancel(id: id, now: at))
        try reopened.acknowledge(id: id); try reopened.acknowledge(id: id)
        let bytes = try Data(contentsOf: stateFile(root))
        try reopened.enqueue(identifier: identifier, token: token, now: at.addingTimeInterval(10))
        XCTAssertTrue(try reopened.pendingActions().isEmpty); XCTAssertEqual(try Data(contentsOf: stateFile(root)), bytes)
        XCTAssertEqual((try read(root)["receipts"] as? [[String: Any]])?.count, 1)
        let changed = try operation("one", revision: 1)
        try reopened.enqueue(identifier: changed.0, token: changed.1, now: at)
        XCTAssertTrue(try reopened.cancel(id: XCTUnwrap(reopened.pendingActions().first).id, now: at.addingTimeInterval(2.999)))
        XCTAssertTrue(try reopened.pendingActions().isEmpty)
    }

    func testProjectionGraceExpiryClaimsAndExactTokenIdentity() throws {
        let (store, _) = try fixture(), (identifier, token) = try operation("é")
        try store.enqueue(identifier: identifier, token: token, now: at)
        let actions = try store.pendingActions(), identity = NativeWidgetActionIdentity(identifier: identifier, token: token)
        XCTAssertNotNil(NativeWidgetActionProjection.pendingAction(for: identity, in: actions, at: at))
        XCTAssertFalse(NativeWidgetActionProjection.isHidden(identity, by: actions, at: at.addingTimeInterval(2.999)))
        XCTAssertNil(NativeWidgetActionProjection.pendingAction(for: identity, in: actions, at: at.addingTimeInterval(3)))
        XCTAssertTrue(NativeWidgetActionProjection.isHidden(identity, by: actions, at: at.addingTimeInterval(3)))
        let otherToken = token.replacingOccurrences(of: "é", with: "é")
        XCTAssertEqual(token, otherToken)
        XCTAssertNil(NativeWidgetActionProjection.pendingAction(for: .init(identifier: identifier, token: otherToken), in: actions, at: at))
        XCTAssertFalse(NativeWidgetActionProjection.isHidden(.init(identifier: identifier, token: otherToken), by: actions, at: at.addingTimeInterval(3)))
        XCTAssertEqual(NativeWidgetActionProjection.timelineDates(pendingActions: actions + actions, now: at), [at, at.addingTimeInterval(3)])
        let claimed = try store.claimReady(now: at.addingTimeInterval(3))
        XCTAssertTrue(NativeWidgetActionProjection.isHidden(identity, by: claimed, at: at))
        XCTAssertEqual(NativeWidgetActionProjection.timelineDates(pendingActions: claimed, now: at), [at])
    }

    func testForeignOrMalformedCapabilitiesAndClocksNeverChangeTheQueue() throws {
        let (store, root) = try fixture(), (identifier, token) = try operation("one")
        try store.enqueue(identifier: identifier, token: token, now: at)
        let bytes = try Data(contentsOf: stateFile(root)), uuid = UUID()
        let foreign = NativeLaunchSelection.isolated(databaseURL: URL(fileURLWithPath: "/synthetic/db"), containerURL: URL(fileURLWithPath: "/synthetic"),
            namespace: "tech.dongdongbh.mindwtr.native-ui." + uuid.uuidString.lowercased(), identifier: uuid)
        let foreignID = try NativeSearchIndex.identifier(taskID: "one", selection: foreign)
        let invalid = [(foreignID, token), (identifier + "=", token), (identifier, "{}"), (identifier, "[]"),
            (identifier, String(decoding: try json(["other", 0, "stamp", "next"]), as: UTF8.self)),
            (identifier, String(decoding: try json(["one", true, "stamp", "next"]), as: UTF8.self)),
            (identifier, String(decoding: try json(["one", -1, "stamp", "next"]), as: UTF8.self)),
            (identifier, String(decoding: try json(["one", 0, "stamp", "unknown"]), as: UTF8.self)),
            (identifier, token + String(repeating: " ", count: 8_192))]
        for (id, raw) in invalid { XCTAssertThrowsError(try store.enqueue(identifier: id, token: raw, now: at)) }
        for time in [Double.nan, .infinity, -1, 8_640_000_000_000_000] {
            XCTAssertThrowsError(try store.enqueue(identifier: identifier, token: token, now: Date(timeIntervalSince1970: time)))
        }
        XCTAssertThrowsError(try store.cancel(id: UUID().uuidString))
        XCTAssertEqual(try Data(contentsOf: stateFile(root)), bytes)
    }

    func testStrictStateFailuresPreserveOriginalBytesAndCannotDeleteClaimedWork() throws {
        let (store, root) = try fixture(), (identifier, token) = try operation("one")
        try store.enqueue(identifier: identifier, token: token, now: at)
        let valid = try read(root), item = try XCTUnwrap((valid["pending"] as? [[String: Any]])?.first)
        var failures: [Data] = [Data("{".utf8), Data(repeating: 0x20, count: 16 * 1_024 * 1_024 + 1)]
        var extra = valid; extra["extra"] = 1; failures.append(try json(extra))
        var foreign = valid; foreign["namespace"] = "tech.dongdongbh.mindwtr"; failures.append(try json(foreign))
        var bool = valid; bool["version"] = true; failures.append(try json(bool))
        for field in ["createdAt", "notBefore", "claimed", "extra"] {
            var row = item
            if field == "claimed" { row[field] = 1 }
            else if field == "notBefore" { row[field] = try XCTUnwrap(item[field] as? NSNumber).doubleValue + 1 }
            else { row[field] = true }
            var state = valid; state["pending"] = [row]; failures.append(try json(state))
        }
        var duplicate = valid; duplicate["pending"] = [item, item]; failures.append(try json(duplicate))
        var overlap = valid; overlap["receipts"] = [["identifier": identifier, "token": token, "consumedAt": 100]]; failures.append(try json(overlap))
        let text = String(decoding: try json(valid), as: UTF8.self)
        failures.append(Data(("{\"version\":1," + String(text.dropFirst())).utf8))
        for bytes in failures {
            try bytes.write(to: stateFile(root))
            XCTAssertThrowsError(try store.pendingActions()); XCTAssertThrowsError(try store.claimReady(now: at.addingTimeInterval(3)))
            XCTAssertThrowsError(try store.acknowledge(id: XCTUnwrap(item["id"] as? String)))
            XCTAssertEqual(try Data(contentsOf: stateFile(root)), bytes)
        }
    }

    func testRegularFileAndNoSymlinkAuthorityFailClosed() throws {
        let (store, root) = try fixture(), (identifier, token) = try operation("one")
        try store.enqueue(identifier: identifier, token: token, now: at)
        let file = stateFile(root), bytes = try Data(contentsOf: file), sibling = root.appendingPathComponent("untouched.json")
        try bytes.write(to: sibling); try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: sibling)
        XCTAssertThrowsError(try store.pendingActions()); XCTAssertThrowsError(try store.enqueue(identifier: identifier, token: token, now: at))
        XCTAssertEqual(try Data(contentsOf: sibling), bytes)
        try FileManager.default.removeItem(at: file); try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        XCTAssertThrowsError(try store.pendingActions())
        try FileManager.default.removeItem(at: file)
        let blocked = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: blocked, withDestinationURL: root.appendingPathComponent("NativeWidgets"))
        XCTAssertThrowsError(try NativeWidgetActionStore(directory: blocked.appendingPathComponent("Actions")).pendingActions())
    }

    func testCapacityNeverEvictsPendingAndConsumedHistoryStaysBounded() throws {
        let (store, root) = try fixture(), first = try operation("first")
        try store.enqueue(identifier: first.0, token: first.1, now: at)
        var state = try read(root), pending: [[String: Any]] = []
        for index in 0..<256 { let op = try operation("pending-\(index)"); pending.append(record(op.0, op.1, index: index)) }
        state["pending"] = pending; try write(state, root: root)
        let bytes = try Data(contentsOf: stateFile(root))
        XCTAssertThrowsError(try store.enqueue(identifier: first.0, token: first.1, now: at)) { XCTAssertEqual($0 as? NativeWidgetActionStoreError, .capacityFull) }
        XCTAssertEqual(try Data(contentsOf: stateFile(root)), bytes)
        var receipts: [[String: Any]] = []
        for index in 0..<512 { let op = try operation("consumed-\(index)"); receipts.append(["identifier": op.0, "token": op.1, "consumedAt": 100]) }
        state["pending"] = [record(first.0, first.1)]; state["receipts"] = receipts; try write(state, root: root)
        let action = try XCTUnwrap(store.claimReady(now: at.addingTimeInterval(3)).first)
        try store.acknowledge(id: action.id)
        let retained = try XCTUnwrap(try read(root)["receipts"] as? [[String: Any]])
        XCTAssertEqual(retained.count, 512); XCTAssertEqual(retained.first?["identifier"] as? String, receipts[1]["identifier"] as? String)
        XCTAssertEqual(retained.last?["token"] as? String, first.1)
    }

    func testByteDistinctUnicodeTaskIDsKeepSeparateOperations() throws {
        let (store, _) = try fixture()
        for id in ["é", "e\u{0301}", "Task", "task", "\u{FEFF}first", "😀"] {
            let op = try operation(id)
            XCTAssertEqual(NativeWidgetTaskLink.decodedTaskID(op.0).map { Data($0.utf8) }, Data(id.utf8), "Qualified decoder must preserve source bytes")
            let token = try XCTUnwrap(NativeJSON.jsonObject(with: Data(op.1.utf8)) as? [Any])
            XCTAssertEqual(Data(try XCTUnwrap(token[0] as? String).utf8), Data(id.utf8), "Fixture token must preserve source bytes")
            try store.enqueue(identifier: op.0, token: op.1, now: at)
        }
        XCTAssertEqual(try store.pendingActions().count, 6)
        XCTAssertEqual(Set(try store.pendingActions().map { Data($0.identifier.utf8) }).count, 6)
    }

    func testCompetingInstancesSerializeReadModifyWriteAndClaimCancelWinner() throws {
        let (store, root) = try fixture(), second = NativeWidgetActionStore(directory: stateFile(root).deletingLastPathComponent())
        let operations = try (0..<24).map { try operation("parallel-\($0)") }
        let group = DispatchGroup(), errors = WidgetActionLocked<[Error]>([])
        for (index, op) in operations.enumerated() {
            group.enter(); DispatchQueue.global().async {
                defer { group.leave() }
                do { try (index.isMultiple(of: 2) ? store : second).enqueue(identifier: op.0, token: op.1) }
                catch { errors.update { $0.append(error) } }
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 15), .success); XCTAssertTrue(errors.value.isEmpty)
        XCTAssertEqual(try store.pendingActions().count, 24)
        let op = try operation("race"), start = DispatchSemaphore(value: 0), done = DispatchGroup()
        try store.enqueue(identifier: op.0, token: op.1, now: at)
        let id = try XCTUnwrap(store.pendingActions().last).id
        let cancellation = WidgetActionLocked<Result<Bool, Error>?>(nil), claim = WidgetActionLocked<Result<[NativeWidgetPendingAction], Error>?>(nil)
        let before = at.addingTimeInterval(2.999), boundary = at.addingTimeInterval(3)
        done.enter(); DispatchQueue.global().async { start.wait(); cancellation.update { $0 = Result { try second.cancel(id: id, now: before) } }; done.leave() }
        done.enter(); DispatchQueue.global().async { start.wait(); claim.update { $0 = Result { try store.claimReady(now: boundary) } }; done.leave() }
        start.signal(); start.signal(); XCTAssertEqual(done.wait(timeout: .now() + 10), .success)
        let cancelled = try XCTUnwrap(cancellation.value).get(), claimed = try XCTUnwrap(claim.value).get().filter { $0.id == id }
        if cancelled { XCTAssertTrue(claimed.isEmpty); XCTAssertFalse(try store.pendingActions().contains { $0.id == id }) }
        else { XCTAssertEqual(claimed.map(\.id), [id]); XCTAssertTrue(try XCTUnwrap(store.pendingActions().first { $0.id == id }).claimed) }
    }

    #if DEBUG && !MINDWTR_WIDGET_EXTENSION
    func testFailedWritesRetainStateAndUncertainPromotionReplaysWithoutDuplicate() throws {
        let (store, root) = try fixture(), first = try operation("first"), next = try operation("next")
        try store.enqueue(identifier: first.0, token: first.1, now: at)
        let initial = try Data(contentsOf: stateFile(root))
        store.beforePromotion = { throw CocoaError(.fileWriteUnknown) }
        XCTAssertThrowsError(try store.enqueue(identifier: next.0, token: next.1, now: at))
        XCTAssertEqual(try Data(contentsOf: stateFile(root)), initial)
        XCTAssertThrowsError(try store.claimReady(now: at.addingTimeInterval(3)))
        XCTAssertEqual(try Data(contentsOf: stateFile(root)), initial)
        store.beforePromotion = nil; store.afterPromotion = { throw CocoaError(.fileWriteUnknown) }
        XCTAssertThrowsError(try store.enqueue(identifier: next.0, token: next.1, now: at))
        store.afterPromotion = nil
        let reopened = NativeWidgetActionStore(directory: stateFile(root).deletingLastPathComponent())
        let ids = try reopened.pendingActions().map(\.id)
        XCTAssertEqual(ids.count, 2)
        try reopened.enqueue(identifier: next.0, token: next.1, now: at)
        XCTAssertEqual(try reopened.pendingActions().map(\.id), ids)
        let claimed = try reopened.claimReady(now: at.addingTimeInterval(3))
        reopened.beforePromotion = { throw CocoaError(.fileWriteUnknown) }
        XCTAssertThrowsError(try reopened.acknowledge(id: XCTUnwrap(claimed.first).id))
        XCTAssertEqual(try reopened.pendingActions().map(\.id), ids)
        reopened.beforePromotion = nil; reopened.afterPromotion = { throw CocoaError(.fileWriteUnknown) }
        XCTAssertThrowsError(try reopened.acknowledge(id: XCTUnwrap(claimed.first).id))
        reopened.afterPromotion = nil
        try reopened.acknowledge(id: XCTUnwrap(claimed.first).id)
        try reopened.enqueue(identifier: first.0, token: first.1, now: at)
        XCTAssertEqual(try reopened.pendingActions().count, 1)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: stateFile(root).deletingLastPathComponent().path).contains { $0.hasSuffix(".tmp") })
    }
    #endif
}

private final class WidgetActionLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ body: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; body(&stored) }
}
