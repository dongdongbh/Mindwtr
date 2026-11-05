import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class RNAdoptionNoNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("RN candidate storage tests must not access the network")
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

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
        guard let physical = Darwin.realpath(root.path, nil) else { throw HostFailure("RN fixture root is unavailable") }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
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

    private func candidateHost(container: URL? = nil, faults: HostIOFaults = HostIOFaults()) throws -> CoreHost {
        faults.secretStatus = { _, _ in errSecItemNotFound }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RNAdoptionNoNetwork.self]
        faults.httpConfiguration = configuration
        let host = try CoreHost(rnAdoptionContainerURL: container ?? root, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }
        return host
    }

    private func assertCandidatePreferences(_ host: CoreHost) async throws {
        for command in ["openSyncSettings", "syncSettings"] {
            let response = try await host.foregroundSync(command: command, requestJSON: "{}")
            let object = try XCTUnwrap(NativeJSON.jsonObject(with: Data(response.utf8)) as? [String: Any])
            XCTAssertEqual(object["ok"] as? Bool, true, "Required canonical device preferences must remain usable")
        }
    }

    private func seedCandidateLibrary() throws -> String {
        let at = "2026-10-30T10:00:00.000Z"
        let task: [String: Any] = ["id": "candidate-live", "title": "Synthetic RN candidate", "status": "next",
            "tags": [], "contexts": [], "createdAt": at, "updatedAt": at, "rev": 3, "revBy": "synthetic-rn"]
        let backup: [String: Any] = ["tasks": [task],
            "projects": [], "sections": [], "areas": [], "people": [], "settings": ["deviceId": "synthetic-rn"]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: backup), as: UTF8.self)
        try writeManifest(["mindwtr-data": json, "mindwtr-data:json-ahead-of-sqlite": "1",
            "mindwtr-data:startup-backup-version": "2", "@mindwtr_sync_backend": "off",
            "mindwtr-language": "de", "unknown-setting": "keep"])
        try FileManager.default.createDirectory(at: database.deletingLastPathComponent(), withIntermediateDirectories: true)
        let sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("PRAGMA user_version = 0")
        sqlite.close()
        return json
    }

    func testCandidateImportsBeforeDevicePreferencesAndColdReopens() async throws {
        let backup = try seedCandidateLibrary()
        let original = try Data(contentsOf: manifest)
        let core = try candidateHost()
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("prewrite").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Library/Application Support/NativeFoundation").path))
        _ = try await core.start()
        try await assertCandidatePreferences(core)
        await core.close()
        let source = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        XCTAssertNil(try source.value(forKey: "mindwtr-data:json-ahead-of-sqlite"))
        XCTAssertEqual(try source.value(forKey: "mindwtr-data:sqlite-json-reconcile-v1"), "1")
        XCTAssertEqual(try source.value(forKey: "mindwtr-data"), backup)
        XCTAssertEqual(try source.value(forKey: "mindwtr-language"), "de")
        XCTAssertEqual(try source.value(forKey: "unknown-setting"), "keep")
        XCTAssertEqual(try Data(contentsOf: database.appendingPathExtension("rn-state.prewrite")), original)
        let first = try SQLiteBridge(url: database)
        let rows = try first.execute("SELECT * FROM tasks ORDER BY id")
        XCTAssertTrue(rows.contains("candidate-live"))
        first.close()
        let reopened = try candidateHost()
        _ = try await reopened.start()
        try await assertCandidatePreferences(reopened)
        await reopened.close()
        let second = try SQLiteBridge(url: database)
        XCTAssertEqual(try second.execute("SELECT * FROM tasks ORDER BY id"), rows)
        second.close()
    }

    func testCandidateRejectsPopulatedDocumentsStoresBeforeSQL() async throws {
        let values = Data(#"{"mindwtr-language":"de","unknown-setting":"keep"}"#.utf8)
        for (index, location) in ["RCTAsyncLocalStorage_V1", "RNCAsyncLocalStorage_V1", "RCTAsyncLocalStorage"].enumerated() {
            for canonical in [false, true] {
                let container = root.appendingPathComponent("old-\(index)-\(canonical)", isDirectory: true)
                let old = container.appendingPathComponent("Documents/\(location)/manifest.json")
                try FileManager.default.createDirectory(at: old.deletingLastPathComponent(), withIntermediateDirectories: true)
                try values.write(to: old)
                if canonical {
                    let current = container.appendingPathComponent("Library/Application Support/\(identifier)/RCTAsyncLocalStorage_V1/manifest.json")
                    try FileManager.default.createDirectory(at: current.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try values.write(to: current)
                }
                let db = container.appendingPathComponent("Documents/SQLite/mindwtr.db")
                try FileManager.default.createDirectory(at: db.deletingLastPathComponent(), withIntermediateDirectories: true)
                let sqlite = try SQLiteBridge(url: db)
                _ = try sqlite.execute("PRAGMA journal_mode = WAL")
                _ = try sqlite.execute("CREATE TABLE candidate_probe (value TEXT)")
                _ = try sqlite.execute("INSERT INTO candidate_probe VALUES ('synthetic')")
                sqlite.close()
                let originals = try ["", "-wal"].map { try Data(contentsOf: URL(fileURLWithPath: db.path + $0)) }
                let faults = HostIOFaults()
                var statements = 0
                faults.beforeSQL = { _ in statements += 1 }
                let core = try candidateHost(container: container, faults: faults)
                do { _ = try await core.start(); XCTFail("Populated old Documents storage requires recovery") }
                catch { XCTAssertTrue(error.localizedDescription.contains("recovery")) }
                await core.close()
                XCTAssertEqual(statements, 0)
                XCTAssertEqual(try Data(contentsOf: db), originals[0])
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: db.path + "-wal")), originals[1])
                XCTAssertEqual(try Data(contentsOf: old), values)
                XCTAssertFalse(FileManager.default.fileExists(atPath: db.appendingPathExtension("prewrite").path))
            }
        }
    }

    func testCandidateAllowsEmptyDocumentsStoresWithoutChangingThem() async throws {
        _ = try seedCandidateLibrary()
        let emptyManifest = Data("{}\n".utf8)
        for objectStore in [false, true] {
            let container = root.appendingPathComponent("empty-old-\(objectStore)", isDirectory: true)
            try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents"), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: root.appendingPathComponent("Library"), to: container.appendingPathComponent("Library"))
            try FileManager.default.copyItem(at: database.deletingLastPathComponent(), to: container.appendingPathComponent("Documents/SQLite"))
            let oldStores = ["RCTAsyncLocalStorage_V1", "RNCAsyncLocalStorage_V1", "RCTAsyncLocalStorage"].map {
                container.appendingPathComponent("Documents/" + $0, isDirectory: true)
            }
            for directory in oldStores {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                if objectStore { try emptyManifest.write(to: directory.appendingPathComponent("manifest.json")) }
            }
            let core = try candidateHost(container: container)
            _ = try await core.start()
            try await assertCandidatePreferences(core)
            await core.close()
            for directory in oldStores {
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), objectStore ? ["manifest.json"] : [])
                if objectStore { XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("manifest.json")), emptyManifest) }
            }
        }
    }

    func testCandidateRequiredDeviceLeaseFailureCannotPublishReadyAndColdRetryConverges() async throws {
        _ = try seedCandidateLibrary()
        let owner = try NativeDeviceKV(containerURL: root, bundleIdentifier: identifier)
        defer { owner.close() }
        let first = try candidateHost()
        do { _ = try await first.start(); XCTFail("A required preference-owner failure must block readiness") } catch {}
        do { _ = try await first.call("captureOpen"); XCTFail("Failed candidate must not admit capture") } catch {}
        await first.close()
        let imported = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        XCTAssertNil(try imported.value(forKey: "mindwtr-data:json-ahead-of-sqlite"))
        owner.close()
        let retry = try candidateHost()
        _ = try await retry.start()
        try await assertCandidatePreferences(retry)
        await retry.close()
        let sqlite = try SQLiteBridge(url: database)
        let rows = try NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT id FROM tasks").utf8)) as? [[String: Any]]
        XCTAssertEqual(rows?.compactMap { $0["id"] as? String }, ["candidate-live"])
        sqlite.close()
    }

    func testCandidateFailedStartRereadsSourceOnSameHostRetry() async throws {
        _ = try seedCandidateLibrary()
        let valid = try Data(contentsOf: manifest)
        try writeManifest(["mindwtr-data": "{corrupt", "mindwtr-data:json-ahead-of-sqlite": "1"])
        let core = try candidateHost()
        do { _ = try await core.start(); XCTFail("Corrupt source must block startup") } catch {}
        try valid.write(to: manifest)
        _ = try await core.start()
        try await assertCandidatePreferences(core)
        await core.close()
    }

    func testCandidateConstructorIsReadOnlyAndRejectsNonFileContainer() throws {
        let fresh = root.appendingPathComponent("not-created", isDirectory: true)
        let host = try CoreHost(rnAdoptionContainerURL: fresh, bundleURL: bundle)
        addTeardownBlock { await host.close() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fresh.path))
        let remote = try XCTUnwrap(URL(string: "https://example.invalid/container"))
        XCTAssertThrowsError(try CoreHost(rnAdoptionContainerURL: remote, bundleURL: bundle))
    }

    func testCandidateRejectsLinkedDatabaseAndLockWithoutChangingTargets() async throws {
        for (index, leaf) in ["mindwtr.db", "mindwtr.db-wal", "mindwtr.db-shm", "mindwtr.db-journal", "mindwtr.db.host-lock"].enumerated() {
            for symbolic in [false, true] {
                let container = root.appendingPathComponent("linked-\(index)-\(symbolic)", isDirectory: true)
                let directory = container.appendingPathComponent("Documents/SQLite", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let target = root.appendingPathComponent("target-\(index)-\(symbolic)")
                let bytes = Data("Unchanged synthetic target".utf8)
                try bytes.write(to: target)
                let linked = directory.appendingPathComponent(leaf)
                if symbolic { try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: target) }
                else { try FileManager.default.linkItem(at: target, to: linked) }
                let faults = HostIOFaults()
                var statements = 0
                faults.beforeSQL = { _ in statements += 1 }
                let core = try candidateHost(container: container, faults: faults)
                do { _ = try await core.start(); XCTFail("Linked candidate authority must refuse") } catch {}
                await core.close()
                XCTAssertEqual(statements, 0)
                XCTAssertEqual(try Data(contentsOf: target), bytes)
                XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("mindwtr.db.prewrite").path))
            }
        }
    }

    func testCandidateRejectsSymlinkedStorageAncestorsWithoutFollowingThem() async throws {
        for (index, component) in ["", "Documents", "Documents/SQLite"].enumerated() {
            let container = root.appendingPathComponent("ancestor-\(index)", isDirectory: true)
            let target = root.appendingPathComponent("ancestor-target-\(index)", isDirectory: true)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            let linked = component.isEmpty ? container : container.appendingPathComponent(component)
            try FileManager.default.createDirectory(at: linked.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: target)
            let core = try candidateHost(container: container)
            do { _ = try await core.start(); XCTFail("Symlinked candidate ancestors must refuse") } catch {}
            await core.close()
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), [])
        }
    }

    func testJSONAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment() async throws {
        try await jsonAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment(candidate: false)
    }

    func testCandidateJSONAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment() async throws {
        try await jsonAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment(candidate: true)
    }

    private func jsonAheadImportRetainsDataAfterInterruptedMarkerAcknowledgment(candidate: Bool) async throws {
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
        let first = try (candidate ? candidateHost() : host())
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
        let retry = try (candidate ? candidateHost() : host())
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
        let reopened = try (candidate ? candidateHost() : host())
        _ = try await reopened.start()
        await reopened.close()
        let after = try SQLiteBridge(url: database)
        let afterRows = try after.execute("SELECT id, title, description, dueDate, deletedAt, rev FROM tasks ORDER BY id")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(afterRows.utf8)) as? NSArray,
                       try JSONSerialization.jsonObject(with: Data(before.utf8)) as? NSArray)
        after.close()
    }

    func testUntrustedOrMissingLegacyLibraryNeverCreatesSQLite() async throws {
        try await untrustedOrMissingLegacyLibraryNeverCreatesSQLite(candidate: false)
    }

    func testCandidateUntrustedOrMissingLegacyLibraryNeverCreatesSQLite() async throws {
        try await untrustedOrMissingLegacyLibraryNeverCreatesSQLite(candidate: true)
    }

    private func untrustedOrMissingLegacyLibraryNeverCreatesSQLite(candidate: Bool) async throws {
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
            let core = try (candidate ? candidateHost(faults: faults) : host(faults))
            do { _ = try await core.start(); XCTFail("Untrusted source must block startup") } catch {}
            await core.close()
            XCTAssertEqual(statements, 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: database.path))
            XCTAssertEqual(try Data(contentsOf: manifest), original)
        }
    }

    func testGenuineJSONOnlyInstallCanCreateDatabase() async throws {
        try await genuineJSONOnlyInstallCanCreateDatabase(candidate: false)
    }

    func testCandidateGenuineJSONOnlyInstallCanCreateDatabase() async throws {
        try await genuineJSONOnlyInstallCanCreateDatabase(candidate: true)
    }

    private func genuineJSONOnlyInstallCanCreateDatabase(candidate: Bool) async throws {
        try writeManifest(["gtd-data": "{\"tasks\":[]}", "mindwtr-language": "de"])
        let core = try (candidate ? candidateHost() : host())
        _ = try await core.start()
        await core.close()
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.path))
        let source = try LegacyRNStorage(containerURL: root, bundleIdentifier: identifier)
        XCTAssertEqual(try source.value(forKey: "gtd-data"), "{\"tasks\":[]}")
        XCTAssertEqual(try source.value(forKey: "mindwtr-language"), "de")
    }

    func testPreservedRNContainerCopyKeepsRowsPreferencesAndAttachments() async throws {
        try await preservedRNContainerCopyKeepsRowsPreferencesAndAttachments(candidate: false)
    }

    func testCandidatePreservedRNContainerCopyKeepsRowsPreferencesAndAttachments() async throws {
        try await preservedRNContainerCopyKeepsRowsPreferencesAndAttachments(candidate: true)
    }

    private func preservedRNContainerCopyKeepsRowsPreferencesAndAttachments(candidate: Bool) async throws {
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
            let core: CoreHost
            if candidate {
                core = try candidateHost(container: destination)
            } else {
                let storage = try LegacyRNStorage(containerURL: destination, bundleIdentifier: identifier)
                core = CoreHost(databaseURL: copiedDatabase, bundleURL: bundle, faults: HostIOFaults(), legacyStorage: storage)
            }
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
