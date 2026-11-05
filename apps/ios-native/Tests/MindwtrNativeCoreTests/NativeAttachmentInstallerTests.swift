import XCTest
import CryptoKit
@testable import MindwtrNativeCore

final class NativeAttachmentInstallerTests: XCTestCase {
    private var root: URL!
    private var managed: URL { root.appendingPathComponent("attachments", isDirectory: true) }
    private var stage: URL { root.appendingPathComponent("staging", isDirectory: true) }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func host() throws -> NativeAttachmentInstaller {
        try NativeAttachmentInstaller(managedRoot: managed, sourceRoots: [stage, managed])
    }
    private func sha(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func request(_ object: [String: Any], on host: NativeAttachmentInstaller? = nil) throws -> [String: Any] {
        let input = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        let output = try (host ?? self.host()).handle(input)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any])
    }
    private func install(_ source: URL, _ target: URL, _ bytes: String, expected: [String: String] = ["kind": "absent"]) throws -> [String: Any] {
        try request(["op": "install", "staged": source.absoluteString, "target": target.absoluteString,
                     "expected": expected, "expectedDownloadSha256": sha(bytes)])
    }

    func testCandidateRawProviderJSONInstallHashReplayAndConflictKeepExactPayloads() throws {
        try withCandidate { files, adapter in
            let target = files.managedRoot.appendingPathComponent("provider.txt")
            func stage(_ name: String, _ value: String) throws -> URL {
                let path = files.managedRoot.appendingPathComponent(".mindwtr-download-" + name + ".staged")
                try Data(value.utf8).write(to: path); return path
            }
            func install(_ source: URL, _ text: String, _ expected: [String: String]) throws -> [String: Any] {
                try request(["op": "install", "staged": source.absoluteString, "target": target.absoluteString,
                    "expected": expected, "expectedDownloadSha256": sha(text)], on: adapter)
            }
            let first = try stage("first", "first")
            XCTAssertEqual(try install(first, "first", ["kind": "absent"]) as NSDictionary, ["status": "installed"] as NSDictionary)
            let hashed = try request(["op": "hash", "path": target.absoluteString], on: adapter)
            XCTAssertEqual(Set(hashed.keys), ["sha256", "size", "modificationTimeMs"])
            XCTAssertEqual(hashed["sha256"] as? String, sha("first")); XCTAssertEqual(hashed["size"] as? Int, 5)
            let replay = try stage("replay", "first")
            XCTAssertEqual(try install(replay, "first", ["kind": "absent"])["status"] as? String, "installed")
            let conflict = try stage("conflict", "conflict")
            XCTAssertEqual(try install(conflict, "conflict", ["kind": "absent"]) as NSDictionary,
                ["status": "conflict", "preservedPath": conflict.absoluteString] as NSDictionary)
            let replacement = try stage("replacement", "second")
            let result = try install(replacement, "second", ["kind": "present", "sha256": sha("first")])
            XCTAssertEqual(Set(result.keys), ["status", "preservedPath"])
            XCTAssertEqual(result["status"] as? String, "installed")
            let preserved = try XCTUnwrap(URL(string: XCTUnwrap(result["preservedPath"] as? String)))
            XCTAssertEqual(try Data(contentsOf: preserved), Data("first".utf8))
            XCTAssertEqual(try Data(contentsOf: target), Data("second".utf8))
            XCTAssertEqual(try request(["op": "hash", "path": target.absoluteString], on: adapter)["sha256"] as? String, sha("second"))
            XCTAssertFalse(FileManager.default.fileExists(atPath: first.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: replay.path))
            XCTAssertEqual(try Data(contentsOf: conflict), Data("conflict".utf8))
        }
    }

    func testCandidateRawProviderRefusesCacheSourceOldUUIDAndReplacedAncestor() throws {
        try withCandidate { files, adapter in
            let cache = files.cacheRoot.appendingPathComponent(".mindwtr-download-cache.staged")
            let target = files.managedRoot.appendingPathComponent("target.txt")
            try Data("incoming".utf8).write(to: cache)
            try Data("local".utf8).write(to: target)
            XCTAssertThrowsError(try request(["op": "install", "staged": cache.absoluteString, "target": target.absoluteString,
                "expected": ["kind": "absent"], "expectedDownloadSha256": sha("incoming")], on: adapter))
            let old = files.managedRoot.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("old-uuid/Documents/attachments/target.txt")
            XCTAssertThrowsError(try request(["op": "hash", "path": old.absoluteString], on: adapter))
            let documents = files.managedRoot.deletingLastPathComponent(), retained = documents.appendingPathExtension("retained")
            try FileManager.default.moveItem(at: documents, to: retained)
            try FileManager.default.copyItem(at: retained, to: documents)
            XCTAssertThrowsError(try request(["op": "hash", "path": target.absoluteString], on: adapter))
            XCTAssertEqual(try Data(contentsOf: target), Data("local".utf8))
            XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent("attachments/target.txt")), Data("local".utf8))
            XCTAssertEqual(try Data(contentsOf: cache), Data("incoming".utf8))
        }
    }

    private func withCandidate(_ body: (NativeAttachmentFiles, NativeAttachmentInstaller) throws -> Void) throws {
        let container = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/provider-adapter-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: container) }
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Library"), withIntermediateDirectories: true)
        let files = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
        _ = try files.ensureManagedDirectoryProof(checkCancellation: {})
        let adapter = try NativeAttachmentInstaller(managedRoot: files.managedRoot, sourceRoots: files.sourceRoots, filePort: files)
        try body(files, adapter)
    }

    func testInstallHashAndReplacementThroughRecreatedHost() throws {
        let source = stage.appendingPathComponent("first")
        let target = managed.appendingPathComponent("attachment.txt")
        try Data("first generation".utf8).write(to: source)
        XCTAssertEqual(try install(source, target, "first generation")["status"] as? String, "installed")
        let digest = try request(["op": "hash", "path": target.absoluteString], on: host())
        XCTAssertEqual(digest["sha256"] as? String, sha("first generation"))
        XCTAssertEqual(digest["size"] as? Int, 16)
        XCTAssertGreaterThan(try XCTUnwrap(digest["modificationTimeMs"] as? Double), 0)
        let next = stage.appendingPathComponent("second")
        try Data("new bytes".utf8).write(to: next)
        XCTAssertEqual(try install(next, target, "new bytes", expected: ["kind": "present", "sha256": sha("first generation")])["status"] as? String, "installed")
        XCTAssertEqual(try Data(contentsOf: target), Data("new bytes".utf8))
        XCTAssertEqual(try request(["op": "hash", "path": target.absoluteString])["sha256"] as? String, sha("new bytes"))
    }

    func testAbsentManagedRootBindsAfterOrdinaryCreationAcrossPreparePublishHashAndRetire() throws {
        // The owner creates this directory later; the adapter must neither
        // create it at construction nor retain its missing-path canonical URL.
        let lateManaged = root.appendingPathComponent("late-managed", isDirectory: false)
        XCTAssertFalse(lateManaged.hasDirectoryPath)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lateManaged.path))
        let adapter = try NativeAttachmentInstaller(managedRoot: lateManaged, sourceRoots: [stage, lateManaged])
        XCTAssertFalse(FileManager.default.fileExists(atPath: lateManaged.path))
        try FileManager.default.createDirectory(at: lateManaged, withIntermediateDirectories: false)

        let target = lateManaged.appendingPathComponent("published.txt"), text = "owned publication bytes"
        let bytes = Data(text.utf8), operationID = String(repeating: "1", count: 32)
        let prepared = try adapter.prepareStage(targetURI: target.absoluteString, operationID: operationID)
        XCTAssertEqual(prepared.stageURI, target.deletingLastPathComponent().absoluteString + ".mindwtr-install-" + operationID + ".candidate/stage")
        let stageURL = try XCTUnwrap(URL(string: prepared.stageURI))
        XCTAssertEqual(try Data(contentsOf: stageURL), Data())
        try bytes.write(to: stageURL)
        XCTAssertEqual(try adapter.publishStage(stage: prepared, targetURI: target.absoluteString, sha256: sha(text)), "published")
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        let hashed = try request(["op": "hash", "path": target.absoluteString], on: adapter)
        XCTAssertEqual(hashed["sha256"] as? String, sha(text)); XCTAssertEqual(hashed["size"] as? Int, bytes.count)

        // Exercise the other fixed Apple spelling when the existing fixture is
        // beneath /var. Every returned proof retains its caller's exact URI.
        var nextManaged = lateManaged
        if lateManaged.path.hasPrefix("/private/var/") {
            nextManaged = URL(fileURLWithPath: String(lateManaged.path.dropFirst("/private".count)), isDirectory: true)
        } else if lateManaged.path.hasPrefix("/var/") {
            nextManaged = URL(fileURLWithPath: "/private" + lateManaged.path, isDirectory: true)
        }
        let nextTarget = nextManaged.appendingPathComponent("unpublished.txt"), nextID = String(repeating: "2", count: 32)
        let next = try adapter.prepareStage(targetURI: nextTarget.absoluteString, operationID: nextID)
        XCTAssertEqual(next.stageURI, nextTarget.deletingLastPathComponent().absoluteString + ".mindwtr-install-" + nextID + ".candidate/stage")
        let nextStage = try XCTUnwrap(URL(string: next.stageURI))
        try Data("owned partial bytes".utf8).write(to: nextStage)
        let recreated = try NativeAttachmentInstaller(managedRoot: lateManaged, sourceRoots: [stage, lateManaged])
        XCTAssertEqual(try recreated.retirePrivateStage(stage: next, targetURI: nextTarget.absoluteString, operationID: nextID), "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: nextStage.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: nextTarget.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: nextStage.deletingLastPathComponent().path))
        XCTAssertEqual(try recreated.retirePrivateStage(stage: next, targetURI: nextTarget.absoluteString, operationID: nextID), "missing")

        // Replay also confirms the owed namespace cleanup when only its stage
        // file is absent, keeping the original caller URI and identity tokens.
        let missingTarget = nextManaged.appendingPathComponent("stage-missing.txt"), missingID = String(repeating: "3", count: 32)
        let missing = try adapter.prepareStage(targetURI: missingTarget.absoluteString, operationID: missingID)
        XCTAssertEqual(missing.stageURI, missingTarget.deletingLastPathComponent().absoluteString + ".mindwtr-install-" + missingID + ".candidate/stage")
        let missingStage = try XCTUnwrap(URL(string: missing.stageURI))
        try FileManager.default.removeItem(at: missingStage)
        XCTAssertTrue(FileManager.default.fileExists(atPath: missingStage.deletingLastPathComponent().path))
        XCTAssertEqual(try recreated.retirePrivateStage(stage: missing, targetURI: missingTarget.absoluteString, operationID: missingID), "missing")
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingStage.deletingLastPathComponent().path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingTarget.path))

        let foreign = root.appendingPathComponent("foreign.txt"), foreignBytes = Data("foreign generation".utf8)
        try foreignBytes.write(to: foreign)
        XCTAssertThrowsError(try adapter.prepareStage(targetURI: foreign.absoluteString, operationID: String(repeating: "4", count: 32))) {
            XCTAssertEqual($0 as? NativeAttachmentInstallerError, .unavailable)
        }
        XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try Data(contentsOf: target), bytes)

        let retained = root.appendingPathComponent("retained-managed", isDirectory: true)
        try FileManager.default.moveItem(at: lateManaged, to: retained)
        try FileManager.default.createSymbolicLink(at: lateManaged, withDestinationURL: retained)
        XCTAssertThrowsError(try request(["op": "hash", "path": target.absoluteString], on: adapter)) {
            XCTAssertEqual($0 as? NativeAttachmentInstallerError, .unavailable)
        }
        XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent(target.lastPathComponent)), bytes)
        XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes)
    }

    func testConflictPreservesBothGenerationsAndReturnsOriginalStagedReference() throws {
        let source = stage.appendingPathComponent("download")
        let target = managed.appendingPathComponent("attachment.txt")
        try Data("incoming".utf8).write(to: source)
        try Data("local edit".utf8).write(to: target)
        let answer = try install(source, target, "incoming")
        XCTAssertEqual(answer["status"] as? String, "conflict")
        let preserved = try XCTUnwrap(URL(string: XCTUnwrap(answer["preservedPath"] as? String)))
        XCTAssertEqual(preserved.standardizedFileURL, source.standardizedFileURL)
        XCTAssertEqual(try Data(contentsOf: preserved), Data("incoming".utf8))
        XCTAssertEqual(try Data(contentsOf: target), Data("local edit".utf8))
    }

    func testWrongDigestDoesNotPublishOrRemoveSource() throws {
        let source = stage.appendingPathComponent("download")
        let target = managed.appendingPathComponent("attachment.txt")
        try Data("original".utf8).write(to: source)
        XCTAssertThrowsError(try install(source, target, "different")) { error in
            XCTAssertEqual(error as? NativeAttachmentInstallerError, .unavailable)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try Data(contentsOf: source), Data("original".utf8))
    }

    func testOutsideRootsAndSymlinkRefusedWithoutExposingPaths() throws {
        let outside = root.appendingPathComponent("private-source-name")
        let target = managed.appendingPathComponent("attachment.txt")
        try Data("private bytes".utf8).write(to: outside)
        XCTAssertThrowsError(try install(outside, target, "private bytes")) { error in
            XCTAssertEqual(error.localizedDescription, "Attachment file operation is unavailable")
        }
        let link = stage.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        XCTAssertThrowsError(try install(link, target, "private bytes"))
        XCTAssertThrowsError(try request(["op": "hash", "path": outside.absoluteString]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try Data(contentsOf: outside), Data("private bytes".utf8))
    }

    func testMalformedRequestsFailBeforeIO() throws {
        let source = stage.appendingPathComponent("source")
        let target = managed.appendingPathComponent("target")
        try Data("bytes".utf8).write(to: source)
        let valid: [String: Any] = ["op": "install", "staged": source.absoluteString, "target": target.absoluteString,
                                    "expected": ["kind": "absent"], "expectedDownloadSha256": sha("bytes")]
        var unknown = valid; unknown["root"] = root.absoluteString
        var malformedExpected = valid; malformedExpected["expected"] = ["kind": "absent", "sha256": sha("bytes")]
        var uppercaseDigest = valid; uppercaseDigest["expectedDownloadSha256"] = sha("bytes").uppercased()
        var notDigest = valid; notDigest["expectedDownloadSha256"] = true
        var remote = valid; remote["staged"] = "file://server/private-source-name"
        var port = valid; port["staged"] = "file://:123" + source.path
        var relative = valid; relative["staged"] = "file:relative"
        var query = valid; query["staged"] = source.absoluteString + "?credential=private"
        var traversal = valid; traversal["staged"] = stage.absoluteString + "/../private-source-name"
        var missing = valid; missing.removeValue(forKey: "target")
        for value in [unknown, malformedExpected, uppercaseDigest, notDigest, remote, port, relative, query, traversal, missing,
                      ["op": "publishImmutable"], ["op": "hash", "path": target.absoluteString, "extra": false]] {
            XCTAssertThrowsError(try request(value)) { error in
                XCTAssertEqual(error as? NativeAttachmentInstallerError, .invalidRequest)
            }
        }
        XCTAssertThrowsError(try host().handle(String(repeating: " ", count: 65537)))
        XCTAssertThrowsError(try host().handle("[]"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try Data(contentsOf: source), Data("bytes".utf8))
    }
}
