import XCTest
@testable import MindwtrNativeCore

final class NativeCloudKitContainerTests: XCTestCase {
    func testEachBundleUsesOnlyItsOwnCloudKitContainer() {
        XCTAssertEqual(NativeCloudKitBridge.containersByBundle, [
            "tech.dongdongbh.mindwtr": "iCloud.tech.dongdongbh.mindwtr",
            "tech.dongdongbh.mindwtr.native.dev": "iCloud.tech.dongdongbh.mindwtr.native.dev",
        ])
        XCTAssertEqual(NativeCloudKitBridge.container(bundleIdentifier: "tech.dongdongbh.mindwtr",
                                                      declared: "iCloud.tech.dongdongbh.mindwtr"), "iCloud.tech.dongdongbh.mindwtr")
        XCTAssertEqual(NativeCloudKitBridge.container(bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev",
                                                      declared: "iCloud.tech.dongdongbh.mindwtr.native.dev"), "iCloud.tech.dongdongbh.mindwtr.native.dev")
    }

    func testACrossedMissingOrUnexpandedContainerTurnsCloudKitOff() {
        let refused: [(String?, Any?)] = [
            ("tech.dongdongbh.mindwtr", "iCloud.tech.dongdongbh.mindwtr.native.dev"),
            ("tech.dongdongbh.mindwtr.native.dev", "iCloud.tech.dongdongbh.mindwtr"),
            ("tech.dongdongbh.mindwtr", ""),
            ("tech.dongdongbh.mindwtr", "$(MINDWTR_CLOUDKIT_CONTAINER)"),
            ("tech.dongdongbh.mindwtr", nil),
            ("tech.dongdongbh.mindwtr", ["iCloud.tech.dongdongbh.mindwtr"]),
            ("tech.dongdongbh.mindwtr.uitests", "iCloud.tech.dongdongbh.mindwtr"),
            (nil, "iCloud.tech.dongdongbh.mindwtr"),
        ]
        for (bundle, declared) in refused {
            XCTAssertNil(NativeCloudKitBridge.container(bundleIdentifier: bundle, declared: declared), "\(String(describing: bundle)) \(String(describing: declared))")
        }
    }
}
