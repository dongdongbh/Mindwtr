import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeReminderImportTests: XCTestCase {
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
    private final class Diagnostics: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [NativeReminderInbox.ImportDiagnostic] = []
        private var intakeValues: [NativePersonalIntake.Diagnostic] = []
        func receive(_ event: NativeReminderInbox.ImportDiagnostic) { lock.lock(); defer { lock.unlock() }; values.append(event) }
        var events: [NativeReminderInbox.ImportDiagnostic] { lock.lock(); defer { lock.unlock() }; return values }
        func receive(_ event: NativePersonalIntake.Diagnostic) { lock.lock(); defer { lock.unlock() }; intakeValues.append(event) }
        var intakeEvents: [NativePersonalIntake.Diagnostic] { lock.lock(); defer { lock.unlock() }; return intakeValues }
    }
    private var home: URL!
    private var route: NativePersonalIntakeRoute!
    private var sources: [NativeReminderInbox] = []
    private var targets: [NativePersonalIntake] = []
    private var root: URL { route.components.reduce(home!) { $0.appendingPathComponent($1, isDirectory: true) } }
    private var state: URL { root.appendingPathComponent("state.json") }
    private var terminals: URL { root.appendingPathComponent("legacy-reminder-terminals.json") }
    private var legacyFile: URL { home.appendingPathComponent("Library/Application Support/NativeFoundation/NotificationResponses/inbox.json") }
    private func record(_ id: String) -> URL { root.appendingPathComponent("records/\(id).json") }

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/personal-intake/\(UUID().uuidString.lowercased())/home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        home = home.resolvingSymlinksInPath(); route = try .fixture(home: home)
    }
    override func tearDown() async throws {
        for target in targets { await target.close() }
        for source in sources { await source.close() }
        targets.removeAll(); sources.removeAll()
        try FileManager.default.removeItem(at: home.deletingLastPathComponent())
    }
    private func response(id: String = UUID().uuidString.lowercased(), clock: Int64 = 1_700_000_000_123,
                          delivered: Double = 100, task: String = "\u{FEFF}e\u{301} 🧠") throws -> NativeReminderResponse {
        let json = try JSONSerialization.data(withJSONObject: ["requestId": id, "taskId": task], options: [.sortedKeys])
        return .init(requestID: id, notificationIdentifier: "mindwtr-native:\(route.namespace):1", action: .complete,
            deliveredAtBits: String(format: "%016llx", delivered.bitPattern), requestedAtMs: clock,
            payloadJSON: String(decoding: json, as: UTF8.self))
    }
    private func seed(_ entries: [(NativeReminderResponse, Int64, NativeReminderInbox.Stage)], terminalCount: Int = 0,
                      floor: Double? = nil) throws -> [String] {
        try FileManager.default.createDirectory(at: legacyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let active = try entries.map { entry -> [String: Any] in
            ["sequence": entry.1, "stage": entry.2.rawValue,
             "response": try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.0))]
        }
        let ids = (0..<terminalCount).map { _ in UUID().uuidString.lowercased() }
        let terminal = ids.enumerated().map { ["requestID": $0.element, "deliveredAtBits": String(format: "%016llx", Double($0.offset + 101).bitPattern)] }
        var raw: [String: Any] = ["version": 1, "namespace": route.namespace, "nextSequence": (entries.map { $0.1 }.max() ?? 0) + 1,
                                  "active": active, "tombstones": terminal]
        if let floor { raw["retiredThrough"] = String(format: "%016llx", floor.bitPattern) }
        try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys]).write(to: legacyFile)
        return ids
    }
    private func source() async throws -> (NativeReminderInbox, NativeReminderInbox.Seal) {
        let owner = try NativeReminderInbox(selection: route.selection); sources.append(owner)
        return (owner, try await owner.sealForPersonalIntake(route: route, diagnostic: { _ in }))
    }
    private func target(diagnostic: @escaping NativePersonalIntake.DiagnosticSink = { _ in }) throws -> NativePersonalIntake {
        let value = try NativePersonalIntake(route: route, diagnostic: diagnostic); targets.append(value); return value
    }
    private func terminalTarget(_ diagnostics: Diagnostics, floor: Double? = nil) async throws -> (NativePersonalIntake, NativeReminderResponse) {
        let ids = try seed([], terminalCount: 1, floor: floor)
        let (owner, token) = try await source(), destination = try target { diagnostics.receive($0) }
        try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in })
        return (destination, try response(id: XCTUnwrap(ids.first), delivered: 101))
    }
    private func failure(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Original sealed import must refuse", file: file, line: line) }
        catch { }
    }
    private func object(_ url: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func substitute(_ url: URL) throws -> UInt64 {
        let bytes = try Data(contentsOf: url), next = url.deletingLastPathComponent().appendingPathComponent("foreign-\(UUID().uuidString)")
        try bytes.write(to: next)
        if let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] {
            try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: next.path)
        }
        guard rename(next.path, url.path) == 0 else { throw Injected.failure }
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw Injected.failure }; return UInt64(value.st_ino)
    }

    func testAppBridgeRequiresExistingOriginalSourceAndKeepsSameLiveFinalProof() async throws {
        XCTAssertThrowsError(try NativeReminderInbox.openExistingForHandover(selection: route.selection))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library").path))
        let event = try response(); _ = try seed([(event, 7, .admitting)])
        let bytes = try Data(contentsOf: legacyFile)
        let original = try NativeReminderInbox(selection: route.selection); sources.append(original)
        let destination = try target()
        try await original.handoverCaptures(into: destination, route: route)
        let held = try await destination.requiresReminderPreparation(); XCTAssertTrue(held)
        let page = try await destination.pendingPage()
        XCTAssertEqual(page.items.first?.event?.response, event); XCTAssertEqual(page.items.first?.stage, .admitting)
        XCTAssertEqual(try Data(contentsOf: legacyFile), bytes)
        await failure { _ = try await original.capture(event) }
        await original.close()
        do { try await original.handoverCaptures(into: destination, route: route); XCTFail("Closed original cannot ACK") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        await destination.close()
        let coldSource = try NativeReminderInbox.openExistingForHandover(selection: route.selection); sources.append(coldSource)
        let coldTarget = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); targets.append(coldTarget)
        try await coldSource.handoverCaptures(into: coldTarget, route: route)
        let coldPage = try await coldTarget.pendingPage(); XCTAssertEqual(coldPage.items.first?.event?.response, event)
        XCTAssertEqual(try Data(contentsOf: legacyFile), bytes)
    }

    func testAppColdProjectionHoldsPartialImportAndMissingOriginalWithoutRecreatingIt() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (original, _) = try await source(), destination = try target()
        await destination.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        do { try await original.handoverCaptures(into: destination, route: route); XCTFail("Partial import cannot ACK") }
        catch { XCTAssertEqual(error as? NativeReminderInbox.CaptureHandoverFailure, .unavailable) }
        let header = try Data(contentsOf: state)
        await destination.close(); await original.close()
        let existing = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); targets.append(existing)
        let held = try await existing.requiresReminderPreparation(); XCTAssertTrue(held)
        try FileManager.default.removeItem(at: legacyFile)
        XCTAssertThrowsError(try NativeReminderInbox.openExistingForHandover(selection: route.selection))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyFile.path))
        XCTAssertEqual(try Data(contentsOf: state), header)
    }

    func testRealImportPreservesFirstBytesClockSequenceAdmittingTerminalsAndFloorWhileHeld() async throws {
        let first = try response(delivered: 90), second = try response(clock: 123, delivered: 200)
        let terminalIDs = try seed([(first, 2, .captured), (second, 9, .admitting)], terminalCount: 16_384, floor: 100)
        let originalBytes = try Data(contentsOf: legacyFile), (owner, token) = try await source(), diagnostics = Diagnostics()
        let initial = try target()
        _ = try await initial.capture(.url("mindwtr://old"))
        let oldHeader = try Data(contentsOf: state)
        XCTAssertNil(try object(state)["legacy"])
        await initial.close(); let destination = try target()
        XCTAssertEqual(try Data(contentsOf: state), oldHeader)
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        let page = try await destination.pendingPage()
        XCTAssertEqual(page.items.map(\.sequence), [1, 2, 3])
        XCTAssertEqual(page.items.suffix(2).map(\.stage), [.captured, .admitting])
        XCTAssertEqual(page.items.suffix(2).compactMap { $0.event?.response }, [first, second])
        XCTAssertEqual((try object(record(first.requestID))["legacySequence"] as? NSNumber)?.int64Value, 2)
        XCTAssertEqual((try object(record(second.requestID))["legacySequence"] as? NSNumber)?.int64Value, 9)
        let importedValue = try await destination.importedLegacy()
        let imported = try XCTUnwrap(importedValue)
        XCTAssertEqual(imported.importedCount, 2); XCTAssertEqual(imported.activeCount, 2)
        XCTAssertEqual(imported.terminal.map(\.requestID), terminalIDs)
        XCTAssertEqual(imported.retiredThrough, String(format: "%016llx", Double(100).bitPattern))
        XCTAssertLessThanOrEqual(try Data(contentsOf: terminals).count, 4 * 1024 * 1024)
        XCTAssertFalse(FileManager.default.fileExists(atPath: record(try XCTUnwrap(terminalIDs.first)).path))
        for item in page.items.suffix(2) {
            await failure { _ = try await destination.markAdmitting(item) }
            await failure { try await destination.finish(item, outcome: .completed) }
        }
        let beforeRepeat = try Data(contentsOf: state)
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        XCTAssertEqual(try Data(contentsOf: state), beforeRepeat); XCTAssertEqual(diagnostics.events.count, 1)
        XCTAssertEqual(try Data(contentsOf: legacyFile), originalBytes)
        let ambiguous = try response(delivered: 0)
        let held = try await destination.capture(.reminder(ambiguous))
        XCTAssertEqual(held.event?.response, ambiguous)
        await failure { _ = try await destination.markAdmitting(held) }
    }

    func testConflictingPreviouslyAcknowledgedIDRefusesWithoutReplacementOrImportReservation() async throws {
        let first = try response(); _ = try seed([(first, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        let newer = try response(id: first.requestID, clock: first.requestedAtMs + 1, task: "newer queued payload")
        _ = try await destination.capture(.reminder(newer))
        let header = try Data(contentsOf: state), accepted = try Data(contentsOf: record(first.requestID))
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: record(first.requestID)), accepted)
        XCTAssertNil(try object(state)["legacy"]); XCTAssertTrue(diagnostics.events.isEmpty)
    }

    func testTerminalLostACKHotRetryRetainsOriginalPublicationIdentity() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        await destination.setIOFaults(afterPublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let bytes = try Data(contentsOf: terminals)
        await failure { try await destination.retry() }
        await destination.setIOFaults()
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        XCTAssertEqual(try Data(contentsOf: terminals), bytes); XCTAssertEqual(diagnostics.events.count, 1)
        let page = try await destination.pendingPage(); XCTAssertEqual(page.items.map(\.id), [event.requestID])
    }

    func testColdUnwitnessedTerminalPublicationRemainsHeldWithoutSameByteAdoption() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        await destination.setIOFaults(afterPublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let header = try Data(contentsOf: state), bytes = try Data(contentsOf: terminals)
        await destination.close(); let cold = try target()
        await failure { try await owner.importSealed(token, into: cold, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: terminals), bytes)
        XCTAssertTrue(diagnostics.events.isEmpty)
        await failure { _ = try await cold.pendingPage() }
    }

    func testRecordLostACKAndFinalProgressClearRetryKeepOneOriginalCohort() async throws {
        let event = try response(); _ = try seed([(event, 8, .admitting)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        await destination.setIOFaults(afterPublication: { if $0 == event.requestID + ".json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let stateURL = state
        await destination.setIOFaults(afterPublication: { name in
            if name == "state.json",
               let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any],
               let legacy = raw["legacy"] as? [String: Any], (legacy["imported"] as? NSNumber)?.intValue == 1,
               raw["pending"] == nil { throw Injected.failure }
        })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertTrue(diagnostics.events.isEmpty)
        let retained = await destination.retainedArtifactCount(); XCTAssertEqual(retained, 2)
        await destination.setIOFaults()
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        let page = try await destination.pendingPage()
        XCTAssertEqual(page.items.map(\.sequence), [1]); XCTAssertEqual(page.items.first?.stage, .admitting)
        XCTAssertEqual(page.items.first?.event?.response, event); XCTAssertEqual(diagnostics.events.count, 1)
        let cleared = await destination.retainedArtifactCount(); XCTAssertEqual(cleared, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("records").path).count, 1)
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        XCTAssertEqual(diagnostics.events.count, 1)
    }

    func testFinalProgressClearLostACKCannotTransferForeignSameByteRecordWitness() async throws {
        let event = try response(); _ = try seed([(event, 8, .admitting)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics(), stateURL = state
        await destination.setIOFaults(afterPublication: { name in
            if name == "state.json", let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any],
               let legacy = raw["legacy"] as? [String: Any], (legacy["imported"] as? NSNumber)?.intValue == 1,
               raw["pending"] == nil { throw Injected.failure }
        })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let retained = await destination.retainedArtifactCount(); XCTAssertEqual(retained, 2)
        let header = try Data(contentsOf: state), accepted = try Data(contentsOf: record(event.requestID))
        let foreign = try substitute(record(event.requestID))
        await destination.setIOFaults()
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertTrue(diagnostics.events.isEmpty)
        var value = stat(); XCTAssertEqual(lstat(record(event.requestID).path, &value), 0); XCTAssertEqual(UInt64(value.st_ino), foreign)
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: record(event.requestID)), accepted)
        await failure { _ = try await destination.capture(.url("mindwtr://must-remain-held")) }
        XCTAssertEqual(try Data(contentsOf: state), header)
    }

    private func retryCheckpoint(_ field: String) async throws {
        let event = try response(); _ = try seed([(event, 4, .admitting)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics(), stateURL = state
        await destination.setIOFaults(afterPublication: { name in
            if field == "order", name == "0000000000000001.json" { throw Injected.failure }
            guard name == "state.json",
                  let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any] else { return }
            if field == "terminalWitness", let legacy = raw["legacy"] as? [String: Any], legacy[field] != nil { throw Injected.failure }
            if let pending = raw["pending"] as? [String: Any], pending[field] != nil { throw Injected.failure }
        })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertTrue(diagnostics.events.isEmpty)
        await failure { _ = try await destination.pendingPage() }
        let retained = await destination.retainedArtifactCount(); XCTAssertLessThanOrEqual(retained, 2)
        await destination.setIOFaults()
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        let page = try await destination.pendingPage()
        XCTAssertEqual(page.items.map(\.sequence), [1]); XCTAssertEqual(page.items.first?.stage, .admitting)
        XCTAssertEqual(page.items.first?.event?.response, event); XCTAssertEqual(diagnostics.events.count, 1)
        let cleared = await destination.retainedArtifactCount(); XCTAssertEqual(cleared, 0)
    }

    func testTerminalWitnessLostACKRetriesExactOriginalCheckpoint() async throws { try await retryCheckpoint("terminalWitness") }
    func testRecordWitnessLostACKRetriesExactOriginalCheckpoint() async throws { try await retryCheckpoint("recordWitness") }
    func testOrderWitnessLostACKRetriesExactOriginalCheckpoint() async throws { try await retryCheckpoint("orderWitness") }
    func testOrderPublicationLostACKRetriesExactOriginalCheckpoint() async throws { try await retryCheckpoint("order") }

    func testSameByteTerminalSubstitutionCannotResumeWitnessedImport() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics(), stateURL = state
        await destination.setIOFaults(afterPublication: { name in
            if name == "state.json", let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any],
               let legacy = raw["legacy"] as? [String: Any], legacy["terminalWitness"] != nil { throw Injected.failure }
        })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let header = try Data(contentsOf: state), bytes = try Data(contentsOf: terminals), inode = try substitute(terminals)
        await destination.setIOFaults()
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        var retained = stat(); XCTAssertEqual(lstat(terminals.path, &retained), 0); XCTAssertEqual(UInt64(retained.st_ino), inode)
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: terminals), bytes)
        XCTAssertTrue(diagnostics.events.isEmpty)
        await failure { _ = try await destination.capture(.url("mindwtr://held")) }
        XCTAssertEqual(try Data(contentsOf: state), header)
    }

    func testChangedOriginalCannotRetryEvenTheHotInitialHeaderAttempt() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        let before = try Data(contentsOf: state)
        await destination.setIOFaults(beforePublication: { if $0 == "state.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await destination.setIOFaults(); await owner.close()
        _ = try seed([(response(id: event.requestID, clock: event.requestedAtMs + 1), 1, .captured)])
        let (changed, changedToken) = try await source()
        await failure { try await changed.importSealed(changedToken, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), before); XCTAssertTrue(diagnostics.events.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: terminals.path))
    }

    func testCompletedImportCannotSettleUnrelatedOrdinaryCaptureDebt() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        let before = try Data(contentsOf: state)
        await destination.setIOFaults(beforePublication: { if $0 == "state.json" { throw Injected.failure } })
        await failure { _ = try await destination.capture(.url("mindwtr://ordinary")) }
        await destination.setIOFaults()
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), before); XCTAssertEqual(diagnostics.events.count, 1)
        try await destination.retry()
        let page = try await destination.pendingPage(); XCTAssertEqual(page.items.count, 2)
    }

    func testColdAbsentArtifactResumesOnlyWithFreshLiveSameGenerationSeal() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target()
        await destination.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in }) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: terminals.path))
        await destination.close(); await owner.close()
        let cold = try target(), (newOwner, newToken) = try await source()
        await failure { try await newOwner.importSealed(token, into: cold, route: route, diagnostic: { _ in }) }
        try await newOwner.importSealed(newToken, into: cold, route: route, diagnostic: { _ in })
        let page = try await cold.pendingPage(); XCTAssertEqual(page.items.first?.event?.response, event)
    }

    func testChangedColdOriginalGenerationCannotResumeReservedImport() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), diagnostics = Diagnostics()
        await destination.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        let header = try Data(contentsOf: state)
        await destination.close(); await owner.close()
        _ = try seed([(response(id: event.requestID, clock: event.requestedAtMs + 1), 1, .captured)])
        let (changed, changedToken) = try await source(), cold = try target()
        await failure { try await changed.importSealed(changedToken, into: cold, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertTrue(diagnostics.events.isEmpty)
    }

    func testDestinationReservesActualImportGateBeforeAwaitingOriginal() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier()
        await destination.setLegacyReadBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in }) }
        await barrier.wait()
        let originalHeader = try Data(contentsOf: state)
        await failure { _ = try await destination.capture(.url("mindwtr://must-wait")) }
        XCTAssertEqual(try Data(contentsOf: state), originalHeader)
        await barrier.open(); try await operation.value
        let page = try await destination.pendingPage(); XCTAssertEqual(page.items.count, 1)
    }

    func testOriginalCloseAfterActualTargetCompletionCannotAcknowledgeImport() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait()
        let legacy = try XCTUnwrap(try object(state)["legacy"] as? [String: Any])
        XCTAssertEqual((legacy["imported"] as? NSNumber)?.intValue, 1)
        await failure { _ = try await destination.importedLegacy() }
        await owner.close(); await barrier.open()
        await failure { try await operation.value }
        XCTAssertTrue(diagnostics.events.isEmpty)
        await failure { _ = try await destination.pendingPage() }
        await failure { _ = try await destination.capture(.url("mindwtr://held-after-source-close")) }
    }

    func testForeignSourceGenerationAtActualAcknowledgementStaysHeld() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait(); _ = try substitute(legacyFile); await barrier.open()
        await failure { try await operation.value }
        XCTAssertTrue(diagnostics.events.isEmpty)
        let legacy = try XCTUnwrap(try object(state)["legacy"] as? [String: Any])
        XCTAssertEqual((legacy["imported"] as? NSNumber)?.intValue, 1)
        await failure { _ = try await destination.importedLegacy() }
    }

    func testDestinationReservationRemainsHeldUntilActualOriginalAcknowledgement() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait()
        let header = try Data(contentsOf: state)
        await failure { _ = try await destination.capture(.url("mindwtr://must-wait-for-ack")) }
        await failure { try await destination.retry() }
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertTrue(diagnostics.events.isEmpty)
        await barrier.open(); try await operation.value
        XCTAssertEqual(diagnostics.events.count, 1)
        _ = try await destination.capture(.url("mindwtr://after-ack"))
        let page = try await destination.pendingPage(); XCTAssertEqual(page.items.count, 2)
    }

    func testDestinationCloseAtActualAcknowledgementInvalidatesBeforeReleasingFiles() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait()
        let header = try Data(contentsOf: state), accepted = try Data(contentsOf: record(event.requestID))
        await destination.close()
        await barrier.open(); await failure { try await operation.value }
        XCTAssertTrue(diagnostics.events.isEmpty)
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: record(event.requestID)), accepted)
        await owner.setImportAcknowledgementBarrier(nil)
        let reopened = try target()
        try await owner.importSealed(token, into: reopened, route: route) { diagnostics.receive($0) }
        XCTAssertEqual(diagnostics.events.count, 1)
        let page = try await reopened.pendingPage(); XCTAssertEqual(page.items.first?.event?.response, event)
        await failure { _ = try await reopened.markAdmitting(XCTUnwrap(page.items.first)) }
    }

    func testDestinationSameByteInodeSubstitutionAtActualAcknowledgementRefusesCompletion() async throws {
        let event = try response(); _ = try seed([(event, 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait()
        let header = try Data(contentsOf: state), accepted = try Data(contentsOf: record(event.requestID))
        let foreign = try substitute(record(event.requestID))
        await barrier.open(); await failure { try await operation.value }
        XCTAssertTrue(diagnostics.events.isEmpty)
        var retained = stat(); XCTAssertEqual(lstat(record(event.requestID).path, &retained), 0)
        XCTAssertEqual(UInt64(retained.st_ino), foreign)
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: record(event.requestID)), accepted)
        await failure { _ = try await destination.pendingPage() }
        await owner.setImportAcknowledgementBarrier(nil)
        await failure { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertTrue(diagnostics.events.isEmpty)
    }

    func testCancellationJoinsActualTargetCompletionWithoutImportAcknowledgement() async throws {
        _ = try seed([(response(), 1, .captured)])
        let (owner, token) = try await source(), destination = try target(), barrier = Barrier(), diagnostics = Diagnostics()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) } }
        await barrier.wait(); operation.cancel(); await barrier.open()
        await failure { try await operation.value }
        XCTAssertTrue(diagnostics.events.isEmpty)
        let before = try Data(contentsOf: state)
        await owner.setImportAcknowledgementBarrier(nil)
        try await owner.importSealed(token, into: destination, route: route) { diagnostics.receive($0) }
        XCTAssertEqual(try Data(contentsOf: state), before); XCTAssertEqual(diagnostics.events.count, 1)
    }

    func testReminderKnownTerminalFromActualFinishHasNoItemWriteOrCapturedMarker() async throws {
        let event = try response(), owner = try NativeReminderInbox(selection: route.selection), diagnostics = Diagnostics()
        sources.append(owner)
        _ = try await owner.capture(event)
        let admitted = try await owner.markAdmitting(event.requestID); try await owner.finish(admitted)
        let token = try await owner.sealForPersonalIntake(route: route, diagnostic: { _ in })
        let destination = try target { diagnostics.receive($0) }
        try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in })
        let header = try Data(contentsOf: state), sidecar = try Data(contentsOf: terminals)
        for _ in 0..<2 {
            guard case .knownTerminal = try await destination.captureReminder(event) else { return XCTFail("Expected exact known terminal") }
        }
        do { _ = try await destination.capture(.reminder(event)); XCTFail("Item-only capture must refuse a terminal") }
        catch { XCTAssertEqual(error as? NativePersonalIntakeError, .legacyHeld) }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: terminals), sidecar)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("records").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("order").path), [])
        XCTAssertEqual(diagnostics.intakeEvents.map(\.outcome), ["knownTerminal", "knownTerminal", "knownTerminal"])
        XCTAssertTrue(diagnostics.intakeEvents.allSatisfy { $0.releaseCheck == "v1.3.9/ios-personal-intake-disposition" && $0.operation == "reminder-capture" })
    }

    func testReminderFloorUnknownAndOriginalActiveKeepTruthfulHotColdDispositionAndFirstBytes() async throws {
        let captured = try response(delivered: 90), admitting = try response(delivered: 95)
        _ = try seed([(captured, 2, .captured), (admitting, 9, .admitting)], floor: 100)
        let (owner, token) = try await source(), diagnostics = Diagnostics()
        var destination = try target { diagnostics.receive($0) }
        try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in })
        let equal = try response(delivered: 100), below = try response(delivered: 99), above = try response(delivered: 101)
        for event in [equal, below] {
            guard case let .ambiguousFloor(item) = try await destination.captureReminder(event) else { return XCTFail("Unknown at/below floor must remain durable ambiguity") }
            XCTAssertEqual(item.event?.response, event); XCTAssertEqual(item.stage, .captured)
        }
        guard case .captured = try await destination.captureReminder(above) else { return XCTFail("Above floor must capture") }
        let settled = try Data(contentsOf: state)
        for cold in [false, true] {
            if cold { await destination.close(); destination = try target { diagnostics.receive($0) } }
            for (event, phase) in [(captured, NativePersonalIntake.Stage.captured), (admitting, .admitting)] {
                let newer = try response(id: event.requestID, clock: event.requestedAtMs + 1, delivered: event == captured ? 90 : 95, task: "later payload")
                guard case let .captured(item) = try await destination.captureReminder(newer) else { return XCTFail("Original active is captured even below floor") }
                XCTAssertEqual(item.event?.response, event); XCTAssertEqual(item.stage, phase)
                await failure { _ = try await destination.markAdmitting(item) }
                await failure { try await destination.finish(item, outcome: .completed) }
            }
            for (event, delivery) in [(equal, Double(100)), (below, Double(99))] {
                let newer = try response(id: event.requestID, clock: event.requestedAtMs + 1, delivered: delivery, task: "later payload")
                guard case let .ambiguousFloor(item) = try await destination.captureReminder(newer) else { return XCTFail("Ambiguous delivery must stay ambiguous after retry/reopen") }
                XCTAssertEqual(item.event?.response, event)
                let generic = try await destination.capture(.reminder(newer)); XCTAssertEqual(generic.sequence, item.sequence)
                await failure { _ = try await destination.markAdmitting(item) }
            }
        }
        XCTAssertEqual(try Data(contentsOf: state), settled)
        let page = try await destination.pendingPage(); XCTAssertEqual(page.items.map(\.sequence), [1, 2, 3, 4, 5])
    }

    func testReminderDispositionIdentityMismatchAndTerminalTargetCollisionNeverRewrite() async throws {
        let event = try response(delivered: 200), ids = try seed([(event, 1, .captured)], terminalCount: 1)
        let terminalID = try XCTUnwrap(ids.first), diagnostics = Diagnostics(), destination = try target { diagnostics.receive($0) }
        let collision = try await destination.capture(.url("mindwtr://kept", id: XCTUnwrap(UUID(uuidString: terminalID))))
        let (owner, token) = try await source()
        try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in })
        let header = try Data(contentsOf: state), accepted = try Data(contentsOf: record(event.requestID)), kept = try Data(contentsOf: record(terminalID))
        let wrongIdentifier = NativeReminderResponse(requestID: event.requestID, notificationIdentifier: "mindwtr-native:\(route.namespace):2", action: .complete, deliveredAtBits: event.deliveredAtBits, requestedAtMs: event.requestedAtMs, payloadJSON: event.payloadJSON)
        let wrongAction = NativeReminderResponse(requestID: event.requestID, notificationIdentifier: event.notificationIdentifier, action: .dismiss, deliveredAtBits: event.deliveredAtBits, requestedAtMs: event.requestedAtMs, payloadJSON: "{}")
        for incoming in [wrongIdentifier, wrongAction, try response(id: event.requestID, delivered: 201), try response(id: terminalID, delivered: 101), try response(id: terminalID, delivered: 102)] {
            await failure { _ = try await destination.captureReminder(incoming) }
        }
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: record(event.requestID)), accepted)
        XCTAssertEqual(try Data(contentsOf: record(terminalID)), kept); XCTAssertEqual(collision.kind, .url)
        XCTAssertFalse(diagnostics.intakeEvents.contains { $0.operation == "reminder-capture" })
    }

    func testReminderTerminalDeliveryMismatchRefusesWithoutPublication() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let header = try Data(contentsOf: state)
        let wrong = try response(id: event.requestID, delivered: 102)
        await failure { _ = try await destination.captureReminder(wrong) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
        XCTAssertFalse(FileManager.default.fileExists(atPath: record(event.requestID).path))
    }

    func testGenericReminderCaptureValidatesOriginalEnvelopeBeforeDisposition() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(NativePersonalIntakeEvent.reminder(event))) as? [String: Any])
        raw["id"] = UUID().uuidString.lowercased()
        let malformed = try JSONDecoder().decode(NativePersonalIntakeEvent.self, from: JSONSerialization.data(withJSONObject: raw))
        let header = try Data(contentsOf: state)
        await failure { _ = try await destination.capture(malformed) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
    }

    func testReminderDispositionRejectsSameByteForeignTerminalWitnessWithoutPositiveMarker() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let header = try Data(contentsOf: state), bytes = try Data(contentsOf: terminals), foreign = try substitute(terminals)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty)
        var value = stat(); XCTAssertEqual(lstat(terminals.path, &value), 0); XCTAssertEqual(UInt64(value.st_ino), foreign)
        XCTAssertEqual(try Data(contentsOf: state), header); XCTAssertEqual(try Data(contentsOf: terminals), bytes)
    }

    func testReminderDispositionMissingTerminalSnapshotRefusesWithoutMutation() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let header = try Data(contentsOf: state); try FileManager.default.removeItem(at: terminals)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
        XCTAssertFalse(FileManager.default.fileExists(atPath: terminals.path))
    }

    func testReminderDispositionCorruptTerminalSnapshotRefusesWithoutRepair() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let header = try Data(contentsOf: state), corrupt = Data("{}".utf8); try corrupt.write(to: terminals)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
        XCTAssertEqual(try Data(contentsOf: terminals), corrupt)
    }

    func testReminderDispositionForeignHeaderAndLeaseRefuseWithoutPositiveMarker() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let header = try Data(contentsOf: state); _ = try substitute(state)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
        await destination.close()
        let reopened = try target { diagnostics.receive($0) }, lock = root.appendingPathComponent(".lock")
        _ = try substitute(lock)
        await failure { _ = try await reopened.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
    }

    func testReminderDispositionMovedRootNeverWritesReplacement() async throws {
        let diagnostics = Diagnostics(), (destination, event) = try await terminalTarget(diagnostics)
        let oldRoot = root, held = home.appendingPathComponent("held-intake", isDirectory: true), header = try Data(contentsOf: state)
        try FileManager.default.moveItem(at: oldRoot, to: held); try FileManager.default.createDirectory(at: oldRoot, withIntermediateDirectories: false)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent("state.json")), header)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: oldRoot.path), [])
    }

    func testReminderDispositionPendingAndRejectedOriginalAcknowledgementRemainHeld() async throws {
        let ids = try seed([], terminalCount: 1), event = try response(id: XCTUnwrap(ids.first), delivered: 101)
        let (owner, token) = try await source(), diagnostics = Diagnostics(), destination = try target { diagnostics.receive($0) }, barrier = Barrier()
        await owner.setImportAcknowledgementBarrier { await barrier.hold() }
        let operation = Task { try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in }) }
        await barrier.wait(); let header = try Data(contentsOf: state)
        await failure { _ = try await destination.captureReminder(event) }
        await owner.close(); await barrier.open(); await failure { try await operation.value }
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
    }

    func testReminderDispositionIncompleteImportCannotUseTerminalMetadataEarly() async throws {
        let ids = try seed([], terminalCount: 1), event = try response(id: XCTUnwrap(ids.first), delivered: 101)
        let (owner, token) = try await source(), diagnostics = Diagnostics(), destination = try target { diagnostics.receive($0) }
        await destination.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in }) }
        let header = try Data(contentsOf: state)
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty); XCTAssertEqual(try Data(contentsOf: state), header)
        await destination.setIOFaults()
        try await owner.importSealed(token, into: destination, route: route, diagnostic: { _ in })
        guard case .knownTerminal = try await destination.captureReminder(event) else { return XCTFail("Exact import retry must establish the stored fact") }
        XCTAssertEqual(diagnostics.intakeEvents.map(\.outcome), ["knownTerminal"])
    }

    private func retryReminderDispositionCut(_ cut: String) async throws {
        let diagnostics = Diagnostics(), (destination, _) = try await terminalTarget(diagnostics, floor: 100)
        let event = try response(delivered: 100), stateURL = state
        await destination.setIOFaults(afterPublication: { name in
            if (cut == "record" && name == event.requestID + ".json") || (cut == "order" && name == "0000000000000001.json") { throw Injected.failure }
            if cut == "clear", name == "state.json", let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any],
               raw["pending"] == nil, (raw["nextSequence"] as? NSNumber)?.intValue == 2 { throw Injected.failure }
        })
        await failure { _ = try await destination.captureReminder(event) }
        XCTAssertTrue(diagnostics.intakeEvents.isEmpty)
        await destination.setIOFaults(); try await destination.retry()
        guard case let .ambiguousFloor(item) = try await destination.captureReminder(event) else { return XCTFail("Exact pending publication retry must retain floor ambiguity") }
        XCTAssertEqual(item.event?.response, event); XCTAssertEqual(item.sequence, 1)
        guard case let .ambiguousFloor(repeated) = try await destination.captureReminder(response(id: event.requestID, clock: event.requestedAtMs + 1, delivered: 100, task: "later")) else { return XCTFail("Retry must remain ambiguous") }
        XCTAssertEqual(repeated.sequence, item.sequence); XCTAssertEqual(repeated.event?.response, event)
        XCTAssertEqual(diagnostics.intakeEvents.filter { $0.operation == "capture" }.count, 1)
        XCTAssertEqual(diagnostics.intakeEvents.filter { $0.outcome == "ambiguousFloor" }.count, 2)
    }
    func testReminderDispositionRecordLostACKRetainsFirstDurableAmbiguity() async throws { try await retryReminderDispositionCut("record") }
    func testReminderDispositionOrderLostACKRetainsFirstDurableAmbiguity() async throws { try await retryReminderDispositionCut("order") }
    func testReminderDispositionHeaderClearLostACKRetainsFirstDurableAmbiguity() async throws { try await retryReminderDispositionCut("clear") }
}
