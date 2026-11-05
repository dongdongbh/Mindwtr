import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWidgetFamilySnapshotTests: XCTestCase {
    private var root: URL!
    private var database: URL { root.appendingPathComponent("family.sqlite") }
    private let families = ["default", "small", "medium", "large", "extraLarge"]

    override func setUpWithError() throws {
        guard let temporary = ProcessInfo.processInfo.environment["TMPDIR"], !temporary.isEmpty else {
            throw XCTSkip("Set a disk-backed TMPDIR")
        }
        root = URL(fileURLWithPath: temporary, isDirectory: true).appendingPathComponent("NativeWidgetFamilySnapshotTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        if let root { try FileManager.default.removeItem(at: root) }
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }

    private func envelope(_ payload: String = "{}") -> [String: Any] {
        ["version": 1, "payloads": Dictionary(uniqueKeysWithValues: families.map { ($0, payload) })]
    }

    private func reject(_ raw: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try NativeWidgetFamilySnapshot(json: raw), file: file, line: line) { error in
            XCTAssertEqual(error.localizedDescription, "INVALID_INPUT: Native widget family snapshot is invalid", file: file, line: line)
        }
    }

    private func host(workspaceMode: NativeWorkspaceMode = .personal) throws -> CoreHost {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build the exact integrated iOS core bundle") }
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), workspaceMode: workspaceMode)
        addTeardownBlock { await core.close() }
        return core
    }

    private func execute(_ sql: String, _ parameters: [Any] = []) throws -> String {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        return try sqlite.execute(sql, parametersJSON: json(parameters))
    }

    private func rows() throws -> String {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").utf8)) as? [[String: String]])
        var result: [String: Any] = [:]
        for entry in names {
            let name = try XCTUnwrap(entry["name"])
            if name.hasPrefix("tasks_fts") || name.hasPrefix("projects_fts") { continue }
            let quoted = "\"" + name.replacingOccurrences(of: "\"", with: "\"\"") + "\""
            result[name] = try NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM " + quoted + " ORDER BY rowid").utf8))
        }
        return try json(result)
    }

    private func setTheme(_ theme: String) throws {
        let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: String]])
        var settings = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(values.first?["data"]).utf8)) as? [String: Any])
        settings["theme"] = theme
        _ = try execute("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }

    private func seed() async throws {
        let bootstrap = try host()
        _ = try await bootstrap.start()
        await bootstrap.close()
        for index in 0..<40 {
            _ = try execute("INSERT INTO tasks (id,title,status,tags,contexts,createdAt,updatedAt,rev,revBy) VALUES (?,?,'next','[]','[]',?,?,1,'family-fixture')",
                ["family-\(index)", "Synthetic family \(index)", "2026-11-03T00:00:00.000Z", "2026-11-03T00:00:00.000Z"])
        }
        try setTheme("system")
    }

    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    private func refused(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected a closed facade refusal", file: file, line: line) } catch {}
    }

    func testClosedEnvelopePreservesFiveStringsAndDistinctUnicodeBytes() throws {
        let expected = try Dictionary(uniqueKeysWithValues: families.enumerated().map { index, family in
            (family, try json(["headerTitle": "\u{FEFF}e\u{301} é 🧠 \(index)", "lists": ["next": ["items": []]]]))
        })
        let raw = try json(["version": 1, "payloads": expected])
        let value = try NativeWidgetFamilySnapshot(json: raw)
        XCTAssertEqual(value.version, 1)
        XCTAssertEqual(Data(value.json.utf8), Data(raw.utf8))
        let actual = [value.payloads.defaultPayload, value.payloads.small, value.payloads.medium, value.payloads.large, value.payloads.extraLarge]
        for (family, payload) in zip(families, actual) {
            XCTAssertEqual(Data(payload.utf8), Data(try XCTUnwrap(expected[family]).utf8))
        }
    }

    func testMalformedOuterVersionKeysAndFamilyTypesAreRejected() throws {
        let versions: [Any] = [true, false, 0, 2, "1", NSNull()]
        for version in versions {
            var value = envelope(); value["version"] = version
            reject(try json(value))
        }
        var extra = envelope(); extra["extra"] = 1; reject(try json(extra))
        var missing = envelope(); missing.removeValue(forKey: "version"); reject(try json(missing))
        for family in families {
            var values = Dictionary(uniqueKeysWithValues: families.map { ($0, "{}" as Any) })
            values.removeValue(forKey: family); reject(try json(["version": 1, "payloads": values]))
            values[family] = NSNull(); reject(try json(["version": 1, "payloads": values]))
            values[family] = true; reject(try json(["version": 1, "payloads": values]))
            values[family] = 1; reject(try json(["version": 1, "payloads": values]))
            values[family] = "{}"; values["foreign"] = "{}"; reject(try json(["version": 1, "payloads": values]))
        }
        reject("{\"version\":1,\"version\":1,\"payloads\":{}}")
        reject("{\"version\":1,\"payloads\":{\"default\":\"{}\",\"default\":\"{}\",\"small\":\"{}\",\"medium\":\"{}\",\"large\":\"{}\",\"extraLarge\":\"{}\"}}")
        reject("{")
    }

    func testEveryFamilyMustContainUniqueJSONObjectJSON() throws {
        for family in families {
            for malformed in ["", "{", "[]", "null", "true", "\"text\"", "{\"same\":1,\"same\":2}"] {
                var values = Dictionary(uniqueKeysWithValues: families.map { ($0, "{}") })
                values[family] = malformed
                reject(try json(["version": 1, "payloads": values]))
            }
        }
    }

    func testWholeReplyByteBoundIncludesEnvelopeAndNestedEscaping() throws {
        var values = Dictionary(uniqueKeysWithValues: families.map { ($0, "{}") })
        values["default"] = try json(["text": ""])
        let base = ["version": 1, "payloads": values] as [String: Any]
        let overhead = try json(["ok": true, "value": base]).utf8.count
        values["default"] = try json(["text": String(repeating: "a", count: NativeWidgetFamilySnapshot.maximumBytes - overhead)])
        let exact = ["version": 1, "payloads": values] as [String: Any]
        let exactBytes = try json(["ok": true, "value": exact]).utf8.count
        XCTAssertEqual(exactBytes, NativeWidgetFamilySnapshot.maximumBytes)
        _ = try NativeWidgetFamilySnapshot(json: json(exact))
        values["default"] = try json(["text": String(repeating: "a", count: NativeWidgetFamilySnapshot.maximumBytes - overhead + 1)])
        let envelopeOverflow = try json(["version": 1, "payloads": values])
        XCTAssertLessThan(envelopeOverflow.utf8.count, NativeWidgetFamilySnapshot.maximumBytes)
        reject(envelopeOverflow)
        values["default"] = try json(["text": String(repeating: "a", count: NativeWidgetFamilySnapshot.maximumBytes)])
        reject(try json(["version": 1, "payloads": values]))
        values["default"] = try json(["text": String(repeating: "漢", count: 800_000)])
        let unicode = try json(["version": 1, "payloads": values])
        XCTAssertLessThan(unicode.utf16.count, NativeWidgetFamilySnapshot.maximumBytes)
        reject(unicode)
        let quoted = try json(["text": String(repeating: "\"", count: 110_000)])
        let amplified = envelope(quoted)
        XCTAssertLessThan(quoted.utf8.count * 5, NativeWidgetFamilySnapshot.maximumBytes)
        XCTAssertGreaterThan(try json(amplified).utf8.count, NativeWidgetFamilySnapshot.maximumBytes)
        reject(try json(amplified))
    }

    func testActualJSCFacadeReturnsAllFamiliesWithoutChangingSavedRowsOrNextShapes() async throws {
        try await seed()
        let core = try host(); _ = try await core.start()
        _ = try await core.call("language", argumentsJSON: json(["de", "de-DE"]))
        let before = try rows()
        let value = try await core.widgetFamilySnapshot(systemColorScheme: .dark)
        let raw = try object(await core.call("iosWidgetFamilySnapshot", argumentsJSON: json([json(["systemColorScheme": "dark"])])))
        let expected = try XCTUnwrap(raw["payloads"] as? [String: String])
        let actual = [value.payloads.defaultPayload, value.payloads.small, value.payloads.medium, value.payloads.large, value.payloads.extraLarge]
        for ((family, payload), count) in zip(zip(families, actual), [20, 11, 13, 20, 32]) {
            XCTAssertEqual(Data(payload.utf8), Data(try XCTUnwrap(expected[family]).utf8))
            let lists = try XCTUnwrap(object(payload)["lists"] as? [String: Any])
            let next = try XCTUnwrap(lists["next"] as? [String: Any])
            XCTAssertEqual((next["items"] as? [Any])?.count, count)
        }
        let next = try await core.widgetNextSnapshot()
        XCTAssertEqual(Set(try object(next.json).keys), ["version", "title", "emptyMessage", "totalCount", "items"])
        let actions = try object(await core.call("iosWidgetNextActionSnapshot"))
        XCTAssertEqual(Set(actions.keys), ["snapshot", "tokens", "completeLabel", "undoLabel"])
        XCTAssertEqual(try rows(), before)
    }

    func testActualJSCSystemPaletteAndExplicitThemeUseTheTypedAppearance() async throws {
        try await seed()
        let system = try host(); _ = try await system.start()
        let light = try await system.widgetFamilySnapshot(systemColorScheme: .light)
        let dark = try await system.widgetFamilySnapshot(systemColorScheme: .dark)
        let lightPalette = try XCTUnwrap(object(light.payloads.defaultPayload)["palette"] as? [String: Any])
        let darkPalette = try XCTUnwrap(object(dark.payloads.defaultPayload)["palette"] as? [String: Any])
        XCTAssertNotEqual(try json(lightPalette), try json(darkPalette))
        await system.close()
        try setTheme("dark")
        let explicit = try host(); _ = try await explicit.start()
        let saved = try rows()
        let explicitLight = try await explicit.widgetFamilySnapshot(systemColorScheme: .light)
        let explicitDark = try await explicit.widgetFamilySnapshot(systemColorScheme: .dark)
        XCTAssertEqual(Data(explicitLight.payloads.defaultPayload.utf8), Data(explicitDark.payloads.defaultPayload.utf8))
        let explicitPalette = try XCTUnwrap(object(explicitLight.payloads.defaultPayload)["palette"] as? [String: Any])
        XCTAssertEqual(try json(explicitPalette), try json(darkPalette))
        XCTAssertEqual(try rows(), saved)
    }

    func testFacadeAndTransportRefuseUnstartedClosedRestrictedAndMalformedCalls() async throws {
        let core = try host()
        await refused { _ = try await core.widgetFamilySnapshot(systemColorScheme: .light) }
        _ = try await core.start()
        let before = try rows()
        for input in ["{}", "{\"systemColorScheme\":true}", "{\"systemColorScheme\":\"system\"}", "{\"systemColorScheme\":\"dark\",\"extra\":1}", "{\"systemColorScheme\":\"dark\",\"systemColorScheme\":\"light\"}", String(repeating: " ", count: 300)] {
            await refused { _ = try await core.call("iosWidgetFamilySnapshot", argumentsJSON: json([input])) }
        }
        await refused { _ = try await core.call("iosWidgetFamilySnapshot", argumentsJSON: "[]") }
        await refused { _ = try await core.call("iosWidgetFamilySnapshot", argumentsJSON: "[true]") }
        await refused { _ = try await core.call("iosWidgetFamilySnapshot", argumentsJSON: json(["{}", "{}"])) }
        XCTAssertEqual(try rows(), before)
        await core.close()
        await refused { _ = try await core.widgetFamilySnapshot(systemColorScheme: .dark) }
        let restricted = try host(workspaceMode: .restricted)
        await refused { _ = try await restricted.widgetFamilySnapshot(systemColorScheme: .light) }
    }

    func testActualJSCFamiliesCarryUnfilteredInboxAndStartedAvailableActions() async throws {
        let bootstrap = try host()
        _ = try await bootstrap.start()
        await bootstrap.close()
        let stamp = "2026-11-03T00:00:00.000Z"
        for (order, id) in ["area-work", "area-home"].enumerated() {
            _ = try execute("INSERT INTO areas (id,name,orderNum,rev,revBy,createdAt,updatedAt) VALUES (?,?,?,1,'family-fixture',?,?)",
                [id, id, order, stamp, stamp])
        }
        let tasks: [(String, String, Any, Any)] = [
            ("inbox-loose", "inbox", NSNull(), NSNull()),
            ("inbox-home", "inbox", "area-home", NSNull()),
            ("next-work-started", "next", "area-work", "2026-01-01"),
            ("next-work-undated", "next", "area-work", NSNull()),
            ("next-home-started", "next", "area-home", "2026-01-01"),
        ]
        for (id, status, area, start) in tasks {
            _ = try execute("INSERT INTO tasks (id,title,status,tags,contexts,areaId,startTime,createdAt,updatedAt,rev,revBy) VALUES (?,?,?,'[]','[]',?,?,?,?,1,'family-fixture')",
                [id, id, status, area, start, stamp, stamp])
        }
        let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: String]])
        var settings = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(values.first?["data"]).utf8)) as? [String: Any])
        settings["filters"] = ["areaIds": ["area-work"]]
        _ = try execute("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        let core = try host(); _ = try await core.start()
        let before = try rows()
        let snapshot = try await core.widgetFamilySnapshot(systemColorScheme: .light)
        func ids(_ list: [String: Any]) -> [String] {
            ((list["items"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
        }
        for payload in [snapshot.payloads.defaultPayload, snapshot.payloads.small, snapshot.payloads.medium, snapshot.payloads.large, snapshot.payloads.extraLarge] {
            let root = try object(payload)
            let lists = try XCTUnwrap(root["lists"] as? [String: Any])
            let inbox = try XCTUnwrap(lists["inbox"] as? [String: Any])
            let next = try XCTUnwrap(lists["next"] as? [String: Any])
            let focus = try XCTUnwrap(lists["focus"] as? [String: Any])
            let available = try XCTUnwrap(lists["focus:available"] as? [String: Any])
            let sections = try XCTUnwrap(available["sections"] as? [[String: Any]])
            let availableSection = try XCTUnwrap(sections.first)
            XCTAssertEqual(root["inboxCount"] as? Int, 2)
            XCTAssertEqual(Set(ids(inbox)), ["inbox-loose", "inbox-home"])
            XCTAssertEqual(Set(ids(next)), ["next-work-started", "next-work-undated"])
            XCTAssertFalse(((focus["sections"] as? [[String: Any]]) ?? []).contains { $0["key"] as? String == "available" })
            XCTAssertEqual(sections.map { $0["key"] as? String }, ["available"])
            XCTAssertEqual(ids(availableSection), ["next-work-started"])
            XCTAssertEqual(available["totalCount"] as? Int, 1)
            XCTAssertEqual(available["openUri"] as? String, "mindwtr:///focus")
        }
        XCTAssertEqual(try rows(), before)
    }
}
