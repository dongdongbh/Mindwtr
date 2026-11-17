import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWatchSelectionTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/synthetic/watch", isDirectory: true)
    private let production = NativeLaunchSelection.productionNamespace
    private let dev = "tech.dongdongbh.mindwtr.native.dev"

    private var standardDev: NativeLaunchSelection {
        .standard(databaseURL: root.appendingPathComponent("mindwtr.sqlite"), containerURL: root, namespace: dev)
    }

    func testProductionAppWithItsOwnLibraryTalksToTheWatch() {
        XCTAssertTrue(NativeWatchSelection.admits(.production(containerURL: root), bundleIdentifier: production))
    }

    func testDevAppWithTheStandardDevLibraryTalksToTheWatch() {
        XCTAssertTrue(NativeWatchSelection.admits(standardDev, bundleIdentifier: dev))
    }

    func testIsolatedTestLibrariesRehearsalsAndForeignBundlesStayAwayFromTheWatch() {
        let id = UUID()
        let isolated = NativeLaunchSelection.isolated(databaseURL: root.appendingPathComponent("ui.sqlite"), containerURL: root,
            namespace: "tech.dongdongbh.mindwtr.native-ui." + id.uuidString.lowercased(), identifier: id)
        let rehearsal = NativeLaunchSelection.rehearsal(containerURL: root, databaseURL: root.appendingPathComponent("r.sqlite"),
            bundleIdentifier: production)
        for bundle in [production, dev] {
            XCTAssertFalse(NativeWatchSelection.admits(isolated, bundleIdentifier: bundle))
            XCTAssertFalse(NativeWatchSelection.admits(rehearsal, bundleIdentifier: bundle))
            XCTAssertFalse(NativeWatchSelection.admits(nil, bundleIdentifier: bundle))
        }
        XCTAssertFalse(NativeWatchSelection.admits(.production(containerURL: root), bundleIdentifier: dev))
        XCTAssertFalse(NativeWatchSelection.admits(standardDev, bundleIdentifier: production))
        XCTAssertFalse(NativeWatchSelection.admits(.standard(databaseURL: root, containerURL: root, namespace: "tech.dongdongbh.mindwtr.native-ui.other"),
            bundleIdentifier: dev))
        XCTAssertFalse(NativeWatchSelection.admits(.production(containerURL: root), bundleIdentifier: nil))
    }
}
