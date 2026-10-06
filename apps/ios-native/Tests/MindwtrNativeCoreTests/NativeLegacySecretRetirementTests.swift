import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

final class NativeLegacySecretRetirementTests: XCTestCase {
    private var roots: [URL] = []
    private var stores: [NativeDeviceKV] = []
    private let secrets = ["@mindwtr_webdav_password", "@mindwtr_cloud_token", "@mindwtr_sync_encryption_key_v1"]
    private let setting = "@mindwtr_sync_backend"
    private let other = "synthetic-unrelated-external"
    private struct Fixture {
        let container: URL
        let namespace: String
        let storage: URL
        var manifest: URL { storage.appendingPathComponent("manifest.json") }
        func file(_ key: String) -> URL {
            storage.appendingPathComponent(Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined())
        }
    }
    override func tearDownWithError() throws {
        for store in stores { store.close() }
        stores.removeAll()
        for root in roots { try FileManager.default.removeItem(at: root) }
        roots.removeAll()
    }
    private func fixture(_ entries: [(String, Any)]) throws -> Fixture {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("NativeLegacySecretRetirementTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(root.path, nil) else { throw HostFailure("Synthetic fixture root unavailable") }
        defer { free(physical) }
        let container = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        roots.append(container)
        let namespace = "mindwtr.secret-retirement.fixture." + UUID().uuidString.lowercased()
        let value = Fixture(container: container, namespace: namespace,
                            storage: container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1"))
        try FileManager.default.createDirectory(at: value.storage, withIntermediateDirectories: true)
        let manifest = NSMutableDictionary()
        for (key, item) in entries { manifest.setObject(item, forKey: key as NSString) }
        try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(to: value.manifest)
        return value
    }
    private func open(_ fixture: Fixture) throws -> NativeDeviceKV {
        let value = try NativeDeviceKV(containerURL: fixture.container, bundleIdentifier: fixture.namespace)
        stores.append(value); return value
    }
    private func inode(_ url: URL) throws -> ino_t {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Synthetic fixture inode unavailable") }
        return value.st_ino
    }
    private func absent(_ url: URL, file: StaticString = #filePath, line: UInt = #line) {
        var value = stat(); XCTAssertEqual(lstat(url.path, &value), -1, file: file, line: line)
        XCTAssertEqual(errno, ENOENT, file: file, line: line)
    }
    private func manifest(_ fixture: Fixture) throws -> NSDictionary {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: fixture.manifest)) as? NSDictionary)
    }

    func testEverySelectedSecretRetiresInlineExternalAndOrphanShapesOnly() throws {
        for key in secrets {
            for shape in ["inline", "external", "inline-stale", "absent-stale", "absent"] {
                var entries: [(String, Any)] = [(setting, "local"), (other, NSNull()), ("unknown", "opaque 🧠")]
                if shape == "external" { entries.append((key, NSNull())) }
                else if shape.hasPrefix("inline") { entries.append((key, "synthetic plaintext")) }
                let fixture = try fixture(entries)
                let retained = Data("unrelated external bytes".utf8)
                try retained.write(to: fixture.file(other))
                let unknown = fixture.storage.appendingPathComponent("unknown-file")
                try Data([0, 1, 2, 3]).write(to: unknown)
                if shape == "external" || shape.hasSuffix("stale") { try Data("synthetic backing bytes".utf8).write(to: fixture.file(key)) }
                let retainedInode = try inode(fixture.file(other)), unknownInode = try inode(unknown)
                let store = try open(fixture), beforeManifest = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
                try store.remove(key)
                XCTAssertNil(try store.get(key), shape)
                absent(fixture.file(key))
                XCTAssertNil(try manifest(fixture).object(forKey: key))
                XCTAssertEqual(try store.get(setting), "local")
                XCTAssertEqual(try store.get(other), String(decoding: retained, as: UTF8.self))
                XCTAssertEqual(try Data(contentsOf: fixture.file(other)), retained)
                XCTAssertEqual(try inode(fixture.file(other)), retainedInode)
                XCTAssertEqual(try Data(contentsOf: unknown), Data([0, 1, 2, 3]))
                XCTAssertEqual(try inode(unknown), unknownInode)
                if shape == "absent" {
                    XCTAssertEqual(try Data(contentsOf: fixture.manifest), beforeManifest)
                    XCTAssertEqual(try inode(fixture.manifest), beforeInode, "Already absent is a no-op")
                }
                store.close()
            }
        }
    }

    func testAfterManifestFaultRetainsOriginalBackingFileAndExactWarmRetryDoesNotRepublish() throws {
        let key = secrets[0], fixture = try fixture([(key, NSNull()), (setting, "local")])
        let bytes = Data("synthetic backing bytes".utf8); try bytes.write(to: fixture.file(key))
        let original = try inode(fixture.file(key)), store = try open(fixture)
        var promotions = 0, faultFired = false
        store.faults.afterPromotion = { promotions += 1 }
        store.faults.beforeSecretUnlink = { faultFired = true; throw HostFailure("Synthetic lost unlink acknowledgment") }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired)
        XCTAssertEqual(promotions, 1); XCTAssertNil(try manifest(fixture).object(forKey: key))
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes); XCTAssertEqual(try inode(fixture.file(key)), original)
        let published = try Data(contentsOf: fixture.manifest), publishedInode = try inode(fixture.manifest)
        XCTAssertThrowsError(try store.get(setting)); XCTAssertThrowsError(try store.set(setting, "other"))
        store.faults.beforeSecretUnlink = nil
        try store.multiRemove([key])
        XCTAssertEqual(promotions, 1); XCTAssertEqual(try Data(contentsOf: fixture.manifest), published)
        XCTAssertEqual(try inode(fixture.manifest), publishedInode); absent(fixture.file(key)); XCTAssertNil(try store.get(key))
    }

    func testAfterUnlinkLostAcknowledgmentRetainsDeletionBeforeFaultAndWarmRetryResynchronizes() throws {
        let key = secrets[1], fixture = try fixture([(key, NSNull()), (setting, "local")])
        try Data("synthetic backing bytes".utf8).write(to: fixture.file(key))
        let store = try open(fixture); var promotions = 0, faultFired = false
        store.faults.afterPromotion = { promotions += 1 }
        store.faults.afterSecretUnlink = { faultFired = true; throw HostFailure("Synthetic lost directory sync acknowledgment") }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired); absent(fixture.file(key))
        let published = try Data(contentsOf: fixture.manifest), publishedInode = try inode(fixture.manifest)
        XCTAssertThrowsError(try store.get(key)); XCTAssertThrowsError(try store.remove(setting))
        store.faults.afterSecretUnlink = nil
        try store.remove(key)
        XCTAssertEqual(promotions, 1); XCTAssertEqual(try Data(contentsOf: fixture.manifest), published)
        XCTAssertEqual(try inode(fixture.manifest), publishedInode); absent(fixture.file(key)); XCTAssertNil(try store.get(key))
    }

    func testSecretSetsMixedAndDuplicateBatchesRefuseBeforeWrites() throws {
        let fixture = try fixture(secrets.map { ($0, "synthetic plaintext" as Any) } + [(setting, "local"), ("unknown", "preserved")])
        for key in secrets { try Data("synthetic stale bytes".utf8).write(to: fixture.file(key)) }
        let store = try open(fixture), before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
        let fileInodes = try secrets.map { try inode(fixture.file($0)) }
        for key in secrets {
            XCTAssertThrowsError(try store.set(key, "refused"))
            XCTAssertThrowsError(try store.multiSet([(setting, "other"), (key, "refused")]))
            for keys in [[key, setting], [setting, key], [key, key], secrets] {
                XCTAssertThrowsError(try store.multiRemove(keys))
            }
        }
        XCTAssertThrowsError(try store.remove("unknown"))
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), before); XCTAssertEqual(try inode(fixture.manifest), beforeInode)
        XCTAssertEqual(try secrets.map { try inode(fixture.file($0)) }, fileInodes)
        for key in secrets { XCTAssertEqual(try Data(contentsOf: fixture.file(key)), Data("synthetic stale bytes".utf8)) }
        XCTAssertEqual(try store.get(setting), "local")
    }

    func testBeforePublicationFaultPreservesManifestAndBackingGeneration() throws {
        let key = secrets[2], fixture = try fixture([(key, NSNull()), (setting, "local")])
        let bytes = Data("synthetic backing bytes".utf8); try bytes.write(to: fixture.file(key))
        let before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest), targetInode = try inode(fixture.file(key))
        let store = try open(fixture); var faultFired = false, promotions = 0
        store.faults.beforePromotion = { faultFired = true; throw HostFailure("Synthetic before-publication failure") }
        store.faults.afterPromotion = { promotions += 1 }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired); XCTAssertEqual(promotions, 0)
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), before); XCTAssertEqual(try inode(fixture.manifest), beforeInode)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes); XCTAssertEqual(try inode(fixture.file(key)), targetInode)
        store.faults.beforePromotion = nil; try store.remove(key); XCTAssertEqual(promotions, 1); absent(fixture.file(key))
    }

    func testUnsafeOrOversizedUnreferencedBackingPathRefusesWithoutPublication() throws {
        for shape in ["symlink", "hardlink", "oversize"] {
            let key = secrets[0], fixture = try fixture([(key, "synthetic plaintext"), (setting, "local")])
            let target = fixture.file(key), peer = fixture.container.appendingPathComponent("synthetic-peer")
            try Data("preserved peer".utf8).write(to: peer)
            if shape == "symlink" { XCTAssertEqual(symlink(peer.path, target.path), 0) }
            else if shape == "hardlink" { XCTAssertEqual(link(peer.path, target.path), 0) }
            else {
                let fd = Darwin.open(target.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
                XCTAssertGreaterThanOrEqual(fd, 0); guard fd >= 0 else { return }
                defer { Darwin.close(fd) }
                XCTAssertEqual(ftruncate(fd, off_t(256 * 1024 * 1024 + 1)), 0)
            }
            let store = try open(fixture), before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
            let targetInode = try inode(target), peerInode = try inode(peer); var promotions = 0
            store.faults.afterPromotion = { promotions += 1 }
            XCTAssertThrowsError(try store.remove(key), shape); XCTAssertEqual(promotions, 0)
            XCTAssertEqual(try Data(contentsOf: fixture.manifest), before); XCTAssertEqual(try inode(fixture.manifest), beforeInode)
            XCTAssertEqual(try inode(target), targetInode); XCTAssertEqual(try inode(peer), peerInode)
            XCTAssertEqual(try Data(contentsOf: peer), Data("preserved peer".utf8))
            store.close()
        }
    }

    func testSameByteOrphanReplacementBeforePublicationPoisonsAndKeepsForeignFile() throws {
        let key = secrets[0], fixture = try fixture([(key, "synthetic plaintext"), (setting, "local")])
        let bytes = Data("synthetic stale bytes".utf8); try bytes.write(to: fixture.file(key))
        let original = try inode(fixture.file(key)), before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
        let store = try open(fixture); var faultFired = false
        store.faults.beforePromotion = { faultFired = true; try bytes.write(to: fixture.file(key), options: .atomic) }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired)
        let replacement = try inode(fixture.file(key)); XCTAssertNotEqual(replacement, original)
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), before); XCTAssertEqual(try inode(fixture.manifest), beforeInode)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes)
        XCTAssertThrowsError(try store.remove(key)); XCTAssertEqual(try inode(fixture.file(key)), replacement)
    }

    func testReplacedParentBeforePublicationNeverRedirectsManifestOrUnlink() throws {
        let key = secrets[0], fixture = try fixture([(key, "synthetic plaintext"), (setting, "local")])
        let bytes = Data("synthetic stale bytes".utf8); try bytes.write(to: fixture.file(key))
        let before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
        let held = fixture.storage.deletingLastPathComponent().appendingPathComponent("retained-original-store")
        let store = try open(fixture); var faultFired = false
        store.faults.beforePromotion = {
            faultFired = true
            try FileManager.default.moveItem(at: fixture.storage, to: held)
            try FileManager.default.createDirectory(at: fixture.storage, withIntermediateDirectories: false)
            try before.write(to: fixture.manifest); try bytes.write(to: fixture.file(key))
        }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired)
        let replacement = try inode(fixture.manifest)
        XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent("manifest.json")), before)
        XCTAssertEqual(try inode(held.appendingPathComponent("manifest.json")), beforeInode)
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), before)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes)
        XCTAssertThrowsError(try store.remove(key)); XCTAssertEqual(try inode(fixture.manifest), replacement)
    }

    func testAfterManifestReplacementRefusesUnlinkAndKeepsForeignBackingFile() throws {
        let key = secrets[1], fixture = try fixture([(key, NSNull()), (setting, "local")])
        let bytes = Data("synthetic backing bytes".utf8); try bytes.write(to: fixture.file(key))
        let original = try inode(fixture.file(key)), store = try open(fixture); var faultFired = false
        store.faults.beforeSecretUnlink = { faultFired = true; try bytes.write(to: fixture.file(key), options: .atomic) }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired)
        XCTAssertNil(try manifest(fixture).object(forKey: key))
        let replacement = try inode(fixture.file(key)); XCTAssertNotEqual(replacement, original)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes)
        XCTAssertThrowsError(try store.remove(key)); XCTAssertEqual(try inode(fixture.file(key)), replacement)
    }

    func testAfterOwnUnlinkReintroducedNameIsPreservedAndCannotBeAdoptedByWarmRetry() throws {
        let key = secrets[2], fixture = try fixture([(key, NSNull()), (setting, "local")])
        try Data("synthetic backing bytes".utf8).write(to: fixture.file(key))
        let foreign = Data("replacement must remain".utf8), store = try open(fixture); var faultFired = false
        store.faults.afterSecretUnlink = {
            faultFired = true; try foreign.write(to: fixture.file(key))
            throw HostFailure("Synthetic lost unlink acknowledgment with replacement")
        }
        XCTAssertThrowsError(try store.remove(key)); XCTAssertTrue(faultFired)
        let replacement = try inode(fixture.file(key)), published = try Data(contentsOf: fixture.manifest)
        store.faults.afterSecretUnlink = nil
        XCTAssertThrowsError(try store.remove(key)); XCTAssertEqual(try Data(contentsOf: fixture.manifest), published)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), foreign); XCTAssertEqual(try inode(fixture.file(key)), replacement)
    }

    func testColdReopeningReadsAbsentSecretWithoutErasingOrphanThenNewExplicitRemovalRetiresIt() throws {
        let key = secrets[2], fixture = try fixture([(key, NSNull()), (setting, "local")])
        let bytes = Data("synthetic backing bytes".utf8); try bytes.write(to: fixture.file(key))
        let original = try inode(fixture.file(key)), first = try open(fixture); var faultFired = false
        first.faults.beforeSecretUnlink = { faultFired = true; throw HostFailure("Synthetic process exit before unlink") }
        XCTAssertThrowsError(try first.remove(key)); XCTAssertTrue(faultFired)
        let published = try Data(contentsOf: fixture.manifest), publishedInode = try inode(fixture.manifest)
        first.close()
        let cold = try open(fixture)
        XCTAssertNil(try cold.get(key)); XCTAssertEqual(try cold.get(setting), "local")
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), published); XCTAssertEqual(try inode(fixture.manifest), publishedInode)
        XCTAssertEqual(try Data(contentsOf: fixture.file(key)), bytes); XCTAssertEqual(try inode(fixture.file(key)), original)
        try cold.multiRemove([key]); absent(fixture.file(key)); XCTAssertNil(try cold.get(key))
    }
    func testOrphanProspectiveBudgetIncludesLegacyInputAndFutureManifestEncoding() throws {
        for boundary in ["capture", "future-manifest"] {
            let key = secrets[0], fixture = try fixture([(key, "synthetic"), (setting, String(repeating: "/", count: 200))])
            let dictionary = try manifest(fixture)
            try JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys, .withoutEscapingSlashes]).write(to: fixture.manifest)
            let old = fixture.container.appendingPathComponent("Documents/RCTAsyncLocalStorage_V1", isDirectory: true)
            try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
            let oldBytes = Data((String(repeating: " ", count: 900) + "{}").utf8)
            try oldBytes.write(to: old.appendingPathComponent("manifest.json"))
            let orphan = Data(String(repeating: "x", count: 80).utf8); try orphan.write(to: fixture.file(key))
            let input = try LegacyRNStorage(containerURL: fixture.container, bundleIdentifier: fixture.namespace).deviceNamespaceSnapshot().consumedBytes
            let store = try open(fixture), before = try Data(contentsOf: fixture.manifest), beforeInode = try inode(fixture.manifest)
            let targetInode = try inode(fixture.file(key)); var promotions = 0
            store.faults.beforePromotion = { promotions += 1 }
            let limit = input + orphan.count - (boundary == "capture" ? 1 : 0)
            store.faults.snapshotByteLimit = limit
            let after = try XCTUnwrap(dictionary.mutableCopy() as? NSMutableDictionary); after.removeObject(forKey: key)
            let next = try JSONSerialization.data(withJSONObject: after, options: [.sortedKeys])
            XCTAssertGreaterThan(input - before.count + next.count + orphan.count, limit, "Prospective encoding must exceed the bound")
            XCTAssertThrowsError(try store.remove(key), boundary); XCTAssertEqual(promotions, 0)
            XCTAssertEqual(try Data(contentsOf: fixture.manifest), before); XCTAssertEqual(try inode(fixture.manifest), beforeInode)
            XCTAssertEqual(try Data(contentsOf: fixture.file(key)), orphan); XCTAssertEqual(try inode(fixture.file(key)), targetInode)
            XCTAssertEqual(try Data(contentsOf: old.appendingPathComponent("manifest.json")), oldBytes)
            store.faults.snapshotByteLimit = nil; try store.remove(key); absent(fixture.file(key))
            store.close()
        }
    }

    func testReferencedBackingInputIsNotCountedAgainAsAnOrphan() throws {
        let key = secrets[1], fixture = try fixture([(key, NSNull()), (setting, "local")])
        try Data(String(repeating: "x", count: 500).utf8).write(to: fixture.file(key))
        let input = try LegacyRNStorage(containerURL: fixture.container, bundleIdentifier: fixture.namespace).deviceNamespaceSnapshot().consumedBytes
        let store = try open(fixture); store.faults.snapshotByteLimit = input
        try store.remove(key); absent(fixture.file(key)); XCTAssertNil(try store.get(key))
    }

    func testFullyAbsentSecretDoesNotCreateManifestOrPublish() throws {
        let fixture = try fixture([]); try FileManager.default.removeItem(at: fixture.manifest)
        let store = try open(fixture); var promotions = 0
        store.faults.afterPromotion = { promotions += 1 }
        for key in secrets { try store.remove(key); XCTAssertNil(try store.get(key)); absent(fixture.file(key)) }
        absent(fixture.manifest); XCTAssertEqual(promotions, 0)
    }

}

private final class SecretRetirementHostState: @unchecked Sendable {
    private let lock = NSLock()
    private var promotions = 0, receipts = 0, otherIO = 0
    private var failUnlink = false
    func promotion() { lock.lock(); promotions += 1; lock.unlock() }
    func receipt() { lock.lock(); receipts += 1; lock.unlock() }
    func unexpectedIO() { lock.lock(); otherIO += 1; lock.unlock() }
    func setFailure(_ enabled: Bool) { lock.lock(); failUnlink = enabled; lock.unlock() }
    func beforeUnlink() throws {
        lock.lock(); let fail = failUnlink; lock.unlock()
        if fail { throw HostFailure("Synthetic host unlink acknowledgment failure") }
    }
    var counts: (promotions: Int, receipts: Int, otherIO: Int) {
        lock.lock(); defer { lock.unlock() }; return (promotions, receipts, otherIO)
    }
}

final class NativeLegacySecretRetirementHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, container: URL!, namespace: String!, state: SecretRetirementHostState!
    private let secrets = ["@mindwtr_webdav_password", "@mindwtr_cloud_token", "@mindwtr_sync_encryption_key_v1"]
    private let setting = "@mindwtr_sync_backend"
    private let invalid = "!MindwtrNativeError:Device settings input is invalid"
    private let unavailable = "!MindwtrNativeError:Device settings storage is unavailable"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var storage: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1") }
    private var manifest: URL { storage.appendingPathComponent("manifest.json") }
    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: source)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeLegacySecretRetirementHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Synthetic host fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        container = root.appendingPathComponent("device", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        namespace = "mindwtr.secret-retirement.host.fixture." + UUID().uuidString.lowercased()
        state = SecretRetirementHostState()
    }
    override func tearDownWithError() throws {
        if let state { XCTAssertEqual(state.counts.otherIO, 0, "No secret or crypto operation is performed") }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func seed(_ entries: [(String, Any)]) throws {
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        let dictionary = NSMutableDictionary()
        for (key, value) in entries { dictionary.setObject(value, forKey: key as NSString) }
        try JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys]).write(to: manifest)
    }
    private func file(_ key: String) -> URL {
        storage.appendingPathComponent(Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined())
    }
    private func inode(_ url: URL) throws -> ino_t {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Synthetic host inode unavailable") }
        return value.st_ino
    }
    private func absent(_ url: URL, file: StaticString = #filePath, line: UInt = #line) {
        var value = stat(); XCTAssertEqual(lstat(url.path, &value), -1, file: file, line: line)
        XCTAssertEqual(errno, ENOENT, file: file, line: line)
    }
    private func host(_ expression: String) throws -> CoreHost {
        let suffix = """
        ;(()=>{
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000,phase=0;
          const probe=()=>{const id=String(++next);Promise.resolve().then(()=>{
            const n=__mindwtrNative;phase++;\(expression)
          }).then(value=>replies.set(id,JSON.stringify({ok:true,value})),
            ()=>replies.set(id,JSON.stringify({ok:false,error:'Synthetic retirement probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():oldPoll(id);
        })();
        """
        let probe = root.appendingPathComponent("probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: probe, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(), state = self.state!
        faults.configureDeviceStorage = { store in
            store.faults.afterPromotion = { state.promotion() }
            store.faults.beforeSecretUnlink = { try state.beforeUnlink() }
        }
        faults.commandDiagnostic = { if $0 == "legacySecretRetirementDelivered" { state.receipt() } }
        faults.cryptoBeforeOperation = { _ in state.unexpectedIO() }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretBeforeOperation = { _, _ in state.unexpectedIO() }
        faults.secretStatus = { _, _ in errSecItemNotFound }
        let value = CoreHost(databaseURL: database, bundleURL: probe, faults: faults,
                             deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ host: CoreHost) async throws {
        let before = state.counts
        _ = try await host.start()
        XCTAssertEqual(state.counts.promotions, before.promotions, "Startup performs no retirement")
        XCTAssertEqual(state.counts.receipts, before.receipts, "Startup emits no retirement success")
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] {
        try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }
    private func delivered(_ count: Int) async throws {
        for _ in 0..<500 {
            if state.counts.receipts >= count { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(state.counts.receipts, count, "Exactly the admitted current-runtime removals are delivered")
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for row in names {
            let name = try XCTUnwrap(row["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }

    func testActualJSCRemoveAndSingleMultiRemoveDeliverFixedRetirementWithoutDomainWrites() async throws {
        let other = "unrelated-external"
        try seed(secrets.map { ($0, NSNull() as Any) } + [(setting, "local"), (other, NSNull())])
        for key in secrets { try Data("synthetic backing bytes".utf8).write(to: file(key)) }
        let kept = Data("unrelated external bytes".utf8); try kept.write(to: file(other)); let keptInode = try inode(file(other))
        let host = try host("""
        const keys=['@mindwtr_webdav_password','@mindwtr_cloud_token','@mindwtr_sync_encryption_key_v1'];
        const removed=keys.map((key,index)=>(index===2?n.kvMultiRemove(JSON.stringify([key])):n.kvRemove(key))==null);
        return {removed,absent:keys.map(key=>JSON.parse(n.kvGet(key))[0]===null)};
        """)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["removed"] as? [Bool], [true, true, true]); XCTAssertEqual(result["absent"] as? [Bool], [true, true, true])
        try await delivered(3); XCTAssertEqual(state.counts.promotions, 3); XCTAssertEqual(try rows(), before)
        for key in secrets { absent(file(key)) }
        XCTAssertEqual(try Data(contentsOf: file(other)), kept); XCTAssertEqual(try inode(file(other)), keptInode)
        let published = try Data(contentsOf: manifest), publishedInode = try inode(manifest)
        await host.close(); XCTAssertEqual(state.counts.receipts, 3)
        let cold = try self.host("return {removed:n.kvRemove('@mindwtr_webdav_password')==null};")
        try await start(cold); let noOp = try await probe(cold)
        XCTAssertEqual(noOp["removed"] as? Bool, true); try await delivered(4)
        XCTAssertEqual(state.counts.promotions, 3); XCTAssertEqual(try Data(contentsOf: manifest), published)
        XCTAssertEqual(try inode(manifest), publishedInode); XCTAssertEqual(try rows(), before)
        await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let lines = log.split(separator: "\n").filter { $0.contains("v1.3.5/ios-legacy-secret-retirement") }
        XCTAssertEqual(lines.count, 4, "Three retired secrets and one verified no-op reach persisted Diagnostics")
        for line in lines {
            let entry = try object(String(line)), context = try XCTUnwrap(entry["context"] as? [String: Any])
            XCTAssertEqual(try json(context), try json([
                "releaseCheck": "v1.3.5/ios-legacy-secret-retirement",
                "operation": "legacy-secret-retirement", "outcome": "delivered",
            ]))
        }
        for value in secrets + [namespace!, "synthetic backing bytes", "synthetic plaintext"] {
            XCTAssertFalse(log.contains(value), "Diagnostics contains no selected name, namespace or synthetic secret content")
        }
    }

    func testActualJSCSecretSetsAndMixedBatchesRefuseWithoutRetirementReceipt() async throws {
        try seed(secrets.map { ($0, "synthetic plaintext" as Any) } + [(setting, "local")])
        for key in secrets { try Data("synthetic stale bytes".utf8).write(to: file(key)) }
        let host = try host("""
        const keys=['@mindwtr_webdav_password','@mindwtr_cloud_token','@mindwtr_sync_encryption_key_v1'];
        return {sets:keys.map(key=>n.kvSet(key,'refused')),
          mixed:keys.map(key=>n.kvMultiRemove(JSON.stringify([key,'@mindwtr_sync_backend']))),
          duplicates:keys.map(key=>n.kvMultiRemove(JSON.stringify([key,key]))),
          mixedSet:n.kvMultiSet(JSON.stringify([['@mindwtr_sync_backend','other'],[keys[0],'refused']]))};
        """)
        try await start(host); let before = try rows(), bytes = try Data(contentsOf: manifest), manifestInode = try inode(manifest)
        let original = try secrets.map { try inode(file($0)) }, result = try await probe(host)
        for field in ["sets", "mixed", "duplicates"] { XCTAssertEqual(result[field] as? [String], [String](repeating: invalid, count: 3)) }
        XCTAssertEqual(result["mixedSet"] as? String, invalid); XCTAssertEqual(state.counts.promotions, 0)
        XCTAssertEqual(state.counts.receipts, 0); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try inode(manifest), manifestInode); XCTAssertEqual(try secrets.map { try inode(file($0)) }, original)
        XCTAssertEqual(try rows(), before); await host.close(); XCTAssertEqual(state.counts.receipts, 0)
        let logURL = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: logURL.path) {
            let log = try String(contentsOf: logURL, encoding: .utf8)
            XCTAssertFalse(log.contains("v1.3.5/ios-legacy-secret-retirement"), "Refusals and close persist no retirement success")
        }
    }

    func testActualJSCWarmRetryDeliversOnlyAfterBackingRetirementAndNeverRepublishes() async throws {
        let key = secrets[0]; try seed([(key, NSNull()), (setting, "local")])
        let backing = Data("synthetic backing bytes".utf8); try backing.write(to: file(key))
        let original = try inode(file(key)); state.setFailure(true)
        let host = try host("const removal=n.kvRemove('@mindwtr_webdav_password');return {removal,removed:removal==null};")
        try await start(host); let before = try rows(), first = try await probe(host)
        XCTAssertEqual(first["removal"] as? String, unavailable); XCTAssertEqual(first["removed"] as? Bool, false)
        XCTAssertEqual(state.counts.receipts, 0)
        XCTAssertEqual(state.counts.promotions, 1); XCTAssertEqual(try inode(file(key)), original)
        XCTAssertEqual(try Data(contentsOf: file(key)), backing)
        let published = try Data(contentsOf: manifest), publishedInode = try inode(manifest)
        state.setFailure(false); let retry = try await probe(host)
        XCTAssertEqual(retry["removed"] as? Bool, true); try await delivered(1); absent(file(key))
        XCTAssertEqual(state.counts.promotions, 1); XCTAssertEqual(try Data(contentsOf: manifest), published)
        XCTAssertEqual(try inode(manifest), publishedInode); XCTAssertEqual(try rows(), before)
    }

    func testActualJSCColdReadDoesNotCleanOrphanAndNewExplicitRemoveCompletesRetirement() async throws {
        let key = secrets[2]; try seed([(key, NSNull()), (setting, "local")])
        let backing = Data("synthetic backing bytes".utf8); try backing.write(to: file(key))
        let original = try inode(file(key)); state.setFailure(true)
        let first = try host("return {removal:n.kvMultiRemove(JSON.stringify(['@mindwtr_sync_encryption_key_v1']))};")
        try await start(first); let before = try rows(), refusal = try await probe(first)
        XCTAssertEqual(refusal["removal"] as? String, unavailable); XCTAssertEqual(state.counts.receipts, 0)
        let published = try Data(contentsOf: manifest), publishedInode = try inode(manifest)
        await first.close(); state.setFailure(false)
        let cold = try host("""
        if(phase===1)return {absent:JSON.parse(n.kvGet('@mindwtr_sync_encryption_key_v1'))[0]===null};
        return {removed:n.kvMultiRemove(JSON.stringify(['@mindwtr_sync_encryption_key_v1']))==null};
        """)
        try await start(cold); let read = try await probe(cold)
        XCTAssertEqual(read["absent"] as? Bool, true); XCTAssertEqual(state.counts.receipts, 0)
        XCTAssertEqual(try Data(contentsOf: manifest), published); XCTAssertEqual(try inode(manifest), publishedInode)
        XCTAssertEqual(try Data(contentsOf: file(key)), backing); XCTAssertEqual(try inode(file(key)), original)
        let result = try await probe(cold); XCTAssertEqual(result["removed"] as? Bool, true); try await delivered(1)
        absent(file(key)); XCTAssertEqual(state.counts.promotions, 2); XCTAssertEqual(try rows(), before)
    }
}
