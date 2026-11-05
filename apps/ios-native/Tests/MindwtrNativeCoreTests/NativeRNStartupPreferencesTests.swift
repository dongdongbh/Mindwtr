import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeRNStartupPreferencesTests: XCTestCase {
    private var root: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private var manifest: URL { root.appendingPathComponent("Library/Application Support/tech.dongdongbh.mindwtr/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        let id = UUID().uuidString.lowercased()
        root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/rn-startup/" + id, isDirectory: true)
        suite = "mindwtr.rn-startup-tests." + id
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        try seed()
    }
    override func tearDownWithError() throws {
        if let suite { defaults?.removePersistentDomain(forName: suite) }
        if let root, FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }
    private func seed(_ changes: [String: String] = [:]) throws {
        var values = [
            "mindwtr-language": "de", "@mindwtr_theme": "dark", "mindwtr:view:taskOpenMode:v1": "view",
            "mindwtr:quickCapture:addAnother": "true", "mindwtr:view:project-detail:show-completed:v1": "true",
            "@mindwtr_pomodoro_collapsed": "true", "mindwtr:settings:manage:openSections": "[\"people\"]",
            "mindwtr:view:focus:v1": "{\"showDetails\":true,\"expandedSections\":{\"nextActions\":false,\"reviewDue\":true,\"focus\":1}}",
            "mindwtr:view:reference:groupBy:v1": "project",
            "mindwtr:view:group-collapse:reference:v1": "{\"project\":[\"legacy-project\"],\"area\":[]}",
            "mindwtr:view:group-collapse:inbox:v1": "{\"project\":[\"legacy-project\"]}",
            "mindwtr:view:done:v1": "{\"groupBy\":\"completedDate\",\"sortBy\":\"title\"}",
            "mindwtr:view:group-collapse:done:v1": "{\"completedDate\":[\"legacy-day\"]}",
            "mindwtr:view:archived:v1": "{\"groupBy\":\"project\",\"sortBy\":\"due\"}",
            "mindwtr:view:group-collapse:archived:v1": "{\"project\":[\"legacy-project\"]}",
            "unknown-rn-cell": "é e\u{0301} 🧭"
        ]
        for (key, value) in changes { values[key] = value }
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]).write(to: manifest)
    }
    private func load(_ selection: NativeLaunchSelection? = nil) throws -> NativeRNStartupPreferences {
        let source = try Data(contentsOf: manifest)
        let before = NSDictionary(dictionary: defaults.dictionaryRepresentation())
        let result = try NativeRNStartupPreferences(selection: selection ?? .production(containerURL: root), defaults: defaults)
        XCTAssertEqual(try Data(contentsOf: manifest), source)
        XCTAssertEqual(NSDictionary(dictionary: defaults.dictionaryRepresentation()), before)
        return result
    }

    func testProductionImportsStrictRNChoicesUsingRealNativeNamesWithoutWriting() throws {
        let result = try load()
        XCTAssertEqual(result.names.devicePrefix, "")
        XCTAssertEqual(result.names.addAnother, "nativeFoundation.capture.addAnother")
        XCTAssertEqual(result.names.manageOpenSections, "mindwtr:settings:manage:openSections")
        XCTAssertEqual(result.names.language, "mindwtr-language")
        XCTAssertEqual(result.language, "de"); XCTAssertEqual(result.theme, "dark")
        XCTAssertEqual(result.taskOpenMode, "view")
        XCTAssertTrue(result.addAnother); XCTAssertTrue(result.projectShowCompleted)
        XCTAssertTrue(result.pomodoroCollapsed); XCTAssertTrue(result.focusShowDetails)
        XCTAssertEqual(result.focusExpandedSections, ["next": false, "reviewDue": true])
        XCTAssertEqual(result.referenceGroupBy, "project")
        XCTAssertEqual(result.referenceCollapsedGroups, ["project": ["legacy-project"]])
        XCTAssertEqual(result.manageOpenSectionsFallback, "[\"people\"]")
        XCTAssertEqual(result.historyViews["done"]?["sortBy"] as? String, "title")
        XCTAssertEqual(result.historyViews["done"]?["collapsedGroups"] as? [String: [String]], ["completedDate": ["legacy-day"]])
    }

    func testRehearsalKeepsItsNamesAndNeverUsesProductionNativeOverrides() throws {
        defaults.set(false, forKey: "nativeFoundation.focus.showDetails")
        defaults.set("fr", forKey: "mindwtr-language")
        let selected = NativeLaunchSelection.rehearsal(containerURL: root,
            databaseURL: root.appendingPathComponent("Documents/SQLite/mindwtr.db"), bundleIdentifier: NativeLaunchSelection.productionNamespace)
        let result = try load(selected)
        XCTAssertEqual(result.names.devicePrefix, "nativeRNRehearsal.")
        XCTAssertEqual(result.names.focusShowDetails, "nativeRNRehearsal.focus.showDetails")
        XCTAssertEqual(result.names.historyViews["archive"], "nativeRNRehearsal.history.archived.view")
        XCTAssertEqual(result.names.manageOpenSections, "nativeRNRehearsal.manage.openSections")
        XCTAssertEqual(result.language, "de"); XCTAssertTrue(result.focusShowDetails)
        defaults.set(false, forKey: result.names.focusShowDetails)
        defaults.set("ar", forKey: result.names.language)
        let cold = try load(selected)
        XCTAssertFalse(cold.focusShowDetails); XCTAssertEqual(cold.language, "ar")
    }

    func testExplicitFalseAndEmptyNativePresenceSuppressesLegacyFallback() throws {
        let names = try load().names
        for name in [names.addAnother, names.projectShowCompleted, names.pomodoroCollapsed, names.focusShowDetails] {
            defaults.set(false, forKey: name)
        }
        for name in [names.language, names.theme, names.taskOpenMode, names.manageOpenSections] { defaults.set("", forKey: name) }
        defaults.set([String: Bool](), forKey: names.focusExpandedSections)
        defaults.set([String: String](), forKey: names.referenceView)
        defaults.set([String: String](), forKey: try XCTUnwrap(names.historyViews["done"]))
        defaults.set("{}", forKey: names.inboxFolds)
        let result = try load()
        XCTAssertFalse(result.addAnother); XCTAssertFalse(result.projectShowCompleted)
        XCTAssertFalse(result.pomodoroCollapsed); XCTAssertFalse(result.focusShowDetails)
        XCTAssertEqual(result.language, ""); XCTAssertEqual(result.theme, ""); XCTAssertEqual(result.taskOpenMode, "")
        XCTAssertEqual(result.focusExpandedSections, [:]); XCTAssertEqual(result.referenceCollapsedGroups, [:])
        XCTAssertNil(result.referenceGroupBy); XCTAssertNil(result.manageOpenSectionsFallback)
        XCTAssertTrue(try XCTUnwrap(result.historyViews["done"]).isEmpty)
        XCTAssertEqual(result.inboxCollapsedGroupsRaw, "{}")
    }

    func testMalformedNativePresenceSuppressesRNScalarsFoldsViewsAndSort() throws {
        let names = try load().names
        for name in [names.addAnother, names.projectShowCompleted, names.pomodoroCollapsed, names.focusShowDetails,
                     names.focusExpandedSections, names.referenceView] { defaults.set("malformed", forKey: name) }
        for name in [names.language, names.theme, names.taskOpenMode, names.inboxFolds, names.manageOpenSections] {
            defaults.set(7, forKey: name)
        }
        defaults.set("malformed", forKey: try XCTUnwrap(names.historyViews["archive"]))
        let result = try load()
        XCTAssertFalse(result.addAnother); XCTAssertFalse(result.projectShowCompleted)
        XCTAssertFalse(result.pomodoroCollapsed); XCTAssertFalse(result.focusShowDetails)
        XCTAssertEqual(result.language, ""); XCTAssertEqual(result.theme, "")
        XCTAssertNil(result.taskOpenMode); XCTAssertNil(result.inboxCollapsedGroupsRaw)
        XCTAssertNil(result.manageOpenSectionsFallback); XCTAssertNil(result.referenceGroupBy)
        XCTAssertEqual(result.focusExpandedSections, [:]); XCTAssertEqual(result.referenceCollapsedGroups, [:])
        XCTAssertTrue(try XCTUnwrap(result.historyViews["archive"]).isEmpty)
    }

    func testRNBooleanNumbersAreRejectedAndCanonicalFocusSectionWinsAlias() throws {
        try seed(["mindwtr:quickCapture:addAnother": "1",
            "mindwtr:view:focus:v1": "{\"showDetails\":1,\"expandedSections\":{\"next\":true,\"nextActions\":false,\"focus\":0,\"schedule\":\"false\"}}"])
        let result = try load()
        XCTAssertFalse(result.addAnother); XCTAssertFalse(result.focusShowDetails)
        XCTAssertEqual(result.focusExpandedSections, ["next": true])
        defaults.set(["next": 0, "reviewDue": true] as [String: Any], forKey: result.names.focusExpandedSections)
        XCTAssertEqual(try load().focusExpandedSections, ["reviewDue": true])
    }

    func testWrongSelectionAndRehearsalSourceNamespaceRefuseWithoutWriting() throws {
        let before = try Data(contentsOf: manifest)
        let native = NSDictionary(dictionary: defaults.dictionaryRepresentation())
        for selected in [NativeLaunchSelection.standard(databaseURL: root, containerURL: root, namespace: NativeLaunchSelection.productionNamespace),
                         .rehearsal(containerURL: root, databaseURL: root, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev")] {
            XCTAssertThrowsError(try NativeRNStartupPreferences(selection: selected, defaults: defaults))
        }
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        XCTAssertEqual(NSDictionary(dictionary: defaults.dictionaryRepresentation()), native)
    }
}
