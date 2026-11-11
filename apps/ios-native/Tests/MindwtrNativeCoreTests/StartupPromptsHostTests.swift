import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class StartupPromptsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.example.mindwtr.startup-prompts"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual core bundle required") }
        let candidate = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/startup-prompts-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Startup prompts fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        bundle = root.appendingPathComponent("core-host.js"); try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    @discardableResult private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(sql, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func settings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func device() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)) }
    private func begin(_ core: CoreHost) async throws -> Any? {
        try object(await core.call("beginStartupPrompts", argumentsJSON: json([json(["installerSource": "play-store", "donationEnabled": true])])))["prompt"]
    }
    private func shown(_ id: String, at: String) throws -> String { try json([json(["requestId": id, "shownAt": at])]) }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch {}
    }

    func testWelcomeSheetOpensForAnEmptyLibraryAndItsSkipStaysOnTheDevice() async throws {
        let core = host(); _ = try await core.start()
        let opened = try await begin(core)
        let prompt = try XCTUnwrap(opened as? [String: Any])
        XCTAssertEqual(prompt["id"] as? String, "onboarding")
        XCTAssertEqual((prompt["words"] as? [String: Any])?["skipForNow"] as? String, "Skip for now")
        XCTAssertNotNil(try device()["mindwtr:local-user-prompts:v1"])
        let action = try object(await core.call("startupPromptAction", argumentsJSON: json([json(["id": "onboarding", "action": "dismiss"])])))
        XCTAssertTrue(action["shownAt"] is NSNull)
        XCTAssertEqual(try device()["mindwtr:mobile:first-run-onboarding:v1"] as? String, "dismissed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        let cold = host(); _ = try await cold.start()
        let reopened = try await begin(cold)
        XCTAssertTrue(reopened is NSNull)
        await failure { _ = try await cold.call("beginStartupPrompts", argumentsJSON: self.json([self.json(["installerSource": "app-store", "donationEnabled": true])])) }
    }

    func testDonationAskReturnsItsDelayInsteadOfWaitingOnTheHostQueue() async throws {
        let format = DateFormatter(); format.calendar = Calendar(identifier: .gregorian); format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = .current; format.dateFormat = "yyyy-MM-dd"
        let day = { (offset: Int) in format.string(from: Date().addingTimeInterval(-Double(offset) * 86_400)) }
        let state = try json(["firstSeenAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-40 * 86_400)), "firstSeenDayKey": day(40),
                              "activeDayKeys": (1...25).reversed().map(day)])
        try Data(json(["@mindwtr_sync_backend": "off", "mindwtr:mobile:first-run-onboarding:v1": "dismissed", "mindwtr:local-user-prompts:v1": state]).utf8).write(to: manifest)
        let core = host(); _ = try await core.start()
        let request = try json([json(["installerSource": "play-store", "donationEnabled": true, "deferDelay": true])])
        let started = Date()
        let reply = try object(await core.call("beginStartupPrompts", argumentsJSON: request))
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)
        XCTAssertEqual(Set(reply.keys), ["prompt", "delayMs"])
        XCTAssertEqual(reply["delayMs"] as? Int, 2000)
        XCTAssertEqual((reply["prompt"] as? [String: Any])?["id"] as? String, "donation")
        let after = try object(await core.call("beginStartupPrompts", argumentsJSON: request))
        XCTAssertTrue(after["prompt"] is NSNull); XCTAssertEqual(after["delayMs"] as? Int, 0)
    }

    func testSupportPromptShownIsAJournaledSettingsWrite() async throws {
        let core = host(); _ = try await core.start()
        let at = "2026-11-11T09:30:00.000Z"
        let reply = try object(await core.call("supportPromptShown", argumentsJSON: shown(UUID().uuidString.lowercased(), at: at)))
        XCTAssertEqual(reply["changed"] as? Bool, true)
        XCTAssertEqual((try settings()["supportPrompt"] as? [String: Any])?["lastShownAt"] as? String, at)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let before = try settings()
        await failure { _ = try await core.call("supportPromptShown", argumentsJSON: self.shown(UUID().uuidString.uppercased(), at: at)) }
        await failure { _ = try await core.call("supportPromptShown", argumentsJSON: self.shown(UUID().uuidString.lowercased(), at: "soon")) }
        XCTAssertEqual(try json(settings()), try json(before))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFailedSupportPromptShownReplaysExactlyOnColdStart() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let at = "2026-11-12T08:00:00.000Z", args = try shown(UUID().uuidString.lowercased(), at: at)
        let before = try json(rows("SELECT * FROM settings"))
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Synthetic support prompt commit failure") } }
        await failure { _ = try await core.call("supportPromptShown", argumentsJSON: args) }
        let command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(command["method"] as? String, "supportPromptShown")
        XCTAssertEqual(command["argumentsJSON"] as? String, args)
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before)
        await failure { _ = try await core.call("supportPromptShown", argumentsJSON: self.shown(UUID().uuidString.lowercased(), at: at)) }
        faults.beforeSQL = nil
        await core.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual((try settings()["supportPrompt"] as? [String: Any])?["lastShownAt"] as? String, at)
    }
}
