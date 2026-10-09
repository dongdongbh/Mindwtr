import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeDeviceKVTests: XCTestCase {
    private var container: URL!
    private var current: NativeDeviceKV?
    private var additionalRoots: [URL] = []
    private let bundle = "tech.dongdongbh.mindwtr.kv-tests"
    private let backend = "@mindwtr_sync_backend"
    private let path = "@mindwtr_sync_path"
    private let webdav = "@mindwtr_webdav_url"
    private var namespace: URL {
        container.appendingPathComponent("Library/Application Support/\(bundle)/RCTAsyncLocalStorage_V1")
    }
    private var manifest: URL { namespace.appendingPathComponent("manifest.json") }
    private var lock: URL { namespace.deletingLastPathComponent().appendingPathComponent(".mindwtr-device-kv.lock") }
    private enum Injected: Error { case failure }

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        container = base.appendingPathComponent(".mindwtr-native-tests/device-kv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        current?.close(); current = nil
        if let container { try FileManager.default.removeItem(at: container) }
        for root in additionalRoots where FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        additionalRoots.removeAll()
    }
    private func open() throws -> NativeDeviceKV {
        let store = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        current = store
        return store
    }
    private func seed(_ json: String, at directory: URL? = nil) throws {
        let target = directory ?? namespace
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: target.appendingPathComponent("manifest.json"))
    }
    private func inode(_ url: URL) throws -> UInt64 {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { throw Injected.failure }
        return UInt64(value.st_ino)
    }
    private func bytes() throws -> [String: Data] {
        let entries = try XCTUnwrap(FileManager.default.enumerator(at: container, includingPropertiesForKeys: [.isRegularFileKey]))
        var result: [String: Data] = [:]
        while let url = entries.nextObject() as? URL {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                result[String(url.path.dropFirst(container.path.count))] = try Data(contentsOf: url)
            }
        }
        return result
    }
    private func externalBytes() throws -> [String: Data] {
        try bytes().filter { !$0.key.hasSuffix("/manifest.json") && !$0.key.hasSuffix("/.mindwtr-device-kv.lock") }
    }
    private func sameByteReplacement(_ url: URL) throws {
        let original = try Data(contentsOf: url)
        let replacement = url.deletingLastPathComponent().appendingPathComponent("foreign-\(UUID().uuidString)")
        try original.write(to: replacement)
        guard rename(replacement.path, url.path) == 0 else { throw Injected.failure }
    }

    func testRNInlineExternalUnicodeAndBOMReadWithoutChangingRecords() throws {
        try seed("{\"é\":\"composed\",\"e\\u0301\":\"decomposed\",\"empty\":\"\",\"clé 😀\":null,\"\\uFEFFrecord\":\"\\uFEFFkeep 🧠\",\"mindwtr-data\":\"raw backup\"}")
        let external = namespace.appendingPathComponent("20fa0a4a007952ce0a20fac39e754bcc")
        try Data("été 🧠".utf8).write(to: external)
        let originalManifest = try Data(contentsOf: manifest)
        let originalExternal = try Data(contentsOf: external)
        let store = try open()
        let result = try store.multiGet(["é", "e\u{301}", "empty", "missing", "é", "clé 😀", "\u{FEFF}record"])
        XCTAssertEqual(result.map { Data($0.0.utf8) }, ["é", "e\u{301}", "empty", "missing", "é", "clé 😀", "\u{FEFF}record"].map { Data($0.utf8) })
        XCTAssertEqual(result.map { $0.1 }, ["composed", "decomposed", "", nil, "composed", "été 🧠", "\u{FEFF}keep 🧠"])
        XCTAssertEqual(try Data(contentsOf: manifest), originalManifest)
        XCTAssertEqual(try Data(contentsOf: external), originalExternal)
        XCTAssertEqual(try store.get("mindwtr-data"), "raw backup")
    }

    func testAtomicSelectedBatchesKeepUnknownRecordsAndEveryExternalFile() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\",\"@mindwtr_sync_path\":null,\"mindwtr-data\":\"  opaque backup 🧠\\n\",\"mindwtr-data:json-ahead-of-sqlite\":\"\",\"unknown\":\"\\uFEFFsame\"}")
        // RN's MD5 filename for @mindwtr_sync_path, plus an unreferenced old file.
        let externalName = "3841382bf18a349689a3256aa5be82e1"
        try Data("original external value".utf8).write(to: namespace.appendingPathComponent(externalName))
        let unicode = namespace.appendingPathComponent("old-provider-bytes")
        try Data("source 🧠".utf8).write(to: unicode)
        let before = try externalBytes()
        let store = try open()
        let long = String(repeating: "a", count: 2048) + "🧠"
        try store.multiSet([(backend, "webdav"), (path, "first"), (path, long), (webdav, "")])
        XCTAssertEqual(try store.get(path), long)
        XCTAssertEqual(try store.get(webdav), "")
        XCTAssertEqual(try store.get(backend), "webdav")
        let inlineReader = try LegacyRNStorage(containerURL: container, bundleIdentifier: bundle)
        XCTAssertEqual(try inlineReader.value(forKey: path), long)
        let inlineManifest = try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? NSDictionary)
        XCTAssertEqual(inlineManifest[path] as? String, long)
        try store.multiRemove([path, webdav, path])
        XCTAssertNil(try store.get(path))
        XCTAssertNil(try store.get(webdav))
        XCTAssertEqual(try store.get("mindwtr-data"), "  opaque backup 🧠\n")
        XCTAssertEqual(try store.get("mindwtr-data:json-ahead-of-sqlite"), "")
        XCTAssertEqual(try externalBytes(), before)
        let lockInode = try inode(lock)
        store.close(); current = nil
        XCTAssertEqual(try inode(lock), lockInode)
        let reopened = try open()
        XCTAssertEqual(try reopened.get(backend), "webdav")
        let rn = try LegacyRNStorage(containerURL: container, bundleIdentifier: bundle)
        XCTAssertEqual(try rn.value(forKey: backend), "webdav")
    }

    func testExternalBOMUsesRNDecodedValueWhileKeepingOriginalFileBytes() throws {
        let external = namespace.appendingPathComponent("3841382bf18a349689a3256aa5be82e1")
        for markerCount in 0...2 {
            try seed("{\"@mindwtr_sync_backend\":\"off\",\"@mindwtr_sync_path\":null,\"unknown\":\"\\uFEFFinline\"}")
            let raw = Data(Array(repeating: [UInt8](arrayLiteral: 0xEF, 0xBB, 0xBF), count: markerCount).flatMap { $0 })
                + Data("a été e\u{301} 🧠".utf8)
            try raw.write(to: external)
            let sourceInode = try inode(external)
            var encoding: UInt = 0
            let expected = try NSString(contentsOfFile: external.path, usedEncoding: &encoding) as String
            XCTAssertEqual(encoding, String.Encoding.utf8.rawValue, "markers=\(markerCount)")
            let expectedBytes = Data(expected.utf8)
            let rn = try LegacyRNStorage(containerURL: container, bundleIdentifier: bundle)
            let legacyBytes = Data(try XCTUnwrap(rn.value(forKey: path)).utf8)
            XCTAssertEqual(legacyBytes, expectedBytes, "markers=\(markerCount), RN expected UTF8 \(Array(expectedBytes)); Legacy actual UTF8 \(Array(legacyBytes))")
            let store = try open()
            let storeBytes = Data(try XCTUnwrap(store.get(path)).utf8)
            XCTAssertEqual(storeBytes, expectedBytes, "markers=\(markerCount), RN expected UTF8 \(Array(expectedBytes)); store actual UTF8 \(Array(storeBytes))")
            XCTAssertEqual(try store.get("unknown"), "\u{FEFF}inline")
            try store.set(backend, "webdav")
            let afterBytes = Data(try XCTUnwrap(store.get(path)).utf8)
            XCTAssertEqual(afterBytes, expectedBytes, "markers=\(markerCount), RN expected UTF8 \(Array(expectedBytes)); after mutation actual UTF8 \(Array(afterBytes))")
            XCTAssertEqual(try Data(contentsOf: external), raw)
            XCTAssertEqual(try inode(external), sourceInode)
            store.close(); current = nil
        }
    }

    func testReminderUnchangedConfirmationForcesDurablePublicationAndRetainsExactLostAck() throws {
        let names = ["mindwtr:local:alarms:v1", "mindwtr:native:reminders:v1"]
        let values = ["mindwtr:local:alarms:v1": "  {} \n", "mindwtr:native:reminders:v1": "{}", "unknown": "PRIVATE_DISJOINT"]
        try seed(String(decoding: JSONSerialization.data(withJSONObject: values), as: UTF8.self))
        let store = try open(), before = try store.multiGet(names).map(\.1)
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        try store.compareAndSetReminderMaps(expected: before, next: before)
        XCTAssertEqual(promotions, 0)
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.compareAndSetReminderMaps(expected: before, next: before, confirmUnchanged: true))
        XCTAssertEqual(promotions, 1); XCTAssertTrue(store.hasPendingReminderMutation)
        let promoted = try Data(contentsOf: manifest), promotedInode = try inode(manifest)
        XCTAssertThrowsError(try store.multiGet(names))
        XCTAssertThrowsError(try store.compareAndSetReminderMaps(expected: before, next: [before[0], "{\"foreign\":true}"], confirmUnchanged: true))
        store.faults.afterPromotion = nil
        try store.compareAndSetReminderMaps(expected: before, next: before, confirmUnchanged: true)
        XCTAssertFalse(store.hasPendingReminderMutation); XCTAssertEqual(promotions, 1)
        XCTAssertEqual(try inode(manifest), promotedInode); XCTAssertEqual(try Data(contentsOf: manifest), promoted)
        XCTAssertEqual(try store.multiGet(names).map(\.1), before); XCTAssertEqual(try store.get("unknown"), "PRIVATE_DISJOINT")
        store.close(); current = nil
        let cold = try open(); XCTAssertEqual(try cold.multiGet(names).map(\.1), before)
    }
    func testReminderUnchangedConfirmationRejectsSameByteForeignLostAck() throws {
        let names = ["mindwtr:local:alarms:v1", "mindwtr:native:reminders:v1"]
        try seed("{\"mindwtr:local:alarms:v1\":\"{}\",\"mindwtr:native:reminders:v1\":\"{}\"}")
        let store = try open(), before = try store.multiGet(names).map(\.1)
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.compareAndSetReminderMaps(expected: before, next: before, confirmUnchanged: true))
        try sameByteReplacement(manifest); let foreign = try Data(contentsOf: manifest)
        store.faults.afterPromotion = nil
        XCTAssertThrowsError(try store.compareAndSetReminderMaps(expected: before, next: before, confirmUnchanged: true))
        XCTAssertEqual(try Data(contentsOf: manifest), foreign)
    }

    func testLostPromotionAcknowledgmentRetainsExactOperationAndColdRows() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\",\"unknown\":\"keep\"}")
        let store = try open()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.multiSet([(backend, "webdav"), (path, "bound path")]))
        let promoted = try Data(contentsOf: manifest)
        let promotedInode = try inode(manifest)
        XCTAssertThrowsError(try store.set(backend, "cloud"))
        XCTAssertThrowsError(try store.get(backend))
        XCTAssertEqual(try Data(contentsOf: manifest), promoted)
        store.faults.afterPromotion = nil
        try store.multiSet([(backend, "webdav"), (path, "bound path")])
        XCTAssertEqual(try inode(manifest), promotedInode)
        XCTAssertEqual(try Data(contentsOf: manifest), promoted)
        XCTAssertEqual(try store.get(backend), "webdav")
        store.close(); current = nil
        let reopened = try open()
        XCTAssertEqual(try reopened.get(path), "bound path")
        XCTAssertEqual(try reopened.get("unknown"), "keep")
    }

    func testNewAndEmptyCanonicalOpeningDoesNotPublishASettingsManifest() throws {
        for alreadyEmpty in [false, true] {
            if alreadyEmpty { try seed("{}") }
            let before = FileManager.default.fileExists(atPath: manifest.path) ? try Data(contentsOf: manifest) : nil
            let store = try open()
            XCTAssertNil(try store.get(backend))
            XCTAssertEqual(try store.multiGet([]).count, 0)
            if let before { XCTAssertEqual(try Data(contentsOf: manifest), before) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path)) }
            store.close(); current = nil
        }
    }

    func testEveryPopulatedOldDocumentsCopyRefusesIncludingMatchingCanonical() throws {
        let legacyPaths = ["RCTAsyncLocalStorage_V1", "RNCAsyncLocalStorage_V1", "RCTAsyncLocalStorage"]
        for name in legacyPaths {
            let old = container.appendingPathComponent("Documents/\(name)")
            try seed("{\"@mindwtr_sync_backend\":\"off\"}", at: old)
            if name != legacyPaths[0] { try seed("{\"@mindwtr_sync_backend\":\"off\"}") }
            let before = try bytes()
            XCTAssertThrowsError(try open())
            XCTAssertEqual(try bytes(), before)
            try FileManager.default.removeItem(at: old)
        }
    }

    func testEmptyOldDocumentsCopyDoesNotGrantMigrationOrHideCurrentValues() throws {
        let old = container.appendingPathComponent("Documents/RCTAsyncLocalStorage_V1")
        try seed("{}", at: old)
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let oldBytes = try Data(contentsOf: old.appendingPathComponent("manifest.json"))
        let store = try open()
        try store.set(backend, "webdav")
        XCTAssertEqual(try store.get(backend), "webdav")
        XCTAssertEqual(try Data(contentsOf: old.appendingPathComponent("manifest.json")), oldBytes)
    }

    func testExactWriteAllowlistAndSecretRemoveOnlyAdmission() throws {
        let removeOnly = ["@mindwtr_webdav_password", "@mindwtr_cloud_token", "@mindwtr_sync_encryption_key_v1"]
        let denied = ["mindwtr-ai-provider-consent-v1", "mindwtr-ai-key_openai", "mindwtr-data", "gtd-data",
            "mindwtr-data:json-ahead-of-sqlite", "mindwtr-data:sqlite-json-reconcile-v1",
            "@mindwtr_attachment_presence_reconcile_v1_extra", "@mindwtr/file-sync-publication-reservations-v1",
            "mindwtr-external-calendars_extra", "mindwtr-system-calendar-settings_extra", "@mindwtr_background_sync_failure_state_v1",
            "@mindwtr_background_sync_last_registered_interval", "@mindwtr_dropbox_last_rev",
            "@mindwtr_cloudkit_change_token", "@mindwtr_cloudkit_seeded", "@mindwtr_cloudkit_zone_created",
            "@mindwtr_sync_backend_extra", "@MINDWTR_SYNC_BACKEND", "unknown"]
        let seedValues = Dictionary(uniqueKeysWithValues: (removeOnly + denied).map { ($0, "\u{FEFF}preserve 🧠") })
        try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: seedValues, options: [.sortedKeys]).write(to: manifest)
        let store = try open()
        let before = try bytes()
        for key in removeOnly + denied { XCTAssertThrowsError(try store.set(key, "refused"), key) }
        for key in denied { XCTAssertThrowsError(try store.remove(key), key) }
        XCTAssertEqual(try bytes(), before)
        let allowed = [backend, path, "@mindwtr_sync_path_bookmark", webdav, "@mindwtr_webdav_username",
            "@mindwtr_webdav_allow_insecure_http", "@mindwtr_webdav_allow_weak_fingerprint",
            "@mindwtr_cloud_provider", "@mindwtr_cloud_url", "@mindwtr_cloud_allow_insecure_http",
            "@mindwtr_sync_encryption_state_v1", "@mindwtr_fast_sync_state_v1", "@mindwtr_local_sync_status_v1",
            "@mindwtr_webdav_capability_proof_v1", "@mindwtr_webdav_legacy_proof_v1",
            "@mindwtr_attachment_presence_reconcile_v1", "mindwtr-external-calendars", "mindwtr-system-calendar-settings"]
        try store.multiSet(allowed.map { ($0, "opaque") })
        XCTAssertEqual(try store.multiGet(allowed).map { $0.1 }, Array(repeating: "opaque", count: allowed.count))
        for key in removeOnly + denied { XCTAssertEqual(try store.get(key), "\u{FEFF}preserve 🧠") }
        try store.multiRemove(allowed)
        XCTAssertEqual(try store.multiGet(allowed).map { $0.1 }, Array(repeating: nil, count: allowed.count))
        for key in removeOnly { try store.remove(key); XCTAssertNil(try store.get(key)) }
        for key in denied { XCTAssertEqual(try store.get(key), "\u{FEFF}preserve 🧠") }
    }

    func testRNSyncPresenceAndCalendarsSurviveReopenWithoutChangingUnknownRecords() throws {
        try seed("{\"unknown\":\"preserve 🧠\"}")
        let entries = [
            ("mindwtr-system-calendar-settings", "{\"enabled\":true,\"selectAll\":false,\"selectedCalendarIds\":[\"é\",\"e\\u0301\"]}"),
            ("@mindwtr_attachment_presence_reconcile_v1", "{\"scope\":\"webdav:opaque 🧠\",\"at\":1791300000000}"),
            ("mindwtr-external-calendars", "[{\"id\":\"calendar-1\",\"name\":\"Calendar 🧠\",\"url\":\"https://example.invalid/feed.ics\",\"enabled\":true}]")
        ]
        let store = try open()
        try store.multiSet(entries)
        store.close()
        let reopened = try open()
        for (key, value) in entries { XCTAssertEqual(try reopened.get(key).map { Data($0.utf8) }, Data(value.utf8)) }
        XCTAssertEqual(try reopened.get("unknown"), "preserve 🧠")
        try reopened.multiRemove(entries.map { $0.0 })
        reopened.close()
        let removed = try open()
        for (key, _) in entries { XCTAssertNil(try removed.get(key)) }
        XCTAssertEqual(try removed.get("unknown"), "preserve 🧠")
    }

    func testEntryKeyValueAndCombinedUTF8BoundsAreValidatedBeforeIO() throws {
        try seed("{}")
        let store = try open()
        let before = try bytes()
        var promotions = 0
        store.faults.beforePromotion = { promotions += 1 }
        XCTAssertEqual(try store.multiGet(Array(repeating: "missing", count: 64)).count, 64)
        XCTAssertThrowsError(try store.multiGet(Array(repeating: "missing", count: 65)))
        XCTAssertNil(try store.get(String(repeating: "k", count: 4096)))
        XCTAssertThrowsError(try store.get(String(repeating: "k", count: 4097)))
        XCTAssertThrowsError(try store.get(""))
        XCTAssertThrowsError(try store.multiSet(Array(repeating: (backend, "off"), count: 65)))
        XCTAssertThrowsError(try store.multiRemove(Array(repeating: backend, count: 65)))
        XCTAssertThrowsError(try store.set(path, String(repeating: "🧠", count: 256 * 1024 + 1)))
        XCTAssertThrowsError(try store.multiSet(Array(repeating: (path, String(repeating: "x", count: 1024 * 1024)), count: 8)))
        XCTAssertEqual(promotions, 0)
        XCTAssertEqual(try bytes(), before)
        try store.set(path, String(repeating: "🧠", count: 256 * 1024))
        XCTAssertEqual(try store.get(path)?.utf8.count, 1024 * 1024)
    }

    func testExactCombinedMutationBudgetAndLastWinsAreAccepted() throws {
        let store = try open()
        let one = 1024 * 1024
        let keyBytes = path.utf8.count * 8
        let entries = [(path, String(repeating: "a", count: one - keyBytes))]
            + (1..<8).map { (path, String(repeating: String($0), count: one)) }
        XCTAssertEqual(entries.reduce(0) { $0 + $1.0.utf8.count + $1.1.utf8.count }, 8 * one)
        try store.multiSet(entries)
        XCTAssertEqual(try store.get(path), String(repeating: "7", count: one))
        try store.multiRemove(Array(repeating: path, count: 64))
        XCTAssertNil(try store.get(path))
    }

    func testLifetimeNamespaceLeaseBlocksSecondOwnerAndIsNeverDeleted() throws {
        let store = try open()
        let lockInode = try inode(lock)
        XCTAssertThrowsError(try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle))
        try store.set(backend, "off")
        store.close(); current = nil
        XCTAssertEqual(try inode(lock), lockInode)
        let next = try open()
        XCTAssertEqual(try next.get(backend), "off")
        XCTAssertEqual(try inode(lock), lockInode)
    }

    func testSymlinkNamespaceAndLockAreRefusedWithoutTouchingTargets() throws {
        try seed("{}")
        let foreign = container.appendingPathComponent("foreign-directory")
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: true)
        let target = foreign.appendingPathComponent("lock-target")
        try Data("keep target".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: lock, withDestinationURL: target)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: target), Data("keep target".utf8))
        try FileManager.default.removeItem(at: lock)
        let original = namespace.deletingLastPathComponent().appendingPathComponent("original-namespace")
        try FileManager.default.moveItem(at: namespace, to: original)
        try FileManager.default.createSymbolicLink(at: namespace, withDestinationURL: original)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: original.appendingPathComponent("manifest.json")), Data("{}".utf8))
    }

    func testHardlinkedAndNonregularLockAreRefused() throws {
        try seed("{}")
        let target = container.appendingPathComponent("hardlink-target")
        try Data("keep".utf8).write(to: target)
        XCTAssertEqual(link(target.path, lock.path), 0)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: target), Data("keep".utf8))
        try FileManager.default.removeItem(at: lock)
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: manifest), Data("{}".utf8))
    }

    func testLockReplacementPoisonsOwnerAndPreservesForeignEntry() throws {
        let store = try open()
        let previous = try inode(lock)
        try sameByteReplacement(lock)
        XCTAssertNotEqual(try inode(lock), previous)
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path))
        XCTAssertThrowsError(try store.get(backend))
    }

    func testSameByteManifestReplacementPoisonsReadsAndWrites() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        let original = try Data(contentsOf: manifest)
        let originalInode = try inode(manifest)
        try sameByteReplacement(manifest)
        XCTAssertNotEqual(try inode(manifest), originalInode)
        XCTAssertThrowsError(try store.get(backend))
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertEqual(try Data(contentsOf: manifest), original)
    }

    func testSameByteForeignManifestCannotAcknowledgeLostPromotion() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        let promoted = try Data(contentsOf: manifest)
        let promotedInode = try inode(manifest)
        try sameByteReplacement(manifest)
        XCTAssertNotEqual(try inode(manifest), promotedInode)
        store.faults.afterPromotion = nil
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertThrowsError(try store.remove(backend))
        XCTAssertEqual(try Data(contentsOf: manifest), promoted)
    }

    func testHardlinkedManifestAndExternalSymlinkOrHardlinkAreRefused() throws {
        try seed("{}")
        let extra = container.appendingPathComponent("manifest-hardlink")
        XCTAssertEqual(link(manifest.path, extra.path), 0)
        XCTAssertThrowsError(try open())
        try FileManager.default.removeItem(at: extra)
        try seed("{\"clé 😀\":null}")
        let target = container.appendingPathComponent("external-target")
        try Data("retained".utf8).write(to: target)
        let external = namespace.appendingPathComponent("20fa0a4a007952ce0a20fac39e754bcc")
        try FileManager.default.createSymbolicLink(at: external, withDestinationURL: target)
        XCTAssertThrowsError(try open())
        try FileManager.default.removeItem(at: external)
        XCTAssertEqual(link(target.path, external.path), 0)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try Data(contentsOf: target), Data("retained".utf8))
    }

    func testExternalGenerationReplacementRefusesEvenWhenBytesMatch() throws {
        try seed("{\"clé 😀\":null,\"@mindwtr_sync_backend\":\"off\"}")
        let external = namespace.appendingPathComponent("20fa0a4a007952ce0a20fac39e754bcc")
        try Data("retain bytes".utf8).write(to: external)
        let store = try open()
        let original = try Data(contentsOf: manifest)
        let before = try inode(external)
        try sameByteReplacement(external)
        XCTAssertNotEqual(try inode(external), before)
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertEqual(try Data(contentsOf: external), Data("retain bytes".utf8))
    }

    func testBeforePromotionFailureRetriesOnlyExactBeforeOperation() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        let original = try Data(contentsOf: manifest)
        let originalInode = try inode(manifest)
        store.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertEqual(try inode(manifest), originalInode)
        XCTAssertThrowsError(try store.remove(backend))
        store.faults.beforePromotion = nil
        try store.set(backend, "webdav")
        XCTAssertEqual(try store.get(backend), "webdav")
    }

    func testReadbackFailureKeepsOwnedAfterAndColdOpeningNeverReplays() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\",\"unknown\":\"keep\"}")
        let store = try open()
        store.faults.beforeReadback = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        let after = try Data(contentsOf: manifest)
        let afterInode = try inode(manifest)
        store.close(); current = nil
        let beforeReopen = try bytes()
        let reopened = try open()
        XCTAssertEqual(try reopened.get(backend), "webdav")
        XCTAssertEqual(try inode(manifest), afterInode)
        XCTAssertEqual(try Data(contentsOf: manifest), after)
        XCTAssertEqual(try bytes(), beforeReopen)
        XCTAssertThrowsError(try store.get(backend))
    }

    func testInterveningWriterAfterFailedBeforePromotionIsNeverOverwritten() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        store.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        try seed("{\"@mindwtr_sync_backend\":\"cloud\",\"unknown\":\"foreign\"}")
        let foreign = try Data(contentsOf: manifest)
        store.faults.beforePromotion = nil
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertEqual(try Data(contentsOf: manifest), foreign)
    }

    func testCanonicalAncestorReplacementBeforePublicationCannotRedirectWrite() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        let original = try Data(contentsOf: manifest)
        let retained = namespace.deletingLastPathComponent().appendingPathComponent("retained-namespace")
        var fired = false
        store.faults.beforePromotion = {
            fired = true
            try FileManager.default.moveItem(at: self.namespace, to: retained)
            try self.seed("{\"unknown\":\"replacement\"}")
        }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertTrue(fired)
        XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent("manifest.json")), original)
        XCTAssertEqual(try Data(contentsOf: manifest), Data("{\"unknown\":\"replacement\"}".utf8))
        XCTAssertThrowsError(try store.get(backend))
    }

    func testExplicitContainerReplacementBeforePublicationIsRefused() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        let original = try Data(contentsOf: manifest)
        let retained = container.appendingPathExtension("retained")
        additionalRoots.append(retained)
        let originalInode = try inode(container)
        var fired = false
        store.faults.beforePromotion = {
            fired = true
            try FileManager.default.moveItem(at: self.container, to: retained)
            try self.seed("{\"unknown\":\"foreign root\"}")
        }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertTrue(fired)
        XCTAssertNotEqual(try inode(container), originalInode)
        let old = retained.appendingPathComponent("Library/Application Support/\(bundle)/RCTAsyncLocalStorage_V1/manifest.json")
        XCTAssertEqual(try Data(contentsOf: old), original)
        XCTAssertEqual(try Data(contentsOf: manifest), Data("{\"unknown\":\"foreign root\"}".utf8))
    }

    func testSparseOversizeManifestIsRefusedBeforeMaterialization() throws {
        try seed("{}")
        let file = try FileHandle(forWritingTo: manifest)
        try file.truncate(atOffset: 64 * 1024 * 1024 + 1)
        try file.close()
        let before = try inode(manifest)
        XCTAssertThrowsError(try open())
        XCTAssertEqual(try inode(manifest), before)
        let size = try FileManager.default.attributesOfItem(atPath: manifest.path)[.size] as? NSNumber
        XCTAssertEqual(size?.int64Value, 64 * 1024 * 1024 + 1)
    }

    func testAnchoredDurablePublicationCannotFollowReplacedDirectoryName() throws {
        try seed("{\"old\":\"before\"}")
        let directory = Darwin.open(namespace.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(directory, 0)
        guard directory >= 0 else { return }
        defer { Darwin.close(directory) }
        let retained = namespace.deletingLastPathComponent().appendingPathComponent("original-directory")
        try FileManager.default.moveItem(at: namespace, to: retained)
        try seed("{\"foreign\":\"keep\"}")
        var ownedFile: Int32 = -1
        defer { if ownedFile >= 0 { Darwin.close(ownedFile) } }
        let intended = Data("{\"owned\":\"after\"}".utf8)
        try DurableFile.write(intended, to: "manifest.json", in: directory, retainingFile: &ownedFile)
        XCTAssertGreaterThanOrEqual(ownedFile, 0)
        XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent("manifest.json")), intended)
        XCTAssertEqual(try Data(contentsOf: manifest), Data("{\"foreign\":\"keep\"}".utf8))
    }

    func testFutureInputCeilingIncludesWhitespaceOnlyOldManifestBeforePromotion() throws {
        let old = container.appendingPathComponent("Documents/RCTAsyncLocalStorage_V1")
        try seed(String(repeating: " ", count: 900) + "{}", at: old)
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        let before = try bytes()
        var promotions = 0
        store.faults.beforePromotion = { promotions += 1 }
        store.faults.snapshotByteLimit = 1024
        XCTAssertThrowsError(try store.set(path, String(repeating: "x", count: 256)))
        XCTAssertEqual(promotions, 0)
        XCTAssertEqual(try bytes(), before)
        XCTAssertEqual(try store.get(backend), "off")
        store.faults.snapshotByteLimit = nil
        try store.set(path, String(repeating: "x", count: 256))
        XCTAssertEqual(promotions, 1)
        XCTAssertEqual(try store.get(path), String(repeating: "x", count: 256))
        XCTAssertEqual(try Data(contentsOf: old.appendingPathComponent("manifest.json")), Data((String(repeating: " ", count: 900) + "{}").utf8))
        let originalManifest = try Data(contentsOf: manifest)
        let originalInode = try inode(manifest)
        var grewOldCopy = false
        store.faults.beforePromotion = {
            grewOldCopy = true
            try self.seed(String(repeating: " ", count: 1000) + "{}", at: old)
        }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertTrue(grewOldCopy)
        XCTAssertEqual(try inode(manifest), originalInode)
        XCTAssertEqual(try Data(contentsOf: manifest), originalManifest)
        XCTAssertEqual(try Data(contentsOf: old.appendingPathComponent("manifest.json")), Data((String(repeating: " ", count: 1000) + "{}").utf8))
        XCTAssertThrowsError(try store.get(backend))
    }

    #if os(iOS)
    func testAllowedWritePreservesStrongerExistingManifestDataProtection() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\",\"unknown\":\"retained opaque credential\"}")
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: namespace.path)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: manifest.path)
        let before = try FileManager.default.attributesOfItem(atPath: manifest.path)[.protectionKey] as? String
        XCTAssertEqual(before, FileProtectionType.complete.rawValue)
        let store = try open()
        try store.set(backend, "webdav")
        let after = try FileManager.default.attributesOfItem(atPath: manifest.path)[.protectionKey] as? String
        XCTAssertEqual(after, FileProtectionType.complete.rawValue)
        XCTAssertEqual(try store.get("unknown"), "retained opaque credential")
        XCTAssertEqual(try store.get(backend), "webdav")
    }
    #endif
}
