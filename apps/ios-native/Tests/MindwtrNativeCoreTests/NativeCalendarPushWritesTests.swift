import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class CalendarPushWritesProvider: NativeCalendarWriteWitnessing, @unchecked Sendable {
    enum Mode { case normal, preflightMissing, confirmedMissing, uncertainMissing }
    var mode = Mode.normal
    var beforeMutation: (() -> Void)?
    private let lock = NSLock()
    private var recorded: [NativeCalendarWriteRequest] = []
    private var mutations = 0
    var requests: [NativeCalendarWriteRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    var mutationCount: Int { lock.lock(); defer { lock.unlock() }; return mutations }
    func permissions() throws -> NativeCalendarPermission { .granted }
    func calendars() throws -> [[String: Any]] { [] }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { [] }
    func sources() throws -> [NativeCalendarSource] { [NativeCalendarSource(id: "source-é", name: "Source", type: .local)] }
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String { "created-calendar" }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws {}
    func deleteCalendar(calendarID: String) throws {}
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String { "created-event" }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws {}
    func deleteEvent(eventID: String, calendarID: String) throws {}
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue {
        lock.lock(); recorded.append(request); lock.unlock()
        if case .sources = request { return .sources(try sources()) }
        switch mode {
        case .preflightMissing: throw NativeCalendarWriteError.missingEvent
        case .confirmedMissing: confirmedMissingEvent(); throw NativeCalendarWriteError.missingEvent
        case .normal, .uncertainMissing: break
        }
        beforeProviderMutation()
        lock.lock(); mutations += 1; let count = mutations; lock.unlock()
        beforeMutation?()
        if case .uncertainMissing = mode { throw NativeCalendarWriteError.missingEvent }
        switch request {
        case .createEvent: return .identifier("event-\(count)")
        case .createCalendar: return .identifier("created-calendar")
        default: return .completed
        }
    }
}

final class NativeCalendarPushWritesTests: XCTestCase {
    private var container: URL!
    private var storage: NativeDeviceKV!
    private var database: SQLiteBridge!
    private var effects: NativeCalendarPushEffects!
    private var jobs: NativeCalendarJobs!
    private var pipeline: NativeCalendarPushWrites!
    private var provider: CalendarPushWritesProvider!
    private var ownerValid = true
    private var settlementValid = true
    private var authorizations: [NativeCalendarWriteRequest?] = []
    private let bundle = "tech.dongdongbh.mindwtr.push-writes-tests"
    private let library = "library-e\u{301}"
    private enum Injected: Error { case failure }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(bundle)/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        container = base.appendingPathComponent(".mindwtr-native-tests/push-writes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["unknown": "unchanged", "mindwtr:calendar-push-sync:pending-calendar": "android-only"]).write(to: manifest)
        storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        database = try SQLiteBridge(url: container.appendingPathComponent("mapping.sqlite"))
        _ = try database.execute("CREATE TABLE calendar_sync (task_id TEXT NOT NULL, calendar_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL, platform TEXT NOT NULL, last_synced_at TEXT NOT NULL, PRIMARY KEY (task_id, platform))")
        effects = try NativeCalendarPushEffects(storage: storage, database: database, libraryID: library)
        provider = CalendarPushWritesProvider()
        jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests(), readerFactory: { self.provider })
        pipeline = NativeCalendarPushWrites(jobs: jobs, effects: effects, authorize: {
            self.authorizations.append($0)
            guard self.ownerValid else { throw Injected.failure }
        }, settleAuthority: { guard self.settlementValid else { throw Injected.failure } })
    }
    override func tearDownWithError() throws {
        storage?.faults.beforePromotion = nil; storage?.faults.afterPromotion = nil; storage?.faults.beforeReadback = nil
        database?.faults = nil; ownerValid = false; settlementValid = true
        try pipeline?.cancelAndDrain(); jobs?.shutdown()
        storage?.close(); database?.close()
        pipeline = nil; jobs = nil; effects = nil; storage = nil; database = nil; provider = nil
        if let container { try FileManager.default.removeItem(at: container) }
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func request(_ operation: String = "createEvent") throws -> String {
        var value: [String: Any] = ["op": operation, "calendarId": "calendar"]
        if operation == "updateEvent" || operation == "deleteEvent" { value["eventId"] = "event" }
        if operation == "createEvent" || operation == "updateEvent" {
            value["details"] = ["title": "Synthetic", "startMs": 1_800_000_000_000,
                                "endMs": 1_800_003_600_000, "allDay": false, "notes": "notes", "location": ""]
        }
        return try json(value)
    }
    private func mapping(_ task: String, event: String = "event") throws -> NativeCalendarPushMapping {
        try NativeCalendarPushMapping(taskId: task, calendarEventId: event, calendarId: "calendar", platform: "ios", lastSyncedAt: "2026-10-09T00:00:00.000Z")
    }
    private func object(_ raw: String?) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(raw).utf8)) as? [String: Any])
    }
    private func value(_ reply: [String: Any]) throws -> [String: Any] { try XCTUnwrap(reply["value"] as? [String: Any]) }
    private func operation(_ reply: [String: Any]) throws -> UUID {
        try XCTUnwrap(UUID(uuidString: XCTUnwrap(value(reply)["operationId"] as? String)))
    }
    private func completed(_ ticket: String) throws -> [String: Any] {
        XCTAssertNil(pipeline.next()); jobs.drain()
        let reply = try object(pipeline.next()); XCTAssertEqual(reply["id"] as? String, ticket); return reply
    }

    func testFourQueuedTasksSerializeThroughTheirExactMappingAcknowledgements() throws {
        let tasks = ["task-é", "task-e\u{301}", "third", "fourth"]
        let tickets = try tasks.map { try pipeline.submit(requestJSON: request(), taskID: $0) }
        for (index, task) in tasks.enumerated() {
            let reply = try completed(tickets[index]), id = try operation(reply)
            XCTAssertEqual(try effects.current()?.id, id); XCTAssertEqual(try effects.current()?.phase, .saved)
            XCTAssertEqual(provider.mutationCount, index + 1)
            XCTAssertNil(pipeline.next()); XCTAssertEqual(provider.mutationCount, index + 1)
            let row = try mapping(task, event: "event-\(index + 1)")
            XCTAssertThrowsError(try pipeline.acknowledge(operationID: UUID(), entry: row))
            try pipeline.acknowledge(operationID: id, entry: row)
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: task), row); XCTAssertNil(try effects.current())
        }
        XCTAssertEqual(authorizations.count, 8)
        XCTAssertEqual(try storage.get("unknown"), "unchanged")
        XCTAssertEqual(try storage.get("mindwtr:calendar-push-sync:pending-calendar"), "android-only")
    }

    func testProviderReceivesExactlyThePreparedCreateMarkerRequest() throws {
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        _ = try completed(ticket)
        let effect = try XCTUnwrap(effects.current())
        guard case .createEvent(_, let frozen) = effect.request, case .createEvent(_, let actual) = try XCTUnwrap(provider.requests.first) else { return XCTFail() }
        XCTAssertEqual(Data(actual.notes.utf8), Data(frozen.notes.utf8))
        XCTAssertTrue(actual.notes.contains(effect.id.uuidString.lowercased()))
        XCTAssertEqual(provider.mutationCount, 1)
    }

    func testCalendarStateAcknowledgementPrecedesSuccessReply() throws {
        let before = try storage.readCalendarPushState(); var next = before
        next[1] = "calendar"; next[3] = "#3B82F6"
        try storage.compareAndSetCalendarPushState(expected: before, next: next)
        let raw = try json(["op": "updateCalendar", "calendarId": "calendar", "details": ["color": "#aabbcc"]])
        let reply = try completed(pipeline.submit(requestJSON: raw, taskID: nil))
        XCTAssertNil(reply["error"]); XCTAssertNil(try effects.current())
        XCTAssertEqual(try storage.readCalendarPushState()[3], "#AABBCC")
        XCTAssertTrue(jobs.writeAdmissionAvailable)
    }

    func testSourcesUseTheExistingWriterSlotWithoutJournalOrMappingWork() throws {
        var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
        let reply = try completed(pipeline.submitSources())
        let sources = try XCTUnwrap(reply["value"] as? [[String: Any]])
        XCTAssertEqual(sources.first?["id"] as? String, "source-é")
        XCTAssertEqual(promotions, 0); XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
        XCTAssertEqual(authorizations.count, 1); XCTAssertNil(authorizations[0])
    }

    func testReadBacklogWaitsWithoutPreparingOrFailingTheHeadWrite() throws {
        let read = try jobs.submit(##"{"op":"permissions"}"##)
        jobs.drain()
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); XCTAssertNil(try effects.current()); XCTAssertTrue(authorizations.isEmpty)
        XCTAssertEqual(try object(jobs.next()?.json)["id"] as? String, read)
        _ = try completed(ticket); XCTAssertEqual(provider.mutationCount, 1)
    }

    func testCancellationOfQueuedAndAcceptedBeforeEntryNeverInvokesTheProvider() throws {
        let first = try pipeline.submit(requestJSON: request(), taskID: "first")
        pipeline.cancel(first)
        XCTAssertEqual(try object(pipeline.next())["error"] as? String, "Calendar request cancelled")
        XCTAssertEqual(provider.mutationCount, 0); XCTAssertNil(try effects.current())
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        jobs.beforeWriteEntry = { entered.signal(); _ = release.wait(timeout: .now() + 5) }
        defer { release.signal(); jobs.beforeWriteEntry = nil }
        let second = try pipeline.submit(requestJSON: request(), taskID: "second")
        XCTAssertNil(pipeline.next()); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        pipeline.cancel(second); release.signal(); jobs.drain()
        XCTAssertEqual(try object(pipeline.next())["error"] as? String, "Calendar request cancelled")
        XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
    }

    func testCancellationAndDrainDuringHeldCreateRetainActualSavedOutcome() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        provider.beforeMutation = { entered.signal(); _ = release.wait(timeout: .now() + 5) }
        defer { release.signal() }
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        ownerValid = false; pipeline.cancel(ticket); release.signal()
        try pipeline.cancelAndDrain()
        let reply = try object(pipeline.next())
        XCTAssertEqual(reply["id"] as? String, ticket); XCTAssertNil(reply["error"])
        XCTAssertEqual(try effects.current()?.phase, .saved); XCTAssertEqual(provider.mutationCount, 1)
        XCTAssertTrue(jobs.writeAdmissionAvailable)
        XCTAssertThrowsError(try pipeline.submitSources())
    }

    func testConfirmedAbsenceAloneProducesMissingEventTokenAndWaitsForNilAck() throws {
        let before = try mapping("task"); try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        provider.mode = .confirmedMissing
        let reply = try completed(pipeline.submit(requestJSON: request("deleteEvent"), taskID: "task"))
        let result = try XCTUnwrap(value(reply)["result"] as? [String: Any])
        XCTAssertEqual(result["kind"] as? String, "missingEvent")
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
        try pipeline.acknowledge(operationID: operation(reply), entry: nil)
        XCTAssertNil(try database.readCalendarPushMapping(taskID: "task")); XCTAssertNil(try effects.current())
    }

    func testThrownMissingEventIsGenericAndUncertainFailureRejectsQueuedPromises() throws {
        let before = try mapping("task"); try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        provider.mode = .uncertainMissing
        let first = try pipeline.submit(requestJSON: request("updateEvent"), taskID: "task")
        let rest = try pipeline.submit(requestJSON: request(), taskID: "other")
        XCTAssertNil(pipeline.next()); jobs.drain()
        let replies = try [object(pipeline.next()), object(pipeline.next())]
        XCTAssertEqual(Set(replies.compactMap { $0["id"] as? String }), Set([first, rest]))
        XCTAssertTrue(replies.allSatisfy { $0["error"] as? String == "Calendar write failed" })
        XCTAssertEqual(try effects.current()?.phase, .started)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
        XCTAssertEqual(provider.mutationCount, 1); XCTAssertThrowsError(try pipeline.submitSources())
    }

    func testProvenPreflightMissingEventClearsEffectAndReturnsGenericFailure() throws {
        let before = try mapping("task"); try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        provider.mode = .preflightMissing
        let reply = try completed(pipeline.submit(requestJSON: request("updateEvent"), taskID: "task"))
        XCTAssertEqual(reply["error"] as? String, "Calendar write failed")
        XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
        provider.mode = .normal; _ = try completed(pipeline.submitSources())
    }

    func testFailedCompletionPublicationRetainsWorkerAndRetriesWithoutAnotherProviderCall() throws {
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); jobs.drain()
        let id = try XCTUnwrap(effects.current()?.id)
        storage.faults.afterPromotion = { throw Injected.failure }
        XCTAssertEqual(try object(pipeline.next())["error"] as? String, "Calendar write failed")
        XCTAssertNotNil(jobs.writeOutcome(operationID: id)); XCTAssertFalse(jobs.writeAdmissionAvailable)
        storage.faults.afterPromotion = nil
        XCTAssertNil(pipeline.next()); XCTAssertNil(jobs.writeOutcome(operationID: id))
        XCTAssertEqual(try effects.current()?.phase, .saved); XCTAssertEqual(provider.mutationCount, 1)
        try pipeline.acknowledge(operationID: id, entry: mapping("task", event: "event-1"))
        XCTAssertNil(try effects.current()); XCTAssertNil(pipeline.next())
        XCTAssertFalse(ticket.isEmpty)
    }

    func testAcknowledgementCASFailureRetainsExactMappingAndRejectsQueuedWritesPromptly() throws {
        let first = try pipeline.submit(requestJSON: request(), taskID: "task")
        let second = try pipeline.submit(requestJSON: request(), taskID: "other")
        let reply = try completed(first), id = try operation(reply), row = try mapping("task", event: "event-1")
        let faults = HostIOFaults(); faults.beforeSQL = { sql in if sql.hasPrefix("INSERT") { throw Injected.failure } }
        database.faults = faults
        XCTAssertThrowsError(try pipeline.acknowledge(operationID: id, entry: row))
        XCTAssertEqual(try effects.current()?.phase, .acknowledging)
        let rejected = try object(pipeline.next()); XCTAssertEqual(rejected["id"] as? String, second)
        XCTAssertEqual(rejected["error"] as? String, "Calendar write failed"); XCTAssertEqual(provider.mutationCount, 1)
        database.faults = nil
        XCTAssertThrowsError(try pipeline.acknowledge(operationID: id, entry: mapping("task", event: "other-event")))
        try pipeline.acknowledge(operationID: id, entry: row)
        XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), row)
    }

    func testLostFinalMappingClearKeepsBarrierUntilExplicitMatchingRetry() throws {
        let reply = try completed(pipeline.submit(requestJSON: request(), taskID: "task"))
        let id = try operation(reply), row = try mapping("task", event: "event-1")
        var promotions = 0
        storage.faults.afterPromotion = { promotions += 1; if promotions == 2 { throw Injected.failure } }
        XCTAssertThrowsError(try pipeline.acknowledge(operationID: id, entry: row))
        storage.faults.afterPromotion = nil
        XCTAssertNil(pipeline.next()); XCTAssertNil(try effects.current())
        XCTAssertThrowsError(try pipeline.acknowledge(operationID: id, entry: nil))
        try pipeline.acknowledge(operationID: id, entry: row)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), row)
        _ = try completed(pipeline.submitSources())
    }

    func testWarmUnsubmittedStartedPublicationCancellationClearsWithoutProviderAndColdCannot() throws {
        for cut in ["before", "after"] {
            var promotions = 0
            storage.faults.beforePromotion = { promotions += 1; if cut == "before", promotions == 2 { throw Injected.failure } }
            storage.faults.afterPromotion = { if cut == "after", promotions == 2 { throw Injected.failure } }
            let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
            let failure = try object(pipeline.next()); XCTAssertEqual(failure["id"] as? String, ticket)
            pipeline.cancel(ticket); ownerValid = false
            storage.faults.beforePromotion = nil; storage.faults.afterPromotion = nil
            XCTAssertNil(pipeline.next()); XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
            ownerValid = true
        }
        let id = UUID(); _ = try effects.prepare(id: id, requestJSON: request(), taskID: "cold")
        _ = try effects.markStarted(id: id)
        try pipeline.cancelAndDrain(); storage.close(); database.close()
        storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        database = try SQLiteBridge(url: container.appendingPathComponent("mapping.sqlite"))
        effects = try NativeCalendarPushEffects(storage: storage, database: database, libraryID: library)
        pipeline = NativeCalendarPushWrites(jobs: jobs, effects: effects, authorize: { _ in }, settleAuthority: {})
        XCTAssertThrowsError(try pipeline.submitSources())
        XCTAssertEqual(try effects.current()?.id, id); XCTAssertEqual(try effects.current()?.phase, .started)
    }

    func testCapacityCountsReadyTicketsAndInvalidRequestsNeverAdmitOrInventTokens() throws {
        XCTAssertThrowsError(try pipeline.submit(requestJSON: ##"{"op":"sources"}"##, taskID: nil))
        XCTAssertThrowsError(try pipeline.submit(requestJSON: request(), taskID: nil))
        let tickets = try (0..<32).map { try pipeline.submit(requestJSON: request(), taskID: "task-\($0)") }
        XCTAssertThrowsError(try pipeline.submitSources())
        for ticket in tickets { pipeline.cancel(ticket) }
        XCTAssertThrowsError(try pipeline.submitSources())
        for _ in tickets { XCTAssertEqual(try object(pipeline.next())["error"] as? String, "Calendar request cancelled") }
        XCTAssertEqual(provider.mutationCount, 0); XCTAssertNil(try effects.current())
        _ = try completed(pipeline.submitSources())
    }

    func testFirstEnqueueRefusalClearsOnlyThisUnacceptedStartedAttempt() throws {
        pipeline.beforeFirstSubmission = { self.jobs.shutdown() }
        let first = try pipeline.submit(requestJSON: request(), taskID: "first")
        let second = try pipeline.submit(requestJSON: request(), taskID: "second")
        let replies = try [object(pipeline.next()), object(pipeline.next())]
        XCTAssertEqual(Set(replies.compactMap { $0["id"] as? String }), Set([first, second]))
        XCTAssertTrue(replies.allSatisfy { $0["error"] != nil })
        XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
    }

    func testAuthorizationIsCheckedAgainAfterStartedPublicationBeforeProviderSubmission() throws {
        var promotions = 0
        storage.faults.afterPromotion = { promotions += 1; if promotions == 2 { self.ownerValid = false } }
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        let reply = try object(pipeline.next()); XCTAssertEqual(reply["id"] as? String, ticket)
        XCTAssertNotNil(reply["error"]); XCTAssertEqual(provider.mutationCount, 0); XCTAssertNil(try effects.current())
    }

    func testSettlementAuthorityFailureRetainsActualWorkerOutcomeUntilAuthorityReturns() throws {
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); jobs.drain()
        let id = try XCTUnwrap(effects.current()?.id)
        settlementValid = false
        XCTAssertEqual(try object(pipeline.next())["id"] as? String, ticket)
        XCTAssertNotNil(jobs.writeOutcome(operationID: id)); XCTAssertEqual(try effects.current()?.phase, .started)
        settlementValid = true
        XCTAssertNil(pipeline.next()); XCTAssertNil(jobs.writeOutcome(operationID: id))
        XCTAssertEqual(try effects.current()?.phase, .saved); XCTAssertEqual(provider.mutationCount, 1)
    }

    func testPersistentCompletionPublicationFailureMakesDrainThrowWithoutRetiringOutcome() throws {
        _ = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); jobs.drain()
        let id = try XCTUnwrap(effects.current()?.id)
        storage.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try pipeline.cancelAndDrain()); XCTAssertNotNil(jobs.writeOutcome(operationID: id))
        storage.faults.beforePromotion = nil
        try pipeline.cancelAndDrain()
        XCTAssertNil(jobs.writeOutcome(operationID: id)); XCTAssertEqual(try effects.current()?.phase, .saved)
        XCTAssertEqual(provider.mutationCount, 1)
    }

    func testPreparedPublicationCancellationRetriesThenDiscardsWithoutProviderEntry() throws {
        storage.faults.afterPromotion = { throw Injected.failure }
        let ticket = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertEqual(try object(pipeline.next())["id"] as? String, ticket)
        pipeline.cancel(ticket); storage.faults.afterPromotion = nil
        try pipeline.cancelAndDrain()
        XCTAssertNil(try effects.current()); XCTAssertEqual(provider.mutationCount, 0)
    }

    func testChangedSameUUIDRecordCannotPublishOrRetireActualSuccessUntilFrozenRecordReturns() throws {
        _ = try pipeline.submit(requestJSON: request(), taskID: "task")
        XCTAssertNil(pipeline.next()); jobs.drain()
        let original = try XCTUnwrap(effects.current()), id = original.id
        let changed = try NativeCalendarPushEffect(id: id, libraryID: library, requestJSON: request(), taskID: "task").markingStarted()
        let before = try storage.readCalendarPushState(); var next = before; next[5] = try changed.encoded()
        try storage.compareAndSetCalendarPushState(expected: before, next: next)
        XCTAssertThrowsError(try pipeline.cancelAndDrain()); XCTAssertNotNil(jobs.writeOutcome(operationID: id))
        let altered = try storage.readCalendarPushState(); var restored = altered; restored[5] = try original.encoded()
        try storage.compareAndSetCalendarPushState(expected: altered, next: restored)
        try pipeline.cancelAndDrain()
        XCTAssertNil(jobs.writeOutcome(operationID: id)); XCTAssertEqual(try effects.current()?.phase, .saved)
        XCTAssertEqual(provider.mutationCount, 1)
    }
}
