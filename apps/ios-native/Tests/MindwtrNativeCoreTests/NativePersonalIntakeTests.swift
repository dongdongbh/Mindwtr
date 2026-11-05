import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativePersonalIntakeTests: XCTestCase {
    private final class Diagnostics: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [NativePersonalIntake.Diagnostic] = []
        func receive(_ value: NativePersonalIntake.Diagnostic) { lock.lock(); defer { lock.unlock() }; values.append(value) }
        var events: [NativePersonalIntake.Diagnostic] { lock.lock(); defer { lock.unlock() }; return values }
    }
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
    private var stores: [NativePersonalIntake] = []
    private var reminderSources: [NativeReminderInbox] = []
    private var finishHomes: [URL] = []
    private var root: URL { route.components.reduce(home!) { $0.appendingPathComponent($1, isDirectory: true) } }
    private var state: URL { root.appendingPathComponent("state.json") }
    private func record(_ id: String) -> URL { root.appendingPathComponent("records/\(id).json") }
    private func slot(_ sequence: Int) -> URL { root.appendingPathComponent(String(format: "order/%016d.json", sequence)) }

    override func setUpWithError() throws {
        home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-native-tests/personal-intake/\(UUID().uuidString.lowercased())/home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        home = home.resolvingSymlinksInPath()
        route = try .fixture(home: home)
    }
    override func tearDown() async throws {
        for store in stores { await store.close() }; stores.removeAll()
        for source in reminderSources { await source.close() }; reminderSources.removeAll()
        for finishHome in finishHomes {
            let ownedRoot = finishHome.deletingLastPathComponent()
            if FileManager.default.fileExists(atPath: ownedRoot.path) { try FileManager.default.removeItem(at: ownedRoot) }
        }
        finishHomes.removeAll()
        if let home { try FileManager.default.removeItem(at: home.deletingLastPathComponent()) }
    }
    private func open(_ sink: @escaping NativePersonalIntake.DiagnosticSink = { _ in }) throws -> NativePersonalIntake {
        let store = try NativePersonalIntake(route: route, diagnostic: sink); stores.append(store); return store
    }
    private func event(_ text: String = "mindwtr://capture?text=\u{FEFF}e\u{301} 🧠", id: UUID = UUID(), seconds: Double = 100) throws -> NativePersonalIntakeEvent {
        try .url(text, id: id, receivedAt: Date(timeIntervalSince1970: seconds))
    }
    private func failure(_ expected: NativePersonalIntakeError? = nil, _ body: () async throws -> Void,
                         file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected retained/closed intake refusal", file: file, line: line) }
        catch { if let expected { XCTAssertEqual(error as? NativePersonalIntakeError, expected, file: file, line: line) } }
    }
    private func replacement(_ url: URL) throws -> UInt64 {
        let bytes = try Data(contentsOf: url)
        let pending = url.deletingLastPathComponent().appendingPathComponent("foreign-\(UUID().uuidString)")
        try bytes.write(to: pending)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pending.path)
        guard rename(pending.path, url.path) == 0 else { throw Injected.failure }; return try inode(url)
    }
    private func inode(_ url: URL) throws -> UInt64 {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw Injected.failure }; return UInt64(value.st_ino)
    }
    private func dictionary(_ url: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func testExistingOnlyInspectionCreatesNothingAndDistinguishesUnrelatedIntake() async throws {
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertNil(try NativePersonalIntake.openExisting(route: route, diagnostic: { _ in }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library").path))
        let original = try open(); let item = try await original.capture(event())
        let bytes = try Data(contentsOf: state); await original.close()
        let existing = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(existing)
        let progress = try await existing.requiresReminderPreparation()
        XCTAssertFalse(progress, "URL/Spotlight storage alone cannot disable ordinary reminder dispatch")
        XCTAssertEqual(try Data(contentsOf: state), bytes)
        let page = try await existing.pendingPage(); XCTAssertEqual(page.items.first?.id, item.id)
    }

    func testNavigationReservationPreservesOldHeaderThenJoinsStickyClaimAcrossColdOpen() async throws {
        let store = try open(), original = try Data(contentsOf: state)
        XCTAssertNil(try dictionary(state)["navigationReservation"])
        let absent = try await store.navigationReservationID(); XCTAssertNil(absent)
        await failure { _ = try await store.reserveNavigationCapture(id: "INVALID") }
        XCTAssertEqual(try Data(contentsOf: state), original, "Valid old canonical bytes are not rewritten by inspection")
        let unrelated = try await store.capture(event("mindwtr://open/unrelated"))
        let beforeClaim = try Data(contentsOf: state)
        let stillAbsent = try await store.navigationReservationID(); XCTAssertNil(stillAbsent)
        XCTAssertEqual(try Data(contentsOf: state), beforeClaim)
        let claim = UUID().uuidString.lowercased()
        let accepted = try await store.reserveNavigationCapture(id: claim); XCTAssertEqual(accepted, claim)
        let header = try Data(contentsOf: state)
        let joined = try await store.reserveNavigationCapture(id: UUID().uuidString.lowercased()); XCTAssertEqual(joined, claim)
        XCTAssertEqual(try Data(contentsOf: state), header)
        XCTAssertThrowsError(try NativePersonalIntake(route: route, diagnostic: { _ in }), "The reminder/navigation owner shares one lease")
        await store.close()
        let cold = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(cold)
        let retained = try await cold.navigationReservationID(); XCTAssertEqual(retained, claim)
        let reminders = try await cold.requiresReminderPreparation(); XCTAssertFalse(reminders)
        let page = try await cold.pendingPage(); XCTAssertEqual(page.items.map(\.id), [unrelated.id])
        XCTAssertEqual(try Data(contentsOf: state), header)
        // The previous strict reader drops this unknown field when encoding and therefore refuses these bytes.
        var oldReader = try dictionary(state); oldReader.removeValue(forKey: "navigationReservation")
        let previousBytes = try JSONSerialization.data(withJSONObject: oldReader, options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertNotEqual(previousBytes, header, "Old exact-canonical readers cannot read a new claimed header")
    }

    func testNavigationClaimAndReminderCaptureUseOneWriterWithoutChangingLegacyHold() async throws {
        let store = try open(), claim = UUID().uuidString.lowercased()
        _ = try await store.reserveNavigationCapture(id: claim)
        let id = UUID().uuidString.lowercased()
        let payload = String(decoding: try JSONSerialization.data(withJSONObject: ["requestId": id, "taskId": "task"], options: [.sortedKeys]), as: UTF8.self)
        let response = NativeReminderResponse(requestID: id, notificationIdentifier: "mindwtr-native:\(route.namespace):1", action: .complete,
            deliveredAtBits: String(format: "%016llx", Double(100).bitPattern), requestedAtMs: 123, payloadJSON: payload)
        let reminder = try await store.capture(.reminder(response))
        await failure(.legacyHeld) { _ = try await store.markAdmitting(reminder) }
        let navigation = try await store.capture(event())
        XCTAssertEqual(reminder.sequence, 1); XCTAssertEqual(navigation.sequence, 2)
        let retained = try await store.navigationReservationID(); XCTAssertEqual(retained, claim)
        let page = try await store.pendingPage()
        XCTAssertEqual(page.items.map(\.kind), [.reminder, .url])
        XCTAssertTrue(page.items.allSatisfy { $0.stage == .captured })
    }

    func testNavigationReservationLostACKUsesActualRetainedPublicationAndColdClaim() async throws {
        let store = try open(), claim = UUID().uuidString.lowercased()
        await store.setIOFaults(afterPublication: { if $0 == "state.json" { throw Injected.failure } })
        await failure { _ = try await store.reserveNavigationCapture(id: claim) }
        let published = try inode(state)
        await failure(.pendingPublication) { _ = try await store.navigationReservationID() }
        await store.setIOFaults()
        let retried = try await store.reserveNavigationCapture(id: claim); XCTAssertEqual(retried, claim)
        XCTAssertEqual(try inode(state), published, "Lost ACK retries retain the actual header publication")
        await store.close()
        let cold = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(cold)
        let retained = try await cold.navigationReservationID(); XCTAssertEqual(retained, claim)
        let raw = "com.mindwtr.synthetic/\u{FEFF}e\u{301}"
        XCTAssertNotEqual(Data(raw.utf8), Data(raw.precomposedStringWithCanonicalMapping.utf8))
        let first = try NativePersonalIntakeEvent.spotlight(raw, receivedAt: Date(timeIntervalSince1970: 123))
        let captured = try await cold.capture(first)
        XCTAssertEqual(captured.event, first); XCTAssertEqual(captured.stage, .captured)
        XCTAssertEqual(Data(try XCTUnwrap(captured.event?.text).utf8), Data(raw.utf8))
        XCTAssertEqual(captured.receivedAtMs, 123_000)
    }

    func testNavigationReservationPrepublicationRetryAndCorruptUnknownHeadersFailClosed() async throws {
        let store = try open(), claim = UUID().uuidString.lowercased(), old = try Data(contentsOf: state)
        await store.setIOFaults(beforePublication: { if $0 == "state.json" { throw Injected.failure } })
        await failure { _ = try await store.reserveNavigationCapture(id: claim) }
        XCTAssertEqual(try Data(contentsOf: state), old)
        await store.setIOFaults()
        let recovered = try await store.reserveNavigationCapture(id: claim); XCTAssertEqual(recovered, claim)
        await store.close()
        let valid = try dictionary(state)
        for (field, value) in [("navigationReservation", "INVALID"), ("unrecognizedClaim", claim)] {
            var invalid = valid; invalid[field] = value
            let bytes = try JSONSerialization.data(withJSONObject: invalid, options: [.sortedKeys, .withoutEscapingSlashes])
            try bytes.write(to: state)
            XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: route, diagnostic: { _ in }))
            XCTAssertEqual(try Data(contentsOf: state), bytes)
        }
    }

    func testNavigationNoClaimColdPendingIsHeldWithoutRepairWhileExistingClaimStillQuarantines() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(beforePublication: { if $0 == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let pending = try Data(contentsOf: state)
        XCTAssertNotNil(try dictionary(state)["pending"])
        await store.close()
        let cold = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(cold)
        await failure(.pendingPublication) { _ = try await cold.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), pending)
        XCTAssertFalse(FileManager.default.fileExists(atPath: record(first.id).path))
        try await cold.retry()
        let settled = try await cold.navigationReservationID(); XCTAssertNil(settled)
        let page = try await cold.pendingPage()
        XCTAssertEqual(Data(try XCTUnwrap(page.items.first?.event?.text).utf8), Data(try XCTUnwrap(first.text).utf8))
        let claim = UUID().uuidString.lowercased(); _ = try await cold.reserveNavigationCapture(id: claim)
        let second = try event("mindwtr://capture?text=\u{FEFF}e\u{301}")
        await cold.setIOFaults(beforePublication: { if $0 == second.id + ".json" { throw Injected.failure } })
        await failure { _ = try await cold.capture(second) }
        let claimedPending = try Data(contentsOf: state); await cold.close()
        let held = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(held)
        let existingClaim = try await held.navigationReservationID(); XCTAssertEqual(existingClaim, claim)
        XCTAssertEqual(try Data(contentsOf: state), claimedPending, "Claim inspection is quarantine, not pending settlement")
        XCTAssertFalse(FileManager.default.fileExists(atPath: record(second.id).path))
    }

    private func sealedReminderSource() async throws -> (NativeReminderInbox, NativeReminderInbox.Seal) {
        let source = try NativeReminderInbox(selection: route.selection); reminderSources.append(source)
        let id = UUID().uuidString.lowercased()
        let payload = String(decoding: try JSONSerialization.data(withJSONObject: ["requestId": id, "taskId": "task"], options: [.sortedKeys]), as: UTF8.self)
        let response = NativeReminderResponse(requestID: id, notificationIdentifier: "mindwtr-native:\(route.namespace):1", action: .complete,
            deliveredAtBits: String(format: "%016llx", Double(100).bitPattern), requestedAtMs: 123, payloadJSON: payload)
        _ = try await source.capture(response)
        return (source, try await source.sealForPersonalIntake(route: route, diagnostic: { _ in }))
    }

    func testNavigationNoClaimReadsCannotReleaseLiveOrRejectedImportAcknowledgement() async throws {
        let store = try open(), (source, seal) = try await sealedReminderSource()
        let reading = Barrier(), acknowledgement = Barrier()
        await store.setLegacyReadBarrier { await reading.hold() }
        await source.setImportAcknowledgementBarrier { await acknowledgement.hold() }
        let operation = Task { try await source.importSealed(seal, into: store, route: route, diagnostic: { _ in }) }
        await reading.wait()
        let beforeRead = try Data(contentsOf: state)
        await failure(.legacyHeld) { _ = try await store.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), beforeRead)
        await reading.open(); await acknowledgement.wait()
        let beforeACK = try Data(contentsOf: state)
        await failure(.legacyHeld) { _ = try await store.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), beforeACK)
        await failure(.legacyHeld) { _ = try await store.capture(event()) }
        operation.cancel(); await acknowledgement.open()
        await failure { try await operation.value }
        await failure(.legacyHeld) { _ = try await store.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), beforeACK)
        await store.setLegacyReadBarrier(nil); await source.setImportAcknowledgementBarrier(nil)
        try await source.importSealed(seal, into: store, route: route, diagnostic: { _ in })
        let settled = try await store.navigationReservationID(); XCTAssertNil(settled)
        XCTAssertEqual(try Data(contentsOf: state), beforeACK, "Only the original real ACK changes admission, never this read")
    }

    func testNavigationNoClaimIncompleteImportRemainsHeldAcrossExistingOnlyColdOpen() async throws {
        let store = try open(), (source, seal) = try await sealedReminderSource()
        await store.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw Injected.failure } })
        await failure { try await source.importSealed(seal, into: store, route: route, diagnostic: { _ in }) }
        let incomplete = try Data(contentsOf: state)
        await failure { _ = try await store.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), incomplete)
        await store.close()
        let cold = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(cold)
        await failure(.legacyHeld) { _ = try await cold.navigationReservationID() }
        XCTAssertEqual(try Data(contentsOf: state), incomplete)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("legacy-reminder-terminals.json").path))
    }

    func testExistingOnlyMissingHeaderForeignPathAndOrphanTerminalsNeverBecomeEmpty() async throws {
        let original = try open(); await original.close()
        let bytes = try Data(contentsOf: state)
        try FileManager.default.removeItem(at: state)
        XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: route, diagnostic: { _ in }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
        try bytes.write(to: state)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: state.path)
        let terminal = root.appendingPathComponent("legacy-reminder-terminals.json")
        try Data("{}".utf8).write(to: terminal)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: terminal.path)
        let existing = try XCTUnwrap(NativePersonalIntake.openExisting(route: route, diagnostic: { _ in })); stores.append(existing)
        await failure { _ = try await existing.requiresReminderPreparation() }
        XCTAssertEqual(try Data(contentsOf: state), bytes)
        await existing.close()
        let foreign = root.deletingLastPathComponent().appendingPathComponent("foreign-actual-root")
        try FileManager.default.moveItem(at: root, to: foreign)
        try FileManager.default.createSymbolicLink(atPath: root.path, withDestinationPath: foreign.path)
        XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: route, diagnostic: { _ in }))
        XCTAssertEqual(try Data(contentsOf: foreign.appendingPathComponent("state.json")), bytes)
    }

    func testCaptureRestartFirstDuplicateAndContentFreeTerminal() async throws {
        let first = try event(), changed = try event("different later payload", id: XCTUnwrap(UUID(uuidString: first.id)), seconds: 999)
        let store = try open()
        let original = try await store.capture(first)
        let duplicate = try await store.capture(changed)
        XCTAssertEqual(duplicate.event, first); XCTAssertEqual(duplicate.receivedAtMs, first.receivedAtMs)
        XCTAssertEqual(duplicate.sequence, 1)
        await store.close()
        let reopened = try open()
        await failure(.staleItem) { _ = try await reopened.markAdmitting(original) }
        let page = try await reopened.pendingPage()
        let admitted = try await reopened.markAdmitting(XCTUnwrap(page.items.first))
        XCTAssertEqual(admitted.stage, .admitting)
        await failure(.staleItem) { _ = try await reopened.markAdmitting(XCTUnwrap(page.items.first)) }
        try await reopened.finish(admitted, outcome: .completed)
        let settlement = try await reopened.settleFinish(admitted, outcome: .completed)
        XCTAssertEqual(settlement.id, first.id); XCTAssertEqual(settlement.outcome, .completed)
        let terminal = try await reopened.capture(changed)
        XCTAssertEqual(terminal.stage, .terminal); XCTAssertNil(terminal.event)
        XCTAssertEqual(terminal.receivedAtMs, first.receivedAtMs); XCTAssertEqual(terminal.outcome, .completed)
        let bytes = try Data(contentsOf: record(first.id))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("mindwtr://"))
        let final = try await reopened.pendingPage(); XCTAssertEqual(final.scanned, 1); XCTAssertTrue(final.items.isEmpty)
        XCTAssertNil(final.next)
        await reopened.close()
        let again = try open(); let retained = try await again.capture(first)
        XCTAssertEqual(retained.stage, .terminal); XCTAssertEqual(retained.receivedAtMs, first.receivedAtMs)
    }

    func testMoreThan128RecordsAndBoundedScannedFrontierWithoutEviction() async throws {
        let store = try open()
        for index in 0..<145 {
            let item = try await store.capture(event("mindwtr://open/\(index)"))
            if index < 33 { let admitted = try await store.markAdmitting(item); try await store.finish(admitted, outcome: .ignored) }
            let retained = await store.retainedArtifactCount(); XCTAssertEqual(retained, 0)
            let finish = await store.retainedFinishProofCounts()
            XCTAssertLessThanOrEqual(finish.slots, 1); XCTAssertLessThanOrEqual(finish.snapshots, 2)
            XCTAssertEqual(finish.creationDescriptors, 0)
        }
        let first = try await store.pendingPage()
        XCTAssertTrue(first.items.isEmpty); XCTAssertEqual(first.scanned, 32); XCTAssertNotNil(first.next)
        var page = first, count = 0, scanned = 0
        while true {
            XCTAssertLessThanOrEqual(page.scanned, 32); XCTAssertLessThanOrEqual(page.items.count, 32)
            count += page.items.count; scanned += page.scanned
            guard let next = page.next else { break }; page = try await store.pendingPage(after: next)
        }
        XCTAssertEqual(count, 112); XCTAssertEqual(scanned, 145)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("records").path).count, 145)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("order").path).count, 145)
        _ = try await store.capture(event("later"))
        var originalPage = try await store.pendingPage(after: XCTUnwrap(first.next)), originalRemaining = 0
        while true {
            originalRemaining += originalPage.items.count
            XCTAssertTrue(originalPage.items.allSatisfy { $0.sequence <= 145 })
            guard let next = originalPage.next else { break }; originalPage = try await store.pendingPage(after: next)
        }
        XCTAssertEqual(originalRemaining, 112)
        var fresh = try await store.pendingPage(), freshCount = 0
        while true {
            freshCount += fresh.items.count
            guard let next = fresh.next else { break }; fresh = try await store.pendingPage(after: next)
        }
        XCTAssertEqual(freshCount, 113)
        await store.close(); let reopened = try open()
        await failure(.staleItem) { _ = try await reopened.pendingPage(after: XCTUnwrap(first.next)) }
    }

    func testReservedAbsentRecordColdRetryKeepsOriginalPayloadClockAndSequence() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(beforePublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: record(first.id).path))
        XCTAssertEqual((try dictionary(state)["nextSequence"] as? NSNumber)?.intValue, 2)
        await failure(.pendingPublication) { _ = try await store.capture(event("unrelated")) }
        await store.close()
        let reopened = try open()
        try await reopened.retry()
        let changed = try event("changed", id: XCTUnwrap(UUID(uuidString: first.id)), seconds: 999)
        let accepted = try await reopened.capture(changed)
        XCTAssertEqual(accepted.event, first); XCTAssertEqual(accepted.sequence, 1)
        XCTAssertNil(try dictionary(state)["pending"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("order").path).count, 1)
    }

    func testActualRecordLostACKHotRetryUsesRetainedCreationIdentity() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let published = try inode(record(first.id))
        await store.setIOFaults()
        try await store.retry()
        XCTAssertEqual(try inode(record(first.id)), published)
        let accepted = try await store.capture(first); XCTAssertEqual(accepted.event, first); XCTAssertEqual(accepted.sequence, 1)
    }

    func testColdUnwitnessedExistingRecordIsHeldEvenWithExactBytes() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let reserved = try Data(contentsOf: state), bytes = try Data(contentsOf: record(first.id))
        await store.close()
        let reopened = try open()
        await failure(.ambiguousPublication) { try await reopened.retry() }
        await failure(.ambiguousPublication) { _ = try await reopened.capture(first) }
        XCTAssertEqual(try Data(contentsOf: state), reserved); XCTAssertEqual(try Data(contentsOf: record(first.id)), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: slot(1).path))
    }

    func testSameByteForeignRecordAfterLostACKCannotBeAdopted() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let foreign = try replacement(record(first.id)), reserved = try Data(contentsOf: state)
        await store.setIOFaults()
        await failure(.unavailable) { try await store.retry() }
        XCTAssertEqual(try inode(record(first.id)), foreign); XCTAssertEqual(try Data(contentsOf: state), reserved)
    }

    func testColdPersistedRecordWitnessRejectsReplacementAndAbsentOrderCanRecover() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(beforePublication: { name in if name == "0000000000000001.json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let pending = try XCTUnwrap(try dictionary(state)["pending"] as? [String: Any])
        XCTAssertNotNil(pending["recordWitness"]); XCTAssertNil(pending["orderWitness"])
        await store.close()
        let reopened = try open(); try await reopened.retry()
        let accepted = try await reopened.capture(first); XCTAssertEqual(accepted.sequence, 1)
        await reopened.close()
        // A second independent reservation retains a persisted record witness across the cold boundary.
        let nextStore = try open(), second = try event()
        await nextStore.setIOFaults(beforePublication: { name in if name == "0000000000000002.json" { throw Injected.failure } })
        await failure { _ = try await nextStore.capture(second) }; await nextStore.close()
        let foreign = try replacement(record(second.id)), reserved = try Data(contentsOf: state)
        let held = try open(); await failure(.unavailable) { try await held.retry() }
        XCTAssertEqual(try inode(record(second.id)), foreign); XCTAssertEqual(try Data(contentsOf: state), reserved)
    }

    func testOrderLostACKColdIsHeld() async throws {
        let store = try open(), first = try event()
        await store.setIOFaults(afterPublication: { name in if name == "0000000000000001.json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        let reserved = try Data(contentsOf: state)
        await store.close(); let reopened = try open()
        await failure(.ambiguousPublication) { try await reopened.retry() }
        XCTAssertEqual(try Data(contentsOf: state), reserved)
    }

    func testAdmittingAndTerminalLostACKRetainExactOwnerAndReleaseBoundedWitnesses() async throws {
        let diagnostics = Diagnostics(), first = try event()
        let store = try open { diagnostics.receive($0) }
        let original = try await store.capture(first)
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.markAdmitting(original) }
        await failure(.pendingPublication) { _ = try await store.pendingPage() }
        await store.setIOFaults(); try await store.retry()
        XCTAssertEqual(diagnostics.events.count, 1)
        let retained = await store.retainedArtifactCount(); XCTAssertEqual(retained, 0)
        await failure(.staleItem) { _ = try await store.markAdmitting(original) }
        let page = try await store.pendingPage(), admitting = try XCTUnwrap(page.items.first)
        XCTAssertEqual(admitting.stage, .admitting)
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { try await store.finish(admitting, outcome: .completed) }
        await store.setIOFaults(); try await store.retry()
        XCTAssertEqual(diagnostics.events.count, 1)
        let cleared = await store.retainedArtifactCount(); XCTAssertEqual(cleared, 0)
        let terminal = try await store.settleFinish(admitting, outcome: .completed)
        XCTAssertEqual(terminal.id, first.id); XCTAssertEqual(terminal.receivedAtMs, first.receivedAtMs)
        XCTAssertEqual(terminal.sequence, admitting.sequence); XCTAssertEqual(terminal.outcome, .completed)
        XCTAssertEqual(diagnostics.events.filter { $0.operation == "capture" }.count, 1)
    }

    private struct FinishContext: Sendable {
        let store: NativePersonalIntake
        let route: NativePersonalIntakeRoute
        let root: URL
        let event: NativePersonalIntakeEvent
        let captured: NativePersonalIntake.Item
        let admitting: NativePersonalIntake.Item
        var record: URL { root.appendingPathComponent("records/\(event.id).json") }
        var order: URL { root.appendingPathComponent("order/0000000000000001.json") }
        var header: URL { root.appendingPathComponent("state.json") }
    }
    private struct FinishFileEvidence: Equatable {
        let witness: IntakeFileWitness
        let bytes: Data
    }
    private func finishContext(input: NativePersonalIntakeEvent? = nil, spotlight: Bool = false,
                               sink: @escaping NativePersonalIntake.DiagnosticSink = { _ in }) async throws -> FinishContext {
        let finishHome = home.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
            .appendingPathComponent("home", isDirectory: true)
        finishHomes.append(finishHome)
        try FileManager.default.createDirectory(at: finishHome, withIntermediateDirectories: true)
        let route = try NativePersonalIntakeRoute.fixture(home: finishHome)
        let store = try NativePersonalIntake(route: route, diagnostic: sink); stores.append(store)
        let event = try input ?? (spotlight ? NativePersonalIntakeEvent.spotlight("private-e\u{301}-🧠", receivedAt: Date(timeIntervalSince1970: 123)) : self.event())
        let captured = try await store.capture(event), admitting = try await store.markAdmitting(captured)
        return .init(store: store, route: route, root: route.components.reduce(finishHome) { $0.appendingPathComponent($1) },
                     event: event, captured: captured, admitting: admitting)
    }
    private func finishEvidence(_ root: URL) throws -> [String: FinishFileEvidence] {
        let names = try XCTUnwrap(FileManager.default.enumerator(atPath: root.path))
        var result: [String: FinishFileEvidence] = [:]
        for case let name as String in names {
            let path = root.appendingPathComponent(name); var value = stat()
            guard lstat(path.path, &value) == 0 else { throw Injected.failure }
            if value.st_mode & S_IFMT == S_IFDIR { continue }
            XCTAssertEqual(value.st_mode & S_IFMT, S_IFREG)
            result[name] = .init(witness: .init(value), bytes: try Data(contentsOf: path))
        }
        return result
    }
    private func assertFinish(_ receipt: NativePersonalIntake.FinishSettlement, _ context: FinishContext,
                              _ outcome: NativePersonalIntake.Outcome, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(receipt.id, context.event.id, file: file, line: line)
        XCTAssertEqual(receipt.kind, context.event.kind, file: file, line: line)
        XCTAssertEqual(receipt.receivedAtMs, context.event.receivedAtMs, file: file, line: line)
        XCTAssertEqual(receipt.sequence, context.admitting.sequence, file: file, line: line)
        XCTAssertEqual(receipt.outcome, outcome, file: file, line: line)
    }
    private func openDescriptorCount() -> Int {
        var count = 0
        for fd in 0..<getdtablesize() { if fcntl(fd, F_GETFD) >= 0 { count += 1 } }
        return count
    }

    private func assertSubmission(_ actual: NativePersonalIntake.FinishSubmission,
                                  _ expected: NativePersonalIntake.FinishSubmission,
                                  file: StaticString = #filePath, line: UInt = #line) {
        switch (actual, expected) {
        case (.submitted, .submitted), (.notSubmitted, .notSubmitted): break
        default: XCTFail("Unexpected finish submission: \(actual)", file: file, line: line)
        }
    }

    func testFinishSubmissionBlockedByPendingCaptureDoesNotAcceptOrProgressFinish() async throws {
        let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
        let later = try event("unrelated pending capture")
        await context.store.setIOFaults(afterPublication: { if $0 == later.id + ".json" { throw Injected.failure } })
        await failure { _ = try await context.store.capture(later) }
        let pending = try finishEvidence(context.root), hot = await context.store.retainedArtifactCount()
        await context.store.setIOFaults()
        for _ in 0..<2 {
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .notSubmitted)
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
            XCTAssertEqual(try finishEvidence(context.root), pending)
            let proof = await context.store.retainedFinishProofCounts(), retained = await context.store.retainedArtifactCount()
            XCTAssertEqual(proof.slots, 0); XCTAssertEqual(proof.snapshots, 0); XCTAssertEqual(retained, hot)
            XCTAssertEqual(diagnostics.events.count, 1)
        }
        try await context.store.retry()
        let captured = try await context.store.capture(later)
        XCTAssertEqual(captured.event, later); XCTAssertEqual(captured.receivedAtMs, later.receivedAtMs)
        XCTAssertEqual(captured.sequence, context.admitting.sequence + 1)
        XCTAssertEqual(try dictionary(context.record)["stage"] as? String, "admitting")
        XCTAssertTrue(diagnostics.events.filter { $0.operation == "finish-settlement" }.isEmpty)
    }

    func testFinishSubmissionLostACKIsSubmittedAndDuplicateCannotRetryBeforeExactSettlement() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
            await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            let published = try finishEvidence(context.root), created = try inode(context.record)
            let pending = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(pending.slots, 1); XCTAssertEqual(pending.creationDescriptors, 1)
            XCTAssertEqual(diagnostics.events.count, 1)
            await context.store.setIOFaults()
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            XCTAssertEqual(try finishEvidence(context.root), published)
            let unchanged = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(unchanged.snapshots, 3); XCTAssertEqual(unchanged.creationDescriptors, 1)
            XCTAssertEqual(diagnostics.events.count, 1, "Submission is not a finish receipt")
            assertFinish(try await context.store.settleFinish(context.admitting, outcome: outcome), context, outcome)
            _ = try await context.store.settleFinish(context.admitting, outcome: outcome)
            XCTAssertEqual(try inode(context.record), created); XCTAssertEqual(try finishEvidence(context.root), published)
            XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 1)
        }
    }

    func testFinishSubmissionBeforePublicationStillRetainsIntentWithoutPublishingBytes() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
            let before = try finishEvidence(context.root)
            await context.store.setIOFaults(beforePublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            XCTAssertEqual(try finishEvidence(context.root), before)
            let pending = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(pending.slots, 1); XCTAssertEqual(pending.snapshots, 3); XCTAssertEqual(pending.creationDescriptors, 0)
            await context.store.setIOFaults()
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            XCTAssertEqual(try finishEvidence(context.root), before)
            XCTAssertEqual(diagnostics.events.count, 1)
            assertFinish(try await context.store.settleFinish(context.admitting, outcome: outcome), context, outcome)
            XCTAssertEqual(try dictionary(context.record)["stage"] as? String, "terminal")
            XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 1)
        }
    }

    func testFinishSubmissionNormalDuplicateIsReadOnlyAndWrongOutcomeGrantsNoReceipt() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            let terminal = try finishEvidence(context.root)
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            let wrong: NativePersonalIntake.Outcome = outcome == .completed ? .ignored : .completed
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: wrong), .notSubmitted)
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: wrong) }
            XCTAssertEqual(try finishEvidence(context.root), terminal); XCTAssertEqual(diagnostics.events.count, 1)
            assertFinish(try await context.store.settleFinish(context.admitting, outcome: outcome), context, outcome)
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: outcome), .submitted)
            _ = try await context.store.settleFinish(context.admitting, outcome: outcome)
            XCTAssertEqual(try finishEvidence(context.root), terminal)
            XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 1)
        }
    }

    func testFinishSubmissionRejectsForeignAndConflictingItemsButAllowsLaterFinishAndEvictsHistory() async throws {
        let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
        let later = try await context.store.capture(event("later navigation"))
        let laterAdmitting = try await context.store.markAdmitting(later), foreign = try await finishContext(input: context.event)
        let initial = try finishEvidence(context.root), foreignFiles = try finishEvidence(foreign.root)
        for wrong in [context.captured, later, foreign.admitting] {
            assertSubmission(await context.store.submitFinish(wrong, outcome: .completed), .notSubmitted)
            await failure(.staleItem) { _ = try await context.store.settleFinish(wrong, outcome: .completed) }
        }
        XCTAssertEqual(try finishEvidence(context.root), initial)
        await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
        assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .submitted)
        let pending = try finishEvidence(context.root)
        await context.store.setIOFaults()
        assertSubmission(await context.store.submitFinish(laterAdmitting, outcome: .ignored), .notSubmitted)
        assertSubmission(await context.store.submitFinish(context.admitting, outcome: .ignored), .notSubmitted)
        assertSubmission(await foreign.store.submitFinish(context.admitting, outcome: .completed), .notSubmitted)
        await failure(.staleItem) { _ = try await context.store.settleFinish(laterAdmitting, outcome: .ignored) }
        XCTAssertEqual(try finishEvidence(context.root), pending); XCTAssertEqual(try finishEvidence(foreign.root), foreignFiles)
        let retained = await context.store.retainedFinishProofCounts(), foreignProof = await foreign.store.retainedFinishProofCounts()
        XCTAssertEqual(retained.creationDescriptors, 1); XCTAssertEqual(foreignProof.slots, 0)
        XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 0)
        assertFinish(try await context.store.settleFinish(context.admitting, outcome: .completed), context, .completed)
        assertSubmission(await context.store.submitFinish(laterAdmitting, outcome: .ignored), .submitted)
        let terminal = try finishEvidence(context.root)
        assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .notSubmitted)
        await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
        XCTAssertEqual(try finishEvidence(context.root), terminal, "Evicted history cannot authorize another write")
        let receipt = try await context.store.settleFinish(laterAdmitting, outcome: .ignored)
        XCTAssertEqual(receipt.id, later.id); XCTAssertEqual(receipt.sequence, later.sequence); XCTAssertEqual(receipt.outcome, .ignored)
        let bounded = await context.store.retainedFinishProofCounts()
        XCTAssertEqual(bounded.slots, 1); XCTAssertEqual(bounded.snapshots, 2); XCTAssertEqual(bounded.creationDescriptors, 0)
        XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 2)
    }

    func testFinishSubmissionMatchingReplacedGenerationStaysSubmittedWithoutReceipt() async throws {
        for pending in [false, true] {
            let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
            if pending { await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } }) }
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .submitted)
            await context.store.setIOFaults()
            _ = try replacement(context.record)
            let replaced = try finishEvidence(context.root)
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .submitted)
            await failure(.unavailable) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .submitted)
            XCTAssertEqual(try finishEvidence(context.root), replaced)
            XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 0)
        }
    }

    func testFinishSubmissionCancelledQueuedCallerAndCloseCannotProduceReceipt() async throws {
        for closeBeforeSubmission in [false, true] {
            let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
            let queued = Barrier(), before = try finishEvidence(context.root)
            await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            let operation = Task {
                await queued.hold()
                return await context.store.submitFinish(context.admitting, outcome: .completed)
            }
            await queued.wait(); operation.cancel()
            if closeBeforeSubmission { await context.store.close() }
            await queued.open()
            let submission = await operation.value
            assertSubmission(submission, closeBeforeSubmission ? .notSubmitted : .submitted)
            XCTAssertTrue(operation.isCancelled)
            if closeBeforeSubmission { XCTAssertEqual(try finishEvidence(context.root), before) }
            else {
                let pending = await context.store.retainedFinishProofCounts()
                XCTAssertEqual(pending.slots, 1); XCTAssertEqual(pending.creationDescriptors, 1)
            }
            let retained = try finishEvidence(context.root)
            await context.store.close()
            assertSubmission(await context.store.submitFinish(context.admitting, outcome: .completed), .notSubmitted)
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
            XCTAssertEqual(try finishEvidence(context.root), retained)
            let closed = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(closed.slots, 0); XCTAssertEqual(closed.snapshots, 0)
            XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 0)
        }
    }

    func testFinishSettlementIsExactContentFreeReadOnlyAndOnceDiagnosticForBothOutcomes() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let diagnostics = Diagnostics(), context = try await finishContext(spotlight: outcome == .ignored) { diagnostics.receive($0) }
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: outcome) }
            let capturedFiles = try finishEvidence(context.root)
            XCTAssertEqual(diagnostics.events.count, 1)
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.captured, outcome: outcome) }
            XCTAssertEqual(try finishEvidence(context.root), capturedFiles)
            try await context.store.finish(context.admitting, outcome: outcome)
            XCTAssertEqual(diagnostics.events.count, 1, "Only explicit exact settlement emits its confirmation")
            let terminalFiles = try finishEvidence(context.root)
            let receipt = try await context.store.settleFinish(context.admitting, outcome: outcome)
            assertFinish(receipt, context, outcome)
            _ = try await context.store.settleFinish(context.admitting, outcome: outcome)
            XCTAssertEqual(try finishEvidence(context.root), terminalFiles, "Confirmation must not rewrite any file")
            let terminal = try dictionary(context.record)
            XCTAssertEqual(terminal["stage"] as? String, "terminal"); XCTAssertNil(terminal["event"])
            XCTAssertFalse(String(decoding: try Data(contentsOf: context.record), as: UTF8.self).contains("private-e"))
            let marker = try XCTUnwrap(diagnostics.events.last)
            XCTAssertEqual(diagnostics.events.count, 2)
            XCTAssertEqual(marker.message, "Native iOS navigation finish settlement confirmed")
            XCTAssertEqual(marker.releaseCheck, "v1.3.9/ios-navigation-finish-settlement")
            XCTAssertEqual(marker.operation, "finish-settlement"); XCTAssertEqual(marker.outcome, outcome.rawValue)
            let fields = Mirror(reflecting: marker).children.compactMap { $0.label }
            XCTAssertEqual(Set(fields), ["message", "releaseCheck", "operation", "outcome"])
            await context.store.close()
        }
    }

    func testFinishBeforePublicationFaultRetainsAdmittingWitnessUntilExactSettlement() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let context = try await finishContext(), before = try finishEvidence(context.root)
            await context.store.setIOFaults(beforePublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            await failure { try await context.store.finish(context.admitting, outcome: outcome) }
            await failure { _ = try await context.store.settleFinish(context.admitting, outcome: outcome) }
            XCTAssertEqual(try finishEvidence(context.root), before)
            let pending = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(pending.slots, 1); XCTAssertEqual(pending.snapshots, 3); XCTAssertEqual(pending.creationDescriptors, 0)
            await context.store.setIOFaults()
            assertFinish(try await context.store.settleFinish(context.admitting, outcome: outcome), context, outcome)
            XCTAssertNotEqual(try inode(context.record), try XCTUnwrap(before["records/\(context.event.id).json"]).witness.identity.inode)
            await context.store.close()
        }
    }

    func testFinishLostACKDirectAndGenericRetryTransferTheOriginalCreatedInode() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            for genericRetry in [false, true] {
                let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
                await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
                await failure { try await context.store.finish(context.admitting, outcome: outcome) }
                let terminal = try finishEvidence(context.root), published = try inode(context.record)
                for _ in 0..<2 {
                    await failure { _ = try await context.store.settleFinish(context.admitting, outcome: outcome) }
                    XCTAssertEqual(try finishEvidence(context.root), terminal)
                    XCTAssertEqual(diagnostics.events.count, 1, "Continuing checkpoint uncertainty cannot emit settlement")
                }
                let pending = await context.store.retainedFinishProofCounts()
                XCTAssertEqual(pending.creationDescriptors, 1)
                await context.store.setIOFaults()
                if genericRetry { try await context.store.retry() }
                let receipt = try await context.store.settleFinish(context.admitting, outcome: outcome)
                assertFinish(receipt, context, outcome)
                XCTAssertEqual(try inode(context.record), published); XCTAssertEqual(try finishEvidence(context.root), terminal)
                XCTAssertEqual(diagnostics.events.filter { $0.operation == "capture" }.count, 1)
                XCTAssertEqual(diagnostics.events.filter { $0.operation == "finish-settlement" }.count, 1)
                let counts = await context.store.retainedFinishProofCounts(), hot = await context.store.retainedArtifactCount()
                XCTAssertEqual(counts.slots, 1); XCTAssertEqual(counts.snapshots, 2); XCTAssertEqual(counts.creationDescriptors, 0); XCTAssertEqual(hot, 0)
                await context.store.close()
            }
        }
    }

    func testFinishWrongItemOutcomeAndForeignOwnerCannotProgressThePendingAttempt() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let context = try await finishContext(), other = try await context.store.capture(event("another"))
            let otherAdmitting = try await context.store.markAdmitting(other), foreign = try await finishContext(input: context.event)
            await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            await failure { try await context.store.finish(context.admitting, outcome: outcome) }
            await foreign.store.setIOFaults(afterPublication: { if $0 == foreign.event.id + ".json" { throw Injected.failure } })
            await failure { try await foreign.store.finish(foreign.admitting, outcome: .ignored) }
            let pending = try finishEvidence(context.root), foreignBefore = try finishEvidence(foreign.root)
            await context.store.setIOFaults(); await foreign.store.setIOFaults()
            await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: outcome == .completed ? .ignored : .completed) }
            for wrong in [context.captured, otherAdmitting, foreign.admitting] {
                await failure(.staleItem) { _ = try await context.store.settleFinish(wrong, outcome: outcome) }
            }
            await failure(.pendingPublication) { try await context.store.finish(otherAdmitting, outcome: .ignored) }
            await failure(.staleItem) { _ = try await foreign.store.settleFinish(context.admitting, outcome: outcome) }
            XCTAssertEqual(try finishEvidence(context.root), pending); XCTAssertEqual(try finishEvidence(foreign.root), foreignBefore)
            let stillPending = await context.store.retainedFinishProofCounts(); XCTAssertEqual(stillPending.creationDescriptors, 1)
            let foreignPending = await foreign.store.retainedFinishProofCounts(); XCTAssertEqual(foreignPending.creationDescriptors, 1)
            assertFinish(try await context.store.settleFinish(context.admitting, outcome: outcome), context, outcome)
            assertFinish(try await foreign.store.settleFinish(foreign.admitting, outcome: .ignored), foreign, .ignored)
            await context.store.close(); await foreign.store.close()
        }
    }

    func testFinishSameByteTerminalAndOrderReplacementsRefuseBeforeAndAfterGenericRetry() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            for genericRetry in [false, true] {
                for replaceOrder in [false, true] {
                    let diagnostics = Diagnostics(), context = try await finishContext { diagnostics.receive($0) }
                    await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
                    await failure { try await context.store.finish(context.admitting, outcome: outcome) }
                    await context.store.setIOFaults()
                    if genericRetry { try await context.store.retry() }
                    let target = replaceOrder ? context.order : context.record, original = try Data(contentsOf: target)
                    let foreign = try replacement(target), retained = try finishEvidence(context.root)
                    await failure(.unavailable) { _ = try await context.store.settleFinish(context.admitting, outcome: outcome) }
                    XCTAssertEqual(try inode(target), foreign); XCTAssertEqual(try Data(contentsOf: target), original)
                    XCTAssertEqual(try finishEvidence(context.root), retained)
                    XCTAssertEqual(diagnostics.events.count, 1)
                    await context.store.close()
                }
            }
        }
    }

    func testFinishPrepublicationAdmittingReplacementIsNotOverwritten() async throws {
        for outcome in [NativePersonalIntake.Outcome.completed, .ignored] {
            let context = try await finishContext()
            await context.store.setIOFaults(beforePublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
            await failure { try await context.store.finish(context.admitting, outcome: outcome) }
            let foreign = try replacement(context.record), retained = try finishEvidence(context.root)
            await context.store.setIOFaults()
            await failure(.unavailable) { _ = try await context.store.settleFinish(context.admitting, outcome: outcome) }
            XCTAssertEqual(try inode(context.record), foreign); XCTAssertEqual(try finishEvidence(context.root), retained)
            await context.store.close()
        }
    }

    func testFinishHeaderLockAndRootSubstitutionsCannotAuthorizeRetryOrConfirmation() async throws {
        for pending in [false, true] {
            for substitution in ["header", "lock", "root"] {
                let context = try await finishContext()
                if pending { await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } }) }
                if pending { await failure { try await context.store.finish(context.admitting, outcome: .completed) } }
                else { try await context.store.finish(context.admitting, outcome: .completed) }
                await context.store.setIOFaults()
                if substitution == "root" {
                    let moved = context.root.deletingLastPathComponent().appendingPathComponent("retained-original-root")
                    try FileManager.default.moveItem(at: context.root, to: moved)
                    try FileManager.default.copyItem(at: moved, to: context.root)
                } else { _ = try replacement(substitution == "header" ? context.header : context.root.appendingPathComponent(".lock")) }
                let retained = try finishEvidence(context.root)
                await failure(.unavailable) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
                XCTAssertEqual(try finishEvidence(context.root), retained)
                await context.store.close()
            }
        }
    }

    func testFinishCloseAndReopenNeverReconstructOriginalOwnerReceipt() async throws {
        for phase in ["before", "after", "settled"] {
            let context = try await finishContext()
            XCTAssertThrowsError(try NativePersonalIntake(route: context.route, diagnostic: { _ in }))
            if phase == "before" { await context.store.setIOFaults(beforePublication: { if $0 == context.event.id + ".json" { throw Injected.failure } }) }
            if phase == "after" { await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } }) }
            if phase != "settled" { await failure { try await context.store.finish(context.admitting, outcome: .ignored) } }
            else { try await context.store.finish(context.admitting, outcome: .ignored) }
            let retained = try finishEvidence(context.root)
            await context.store.close()
            let released = await context.store.retainedFinishProofCounts(); XCTAssertEqual(released.slots, 0); XCTAssertEqual(released.snapshots, 0)
            await failure { _ = try await context.store.settleFinish(context.admitting, outcome: .ignored) }
            let reopened = try NativePersonalIntake(route: context.route, diagnostic: { _ in }); stores.append(reopened)
            await failure(.staleItem) { _ = try await reopened.settleFinish(context.admitting, outcome: .ignored) }
            XCTAssertEqual(try finishEvidence(context.root), retained)
            let page = try await reopened.pendingPage()
            if phase == "before" { XCTAssertEqual(page.items.first?.stage, .admitting) }
            else { XCTAssertTrue(page.items.isEmpty) }
            await reopened.close()
        }
    }

    func testFinishGenericRetrySurvivesNewCaptureAndOnlyValidLaterFinishReplacesSlot() async throws {
        let context = try await finishContext()
        await context.store.setIOFaults(afterPublication: { if $0 == context.event.id + ".json" { throw Injected.failure } })
        await failure { try await context.store.finish(context.admitting, outcome: .completed) }
        await context.store.setIOFaults()
        let claim = UUID().uuidString.lowercased()
        let reserved = try await context.store.reserveNavigationCapture(id: claim); XCTAssertEqual(reserved, claim)
        let next = try await context.store.capture(event()), nextAdmitting = try await context.store.markAdmitting(next)
        XCTAssertNotEqual(next.id, context.event.id); XCTAssertEqual(next.sequence, context.admitting.sequence + 1)
        await failure(.staleItem) { try await context.store.finish(next, outcome: .ignored) }
        assertFinish(try await context.store.settleFinish(context.admitting, outcome: .completed), context, .completed)
        let original = try finishEvidence(context.root)
        _ = try await context.store.settleFinish(context.admitting, outcome: .completed)
        XCTAssertEqual(try finishEvidence(context.root), original)
        try await context.store.finish(nextAdmitting, outcome: .ignored)
        await failure(.staleItem) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
        let settled = try await context.store.settleFinish(nextAdmitting, outcome: .ignored)
        XCTAssertEqual(settled.id, next.id); XCTAssertEqual(settled.receivedAtMs, next.receivedAtMs)
    }

    func testFinishSettlementHoldsUnrelatedPendingCaptureWithoutSettlingItsWrite() async throws {
        let context = try await finishContext(); try await context.store.finish(context.admitting, outcome: .completed)
        let later = try event("later capture")
        await context.store.setIOFaults(afterPublication: { if $0 == later.id + ".json" { throw Injected.failure } })
        await failure { _ = try await context.store.capture(later) }
        let pending = try finishEvidence(context.root)
        await context.store.setIOFaults()
        await failure(.pendingPublication) { _ = try await context.store.settleFinish(context.admitting, outcome: .completed) }
        XCTAssertEqual(try finishEvidence(context.root), pending)
        try await context.store.retry()
        assertFinish(try await context.store.settleFinish(context.admitting, outcome: .completed), context, .completed)
    }

    func testFinishSequentialFailuresKeepOneSlotAndCloseReleasesEveryProof() async throws {
        let context = try await finishContext()
        let baselineDescriptors = openDescriptorCount()
        var previous = context.admitting
        for index in 0..<24 {
            let item: NativePersonalIntake.Item
            if index == 0 { item = context.admitting }
            else {
                let captured = try await context.store.capture(event("sequence-\(index)"))
                item = try await context.store.markAdmitting(captured)
            }
            let outcome: NativePersonalIntake.Outcome = index.isMultiple(of: 2) ? .completed : .ignored
            if index.isMultiple(of: 3) {
                await context.store.setIOFaults(beforePublication: { if $0 == item.id + ".json" { throw Injected.failure } })
            } else {
                await context.store.setIOFaults(afterPublication: { if $0 == item.id + ".json" { throw Injected.failure } })
            }
            await failure { try await context.store.finish(item, outcome: outcome) }
            let pending = await context.store.retainedFinishProofCounts()
            XCTAssertEqual(pending.slots, 1); XCTAssertEqual(pending.snapshots, 3); XCTAssertLessThanOrEqual(pending.creationDescriptors, 1)
            if index == 23 { XCTAssertLessThanOrEqual(openDescriptorCount(), baselineDescriptors + 4) }
            await context.store.setIOFaults(); try await context.store.retry()
            let receipt = try await context.store.settleFinish(item, outcome: outcome)
            XCTAssertEqual(receipt.id, item.id); XCTAssertEqual(receipt.sequence, item.sequence)
            if index > 0 { await failure(.staleItem) { _ = try await context.store.settleFinish(previous, outcome: outcome) } }
            previous = item
            let settled = await context.store.retainedFinishProofCounts(), hot = await context.store.retainedArtifactCount()
            XCTAssertEqual(settled.slots, 1); XCTAssertEqual(settled.snapshots, 2); XCTAssertEqual(settled.creationDescriptors, 0); XCTAssertEqual(hot, 0)
        }
        XCTAssertLessThanOrEqual(openDescriptorCount(), baselineDescriptors + 3, "Repeated slot replacement must release prior descriptors")
        await context.store.close()
        let closed = await context.store.retainedFinishProofCounts(); XCTAssertEqual(closed.slots, 0); XCTAssertEqual(closed.snapshots, 0)
        XCTAssertLessThanOrEqual(openDescriptorCount(), baselineDescriptors)
    }

    func testFinalHeaderClearLostACKMustSettleBeforeDuplicateACK() async throws {
        let diagnostics = Diagnostics(), first = try event()
        let store = try open { diagnostics.receive($0) }
        var headerWrites = 0
        await store.setIOFaults(afterPublication: { name in
            if name == "state.json" { headerWrites += 1; if headerWrites == 4 { throw Injected.failure } }
        })
        await failure { _ = try await store.capture(first) }
        XCTAssertTrue(diagnostics.events.isEmpty)
        XCTAssertNil(try dictionary(state)["pending"])
        await failure(.pendingPublication) { _ = try await store.capture(first) }
        await store.setIOFaults(); try await store.retry()
        XCTAssertEqual(diagnostics.events.count, 1)
        let accepted = try await store.capture(first); XCTAssertEqual(accepted.sequence, 1); XCTAssertEqual(accepted.event, first)
        XCTAssertEqual(diagnostics.events.count, 1)
    }

    func testValueFreeDiagnosticOnlyFollowsSettledCapture() async throws {
        let diagnostics = Diagnostics(), first = try event()
        let store = try open { diagnostics.receive($0) }
        await store.setIOFaults(afterPublication: { name in if name == first.id + ".json" { throw Injected.failure } })
        await failure { _ = try await store.capture(first) }
        XCTAssertTrue(diagnostics.events.isEmpty)
        await store.setIOFaults(); try await store.retry()
        let marker = try XCTUnwrap(diagnostics.events.first)
        XCTAssertEqual(diagnostics.events.count, 1)
        XCTAssertEqual(marker.message, "Native iOS personal intake capture confirmed")
        XCTAssertEqual(marker.releaseCheck, "v1.3.9/ios-personal-intake")
        XCTAssertEqual(marker.operation, "capture"); XCTAssertEqual(marker.outcome, "confirmed")
        _ = try await store.capture(first); XCTAssertEqual(diagnostics.events.count, 1)
    }

    #if os(iOS)
    func testActualIOSProtectionClassSurvivesPublicationAndTransition() async throws {
        let store = try open(), first = try event()
        let captured = try await store.capture(first)
        func protection(_ url: URL) throws -> Int32 {
            let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw Injected.failure }; defer { Darwin.close(fd) }
            let value = fcntl(fd, F_GETPROTECTIONCLASS)
            guard value >= 0 else { throw Injected.failure }; return value
        }
        let inherited = try protection(root.appendingPathComponent(".lock"))
        XCTAssertEqual(try protection(state), inherited)
        XCTAssertEqual(try protection(record(first.id)), inherited)
        XCTAssertEqual(try protection(slot(1)), inherited)
        let admitting = try await store.markAdmitting(captured)
        XCTAssertEqual(try protection(record(first.id)), inherited)
        try await store.finish(admitting, outcome: .completed)
        let terminalInode = try inode(record(first.id))
        _ = try await store.settleFinish(admitting, outcome: .completed)
        XCTAssertEqual(try inode(record(first.id)), terminalInode)
        XCTAssertEqual(try protection(record(first.id)), inherited)
    }
    #endif

    func testReminderGrammarAndIdentityReusedButUnsealedLegacyAlwaysHeld() async throws {
        let id = UUID().uuidString.lowercased()
        let payload = String(decoding: try JSONSerialization.data(withJSONObject: ["requestId": id, "taskId": "task"], options: [.sortedKeys]), as: UTF8.self)
        let response = NativeReminderResponse(requestID: id, notificationIdentifier: "mindwtr-native:\(route.namespace):1", action: .complete,
            deliveredAtBits: String(format: "%016llx", Double(100).bitPattern), requestedAtMs: 123, payloadJSON: payload)
        let store = try open(); let captured = try await store.capture(.reminder(response))
        let accepted = try Data(contentsOf: state)
        await failure(.legacyHeld) { _ = try await store.markAdmitting(captured) }
        await failure(.staleItem) { _ = try await store.settleFinish(captured, outcome: .completed) }
        XCTAssertEqual(try Data(contentsOf: state), accepted)
        await failure(.unavailable) { _ = try await store.capture(event("cross kind", id: XCTUnwrap(UUID(uuidString: id)))) }
        let malformed = NativeReminderResponse(requestID: UUID().uuidString.lowercased(), notificationIdentifier: response.notificationIdentifier,
            action: .complete, deliveredAtBits: response.deliveredAtBits, requestedAtMs: 123, payloadJSON: payload)
        await failure { _ = try await store.capture(.reminder(malformed)) }
        await store.close(); let reopened = try open(); let page = try await reopened.pendingPage()
        await failure(.legacyHeld) { _ = try await reopened.markAdmitting(XCTUnwrap(page.items.first)) }
        XCTAssertEqual(page.items.first?.event?.response, response)
    }

    func testForeignRootLockHeaderAndRecordCorruptionRefuseWithoutRepair() async throws {
        let store = try open(), first = try event(); _ = try await store.capture(first)
        // Concurrent owner cannot acquire the original route lease.
        XCTAssertThrowsError(try NativePersonalIntake(route: route, diagnostic: { _ in }))
        let original = try Data(contentsOf: state), foreign = try replacement(state)
        await failure(.unavailable) { _ = try await store.pendingPage() }
        XCTAssertEqual(try inode(state), foreign); XCTAssertEqual(try Data(contentsOf: state), original)
        await store.close()
        let reopened = try open()
        let lockInode = try replacement(root.appendingPathComponent(".lock"))
        await failure(.unavailable) { _ = try await reopened.pendingPage() }
        XCTAssertEqual(try inode(root.appendingPathComponent(".lock")), lockInode)
        await reopened.close()
        // Cold replacement of the whole directory cannot adopt even byte-identical header/records.
        let moved = root.deletingLastPathComponent().appendingPathComponent("retained-original")
        try FileManager.default.moveItem(at: root, to: moved)
        try FileManager.default.copyItem(at: moved, to: root)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: state), original)
    }

    func testCorruptOrMissingCommittedOrderAndOversizedEnvelopeNeverBecomeEmpty() async throws {
        let store = try open(), first = try event(); _ = try await store.capture(first)
        try Data("{}".utf8).write(to: record(first.id))
        await failure { _ = try await store.pendingPage() }
        await failure(.unavailable) { _ = try await store.capture(event("after corruption")) }
        await store.close()
        XCTAssertThrowsError(try NativePersonalIntakeEvent.url(String(repeating: "x", count: 16_001)))
        XCTAssertThrowsError(try NativePersonalIntakeEvent.spotlight(String(repeating: "x", count: 8_001)))
        XCTAssertThrowsError(try NativePersonalIntakeEvent.url("x", receivedAt: Date(timeIntervalSince1970: .infinity)))
        // Restore only this owned fixture's exact capture envelope by starting a separate native route.
        route = try .fixture(home: home, arguments: ["--native-ui-test-library", UUID().uuidString.lowercased()])
        let isolated = try open(); _ = try await isolated.capture(event())
        try FileManager.default.removeItem(at: slot(1))
        await failure { _ = try await isolated.pendingPage() }
    }

    func testOrderPhysicalReadFailureLatchesBeforeAnyLaterCapture() async throws {
        for oversized in [true, false] {
            route = try .fixture(home: home, arguments: ["--native-ui-test-library", UUID().uuidString.lowercased()])
            let store = try open(), first = try event()
            _ = try await store.capture(first)
            let originalHeader = try Data(contentsOf: state), order = slot(1)
            let corrupt: Data
            if oversized {
                corrupt = Data(repeating: 120, count: IntakeWire.recordLimit + 1)
                try corrupt.write(to: order)
            } else {
                corrupt = Data("retained foreign target".utf8)
                let foreign = home.appendingPathComponent("foreign-order-target")
                try corrupt.write(to: foreign)
                try FileManager.default.removeItem(at: order)
                try FileManager.default.createSymbolicLink(at: order, withDestinationURL: foreign)
            }
            await failure(.unavailable) { _ = try await store.pendingPage() }
            let next = try event("must not publish after known order IO corruption")
            await failure(.unavailable) { _ = try await store.capture(next) }
            XCTAssertEqual(try Data(contentsOf: state), originalHeader)
            XCTAssertEqual(try Data(contentsOf: order), corrupt)
            XCTAssertFalse(FileManager.default.fileExists(atPath: record(next.id).path))
            await store.close()
        }
    }

    private func futureRenamedHome() throws -> URL {
        let result = home.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
            .appendingPathComponent("home", isDirectory: true)
        finishHomes.append(result)
        try FileManager.default.createDirectory(at: result.deletingLastPathComponent(), withIntermediateDirectories: true)
        return result
    }
    private func intakeDirectoryEvidence(_ root: URL) throws -> [String: IntakeDirectoryIdentity] {
        var result: [String: IntakeDirectoryIdentity] = [:]
        for name in ["", "records", "order"] {
            let path = name.isEmpty ? root : root.appendingPathComponent(name)
            var value = stat()
            guard lstat(path.path, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else { throw Injected.failure }
            result[name] = .init(value)
        }
        return result
    }
    private func exerciseColdFullHomeRename(isolated: Bool) async throws {
        let identifier = UUID().uuidString.lowercased()
        let arguments = isolated ? ["--native-ui-test-library", identifier] : []
        route = try .fixture(home: home, arguments: arguments)
        let original = try open(), firstEvent = try event()
        let first = try await original.capture(firstEvent)
        let second = try await original.capture(event("terminal-history", seconds: 101))
        let admitting = try await original.markAdmitting(second)
        try await original.finish(admitting, outcome: .completed)
        _ = try await original.settleFinish(admitting, outcome: .completed)
        let claim = try await original.reserveNavigationCapture(id: UUID().uuidString.lowercased())
        let oldRoot = root, headerBytes = try Data(contentsOf: state)
        let filesBefore = try finishEvidence(oldRoot), directoriesBefore = try intakeDirectoryEvidence(oldRoot)
        await original.close()
        let renamedHome = try futureRenamedHome()
        try FileManager.default.moveItem(at: home, to: renamedHome)
        let currentRoute = try NativePersonalIntakeRoute.fixture(home: renamedHome, arguments: arguments)
        let currentRoot = currentRoute.components.reduce(renamedHome) { $0.appendingPathComponent($1, isDirectory: true) }
        let diagnostics = Diagnostics()
        let reopened = try XCTUnwrap(NativePersonalIntake.openExisting(route: currentRoute, diagnostic: diagnostics.receive)); stores.append(reopened)
        XCTAssertNotEqual(currentRoute.descriptor, route.descriptor)
        XCTAssertEqual(try Data(contentsOf: currentRoot.appendingPathComponent("state.json")), headerBytes)
        XCTAssertEqual(try intakeDirectoryEvidence(currentRoot), directoriesBefore)
        XCTAssertEqual(try finishEvidence(currentRoot), filesBefore, "A renamed home does not rewrite or copy the original intake")
        let retainedClaim = try await reopened.navigationReservationID(); XCTAssertEqual(retainedClaim, claim)
        let page = try await reopened.pendingPage()
        XCTAssertEqual(page.items.map(\.id), [first.id]); XCTAssertEqual(page.items.first?.event, firstEvent)
        XCTAssertEqual(page.items.first?.stage, .captured)
        await failure(.staleItem) { _ = try await reopened.markAdmitting(first) }
        await failure(.staleItem) { _ = try await reopened.settleFinish(admitting, outcome: .completed) }
        XCTAssertEqual(try Data(contentsOf: currentRoot.appendingPathComponent("records/\(second.id).json")),
                       filesBefore["records/\(second.id).json"]?.bytes)
        let laterEvent = try event("after-home-rename", seconds: 102)
        let later = try await reopened.capture(laterEvent)
        XCTAssertEqual(later.sequence, 3); XCTAssertEqual(later.event, laterEvent)
        let originBefore = try XCTUnwrap(JSONSerialization.jsonObject(with: headerBytes) as? [String: Any])["origin"] as? String
        XCTAssertEqual(try dictionary(currentRoot.appendingPathComponent("state.json"))["origin"] as? String, originBefore,
                       "Ordinary later publication retains the original descriptor; reopening never rewrites it")
        let markers = diagnostics.events.filter { $0.operation == "same-tree-reopen" }
        XCTAssertEqual(markers.count, 1, "Cold admission emits once, not once per validated operation")
        XCTAssertEqual(markers.first?.message, "Native iOS personal intake reopened after container relocation")
        XCTAssertEqual(markers.first?.releaseCheck, "v1.3.9/ios-intake-same-tree-reopen")
        XCTAssertEqual(markers.first?.outcome, "confirmed")
    }
    func testColdFullHomeRenameReopensSameStandardTreeWithoutRewritingHeader() async throws {
        try await exerciseColdFullHomeRename(isolated: false)
    }
    func testColdFullHomeRenameReopensSameIsolatedTreeWithoutRewritingHeader() async throws {
        try await exerciseColdFullHomeRename(isolated: true)
    }
    func testColdHomeChangeRejectsByteIdenticalCopiedTreeWithoutRepair() async throws {
        let original = try open(); _ = try await original.capture(event())
        let before = try finishEvidence(root), originalInode = try inode(root)
        await original.close()
        let copiedHome = try futureRenamedHome()
        try FileManager.default.copyItem(at: home, to: copiedHome)
        let currentRoute = try NativePersonalIntakeRoute.fixture(home: copiedHome)
        let currentRoot = currentRoute.components.reduce(copiedHome) { $0.appendingPathComponent($1) }
        XCTAssertNotEqual(try inode(currentRoot), originalInode)
        let copied = try finishEvidence(currentRoot), diagnostics = Diagnostics()
        XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: currentRoute, diagnostic: diagnostics.receive))
        XCTAssertEqual(try finishEvidence(currentRoot), copied)
        XCTAssertEqual(try finishEvidence(root), before)
        XCTAssertTrue(diagnostics.events.isEmpty)
    }
    func testColdHomeRenameRejectsReplacedLeaseWithoutRepair() async throws {
        let original = try open(); _ = try await original.capture(event())
        let directories = try intakeDirectoryEvidence(root)
        await original.close()
        let renamedHome = try futureRenamedHome(); try FileManager.default.moveItem(at: home, to: renamedHome)
        let currentRoute = try NativePersonalIntakeRoute.fixture(home: renamedHome)
        let currentRoot = currentRoute.components.reduce(renamedHome) { $0.appendingPathComponent($1) }
        let replacementInode = try replacement(currentRoot.appendingPathComponent(".lock"))
        let before = try finishEvidence(currentRoot), diagnostics = Diagnostics()
        XCTAssertEqual(try intakeDirectoryEvidence(currentRoot), directories)
        XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: currentRoute, diagnostic: diagnostics.receive))
        XCTAssertEqual(try inode(currentRoot.appendingPathComponent(".lock")), replacementInode)
        XCTAssertEqual(try finishEvidence(currentRoot), before); XCTAssertTrue(diagnostics.events.isEmpty)
    }
    func testColdHomeRenameRejectsForeignNamespaceOnSamePhysicalTree() async throws {
        let original = try open(); _ = try await original.capture(event())
        let directories = try intakeDirectoryEvidence(root), before = try finishEvidence(root)
        await original.close()
        let renamedHome = try futureRenamedHome(); try FileManager.default.moveItem(at: home, to: renamedHome)
        let oldRoot = route.components.reduce(renamedHome) { $0.appendingPathComponent($1) }
        let foreignRoute = try NativePersonalIntakeRoute.fixture(home: renamedHome, bundleIdentifier: "mindwtr.intake.foreign")
        let foreignRoot = foreignRoute.components.reduce(renamedHome) { $0.appendingPathComponent($1) }
        try FileManager.default.moveItem(at: oldRoot, to: foreignRoot)
        XCTAssertEqual(try intakeDirectoryEvidence(foreignRoot), directories)
        let diagnostics = Diagnostics()
        XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: foreignRoute, diagnostic: diagnostics.receive))
        XCTAssertEqual(try finishEvidence(foreignRoot), before); XCTAssertTrue(diagnostics.events.isEmpty)
    }
    func testColdHomeRenameRejectsMalformedOrNoncanonicalOriginWithoutRepair() async throws {
        let original = try open(), captured = try await original.capture(event())
        let header = try dictionary(state), headerBytes = try Data(contentsOf: state)
        let originData = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(header["origin"] as? String)))
        let origin = try XCTUnwrap(JSONSerialization.jsonObject(with: originData) as? [String: Any])
        await original.close()
        let renamedHome = try futureRenamedHome(); try FileManager.default.moveItem(at: home, to: renamedHome)
        let currentRoute = try NativePersonalIntakeRoute.fixture(home: renamedHome)
        let currentRoot = currentRoute.components.reduce(renamedHome) { $0.appendingPathComponent($1) }
        let currentState = currentRoot.appendingPathComponent("state.json"), diagnostics = Diagnostics()
        var invalid: [Data] = [Data("null".utf8), Data("[]".utf8), Data("not JSON".utf8),
            Data(" ".utf8) + originData, Data(repeating: 32, count: 64 * 1024 + 1),
            Data("{\"version\":\"1\",".utf8) + originData.dropFirst()]
        let changes: [(String, Any)] = [
            ("extra", "unknown"), ("version", 1), ("version", "2"), ("kind", "isolated"),
            ("namespace", "mindwtr.intake.foreign"), ("identifier", UUID().uuidString.lowercased()),
            ("home", home.path + "/"), ("home", home.path + "//"), ("home", home.path + "/../home"),
            ("home", home.path + "\0"), ("support", home.path + "-foreign/Library/Application Support"),
            ("database", home.path + "/Library/Application Support/NativeFoundation/other.sqlite"),
            ("container", home.path + "/foreign")]
        for (field, value) in changes {
            var changed = origin; changed[field] = value
            invalid.append(try JSONSerialization.data(withJSONObject: changed, options: [.sortedKeys, .withoutEscapingSlashes]))
        }
        var missing = origin; missing.removeValue(forKey: "database")
        invalid.append(try JSONSerialization.data(withJSONObject: missing, options: [.sortedKeys, .withoutEscapingSlashes]))
        for badOrigin in invalid {
            var badHeader = header; badHeader["origin"] = badOrigin.base64EncodedString()
            let bytes = try JSONSerialization.data(withJSONObject: badHeader, options: [.sortedKeys, .withoutEscapingSlashes])
            try bytes.write(to: currentState)
            XCTAssertThrowsError(try NativePersonalIntake.openExisting(route: currentRoute, diagnostic: diagnostics.receive))
            XCTAssertEqual(try Data(contentsOf: currentState), bytes)
        }
        XCTAssertTrue(diagnostics.events.isEmpty)
        try headerBytes.write(to: currentState)
        let accepted = try XCTUnwrap(NativePersonalIntake.openExisting(route: currentRoute, diagnostic: diagnostics.receive)); stores.append(accepted)
        let page = try await accepted.pendingPage(); XCTAssertEqual(page.items.first?.id, captured.id)
        XCTAssertEqual(try Data(contentsOf: currentState), headerBytes)
        XCTAssertEqual(diagnostics.events.filter { $0.operation == "same-tree-reopen" }.count, 1)
    }

    func testRouteResolvesOnceRejectsNamespaceDotAndSeparatesPersonalFamilies() throws {
        XCTAssertThrowsError(try NativePersonalIntakeRoute.fixture(home: home, bundleIdentifier: "."))
        XCTAssertThrowsError(try NativePersonalIntakeRoute.fixture(home: home, bundleIdentifier: ".."))
        XCTAssertThrowsError(try NativePersonalIntakeRoute.fixture(home: home, bundleIdentifier: "NativePersonalIntake"))
        let ordinary = try NativePersonalIntakeRoute.fixture(home: home)
        let id = UUID().uuidString.lowercased()
        let isolated = try NativePersonalIntakeRoute.fixture(home: home, arguments: ["--native-ui-test-library", id], bundleIdentifier: nil)
        guard case let .isolated(database, container, _, actual) = isolated.selection else { return XCTFail("Expected original isolated selection") }
        XCTAssertEqual(actual.uuidString.lowercased(), id)
        let intake = isolated.components.reduce(home!) { $0.appendingPathComponent($1) }
        XCTAssertFalse(intake.path.hasPrefix(container.path + "/")); XCTAssertFalse(intake.path.hasPrefix(database.deletingLastPathComponent().path + "/"))
        XCTAssertNotEqual(ordinary.descriptor, isolated.descriptor)
        XCTAssertEqual(ordinary.descriptor, try NativePersonalIntakeRoute.fixture(home: home).descriptor)
        XCTAssertThrowsError(try NativePersonalIntakeRoute.fixture(home: home.deletingLastPathComponent()))
    }

    func testDurableExclusiveCollisionKeepsForeignInodeAndDefaultReplacementWorks() throws {
        let directory = home.appendingPathComponent("publication", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(fd, 0); defer { Darwin.close(fd) }
        let file = directory.appendingPathComponent("record.json"), foreign = Data("foreign".utf8), own = Data("own".utf8)
        try foreign.write(to: file); let before = try inode(file)
        var retained: Int32 = -1
        XCTAssertThrowsError(try DurableFile.write(own, to: "record.json", in: fd, retainingFile: &retained, exclusive: true))
        XCTAssertGreaterThanOrEqual(retained, 0); if retained >= 0 { Darwin.close(retained) }; retained = -1
        XCTAssertEqual(try inode(file), before); XCTAssertEqual(try Data(contentsOf: file), foreign)
        try DurableFile.write(own, to: "record.json", in: fd, retainingFile: &retained)
        defer { if retained >= 0 { Darwin.close(retained) } }
        XCTAssertNotEqual(try inode(file), before); XCTAssertEqual(try Data(contentsOf: file), own)
    }
    func testProductionRouteKeepsExactDescriptorAndColdPendingCapture() async throws {
        let selected = try NativePersonalIntakeRoute.fixture(home: home,
            bundleIdentifier: NativeLaunchSelection.productionNamespace, mode: .production)
        guard case let .production(container) = selected.selection else { return XCTFail("Expected production route") }
        XCTAssertEqual(container, home)
        XCTAssertEqual(selected.namespace, NativeLaunchSelection.productionNamespace)
        let origin = try XCTUnwrap(JSONSerialization.jsonObject(with: selected.descriptor) as? [String: String])
        XCTAssertEqual(Set(origin.keys), Set(["version", "kind", "namespace", "identifier", "home", "support", "database", "container"]))
        XCTAssertEqual(origin["kind"], "standard")
        XCTAssertEqual(origin["namespace"], "tech.dongdongbh.mindwtr")
        XCTAssertEqual(origin["database"], home.appendingPathComponent("Documents/SQLite/mindwtr.db").path)
        XCTAssertTrue(selected.matchesStoredOrigin(selected.descriptor))
        let reminder = try NativeReminderInbox(selection: selected.selection); reminderSources.append(reminder)
        try await reminder.prepareEmptySourceForPersonalIntake(route: selected)
        let writer = try NativePersonalIntake(route: selected, diagnostic: { _ in }); stores.append(writer)
        let original = try event(), item = try await writer.capture(original)
        await writer.close()
        let cold = try NativePersonalIntake(route: selected, diagnostic: { _ in }); stores.append(cold)
        let page = try await cold.pendingPage()
        XCTAssertEqual(page.items.map(\.id), [item.id])
        let repeated = try await cold.capture(original)
        XCTAssertEqual(repeated.id, item.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/NativeFoundation/mindwtr.sqlite").path))
    }

}
