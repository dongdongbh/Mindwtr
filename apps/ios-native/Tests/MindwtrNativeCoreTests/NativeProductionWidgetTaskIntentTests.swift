import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeProductionWidgetTaskIntentTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/synthetic/home", isDirectory: true)
    private let productionBundle = NativeLaunchSelection.productionNamespace

    private func url(_ taskId: String) -> URL? {
        NativeProductionWidgetTaskIntent.url(taskId: taskId, selection: .production(containerURL: home),
            bundleIdentifier: productionBundle)
    }

    func testProductionRouteKeepsOpaqueTaskIdentifiersAndEncodesQueryDelimiters() throws {
        for taskId in ["task", "opaque task/漢+😀", "a&task=other#?%=:/+", "  preserved  ", "e\u{301}", "é"] {
            let url = try XCTUnwrap(url(taskId))
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            XCTAssertEqual(components.scheme, "mindwtr")
            XCTAssertEqual(components.host, "open")
            XCTAssertEqual(components.path, "")
            XCTAssertNil(components.fragment)
            XCTAssertNil(components.user)
            XCTAssertNil(components.password)
            XCTAssertNil(components.port)
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "task", value: taskId)])
            let query = try XCTUnwrap(components.percentEncodedQuery)
            XCTAssertFalse(query.contains("+"))
            XCTAssertEqual(query.split(separator: "&").count, 1)
            let formValue = String(query.dropFirst("task=".count)).replacingOccurrences(of: "+", with: " ")
            XCTAssertEqual(formValue.removingPercentEncoding, taskId)
        }
    }

    func testRefusesBlankControlAndOversizedIdentifiers() {
        for taskId in ["", " ", "\t\r\n", "\u{00a0}", "\u{2003}", "task\0", "task\n", "task\r", "task\t",
                       "task\u{001f}", "task\u{007f}", "task\u{0085}",
                       String(repeating: "a", count: 501), String(repeating: "😀", count: 250) + "x"] {
            XCTAssertNil(url(taskId))
        }
    }

    func testAllowsExactly500UTF16Units() throws {
        for taskId in [String(repeating: "a", count: 500), String(repeating: "😀", count: 250)] {
            XCTAssertEqual(taskId.utf16.count, 500)
            let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(url(taskId)), resolvingAgainstBaseURL: false))
            XCTAssertEqual(components.queryItems?.first?.value, taskId)
        }
    }

    func testProductionSelectionRequiresExactProductionAppBundle() {
        for bundle in [nil, "", "tech.dongdongbh.mindwtr.native.dev", "tech.dongdongbh.mindwtr.dev",
                       "tech.dongdongbh.mindwtr.MindwtrWidgets", "tech.dongdongbh.mindwtr.share-extension",
                       "TECH.DONGDONGBH.MINDWTR", productionBundle + ".other", productionBundle + " "] {
            XCTAssertNil(NativeProductionWidgetTaskIntent.url(taskId: "task", selection: .production(containerURL: home),
                bundleIdentifier: bundle))
        }
        XCTAssertEqual(url("task")?.absoluteString, "mindwtr://open?task=task")
    }

    func testEveryNonproductionSelectionIsRefusedEvenWithProductionNamespace() {
        let database = home.appendingPathComponent("Documents/SQLite/mindwtr.db")
        let selections: [NativeLaunchSelection] = [
            .standard(databaseURL: database, containerURL: home, namespace: productionBundle),
            .standard(databaseURL: database, containerURL: home, namespace: "tech.dongdongbh.mindwtr.native.dev"),
            .isolated(databaseURL: database, containerURL: home, namespace: productionBundle, identifier: UUID()),
            .rehearsal(containerURL: home, databaseURL: database, bundleIdentifier: productionBundle)
        ]
        for selection in selections {
            for bundle in [productionBundle, "tech.dongdongbh.mindwtr.native.dev"] {
                XCTAssertNil(NativeProductionWidgetTaskIntent.url(taskId: "task", selection: selection,
                    bundleIdentifier: bundle))
            }
        }
    }
}
