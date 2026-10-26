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
    private var home: URL!
    private var route: NativePersonalIntakeRoute!
    private var stores: [NativePersonalIntake] = []
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
        let terminal = try await store.capture(first); XCTAssertEqual(terminal.stage, .terminal); XCTAssertNil(terminal.event)
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
        XCTAssertEqual(marker.releaseCheck, "v1.3.8/ios-personal-intake")
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
}
