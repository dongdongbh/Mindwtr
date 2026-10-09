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
    private let calendarSetting = "mindwtr-system-calendar-settings"
    private let calendarMarker = "mindwtr:native:calendar-setting:v1"
    private let calendarPushNames = [
        "mindwtr:calendar-push-sync:enabled", "mindwtr:calendar-push-sync:calendar-id",
        "mindwtr:calendar-push-sync:target-calendar-id", "mindwtr:calendar-push-sync:color",
        "mindwtr:calendar-push-sync:creation-intent", "mindwtr:native:calendar-push-effect:v1",
    ]
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
    private func seedCalendarPush(_ values: [String?]) throws {
        XCTAssertEqual(values.count, calendarPushNames.count)
        let object = NSMutableDictionary(dictionary: ["unknown": "keep", "mindwtr:calendar-push-sync:pending-calendar": "android-marker"])
        for (name, value) in zip(calendarPushNames, values) {
            if let value { object.setObject(value, forKey: name as NSString) }
        }
        try seed(String(decoding: JSONSerialization.data(withJSONObject: object), as: UTF8.self))
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

    func testCalendarStateReadsMissingEmptyAndRawLegacyCellsWithoutWriting() throws {
        let missing = try open()
        XCTAssertEqual(try missing.readCalendarSettingState(), [nil, nil])
        XCTAssertFalse(missing.hasPendingCalendarSettingMutation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path))
        missing.close(); current = nil
        try seed("{\"mindwtr-system-calendar-settings\":\"\\uFEFF  { \\\"enabled\\\": true } 🧠\\n\",\"mindwtr:native:calendar-setting:v1\":\"\",\"unknown\":\"preserved\"}")
        let store = try open(), before = try bytes()
        let values = try store.readCalendarSettingState()
        XCTAssertEqual(values.map { $0.map { Data($0.utf8) } }, [Data("\u{FEFF}  { \"enabled\": true } 🧠\n".utf8), Data()])
        XCTAssertEqual(try bytes(), before)
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [values[0], nil], next: ["after", "proof"]))
        XCTAssertEqual(try bytes(), before)
        store.close(); current = nil
        try seed("{\"mindwtr-system-calendar-settings\":null,\"mindwtr:native:calendar-setting:v1\":null}")
        // RN's exact MD5 filenames for the two fixed cells.
        let files = ["c1b1171d3d70d708dabbaa00e835028d", "2730d01cc73c83d46a0f156b83ff7f95"].map { namespace.appendingPathComponent($0) }
        let raw = [Data([0xEF, 0xBB, 0xBF]) + Data("raw external choice 🧠".utf8), Data("\u{FEFF}\u{FEFF}raw external proof".utf8)]
        for (url, data) in zip(files, raw) { try data.write(to: url) }
        let external = try open(), externalBefore = try bytes()
        let decoded = try files.map { url -> Data? in
            var encoding: UInt = 0
            return Data((try NSString(contentsOfFile: url.path, usedEncoding: &encoding) as String).utf8)
        }
        XCTAssertEqual(try external.readCalendarSettingState().map { $0.map { Data($0.utf8) } }, decoded)
        XCTAssertEqual(try bytes(), externalBefore)
    }

    func testCalendarCASCommitsBothCellsTogetherAndPreservesUnknownAndExternalRecords() throws {
        try seed("{\"@mindwtr_sync_path\":null,\"é\":\"composed\",\"e\\u0301\":\"decomposed\",\"unknown\":\"\\uFEFFkeep 🧠\"}")
        let external = namespace.appendingPathComponent("3841382bf18a349689a3256aa5be82e1")
        let raw = Data("external path bytes 🧠".utf8); try raw.write(to: external)
        let externalBefore = try externalBytes(), externalInode = try inode(external)
        let store = try open(), before = try store.readCalendarSettingState()
        let next = ["\u{FEFF}{\"enabled\":true,\"selectedCalendarIds\":[\"é\",\"e\\u0301\"]}\n", "\u{FEFF}exact mutation proof e\u{301}"]
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        try store.compareAndSetCalendarSetting(expected: before, next: next)
        XCTAssertEqual(promotions, 1); XCTAssertFalse(store.hasPendingCalendarSettingMutation)
        XCTAssertEqual(try store.readCalendarSettingState().map { $0.map { Data($0.utf8) } }, next.map { Data($0.utf8) })
        let written = try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? NSDictionary)
        XCTAssertEqual(written[calendarSetting] as? String, next[0]); XCTAssertEqual(written[calendarMarker] as? String, next[1])
        XCTAssertEqual(written["é"] as? String, "composed"); XCTAssertEqual(written["e\u{301}"] as? String, "decomposed")
        XCTAssertEqual(try store.get("unknown"), "\u{FEFF}keep 🧠")
        XCTAssertEqual(try externalBytes(), externalBefore); XCTAssertEqual(try inode(external), externalInode)
        store.close(); current = nil
        let cold = try open()
        XCTAssertEqual(try cold.readCalendarSettingState().map { $0.map { Data($0.utf8) } }, next.map { Data($0.utf8) })
        XCTAssertEqual(try cold.get(path), "external path bytes 🧠"); XCTAssertEqual(try Data(contentsOf: external), raw)
    }

    func testCalendarCASRejectsStaleSettingOrMarkerIncludingABAWithoutPublication() throws {
        try seed("{\"mindwtr-system-calendar-settings\":\"old choice\",\"mindwtr:native:calendar-setting:v1\":\"first proof\"}")
        let store = try open(), initial = try store.readCalendarSettingState()
        try store.set(calendarSetting, "newer ordinary pruning")
        let pruned = try bytes()
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: initial, next: ["requested choice", "request proof"]))
        XCTAssertEqual(try bytes(), pruned)
        try store.compareAndSetCalendarSetting(expected: try store.readCalendarSettingState(), next: ["old choice", "newer proof"])
        let aba = try bytes()
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: initial, next: ["requested choice", "request proof"]))
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try bytes(), aba)
        XCTAssertEqual(try store.readCalendarSettingState(), ["old choice", "newer proof"])
    }

    func testCalendarCASUsesExactUnicodeBytesInBothWitnesses() throws {
        try seed("{\"mindwtr-system-calendar-settings\":\"café\",\"mindwtr:native:calendar-setting:v1\":\"proof café\"}")
        let store = try open(), before = try bytes()
        let expected = try store.readCalendarSettingState()
        XCTAssertEqual(expected[0], "cafe\u{301}"); XCTAssertEqual(expected[1], "proof cafe\u{301}")
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: ["cafe\u{301}", expected[1]], next: ["after", "proof-after"]))
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [expected[0], "proof cafe\u{301}"], next: ["after", "proof-after"]))
        XCTAssertEqual(try bytes(), before)
        let next = ["\u{FEFF}cafe\u{301}", "\u{FEFF}proof cafe\u{301}"]
        try store.compareAndSetCalendarSetting(expected: expected, next: next)
        let committed = try store.readCalendarSettingState().map { $0.map { Data($0.utf8) } }
        XCTAssertEqual(committed, next.map { Data($0.utf8) })
    }

    func testCalendarPrivateMarkerCannotBeWrittenOrRemovedThroughGenericKV() throws {
        try seed("{\"mindwtr-system-calendar-settings\":\"choice\",\"mindwtr:native:calendar-setting:v1\":\"proof\",\"unknown\":\"keep\"}")
        let store = try open(), before = try bytes()
        XCTAssertThrowsError(try store.set(calendarMarker, "forged"))
        XCTAssertThrowsError(try store.remove(calendarMarker))
        XCTAssertThrowsError(try store.multiSet([(calendarSetting, "new choice"), (calendarMarker, "forged")]))
        XCTAssertThrowsError(try store.multiRemove([calendarSetting, calendarMarker]))
        XCTAssertEqual(try bytes(), before)
        try store.set(calendarSetting, "ordinary prune")
        XCTAssertEqual(try store.readCalendarSettingState(), ["ordinary prune", "proof"])
        try store.remove(calendarSetting)
        XCTAssertEqual(try store.readCalendarSettingState(), [nil, "proof"])
    }

    func testCalendarCASCountsAndUTF8CellCapsRefuseBeforeIOAndExactCapsAreAccepted() throws {
        try seed("{}")
        let store = try open(), before = try bytes()
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        for count in [0, 1, 3] {
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: Array(repeating: nil, count: count), next: ["choice", "proof"]))
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [nil, nil], next: Array(repeating: "", count: count)))
        }
        let over = String(repeating: "🧠", count: 256 * 1024 + 1)
        for slot in 0..<2 {
            var expected: [String?] = [nil, nil]; expected[slot] = over
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: expected, next: ["choice", "proof"]))
            var next = ["choice", "proof"]; next[slot] = over
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [nil, nil], next: next))
        }
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try bytes(), before)
        let boundary = String(repeating: "🧠", count: 256 * 1024)
        try store.compareAndSetCalendarSetting(expected: [nil, nil], next: [boundary, boundary])
        XCTAssertEqual(try store.readCalendarSettingState().map { $0?.utf8.count }, [1024 * 1024, 1024 * 1024])
        let unchanged = try bytes(), unchangedInode = try inode(manifest)
        try store.compareAndSetCalendarSetting(expected: [boundary, boundary], next: [boundary, boundary])
        XCTAssertEqual(promotions, 1); XCTAssertEqual(try bytes(), unchanged); XCTAssertEqual(try inode(manifest), unchangedInode)
    }

    func testCalendarCASRetainsExactBaselineAcrossLostPromotionOrReadbackAcknowledgment() throws {
        for promotionCut in [true, false] {
            try seed("{\"mindwtr-system-calendar-settings\":\"before\",\"unknown\":\"keep\"}")
            let store = try open(), before = try store.readCalendarSettingState(), next = ["after", "proof"]
            var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
            if promotionCut { store.faults.afterPromotion = { throw Injected.failure } }
            else { store.faults.beforeReadback = { throw Injected.failure } }
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: before, next: next))
            XCTAssertTrue(store.hasPendingCalendarSettingMutation); XCTAssertFalse(store.hasPendingReminderMutation)
            let promoted = try bytes(), promotedInode = try inode(manifest)
            XCTAssertThrowsError(try store.readCalendarSettingState()); XCTAssertThrowsError(try store.get("unknown"))
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: before, next: ["different", "proof"]))
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: before, next: ["after", "different proof"]))
            XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [next[0], next[1]], next: next))
            XCTAssertThrowsError(try store.set(calendarSetting, "after"))
            XCTAssertTrue(store.hasPendingCalendarSettingMutation); XCTAssertEqual(try bytes(), promoted)
            store.faults.afterPromotion = nil; store.faults.beforeReadback = nil
            try store.compareAndSetCalendarSetting(expected: before, next: next)
            XCTAssertFalse(store.hasPendingCalendarSettingMutation); XCTAssertEqual(promotions, 1)
            XCTAssertEqual(try bytes(), promoted); XCTAssertEqual(try inode(manifest), promotedInode)
            XCTAssertEqual(try store.readCalendarSettingState(), ["after", "proof"])
            store.close(); current = nil
            let cold = try open()
            XCTAssertEqual(try cold.readCalendarSettingState(), ["after", "proof"]); XCTAssertEqual(try cold.get("unknown"), "keep")
            cold.close(); current = nil
        }
    }

    func testCalendarCASCannotReplaceDifferentPendingMutationAndForeignAfterManifest() throws {
        try seed("{\"@mindwtr_sync_backend\":\"off\"}")
        let store = try open()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav"))
        XCTAssertFalse(store.hasPendingCalendarSettingMutation)
        let held = try bytes()
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: [nil, nil], next: ["choice", "proof"]))
        XCTAssertEqual(try bytes(), held)
        store.faults.afterPromotion = nil; try store.set(backend, "webdav")
        let before = try store.readCalendarSettingState()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: before, next: ["choice", "proof"]))
        try sameByteReplacement(manifest); let foreign = try bytes()
        store.faults.afterPromotion = nil
        XCTAssertThrowsError(try store.compareAndSetCalendarSetting(expected: before, next: ["choice", "proof"]))
        XCTAssertEqual(try bytes(), foreign); XCTAssertThrowsError(try store.readCalendarSettingState())
    }

    func testCalendarPushStateReadsSixRawRNCellsIncludingMissingEmptyAndExternalValues() throws {
        let absent = try open(), absentBytes = try bytes()
        XCTAssertEqual(try absent.readCalendarPushState(), Array(repeating: nil, count: 6))
        XCTAssertFalse(absent.hasPendingCalendarPushMutation)
        XCTAssertEqual(try bytes(), absentBytes); XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path))
        absent.close(); current = nil
        let values: [String?] = ["1", "calendar-é", nil, "", "\u{FEFF} { invalid legacy intent } 🧠\n", "not a typed effect"]
        try seedCalendarPush(values)
        let inline = try open(), before = try bytes()
        XCTAssertEqual(try inline.readCalendarPushState().map { $0.map { Data($0.utf8) } }, values.map { $0.map { Data($0.utf8) } })
        XCTAssertEqual(try bytes(), before)
        inline.close(); current = nil
        // RN's exact MD5 filename for mindwtr:calendar-push-sync:calendar-id.
        let externalName = "f93dfa2b75f064196d2cc4b087818736"
        let object = try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest), options: [.mutableContainers]) as? NSMutableDictionary)
        object.setObject(NSNull(), forKey: calendarPushNames[1] as NSString)
        try JSONSerialization.data(withJSONObject: object).write(to: manifest)
        let external = namespace.appendingPathComponent(externalName)
        let raw = Data([0xEF, 0xBB, 0xBF]) + Data("external calendar e\u{301}".utf8)
        try raw.write(to: external)
        var encoding: UInt = 0
        let decoded = try NSString(contentsOfFile: external.path, usedEncoding: &encoding) as String
        let store = try open(), externalBefore = try bytes()
        var expected = values; expected[1] = decoded
        XCTAssertEqual(try store.readCalendarPushState().map { $0.map { Data($0.utf8) } }, expected.map { $0.map { Data($0.utf8) } })
        XCTAssertEqual(try bytes(), externalBefore); XCTAssertEqual(try Data(contentsOf: external), raw)
    }

    func testCalendarPushCASAtomicallyChangesAndClearsOnlyItsSixCells() throws {
        try seed("{\"mindwtr:calendar-push-sync:enabled\":\"1\",\"mindwtr:calendar-push-sync:calendar-id\":\"old\",\"mindwtr:calendar-push-sync:target-calendar-id\":\"chosen\",\"mindwtr:calendar-push-sync:color\":\"old-color\",\"mindwtr:calendar-push-sync:creation-intent\":\"raw-intent\",\"mindwtr:native:calendar-push-effect:v1\":\"raw-effect\",\"mindwtr:calendar-push-sync:pending-calendar\":\"android-marker\",\"@mindwtr_sync_path\":null,\"é\":\"composed\",\"e\\u0301\":\"decomposed\",\"unknown\":\"\\uFEFF keep 🧠\"}")
        let external = namespace.appendingPathComponent("3841382bf18a349689a3256aa5be82e1")
        try Data("unchanged external path".utf8).write(to: external)
        let externalBefore = try externalBytes(), externalInode = try inode(external)
        let store = try open(), before = try store.readCalendarPushState()
        let next: [String?] = [nil, "new e\u{301}", nil, "", "malformed allowed raw intent", nil]
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        try store.compareAndSetCalendarPushState(expected: before, next: next)
        XCTAssertEqual(promotions, 1); XCTAssertFalse(store.hasPendingCalendarPushMutation)
        XCTAssertEqual(try store.readCalendarPushState().map { $0.map { Data($0.utf8) } }, next.map { $0.map { Data($0.utf8) } })
        let written = try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? NSDictionary)
        for (name, value) in zip(calendarPushNames, next) {
            XCTAssertEqual((written[name] as? String).map { Data($0.utf8) }, value.map { Data($0.utf8) })
            if value == nil { XCTAssertNil(written[name], "Removal must remove only the exact named cell") }
        }
        XCTAssertEqual(written["é"] as? String, "composed"); XCTAssertEqual(written["e\u{301}"] as? String, "decomposed")
        XCTAssertEqual(try store.get("unknown"), "\u{FEFF} keep 🧠")
        XCTAssertEqual(try store.get("mindwtr:calendar-push-sync:pending-calendar"), "android-marker")
        XCTAssertEqual(try externalBytes(), externalBefore); XCTAssertEqual(try inode(external), externalInode)
        store.close(); current = nil
        let cold = try open()
        XCTAssertEqual(try cold.readCalendarPushState().map { $0.map { Data($0.utf8) } }, next.map { $0.map { Data($0.utf8) } })
        XCTAssertEqual(try cold.get(path), "unchanged external path")
    }

    func testCalendarPushCASDistinguishesNilEmptyAndExactUnicodeBytesInEveryCell() throws {
        let initial: [String?] = [nil, "", "café", "proof café", "café", "café"]
        try seedCalendarPush(initial)
        let store = try open(), before = try bytes()
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        for index in calendarPushNames.indices {
            var expected = initial
            expected[index] = index == 0 ? "" : index == 1 ? nil : initial[index]!.replacingOccurrences(of: "é", with: "e\u{301}")
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: expected, next: Array(repeating: "after", count: 6)))
        }
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try bytes(), before)
        let next: [String?] = ["", nil, "cafe\u{301}", "proof cafe\u{301}", "cafe\u{301}", "cafe\u{301}"]
        try store.compareAndSetCalendarPushState(expected: initial, next: next)
        XCTAssertEqual(promotions, 1)
        XCTAssertEqual(try store.readCalendarPushState().map { $0.map { Data($0.utf8) } }, next.map { $0.map { Data($0.utf8) } })
        XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: initial))
    }

    func testCalendarPushAllSixCellsRemainOutsideGenericWriteAndRemoveAuthority() throws {
        try seedCalendarPush(["1", "owned", "chosen", "", "legacy", "effect"])
        let store = try open(), before = try bytes()
        for name in calendarPushNames {
            XCTAssertThrowsError(try store.set(name, "replacement"))
            XCTAssertThrowsError(try store.remove(name))
            XCTAssertThrowsError(try store.multiSet([(backend, "webdav"), (name, "replacement")]))
            XCTAssertThrowsError(try store.multiRemove([backend, name]))
        }
        XCTAssertEqual(try bytes(), before); XCTAssertFalse(store.hasPendingCalendarPushMutation)
        XCTAssertEqual(try store.get("mindwtr:calendar-push-sync:pending-calendar"), "android-marker")
    }

    func testCalendarPushCASCountAndUTF8BoundsRefuseBeforePublicationAndAcceptAllExactCaps() throws {
        let store = try open(), empty: [String?] = Array(repeating: nil, count: 6), before = try bytes()
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        for count in [0, 1, 5, 7] {
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: Array(repeating: nil, count: count), next: empty))
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: empty, next: Array(repeating: nil, count: count)))
        }
        let boundary = String(repeating: "é", count: 512 * 1024), overflow = boundary + "a"
        XCTAssertEqual(boundary.utf8.count, 1024 * 1024)
        for index in calendarPushNames.indices {
            var oversized = empty; oversized[index] = overflow
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: oversized, next: empty))
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: empty, next: oversized))
        }
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try bytes(), before); XCTAssertFalse(store.hasPendingCalendarPushMutation)
        let maximum: [String?] = Array(repeating: boundary, count: 6)
        try store.compareAndSetCalendarPushState(expected: empty, next: maximum)
        XCTAssertEqual(try store.readCalendarPushState().map { $0?.utf8.count }, Array(repeating: 1024 * 1024, count: 6))
        let retained = try bytes(), retainedInode = try inode(manifest)
        try store.compareAndSetCalendarPushState(expected: maximum, next: maximum)
        XCTAssertEqual(promotions, 1); XCTAssertEqual(try bytes(), retained); XCTAssertEqual(try inode(manifest), retainedInode)
    }

    func testCalendarPushReadRefusesOversizedStoredCellWithoutRepair() throws {
        let overflow = String(repeating: "a", count: 1024 * 1024 + 1)
        for index in calendarPushNames.indices {
            var values: [String?] = Array(repeating: nil, count: 6); values[index] = overflow
            try seedCalendarPush(values)
            let store = try open(), before = try bytes()
            XCTAssertThrowsError(try store.readCalendarPushState())
            XCTAssertEqual(try bytes(), before); XCTAssertFalse(store.hasPendingCalendarPushMutation)
            XCTAssertEqual(try store.get(calendarPushNames[index])?.utf8.count, overflow.utf8.count)
            store.close(); current = nil
        }
    }

    func testCalendarPushUnchangedRawStateDoesNotPublishOrCreateManifest() throws {
        let store = try open(), empty: [String?] = Array(repeating: nil, count: 6), before = try bytes()
        store.faults.beforePromotion = { throw Injected.failure }
        try store.compareAndSetCalendarPushState(expected: empty, next: empty)
        XCTAssertEqual(try bytes(), before); XCTAssertFalse(store.hasPendingCalendarPushMutation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path))
        store.close(); current = nil
        let values: [String?] = ["1", "raw-é", "", nil, "  not JSON 🧠\n", "\u{FEFF}raw effect"]
        try seedCalendarPush(values)
        let populated = try open(), populatedBefore = try bytes(), originalInode = try inode(manifest)
        populated.faults.beforePromotion = { throw Injected.failure }
        try populated.compareAndSetCalendarPushState(expected: values, next: values)
        XCTAssertEqual(try bytes(), populatedBefore); XCTAssertEqual(try inode(manifest), originalInode)
        XCTAssertFalse(populated.hasPendingCalendarPushMutation)
    }

    func testCalendarPushLostPublicationRetainsOnlyExactChangeAndBaselineForRetryAndColdRead() throws {
        for cut in ["before", "after", "readback"] {
            let initial: [String?] = ["0", "old-é", nil, "", "raw-intent", nil]
            let next: [String?] = ["1", "new-e\u{301}", "chosen", nil, nil, "raw-effect"]
            try seedCalendarPush(initial)
            let store = try open(), original = try bytes()
            var promotions = 0
            store.faults.beforePromotion = { promotions += 1; if cut == "before" { throw Injected.failure } }
            if cut == "after" { store.faults.afterPromotion = { throw Injected.failure } }
            if cut == "readback" { store.faults.beforeReadback = { throw Injected.failure } }
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
            XCTAssertTrue(store.hasPendingCalendarPushMutation)
            XCTAssertFalse(store.hasPendingCalendarSettingMutation); XCTAssertFalse(store.hasPendingReminderMutation)
            let uncertain = try bytes()
            let uncertainInode: UInt64?
            if cut == "before" { uncertainInode = nil } else { uncertainInode = try inode(manifest) }
            if cut == "before" { XCTAssertEqual(uncertain, original) }
            XCTAssertThrowsError(try store.readCalendarPushState()); XCTAssertThrowsError(try store.get("unknown"))
            for index in calendarPushNames.indices {
                var different = next; different[index] = (different[index] ?? "") + "different"
                XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: different))
                var wrongBaseline = initial; wrongBaseline[index] = (wrongBaseline[index] ?? "") + "different"
                XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: wrongBaseline, next: next))
            }
            XCTAssertThrowsError(try store.set(backend, "webdav"))
            XCTAssertEqual(try bytes(), uncertain); XCTAssertTrue(store.hasPendingCalendarPushMutation)
            store.faults.beforePromotion = { promotions += 1 }; store.faults.afterPromotion = nil; store.faults.beforeReadback = nil
            try store.compareAndSetCalendarPushState(expected: initial, next: next)
            XCTAssertFalse(store.hasPendingCalendarPushMutation); XCTAssertEqual(promotions, cut == "before" ? 2 : 1)
            if let uncertainInode { XCTAssertEqual(try inode(manifest), uncertainInode); XCTAssertEqual(try bytes(), uncertain) }
            XCTAssertEqual(try store.readCalendarPushState().map { $0.map { Data($0.utf8) } }, next.map { $0.map { Data($0.utf8) } })
            store.close(); current = nil
            let cold = try open()
            XCTAssertEqual(try cold.readCalendarPushState().map { $0.map { Data($0.utf8) } }, next.map { $0.map { Data($0.utf8) } })
            XCTAssertEqual(try cold.get("unknown"), "keep")
            XCTAssertEqual(try cold.get("mindwtr:calendar-push-sync:pending-calendar"), "android-marker")
            cold.close(); current = nil
        }
    }

    func testCalendarPushCASRefusesOtherPendingMutationAndSameByteForeignManifest() throws {
        try seedCalendarPush(Array(repeating: nil, count: 6))
        let store = try open(), initial = try store.readCalendarPushState(), next: [String?] = ["1", "owned", nil, "", nil, "effect"]
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "webdav")); XCTAssertFalse(store.hasPendingCalendarPushMutation)
        let otherPending = try bytes()
        XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
        XCTAssertEqual(try bytes(), otherPending)
        store.faults.afterPromotion = nil; try store.set(backend, "webdav")
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
        XCTAssertTrue(store.hasPendingCalendarPushMutation)
        try sameByteReplacement(manifest); let foreign = try bytes()
        store.faults.afterPromotion = nil
        XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
        XCTAssertEqual(try bytes(), foreign); XCTAssertThrowsError(try store.readCalendarPushState())
    }

    func testCalendarPushCASRefusesExternalManifestEditOrNamespaceReplacementBeforePublication() throws {
        for replaceNamespace in [false, true] {
            try seedCalendarPush(["0", nil, nil, nil, nil, nil])
            let store = try open(), initial = try store.readCalendarPushState()
            let originalManifest = try Data(contentsOf: manifest)
            var displaced: URL?
            let foreign = Data("{\"mindwtr:calendar-push-sync:enabled\":\"foreign\",\"unknown\":\"external edit\"}".utf8)
            store.faults.beforePromotion = {
                if replaceNamespace {
                    let old = self.namespace.deletingLastPathComponent().appendingPathComponent("displaced-" + UUID().uuidString)
                    try FileManager.default.moveItem(at: self.namespace, to: old); displaced = old
                    try FileManager.default.createDirectory(at: self.namespace, withIntermediateDirectories: false)
                }
                try foreign.write(to: self.manifest)
            }
            let next: [String?] = ["1", "owned", nil, nil, nil, "effect"]
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
            XCTAssertEqual(try Data(contentsOf: manifest), foreign)
            if let displaced { XCTAssertEqual(try Data(contentsOf: displaced.appendingPathComponent("manifest.json")), originalManifest) }
            let refused = try bytes()
            XCTAssertThrowsError(try store.compareAndSetCalendarPushState(expected: initial, next: next))
            XCTAssertThrowsError(try store.readCalendarPushState()); XCTAssertEqual(try bytes(), refused)
            store.close(); current = nil
        }
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
