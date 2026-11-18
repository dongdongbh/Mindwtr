import XCTest
@testable import MindwtrNativeCore

final class NativeQuickActionsTests: XCTestCase {
    func testRNsThreeHomeScreenActionsOpenRNsDestinations() {
        XCTAssertEqual(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.add_task", scheme: "mindwtr")?.absoluteString,
                       "mindwtr:///capture-quick?mode=text")
        XCTAssertEqual(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.open_focus", scheme: "mindwtr")?.absoluteString, "mindwtr:///focus")
        XCTAssertEqual(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.open_calendar", scheme: "mindwtr")?.absoluteString, "mindwtr:///calendar")
    }

    func testDevelopmentBuildUsesItsOwnScheme() {
        XCTAssertEqual(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.open_focus", scheme: "mindwtr-native-dev")?.absoluteString,
                       "mindwtr-native-dev:///focus")
    }

    func testEachLaunchSelectionOpensTheLinkItsRouterAccepts() {
        let root = URL(fileURLWithPath: "/synthetic-container", isDirectory: true)
        let database = root.appendingPathComponent("mindwtr.sqlite")
        let focus = "tech.dongdongbh.mindwtr.open_focus"
        XCTAssertEqual(NativeQuickActions.url(type: focus, selection: .production(containerURL: root),
                                              bundleIdentifier: "tech.dongdongbh.mindwtr")?.absoluteString, "mindwtr:///focus")
        XCTAssertNil(NativeQuickActions.url(type: focus, selection: .production(containerURL: root),
                                            bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"))
        XCTAssertEqual(NativeQuickActions.url(type: focus, selection: .standard(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr"),
                                              bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev")?.absoluteString, "mindwtr-native-dev:///focus")
        XCTAssertEqual(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.add_task",
                                              selection: .isolated(databaseURL: database, containerURL: root, namespace: "tech.dongdongbh.mindwtr", identifier: UUID()),
                                              bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev")?.absoluteString, "mindwtr-native-dev:///capture-quick?mode=text")
        XCTAssertNil(NativeQuickActions.url(type: focus, selection: .rehearsal(containerURL: root, databaseURL: database, bundleIdentifier: "tech.dongdongbh.mindwtr"),
                                            bundleIdentifier: "tech.dongdongbh.mindwtr"))
    }

    func testUnknownActionOrMissingSchemeOpensNothing() {
        XCTAssertNil(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.open_inbox", scheme: "mindwtr"))
        XCTAssertNil(NativeQuickActions.url(type: "tech.dongdongbh.mindwtr.open_focus", scheme: nil))
    }
}
