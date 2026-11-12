import XCTest
@testable import MindwtrNativeCore

final class NativeShortcutIntentLinksTests: XCTestCase {
    private func query(_ url: URL?) -> [String: String] {
        let items = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
    }

    func testCaptureLinkCarriesRNsFieldsTrimmedAndKeepsPlusSigns() throws {
        let url = try XCTUnwrap(NativeShortcutIntentLinks.capture(scheme: "mindwtr", task: "  Learn C++ ", note: " a+b ",
            tags: " home, ,work ,", project: " Garden ", requestId: "request-1"))
        XCTAssertTrue(url.absoluteString.hasPrefix("mindwtr:///capture?"))
        XCTAssertFalse(url.absoluteString.contains("+"))
        XCTAssertEqual(query(url), ["title": "Learn C++", "requestId": "request-1", "note": "a+b", "tags": "home,work", "project": "Garden"])
    }

    func testCaptureLinkOmitsBlankOptionalFieldsAndRefusesABlankTask() {
        XCTAssertEqual(query(NativeShortcutIntentLinks.capture(scheme: "mindwtr", task: "Call", note: " ", tags: " , ", project: nil,
            requestId: "r")), ["title": "Call", "requestId": "r"])
        XCTAssertNil(NativeShortcutIntentLinks.capture(scheme: "mindwtr", task: "  ", note: nil, tags: nil, project: nil))
    }

    func testFeatureLinksCoverRNsSevenListsOnly() {
        for feature in ["inbox", "focus", "waiting", "someday", "projects", "review", "calendar"] {
            XCTAssertEqual(NativeShortcutIntentLinks.feature(scheme: "mindwtr", feature: feature)?.absoluteString,
                           "mindwtr:///open-feature?feature=" + feature)
        }
        XCTAssertNil(NativeShortcutIntentLinks.feature(scheme: "mindwtr", feature: "capture"))
    }

    func testSavedListLinkMatchesRNsWidgetListDestination() {
        XCTAssertEqual(NativeShortcutIntentLinks.savedList(scheme: "mindwtr", id: "home office")?.absoluteString,
                       "mindwtr:///widget-list/filter%3Ahome%20office?source=shortcut")
        XCTAssertNil(NativeShortcutIntentLinks.savedList(scheme: "mindwtr", id: " "))
        XCTAssertNil(NativeShortcutIntentLinks.savedList(scheme: "mindwtr", id: "a\nb"))
        XCTAssertNil(NativeShortcutIntentLinks.savedList(scheme: "mindwtr", id: String(repeating: "x", count: 1018)))
    }

    func testShortcutLinksUseTheSchemeEachRouterAccepts() {
        let root = URL(fileURLWithPath: "/synthetic-container", isDirectory: true)
        let database = root.appendingPathComponent("mindwtr.sqlite")
        let production = NativeLaunchSelection.production(containerURL: root)
        XCTAssertEqual(NativeShortcutIntentLinks.scheme(selection: production, bundleIdentifier: "tech.dongdongbh.mindwtr"), "mindwtr")
        XCTAssertNil(NativeShortcutIntentLinks.scheme(selection: production, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"))
        let standard = NativeLaunchSelection.standard(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr")
        XCTAssertEqual(NativeShortcutIntentLinks.scheme(selection: standard, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"),
                       "mindwtr-native-dev")
        let rehearsal = NativeLaunchSelection.rehearsal(containerURL: root, databaseURL: database, bundleIdentifier: "tech.dongdongbh.mindwtr")
        XCTAssertNil(NativeShortcutIntentLinks.scheme(selection: rehearsal, bundleIdentifier: "tech.dongdongbh.mindwtr"))
    }

    func testSavedListsComeOnlyFromTheProductionAppGroup() {
        let root = URL(fileURLWithPath: "/synthetic-container", isDirectory: true)
        let standard = NativeLaunchSelection.standard(databaseURL: root.appendingPathComponent("mindwtr.sqlite"), containerURL: root,
                                                      namespace: "tech.dongdongbh.mindwtr")
        XCTAssertEqual(NativeSavedListCatalog.load(selection: standard, bundleIdentifier: "tech.dongdongbh.mindwtr"), [])
    }

    func testSavedListCatalogReadsTheWidgetPayloadLikeRN() {
        let json = #"{"headerTitle":"Focus","savedFilters":[{"id":"home","name":"Home"},{"id":"home","name":"Again"},{"id":"blank","name":"  "},{"id":" ","name":"No id"},{"id":"work","name":"Work","extra":1}]}"#
        XCTAssertEqual(NativeSavedListCatalog.decode(json).map(\.id), ["home", "work"])
        XCTAssertEqual(NativeSavedListCatalog.decode(#"{"headerTitle":"Focus"}"#), [])
        XCTAssertEqual(NativeSavedListCatalog.decode("not json"), [])
        XCTAssertEqual(NativeSavedListCatalog.decode(nil), [])
    }
}
