import XCTest
@testable import MindwtrNativeCore

final class LegacyRNStorageTests: XCTestCase {
    private var container: URL!
    private let bundleIdentifier = "tech.dongdongbh.mindwtr"
    private var current: String { "Library/Application Support/\(bundleIdentifier)/RCTAsyncLocalStorage_V1" }
    private let legacy = ["Documents/RCTAsyncLocalStorage_V1", "Documents/RNCAsyncLocalStorage_V1", "Documents/RCTAsyncLocalStorage"]
    private var checkpoint: URL { container.appendingPathComponent("rn-manifest.prewrite.json") }
    private let clearAndReconcile = "{\"clearJsonAhead\":true,\"setReconciled\":true}"

    override func setUpWithError() throws {
        container = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/legacy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let container { try FileManager.default.removeItem(at: container) }
    }

    private func reader() throws -> LegacyRNStorage {
        try LegacyRNStorage(containerURL: container, bundleIdentifier: bundleIdentifier)
    }

    @discardableResult
    private func store(_ entries: [String: Any], at path: String? = nil) throws -> URL {
        let directory = container.appendingPathComponent(path ?? current)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
            .write(to: directory.appendingPathComponent("manifest.json"))
        return directory
    }

    private func state(_ reader: LegacyRNStorage) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reader.bootState().stateJSON.utf8)) as? [String: Any])
    }

    private func bytes() throws -> [String: Data] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: container, includingPropertiesForKeys: [.isRegularFileKey]))
        var result: [String: Data] = [:]
        while let url = enumerator.nextObject() as? URL {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                result[String(url.path.dropFirst(container.path.count))] = try Data(contentsOf: url)
            }
        }
        return result
    }

    func testInlineUnicodeAndUnrelatedPreferencesAreReadableWithoutChanges() throws {
        let backup = "  {\"tasks\":[{\"title\":\"Café 🧠 فارسی\"}]}\n"
        try store([
            "mindwtr-data": backup,
            "mindwtr-language": "fa",
            "@mindwtr_theme": "system-oled",
            "unrelated": "retain me",
            "clé 😀": "مرحبا 👋",
        ])
        let before = try bytes()
        for _ in 0..<3 {
            let loaded = try reader()
            XCTAssertEqual(try loaded.value(forKey: "clé 😀"), "مرحبا 👋")
            XCTAssertEqual(try loaded.value(forKey: "mindwtr-language"), "fa")
            XCTAssertEqual(try loaded.value(forKey: "@mindwtr_theme"), "system-oled")
            XCTAssertEqual(try loaded.value(forKey: "unrelated"), "retain me")
            XCTAssertNil(try loaded.value(forKey: "missing"))
            XCTAssertEqual(try loaded.bootState().backupJSON, backup)
            XCTAssertEqual(Set(try state(loaded).keys), ["jsonAhead", "reconciled", "backupVersion", "backupPresent"])
        }
        XCTAssertEqual(try bytes(), before)
    }

    func testMD5BackedValuesUseLowercaseUTF8DigestAndAllowLargeBackups() throws {
        let directory = try store(["mindwtr-data": NSNull(), "clé 😀": NSNull()])
        // Fixed digests from the RN MD5 format; the test does not call reader hashing.
        let backup = String(repeating: "x", count: 3 * 1024 * 1024) + "😀"
        try Data(backup.utf8).write(to: directory.appendingPathComponent("d59baf067e1f6acb9879d4a44c5bc756"))
        try Data("été 🧠".utf8).write(to: directory.appendingPathComponent("20fa0a4a007952ce0a20fac39e754bcc"))
        let before = try bytes()
        let loaded = try reader()
        XCTAssertEqual(try loaded.bootState().backupJSON, backup)
        XCTAssertEqual(try loaded.value(forKey: "clé 😀"), "été 🧠")
        XCTAssertEqual(try bytes(), before)
    }

    func testBackupFallbackUsesFirstPresentEvenWhenEmptyOrInvalidJSON() throws {
        let keys = ["mindwtr-data", "focus-gtd-data", "gtd-todo-data", "gtd-data"]
        for start in keys.indices {
            var entries = Dictionary(uniqueKeysWithValues: keys[start...].map { ($0, "raw-\($0)") })
            try store(entries)
            XCTAssertEqual(try reader().bootState().backupJSON, "raw-\(keys[start])")
            entries[keys[start]] = ""
            try store(entries)
            let loaded = try reader()
            XCTAssertEqual(try loaded.bootState().backupJSON, "")
            XCTAssertEqual(try state(loaded)["backupPresent"] as? Bool, true)
        }
    }

    func testExternalBackupBOMMatchesRNFileReaderWithoutChangingBytes() throws {
        let directory = try store(["mindwtr-data": NSNull()])
        let external = directory.appendingPathComponent("d59baf067e1f6acb9879d4a44c5bc756")
        for markerCount in 0...2 {
            let raw = Data(Array(repeating: [UInt8](arrayLiteral: 0xEF, 0xBB, 0xBF), count: markerCount).flatMap { $0 })
                + Data("{\"tasks\":[],\"text\":\"été e\u{301} 🧠\"}".utf8)
            try raw.write(to: external)
            let before = try bytes()
            var encoding: UInt = 0
            let expected = try NSString(contentsOfFile: external.path, usedEncoding: &encoding) as String
            XCTAssertEqual(encoding, String.Encoding.utf8.rawValue, "markers=\(markerCount)")
            let expectedBytes = Data(expected.utf8)
            let loaded = try reader()
            let actual = Data(try loaded.bootState().backupJSON.utf8)
            XCTAssertEqual(actual, expectedBytes, "markers=\(markerCount), RN expected UTF8 \(Array(expectedBytes)); backup actual UTF8 \(Array(actual))")
            XCTAssertEqual(try bytes(), before)
        }
    }

    func testMarkersUsePresenceAndAreNeverCleared() throws {
        try store([
            "mindwtr-data:json-ahead-of-sqlite": "",
            "mindwtr-data:sqlite-json-reconcile-v1": "false",
            "mindwtr-data:startup-backup-version": "2",
        ])
        let before = try bytes()
        let result = try state(reader())
        XCTAssertEqual(result["jsonAhead"] as? Bool, true)
        XCTAssertEqual(result["reconciled"] as? Bool, true)
        XCTAssertEqual(result["backupVersion"] as? String, "2")
        XCTAssertEqual(result["backupPresent"] as? Bool, false)
        XCTAssertEqual(try bytes(), before)
    }

    func testAbsentAndTrulyEmptyStoresAreValid() throws {
        for makeDirectory in [false, true] {
            if makeDirectory {
                try FileManager.default.createDirectory(at: container.appendingPathComponent(current), withIntermediateDirectories: true)
            }
            let loaded = try reader()
            let result = try state(loaded)
            XCTAssertEqual(result["jsonAhead"] as? Bool, false)
            XCTAssertEqual(result["reconciled"] as? Bool, false)
            XCTAssertTrue(result["backupVersion"] is NSNull)
            XCTAssertEqual(result["backupPresent"] as? Bool, false)
            XCTAssertEqual(try loaded.bootState().backupJSON, "")
            XCTAssertEqual(try bytes(), [:])
        }
        try store([:])
        XCTAssertNil(try reader().value(forKey: "mindwtr-data"))
    }

    func testEveryLegacyLocationLoadsAndMatchingCopiesAreSafe() throws {
        for path in legacy {
            let directory = try store(["gtd-data": "old backup", "unrelated": "unchanged"], at: path)
            XCTAssertEqual(try reader().bootState().backupJSON, "old backup")
            try FileManager.default.removeItem(at: directory)
        }
        for path in [current] + legacy { try store(["mindwtr-data": "same backup"], at: path) }
        let before = try bytes()
        XCTAssertEqual(try reader().bootState().backupJSON, "same backup")
        XCTAssertEqual(try bytes(), before)
    }

    func testEmptyCurrentStoreDoesNotHidePopulatedLegacyStore() throws {
        try store([:])
        try store(["mindwtr-data": "still present"], at: legacy[0])
        XCTAssertEqual(try reader().bootState().backupJSON, "still present")
    }

    func testConflictingCopiesIncludingUnrelatedValuesFailWithoutWrites() throws {
        try store(["mindwtr-data": "same", "unrelated": "new"])
        try store(["mindwtr-data": "same", "unrelated": "old"], at: legacy[0])
        let before = try bytes()
        XCTAssertThrowsError(try reader()) { XCTAssertTrue($0.localizedDescription.contains("Conflicting")) }
        XCTAssertEqual(try bytes(), before)
        try store(["mindwtr-data": "é"])
        try store(["mindwtr-data": "e\u{301}"], at: legacy[0])
        XCTAssertThrowsError(try reader())
    }

    func testCanonicalUnicodeKeysRemainDistinct() throws {
        let directory = try store([:])
        try Data("{\"é\":\"composed\",\"e\\u0301\":\"decomposed\"}".utf8)
            .write(to: directory.appendingPathComponent("manifest.json"))
        let loaded = try reader()
        XCTAssertEqual(try loaded.value(forKey: "é"), "composed")
        XCTAssertEqual(try loaded.value(forKey: "e\u{301}"), "decomposed")
    }

    func testMalformedManifestAndInvalidShapesFailWithoutWrites() throws {
        let directory = try store([:])
        for invalid in ["broken", "[]", "null", "{\"k\":42}", "{\"k\":true}", "{\"k\":{}}", "{\"k\":[]}", "{\"\":\"bad\"}"] {
            try Data(invalid.utf8).write(to: directory.appendingPathComponent("manifest.json"))
            let before = try bytes()
            XCTAssertThrowsError(try reader(), invalid)
            XCTAssertEqual(try bytes(), before)
        }
        try Data([0xff]).write(to: directory.appendingPathComponent("manifest.json"))
        XCTAssertThrowsError(try reader())
    }

    func testMissingExternalValueAndInvalidUTF8FailEvenForUnrelatedEntry() throws {
        let directory = try store(["mindwtr-data": "valid", "hello": NSNull()])
        XCTAssertThrowsError(try reader())
        try Data([0xff]).write(to: directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592"))
        XCTAssertThrowsError(try reader())
    }

    func testNonemptyDirectoryWithoutManifestAndCorruptLegacyCopyFail() throws {
        let directory = try store(["mindwtr-data": "valid"])
        try FileManager.default.removeItem(at: directory.appendingPathComponent("manifest.json"))
        try Data("orphaned data".utf8).write(to: directory.appendingPathComponent("orphan"))
        XCTAssertThrowsError(try reader())
        try store(["mindwtr-data": "valid"])
        let old = try store([:], at: legacy[0])
        try Data("broken".utf8).write(to: old.appendingPathComponent("manifest.json"))
        XCTAssertThrowsError(try reader())
    }

    func testUnreadableManifestAndExternalValueFailWithoutLeakingDetails() throws {
        let directory = try store(["hello": NSNull()])
        let external = directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592")
        try Data("sensitive value".utf8).write(to: external)
        for file in [directory.appendingPathComponent("manifest.json"), external] {
            try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
            if FileManager.default.isReadableFile(atPath: file.path) { throw XCTSkip("Requires an unprivileged test process") }
            XCTAssertThrowsError(try reader()) {
                XCTAssertFalse($0.localizedDescription.contains(self.container.path))
                XCTAssertFalse($0.localizedDescription.contains("hello"))
                XCTAssertFalse($0.localizedDescription.contains("sensitive value"))
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }

    func testFileSizeLimitsFailBeforeReadingSparseFiles() throws {
        let directory = try store(["hello": NSNull()])
        let external = directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592")
        XCTAssertTrue(FileManager.default.createFile(atPath: external.path, contents: nil))
        let file = try FileHandle(forWritingTo: external)
        try file.truncate(atOffset: 256 * 1024 * 1024 + 1)
        try file.close()
        XCTAssertThrowsError(try reader()) { XCTAssertTrue($0.localizedDescription.contains("safe read limit")) }
        let manifest = try FileHandle(forWritingTo: directory.appendingPathComponent("manifest.json"))
        try manifest.truncate(atOffset: 64 * 1024 * 1024 + 1)
        try manifest.close()
        XCTAssertThrowsError(try reader()) { XCTAssertTrue($0.localizedDescription.contains("safe read limit")) }
    }

    func testSymlinksAndNonDirectoryStoragePathsFail() throws {
        let directory = try store(["hello": NSNull()])
        let target = container.appendingPathComponent("outside-value")
        try Data("untouched".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592"), withDestinationURL: target)
        XCTAssertThrowsError(try reader())
        try FileManager.default.removeItem(at: directory)
        try Data("not a directory".utf8).write(to: directory)
        XCTAssertThrowsError(try reader())
        XCTAssertEqual(try Data(contentsOf: target), Data("untouched".utf8))
        XCTAssertThrowsError(try LegacyRNStorage(containerURL: container, bundleIdentifier: "../escape"))
    }

    func testAuthorityCommitPreservesUnknownValuesExternalFilesAndOriginalCheckpoint() throws {
        let directory = try store([:])
        let manifest = directory.appendingPathComponent("manifest.json")
        let original = Data("{\"mindwtr-data:json-ahead-of-sqlite\":\"1\",\"mindwtr-data\":\"raw backup\",\"hello\":null,\"é\":\"composed\",\"e\\u0301\":\"decomposed\",\"unknown 😀\":\"فارسی\"}".utf8)
        try original.write(to: manifest)
        let external = directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592")
        let externalBytes = Data("keep this exact byte sequence 🧠".utf8)
        try externalBytes.write(to: external)
        let loaded = try reader()
        XCTAssertTrue(loaded.hasStoredValues)
        try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint)
        XCTAssertEqual(try Data(contentsOf: checkpoint), original)
        XCTAssertEqual(try Data(contentsOf: external), externalBytes)
        let next = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? NSDictionary)
        let previous = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? NSDictionary)
        for (rawKey, value) in previous where rawKey as? String != "mindwtr-data:json-ahead-of-sqlite" {
            let key = try XCTUnwrap(rawKey as? String)
            XCTAssertTrue((next[key] as? NSObject)?.isEqual(value) == true, key)
        }
        XCTAssertNil(next["mindwtr-data:json-ahead-of-sqlite"])
        XCTAssertEqual(next["mindwtr-data:sqlite-json-reconcile-v1"] as? String, "1")
        let reopened = try reader()
        XCTAssertEqual(try reopened.value(forKey: "é"), "composed")
        XCTAssertEqual(try reopened.value(forKey: "e\u{301}"), "decomposed")
        XCTAssertEqual(try reopened.bootState().backupJSON, "raw backup")
        // The immutable old snapshot remains available for exact retry.
        XCTAssertEqual(try loaded.value(forKey: "mindwtr-data:json-ahead-of-sqlite"), "1")
    }

    func testAuthorityNoOpAndStrictBooleanValidationWriteNothing() throws {
        XCTAssertFalse(try reader().hasStoredValues)
        try reader().commit(changeJSON: "{\"clearJsonAhead\":false,\"setReconciled\":false}", checkpointURL: checkpoint)
        try store(["mindwtr-data": "raw", "unknown": "preserved"])
        let loaded = try reader()
        let before = try bytes()
        for invalid in [
            "broken", "[]", "{}", "{\"clearJsonAhead\":true}",
            "{\"clearJsonAhead\":true,\"setReconciled\":null}",
            "{\"clearJsonAhead\":1,\"setReconciled\":false}",
            "{\"clearJsonAhead\":false,\"setReconciled\":0}",
            "{\"clearJsonAhead\":\"true\",\"setReconciled\":false}",
            "{\"clearJsonAhead\":false,\"setReconciled\":false,\"extra\":true}",
        ] { XCTAssertThrowsError(try loaded.commit(changeJSON: invalid, checkpointURL: checkpoint)) }
        try loaded.commit(changeJSON: "{\"clearJsonAhead\":false,\"setReconciled\":false}", checkpointURL: checkpoint)
        XCTAssertEqual(try bytes(), before)
    }

    func testCheckpointFailureAndPromotionFailureLeaveSourceUnchanged() throws {
        try store(["mindwtr-data": "raw", "mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        let before = try bytes()
        loaded.commitFaults.beforeCheckpoint = { throw HostFailure("Injected checkpoint failure") }
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try bytes(), before)
        loaded.commitFaults.beforeCheckpoint = nil
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: container.appendingPathComponent("missing/checkpoint")))
        XCTAssertEqual(try bytes(), before)
        loaded.commitFaults.beforePromotion = { throw HostFailure("Injected promotion failure") }
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        var after = try bytes()
        after.removeValue(forKey: "/rn-manifest.prewrite.json")
        XCTAssertEqual(after, before)
        loaded.commitFaults.beforePromotion = nil
        try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint)
    }

    func testChangedManifestOrExternalValueRefusesCommitBeforeCheckpoint() throws {
        let directory = try store(["hello": NSNull(), "mindwtr-data:json-ahead-of-sqlite": "1"])
        let manifest = directory.appendingPathComponent("manifest.json")
        let original = try Data(contentsOf: manifest)
        let external = directory.appendingPathComponent("5d41402abc4b2a76b9719d911017c592")
        try Data("original".utf8).write(to: external)
        let loaded = try reader()
        try (original + Data("\n".utf8)).write(to: manifest)
        var before = try bytes()
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try bytes(), before)
        try original.write(to: manifest)
        try Data("changed".utf8).write(to: external)
        before = try bytes()
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try bytes(), before)
    }

    func testSourceIsRevalidatedAfterCheckpointBeforePromotion() throws {
        let directory = try store(["mindwtr-data": "original", "mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        let changed = Data("{\"mindwtr-data\":\"changed concurrently\"}".utf8)
        let manifest = directory.appendingPathComponent("manifest.json")
        loaded.commitFaults.beforePromotion = { try changed.write(to: manifest) }
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try Data(contentsOf: manifest), changed)
    }

    func testLostReadbackAcknowledgmentAndRepeatedCommitsConverge() throws {
        let directory = try store(["mindwtr-data": "raw", "mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        loaded.commitFaults.beforeReadback = { throw HostFailure("Injected lost acknowledgment") }
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        let once = try bytes()
        loaded.commitFaults.beforeReadback = nil
        try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint)
        try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint)
        try reader().commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint)
        XCTAssertEqual(try bytes(), once)
        XCTAssertNotEqual(try Data(contentsOf: checkpoint), try Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        let result = try state(reader())
        XCTAssertEqual(result["jsonAhead"] as? Bool, false)
        XCTAssertEqual(result["reconciled"] as? Bool, true)
    }

    func testCorruptReadbackNeverAcknowledgesSuccess() throws {
        let directory = try store(["mindwtr-data": "raw", "mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        let manifest = directory.appendingPathComponent("manifest.json")
        let original = try Data(contentsOf: manifest)
        loaded.commitFaults.beforeReadback = { try Data("corrupt".utf8).write(to: manifest) }
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try Data(contentsOf: checkpoint), original)
    }

    func testCorruptCheckpointAndCheckpointAliasRefuseBeforeSourceMutation() throws {
        let directory = try store(["mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        let manifest = directory.appendingPathComponent("manifest.json")
        try Data("wrong checkpoint".utf8).write(to: checkpoint)
        let before = try bytes()
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertThrowsError(try loaded.commit(changeJSON: clearAndReconcile, checkpointURL: manifest))
        XCTAssertEqual(try bytes(), before)
    }

    func testMultiplePopulatedStoresAndEmptyStoresCannotReceiveMarkerWrites() throws {
        XCTAssertThrowsError(try reader().commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        try store([:])
        XCTAssertThrowsError(try reader().commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        let entries = ["mindwtr-data": "raw", "mindwtr-data:json-ahead-of-sqlite": "1"]
        try store(entries)
        let single = try reader()
        try store(entries, at: legacy[0])
        let before = try bytes()
        XCTAssertThrowsError(try single.commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertThrowsError(try reader().commit(changeJSON: clearAndReconcile, checkpointURL: checkpoint))
        XCTAssertEqual(try bytes(), before)
    }

    func testClearOnlyCommitCanLeaveAnEmptyManifestAndRetry() throws {
        try store(["mindwtr-data:json-ahead-of-sqlite": "1"])
        let loaded = try reader()
        let clearOnly = "{\"clearJsonAhead\":true,\"setReconciled\":false}"
        try loaded.commit(changeJSON: clearOnly, checkpointURL: checkpoint)
        let once = try bytes()
        try loaded.commit(changeJSON: clearOnly, checkpointURL: checkpoint)
        XCTAssertEqual(try bytes(), once)
        XCTAssertFalse(try reader().hasStoredValues)
    }
}
