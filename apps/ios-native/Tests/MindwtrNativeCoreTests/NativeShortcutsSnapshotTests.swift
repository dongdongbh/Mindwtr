import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeShortcutsSnapshotTests: XCTestCase {
    private var root: URL!
    private var file: NativeShortcutsSnapshotFile { NativeShortcutsSnapshotFile(url: root.appendingPathComponent("Shortcuts/snapshot.json")) }
    private let generatedAt = "2026-11-14T12:00:00.000Z"
    private var generated: Date { ISO8601DateFormatter().date(from: "2026-11-14T12:00:00Z")! }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("NativeShortcutsSnapshot-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let root { try? FileManager.default.removeItem(at: root) } }

    private func item(_ id: String, _ list: String, _ extra: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["id": id, "title": "Task " + id, "list": list, "deepLink": "mindwtr://open?task=" + id]
        value.merge(extra) { _, new in new }
        return value
    }

    private func snapshotJSON(omittedNext: Int? = 0) throws -> String {
        var nextCoverage: [String: Any] = ["eligible": 2, "published": 2]
        if let omittedNext { nextCoverage["omitted"] = omittedNext }
        let value: [String: Any] = [
            "version": 1, "generatedAt": generatedAt,
            "lists": ["inbox": [item("a", "inbox")], "focus": [], "next": [item("b", "next", ["dueDate": "2026-11-20"]), item("c", "next")],
                      "waiting": [], "someday": []],
            "projects": [["id": "p1", "name": "Garden", "items": [item("c", "next", ["projectId": "p1", "projectName": "Garden"])],
                          "coverage": ["eligible": 3, "published": 1, "omitted": 2]],
                         ["id": "p2", "name": "Twin", "items": [], "coverage": ["eligible": 0, "published": 0, "omitted": 0]],
                         ["id": "p3", "name": " twin ", "items": [], "coverage": ["eligible": 0, "published": 0, "omitted": 0]]],
            "coverage": ["lists": ["next": nextCoverage], "projects": ["eligible": 3, "published": 3, "omitted": 0],
                         "tasks": ["eligible": 3, "published": 3, "omitted": 0]],
        ]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    func testPublishReadAndWithdraw() throws {
        XCTAssertNil(file.read())
        try file.publish(snapshotJSON())
        let snapshot = try XCTUnwrap(file.read())
        XCTAssertEqual(snapshot.items(forList: "next").map(\.id), ["b", "c"])
        XCTAssertEqual(snapshot.items(forList: "next").first?.dueDate, "2026-11-20")
        XCTAssertFalse(file.withdrawnForAppLock)
        try file.withdrawForAppLock()
        XCTAssertNil(file.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
        XCTAssertTrue(file.withdrawnForAppLock)
        try file.withdrawForAppLock()
        XCTAssertTrue(file.withdrawnForAppLock)
        try file.clearAppLock()
        XCTAssertFalse(file.withdrawnForAppLock)
        try file.clearAppLock()
    }

    func testPublishAfterAppLockClearsTheLockMarker() throws {
        try file.withdrawForAppLock()
        XCTAssertTrue(file.withdrawnForAppLock)
        try file.publish(snapshotJSON())
        XCTAssertFalse(file.withdrawnForAppLock)
        XCTAssertNotNil(file.read())
    }

    func testPublishRefusesSomethingThatIsNotASnapshot() throws {
        for bad in ["[]", "not json", #"{"version":1}"#, #"{"version":1,"generatedAt":"x","lists":[]}"#] {
            XCTAssertThrowsError(try file.publish(bad))
        }
        XCTAssertNil(file.read())
    }

    func testFreshnessMatchesRNsDayWindow() throws {
        let snapshot = try XCTUnwrap(NativeShortcutsSnapshot(json: snapshotJSON()))
        XCTAssertEqual(snapshot.freshness(now: generated.addingTimeInterval(60)), .current)
        XCTAssertEqual(snapshot.freshness(now: generated.addingTimeInterval(24 * 60 * 60 + 1)), .stale)
        XCTAssertEqual(snapshot.freshness(now: generated.addingTimeInterval(-60)), .stale)
        let bad = try XCTUnwrap(NativeShortcutsSnapshot(json: snapshotJSON().replacingOccurrences(of: generatedAt, with: "yesterday")))
        XCTAssertEqual(bad.freshness(now: generated), .invalidTimestamp)
    }

    func testOmittedCountsAndProjectResolutionMatchRN() throws {
        let snapshot = try XCTUnwrap(NativeShortcutsSnapshot(json: snapshotJSON()))
        XCTAssertEqual(snapshot.knownOmittedTaskCount(forList: "next"), 0)
        XCTAssertNil(snapshot.knownOmittedTaskCount(forList: "inbox"))
        XCTAssertNil(try XCTUnwrap(NativeShortcutsSnapshot(json: snapshotJSON(omittedNext: nil))).knownOmittedTaskCount(forList: "next"))
        guard case let .matched(items, omitted) = snapshot.items(forProjectNamed: "  garden ") else { return XCTFail("Garden not matched") }
        XCTAssertEqual(items.map(\.id), ["c"]); XCTAssertEqual(omitted, 2)
        XCTAssertEqual(items.first?.projectName, "Garden")
        guard case .ambiguous = snapshot.items(forProjectNamed: "Twin") else { return XCTFail("Twin projects must be ambiguous") }
        guard case .missing = snapshot.items(forProjectNamed: "Nope") else { return XCTFail("Unknown project must be missing") }
        guard case .missing = snapshot.items(forProjectNamed: "  ") else { return XCTFail("Blank project must be missing") }
    }

    func testAllItemsAreUniqueAcrossListsAndProjects() throws {
        let snapshot = try XCTUnwrap(NativeShortcutsSnapshot(json: snapshotJSON()))
        XCTAssertEqual(snapshot.allItems().map(\.id), ["a", "b", "c"])
        XCTAssertEqual(snapshot.items(forList: "unknown").count, 0)
    }

    func testItemsWithoutIdOrTitleAreSkipped() throws {
        let json = #"{"version":1,"generatedAt":"2026-11-14T12:00:00.000Z","lists":{"inbox":[{"id":"","title":"x"},{"id":"y","title":""},{"id":"z","title":"Z","list":"inbox"}]},"projects":[]}"#
        XCTAssertEqual(try XCTUnwrap(NativeShortcutsSnapshot(json: json)).items(forList: "inbox").map(\.id), ["z"])
    }

    func testLiveFileOnlyForTheMainLibraries() {
        let home = URL(fileURLWithPath: "/synthetic-home", isDirectory: true)
        let production = NativeLaunchSelection.production(containerURL: home)
        XCTAssertEqual(NativeShortcutsSnapshotFile.live(selection: production)?.url.path,
                       "/synthetic-home/Library/Application Support/MindwtrShortcuts/snapshot.json")
        let standard = NativeLaunchSelection.standard(databaseURL: home.appendingPathComponent("m.sqlite"), containerURL: home, namespace: "x")
        XCTAssertNotNil(NativeShortcutsSnapshotFile.live(selection: standard))
        let isolated = NativeLaunchSelection.isolated(databaseURL: home.appendingPathComponent("m.sqlite"), containerURL: home,
                                                      namespace: "x", identifier: UUID())
        XCTAssertNil(NativeShortcutsSnapshotFile.live(selection: isolated))
        XCTAssertNil(NativeShortcutsSnapshotFile.live(selection: .rehearsal(containerURL: home, databaseURL: home, bundleIdentifier: "x")))
    }

    func testLegacyRNSnapshotIsRetiredOnceAndOtherKeysStay() throws {
        let domain = "mindwtr.legacy-shortcuts.fixture." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        addTeardownBlock { defaults.removePersistentDomain(forName: domain) }
        defaults.setPersistentDomain([NativeLegacyShortcutsSnapshot.key: "PRIVATE RN titles", "mindwtr-ios-widget-payload": "kept"], forName: domain)
        XCTAssertTrue(NativeLegacyShortcutsSnapshot.retire(from: defaults))
        XCTAssertNil(defaults.object(forKey: NativeLegacyShortcutsSnapshot.key))
        XCTAssertEqual(defaults.string(forKey: "mindwtr-ios-widget-payload"), "kept")
        XCTAssertFalse(NativeLegacyShortcutsSnapshot.retire(from: defaults))
    }

    func testLegacyRNSnapshotIsOnlyReachedFromTheProductionApp() {
        let home = URL(fileURLWithPath: "/synthetic-home", isDirectory: true)
        let standard = NativeLaunchSelection.standard(databaseURL: home.appendingPathComponent("m.sqlite"), containerURL: home,
                                                      namespace: "tech.dongdongbh.mindwtr")
        XCTAssertNil(NativeLegacyShortcutsSnapshot.defaults(selection: standard, bundleIdentifier: "tech.dongdongbh.mindwtr"))
        XCTAssertNil(NativeLegacyShortcutsSnapshot.defaults(selection: .production(containerURL: home),
                                                            bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"))
    }
}
