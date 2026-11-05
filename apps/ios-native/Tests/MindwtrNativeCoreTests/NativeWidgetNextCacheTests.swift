import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
final class NativeWidgetNextCacheTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private var selection: NativeLaunchSelection {
        .standard(databaseURL: URL(fileURLWithPath: "/synthetic/mindwtr.sqlite"),
                  containerURL: URL(fileURLWithPath: "/synthetic"), namespace: NativeWidgetNextCache.namespace)
    }
    private func snapshot(_ id: String = "synthetic-é😀") throws -> NativeWidgetNextSnapshot {
        try NativeWidgetNextSnapshot(json: json(["version": 1, "title": "Next Actions", "emptyMessage": "No tasks found", "totalCount": 1,
            "items": [["id": id, "title": "Synthetic title", "contextLabel": NSNull(), "dueLabel": "Today", "dueTone": "today"]]]))
    }
    private func cache() throws -> (NativeWidgetNextCache, URL) {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("NativeWidgetNextCacheTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return (NativeWidgetNextCache(groupURL: root), root.appendingPathComponent("NativeWidgets/next.json"))
    }

    func testAtomicRoundtripExpirationAndInvalidationTouchOnlyDerivedFile() throws {
        let (cache, file) = try cache(), snapshot = try snapshot()
        XCTAssertNil(try cache.read(nowMs: 100))
        let identifier = try NativeSearchIndex.identifier(taskID: snapshot.items[0].id, selection: selection)
        try cache.publish(snapshot, identifiers: [identifier], publishedAtMs: 100, expiresAtMs: 200)
        let record = try XCTUnwrap(cache.read(nowMs: 100))
        XCTAssertEqual(record.snapshot.json, snapshot.json); XCTAssertEqual(record.identifiers, [identifier])
        XCTAssertEqual(record.snapshot.items[0].dueTone, .today)
        XCTAssertNil(record.actions)
        XCTAssertFalse(record.contains(identifier: identifier, token: "anything"))
        XCTAssertNotNil(try cache.read(nowMs: 199)); XCTAssertNil(try cache.read(nowMs: 200))
        XCTAssertNil(try cache.read(nowMs: 99)); XCTAssertNil(try cache.read(nowMs: .nan))
        let before = try Data(contentsOf: file)
        XCTAssertThrowsError(try cache.publish(snapshot, identifiers: [], publishedAtMs: 100, expiresAtMs: 200))
        XCTAssertEqual(try Data(contentsOf: file), before)
        try cache.invalidate(); XCTAssertNil(try cache.read(nowMs: 150)); try cache.invalidate()
    }

    func testClosedEnvelopeRejectsBoundsForeignScopeAndMismatchedRowIdentity() throws {
        let snapshot = try snapshot(), identifier = try NativeSearchIndex.identifier(taskID: snapshot.items[0].id, selection: selection)
        let valid: [String: Any] = ["version": 1, "namespace": NativeWidgetNextCache.namespace, "snapshot": snapshot.json,
            "identifiers": [identifier], "publishedAtMs": 100, "expiresAtMs": 200]
        XCTAssertEqual(try NativeWidgetNextCache.Record(json: json(valid)).snapshot.json, snapshot.json)
        for field in valid.keys {
            var bad = valid; bad.removeValue(forKey: field)
            XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: json(bad)))
        }
        for (field, value) in [("version", true), ("namespace", "group.tech.dongdongbh.mindwtr"),
                ("expiresAtMs", 100), ("expiresAtMs", 86_400_101), ("publishedAtMs", 1.5), ("expiresAtMs", true),
                ("identifiers", []), ("identifiers", [identifier + "="]), ("extra", 0)] as [(String, Any)] {
            var bad = valid; bad[field] = value
            XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: json(bad)))
        }
        let uuid = UUID(), name = uuid.uuidString.lowercased()
        let foreign = NativeLaunchSelection.isolated(databaseURL: URL(fileURLWithPath: "/synthetic/db"),
            containerURL: URL(fileURLWithPath: "/synthetic"), namespace: "tech.dongdongbh.mindwtr.native-ui." + name, identifier: uuid)
        for id in [try NativeSearchIndex.identifier(taskID: snapshot.items[0].id, selection: foreign),
                   try NativeSearchIndex.identifier(taskID: "different", selection: selection)] {
            var bad = valid; bad["identifiers"] = [id]
            XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: json(bad)))
        }
        let raw = try json(valid)
        XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: "{\"version\":1," + String(raw.dropFirst())))
        let padded = raw + String(repeating: " ", count: 2 * 1_024 * 1_024 - raw.utf8.count)
        XCTAssertEqual(try NativeWidgetNextCache.Record(json: padded).identifiers, [identifier])
        XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: padded + " "))
    }

    func testV2AtomicCapabilityBindingExpirationAndMalformedV2NeverDowngrades() throws {
        let (cache, file) = try cache(), snapshot = try snapshot("é")
        let identifier = try NativeSearchIndex.identifier(taskID: "é", selection: selection)
        let token = try json(["é", 2, "2026-10-30T00:00:00Z", "next"])
        let actions = try NativeWidgetNextActionSnapshot(json: json(["snapshot": snapshot.json,
            "tokens": [token], "completeLabel": "完成", "undoLabel": "撤销"]))
        try cache.publish(actions, identifiers: [identifier], publishedAtMs: 100, expiresAtMs: 200)
        let record = try XCTUnwrap(cache.read(nowMs: 150))
        XCTAssertEqual(record.actions?.completeLabel, "完成")
        XCTAssertTrue(record.contains(identifier: identifier, token: token))
        XCTAssertFalse(record.contains(identifier: identifier, token: " " + token))
        XCTAssertFalse(record.contains(identifier: try NativeSearchIndex.identifier(taskID: "e\u{0301}", selection: selection), token: token))
        XCTAssertNil(try cache.read(nowMs: 200))
        let saved = try Data(contentsOf: file)
        XCTAssertThrowsError(try cache.publish(actions,
            identifiers: [NativeSearchIndex.identifier(taskID: "e\u{0301}", selection: selection)], publishedAtMs: 100, expiresAtMs: 200))
        XCTAssertEqual(try Data(contentsOf: file), saved)
        let fields = try XCTUnwrap(NativeJSON.jsonObject(with: saved) as? [String: Any])
        for (field, value) in [("tokens", [try json(["other", 2, "stamp", "next"])]),
                ("tokens", []), ("extra", 1), ("completeLabel", ""), ("version", 3)] as [(String, Any)] {
            var bad = fields; bad[field] = value
            try Data(json(bad).utf8).write(to: file)
            XCTAssertThrowsError(try cache.read(nowMs: 150))
        }
        var absent = fields; absent.removeValue(forKey: "tokens")
        try Data(json(absent).utf8).write(to: file)
        XCTAssertThrowsError(try cache.read(nowMs: 150))
        let raw = try json(fields)
        XCTAssertThrowsError(try NativeWidgetNextCache.Record(json: "{\"version\":2," + String(raw.dropFirst())))
        let readOnly = try NativeWidgetNextActionSnapshot(json: json(["snapshot": snapshot.json,
            "tokens": [NSNull()], "completeLabel": "Complete", "undoLabel": "Undo"]))
        try cache.publish(readOnly, identifiers: [identifier], publishedAtMs: 100, expiresAtMs: 200)
        XCTAssertFalse(try XCTUnwrap(cache.read(nowMs: 150)).contains(identifier: identifier, token: token))
    }

    func testV2RetainsSeparateUnicodeAndBOMRowCapabilitiesInOrder() throws {
        let (cache, _) = try cache(), ids = ["é", "e\u{0301}", "\u{FEFF}first"]
        let snapshot = try NativeWidgetNextSnapshot(json: json(["version": 1, "title": "Next", "emptyMessage": "Empty", "totalCount": 3,
            "items": ids.map { ["id": $0, "title": "Synthetic", "contextLabel": NSNull(), "dueLabel": NSNull(), "dueTone": "normal"] as [String: Any] }]))
        let tokens = try ids.map { try json([$0, 1, "stamp", "next"]) }
        let identifiers = try ids.map { try NativeSearchIndex.identifier(taskID: $0, selection: selection) }
        let actions = try NativeWidgetNextActionSnapshot(json: json(["snapshot": snapshot.json,
            "tokens": tokens, "completeLabel": "Complete", "undoLabel": "Undo"]))
        try cache.publish(actions, identifiers: identifiers, publishedAtMs: 100, expiresAtMs: 200)
        let record = try XCTUnwrap(cache.read(nowMs: 150))
        for index in ids.indices {
            XCTAssertEqual(Data(record.snapshot.items[index].id.utf8), Data(ids[index].utf8))
            XCTAssertTrue(record.contains(identifier: identifiers[index], token: tokens[index]))
            XCTAssertFalse(record.contains(identifier: identifiers[index], token: tokens[(index + 1) % ids.count]))
        }
    }

    func testMalformedOrOversizedFileIsUnavailableInsteadOfEmpty() throws {
        let (cache, file) = try cache(), snapshot = try snapshot()
        try cache.publish(snapshot, identifiers: [NativeSearchIndex.identifier(taskID: snapshot.items[0].id, selection: selection)],
                          publishedAtMs: 100, expiresAtMs: 200)
        try Data("{}".utf8).write(to: file)
        XCTAssertThrowsError(try cache.read(nowMs: 150))
        try Data(repeating: 0x20, count: 2 * 1_024 * 1_024 + 1).write(to: file)
        XCTAssertThrowsError(try cache.read(nowMs: 150))
    }

    func testOrdinaryAndReservedURLsRetainScopeAndByteDistinctTaskIDs() throws {
        for id in ["é", "e\u{0301}", "Task", "task", "legacy/ID ?#😀", "\u{FEFF}first"] {
            let identifier = try NativeSearchIndex.identifier(taskID: id, selection: selection)
            let url = try XCTUnwrap(NativeWidgetTaskLink.url(identifier: identifier))
            XCTAssertTrue(NativeWidgetTaskLink.isCandidate(url))
            XCTAssertEqual(NativeWidgetTaskLink.identifier(in: url), identifier)
            XCTAssertEqual(NativeWidgetTaskLink.taskID(for: url, selection: selection).map { Data($0.utf8) }, Data(id.utf8))
            let retained = try NativePersonalIntakeEvent.url(url.absoluteString)
            XCTAssertEqual(retained.text, url.absoluteString)
            let coldURL = try XCTUnwrap(URL(string: XCTUnwrap(retained.text)))
            XCTAssertEqual(NativeWidgetTaskLink.taskID(for: coldURL, selection: selection).map { Data($0.utf8) }, Data(id.utf8))
            let uuid = UUID(), name = uuid.uuidString.lowercased()
            let foreign = NativeLaunchSelection.isolated(databaseURL: URL(fileURLWithPath: "/synthetic/db"),
                containerURL: URL(fileURLWithPath: "/synthetic"), namespace: "tech.dongdongbh.mindwtr.native-ui." + name, identifier: uuid)
            XCTAssertNil(NativeWidgetTaskLink.taskID(for: coldURL, selection: foreign))
        }
    }

    func testMalformedWidgetCandidatesNeverBecomeOrdinaryEntityURLs() throws {
        let identifier = try NativeSearchIndex.identifier(taskID: "one", selection: selection)
        let prefix = "mindwtr-native-dev://widget-task/"
        for raw in [prefix + identifier + "?task=one", prefix + identifier + "#one", prefix + identifier + "/extra",
                    "mindwtr://widget-task/" + identifier, "mindwtr-native-dev://name@widget-task/" + identifier,
                    "mindwtr-native-dev://widget-task:123/" + identifier, prefix + identifier + "=", prefix,
                    prefix + identifier.replacingOccurrences(of: ".", with: "%2E"), prefix + String(repeating: "x", count: 4_096)] {
            let url = try XCTUnwrap(URL(string: raw))
            XCTAssertTrue(NativeWidgetTaskLink.isCandidate(url))
            XCTAssertNil(NativeWidgetTaskLink.identifier(in: url))
            XCTAssertNil(NativeWidgetTaskLink.taskID(for: url, selection: selection))
        }
        XCTAssertFalse(NativeWidgetTaskLink.isCandidate(try XCTUnwrap(URL(string: "mindwtr-native-dev://open?task=one"))))
    }
}
