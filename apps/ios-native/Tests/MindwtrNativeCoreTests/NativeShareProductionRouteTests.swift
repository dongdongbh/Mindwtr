import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
final class NativeShareProductionRouteTests: XCTestCase {
    private func shareRoot() throws -> URL {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/share/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return root
    }

    private func intakeRoute(production: Bool) throws -> NativePersonalIntakeRoute {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/personal-intake/" + UUID().uuidString.lowercased(), isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/Application Support", isDirectory: true), withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return try NativePersonalIntakeRoute.fixture(home: home,
            bundleIdentifier: production ? "tech.dongdongbh.mindwtr" : "tech.dongdongbh.mindwtr.native.dev",
            mode: production ? .production : .deviceTest)
    }

    func testClosedProductionAndDevelopmentMailboxTuplesNeverUseForeignBundles() throws {
        for route in [NativeShareMailbox.Route.development, .production] {
            XCTAssertEqual(NativeShareMailbox.Route.resolve(bundleIdentifier: route.appIdentifier), route)
            XCTAssertEqual(NativeShareMailbox.Route.resolve(bundleIdentifier: route.extensionIdentifier), route)
            XCTAssertEqual(try NativeShareMailbox.group(for: route.appIdentifier), route.groupIdentifier)
            XCTAssertEqual(try NativeShareMailbox.group(for: route.extensionIdentifier), route.groupIdentifier)
        }
        XCTAssertEqual(NativeShareMailbox.Route.production.appIdentifier, "tech.dongdongbh.mindwtr")
        XCTAssertEqual(NativeShareMailbox.Route.production.extensionIdentifier, "tech.dongdongbh.mindwtr.share-extension")
        XCTAssertEqual(NativeShareMailbox.Route.production.groupIdentifier, "group.tech.dongdongbh.mindwtr")
        for bundle in [nil, "", "tech.dongdongbh.mindwtr.dev", "tech.dongdongbh.mindwtr.share", "tech.dongdongbh.mindwtr.MindwtrWidgets", "tech.dongdongbh.mindwtr.native.dev.uitests.xctrunner"] {
            XCTAssertNil(NativeShareMailbox.Route.resolve(bundleIdentifier: bundle))
        }
    }

    func testProductionAppAdmissionRequiresProductionSelectionAndMatchesActualIntakeNamespace() throws {
        let production = try intakeRoute(production: true)
        let development = try intakeRoute(production: false)
        let admitted = try XCTUnwrap(NativeShareMailbox.Route.app(selection: production.selection, bundleIdentifier: "tech.dongdongbh.mindwtr"))
        XCTAssertEqual(admitted, .production)
        XCTAssertEqual(admitted.appIdentifier, production.namespace)
        XCTAssertEqual(NativeShareMailbox.Route.app(selection: development.selection, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"), .development)
        XCTAssertNil(NativeShareMailbox.Route.app(selection: production.selection, bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev"))
        XCTAssertNil(NativeShareMailbox.Route.app(selection: development.selection, bundleIdentifier: "tech.dongdongbh.mindwtr"))
        XCTAssertNil(NativeShareMailbox.Route.app(selection: production.selection, bundleIdentifier: "tech.dongdongbh.mindwtr.share-extension"))
        let home = URL(fileURLWithPath: "/synthetic/home")
        let database = home.appendingPathComponent("Library/Application Support/NativeFoundation/mindwtr.sqlite")
        let emptyNativeFallback = NativeLaunchSelection.standard(databaseURL: database, containerURL: home, namespace: "tech.dongdongbh.mindwtr")
        let isolated = NativeLaunchSelection.isolated(databaseURL: database, containerURL: home, namespace: "tech.dongdongbh.mindwtr.native.dev", identifier: UUID())
        let rehearsal = NativeLaunchSelection.rehearsal(containerURL: home, databaseURL: database, bundleIdentifier: "tech.dongdongbh.mindwtr")
        for selection in [emptyNativeFallback, isolated, rehearsal] {
            for bundle in ["tech.dongdongbh.mindwtr", "tech.dongdongbh.mindwtr.native.dev"] {
                XCTAssertNil(NativeShareMailbox.Route.app(selection: selection, bundleIdentifier: bundle))
            }
        }
    }

    func testProductionMailboxImportsIntoActualProductionPrivateIntakeAndColdRetainsEnvelope() async throws {
        let groupRoot = try shareRoot()
        let unknown = groupRoot.appendingPathComponent("old-rn-store.bin")
        let bytes = Data([0xef, 0xbb, 0xbf, 0, 42])
        try bytes.write(to: unknown)
        let mailbox = try NativeShareMailbox.fixture(root: groupRoot, route: .production)
        let envelope = try NativeShareEnvelope(subject: nil, text: "Synthetic production share", webUrl: nil)
        try await mailbox.publish(envelope)
        let page = try await mailbox.pendingPage()
        let item = try XCTUnwrap(page.items.first)
        let route = try intakeRoute(production: true)
        XCTAssertEqual(item.namespace, route.namespace)
        let intake = try NativePersonalIntake(route: route, diagnostic: { _ in })
        addTeardownBlock { await intake.close() }
        let imported = try await intake.importShare(item, from: mailbox)
        XCTAssertEqual(imported.event?.share, envelope)
        let remaining = try await mailbox.pendingPage()
        XCTAssertTrue(remaining.items.isEmpty)
        await intake.close()
        let cold = try NativePersonalIntake(route: route, diagnostic: { _ in })
        addTeardownBlock { await cold.close() }
        let retained = try await cold.pendingPage()
        XCTAssertEqual(retained.items.first?.event?.share, envelope)
        XCTAssertEqual(try Data(contentsOf: unknown), bytes)
        await cold.close()
    }

    func testProductionAndDevelopmentIntakesRefuseEachOthersMailboxWithoutAcknowledging() async throws {
        for producer in [NativeShareMailbox.Route.development, .production] {
            let mailbox = try NativeShareMailbox.fixture(root: shareRoot(), route: producer)
            let envelope = try NativeShareEnvelope(subject: nil, text: "Synthetic cross route share", webUrl: nil)
            try await mailbox.publish(envelope)
            let page = try await mailbox.pendingPage()
            let item = try XCTUnwrap(page.items.first)
            let route = try intakeRoute(production: producer == .development)
            let intake = try NativePersonalIntake(route: route, diagnostic: { _ in })
            addTeardownBlock { await intake.close() }
            do {
                _ = try await intake.importShare(item, from: mailbox)
                XCTFail("Foreign mailbox namespace was admitted")
            } catch NativePersonalIntakeError.unavailable {}
            let retained = try await mailbox.pendingPage()
            XCTAssertEqual(retained.items.map(\.envelope), [envelope])
            await intake.close()
        }
    }
}
