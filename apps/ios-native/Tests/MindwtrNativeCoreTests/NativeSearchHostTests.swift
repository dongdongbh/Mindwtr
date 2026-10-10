import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class SearchObservationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [NativeSearchObservation] = []
    func append(_ value: NativeSearchObservation) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    var observations: [NativeSearchObservation] { lock.lock(); defer { lock.unlock() }; return values }
}

final class NativeSearchHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace = ""
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private let ids = ["é", "e\u{0301}", "Task", "task", "\u{FEFF}task", " task ", "opaque task/漢+😀", String(repeating: "😀", count: 250)]
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build production core-host.js")
        }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("NativeSearchHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.dongdongbh.mindwtr.native-ui." + UUID().uuidString.lowercased()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func host(bundleURL: URL? = nil) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle,
            deviceStorage: (containerURL: root, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        var result: [String: String] = [:]
        for table in ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"] {
            result[table] = try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + table + " ORDER BY rowid").utf8)))
        }
        return result
    }
    private func seed() async throws {
        let bootstrap = host(); _ = try await bootstrap.start(); await bootstrap.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        for id in ids + ["deleted"] {
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,deletedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Synthetic private task','inbox','[]','[]','Synthetic private notes',?,?,?,3,'fixture',0,0,0,0)",
                parametersJSON: json([id, "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z", id == "deleted" ? "2026-10-09T00:00:00.000Z" as Any : NSNull()]))
        }
    }
    private func open(_ core: CoreHost, _ id: String) async throws -> [String: String] {
        let raw = try await core.call("iosSearchOpen", argumentsJSON: json([id]))
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: String])
    }

    func testActualSearchOpenPreservesExactIDsAndClosedTransportWithoutWrites() async throws {
        try await seed(); let core = host()
        do { _ = try await open(core, ids[0]); XCTFail("Canonical startup required") } catch {}
        _ = try await core.start(); let before = try rows()
        for id in ids {
            let target = try await open(core, id)
            XCTAssertEqual(target["type"], "task"); XCTAssertEqual(target["taskId"].map { Data($0.utf8) }, Data(id.utf8))
            XCTAssertEqual(Set(target.keys), Set(["type", "taskId"]))
        }
        for id in ["deleted", "missing", "  task  ", "mindwtr-native-dev://open?task=Task"] {
            let target = try await open(core, id); XCTAssertEqual(target, ["type": "inbox"])
        }
        let request = try json([ids[0]]), bounded = request + String(repeating: " ", count: 8_192 - request.utf8.count)
        _ = try await core.call("iosSearchOpen", argumentsJSON: bounded)
        for raw in ["null", "{}", "[]", "[1]", "[true]", "[null]", "[{}]", "[\"\"]", "[\"task\",\"other\"]", bounded + " ", try json([String(repeating: "😀", count: 250) + "x"])] {
            do { _ = try await core.call("iosSearchOpen", argumentsJSON: raw); XCTFail("Expected bounded ID refusal") }
            catch let failure as HostFailure { XCTAssertTrue(failure.message.hasPrefix("INVALID_INPUT:")) }
        }
        let observation = try await core.searchObservation(); XCTAssertTrue(observation.ready)
        for raw in ["{}", "[1]", "[true]", "[null]", "[\"task\"]"] {
            do { _ = try await core.call("iosSearchObservation", argumentsJSON: raw); XCTFail("Expected zero-argument refusal") } catch {}
        }
        _ = try await core.call("iosSearchObservation", argumentsJSON: "[]" + String(repeating: " ", count: 2_046))
        do { _ = try await core.call("iosSearchObservation", argumentsJSON: "[]" + String(repeating: " ", count: 2_047)); XCTFail("Expected bounded observation request") } catch {}
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    private func observedBundle() throws -> URL {
        let suffix = """
        ;(() => {
          const original = MindwtrHost.iosSearchOpen;
          let reads = 0, revision = 1, ready = true, malformed = false;
          MindwtrHost.iosSearchObservation = function() {
            reads++;
            return malformed ? '{"ready":true,"revision":true,"nextAt":null}'
              : JSON.stringify({ ready, revision, nextAt: null });
          };
          MindwtrHost.iosSearchOpen = function(id) {
            if (id.startsWith('assert-count:') && reads !== Number(id.slice(13))) throw new Error('Synthetic observation count mismatch');
            if (id === 'bump') revision++;
            if (id === 'malformed') malformed = true;
            if (id === 'recover') { malformed = false; revision++; }
            if (id === 'timer') setTimeout(() => { revision++; }, 20);
            return original.apply(this, arguments);
          };
        })();
        """
        let file = root.appendingPathComponent("observed-core.js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n" + suffix).write(to: file, atomically: true, encoding: .utf8)
        return file
    }

    func testObserverHasNoUnregisteredWorkAndCoalescesOnlyChangedPostOperationReadiness() async throws {
        let core = host(bundleURL: try observedBundle()); _ = try await core.start()
        _ = try await open(core, "assert-count:0")
        let recorder = SearchObservationRecorder(), changed = expectation(description: "Changed revision")
        try await core.setSearchObservationHandler { value in recorder.append(value); changed.fulfill() }
        _ = try await open(core, "missing")
        XCTAssertTrue(recorder.observations.isEmpty)
        _ = try await open(core, "bump"); await fulfillment(of: [changed], timeout: 2)
        XCTAssertEqual(recorder.observations.count, 1); XCTAssertEqual(recorder.observations.first?.revision, 2)
        try await core.setSearchObservationHandler(nil)
        _ = try await open(core, "bump"); XCTAssertEqual(recorder.observations.count, 1)
        let unavailable = expectation(description: "Malformed observation suppresses"), recovered = expectation(description: "Recovered observation")
        try await core.setSearchObservationHandler { value in
            recorder.append(value)
            if value.ready { recovered.fulfill() } else { unavailable.fulfill() }
        }
        _ = try await open(core, "malformed"); await fulfillment(of: [unavailable], timeout: 2)
        XCTAssertFalse(try XCTUnwrap(recorder.observations.last).ready)
        do { _ = try await core.searchObservation(); XCTFail("Malformed observation must refuse") } catch {}
        _ = try await open(core, "recover"); await fulfillment(of: [recovered], timeout: 2)
        XCTAssertTrue(try XCTUnwrap(recorder.observations.last).ready)
        await core.close()
        do { _ = try await core.searchObservation(); XCTFail("Closed host must refuse") } catch {}
        XCTAssertEqual(recorder.observations.count, 3)
    }

    func testExistingIdleTimerSettlementDeliversOneObservationWithoutPolling() async throws {
        let core = host(bundleURL: try observedBundle()); _ = try await core.start()
        let recorder = SearchObservationRecorder(), changed = expectation(description: "Idle timer source settlement")
        try await core.setSearchObservationHandler { value in recorder.append(value); changed.fulfill() }
        _ = try await open(core, "timer"); await fulfillment(of: [changed], timeout: 2)
        XCTAssertEqual(recorder.observations.count, 1); XCTAssertEqual(recorder.observations.first?.revision, 2)
        _ = try await core.searchObservation(); XCTAssertEqual(recorder.observations.count, 1)
    }
}
