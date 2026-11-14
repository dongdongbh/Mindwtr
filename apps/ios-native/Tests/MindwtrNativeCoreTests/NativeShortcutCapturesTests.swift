import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeShortcutCapturesTests: XCTestCase {
    private var root: URL!
    private var queue: NativeShortcutCaptureQueue { NativeShortcutCaptureQueue(directory: root.appendingPathComponent("pending-captures")) }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("NativeShortcutCaptures-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let root { try? FileManager.default.removeItem(at: root) } }

    private func object(_ body: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
    }

    func testEnqueueWritesRNsPendingCapturePayload() throws {
        var components = DateComponents(); components.year = 2026; components.month = 11; components.day = 5; components.hour = 23
        let due = try XCTUnwrap(Calendar(identifier: .gregorian).date(from: components))
        let id = "ABCDEF00-0000-4000-8000-000000000001"
        XCTAssertTrue(queue.enqueue(task: "Buy milk", note: "  2% only ", tags: " home, ,errands ", project: " Garden ",
                                    dueDate: due, startDate: nil, id: id, now: Date(timeIntervalSince1970: 1_794_000_000)))
        let pending = try queue.pending()
        XCTAssertEqual(pending.map(\.name), [id + ".json"])
        let value = try object(pending[0].body)
        XCTAssertEqual(Set(value.keys), ["id", "title", "createdAt", "note", "tags", "project", "dueDate"])
        XCTAssertEqual(value["id"] as? String, id)
        XCTAssertEqual(value["title"] as? String, "Buy milk")
        XCTAssertEqual(value["note"] as? String, "2% only")
        XCTAssertEqual(value["tags"] as? String, "home,errands")
        XCTAssertEqual(value["project"] as? String, "Garden")
        XCTAssertEqual(value["dueDate"] as? String, "2026-11-05")
        XCTAssertNotNil(ISO8601DateFormatter().date(from: try XCTUnwrap(value["createdAt"] as? String)))
    }

    func testEnqueueOmitsBlankOptionalFields() throws {
        XCTAssertTrue(queue.enqueue(task: "Call", note: " ", tags: " , ", project: nil, dueDate: nil, startDate: nil,
                                    id: "ABCDEF00-0000-4000-8000-000000000002", now: Date()))
        XCTAssertEqual(Set(try object(queue.pending()[0].body).keys), ["id", "title", "createdAt"])
    }

    func testPendingSkipsForeignFilesAndRetireDeletesOnlyTheSameBytes() throws {
        XCTAssertTrue(queue.enqueue(task: "One", note: nil, tags: nil, project: nil, dueDate: nil, startDate: nil,
                                    id: "ABCDEF00-0000-4000-8000-000000000003", now: Date()))
        try Data("x".utf8).write(to: queue.directory.appendingPathComponent("notes.txt"))
        try FileManager.default.createDirectory(at: queue.directory.appendingPathComponent("folder.json"), withIntermediateDirectories: true)
        let pending = try queue.pending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertThrowsError(try queue.retire(name: pending[0].name, body: pending[0].body + " "))
        XCTAssertEqual(try queue.pending().count, 1)
        try queue.retire(name: pending[0].name, body: pending[0].body)
        XCTAssertEqual(try queue.pending().count, 0)
        XCTAssertThrowsError(try queue.retire(name: "../escape.json", body: ""))
    }

    func testMissingQueueDirectoryIsEmpty() throws {
        XCTAssertEqual(try queue.pending().count, 0)
    }

    func testBatchTakesSixteenOldestValidItemsAndLeavesInvalidOnes() throws {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var sources: [(name: String, body: String)] = []
        for n in 1...20 {
            let id = String(format: "ABCDEF00-0000-4000-8000-%012d", n)
            let created = fractional.string(from: Date(timeIntervalSince1970: 1_794_000_000 - Double(n)))
            let body = String(decoding: try JSONSerialization.data(withJSONObject: ["id": id, "title": "Item \(n)", "createdAt": created],
                                                                    options: [.sortedKeys]), as: UTF8.self)
            sources.append((id + ".json", body))
        }
        sources.append(("ABCDEF00-0000-4000-8000-000000000099.json", #"{"id":"ABCDEF00-0000-4000-8000-000000000099","title":"Watch","createdAt":"2026-11-01T00:00:00Z","source":"apple-watch"}"#))
        let batch = try XCTUnwrap(NativeShortcutCaptureBatch.next(sources))
        XCTAssertEqual(batch.entries.map(\.name), (5...20).reversed().map { String(format: "ABCDEF00-0000-4000-8000-%012d", $0) + ".json" })
        XCTAssertEqual(try NativeShortcutCaptureBatch(json: batch.json).entries.map(\.name), batch.entries.map(\.name))
        XCTAssertNil(try NativeShortcutCaptureBatch.next([sources.last!]))
        XCTAssertNil(try NativeShortcutCaptureBatch.next([]))
    }

    func testEntryValidationMatchesRNsQueueShape() {
        let id = "ABCDEF00-0000-4000-8000-000000000001", name = id + ".json"
        func valid(_ body: String, name: String = name) -> Bool { NativeShortcutCaptureBatch.isValid(name: name, body: body) }
        XCTAssertTrue(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z","note":"n","tags":"a,b","project":"P","dueDate":"2026-11-02","startDate":"2026-11-01"}"#))
        XCTAssertTrue(valid(#"{"id":"\#(id.lowercased())","title":"A","createdAt":"2026-11-01T00:00:00Z"}"#, name: id.lowercased() + ".json"))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z","kind":"text"}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z","source":"apple-watch"}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"  ","createdAt":"2026-11-01T00:00:00Z"}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z","dueDate":"2026-11-02T09:00:00Z"}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z","tags":["a"]}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z"}"#, name: "other.json"))
        XCTAssertFalse(valid(#"{"id":"not-a-uuid","title":"A","createdAt":"2026-11-01T00:00:00Z"}"#, name: "not-a-uuid.json"))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A","title":"B","createdAt":"2026-11-01T00:00:00Z"}"#))
        XCTAssertFalse(valid(#"{"id":"\#(id)","title":"A"}"#))
    }

    func testResultMustNameEveryEntryInOrder() throws {
        let id = "ABCDEF00-0000-4000-8000-000000000001"
        let batch = try XCTUnwrap(NativeShortcutCaptureBatch.next([(id + ".json", #"{"id":"\#(id)","title":"A","createdAt":"2026-11-01T00:00:00Z"}"#)]))
        XCTAssertEqual(try batch.result(#"{"version":1,"ingested":1,"completed":[{"name":"\#(id).json"}]}"#), [id + ".json"])
        XCTAssertThrowsError(try batch.result(#"{"version":1,"ingested":0,"completed":[]}"#))
        XCTAssertThrowsError(try batch.result(#"{"version":1,"ingested":1,"completed":[{"name":"other.json"}]}"#))
    }
}
