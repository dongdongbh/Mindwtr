import XCTest
@testable import MindwtrNativeCore

final class LegacyRNUpgradeTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private let identifier = "tech.dongdongbh.mindwtr"
    private var database: URL { root.appendingPathComponent("Documents/SQLite/mindwtr.db") }
    private var manifest: URL { root.appendingPathComponent("Library/Application Support/\(identifier)/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build core-host.js first") }
        bundle = URL(fileURLWithPath: path)
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func host(_ faults: HostIOFaults = HostIOFaults()) throws -> CoreHost {
        let source = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, legacyStorage: source)
        addTeardownBlock { await host.close() }
        return host
    }

    private func writeManifest(_ values: [String: String]) throws {
        try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]).write(to: manifest)
    }

    func testJSONAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment() async throws {
        let at = "2026-09-20T10:00:00.000Z"
        // Keep activation's due-Inbox promotion out of this import/replay check.
        let live: [String: Any] = ["id": "rn-live", "title": "Unsynced RN task ü 😀", "description": "Keep notes\nline two",
            "status": "next", "tags": ["#tag"], "contexts": ["@home"], "dueDate": "2099-10-01",
            "createdAt": at, "updatedAt": at, "rev": 4, "revBy": "rn-device"]
        var deleted = live
        deleted["id"] = "rn-tombstone"
        deleted["deletedAt"] = at
        let backup: [String: Any] = ["tasks": [live, deleted], "projects": [], "sections": [], "areas": [], "people": [],
            "settings": ["deviceId": "rn-device", "theme": "dark", "gtd": ["autoArchiveDays": 7]]]
        let backupJSON = String(decoding: try JSONSerialization.data(withJSONObject: backup), as: UTF8.self)
        try writeManifest(["mindwtr-data": backupJSON, "mindwtr-data:json-ahead-of-sqlite": "1",
                           "mindwtr-data:startup-backup-version": "2", "mindwtr-language": "de", "unknown-setting": "Keep me"])
        let original = try Data(contentsOf: manifest)
        let attachment = root.appendingPathComponent("Documents/attachments/untouched.txt")
        try FileManager.default.createDirectory(at: attachment.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("Unchanged attachment bytes".utf8).write(to: attachment)
        let checkpoint = database.appendingPathExtension("rn-state.prewrite")
        try FileManager.default.createDirectory(at: checkpoint, withIntermediateDirectories: true)
        let existing = try SQLiteBridge(url: database)
        _ = try existing.execute("PRAGMA user_version = 0")
        existing.close()
        let first = try host()
        do { _ = try await first.start(); XCTFail("Marker acknowledgment must fail") }
        catch { XCTAssertTrue(error.localizedDescription.contains("previous app version")) }
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        do { _ = try await first.call("captureOpen"); XCTFail("Failed import cannot activate") } catch {}
        await first.close()

        let inspect = try SQLiteBridge(url: database)
        let before = try inspect.execute("SELECT id, title, description, dueDate, deletedAt, rev FROM tasks ORDER BY id")
        XCTAssertTrue(before.contains("rn-live"))
        XCTAssertTrue(before.contains("rn-tombstone"))
        XCTAssertTrue(before.contains("2099-10-01"))
        inspect.close()
        try FileManager.default.removeItem(at: checkpoint) // only this test's injected obstruction
        let retry = try host()
        _ = try await retry.start()
        await retry.close()
        let source = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        XCTAssertNil(try source.value(forKey: "mindwtr-data:json-ahead-of-sqlite"))
        XCTAssertEqual(try source.value(forKey: "mindwtr-data:sqlite-json-reconcile-v1"), "1")
        XCTAssertEqual(try source.value(forKey: "mindwtr-data"), backupJSON)
        XCTAssertEqual(try source.value(forKey: "unknown-setting"), "Keep me")
        XCTAssertEqual(try source.value(forKey: "mindwtr-language"), "de")
        XCTAssertEqual(try Data(contentsOf: checkpoint), original)
        XCTAssertEqual(try String(contentsOf: attachment), "Unchanged attachment bytes")
        let reopened = try host()
        _ = try await reopened.start()
        await reopened.close()
        let after = try SQLiteBridge(url: database)
        let afterRows = try after.execute("SELECT id, title, description, dueDate, deletedAt, rev FROM tasks ORDER BY id")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(afterRows.utf8)) as? NSArray,
                       try JSONSerialization.jsonObject(with: Data(before.utf8)) as? NSArray)
        // The copy's settings move whole into a SQLite with none (core's mergeLegacyJsonCopy): RN's device id stays this
        // install's, so sync's revBy does not change on the upgrade.
        let settingsRows = try JSONSerialization.jsonObject(with: Data(try after.execute("SELECT data FROM settings WHERE id = 1").utf8)) as? [[String: Any]]
        let settingsJSON = try XCTUnwrap(settingsRows?.first?["data"] as? String)
        let settings = try JSONSerialization.jsonObject(with: Data(settingsJSON.utf8)) as? [String: Any]
        XCTAssertEqual(settings?["deviceId"] as? String, "rn-device")
        after.close()
    }

    func testUntrustedOrMissingLegacyLibraryNeverCreatesSQLite() async throws {
        for values in [
            ["mindwtr-data": "{corrupt", "mindwtr-data:json-ahead-of-sqlite": "1"],
            ["mindwtr-data": "{\"tasks\":\"lost\"}"],
            ["mindwtr-data:json-ahead-of-sqlite": "1"],
            ["mindwtr-language": "de"],
            ["mindwtr-data": "{\"tasks\":[]}", "mindwtr-data:sqlite-json-reconcile-v1": "1"],
            ["mindwtr-data": "{\"tasks\":[]}", "mindwtr-data:startup-backup-version": "2"],
            ["mindwtr-data": "{\"tasks\":[]}", "mindwtr-data:json-ahead-of-sqlite": "1"],
        ] {
            try writeManifest(values)
            let original = try Data(contentsOf: manifest)
            let faults = HostIOFaults()
            var statements = 0
            faults.beforeSQL = { _ in statements += 1 }
            let core = try host(faults)
            do { _ = try await core.start(); XCTFail("Untrusted source must block startup") } catch {}
            await core.close()
            XCTAssertEqual(statements, 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: database.path))
            XCTAssertEqual(try Data(contentsOf: manifest), original)
        }
    }

    func testGenuineJSONOnlyInstallCanCreateDatabase() async throws {
        try writeManifest(["gtd-data": "{\"tasks\":[]}", "mindwtr-language": "de"])
        let core = try host()
        _ = try await core.start()
        await core.close()
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.path))
        let source = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        XCTAssertEqual(try source.value(forKey: "gtd-data"), "{\"tasks\":[]}")
        XCTAssertEqual(try source.value(forKey: "mindwtr-language"), "de")
    }

    func testPreservedRNContainerCopyKeepsRowsPreferencesAndAttachments() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_RN_FIXTURE"] else {
            throw XCTSkip("Set MINDWTR_RN_FIXTURE to a preserved, closed RN container")
        }
        let files = FileManager.default
        let source = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        let destination = root.appendingPathComponent("preserved-rn-copy", isDirectory: true)
        let testRoot = root.resolvingSymlinksInPath().standardizedFileURL
        guard path.hasPrefix("/"), source.path == source.resolvingSymlinksInPath().path,
              !source.pathComponents.starts(with: testRoot.pathComponents),
              !testRoot.pathComponents.starts(with: source.pathComponents),
              try source.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw HostFailure("Preserved RN fixture must be a separate real directory")
        }
        // Inspect paths only before copying: never open SQLite or the upgrade host
        // on the preserved source, and never follow a fixture symlink outside it.
        func entries(_ directory: URL) throws -> [URL] {
            var failed = false
            guard let iterator = files.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey],
                                                 errorHandler: { _, _ in failed = true; return false }) else {
                throw HostFailure("Cannot inspect preserved RN fixture")
            }
            var result: [URL] = []
            for case let url as URL in iterator {
                let attributes = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey])
                guard attributes.isSymbolicLink != true, attributes.isRegularFile == true || attributes.isDirectory == true else {
                    throw HostFailure("Preserved RN fixture contains an unsupported file")
                }
                if attributes.isRegularFile == true { result.append(url) }
            }
            guard !failed else { throw HostFailure("Cannot inspect preserved RN fixture") }
            return result
        }
        _ = try entries(source)
        try files.copyItem(at: source, to: destination)
        let copiedFiles = try entries(destination)
        let copiedDatabase = destination.appendingPathComponent("Documents/SQLite/mindwtr.db")
        guard files.fileExists(atPath: copiedDatabase.path) else { throw HostFailure("Preserved RN fixture database is missing") }

        let tables = ["tasks", "projects", "sections", "areas", "people", "settings", "saved_filters", "calendar_sync"]
        func snapshotRows() throws -> [String: [[String: Any]]] {
            let sqlite = try SQLiteBridge(url: copiedDatabase)
            defer { sqlite.close() }
            let schema = try JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table'").utf8)) as? [[String: Any]] ?? []
            let existing = Set(schema.compactMap { $0["name"] as? String })
            var result: [String: [[String: Any]]] = [:]
            for table in tables where existing.contains(table) {
                guard let rows = try JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT * FROM \(table)").utf8)) as? [[String: Any]] else {
                    throw HostFailure("Cannot snapshot preserved RN rows")
                }
                result[table] = rows
            }
            return result
        }
        func same(_ left: Any?, _ right: Any?) -> Bool {
            guard let left, let right else { return left == nil && right == nil }
            return (left as? NSObject)?.isEqual(right) == true
        }
        let originalRows = try snapshotRows() // includes committed pages in the copied WAL
        guard originalRows["tasks"]?.isEmpty == false else { throw HostFailure("Preserved RN fixture must contain tasks") }
        let manifestPaths: Set<String> = [
            "Library/Application Support/\(identifier)/RCTAsyncLocalStorage_V1/manifest.json",
            "Documents/RCTAsyncLocalStorage_V1/manifest.json", "Documents/RNCAsyncLocalStorage_V1/manifest.json",
            "Documents/RCTAsyncLocalStorage/manifest.json",
        ]
        let databaseFiles: Set<String> = ["Documents/SQLite/mindwtr.db", "Documents/SQLite/mindwtr.db-wal",
                                         "Documents/SQLite/mindwtr.db-shm", "Documents/SQLite/mindwtr.db-journal"]
        var originalFiles: [String: Data] = [:]
        for url in copiedFiles {
            let relative = String(url.path.dropFirst(destination.path.count + 1))
            if !databaseFiles.contains(relative), relative.hasPrefix("Documents/") || relative.hasPrefix("Library/Preferences/")
                || relative.hasPrefix("Library/Application Support/\(identifier)/RCTAsyncLocalStorage_V1/") {
                originalFiles[relative] = try Data(contentsOf: url)
            }
        }

        for launch in 1...2 {
            let storage = try LegacyRNStorage(containerURL: destination, bundleIdentifier: identifier)
            let core = CoreHost(databaseURL: copiedDatabase, bundleURL: bundle, faults: HostIOFaults(), legacyStorage: storage)
            do { _ = try await core.start() }
            catch {
                await core.close()
                let categories = [
                    "Incomplete settings load", "Incomplete tasks load", "Incomplete projects load", "Incomplete sections load",
                    "Incomplete areas load", "Incomplete people load", "Incomplete saved filters load",
                    "Incomplete tasks activation", "Incomplete projects activation", "Incomplete sections activation",
                    "Incomplete areas activation", "Incomplete people activation",
                    "Legacy recovery checkpoint does not match the original snapshot",
                    "Legacy recovery checkpoint verification failed", "Legacy storage changed since the upgrade snapshot",
                    "Legacy authority readback verification failed", "Legacy library database is missing",
                    "Legacy backup requires recovery", "Conflicting legacy storage copies require recovery",
                    "Cannot update the previous app version's saved state", "SQLite integrity check failed",
                    "SAVE_FAILED", "INVALID_INPUT", "NOT_READY",
                ]
                let category = categories.first { error.localizedDescription.contains($0) } ?? "unclassified startup failure"
                XCTFail("Copied RN fixture launch \(launch) failed: \(category); source untouched")
                return
            }
            await core.close()
            let current = try snapshotRows()
            for table in tables {
                for row in originalRows[table] ?? [] {
                    let identity = table == "calendar_sync" ? ["task_id", "platform"] : ["id"]
                    guard let preserved = current[table]?.first(where: { candidate in identity.allSatisfy { same(row[$0], candidate[$0]) } }) else {
                        XCTFail("Preserved RN \(table) lost a row")
                        continue
                    }
                    var changed = row.keys.filter { !same(row[$0], preserved[$0]) }.sorted()
                    // Compare preferences as JSON. Normal startup's
                    // bumpTombstoneCleanupTimestampMigration updates only this
                    // maintenance receipt; all other settings stay exact.
                    var settingNames = ""
                    if table == "settings", changed.contains("data"), let old = row["data"] as? String,
                       let new = preserved["data"] as? String,
                       var oldSettings = try? JSONSerialization.jsonObject(with: Data(old.utf8)) as? [String: Any],
                       var newSettings = try? JSONSerialization.jsonObject(with: Data(new.utf8)) as? [String: Any] {
                        for oldSide in [true, false] {
                            var settings = oldSide ? oldSettings : newSettings
                            if var migrations = settings["migrations"] as? [String: Any] {
                                migrations.removeValue(forKey: "lastTombstoneCleanupAt")
                                settings["migrations"] = migrations.isEmpty ? nil : migrations
                            }
                            if oldSide { oldSettings = settings } else { newSettings = settings }
                        }
                        let names = Set(oldSettings.keys).union(newSettings.keys).filter { !same(oldSettings[$0], newSettings[$0]) }.sorted()
                        if names.isEmpty { changed.removeAll { $0 == "data" } }
                        else { settingNames = "; changed setting keys: " + names.joined(separator: ", ") }
                    }
                    // Only schema/setting names are reported, never stored values.
                    XCTAssertTrue(changed.isEmpty, "Preserved RN \(table) changed fields: \(changed.joined(separator: ", "))\(settingNames)")
                }
            }
            for (relative, original) in originalFiles {
                let file = destination.appendingPathComponent(relative)
                guard files.fileExists(atPath: file.path) else { XCTFail("Preserved RN non-database file was removed"); continue }
                let current = try Data(contentsOf: file)
                if manifestPaths.contains(relative), current != original {
                    guard let before = try JSONSerialization.jsonObject(with: original) as? [String: Any],
                          let after = try JSONSerialization.jsonObject(with: current) as? [String: Any] else {
                        XCTFail("Preserved RN manifest became invalid"); continue
                    }
                    let ahead = "mindwtr-data:json-ahead-of-sqlite"
                    let reconciled = "mindwtr-data:sqlite-json-reconcile-v1"
                    let unchanged = Set(before.keys).union(after.keys).subtracting([ahead, reconciled])
                    XCTAssertTrue(unchanged.allSatisfy { same(before[$0], after[$0]) }, "Preserved RN preferences changed")
                    XCTAssertTrue(same(before[ahead], after[ahead]) || after[ahead] == nil, "Invalid RN authority-marker transition")
                    XCTAssertTrue(same(before[reconciled], after[reconciled]) || after[reconciled] as? String == "1", "Invalid RN reconciliation-marker transition")
                } else {
                    XCTAssertTrue(current == original, "Preserved RN non-database file bytes changed")
                }
            }
        }
    }
}
