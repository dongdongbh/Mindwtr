import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class RefusingWidgetDefaults: UserDefaults, @unchecked Sendable {
    override func set(_ value: Any?, forKey defaultName: String) {
        if defaultName == "mindwtr-ios-widget-payload-extra-large" { return }
        super.set(value, forKey: defaultName)
    }
}

@MainActor
final class NativeWidgetFamilyPublisherTests: XCTestCase {
    private let names = ["mindwtr-ios-widget-payload", "mindwtr-ios-widget-payload-small",
        "mindwtr-ios-widget-payload-medium", "mindwtr-ios-widget-payload-large", "mindwtr-ios-widget-payload-extra-large"]
    private let kinds = ["MindwtrTasksWidget", "MindwtrCompactWidget", "MindwtrFocusLockWidget", "MindwtrCaptureLockWidget"]
    private let untouched: [String: Any] = ["mindwtr-ios-shortcuts-snapshot": "legacy shortcut bytes",
        "mindwtr-widget-actions-v1": Data([0, 255, 13]), "external-preference": false]

    private func fixture(refusingWrites: Bool = false) throws -> (UserDefaults, NativeWidgetFamilyPublisher) {
        let domain = "mindwtr.widget.publisher.fixture." + UUID().uuidString
        let defaults = try XCTUnwrap(refusingWrites ? RefusingWidgetDefaults(suiteName: domain) : UserDefaults(suiteName: domain))
        addTeardownBlock { defaults.removePersistentDomain(forName: domain) }
        var initial = untouched
        for name in names { initial[name] = "legacy RN cache" }
        defaults.setPersistentDomain(initial, forName: domain)
        return (defaults, try XCTUnwrap(NativeWidgetFamilyPublisher(defaults: defaults)))
    }

    private func snapshot(_ suffix: String = "first") throws -> NativeWidgetFamilySnapshot {
        let payloads = try Dictionary(uniqueKeysWithValues: zip(["default", "small", "medium", "large", "extraLarge"], 0..<5).map { family, index in
            let bytes = try JSONSerialization.data(withJSONObject: ["headerTitle": "\u{FEFF}e\u{301} é 🧠 \(suffix) \(index)"], options: [.sortedKeys, .withoutEscapingSlashes])
            return (family, String(decoding: bytes, as: UTF8.self))
        })
        return try NativeWidgetFamilySnapshot(json: String(decoding: JSONSerialization.data(withJSONObject: ["version": 1, "payloads": payloads]), as: UTF8.self))
    }

    private func values(_ value: NativeWidgetFamilySnapshot) -> [String] {
        [value.payloads.defaultPayload, value.payloads.small, value.payloads.medium, value.payloads.large, value.payloads.extraLarge]
    }

    private func assertPayloads(_ defaults: UserDefaults, _ snapshot: NativeWidgetFamilySnapshot, file: StaticString = #filePath, line: UInt = #line) throws {
        for (name, expected) in zip(names, values(snapshot)) {
            XCTAssertEqual(Data(try XCTUnwrap(defaults.object(forKey: name) as? String, file: file, line: line).utf8), Data(expected.utf8), file: file, line: line)
        }
    }

    private func assertUntouched(_ defaults: UserDefaults, file: StaticString = #filePath, line: UInt = #line) {
        for (name, expected) in untouched {
            XCTAssertEqual(defaults.object(forKey: name) as? NSObject, expected as? NSObject, file: file, line: line)
        }
    }

    func testProductionRouteRefusesDevSandboxRehearsalAndForeignBundles() {
        let root = URL(fileURLWithPath: "/synthetic-container", isDirectory: true)
        let database = root.appendingPathComponent("mindwtr.sqlite")
        let production = NativeLaunchSelection.production(containerURL: root)
        XCTAssertEqual(NativeWidgetFamilyPublisher.group(selection: production, bundleIdentifier: "tech.dongdongbh.mindwtr"), "group.tech.dongdongbh.mindwtr")
        let denied: [NativeLaunchSelection] = [
            .standard(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr"),
            .standard(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr.native.dev"),
            .isolated(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr.native-ui.synthetic", identifier: UUID()),
            .rehearsal(containerURL: root, databaseURL: database, bundleIdentifier: "tech.dongdongbh.mindwtr")]
        for selection in denied {
            XCTAssertNil(NativeWidgetFamilyPublisher.group(selection: selection, bundleIdentifier: "tech.dongdongbh.mindwtr"))
        }
        let bundles: [String?] = [nil, "", "tech.dongdongbh.mindwtr.native.dev", "tech.dongdongbh.mindwtr.MindwtrWidgets", "foreign.app"]
        for bundle in bundles {
            XCTAssertNil(NativeWidgetFamilyPublisher.group(selection: production, bundleIdentifier: bundle))
        }
        XCTAssertNil(NativeWidgetFamilyPublisher.live(selection: production))
        XCTAssertNil(NativeWidgetFamilyPublisher(defaults: nil))
    }

    func testPublishReadbacksAllFiveExactStringsBeforeReloadAndPreservesOtherValues() throws {
        let (defaults, publisher) = try fixture()
        let first = try snapshot()
        for name in names { defaults.set("old RN cache", forKey: name) }
        var reloaded: [String] = []
        try publisher.publish(first) { kind in
            do { try assertPayloads(defaults, first) }
            catch { XCTFail("All five payloads must be visible before reload") }
            assertUntouched(defaults)
            reloaded.append(kind)
        }
        XCTAssertEqual(reloaded, kinds)
        try assertPayloads(defaults, first)
        assertUntouched(defaults)
        let next = try snapshot("second")
        try publisher.publish(next) { _ in
            do { try assertPayloads(defaults, next) }
            catch { XCTFail("All five replacement payloads must be visible before reload") }
        }
        try assertPayloads(defaults, next)
        assertUntouched(defaults)
    }

    func testFailedWriteCannotReloadOrOwnLegacyCache() throws {
        let (defaults, publisher) = try fixture(refusingWrites: true)
        var reloaded: [String] = []
        let expected = try snapshot()
        XCTAssertThrowsError(try publisher.publish(expected) { reloaded.append($0) })
        XCTAssertEqual(reloaded, [])
        for (index, name) in names.enumerated() {
            XCTAssertEqual(defaults.string(forKey: name), index == 4 ? "legacy RN cache" : values(expected)[index])
        }
        assertUntouched(defaults)
        XCTAssertThrowsError(try publisher.invalidate { reloaded.append($0) })
        XCTAssertEqual(reloaded, [])
        assertUntouched(defaults)
    }

    func testUnpublishedInstanceCannotClearExistingLegacyCache() throws {
        let (defaults, publisher) = try fixture()
        let legacy = try snapshot("legacy")
        for (name, value) in zip(names, values(legacy)) { defaults.set(value, forKey: name) }
        var reloaded: [String] = []
        XCTAssertThrowsError(try publisher.invalidate { reloaded.append($0) })
        XCTAssertEqual(reloaded, [])
        try assertPayloads(defaults, legacy)
        assertUntouched(defaults)
    }

    func testOwnedInvalidationClearsOnlyFiveValuesBeforeReloadAndCannotRepeat() throws {
        let (defaults, publisher) = try fixture()
        try publisher.publish(snapshot()) { _ in }
        var reloaded: [String] = []
        try publisher.invalidate { kind in
            for name in names { XCTAssertNil(defaults.object(forKey: name)) }
            assertUntouched(defaults)
            reloaded.append(kind)
        }
        XCTAssertEqual(reloaded, kinds)
        XCTAssertThrowsError(try publisher.invalidate { reloaded.append($0) })
        XCTAssertEqual(reloaded, kinds)
        assertUntouched(defaults)
    }

    func testByteDistinctEquivalentUnicodeReplacementCannotBeInvalidated() throws {
        let (defaults, publisher) = try fixture()
        let original = try snapshot()
        try publisher.publish(original) { _ in }
        let expected = values(original)[0]
        let replacement = expected.precomposedStringWithCanonicalMapping
        XCTAssertEqual(expected, replacement)
        XCTAssertNotEqual(Data(expected.utf8), Data(replacement.utf8))
        defaults.set(replacement, forKey: names[0])
        var reloaded: [String] = []
        XCTAssertThrowsError(try publisher.invalidate { reloaded.append($0) })
        XCTAssertEqual(reloaded, [])
        XCTAssertEqual(Data(try XCTUnwrap(defaults.string(forKey: names[0])).utf8), Data(replacement.utf8))
        assertUntouched(defaults)
    }

    func testExternalReplacementPreventsInvalidationWithoutChangingAnyCurrentValue() throws {
        let (defaults, publisher) = try fixture()
        let original = try snapshot()
        try publisher.publish(original) { _ in }
        let expected = values(original)
        defaults.set("external RN replacement", forKey: names[2])
        var reloaded: [String] = []
        XCTAssertThrowsError(try publisher.invalidate { reloaded.append($0) })
        XCTAssertEqual(reloaded, [])
        for (index, name) in names.enumerated() {
            XCTAssertEqual(defaults.string(forKey: name), index == 2 ? "external RN replacement" : expected[index])
        }
        assertUntouched(defaults)
    }
}
