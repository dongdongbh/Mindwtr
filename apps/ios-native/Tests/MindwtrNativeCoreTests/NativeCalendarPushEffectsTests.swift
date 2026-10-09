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
    private let temporaryTitle = "Mindwtr (12345678-1234-4234-8234-123456789abc)"
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
    private func request(_ op: String = "createEvent", event: String = "event", calendar: String = "calendar", notes: String = "") throws -> String {
        var value: [String: Any] = ["op": op, "calendarId": calendar]
        if op == "updateEvent" || op == "deleteEvent" { value["eventId"] = event }
        if op == "createEvent" || op == "updateEvent" {
            value["details"] = ["title": "Synthetic", "startMs": 1_800_000_000_000,
                                "endMs": 1_800_003_600_000, "allDay": false, "notes": notes, "location": ""]
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
    private func assertUnrelatedPreserved(_ firstCells: [String?]? = nil, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try storage.readCalendarPushState().prefix(5).map { $0.map { Data($0.utf8) } },
                       (firstCells ?? firstFive.map { Optional($0) }).map { $0.map { Data($0.utf8) } }, file: file, line: line)
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
    private func setCalendarState(_ values: [String?]) throws {
        let before = try storage.readCalendarPushState(); var next = before
        XCTAssertEqual(values.count, 5)
        for index in 0..<5 { next[index] = values[index] }
        try storage.compareAndSetCalendarPushState(expected: before, next: next)
    }
    private func intent(calendar: String? = nil, revision: String? = nil) throws -> String {
        var value = ["title": temporaryTitle]
        if let calendar { value["calendarId"] = calendar }
        if let revision { value["deletionRevision"] = revision }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    private func calendarState(saved: String? = nil, selected: String? = "selected-e\u{301}", intent: String? = nil) -> [String?] {
        [firstFive[0], saved, selected, firstFive[3], intent]
    }
    private func calendarRequest(_ op: String, calendar: String = "calendar", title: String? = nil,
                                 color: String = "#aabbcc") throws -> String {
        var value: [String: Any] = ["op": op]
        if op == "createCalendar" {
            value["details"] = ["title": title ?? temporaryTitle, "color": color, "entityType": "event", "sourceId": "source"]
        } else {
            value["calendarId"] = calendar
            if op == "updateCalendar" {
                var details = ["color": color]
                if let title { details["title"] = title }
                value["details"] = details
            }
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func saveCalendar(_ effects: NativeCalendarPushEffects, requestJSON: String, createdID: String? = nil) throws {
        _ = try effects.prepare(id: id, requestJSON: requestJSON, taskID: nil)
        _ = try effects.markStarted(id: id)
        let outcome: NativeCalendarWriteOutcome = createdID.map { .succeeded(.identifier($0)) } ?? .succeeded(.completed)
        try effects.acceptCompletion(id: id, outcome: outcome)
    }
    private func assertCapacityRefusal(_ effects: NativeCalendarPushEffects, requestJSON: String, taskID: String?,
                                       file: StaticString = #filePath, line: UInt = #line) throws {
        let bytes = try Data(contentsOf: manifest)
        var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
        defer { storage.faults.beforePromotion = nil }
        fixed(.invalid, file: file, line: line) { try effects.prepare(id: id, requestJSON: requestJSON, taskID: taskID) }
        try effects.retryPublication()
        XCTAssertEqual(promotions, 0, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes, file: file, line: line)
        XCTAssertFalse(storage.hasPendingCalendarPushMutation, file: file, line: line)
        XCTAssertNil(try effects.current(), file: file, line: line)
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
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.denied)) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        _ = try effects.markStarted(id: id); bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.markStarted(id: id) }
        fixed(.invalid) { try effects.acceptCompletion(id: wrong, outcome: .notStarted) }
        fixed(.invalid) { try effects.acceptCompletion(id: wrong, outcome: .failedBeforeMutation(.denied)) }
        fixed(.invalid) { try effects.acceptCompletion(id: wrong, outcome: .confirmedMissingEvent) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .succeeded(.sources([]))) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .succeeded(.completed)) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
        bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .notStarted) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.denied)) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
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
                      .missingEvent, .invalid, .readOnly, .ambiguous, .recurring, .failed] {
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
                try effects.acceptCompletion(id: id, outcome: missing ? .confirmedMissingEvent : .succeeded(.completed))
                XCTAssertEqual(try effects.current()?.result, missing ? .missingEvent : .completed)
                let intended = !missing && op == "updateEvent" ? next : nil
                try effects.acknowledgeMapping(id: id, mapping: intended)
                XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), intended)
                if let intended { try database.compareAndSetCalendarPushMapping(taskID: "task", expected: intended, next: nil) }
            }
        }
        try assertUnrelatedPreserved()
    }

    func testFailedBeforeMutationClearsOnlyStartedEffectPreservingCompleteRowsAndRawState() throws {
        let effects = try coordinator(), before = try mapping(stamp: "exact-e\u{301}"), other = try mapping(task: "other")
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        try database.compareAndSetCalendarPushMapping(taskID: "other", expected: nil, next: other)
        _ = try database.execute("INSERT INTO calendar_sync VALUES ('task','android-event','android-calendar','android','original')")
        for error in [NativeCalendarWriteError.denied, .missingSource, .readOnly, .invalid, .failed, .missingEvent] {
            _ = try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task")
            _ = try effects.markStarted(id: id)
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(error))
            XCTAssertNil(try effects.current()); database.faults = nil
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: "other"), other)
            XCTAssertTrue(try database.execute("SELECT * FROM calendar_sync WHERE platform = 'android'").contains("android-event"))
            try assertUnrelatedPreserved()
        }
        try reopen(); XCTAssertNil(try coordinator().current())
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
    }

    func testColdPreparedDiscardClearsExactEffectPreservingCurrentChangedCellsAndMapping() throws {
        let before = try mapping()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        for calendar in [false, true] {
            let cells = calendar ? calendarState(intent: try intent()) : firstFive.map { Optional($0) }
            try setCalendarState(cells)
            let effects = try coordinator()
            let raw = calendar ? try calendarRequest("createCalendar") : try request("updateEvent")
            _ = try effects.prepare(id: id, requestJSON: raw, taskID: calendar ? nil : "task")
            let changed: [String?] = ["external-enabled", nil, "selected-e\u{301}", "\u{FEFF}legacy-color", "external-invalid-intent"]
            try setCalendarState(changed); try reopen()
            let cold = try coordinator(), bytes = try Data(contentsOf: manifest)
            XCTAssertEqual(try cold.current()?.phase, .prepared)
            fixed(.invalid) { try cold.discardPrepared(id: UUID()) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
            try cold.discardPrepared(id: id)
            XCTAssertEqual(promotions, 1); XCTAssertNil(try cold.current())
            fixed(.invalid) { try cold.discardPrepared(id: id) }
            try assertUnrelatedPreserved(changed)
            storage.faults.beforePromotion = nil; database.faults = nil
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
            try reopen(); XCTAssertNil(try coordinator().current()); try assertUnrelatedPreserved(changed)
        }
    }

    func testUnprovenMissingEventKeepsStartedAndCompleteMappingWithoutSQLIncludingColdRead() throws {
        let before = try mapping(stamp: "unchanged-e\u{301}"), effects = try coordinator()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        _ = try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task")
        _ = try effects.markStarted(id: id)
        let bytes = try Data(contentsOf: manifest)
        let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
        try effects.acceptCompletion(id: id, outcome: .failed(.missingEvent))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try effects.current()?.phase, .started)
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        fixed(.invalid) { try effects.discardPrepared(id: id) }
        fixed(.unavailable) { try effects.prepare(id: UUID(), requestJSON: request(), taskID: "other") }
        try reopen(); let cold = try coordinator()
        XCTAssertEqual(try cold.current()?.phase, .started); XCTAssertNil(try cold.current()?.result)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
        try assertUnrelatedPreserved()
    }

    func testConfirmedAbsenceColdAcknowledgmentStillRequiresExactFullMappingCAS() throws {
        let before = try mapping(), conflict = try mapping(event: "foreign", stamp: "different"), effects = try coordinator()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        _ = try effects.prepare(id: id, requestJSON: request("deleteEvent"), taskID: "task")
        _ = try effects.markStarted(id: id)
        let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
        try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent)
        XCTAssertEqual(try effects.current()?.result, .missingEvent); XCTAssertEqual(try effects.current()?.phase, .saved)
        database.faults = nil
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: before, next: conflict)
        try reopen(); let cold = try coordinator()
        XCTAssertThrowsError(try cold.acknowledgeMapping(id: id, mapping: nil))
        XCTAssertEqual(try cold.current()?.phase, .acknowledging); XCTAssertEqual(try cold.current()?.result, .missingEvent)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), conflict)
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: conflict, next: before)
        try cold.acknowledgeMapping(id: id, mapping: nil)
        XCTAssertNil(try cold.current()); XCTAssertNil(try database.readCalendarPushMapping(taskID: "task"))
        try assertUnrelatedPreserved()
    }

    func testCalendarConfirmedAbsenceRefusesWhileNoMutationFailurePreservesOwnedCells() throws {
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar"] {
            let cells = operation == "createCalendar" ? calendarState(intent: try intent()) : calendarState(saved: "calendar")
            try setCalendarState(cells); let effects = try coordinator()
            _ = try effects.prepare(id: id, requestJSON: calendarRequest(operation), taskID: nil)
            _ = try effects.markStarted(id: id)
            let bytes = try Data(contentsOf: manifest)
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
            try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.denied))
            XCTAssertNil(try effects.current()); try assertUnrelatedPreserved(cells); database.faults = nil
        }
    }

    func testPreparedDiscardRejectsEveryLaterPhaseAndNewOutcomesCannotClearAcknowledging() throws {
        let effects = try coordinator()
        fixed(.invalid) { try effects.discardPrepared(id: id) }
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.discardPrepared(id: UUID()) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        _ = try effects.markStarted(id: id)
        fixed(.invalid) { try effects.discardPrepared(id: id) }
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
        fixed(.invalid) { try effects.discardPrepared(id: id) }
        let intended = try mapping(event: "created")
        let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
        XCTAssertThrowsError(try effects.acknowledgeMapping(id: id, mapping: intended))
        let acknowledging = try Data(contentsOf: manifest)
        XCTAssertEqual(try effects.current()?.phase, .acknowledging)
        fixed(.invalid) { try effects.discardPrepared(id: id) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.denied)) }
        fixed(.invalid) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
        XCTAssertEqual(try Data(contentsOf: manifest), acknowledging)
        database.faults = nil; try effects.acknowledgeMapping(id: id, mapping: intended)
    }

    func testNoMutationClearAndPreparedDiscardRetryOnlyIdenticalSixCellPairAcrossFaultCuts() throws {
        let before = try mapping()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        for discard in [false, true] {
            for cut in ["before", "after", "readback"] {
                let effects = try coordinator()
                _ = try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task")
                if !discard { _ = try effects.markStarted(id: id) }
                let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
                var promotions = 0
                storage.faults.beforePromotion = { promotions += 1; if cut == "before" { throw Injected.failure } }
                if cut == "after" { storage.faults.afterPromotion = { throw Injected.failure } }
                if cut == "readback" { storage.faults.beforeReadback = { throw Injected.failure } }
                if discard { XCTAssertThrowsError(try effects.discardPrepared(id: id)) }
                else { XCTAssertThrowsError(try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.missingEvent))) }
                XCTAssertTrue(storage.hasPendingCalendarPushMutation)
                let bytes = try Data(contentsOf: manifest)
                fixed(.unavailable) { try effects.current() }
                fixed(.unavailable) { try effects.discardPrepared(id: id) }
                fixed(.unavailable) { try effects.discardPrepared(id: UUID()) }
                fixed(.unavailable) { try effects.acceptCompletion(id: id, outcome: .confirmedMissingEvent) }
                fixed(.unavailable) { try effects.prepare(id: UUID(), requestJSON: request(), taskID: "other") }
                XCTAssertEqual(try Data(contentsOf: manifest), bytes)
                storage.faults.beforePromotion = { promotions += 1 }; storage.faults.afterPromotion = nil; storage.faults.beforeReadback = nil
                try effects.retryPublication()
                XCTAssertEqual(promotions, cut == "before" ? 2 : 1)
                XCTAssertFalse(storage.hasPendingCalendarPushMutation); XCTAssertNil(try effects.current())
                if cut != "before" { XCTAssertEqual(try Data(contentsOf: manifest), bytes) }
                try assertUnrelatedPreserved(); database.faults = nil; storage.faults.beforePromotion = nil
                XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
                try reopen(); XCTAssertNil(try coordinator().current())
                XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
            }
        }
    }

    func testColdPreparedDiscardAfterLostReplySettlesOnlyPreparedOrObservesCommittedClear() throws {
        let before = try mapping()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        for committed in [false, true] {
            let effects = try coordinator()
            _ = try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task")
            if committed { storage.faults.afterPromotion = { throw Injected.failure } }
            else { storage.faults.beforePromotion = { throw Injected.failure } }
            XCTAssertThrowsError(try effects.discardPrepared(id: id))
            try reopen(); let cold = try coordinator()
            if committed { XCTAssertNil(try cold.current()) }
            else {
                XCTAssertEqual(try cold.current()?.phase, .prepared)
                try cold.discardPrepared(id: id); XCTAssertNil(try cold.current())
            }
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
            try assertUnrelatedPreserved()
        }
    }

    func testColdUncommittedNoMutationClearRetainsStartedWithoutItsVolatileProof() throws {
        let before = try mapping(), effects = try coordinator()
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        _ = try effects.prepare(id: id, requestJSON: request("updateEvent"), taskID: "task")
        _ = try effects.markStarted(id: id)
        let bytes = try Data(contentsOf: manifest)
        storage.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try effects.acceptCompletion(id: id, outcome: .failedBeforeMutation(.denied)))
        try reopen(); let cold = try coordinator()
        XCTAssertEqual(try cold.current()?.phase, .started)
        fixed(.invalid) { try cold.discardPrepared(id: id) }
        fixed(.unavailable) { try cold.prepare(id: UUID(), requestJSON: request(), taskID: "other") }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
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
        fixed(.unavailable) { try effects.discardPrepared(id: id) }
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
            fixed(.invalid) { try effects.discardPrepared(id: id) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        }
        let foreign = try NativeCalendarPushEffect(id: id, libraryID: "library-\u{e9}", requestJSON: request(), taskID: "task")
        try replaceEffect(foreign.encoded())
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.current() }; fixed(.invalid) { try coordinator() }
        fixed(.invalid) { try effects.discardPrepared(id: id) }
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
        try setCalendarState(calendarState(saved: "calendar"))
        _ = try effects.prepare(id: id, requestJSON: request("deleteCalendar"), taskID: nil)
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.completed))
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acknowledgeMapping(id: id, mapping: nil) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try effects.current()?.phase, .saved)
    }

    func testCalendarCreateAtomicallyBindsExactJSIntentAndReturnedIDPreservingStaleIDBaseline() throws {
        let effects = try coordinator(), before = calendarState(saved: "stale/e\u{301}", intent: try intent())
        try setCalendarState(before)
        let returnedID = "created/e\u{301} 🧠\"\n\\\u{2028}"
        let prepared = try effects.prepare(id: id, requestJSON: calendarRequest("createCalendar"), taskID: nil)
        XCTAssertEqual(prepared.beforeCalendarState?.map { $0.map { Data($0.utf8) } }, before.map { $0.map { Data($0.utf8) } })
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier(returnedID)))
        var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
        try effects.acknowledgeCalendar(id: id)
        XCTAssertEqual(promotions, 1); XCTAssertNil(try effects.current())
        var expected = before; expected[1] = returnedID
        expected[4] = "{\"title\":\"\(temporaryTitle)\",\"calendarId\":\"created/e\u{301} 🧠\\\"\\n\\\\\u{2028}\"}"
        try assertUnrelatedPreserved(expected)
        let state = try storage.readCalendarPushState(), bytes = try Data(contentsOf: manifest)
        storage.faults.beforePromotion = { throw Injected.failure }
        try storage.compareAndSetCalendarPushState(expected: state, next: state)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        try reopen(); XCTAssertNil(try coordinator().current()); try assertUnrelatedPreserved(expected)
    }

    func testCalendarRenameClearsOnlyBoundIntentAndColorAcknowledgementStoresUppercaseRequest() throws {
        let effects = try coordinator(), owned = "calendar-e\u{301}"
        let before = calendarState(saved: owned, intent: try intent(calendar: owned))
        try setCalendarState(before)
        try saveCalendar(effects, requestJSON: calendarRequest("updateCalendar", calendar: owned, title: "Mindwtr"))
        try effects.acknowledgeCalendar(id: id)
        var expected = before; expected[4] = nil
        try assertUnrelatedPreserved(expected); XCTAssertNil(try effects.current())
        try saveCalendar(effects, requestJSON: calendarRequest("updateCalendar", calendar: owned, color: "#aB09fF"))
        try effects.acknowledgeCalendar(id: id)
        expected[3] = "#AB09FF"
        try assertUnrelatedPreserved(expected); XCTAssertNil(try effects.current())
    }

    func testCalendarDeleteClearsOnlyMatchingOwnedIntentAndSelectedTargetIncludingColdBoundRecovery() throws {
        for selected in ["calendar-e\u{301}", "calendar-\u{e9}", "other-e\u{301}"] {
            for saved in [Optional("calendar-e\u{301}"), nil] {
                let effects = try coordinator(), owned = "calendar-e\u{301}"
                let before = calendarState(saved: saved, selected: selected,
                    intent: try intent(calendar: owned, revision: String(repeating: "a", count: 32)))
                try setCalendarState(before)
                try saveCalendar(effects, requestJSON: calendarRequest("deleteCalendar", calendar: owned))
                try reopen()
                let cold = try coordinator(); XCTAssertEqual(try cold.current()?.phase, .saved)
                // The caller must freshly prove provider absence under its exact owner before this cold call.
                try cold.acknowledgeCalendar(id: id)
                var expected = before; expected[1] = nil; expected[4] = nil
                if Data(selected.utf8) == Data(owned.utf8) { expected[2] = nil }
                try assertUnrelatedPreserved(expected); XCTAssertNil(try cold.current())
            }
        }
        let effects = try coordinator(), before = calendarState(saved: "calendar")
        try setCalendarState(before)
        try saveCalendar(effects, requestJSON: calendarRequest("deleteCalendar"))
        try effects.acknowledgeCalendar(id: id)
        var expected = before; expected[1] = nil
        try assertUnrelatedPreserved(expected); XCTAssertNil(try effects.current())
    }

    func testCalendarAdmissionRefusesUnownedRequestsInvalidOrUnresolvedIntentsWithoutPublication() throws {
        let effects = try coordinator(), unbound = try intent(), bound = try intent(calendar: "calendar")
        let deleting = try intent(calendar: "calendar", revision: String(repeating: "a", count: 32))
        let cases: [([String?], String, String, String?)] = [
            (calendarState(intent: unbound), "createCalendar", "calendar", "Mindwtr"),
            (calendarState(intent: bound), "createCalendar", "calendar", nil),
            (calendarState(), "createCalendar", "calendar", nil),
            (calendarState(saved: "" , intent: unbound), "createCalendar", "calendar", nil),
            (calendarState(saved: "calendar"), "updateCalendar", "other", nil),
            (calendarState(saved: "calendar", intent: bound), "updateCalendar", "calendar", nil),
            (calendarState(saved: "calendar"), "updateCalendar", "calendar", "Mindwtr"),
            (calendarState(saved: "calendar", intent: bound), "updateCalendar", "calendar", "Other"),
            (calendarState(saved: "calendar", intent: deleting), "updateCalendar", "calendar", "Mindwtr"),
            (calendarState(saved: "other", intent: bound), "updateCalendar", "calendar", "Mindwtr"),
            (calendarState(), "deleteCalendar", "calendar", nil),
            (calendarState(saved: "calendar", intent: unbound), "deleteCalendar", "calendar", nil),
            (calendarState(saved: "calendar", intent: bound), "deleteCalendar", "calendar", nil),
            (calendarState(saved: "other", intent: deleting), "deleteCalendar", "calendar", nil)
        ]
        for (state, op, calendar, title) in cases {
            try setCalendarState(state); let bytes = try Data(contentsOf: manifest)
            fixed(.invalid) { try effects.prepare(id: id, requestJSON: calendarRequest(op, calendar: calendar, title: title), taskID: nil) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertNil(try effects.current())
        }
        let malformed = ["null", "", "{\"title\":\"Mindwtr\"}",
            "{\"title\":\"\(temporaryTitle)\",\"extra\":true}",
            "{\"title\":\"\(temporaryTitle)\",\"title\":\"\(temporaryTitle)\"}",
            "{\"title\":\"\(temporaryTitle)\",\"calendarId\":\"calendar\",\"deletionRevision\":\"BAD\"}",
            "{\"title\":\"\(temporaryTitle.replacingOccurrences(of: "-4234-", with: "-1234-"))\"}"]
        for raw in malformed {
            try setCalendarState(calendarState(intent: raw)); let bytes = try Data(contentsOf: manifest)
            fixed(.invalid) { try effects.prepare(id: id, requestJSON: calendarRequest("createCalendar"), taskID: nil) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        }
        try setCalendarState(calendarState(saved: "calendar"))
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: calendarRequest("updateCalendar", color: "red"), taskID: nil) }
    }

    func testCalendarAcknowledgementRequiresExactUUIDSavedPhaseAndUnchangedFiveCellRevision() throws {
        let effects = try coordinator(), before = calendarState(saved: "calendar",
            intent: try intent(calendar: "calendar", revision: String(repeating: "a", count: 32)))
        fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
        try setCalendarState(before)
        _ = try effects.prepare(id: id, requestJSON: calendarRequest("deleteCalendar"), taskID: nil)
        fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
        _ = try effects.markStarted(id: id)
        fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
        try effects.acceptCompletion(id: id, outcome: .succeeded(.completed))
        let bytes = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acknowledgeCalendar(id: UUID()) }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        var changedRevision = before
        changedRevision[4] = try intent(calendar: "calendar", revision: String(repeating: "b", count: 32))
        try setCalendarState(changedRevision); let rebound = try Data(contentsOf: manifest)
        fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
        XCTAssertEqual(try Data(contentsOf: manifest), rebound); try setCalendarState(before)
        for index in 0..<5 {
            var changed = before; changed[index] = (before[index] ?? "") + "changed"
            try setCalendarState(changed); let altered = try Data(contentsOf: manifest)
            fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
            XCTAssertEqual(try Data(contentsOf: manifest), altered); XCTAssertEqual(try effects.current()?.phase, .saved)
            try setCalendarState(before)
        }
        try effects.acknowledgeCalendar(id: id); XCTAssertNil(try effects.current())
        _ = try effects.prepare(id: id, requestJSON: request(), taskID: "task")
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier("created")))
        fixed(.invalid) { try effects.acknowledgeCalendar(id: id) }
        XCTAssertEqual(try effects.current()?.phase, .saved)
    }

    func testCalendarFrozenStateRecordOverflowRefusesBeforePublication() throws {
        var state = calendarState(intent: try intent()); state[0] = String(repeating: "\n", count: 600_000)
        try setCalendarState(state)
        let effects = try coordinator(), bytes = try Data(contentsOf: manifest)
        var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: calendarRequest("createCalendar"), taskID: nil) }
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertNil(try effects.current()); try effects.retryPublication()
    }

    func testExactLimitPreparedCalendarCannotAdmitAnUnsaveableProviderResult() throws {
        let raw = try calendarRequest("createCalendar")
        var state = calendarState(intent: try intent())
        let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                beforeCalendarState: state)
        state[3] = (state[3] ?? "") + String(repeating: "x", count:
            NativeCalendarJobs.maximumRequestBytes - (try base.encoded().utf8.count))
        let full = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                beforeCalendarState: state)
        XCTAssertEqual(try full.encoded().utf8.count, NativeCalendarJobs.maximumRequestBytes)
        let started = try full.markingStarted()
        fixed(.invalid) { try started.recording(result: .identifier("created")) }
        try setCalendarState(state)
        let effects = try coordinator(), bytes = try Data(contentsOf: manifest)
        var promotions = 0; storage.faults.beforePromotion = { promotions += 1 }
        fixed(.invalid) { try effects.prepare(id: id, requestJSON: raw, taskID: nil) }
        try effects.retryPublication()
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertFalse(storage.hasPendingCalendarPushMutation); XCTAssertNil(try effects.current())
        try reopen(); XCTAssertNil(try coordinator().current()); try assertUnrelatedPreserved(state)
    }

    func testEachCalendarAdmissionReservesExactlyItsMaximumSavedResultAndSettles() throws {
        let maximumID = String(repeating: "\0", count: 1024), limit = NativeCalendarJobs.maximumRequestBytes
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar"] {
            let create = operation == "createCalendar"
            let raw = try calendarRequest(operation)
            var state = create ? calendarState(intent: try intent()) : calendarState(saved: "calendar")
            let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                    beforeCalendarState: state)
            let result: NativeCalendarPushEffect.Result = create ? .identifier(maximumID) : .completed
            let future = try base.markingStarted().recording(result: result)
            state[3] = (state[3] ?? "") + String(repeating: "x", count: limit - (try future.encoded().utf8.count))
            let full = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                    beforeCalendarState: state)
            XCTAssertEqual(try full.markingStarted().recording(result: result).encoded().utf8.count, limit)
            var tooLarge = state; tooLarge[3] = (tooLarge[3] ?? "") + "x"
            try setCalendarState(tooLarge)
            let effects = try coordinator()
            try assertCapacityRefusal(effects, requestJSON: raw, taskID: nil)
            try setCalendarState(state)
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            try saveCalendar(effects, requestJSON: raw, createdID: create ? maximumID : nil)
            XCTAssertEqual(try effects.current()?.encoded().utf8.count, limit)
            try effects.acknowledgeCalendar(id: id)
            XCTAssertNil(try effects.current()); database.faults = nil
            var expected = state
            if create {
                expected[1] = maximumID
                expected[4] = "{\"title\":\"\(temporaryTitle)\",\"calendarId\":\"\(String(repeating: "\\u0000", count: 1024))\"}"
            } else if operation == "updateCalendar" { expected[3] = "#AABBCC" }
            else { expected[1] = nil; expected[4] = nil }
            try assertUnrelatedPreserved(expected)
            try reopen(); XCTAssertNil(try coordinator().current()); try assertUnrelatedPreserved(expected)
        }
    }

    func testEventCreateExactAcknowledgmentLimitAdmitsMaximumIdentifierAndTimestampWithoutHeadroom() throws {
        let maximumID = String(repeating: "\0", count: 1024), maximumStamp = String(repeating: "\0", count: 128)
        let next = try mapping(event: maximumID, stamp: maximumStamp), limit = NativeCalendarJobs.maximumRequestBytes
        let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID,
            requestJSON: NativeCalendarPushWitness.markCreateEvent(requestJSON: request(), id: id), taskID: "task")
        let future = try base.markingStarted().recording(result: .identifier(maximumID)).acknowledging(mapping: next)
        let padding = limit - (try future.encoded().utf8.count)
        let raw = try request(notes: String(repeating: "x", count: padding))
        let full = try NativeCalendarPushEffect(id: id, libraryID: libraryID,
            requestJSON: NativeCalendarPushWitness.markCreateEvent(requestJSON: raw, id: id), taskID: "task")
        XCTAssertEqual(try full.markingStarted().recording(result: .identifier(maximumID))
            .acknowledging(mapping: next).encoded().utf8.count, limit)
        let effects = try coordinator()
        try assertCapacityRefusal(effects, requestJSON: request(notes: String(repeating: "x", count: padding + 1)), taskID: "task")
        _ = try effects.prepare(id: id, requestJSON: raw, taskID: "task")
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.identifier(maximumID)))
        try reopen(); let cold = try coordinator()
        XCTAssertEqual(try cold.current()?.result, .identifier(maximumID))
        try cold.acknowledgeMapping(id: id, mapping: next)
        XCTAssertNil(try cold.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), next)
        try assertUnrelatedPreserved()
        try reopen(); XCTAssertNil(try coordinator().current())
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), next)
    }

    func testEventUpdateExactAcknowledgmentLimitUsesFrozenIDsAndMaximumTimestamp() throws {
        let taskID = String(repeating: "\0", count: 1024), calendarID = String(repeating: "\0", count: 1024)
        let eventID = "captured/event\0e\u{301}", stamp = String(repeating: "\0", count: 128)
        let before = try mapping(task: taskID, event: eventID, calendar: calendarID)
        let next = try mapping(task: taskID, event: eventID, calendar: calendarID, stamp: stamp)
        try database.compareAndSetCalendarPushMapping(taskID: taskID, expected: nil, next: before)
        let raw = try request("updateEvent", event: eventID, calendar: calendarID)
        let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                taskID: taskID, beforeMapping: before)
        let future = try base.markingStarted().recording(result: .completed).acknowledging(mapping: next)
        let fullRaw = raw + String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes - (try future.encoded().utf8.count))
        let full = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: fullRaw,
                                                taskID: taskID, beforeMapping: before)
        XCTAssertEqual(try full.markingStarted().recording(result: .completed).acknowledging(mapping: next)
            .encoded().utf8.count, NativeCalendarJobs.maximumRequestBytes)
        let effects = try coordinator()
        try assertCapacityRefusal(effects, requestJSON: fullRaw + " ", taskID: taskID)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: taskID), before)
        let prepared = try effects.prepare(id: id, requestJSON: fullRaw, taskID: taskID)
        XCTAssertEqual(Data(prepared.requestJSON.utf8), Data(fullRaw.utf8)); XCTAssertEqual(prepared.beforeMapping, before)
        _ = try effects.markStarted(id: id)
        try effects.acceptCompletion(id: id, outcome: .succeeded(.completed))
        try effects.acknowledgeMapping(id: id, mapping: next)
        XCTAssertNil(try effects.current()); XCTAssertEqual(try database.readCalendarPushMapping(taskID: taskID), next)
        try assertUnrelatedPreserved()
    }

    func testEventDeleteReservesLongerMissingEventAndNilAcknowledgmentAtExactLimit() throws {
        let before = try mapping(), raw = try request("deleteEvent"), limit = NativeCalendarJobs.maximumRequestBytes
        let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw,
                                                taskID: "task", beforeMapping: before)
        let future = try base.markingStarted().recording(result: .missingEvent).acknowledging(mapping: nil)
        let fullRaw = raw + String(repeating: " ", count: limit - (try future.encoded().utf8.count))
        let tooLarge = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: fullRaw + " ",
                                                    taskID: "task", beforeMapping: before).markingStarted()
        XCTAssertLessThan(try tooLarge.recording(result: .completed).acknowledging(mapping: nil).encoded().utf8.count, limit)
        let savedMissing = try tooLarge.recording(result: .missingEvent)
        fixed(.invalid) { try savedMissing.acknowledging(mapping: nil) }
        let outcomes: [NativeCalendarWriteOutcome] = [.succeeded(.completed), .confirmedMissingEvent]
        for outcome in outcomes {
            try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
            let effects = try coordinator()
            try assertCapacityRefusal(effects, requestJSON: fullRaw + " ", taskID: "task")
            XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
            _ = try effects.prepare(id: id, requestJSON: fullRaw, taskID: "task")
            _ = try effects.markStarted(id: id)
            try effects.acceptCompletion(id: id, outcome: outcome)
            let saved = try XCTUnwrap(effects.current())
            if saved.result == .missingEvent {
                XCTAssertEqual(try saved.acknowledging(mapping: nil).encoded().utf8.count, limit)
            }
            try effects.acknowledgeMapping(id: id, mapping: nil)
            XCTAssertNil(try effects.current()); XCTAssertNil(try database.readCalendarPushMapping(taskID: "task"))
            try assertUnrelatedPreserved()
        }
    }

    func testColdValidBoundaryRecordsAreReadWithoutApplyingNewAdmissionPreflight() throws {
        let raw = try calendarRequest("createCalendar"), limit = NativeCalendarJobs.maximumRequestBytes
        var state = calendarState(intent: try intent())
        let base = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw, beforeCalendarState: state)
        state[3] = (state[3] ?? "") + String(repeating: "x", count: limit - (try base.encoded().utf8.count))
        let prepared = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: raw, beforeCalendarState: state)
        try setCalendarState(state)
        for effect in [prepared, try prepared.markingStarted()] {
            let encoded = try effect.encoded(); try replaceEffect(encoded); try reopen()
            let bytes = try Data(contentsOf: manifest), cold = try coordinator()
            let recovered = try XCTUnwrap(cold.current())
            XCTAssertEqual(recovered.phase, effect.phase)
            XCTAssertEqual(Data(try recovered.encoded().utf8), Data(encoded.utf8))
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        }
        try replaceEffect(nil)
        let before = try mapping(), updateRaw = try request("updateEvent")
        try database.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: before)
        let baseSaved = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: updateRaw,
            taskID: "task", beforeMapping: before).markingStarted().recording(result: .completed)
        let saved = try NativeCalendarPushEffect(id: id, libraryID: libraryID,
            requestJSON: updateRaw + String(repeating: " ", count: limit - (try baseSaved.encoded().utf8.count)),
            taskID: "task", beforeMapping: before).markingStarted().recording(result: .completed)
        XCTAssertEqual(try saved.encoded().utf8.count, limit)
        fixed(.invalid) { try saved.acknowledging(mapping: mapping(stamp: "after")) }
        let encoded = try saved.encoded(); try replaceEffect(encoded); try reopen()
        let bytes = try Data(contentsOf: manifest), cold = try coordinator()
        let recovered = try XCTUnwrap(cold.current())
        XCTAssertEqual(recovered.phase, .saved)
        XCTAssertEqual(Data(try recovered.encoded().utf8), Data(encoded.utf8))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try database.readCalendarPushMapping(taskID: "task"), before)
    }

    func testCalendarAtomicAcknowledgementLostReplyRetriesOnlyExactSixCellPair() throws {
        for cut in ["before", "after", "readback"] {
            let effects = try coordinator(), before = calendarState(intent: try intent())
            try setCalendarState(before)
            try saveCalendar(effects, requestJSON: calendarRequest("createCalendar"), createdID: "created")
            var promotions = 0
            storage.faults.beforePromotion = { promotions += 1; if cut == "before" { throw Injected.failure } }
            if cut == "after" { storage.faults.afterPromotion = { throw Injected.failure } }
            if cut == "readback" { storage.faults.beforeReadback = { throw Injected.failure } }
            XCTAssertThrowsError(try effects.acknowledgeCalendar(id: id)); XCTAssertTrue(storage.hasPendingCalendarPushMutation)
            let bytes = try Data(contentsOf: manifest)
            fixed(.unavailable) { try effects.current() }
            fixed(.unavailable) { try effects.acknowledgeCalendar(id: UUID()) }
            fixed(.unavailable) { try effects.prepare(id: UUID(), requestJSON: calendarRequest("createCalendar"), taskID: nil) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes)
            storage.faults.beforePromotion = { promotions += 1 }; storage.faults.afterPromotion = nil; storage.faults.beforeReadback = nil
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            try effects.retryPublication()
            XCTAssertEqual(promotions, cut == "before" ? 2 : 1); XCTAssertNil(try effects.current())
            var expected = before; expected[1] = "created"
            expected[4] = "{\"title\":\"\(temporaryTitle)\",\"calendarId\":\"created\"}"
            try assertUnrelatedPreserved(expected)
            database.faults = nil; storage.faults.beforePromotion = nil
        }
    }

    func testCalendarAcknowledgementColdReopenSettlesSavedOrObservesCommittedClear() throws {
        for committed in [false, true] {
            let effects = try coordinator(), before = calendarState(saved: "calendar")
            try setCalendarState(before)
            try saveCalendar(effects, requestJSON: calendarRequest("updateCalendar", color: "#aabbcc"))
            if committed { storage.faults.afterPromotion = { throw Injected.failure } }
            else { storage.faults.beforePromotion = { throw Injected.failure } }
            XCTAssertThrowsError(try effects.acknowledgeCalendar(id: id))
            try reopen(); let cold = try coordinator()
            if committed { XCTAssertNil(try cold.current()) }
            else {
                XCTAssertEqual(try cold.current()?.phase, .saved)
                try cold.acknowledgeCalendar(id: id); XCTAssertNil(try cold.current())
            }
            var expected = before; expected[3] = "#AABBCC"
            try assertUnrelatedPreserved(expected)
        }
    }

    func testColdSavedCalendarCreateAndRenameSettleFrozenOperationWithoutSQL() throws {
        for create in [true, false] {
            let effects = try coordinator()
            let before = create ? calendarState(intent: try intent()) : calendarState(saved: "calendar", intent: try intent(calendar: "calendar"))
            try setCalendarState(before)
            let raw = try calendarRequest(create ? "createCalendar" : "updateCalendar", title: create ? nil : "Mindwtr")
            try saveCalendar(effects, requestJSON: raw, createdID: create ? "created" : nil)
            try reopen(); let cold = try coordinator(), frozen = try XCTUnwrap(cold.current())
            XCTAssertEqual(frozen.phase, .saved); XCTAssertEqual(Data(frozen.requestJSON.utf8), Data(raw.utf8))
            let forbid = HostIOFaults(); forbid.beforeSQL = { _ in throw Injected.failure }; database.faults = forbid
            try cold.acknowledgeCalendar(id: frozen.id)
            var expected = before
            if create {
                expected[1] = "created"; expected[4] = "{\"title\":\"\(temporaryTitle)\",\"calendarId\":\"created\"}"
            } else { expected[4] = nil }
            try assertUnrelatedPreserved(expected); XCTAssertNil(try cold.current())
            database.faults = nil
        }
    }
}
