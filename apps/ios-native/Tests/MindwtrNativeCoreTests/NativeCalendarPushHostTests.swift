import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CalendarPushHostProvider: NativeCalendarWriteWitnessing, @unchecked Sendable {
    let reader = CalendarTestReader()
    var eventID = " event-e\u{301} "
    var beforeCreate: ((Int, NativeCalendarWriteRequest) throws -> Void)?
    private let lock = NSLock()
    private var recorded: [NativeCalendarWriteRequest] = []
    var writes: [NativeCalendarWriteRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    func permissions() throws -> NativeCalendarPermission { try reader.permissions() }
    func calendars() throws -> [[String: Any]] { try reader.calendars() }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        try reader.events(calendarIds: calendarIds, start: start, end: end)
    }
    func sources() throws -> [NativeCalendarSource] { throw NativeCalendarWriteError.unavailable }
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteCalendar(calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteEvent(eventID: String, calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue {
        guard case .createEvent = request else { throw NativeCalendarWriteError.unavailable }
        lock.lock(); let count = recorded.count + 1; lock.unlock()
        try beforeCreate?(count, request)
        beforeProviderMutation()
        lock.lock(); recorded.append(request); lock.unlock()
        return .identifier(eventID + String(count))
    }
}

final class NativeCalendarPushHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.example.mindwtr.calendar-push"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container") }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private let calendarID = " calendar-e\u{301} "
    private let taskID = " task-e\u{301} "
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Actual iOS bundle required") }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/calendar-push/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeCalendarWriteError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws {
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), as: UTF8.self)
    }
    private func host(enabled: Bool = false, probe: String? = nil, storage: Bool = true,
                      preserveManifest: Bool = false, provider: (any NativeCalendarReading)? = nil) async throws -> CoreHost {
        if !preserveManifest {
            try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(json(["mindwtr:calendar-push-sync:enabled": enabled ? "1" : "0",
                           "mindwtr-system-calendar-settings": "{\"enabled\":false,\"selectAll\":true,\"selectedCalendarIds\":[]}",
                           "mindwtr-external-calendars": "[]", "unknown": "preserve"]).utf8).write(to: manifest)
        }
        var selected = bundle!
        if let probe {
            selected = root.appendingPathComponent("probe.js")
            let suffix = """
            ;(()=>{
              const oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000;
              MindwtrHost.iosCalendarPushRun=json=>{const id=String(++next);Promise.resolve().then(async()=>{\(probe)}).then(
                value=>replies.set(id,JSON.stringify({ok:true,value})),
                error=>replies.set(id,JSON.stringify({ok:false,error:String(error.message)})));return id;};
              MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const r=replies.get(id);if(!r)return null;replies.delete(id);return r;})():oldPoll(id);
            })();
            """
            try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: selected, atomically: true, encoding: .utf8)
        }
        let faults = HostIOFaults(), reader = provider ?? CalendarTestReader()
        faults.calendarReaderFactory = { reader }
        faults.calendarAuthorizationRequest = { XCTFail("Push must not prompt for access"); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let value = CoreHost(databaseURL: database, bundleURL: selected, faults: faults,
            deviceStorage: storage ? (containerURL: container, bundleIdentifier: namespace) : nil)
        addTeardownBlock { await value.close() }
        _ = try await value.start()
        return value
    }

    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    private func physicalLibraryID() throws -> String {
        var identity = stat()
        guard Darwin.lstat(database.path, &identity) == 0 else { throw NativeCalendarWriteError.unavailable }
        return try json([namespace, database.path, String(identity.st_dev), String(identity.st_ino)])
    }
    private func withEffects<T>(_ work: (NativeCalendarPushEffects, SQLiteBridge, NativeDeviceKV) throws -> T) throws -> T {
        // Call only with the host closed: this acquires the same real namespace lease.
        let storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace)
        defer { storage.close() }
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        let effects = try NativeCalendarPushEffects(storage: storage, database: sqlite, libraryID: physicalLibraryID())
        return try work(effects, sqlite, storage)
    }
    private func eventRequest(startMs: Int64 = 70_262_315_826_648) throws -> String {
        try json(["op": "createEvent", "calendarId": calendarID,
                  "details": ["title": "Synthetic", "startMs": startMs, "endMs": startMs + 3_600_000,
                              "allDay": false, "notes": "Original notes", "location": "Original location"]])
    }
    private func persistedStartedCreate() async throws -> NativeCalendarPushEffect {
        let bootstrap = try await host(); await bootstrap.close()
        return try withEffects { effects, _, _ in
            let id = UUID()
            _ = try effects.prepare(id: id, requestJSON: eventRequest(), taskID: taskID)
            return try effects.markStarted(id: id)
        }
    }
    private func exactEvent(_ effect: NativeCalendarPushEffect, id: String = " recovered-e\u{301} ") throws -> [String: Any] {
        guard case .createEvent(let calendar, let details) = effect.request else { throw NativeCalendarWriteError.invalid }
        // These exact provider milliseconds avoid deriving the witness from a lossy Date formatter.
        return ["id": id, "calendarId": calendar, "title": details.title, "notes": details.notes,
                "location": details.location, "startDate": "4196-07-10T05:57:06.648Z",
                "endDate": "4196-07-10T06:57:06.648Z", "allDay": false, "isRecurring": false]
    }
    private func assertOrdinaryTaskWrite(_ value: CoreHost) async throws {
        let title = "Ordinary task after blocked Calendar push", id = UUID().uuidString.lowercased()
        let opened = try object(await value.call("captureOpen"))
        let request = try json(["text": title, "options": XCTUnwrap(opened["options"]),
                                "captureId": id, "openAfterSave": false])
        let saved = try object(await value.call("captureSubmit", argumentsJSON: json([request])))
        XCTAssertEqual(saved["kind"] as? String, "saved"); XCTAssertEqual(saved["taskId"] as? String, id)
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(
            "SELECT title FROM tasks WHERE id = ?", parametersJSON: json([id])).utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 1); XCTAssertEqual(rows.first?["title"] as? String, title)
    }

    func testDisabledLifecycleUsesActualBundleAndRemainsStopped() async throws {
        let value = try await host()
        let started = try await value.calendarPush(.start)
        XCTAssertEqual(started, "false")
        let result = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        XCTAssertEqual(result, "null")
        let stopped = try await value.calendarPush(.stop)
        XCTAssertEqual(stopped, "null")
    }

    func testGenericCallCannotInvokeAnyPushFacade() async throws {
        let value = try await host()
        for method in ["iosCalendarPushStart", "iosCalendarPushStop", "iosCalendarPushRun", "iosCalendarPushSetting", "iosCalendarPushDiagnostic"] {
            do { _ = try await value.call(method); XCTFail("Generic method admitted: " + method) }
            catch { XCTAssertTrue(error.localizedDescription.contains("NOT_READY")) }
        }
    }

    func testLifecycleDiagnosticAcceptsOnlyItsContentFreeConfirmation() async throws {
        let value = try await host()
        let message = "Native iOS calendar push lifecycle completed"
        let context = ["releaseCheck": "v1.3.5/ios-calendar-push-lifecycle", "outcome": "confirmed"]
        let result = try await value.call("logLine", argumentsJSON: json([message, json(context)]))
        XCTAssertEqual(result, "{}")
        for invalid in [context.merging(["outcome": "saved"], uniquingKeysWith: { _, next in next }),
                        context.merging(["calendarId": "private"], uniquingKeysWith: { _, next in next })] {
            do { _ = try await value.call("logLine", argumentsJSON: json([message, json(invalid)])); XCTFail("Unaudited diagnostic admitted") }
            catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT")) }
        }
    }

    func testSharedDisableUsesOwnedStateCASAndPreservesUnrelatedPreferences() async throws {
        let value = try await host(enabled: true)
        let request = try json(["requestId": UUID().uuidString.lowercased(),
                                "edit": ["type": "push", "before": true, "enabled": false]])
        let raw = try await value.calendarPush(.setting, argumentsJSON: request)
        let result = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        XCTAssertEqual(result["changed"] as? Bool, true)
        let manifest = root.appendingPathComponent("container/Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        let state = try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
        XCTAssertEqual(state["mindwtr:calendar-push-sync:enabled"] as? String, "0")
        XCTAssertEqual(state["unknown"] as? String, "preserve")
    }

    func testOwnedPrivateReadUsesWorkerAndDoesNotExposeEffectCell() async throws {
        let value = try await host(probe: "return {permission:await __mindwtrCalendarPushCall({op:'read',request:{op:'permissions'}}),state:await __mindwtrCalendarPushCall({op:'readState'})};")
        let raw = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        let reply = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        let cells = try XCTUnwrap(reply["state"] as? [Any])
        XCTAssertEqual(cells.count, 5)
        XCTAssertEqual(cells[0] as? String, "0")
        XCTAssertNotNil(reply["permission"])
    }

    func testOwnedPrivateRunCannotChangeSettingOrUseGenericSQL() async throws {
        let value = try await host(probe: "const denied=[];for(const f of [()=>__mindwtrCalendarPushCall({op:'setState',name:'mindwtr:calendar-push-sync:enabled',value:'1'}),()=>{const r=__mindwtrNative.sqlExec('DELETE FROM tasks');if(typeof r==='string'&&r.startsWith('!MindwtrNativeError:'))throw Error('refused');return r;}]){try{await f();denied.push(false);}catch{denied.push(true);}}return denied;")
        let raw = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        XCTAssertEqual(try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [Bool], [true, true])
    }

    func testCapabilityOffAndMalformedRunsRemainUnavailable() async throws {
        let value = try await host(storage: false)
        for input in ["{\"ids\":null}", "{\"ids\":[] ,\"ids\":null}", "{\"ids\":[\"\"]}"] {
            do { _ = try await value.calendarPush(.run, argumentsJSON: input); XCTFail("Unavailable or malformed push admitted") }
            catch { }
        }
    }

    func testOversizedDirtyBatchesRequestFullRunsInsteadOfDroppingChanges() async throws {
        let value = try await host(probe: "__mindwtrNative.calendarPushDue(JSON.stringify(Array.from({length:10001},(_,i)=>'t'+i)));__mindwtrNative.calendarPushDue(JSON.stringify(['x'.repeat(1048576)]));return null;")
        let wake = expectation(description: "Both oversize shapes promote to full")
        wake.expectedFulfillmentCount = 2
        let observer = try await value.observeCalendarPush { ids in
            XCTAssertNil(ids)
            wake.fulfill()
        }
        _ = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        await fulfillment(of: [wake], timeout: 1)
        try await value.removeCalendarPushObserver(observer)
    }

    func testColdStartedCreateRecoversExactWitnessThroughRoundedBoundedWindowWithoutAnotherWrite() async throws {
        let started = try await persistedStartedCreate()
        guard case .createEvent(_, let details) = started.request else { return XCTFail("Expected frozen create") }
        let rawMilliseconds = details.start.timeIntervalSince1970 * 1000
        XCTAssertTrue(NativeCalendarEventOpenRequest.validDate(details.start))
        XCTAssertLessThan(rawMilliseconds, 70_262_315_826_648)
        XCTAssertEqual(rawMilliseconds.rounded(), 70_262_315_826_648)
        let provider = CalendarPushHostProvider(), event = try exactEvent(started)
        provider.reader.eventValues = [event]
        let probe = "return await __mindwtrCalendarPushCall({op:'mapping',taskId:\(try json(taskID))});"
        let value = try await host(probe: probe, preserveManifest: true, provider: provider)
        let recovered = try object(await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}"))
        let query = try XCTUnwrap(provider.reader.requestedEvents)
        XCTAssertEqual(query.ids.map { Data($0.utf8) }, [Data(calendarID.utf8)])
        XCTAssertEqual(query.start, Date(timeIntervalSince1970: (rawMilliseconds.rounded() - 1000) / 1000))
        XCTAssertEqual(query.end, Date(timeIntervalSince1970: (rawMilliseconds.rounded() + 1000) / 1000))
        XCTAssertGreaterThanOrEqual(query.start.timeIntervalSince1970, NativeCalendarEventOpenRequest.minimumSeconds)
        XCTAssertLessThanOrEqual(query.end.timeIntervalSince1970, NativeCalendarEventOpenRequest.maximumSeconds)
        XCTAssertEqual(provider.reader.operations.filter { $0 == "events" }.count, 1)
        XCTAssertTrue(provider.writes.isEmpty)
        XCTAssertEqual(Data(try XCTUnwrap(recovered["taskId"] as? String).utf8), Data(taskID.utf8))
        XCTAssertEqual(Data(try XCTUnwrap(recovered["calendarEventId"] as? String).utf8), Data(try XCTUnwrap(event["id"] as? String).utf8))
        let second = try object(await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}"))
        XCTAssertEqual(try json(second), try json(recovered))
        XCTAssertEqual(provider.reader.operations.filter { $0 == "events" }.count, 1)
        await value.close()
        try withEffects { effects, sqlite, storage in
            XCTAssertNil(try effects.current())
            let mapping = try XCTUnwrap(sqlite.readCalendarPushMapping(taskID: taskID))
            XCTAssertEqual(Data(mapping.calendarId.utf8), Data(calendarID.utf8))
            XCTAssertEqual(Data(mapping.calendarEventId.utf8), Data(try XCTUnwrap(event["id"] as? String).utf8))
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM calendar_sync WHERE platform = 'ios'").utf8)) as? [[String: Any]])
            XCTAssertEqual(rows.count, 1)
            XCTAssertEqual(try storage.get("unknown"), "preserve")
        }
        let reopened = try await host(probe: probe, preserveManifest: true, provider: provider)
        _ = try await reopened.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        XCTAssertEqual(provider.reader.operations.filter { $0 == "events" }.count, 1)
        XCTAssertTrue(provider.writes.isEmpty)
    }

    private func assertColdCreateBlocked(changedBody: Bool) async throws {
        let started = try await persistedStartedCreate(), frozen = try started.encoded()
        let provider = CalendarPushHostProvider()
        var event = try exactEvent(started)
        if changedBody { event["title"] = "Changed externally"; provider.reader.eventValues = [event] }
        else {
            var duplicate = event; duplicate["id"] = "different-provider-event"
            provider.reader.eventValues = [event, duplicate]
        }
        let value = try await host(probe: "throw Error('Shared run must not be entered before recovery');",
                                   preserveManifest: true, provider: provider)
        do { _ = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}"); XCTFail("Unsafe witness recovered") }
        catch { XCTAssertFalse(error.localizedDescription.contains("Shared run must not be entered")) }
        XCTAssertEqual(provider.reader.operations.filter { $0 == "events" }.count, 1)
        XCTAssertTrue(provider.writes.isEmpty)
        try await assertOrdinaryTaskWrite(value)
        await value.close()
        try withEffects { effects, sqlite, _ in
            XCTAssertEqual(Data(try XCTUnwrap(effects.current()).encoded().utf8), Data(frozen.utf8))
            XCTAssertNil(try sqlite.readCalendarPushMapping(taskID: taskID))
        }
    }

    func testColdStartedCreateChangedBodyRetainsExactEffectAndOrdinaryTaskWritesRemainAvailable() async throws {
        try await assertColdCreateBlocked(changedBody: true)
    }

    func testColdStartedCreateDuplicateWitnessRetainsExactEffectAndOrdinaryTaskWritesRemainAvailable() async throws {
        try await assertColdCreateBlocked(changedBody: false)
    }

    func testOwnedPrivateLiveEventWriteRequiresExactAckAndPreservesOriginalIDs() async throws {
        let provider = CalendarPushHostProvider(), raw = try eventRequest(startMs: 1_800_000_000_000)
        let probe = """
        const task=\(try json(taskID)),request=\(raw);
        const token=await __mindwtrCalendarPushCall({op:'write',request,taskId:task});
        const before=await __mindwtrCalendarPushCall({op:'mapping',taskId:task});
        const entry={taskId:task,calendarEventId:token.result.id,calendarId:request.calendarId,platform:'ios',lastSyncedAt:'2026-10-09T00:00:00.000Z'};
        let wrongRefused=false;
        try{await __mindwtrCalendarPushCall({op:'ackMapping',operationId:'00000000-0000-0000-0000-000000000000',entry});}
        catch{wrongRefused=true;}
        const stillBefore=await __mindwtrCalendarPushCall({op:'mapping',taskId:task});
        await __mindwtrCalendarPushCall({op:'ackMapping',operationId:token.operationId,entry});
        return {token,before,stillBefore,wrongRefused,mapping:await __mindwtrCalendarPushCall({op:'mapping',taskId:task})};
        """
        let value = try await host(probe: probe, provider: provider)
        let reply = try object(await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}"))
        XCTAssertTrue(reply["before"] is NSNull); XCTAssertTrue(reply["stillBefore"] is NSNull)
        XCTAssertEqual(reply["wrongRefused"] as? Bool, true)
        let token = try XCTUnwrap(reply["token"] as? [String: Any])
        let operation = try XCTUnwrap(UUID(uuidString: XCTUnwrap(token["operationId"] as? String)))
        let mapping = try NativeCalendarPushRequest.mapping(XCTUnwrap(reply["mapping"] as? [String: Any]))
        XCTAssertEqual(Data(mapping.taskId.utf8), Data(taskID.utf8))
        XCTAssertEqual(Data(mapping.calendarId.utf8), Data(calendarID.utf8))
        XCTAssertEqual(Data(mapping.calendarEventId.utf8), Data((provider.eventID + "1").utf8))
        XCTAssertEqual(provider.writes.count, 1)
        guard case .createEvent(let actualID, let actualDetails) = try XCTUnwrap(provider.writes.first) else { return XCTFail("Expected create") }
        XCTAssertEqual(Data(actualID.utf8), Data(calendarID.utf8))
        XCTAssertTrue(actualDetails.notes.contains(operation.uuidString.lowercased()))
        await value.close()
        try withEffects { effects, sqlite, _ in
            XCTAssertNil(try effects.current()); XCTAssertEqual(try sqlite.readCalendarPushMapping(taskID: taskID), mapping)
        }
    }

    func testFourParallelPrivateWritesReachProviderOnlyAfterPreviousDurableMappingAck() async throws {
        let provider = CalendarPushHostProvider(), tasks = [" task-\u{e9} ", taskID, "third", "fourth"]
        provider.beforeCreate = { index, _ in
            let sqlite = try SQLiteBridge(url: self.database); defer { sqlite.close() }
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM calendar_sync WHERE platform = 'ios'").utf8)) as? [[String: Any]])
            XCTAssertEqual(rows.count, index - 1, "Next provider write preceded the previous durable ack")
        }
        let probe = """
        const request=\(try eventRequest(startMs: 1_800_000_000_000)),tasks=\(try json(tasks));
        return await Promise.all(tasks.map(async task=>{
          const token=await __mindwtrCalendarPushCall({op:'write',request,taskId:task});
          const entry={taskId:task,calendarEventId:token.result.id,calendarId:request.calendarId,platform:'ios',lastSyncedAt:'2026-10-09T00:00:00.000Z'};
          await __mindwtrCalendarPushCall({op:'ackMapping',operationId:token.operationId,entry});
          return await __mindwtrCalendarPushCall({op:'mapping',taskId:task});
        }));
        """
        let value = try await host(probe: probe, provider: provider)
        let raw = try await value.calendarPush(.run, argumentsJSON: "{\"ids\":null}")
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 4); XCTAssertEqual(provider.writes.count, 4)
        for (index, row) in rows.enumerated() {
            let mapping = try NativeCalendarPushRequest.mapping(row)
            XCTAssertEqual(Data(mapping.taskId.utf8), Data(tasks[index].utf8))
            XCTAssertEqual(Data(mapping.calendarEventId.utf8), Data((provider.eventID + String(index + 1)).utf8))
            XCTAssertEqual(Data(mapping.calendarId.utf8), Data(calendarID.utf8))
        }
        await value.close()
        try withEffects { effects, sqlite, _ in
            XCTAssertNil(try effects.current())
            for task in tasks { XCTAssertNotNil(try sqlite.readCalendarPushMapping(taskID: task)) }
        }
    }

    func testReplacingDatabaseFileRevokesPushOwner() async throws {
        let value = try await host()
        let retained = root.appendingPathComponent("original.sqlite")
        try FileManager.default.moveItem(at: database, to: retained)
        try Data().write(to: database)
        do { _ = try await value.calendarPush(.start); XCTFail("Rebound library admitted") }
        catch { }
        await value.close()
    }
}
