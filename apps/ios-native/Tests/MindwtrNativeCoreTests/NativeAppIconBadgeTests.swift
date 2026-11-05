import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
final class NativeAppIconBadgeTests: XCTestCase {
    private final class FakeSystem: @unchecked Sendable {
        private let lock = NSLock()
        private var _authorized: Bool
        private var _grant: Bool
        private var _fail = false
        private var _writes: [Int] = []
        private var _requests = 0
        init(authorized: Bool = false, grant: Bool = true) { _authorized = authorized; _grant = grant }
        func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
        var authorized: Bool { get { locked { _authorized } } set { locked { _authorized = newValue } } }
        var fail: Bool { get { locked { _fail } } set { locked { _fail = newValue } } }
        var writes: [Int] { locked { _writes } }
        var requests: Int { locked { _requests } }
        var system: NativeAppIconBadgeSystem {
            NativeAppIconBadgeSystem(authorized: { self.authorized }, requestAuthorization: {
                self.locked { self._requests += 1; if self._grant { self._authorized = true } }
                return self.authorized
            }, setCount: { count in
                if self.fail { throw CocoaError(.featureUnsupported) }
                self.locked { self._writes.append(count) }
            })
        }
    }

    private var root: URL!
    private var suite: String!
    private var defaults: UserDefaults!
    private var manifest: URL { root.appendingPathComponent("Library/Application Support/tech.dongdongbh.mindwtr/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        let id = UUID().uuidString.lowercased()
        root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/app-icon-badge/" + id, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        suite = "mindwtr.app-icon-badge-tests." + id
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDownWithError() throws {
        if let suite { defaults?.removePersistentDomain(forName: suite) }
        if let root, FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    private func seedLegacy(_ value: String) throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [NativeAppIconBadge.legacyKey: value], options: [.sortedKeys]).write(to: manifest)
    }

    private func badge(_ fake: FakeSystem, selection: NativeLaunchSelection? = nil) -> (NativeAppIconBadge, () -> [NativeAppIconBadge.Publication]) {
        let badge = NativeAppIconBadge(selection: selection ?? .production(containerURL: root), defaults: defaults, system: fake.system)
        var reports: [NativeAppIconBadge.Publication] = []
        badge.report = { reports.append($0) }
        return (badge, { reports })
    }

    func testDefaultsOffAndReadsTheLegacyRNPreferenceUntilNativeStoresOne() throws {
        XCTAssertFalse(badge(FakeSystem()).0.enabled)
        try seedLegacy("true")
        XCTAssertTrue(badge(FakeSystem()).0.enabled)
        defaults.set(false, forKey: "nativeFoundation.notifications.appIconBadge")
        XCTAssertFalse(badge(FakeSystem()).0.enabled)
        try seedLegacy("false")
        defaults.removeObject(forKey: "nativeFoundation.notifications.appIconBadge")
        XCTAssertFalse(badge(FakeSystem()).0.enabled)
    }

    func testIsolatedSelectionsUseTheirOwnKeyAndNeverReadLegacyStorage() throws {
        try seedLegacy("true")
        let isolated = NativeLaunchSelection.isolated(databaseURL: root.appendingPathComponent("db"), containerURL: root,
            namespace: "tech.dongdongbh.mindwtr.native-ui.case", identifier: UUID())
        let (subject, _) = badge(FakeSystem(), selection: isolated)
        XCTAssertFalse(subject.enabled)
        XCTAssertEqual(subject.key, "tech.dongdongbh.mindwtr.native-ui.case.notifications.appIconBadge")
    }

    func testPublicationNeverRequestsPermissionAndSkipsUnauthorizedClears() async {
        let fake = FakeSystem(authorized: false)
        let (subject, reports) = badge(fake)
        await subject.publish { XCTFail("Disabled badge must not count"); return 9 }
        XCTAssertEqual(fake.requests, 0)
        XCTAssertEqual(fake.writes, [])
        XCTAssertEqual(reports(), [])
    }

    func testDisabledAuthorizedBadgeIsClearedOnce() async {
        let fake = FakeSystem(authorized: true)
        let (subject, reports) = badge(fake)
        await subject.publish { 9 }
        await subject.publish { 9 }
        XCTAssertEqual(fake.writes, [0])
        XCTAssertEqual(reports(), [.init(count: 0, enabled: false, result: .applied)])
        XCTAssertEqual(fake.requests, 0)
    }

    func testEnablingRequestsOnceThenPublishesChangedCountsOnly() async throws {
        let fake = FakeSystem(authorized: false, grant: true)
        let (subject, reports) = badge(fake)
        let change = try await subject.setEnabled(true)
        XCTAssertEqual(change, .enabled)
        XCTAssertEqual(fake.requests, 1)
        XCTAssertEqual(defaults.object(forKey: subject.key) as? Bool, true)
        await subject.publish { 3 }
        await subject.publish { 3 }
        await subject.publish { 4 }
        XCTAssertEqual(fake.writes, [3, 4])
        XCTAssertEqual(reports().map(\.count), [3, 4])
        XCTAssertEqual(fake.requests, 1)
    }

    func testDeniedEnableStoresOffClearsAndReportsDenied() async throws {
        let fake = FakeSystem(authorized: false, grant: false)
        let (subject, reports) = badge(fake)
        let change = try await subject.setEnabled(true)
        XCTAssertEqual(change, .denied)
        XCTAssertFalse(subject.enabled)
        XCTAssertEqual(defaults.object(forKey: subject.key) as? Bool, false)
        XCTAssertEqual(fake.writes, [0])
        XCTAssertEqual(reports(), [.init(count: 0, enabled: false, result: .denied)])
    }

    func testRevokedPermissionClearsAndRegrantRepublishes() async throws {
        let fake = FakeSystem(authorized: true)
        let (subject, reports) = badge(fake)
        _ = try await subject.setEnabled(true)
        await subject.publish { 2 }
        fake.authorized = false
        await subject.publish { 2 }
        fake.authorized = true
        await subject.publish { 2 }
        XCTAssertEqual(fake.writes, [2, 0, 2])
        XCTAssertEqual(reports().map(\.result), [.applied, .denied, .applied])
    }

    func testDisablingStoresOffAndAppliesZero() async throws {
        let fake = FakeSystem(authorized: true)
        let (subject, _) = badge(fake)
        _ = try await subject.setEnabled(true)
        await subject.publish { 5 }
        let change = try await subject.setEnabled(false)
        XCTAssertEqual(change, .disabled)
        XCTAssertEqual(defaults.object(forKey: subject.key) as? Bool, false)
        XCTAssertEqual(fake.writes, [5, 0])
        await subject.publish { 5 }
        XCTAssertEqual(fake.writes, [5, 0])
    }

    func testToggleDuringCountDropsTheStalePublication() async throws {
        let fake = FakeSystem(authorized: true)
        let (subject, _) = badge(fake)
        _ = try await subject.setEnabled(true)
        await subject.publish {
            _ = try await subject.setEnabled(false)
            return 7
        }
        XCTAssertEqual(fake.writes, [0])
    }

    func testFailedCountOrWriteLeavesTheBadgeAndReportsFailureOnce() async throws {
        let fake = FakeSystem(authorized: true)
        let (subject, reports) = badge(fake)
        _ = try await subject.setEnabled(true)
        await subject.publish { throw CocoaError(.fileReadUnknown) }
        XCTAssertEqual(fake.writes, [])
        fake.fail = true
        await subject.publish { 1 }
        await subject.publish { 1 }
        XCTAssertEqual(reports(), [.init(count: 1, enabled: true, result: .failed)])
        fake.fail = false
        await subject.publish { 2 }
        XCTAssertEqual(fake.writes, [2])
    }

    func testClearWritesZeroAndTheNextPublicationRestoresTheCount() async throws {
        let fake = FakeSystem(authorized: true)
        let (subject, _) = badge(fake)
        _ = try await subject.setEnabled(true)
        await subject.publish { 6 }
        await subject.clear()
        await subject.publish { 6 }
        XCTAssertEqual(fake.writes, [6, 0, 6])
        XCTAssertTrue(subject.enabled)
    }
}
