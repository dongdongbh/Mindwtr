import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativePersonalIntakeReminderReplayTests: XCTestCase {
    private enum Injected: Error { case failure }
    private actor Barrier {
        private var entered = false
        private var entrance: CheckedContinuation<Void, Never>?
        private var release: CheckedContinuation<Void, Never>?
        func hold() async {
            entered = true; entrance?.resume(); entrance = nil
            await withCheckedContinuation { release = $0 }
        }
        func wait() async { if !entered { await withCheckedContinuation { entrance = $0 } } }
        func open() { release?.resume(); release = nil }
    }
    private var home: URL!
    private var route: NativePersonalIntakeRoute!
    private var sources: [NativeReminderInbox] = []
    private var destinations: [NativePersonalIntake] = []
    private var root: URL { route.components.reduce(home!) { $0.appendingPathComponent($1, isDirectory: true) } }
    private var legacyFile: URL { home.appendingPathComponent("Library/Application Support/NativeFoundation/NotificationResponses/inbox.json") }
    private func record(_ id: String) -> URL { root.appendingPathComponent("records/\(id).json") }

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/personal-intake/\(UUID().uuidString.lowercased())/home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        home = home.resolvingSymlinksInPath(); route = try .fixture(home: home)
    }
    override func tearDown() async throws {
        for destination in destinations { await destination.close() }
        for source in sources { await source.close() }
        destinations.removeAll(); sources.removeAll()
        try FileManager.default.removeItem(at: home.deletingLastPathComponent())
    }
    private func response(id: String = UUID().uuidString.lowercased(), delivered: Double = 100,
                          clock: Int64 = 123, task: String = "\u{FEFF}e\u{301} 🧠") throws -> NativeReminderResponse {
        let json = try JSONSerialization.data(withJSONObject: ["requestId": id, "taskId": task], options: [.sortedKeys])
        return .init(requestID: id, notificationIdentifier: "mindwtr-native:\(route.namespace):1", action: .complete,
            deliveredAtBits: String(format: "%016llx", delivered.bitPattern), requestedAtMs: clock,
            payloadJSON: String(decoding: json, as: UTF8.self))
    }
    private func seed(_ entries: [(NativeReminderResponse, Int64, NativeReminderInbox.Stage)], floor: Double? = nil) throws {
        try FileManager.default.createDirectory(at: legacyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let active = try entries.map { entry -> [String: Any] in
            ["sequence": entry.1, "stage": entry.2.rawValue,
             "response": try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.0))]
        }
        var raw: [String: Any] = ["version": 1, "namespace": route.namespace,
            "nextSequence": (entries.map { $0.1 }.max() ?? 0) + 1, "active": active, "tombstones": []]
        if let floor { raw["retiredThrough"] = String(format: "%016llx", floor.bitPattern) }
        try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys]).write(to: legacyFile)
    }
    private func source(existing: Bool = false) throws -> NativeReminderInbox {
        let value: NativeReminderInbox
        if existing { value = try NativeReminderInbox.openExistingForHandover(selection: route.selection) }
        else { value = try NativeReminderInbox(selection: route.selection) }
        sources.append(value); return value
    }
    private func destination(existing: Bool = false) throws -> NativePersonalIntake {
        let value: NativePersonalIntake
        if existing { value = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })) }
        else { value = try NativePersonalIntake(route: route, diagnostic: { _ in }) }
        destinations.append(value); return value
    }
    private func refused(_ expected: NativePersonalIntakeError? = nil, _ operation: () async throws -> Void,
                         file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Held reminder must refuse", file: file, line: line) }
        catch { if let expected { XCTAssertEqual(error as? NativePersonalIntakeError, expected, file: file, line: line) } }
    }
    private func inode(_ url: URL) throws -> UInt64 {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw Injected.failure }; return UInt64(value.st_ino)
    }
    private func first(_ destination: NativePersonalIntake) async throws -> NativePersonalIntake.Item {
        let page = try await destination.pendingPage(); return try XCTUnwrap(page.items.first)
    }

    func testRequiresConfirmedOriginalDestinationAndKeepsGenericReminderMethodsClosed() async throws {
        let originalResponse = try response(); try seed([(originalResponse, 1, .captured)])
        let original = try source(), intake = try destination()
        let newlyCaptured = try await intake.capture(.reminder(response(delivered: 200)))
        await refused { _ = try await original.admitHeldReminder(newlyCaptured, in: intake, route: self.route) }
        try await original.handoverCaptures(into: intake, route: route)
        let wrongRoute = try NativePersonalIntakeRoute.fixture(home: home, arguments: ["--native-ui-test-library", UUID().uuidString.lowercased()])
        let other = try NativePersonalIntake(route: wrongRoute, diagnostic: { _ in }); destinations.append(other)
        await refused { _ = try await original.admitHeldReminder(newlyCaptured, in: other, route: self.route) }
        await refused { _ = try await original.admitHeldReminder(newlyCaptured, in: intake, route: wrongRoute) }
        await refused(.legacyHeld) { _ = try await intake.markAdmitting(newlyCaptured) }
        await refused(.staleItem) { _ = try await original.heldReminderDispatchItem(newlyCaptured, in: intake, route: self.route) }
        let admitted = try await original.admitHeldReminder(newlyCaptured, in: intake, route: route)
        XCTAssertEqual(admitted.stage, .admitting)
        await refused(.staleItem) { _ = try await original.admitHeldReminder(newlyCaptured, in: intake, route: self.route) }
        await refused(.legacyHeld) { try await intake.finish(admitted, outcome: .completed) }
        let dispatch = try await original.heldReminderDispatchItem(admitted, in: intake, route: route)
        XCTAssertEqual(dispatch.response, admitted.event?.response); XCTAssertEqual(dispatch.stage, .admitting)
        let navigation = try await intake.capture(.url("mindwtr://open/local"))
        await refused(.staleItem) { _ = try await original.admitHeldReminder(navigation, in: intake, route: self.route) }
    }

    func testCaptureAdmissionDomainReceiptAndFinishPreserveExactOriginalResponse() async throws {
        let captured = try response(delivered: 50), alreadyAdmitting = try response(delivered: 60, clock: 456)
        try seed([(captured, 2, .captured), (alreadyAdmitting, 9, .admitting)], floor: 100)
        let original = try source(), intake = try destination()
        let sourceBytes = try Data(contentsOf: legacyFile)
        try await original.handoverCaptures(into: intake, route: route)
        let callback = try response(delivered: 101, clock: 789)
        guard case .captured = try await intake.captureReminder(callback) else { return XCTFail("Above-floor callback must capture") }
        let page = try await intake.pendingPage()
        XCTAssertEqual(page.items.count, 3)
        var domainReceipts: [String: NativeReminderResponse] = [:]
        for item in page.items {
            let admitted = try await original.admitHeldReminder(item, in: intake, route: route)
            let dispatch = try await original.heldReminderDispatchItem(admitted, in: intake, route: route)
            // Model the existing CoreHost receipt boundary; no finish is attempted before this exact response is receipted.
            domainReceipts[dispatch.response.requestID] = dispatch.response
            XCTAssertEqual(domainReceipts[admitted.id], admitted.event?.response)
            let settled = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: route)
            XCTAssertEqual(settled.id, admitted.id); XCTAssertEqual(settled.sequence, admitted.sequence)
            XCTAssertEqual(settled.receivedAtMs, admitted.receivedAtMs); XCTAssertEqual(settled.kind, .reminder)
            XCTAssertEqual(settled.outcome, .completed)
            let bytes = try Data(contentsOf: record(admitted.id)), identity = try inode(record(admitted.id))
            _ = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: route)
            XCTAssertEqual(try Data(contentsOf: record(admitted.id)), bytes); XCTAssertEqual(try inode(record(admitted.id)), identity)
            guard case .knownTerminal = try await intake.captureReminder(dispatch.response) else { return XCTFail("Exact finished callback must stay terminal") }
            await refused { _ = try await intake.captureReminder(response(id: dispatch.response.requestID, delivered: Double(bitPattern: UInt64(dispatch.response.deliveredAtBits, radix: 16)!), clock: dispatch.response.requestedAtMs, task: "foreign payload")) }
        }
        let remaining = try await intake.pendingPage(); XCTAssertTrue(remaining.items.isEmpty)
        XCTAssertEqual(domainReceipts.count, 3); XCTAssertEqual(try Data(contentsOf: legacyFile), sourceBytes)
    }

    func testAmbiguousFloorAndIncompleteGenerationRemainHeld() async throws {
        let sourceResponse = try response(delivered: 50); try seed([(sourceResponse, 1, .captured)], floor: 100)
        let original = try source(), intake = try destination()
        await intake.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await refused { try await original.handoverCaptures(into: intake, route: self.route) }
        await intake.setIOFaults()
        try await original.handoverCaptures(into: intake, route: route)
        for delivered in [99.0, 100.0] {
            guard case let .ambiguousFloor(item) = try await intake.captureReminder(response(delivered: delivered)) else { return XCTFail("Unknown floor delivery must stay ambiguous") }
            let before = try Data(contentsOf: record(item.id))
            await refused(.ambiguousReminderFloor) { _ = try await original.admitHeldReminder(item, in: intake, route: self.route) }
            XCTAssertEqual(try Data(contentsOf: record(item.id)), before)
        }
        let page = try await intake.pendingPage()
        let imported = try XCTUnwrap(page.items.first(where: { $0.id == sourceResponse.requestID }))
        let admitted = try await original.admitHeldReminder(imported, in: intake, route: route)
        XCTAssertEqual(admitted.event?.response, sourceResponse)
    }

    func testMixedAmbiguousFloorAndFreshCallbackOnlySkipsValidatedFloor() async throws {
        try seed([], floor: 100)
        let original = try source(), intake = try destination()
        try await original.handoverCaptures(into: intake, route: route)
        let older = try response(delivered: 99), fresh = try response(delivered: 101)
        guard case let .ambiguousFloor(held) = try await intake.captureReminder(older) else { return XCTFail("Older callback must remain held") }
        guard case let .captured(accepted) = try await intake.captureReminder(fresh) else { return XCTFail("Fresh callback must capture") }
        let heldBytes = try Data(contentsOf: record(held.id)), heldIdentity = try inode(record(held.id))
        await refused(.legacyHeld) { _ = try await intake.markAdmitting(held) }
        await refused(.legacyHeld) { _ = try await intake.markAdmitting(accepted) }
        let wrongRoute = try NativePersonalIntakeRoute.fixture(home: home, arguments: ["--native-ui-test-library", UUID().uuidString.lowercased()])
        do {
            _ = try await original.admitHeldReminder(held, in: intake, route: wrongRoute)
            XCTFail("Wrong original route must refuse")
        } catch {
            XCTAssertNotEqual(error as? NativePersonalIntakeError, .ambiguousReminderFloor,
                "Proof uncertainty must stop replay rather than being classified as an individually held floor row")
        }
        var skipped: [String] = [], completed: [String] = []
        let page = try await intake.pendingPage()
        XCTAssertEqual(page.items.map(\.id), [held.id, accepted.id])
        for item in page.items {
            let admitted: NativePersonalIntake.Item
            do { admitted = try await original.admitHeldReminder(item, in: intake, route: route) }
            catch NativePersonalIntakeError.ambiguousReminderFloor { skipped.append(item.id); continue }
            let dispatch = try await original.heldReminderDispatchItem(admitted, in: intake, route: route)
            XCTAssertEqual(dispatch.response, fresh)
            // Only the fresh exact response reaches the modeled domain receipt before finish.
            let settled = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: route)
            completed.append(settled.id)
        }
        XCTAssertEqual(skipped, [held.id]); XCTAssertEqual(completed, [accepted.id])
        let remaining = try await intake.pendingPage()
        XCTAssertEqual(remaining.items.map(\.id), [held.id]); XCTAssertEqual(remaining.items.first?.stage, .captured)
        XCTAssertEqual(try Data(contentsOf: record(held.id)), heldBytes); XCTAssertEqual(try inode(record(held.id)), heldIdentity)
        await refused(.ambiguousReminderFloor) { _ = try await original.admitHeldReminder(held, in: intake, route: self.route) }
    }

    func testLostFinishReplySettlesOnlyOriginalItemAndOutcomeWithoutRewriting() async throws {
        let event = try response(); try seed([(event, 1, .captured)])
        let original = try source(), intake = try destination()
        try await original.handoverCaptures(into: intake, route: route)
        let captured = try await first(intake)
        let admitted = try await original.admitHeldReminder(captured, in: intake, route: route)
        _ = try await original.heldReminderDispatchItem(admitted, in: intake, route: route)
        await intake.setIOFaults(afterPublication: { if $0 == event.requestID + ".json" { throw Injected.failure } })
        await refused { _ = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: self.route) }
        let terminal = try Data(contentsOf: record(admitted.id)), identity = try inode(record(admitted.id))
        await refused { _ = try await original.finishHeldReminder(admitted, outcome: .ignored, in: intake, route: self.route) }
        await refused { _ = try await original.finishHeldReminder(captured, outcome: .completed, in: intake, route: self.route) }
        await intake.setIOFaults()
        let settlement = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: route)
        XCTAssertEqual(settlement.id, admitted.id); XCTAssertEqual(settlement.outcome, .completed)
        XCTAssertEqual(try Data(contentsOf: record(admitted.id)), terminal); XCTAssertEqual(try inode(record(admitted.id)), identity)
        _ = try await original.finishHeldReminder(admitted, outcome: .completed, in: intake, route: route)
        XCTAssertEqual(try inode(record(admitted.id)), identity)
    }

    func testColdReopenResealsProgressedImportWithoutResurrectionOrFreshReceipt() async throws {
        let captured = try response(), admitting = try response(clock: 456)
        try seed([(captured, 2, .captured), (admitting, 9, .admitting)])
        let original = try source(), intake = try destination()
        try await original.handoverCaptures(into: intake, route: route)
        let initial = try await intake.pendingPage()
        let firstAdmitted = try await original.admitHeldReminder(XCTUnwrap(initial.items.first), in: intake, route: route)
        let admittingBytes = try Data(contentsOf: record(firstAdmitted.id))
        await intake.close(); await original.close()
        let secondSource = try source(existing: true), secondIntake = try destination(existing: true)
        try await secondSource.handoverCaptures(into: secondIntake, route: route)
        XCTAssertEqual(try Data(contentsOf: record(firstAdmitted.id)), admittingBytes)
        await refused(.staleItem) { _ = try await secondSource.admitHeldReminder(firstAdmitted, in: secondIntake, route: self.route) }
        let resumed = try await secondIntake.pendingPage()
        XCTAssertEqual(resumed.items.map(\.stage), [.admitting, .admitting])
        for item in resumed.items {
            let admitted = try await secondSource.admitHeldReminder(item, in: secondIntake, route: route)
            let dispatch = try await secondSource.heldReminderDispatchItem(admitted, in: secondIntake, route: route)
            XCTAssertEqual(dispatch.response, admitted.event?.response)
            _ = try await secondSource.finishHeldReminder(admitted, outcome: .completed, in: secondIntake, route: route)
        }
        let header = try Data(contentsOf: root.appendingPathComponent("state.json"))
        let recordBytes = try [captured, admitting].map { try Data(contentsOf: record($0.requestID)) }
        let identities = try [captured, admitting].map { try inode(record($0.requestID)) }
        await secondIntake.close(); await secondSource.close()
        let coldSource = try source(existing: true), coldIntake = try destination(existing: true)
        try await coldSource.handoverCaptures(into: coldIntake, route: route)
        let pending = try await coldIntake.pendingPage(); XCTAssertTrue(pending.items.isEmpty)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("state.json")), header)
        XCTAssertEqual(try [captured, admitting].map { try Data(contentsOf: record($0.requestID)) }, recordBytes)
        XCTAssertEqual(try [captured, admitting].map { try inode(record($0.requestID)) }, identities)
        await refused(.staleItem) { _ = try await coldSource.finishHeldReminder(firstAdmitted, outcome: .completed, in: coldIntake, route: self.route) }
        for event in [captured, admitting] {
            guard case .knownTerminal = try await coldIntake.captureReminder(event) else { return XCTFail("Cold terminal must not become a new capture") }
        }
    }

    func testOriginalSourceClosureAfterDestinationAwaitCannotPublishAdmission() async throws {
        let event = try response(); try seed([(event, 1, .captured)])
        let original = try source(), intake = try destination(), barrier = Barrier()
        try await original.handoverCaptures(into: intake, route: route)
        let captured = try await first(intake), frozenRoute = try XCTUnwrap(route)
        await intake.setHeldReminderReplayBarrier { await barrier.hold() }
        let admission = Task { try await original.admitHeldReminder(captured, in: intake, route: frozenRoute) }
        await barrier.wait(); await original.close(); await barrier.open()
        await refused { _ = try await admission.value }
        await intake.setHeldReminderReplayBarrier(nil)
        let held = try await first(intake)
        XCTAssertEqual(held.stage, .admitting, "Storage progress alone cannot publish original producer authority")
        await refused { _ = try await original.heldReminderDispatchItem(held, in: intake, route: self.route) }
    }

    func testChangedColdOriginalGenerationAndMalformedProgressRefuseWithoutRepair() async throws {
        let event = try response(); try seed([(event, 1, .captured)])
        let original = try source(), intake = try destination()
        try await original.handoverCaptures(into: intake, route: route)
        let captured = try await first(intake)
        _ = try await original.admitHeldReminder(captured, in: intake, route: route)
        let before = try Data(contentsOf: record(captured.id))
        await intake.close(); await original.close()
        try seed([(response(id: event.requestID, clock: event.requestedAtMs + 1), 1, .captured)])
        let changedSource = try source(existing: true), coldIntake = try destination(existing: true)
        await refused { try await changedSource.handoverCaptures(into: coldIntake, route: self.route) }
        XCTAssertEqual(try Data(contentsOf: record(captured.id)), before)
        await coldIntake.close(); await changedSource.close()
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: before) as? [String: Any])
        raw["revision"] = 0 // An admitting row cannot masquerade as an original captured revision.
        let malformed = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys, .withoutEscapingSlashes])
        try malformed.write(to: record(captured.id))
        let malformedIntake = try destination(existing: true)
        await refused { _ = try await malformedIntake.pendingPage() }
        XCTAssertEqual(try Data(contentsOf: record(captured.id)), malformed)
    }
}
