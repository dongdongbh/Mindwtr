import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
private final class ControlledSearchIndex: NativeSearchIndexPort {
    struct Request {
        let domain: String
        let items: [NativeSearchIndexEntry]?
    }
    var requests: [Request] = []
    var stored: [String: String] = ["foreign-item": "foreign.domain"]
    var didCall: (() -> Void)?
    private var pending: [CheckedContinuation<Void, Error>] = []
    func remove(domain: String) async throws {
        try await request(.init(domain: domain, items: nil))
        stored = stored.filter { $0.value != domain }
    }
    func add(_ items: [NativeSearchIndexEntry], domain: String) async throws {
        try await request(.init(domain: domain, items: items))
        for item in items { stored[item.identifier] = domain }
    }
    private func request(_ request: Request) async throws {
        try await withCheckedThrowingContinuation { continuation in
            pending.append(continuation); requests.append(request); didCall?()
        }
    }
    func finish(_ error: Error? = nil) {
        let continuation = pending.removeFirst()
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }
}

@MainActor
final class NativeSearchIndexTests: XCTestCase {
    private enum Injected: Error { case failed }
    private let root = URL(fileURLWithPath: "/home/dd/native-search-synthetic", isDirectory: true)
    private var selection: NativeLaunchSelection {
        .standard(databaseURL: root.appendingPathComponent("core.sqlite"), containerURL: root,
                  namespace: "tech.dongdongbh.mindwtr.native.dev")
    }
    private func snapshot(_ id: String = "exact task/漢+😀e\u{0301}") throws -> NativeSearchSnapshot {
        let item: [String: Any] = ["id": id, "title": "Synthetic title", "list": "next", "projectName": "Synthetic project",
                                  "dueDate": "2026-10-09", "startDate": "2026-10-09T00:00:00.000Z"]
        return try NativeSearchSnapshot(json: String(decoding: JSONSerialization.data(withJSONObject: ["items": [item]], options: [.sortedKeys]), as: UTF8.self))
    }
    private func waitForCalls(_ port: ControlledSearchIndex, _ count: Int) async {
        if port.requests.count >= count { return }
        let reached = expectation(description: "Index request \(count)")
        port.didCall = { if port.requests.count >= count { reached.fulfill() } }
        await fulfillment(of: [reached], timeout: 2)
        port.didCall = nil
    }

    func testScopedIdentifiersPreserveExactUTF8AndRejectForeignNoncanonicalInput() async throws {
        let port = ControlledSearchIndex(), removed = expectation(description: "Initial owned cleanup")
        let index = try NativeSearchIndex(selection: selection, port: port) { outcome, _ in
            XCTAssertEqual(outcome, "removalQueued"); removed.fulfill()
        }
        let ids = ["é", "e\u{0301}", "Task", "task", " task ", "\u{FEFF}task", "\u{FEFF}", "\u{FEFF}\u{FEFF}task", "task/漢+😀\u{0000}", String(repeating: "😀", count: 250)]
        let identifiers = try ids.map { try NativeSearchIndex.identifier(taskID: $0, selection: selection) }
        XCTAssertEqual(Set(identifiers).count, ids.count)
        for (id, identifier) in zip(ids, identifiers) {
            XCTAssertEqual(index.taskID(for: identifier).map { Data($0.utf8) }, Data(id.utf8))
            XCTAssertNil(index.taskID(for: identifier + "="))
        }
        let prefix = String(identifiers[0].prefix(65))
        let malformed: [[UInt8]] = [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xef, 0xbb, 0xbf, 0xff]]
        for bytes in malformed {
            let encoded = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            XCTAssertNil(index.taskID(for: prefix + encoded), "Malformed UTF8 must not become a replacement-character task ID")
        }
        let uuid = UUID(), foreign = NativeLaunchSelection.isolated(databaseURL: root, containerURL: root,
            namespace: "tech.dongdongbh.mindwtr.native-ui." + uuid.uuidString.lowercased(), identifier: uuid)
        XCTAssertNil(index.taskID(for: try NativeSearchIndex.identifier(taskID: ids[0], selection: foreign)))
        for id in ["", String(repeating: "😀", count: 251)] {
            XCTAssertThrowsError(try NativeSearchIndex.identifier(taskID: id, selection: selection))
        }
        for invalid in [NativeLaunchSelection.standard(databaseURL: root, containerURL: root, namespace: "tech.dongdongbh.mindwtr"),
                        .rehearsal(containerURL: root, databaseURL: root, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"),
                        .isolated(databaseURL: root, containerURL: root, namespace: "tech.dongdongbh.mindwtr.native.dev", identifier: uuid)] {
            XCTAssertThrowsError(try NativeSearchIndex.identifier(taskID: "task", selection: invalid))
            XCTAssertThrowsError(try NativeSearchIndex(selection: invalid, port: port) { _, _ in XCTFail("Denied selection must not index") })
        }
        await waitForCalls(port, 1); port.finish()
        await fulfillment(of: [removed], timeout: 2)
        XCTAssertEqual(port.requests.count, 1); XCTAssertEqual(port.stored, ["foreign-item": "foreign.domain"])
    }

    func testOffDuringAdditionWithdrawsLatePublicationAndFailedRemovalNeedsRetry() async throws {
        let port = ControlledSearchIndex(), failure = expectation(description: "Failed withdrawal"), removed = expectation(description: "Retried withdrawal")
        var outcomes: [String] = []
        let index = try NativeSearchIndex(selection: selection, port: port) { outcome, _ in
            outcomes.append(outcome)
            if outcome == "failed" { failure.fulfill() }
            if outcome == "removalQueued" { removed.fulfill() }
        }
        await waitForCalls(port, 1)
        index.replace(try snapshot()); index.replace(try snapshot())
        port.finish(); await waitForCalls(port, 2); port.finish(); await waitForCalls(port, 3)
        XCTAssertNotNil(port.requests[2].items)
        index.withdraw(); index.withdraw(); port.finish(); await waitForCalls(port, 4)
        port.finish(Injected.failed); await fulfillment(of: [failure], timeout: 2)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(port.requests.count, 4); XCTAssertEqual(outcomes, ["failed"])
        index.retry(); await waitForCalls(port, 5); port.finish(); await fulfillment(of: [removed], timeout: 2)
        XCTAssertEqual(outcomes, ["failed", "removalQueued"])
        XCTAssertEqual(port.stored, ["foreign-item": "foreign.domain"])
        XCTAssertTrue(port.requests.allSatisfy { $0.domain == "tech.dongdongbh.mindwtr.native.search" })
        index.withdraw(); for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(port.requests.count, 5)
    }

    func testSameDesiredCoalescesAndOnlyAcknowledgedFingerprintSkipsWork() async throws {
        let port = ControlledSearchIndex(), first = expectation(description: "First publication"), latest = expectation(description: "Latest publication")
        var publications = 0
        let index = try NativeSearchIndex(selection: selection, port: port) { outcome, count in
            guard outcome == "publicationQueued" else { return }
            XCTAssertEqual(count, 1); publications += 1
            if publications == 1 { first.fulfill() } else { latest.fulfill() }
        }
        let initial = try snapshot("initial"), replacement = try snapshot("replacement"), newest = try snapshot("newest")
        await waitForCalls(port, 1); index.replace(initial); index.replace(initial)
        port.finish(); await waitForCalls(port, 2); port.finish(); await waitForCalls(port, 3); port.finish()
        await fulfillment(of: [first], timeout: 2)
        index.replace(initial); for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(port.requests.count, 3)
        index.replace(replacement); await waitForCalls(port, 4); index.replace(newest); index.replace(newest)
        port.finish(); await waitForCalls(port, 5); port.finish(); await waitForCalls(port, 6)
        let entry = try XCTUnwrap(port.requests[5].items?.first)
        XCTAssertEqual(index.taskID(for: entry.identifier), "newest"); XCTAssertEqual(entry.projectName, "Synthetic project")
        port.finish(); await fulfillment(of: [latest], timeout: 2)
        XCTAssertEqual(port.stored.count, 2); XCTAssertEqual(publications, 2)
    }

    func testFailedInitialCleanupRetriesOnFreshWithdrawAndDoesNotSpin() async throws {
        let port = ControlledSearchIndex(), failed = expectation(description: "Initial failure"), removed = expectation(description: "Fresh withdrawal")
        let index = try NativeSearchIndex(selection: selection, port: port) { outcome, _ in
            if outcome == "failed" { failed.fulfill() } else { removed.fulfill() }
        }
        await waitForCalls(port, 1); port.finish(Injected.failed); await fulfillment(of: [failed], timeout: 2)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(port.requests.count, 1)
        index.withdraw(); await waitForCalls(port, 2); port.finish(); await fulfillment(of: [removed], timeout: 2)
        XCTAssertEqual(port.requests.count, 2)
    }
}
