import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarPushEffectsTests: XCTestCase {
    private var container: URL!
    private var storage: NativeDeviceKV!
    private var database: SQLiteBridge!
    private let bundle = "tech.dongdongbh.mindwtr.push-effects-tests"
    private let libraryID = "library-e\u{301}"
    private let id = UUID(uuid: (0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0x4c, 0xcc,
                                0x8d, 0xdd, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee))
    private let names = [
        "mindwtr:calendar-push-sync:enabled", "mindwtr:calendar-push-sync:calendar-id",
        "mindwtr:calendar-push-sync:target-calendar-id", "mindwtr:calendar-push-sync:color",
        "mindwtr:calendar-push-sync:creation-intent", "mindwtr:native:calendar-push-effect:v1",
    ]
    private let firstFive = ["legacy-invalid", "calendar-e\u{301}", "", "\u{FEFF}color", "{legacy-intent"]
    private enum Injected: Error { case failure }
    private var namespace: URL {
        container.appendingPathComponent("Library/Application Support/\(bundle)/RCTAsyncLocalStorage_V1")
    }
    private var manifest: URL { namespace.appendingPathComponent("manifest.json") }
    private var databaseURL: URL { container.appendingPathComponent("mapping.sqlite") }
    private var unrelatedFile: URL { namespace.appendingPathComponent("old-provider-bytes") }

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        container = base.appendingPathComponent(".mindwtr-native-tests/push-effects-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: true)
        var values = Dictionary(uniqueKeysWithValues: zip(names.prefix(5), firstFive))
        values["mindwtr:calendar-push-sync:pending-calendar"] = "android-pending-e\u{301}"
        values["unknown"] = "\u{FEFF}opaque backup 🧠\n"
        try JSONSerialization.data(withJSONObject: values).write(to: manifest)
        try Data("unrelated external bytes 🧠".utf8).write(to: unrelatedFile)
        storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        database = try SQLiteBridge(url: databaseURL)
        _ = try database.execute("CREATE TABLE calendar_sync (task_id TEXT NOT NULL, calendar_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL, platform TEXT NOT NULL, last_synced_at TEXT NOT NULL, PRIMARY KEY (task_id, platform))")
    }
    override func tearDownWithError() throws {
        storage?.close(); database?.close()
        storage = nil; database = nil
        if let container { try FileManager.default.removeItem(at: container) }
    }
    private func reopen() throws {
        storage.close(); database.close()
        storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        database = try SQLiteBridge(url: databaseURL)
    }
    private func coordinator(library: String? = nil) throws -> NativeCalendarPushEffects {
        try NativeCalendarPushEffects(storage: storage, database: database, libraryID: library ?? libraryID)
    }
    private func request(_ op: String = "createEvent", event: String = "event", calendar: String = "calendar") throws -> String {
        var value: [String: Any] = ["op": op, "calendarId": calendar]
        if op == "updateEvent" || op == "deleteEvent" { value["eventId"] = event }
        if op == "createEvent" || op == "updateEvent" {
            value["details"] = ["title": "Synthetic", "startMs": 1_800_000_000_000,
                                "endMs": 1_800_003_600_000, "allDay": false, "notes": "", "location": ""]
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func mapping(task: String = "task", event: String = "event", calendar: String = "calendar",
                         stamp: String = "before") throws -> NativeCalendarPushMapping {
        try NativeCalendarPushMapping(taskId: task, calendarEventId: event, calendarId: calendar,
                                      platform: "ios", lastSyncedAt: stamp)
    }
    private func replaceEffect(_ raw: String?) throws {
        let before = try storage.readCalendarPushState()
        var next = before; next[5] = raw
        try storage.compareAndSetCalendarPushState(expected: before, next: next)
    }
    private func fixed<T>(_ error: NativeCalendarWriteError, file: StaticString = #filePath, line: UInt = #line,
                          _ work: () throws -> T) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertEqual($0 as? NativeCalendarWriteError, error, file: file, line: line)
        }
    }
    private func assertUnrelatedPreserved(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try storage.readCalendarPushState().prefix(5).map { $0.map { Data($0.utf8) } },
                       firstFive.map { Optional(Data($0.utf8)) }, file: file, line: line)
        XCTAssertEqual(try storage.get("mindwtr:calendar-push-sync:pending-calendar").map { Data($0.utf8) },
                       Data("android-pending-e\u{301}".utf8), file: file, line: line)
        XCTAssertEqual(try storage.get("unknown").map { Data($0.utf8) },
                       Data("\u{FEFF}opaque backup 🧠\n".utf8), file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: unrelatedFile), Data("unrelated external bytes 🧠".utf8), file: file, line: line)
    }
    private func savedCreate(_ effects: NativeCalendarPushEffects) throws {
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
    }

    func testPrepareStartedSavedMappingClearPreservesBorrowedStorageAndUnrelatedBytes() throws {
        let effects = try coordinator(), other = try mapping(task: "other")
        try database.compareAndSetCalendarPushMapping(taskID: "other", expected: nil, next: other)
        _ = try database.execute("INSERT INTO calendar_sync VALUES ('task','android-event','android-calendar','android','original')")
        let raw = try request(), next = try mapping(event: "created", stamp: "after")
        let prepared = try effects.prepare(id: id, requestJSON: raw, taskID: "task")
        XCTAssertEqual(prepared.id, id); XCTAssertEqual(prepared.phase, .prepared)
        guard case .createEvent(_, let details) = prepared.request else { return XCTFail("Expected create") }
        XCTAssertEqual(details.notes, "\n\n[Mindwtr native calendar operation: \(id.uuidString.lowercased())]")
        XCTAssertNil(prepared.beforeMapping)
        try assertUnrelatedPreserved()
        XCTAssertEqual(try effects.markStarted(id: id).phase, .started)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
        XCTAssertEqual(try effects.current()?.result, .identifier("created"))
        try effects.acknowledgeMapping(id: id, mapping: next)
        XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), next)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "other"), other)
        XCTAssertTrue(try database.execute("SELECT * FROM calendar_sync WHERE platform = 'android'").contains("android-event"))
        try assertUnrelatedPreserved()
        try effects.retryPublication()
        try reopen(); XCTAssertNil(try coordinator().current()); try assertUnrelatedPreserved()
    }

    func testCreatedEventWitnessIsFrozenBeforeStartAndSurvivesColdRestart() throws {
        var value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(request().utf8)) as? [String: Any])
        var details = try XCTUnwrap(value["details"] as? [String: Any])
        let notes = "e\u{301} 🧠\n[Mindwtr task: task]"
        details["notes"] = notes; value["details"] = details
        let raw = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        let effects = try coordinator()
        let prepared = try effects.prepare(id: id, requestJSON: raw, taskID: "task")
        let started = try effects.markStarted(id: id)
        try reopen()
        let recovered = try XCTUnwrap(coordinator().current())
        XCTAssertEqual(Data(recovered.requestJSON.utf8), Data(prepared.requestJSON.utf8))
        XCTAssertEqual(Data(recovered.requestJSON.utf8), Data(started.requestJSON.utf8))
        guard case .createEvent(_, let frozen) = recovered.request else { return XCTFail("Expected create") }
        XCTAssertEqual(Data(frozen.notes.utf8), Data((notes + "\n\n[Mindwtr native calendar operation: \(id.uuidString.lowercased())]").utf8))
        XCTAssertEqual(recovered.phase, .started)
        try assertUnrelatedPreserved()
    }

    func testPrepareCapturesActualFullRowAndRefusesCreateOrMismatchedUpdate() throws {
        let effects = try coordinator(), before = try mapping(stamp: "stamp-e\u{301}")
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: request(), taskID: "task") }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: request("updateEvent", event: "other"), taskID: "task") }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: request("deleteEvent", calendar: "other"), taskID: "task") }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "absent") }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: "{\"op\":\"sources\"}", taskID: nil) }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: "malformed", taskID: "task") }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task").beforeMapping, before)
    }

    func testWrongUUIDPhaseResultAndMappingFailWithoutMutation() throws {
        let effects = try coordinator(), wrong = UUID()
        fixed(.invalid) { try effects.markStarted(id: id) }
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        var bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.markStarted(id: wrong) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .notStarted) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        _ = try effects.markStarted(id: id); bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.markStarted(id: id) }
        fixed(.invalid) { try effects.acceptCompletion(id: wrong, outcome: .notStarted) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .succeeded(.sources([]))) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .succeeded(.completed)) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .failed(.missingEvent)) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
        bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .notStarted) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: wrong, mapping: mapping(event: "created")) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: mapping(task: "other", event: "created")) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: mapping(event: "other")) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
    }

    func testAnySecondPrepareRefusesIncludingSameUUIDAndSavedRecord() throws {
        let effects = try coordinator()
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        for phase in 0..<3 {
            let bytes = try Data(contentsOf: manifest)
            for operation in [id, UUID()] {
                fixed(.unavailable) { try effects.prepare(id: operation, requestJSON: request(), taskID: "other") }
            }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
            if phase == 0 { _ = try effects.markStarted(id: id) }
            if phase == 1 { try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created"))) }
        }
    }

    func testActualNotStartedClearsWhileAllOtherFailureResultsKeepStarted() throws {
        let effects = try coordinator()
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        _ = try effects.markStarted(id: id)
        let bytes = try Data(contentsOf: manifest)
        for error in [NativeCalendarWriteError.denied, .unavailable, .missingCalendar, .missingSource,
                      .invalid, .readOnly, .ambiguous, .recurring, .failed] {
            try effects.acceptCompletion(id: id, outcome: .failed(error))
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try effects.current()?.phase, .started)
        }
        try effects.acceptCompletion(id: id, outcome: .notStarted)
        XCTAssertNil(try effects.current()); XCTAssertNil(try database.readCalendarPushMapping(taskID: "task"))
        try assertUnrelatedPreserved()
    }

    func testUpdateDeleteMissingEventAndCompletedResultsAcknowledgeExactMapping() throws {
        let effects = try coordinator()
        for op in ["updateEvent", "deleteEvent"] {
            for missing in [false, true] {
                let before = try mapping(), next = try mapping(stamp: "after")
                try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
                _ = try effects.prepare(id: id, requestJSON: request(op), taskID: "task")
                _ = try effects.markStarted(id: id)
                try effects.acceptCompletion(id: id, outcome: missing ? .failed(.missingEvent) : .succeeded(.completed))
                XCTAssertEqual(try effects.current()?.result, missing ? .missingEvent : .completed)
                let intended = !missing && op == "updateEvent" ? next : nil
                try effects.acknowledgeMapping(id: id, mapping: intended)
                XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended)
                if let intended { try database.compareAndSetCalendarPushMapping(taskID: "task", expected: intended, next: nil) }
            }
        }
        try assertUnrelatedPreserved()
    }

    func testSavedCreateFailedMappingLeavesFrozenRecordAndRefusesLaterWork() throws {
        let effects = try coordinator(), conflict = try mapping(event: "foreign"), intended = try mapping(event: "created")
        try savedCreate(effects)
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: conflict)
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(try effects.current()?.phase, .acknowledging)
        XCTAssertEqual(try effects.current()?.result, .identifier("created"))
        XCTAssertEqual(try effects.current()?.afterMapping, intended)
        let bytes = try Data(contentsOf: manifest)
        fixed(.unavailable) { try effects.prepare(id: UUID(), requestJSON: request(), taskID: "other") }
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), conflict)
    }

    func testAcknowledgingRejectsCallerReplacementIncludingUnicodeEquivalentTimestamp() throws {
        let effects = try coordinator(), intended = try mapping(event: "created", stamp: "cafe\u{301}")
        try savedCreate(effects)
        let faults = HostIOFaults(); faults.beforeSQL = { _ in throw Injected.failure }; database.faults = faults
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        database.faults = nil
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: mapping(event: "created", stamp: "caf\u{e9}")) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertNil(try database.readCalendarPushMapping(taskID: "task"))
        try effects.acknowledgeMapping(id: id, mapping: intended); XCTAssertNil(try effects.current())
    }

    func testLostCommitReplyColdReopenSettlesWithoutAnotherMappingMutation() throws {
        let effects = try coordinator(), intended = try mapping(event: "created", stamp: "after")
        try savedCreate(effects)
        let faults = HostIOFaults(); var commits = 0
        faults.afterSQL = { sql in if sql == "COMMIT" { commits += 1; throw Injected.failure } }
        database.faults = faults
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended)); XCTAssertEqual(commits, 1)
        XCTAssertEqual(try effects.current()?.phase, .acknowledging)
        try reopen()
        let cold = try coordinator(), frozen = try XCTUnwrap(cold.current())
        XCTAssertEqual(frozen.id, id); XCTAssertEqual(frozen.afterMapping, intended)
        let forbid = HostIOFaults(); var mutations = 0
        forbid.beforeSQL = { sql in
            if sql.hasPrefix("INSERT") || sql.hasPrefix("UPDATE") || sql.hasPrefix("DELETE") {
                mutations += 1; throw Injected.failure
            }
        }
        database.faults = forbid
        try cold.acknowledgeMapping(id: frozen.id, mapping: frozen.afterMapping)
        XCTAssertEqual(mutations, 0); XCTAssertNil(try cold.current())
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended); try assertUnrelatedPreserved()
    }

    func testColdSavedCreateDerivesMappingFromFrozenResultWithoutNewPrepare() throws {
        try savedCreate(coordinator()); try reopen()
        let cold = try coordinator(), frozen = try XCTUnwrap(cold.current())
        guard case .identifier(let event)? = frozen.result else { return XCTFail("Expected saved identifier") }
        let intended = try mapping(event: event, stamp: "recovered")
        try cold.acknowledgeMapping(id: frozen.id, mapping: intended)
        XCTAssertNil(try cold.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended)
    }

    func testFailedFinalClearKeepsExactPendingPairBlocksWorkAndRetriesOnlyPublication() throws {
        let effects = try coordinator(), intended = try mapping(event: "created")
        try savedCreate(effects)
        var promotions = 0
        storage.faults.beforePromotion = { promotions += 1; if promotions == 2 { throw Injected.failure } }
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(promotions, 2); XCTAssertTrue(storage.hasPendingCalendarPushMutation)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended)
        let bytes = try Data(contentsOf: manifest)
        fixed(.unavailable) { try effects.current() }
        fixed(.unavailable) { try effects.prepare(id: UUID(), requestJSON: request(), taskID: "other") }
        fixed(.unavailable) { try effects.markStarted(id: id) }
        fixed(.unavailable) { try effects.acceptCompletion(id: id, outcome: .notStarted) }
        fixed(.unavailable) { try effects.acknowledgeMapping(id: id, mapping: intended) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
        storage.faults.beforePromotion = { promotions += 1 }
        try effects.retryPublication()
        XCTAssertEqual(promotions, 3); XCTAssertFalse(storage.hasPendingCalendarPushMutation)
        XCTAssertNil(try effects.current()); database.faults = nil
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended); try assertUnrelatedPreserved()
    }

    func testFailedAcknowledgingPublicationNeverEntersSQLAndRetryFreezesExactMapping() throws {
        let effects = try coordinator(), intended = try mapping(event: "created")
        try savedCreate(effects)
        let faults = HostIOFaults(); var statements = 0
        faults.beforeSQL = { _ in statements += 1 }; database.faults = faults
        storage.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(statements, 0)
        fixed(.unavailable) { try effects.acknowledgeMapping(id: id, mapping: intended) }
        storage.faults.beforePromotion = nil
        try effects.retryPublication()
        XCTAssertEqual(statements, 0); XCTAssertEqual(try effects.current()?.phase, .acknowledging)
        XCTAssertEqual(try effects.current()?.afterMapping, intended)
        try effects.acknowledgeMapping(id: id, mapping: intended)
        XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended)
    }

    func testFinalClearReadbackFailureRetriesCommittedPairWithoutPromotionOrSQL() throws {
        let effects = try coordinator(), intended = try mapping(event: "created")
        try savedCreate(effects)
        var promotions = 0, readbacks = 0
        storage.faults.beforePromotion = { promotions += 1 }
        storage.faults.beforeReadback = { readbacks += 1; if readbacks == 2 { throw Injected.failure } }
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(promotions, 2); XCTAssertTrue(storage.hasPendingCalendarPushMutation)
        let bytes = try Data(contentsOf: manifest)
        let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
        storage.faults.beforeReadback = nil
        try effects.retryPublication()
        XCTAssertEqual(promotions, 2); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertNil(try effects.current()); try assertUnrelatedPreserved()
    }

    func testCommittedClearLostReplyColdReopenSeesNoEffect() throws {
        let effects = try coordinator(), intended = try mapping(event: "created")
        try savedCreate(effects)
        var promotions = 0
        storage.faults.afterPromotion = { promotions += 1; if promotions == 2 { throw Injected.failure } }
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        XCTAssertEqual(promotions, 2); XCTAssertTrue(storage.hasPendingCalendarPushMutation)
        fixed(.unavailable) { try effects.current() }
        try reopen(); XCTAssertNil(try coordinator().current())
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended); try assertUnrelatedPreserved()
    }

    func testEachLostPhasePublicationRetriesExactUUIDWithoutAnotherPromotion() throws {
        let effects = try coordinator()
        var promotions = 0
        storage.faults.beforePromotion = { promotions += 1 }
        storage.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try effects.prepare(id: id, requestJSON: request(), taskID: "task"))
        fixed(.unavailable) { try effects.markStarted(id: id) }
        storage.faults.afterPromotion = nil
        try effects.retryPublication(); XCTAssertEqual(promotions, 1); XCTAssertEqual(try effects.current()?.id, id)
        storage.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try effects.markStarted(id: id))
        fixed(.unavailable) { try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created"))) }
        storage.faults.afterPromotion = nil
        try effects.retryPublication(); XCTAssertEqual(promotions, 2); XCTAssertEqual(try effects.current()?.phase, .started)
        storage.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created"))))
        storage.faults.afterPromotion = nil
        try effects.retryPublication(); XCTAssertEqual(promotions, 3)
        XCTAssertEqual(try effects.current()?.id, id); XCTAssertEqual(try effects.current()?.result, .identifier("created"))
    }

    func testMalformedWrongLibraryAndChangedNamespaceNeverRepairStoredBytes() throws {
        let effects = try coordinator()
        fixed(.invalid) { try coordinator(library: "") }
        for raw in ["malformed", "", "{\"version\":true}"] {
            try replaceEffect(raw)
            let bytes = try Data(contentsOf: manifest)
            fixed(.invalid) { try effects.current() }
            fixed(.invalid) { try coordinator() }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        }
        let foreign = try NativeCalendarPushEffect(id: id, libraryID: "library-\u{e9}", requestJSON: request(), taskID: "task")
        try replaceEffect(foreign.encoded())
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.current() }; fixed(.invalid) { try coordinator() }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        try replaceEffect(nil); XCTAssertNil(try effects.current())
        var changed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
        changed["unknown"] = "external edit"
        try JSONSerialization.data(withJSONObject: changed).write(to: manifest)
        let external = try Data(contentsOf: manifest)
        XCTAssertThrowsError(try effects.current()); XCTAssertEqual(try Data(contentsOf: manifest), external)
    }

    func testCalendarSavedResultCannotUseEventMappingAcknowledgement() throws {
        let effects = try coordinator()
        _ = try effects.prepare(id: id, requestJSON: request("deleteCalendar"), taskID: nil)
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.completed))
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try effects.current()?.phase, .saved)
    }
}
