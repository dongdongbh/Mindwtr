import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class NativeAttachmentFilesTests: XCTestCase {
    private var root: URL!
    private var physicalRootPath: String!
    private var files: NativeAttachmentFiles!
    private var documents: URL!
    private var cache: URL!
    private enum Cancelled: Error { case stopped }

    override func setUpWithError() throws {
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/attachment-files-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)


        guard let physical = Darwin.realpath(root.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        physicalRootPath = String(cString: physical)
        root = URL(fileURLWithPath: physicalRootPath, isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        let directories = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(files.directoriesJSON.utf8)) as? [String: String])
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"])))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"])))
    }
    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func call(_ object: [String: Any], on port: NativeAttachmentFiles? = nil,
                      check: () throws -> Void = {}) throws -> NativeAttachmentFiles.Reply {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
        return try (port ?? files).call(json, checkCancellation: check)
    }
    private func write(_ uri: URL, _ bytes: Data) throws {
        _ = try call(["op": "writeBytes", "uri": uri.absoluteString, "base64": bytes.base64EncodedString()])
    }
    private func read(_ uri: URL) throws -> Data {
        try XCTUnwrap(call(["op": "readBytes", "uri": uri.absoluteString]).bytes)
    }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func names(_ url: URL) throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: url.path).sorted() }
    private func assertError(_ expected: NativeAttachmentFilesError, _ body: () throws -> Void,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeAttachmentFilesError, expected, file: file, line: line)
        }
    }
    private func largeSource(_ name: String = "large.bin") throws -> (URL, Int, String) {
        let source = cache.appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.createFile(atPath: source.path, contents: nil))
        let handle = try FileHandle(forWritingTo: source)
        defer { try? handle.close() }
        let chunk = Data(repeating: 0x7a, count: 1024 * 1024)
        var hash = SHA256()
        for _ in 0..<18 { try handle.write(contentsOf: chunk); hash.update(data: chunk) }
        let tail = Data("tail + 世界".utf8)
        try handle.write(contentsOf: tail); hash.update(data: tail)
        try handle.synchronize()
        return (source, 18 * chunk.count + tail.count, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }

    func testDirectoryContractIsPrivateLibraryScopedAndTrailingSlash() throws {
        let map = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(files.directoriesJSON.utf8)) as? [String: String])
        XCTAssertEqual(Set(map.keys), ["document", "cache"])
        XCTAssertTrue(try XCTUnwrap(map["document"]).hasSuffix("/"))
        XCTAssertTrue(try XCTUnwrap(map["cache"]).hasSuffix("/"))
        XCTAssertEqual(documents.path, physicalRootPath + "/attachment-files/documents")
        XCTAssertEqual(cache.path, physicalRootPath + "/attachment-files/cache")
        XCTAssertEqual(files.managedRoot, documents.appendingPathComponent("attachments", isDirectory: true))
        XCTAssertEqual(files.sourceRoots, [documents!, cache!])
        XCTAssertNil(try call(["op": "barrier"]).value)
        XCTAssertNil(try call(["op": "barrier"]).bytes)
    }

    private func candidate(_ name: String = UUID().uuidString) throws -> URL {
        let container = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Documents", isDirectory: true), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container.appendingPathComponent("Library", isDirectory: true), withIntermediateDirectories: false)
        return container
    }

    func testCandidateUsesActualRNRootsForIOWithoutCreatingAlternateAuthority() throws {
        let container = try candidate(), port = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
        let document = container.appendingPathComponent("Documents", isDirectory: true)
        let cache = container.appendingPathComponent("Library/Caches", isDirectory: true)
        let preserved = document.appendingPathComponent("unrelated.json"), bytes = Data("existing RN bytes".utf8)
        try bytes.write(to: preserved)
        XCTAssertEqual(port.managedRoot, document.appendingPathComponent("attachments", isDirectory: true))
        XCTAssertEqual(port.sourceRoots, [document, cache])
        XCTAssertEqual(try call(["op": "readBytes", "uri": preserved.absoluteString], on: port).bytes, bytes)
        let target = port.managedRoot.appendingPathComponent("new.bin")
        _ = try call(["op": "writeBytes", "uri": target.absoluteString, "base64": bytes.base64EncodedString()], on: port)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: preserved), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.appendingPathComponent("Documents/SQLite/attachment-files").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.appendingPathComponent("attachment-files").path))
        XCTAssertThrowsError(try call(["op": "readBytes", "uri": documents.appendingPathComponent("unrelated.json").absoluteString], on: port))
        XCTAssertThrowsError(try call(["op": "readBytes", "uri": target.absoluteString]))
        let json = String(decoding: try JSONSerialization.data(withJSONObject: ["op": "readBytes", "uri": target.absoluteString]), as: UTF8.self)
        XCTAssertThrowsError(try port.call(json, maximumReadBytes: bytes.count - 1)) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, .tooLarge)
        }
    }

    func testCandidateRefusesSameContentReplacementOfEveryBoundAncestor() throws {
        for relative in ["", "Documents", "Library", "Library/Caches"] {
            let container = try candidate(), port = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
            let document = container.appendingPathComponent("Documents/file.bin")
            let cache = container.appendingPathComponent("Library/Caches/file.bin")
            let bytes = Data("same contents".utf8)
            try bytes.write(to: document); try bytes.write(to: cache)
            let replaced = relative.isEmpty ? container : container.appendingPathComponent(relative, isDirectory: true)
            let retained = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.moveItem(at: replaced, to: retained)
            try FileManager.default.copyItem(at: retained, to: replaced)
            for target in [document, cache] {
                XCTAssertThrowsError(try call(["op": "readBytes", "uri": target.absoluteString], on: port), relative)
                XCTAssertThrowsError(try call(["op": "writeBytes", "uri": target.absoluteString, "base64": Data("replacement".utf8).base64EncodedString()], on: port), relative)
                XCTAssertEqual(try Data(contentsOf: target), bytes)
            }
            XCTAssertThrowsError(try port.verifyCandidateRoots(), relative)
        }
    }

    func testCandidateMissingOrSymlinkedRootsNeverGrantAuthority() throws {
        for relative in ["", "Documents", "Library", "Library/Caches"] {
            let container = try candidate()
            if relative == "Library/Caches" {
                try FileManager.default.createDirectory(at: container.appendingPathComponent(relative), withIntermediateDirectories: false)
            }
            let replaced = relative.isEmpty ? container : container.appendingPathComponent(relative, isDirectory: true)
            let retained = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.moveItem(at: replaced, to: retained)
            if relative != "Library/Caches" { XCTAssertThrowsError(try NativeAttachmentFiles(rnAdoptionContainerURL: container), relative) }
            try FileManager.default.createSymbolicLink(at: replaced, withDestinationURL: retained)
            XCTAssertThrowsError(try NativeAttachmentFiles(rnAdoptionContainerURL: container), relative)
        }
    }

    func testCandidateRefusesSymlinkAndHardlinkedLeavesWithoutReadingOrChangingThem() throws {
        let container = try candidate(), port = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
        let document = container.appendingPathComponent("Documents", isDirectory: true)
        let original = document.appendingPathComponent("original.bin"), linked = document.appendingPathComponent("linked.bin")
        let bytes = Data("preserve linked bytes".utf8)
        try bytes.write(to: original)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: original)
        XCTAssertThrowsError(try call(["op": "readBytes", "uri": linked.absoluteString], on: port))
        try FileManager.default.removeItem(at: linked)
        XCTAssertEqual(Darwin.link(original.path, linked.path), 0)
        for target in [original, linked] {
            XCTAssertThrowsError(try call(["op": "readBytes", "uri": target.absoluteString], on: port))
            XCTAssertThrowsError(try call(["op": "getInfo", "uri": target.absoluteString], on: port))
            XCTAssertThrowsError(try call(["op": "writeBytes", "uri": target.absoluteString, "base64": Data("changed".utf8).base64EncodedString()], on: port))
            XCTAssertEqual(try Data(contentsOf: target), bytes)
        }
    }

    func testCandidatePathnameInstallerHashAndInstallRefuseWithoutMutation() throws {
        let container = try candidate(), port = try NativeAttachmentFiles(rnAdoptionContainerURL: container)
        let installer = try NativeAttachmentInstaller(managedRoot: port.managedRoot, sourceRoots: port.sourceRoots, filePort: port)
        let source = port.cacheRoot.appendingPathComponent("source.bin"), bytes = Data("preserved cache source".utf8)
        try bytes.write(to: source)
        for input: [String: Any] in [
            ["op": "hash", "path": source.absoluteString],
            ["op": "install", "staged": source.absoluteString, "target": port.managedRoot.appendingPathComponent("target.bin").absoluteString,
             "expected": ["kind": "absent"], "expectedDownloadSha256": digest(bytes)]
        ] {
            let raw = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
            XCTAssertThrowsError(try installer.handle(raw))
        }
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: port.managedRoot.path))
    }

    func testRealByteRoundTripPreservesSpacesPlusUnicodeAndSeconds() throws {
        let directory = documents.appendingPathComponent("attachments/Space + 世界", isDirectory: true)
        _ = try call(["op": "makeDirectory", "uri": directory.absoluteString])
        let target = directory.appendingPathComponent("résumé + 文件.bin")
        let bytes = Data([0, 1, 255]) + Data("hello + 世界".utf8)
        try write(target, bytes)
        XCTAssertEqual(try read(target), bytes)
        let listing = try XCTUnwrap(call(["op": "readDirectory", "uri": directory.absoluteString]).value as? [String])
        XCTAssertEqual(listing, [target.lastPathComponent])
        let info = try XCTUnwrap(call(["op": "getInfo", "uri": target.absoluteString]).value as? [String: Any])
        XCTAssertEqual(info["exists"] as? Bool, true)
        XCTAssertEqual(info["isDirectory"] as? Bool, false)
        XCTAssertEqual(info["size"] as? Int64, Int64(bytes.count))
        let date = try XCTUnwrap(target.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        XCTAssertEqual(try XCTUnwrap(info["modificationTime"] as? Double), date.timeIntervalSince1970, accuracy: 0.001)
        let folder = try XCTUnwrap(call(["op": "getInfo", "uri": directory.absoluteString]).value as? [String: Any])
        XCTAssertEqual(folder["isDirectory"] as? Bool, true)
        XCTAssertEqual(try call(["op": "sha256File", "uri": target.absoluteString]).value as? String, digest(bytes))
        XCTAssertEqual(try call(["op": "sha256", "base64": bytes.base64EncodedString()]).value as? String, digest(bytes))
    }

    func testZeroByteBase64IsValidAndReplacesWithEmptyDurableFile() throws {
        let target = cache.appendingPathComponent("empty.bin")
        try write(target, Data("existing".utf8))
        try write(target, Data())
        XCTAssertEqual(try read(target), Data())
        XCTAssertEqual(try call(["op": "sha256", "base64": ""]).value as? String, digest(Data()))
        XCTAssertEqual(try call(["op": "sha256File", "uri": target.absoluteString]).value as? String, digest(Data()))
    }

    func testExactBridgeLimitAcceptedAndOverflowRefusedBeforePublication() throws {
        let target = cache.appendingPathComponent("limit.bin")
        let bytes = Data(repeating: 0x61, count: NativeAttachmentFiles.maximumBytes)
        try write(target, bytes)
        XCTAssertEqual(try read(target), bytes)


        let encodedLength = ((NativeAttachmentFiles.maximumBytes + 2) / 3) * 4
        for oversized in [String(repeating: "A", count: encodedLength), String(repeating: "A", count: encodedLength - 1) + "=",
                          String(repeating: "A", count: encodedLength + 4)] {
            assertError(.tooLarge) { _ = try self.call(["op": "writeBytes", "uri": target.absoluteString, "base64": oversized]) }
            assertError(.tooLarge) { _ = try self.call(["op": "sha256", "base64": oversized]) }
        }
        XCTAssertEqual(try read(target), bytes)
        XCTAssertEqual(try names(cache), ["limit.bin"])
    }

    func testCanonicalBase64AndShapeRequiredWithoutFileMutation() throws {
        let target = cache.appendingPathComponent("unchanged.bin")
        try write(target, Data("original".utf8))
        for malformed: Any in ["AQ", "AB==", "A===", "A A==", "AA==\n", "!", 7, true, NSNull()] {
            assertError(.invalidRequest) { _ = try self.call(["op": "writeBytes", "uri": target.absoluteString, "base64": malformed]) }
            assertError(.invalidRequest) { _ = try self.call(["op": "sha256", "base64": malformed]) }
        }
        XCTAssertEqual(try read(target), Data("original".utf8))
        XCTAssertEqual(try names(cache), ["unchanged.bin"])
    }

    func testRangeShortReadEOFAndInvalidNumericTypes() throws {
        let target = cache.appendingPathComponent("range.bin")
        try write(target, Data("0123456789".utf8))
        for (position, length, expected) in [(3, 4, "3456"), (8, 9, "89"), (20, 2, ""), (0, 0, "")] {
            XCTAssertEqual(try call(["op": "readBytesRange", "uri": target.absoluteString,
                                     "position": position, "length": length]).bytes, Data(expected.utf8))
        }
        for value: Any in [-1, 0.5, true, "0", NSNull(), 9_007_199_254_740_992.0] {
            for field in ["position", "length"] {
                var request: [String: Any] = ["op": "readBytesRange", "uri": target.absoluteString, "position": 0, "length": 1]
                request[field] = value
                assertError(.invalidRequest) { _ = try self.call(request) }
            }
        }
        assertError(.tooLarge) { _ = try self.call(["op": "readBytesRange", "uri": target.absoluteString,
                                                  "position": 0, "length": NativeAttachmentFiles.maximumBytes + 1]) }
    }

    func testStreamingCopyAndHashOverBridgeLimitAndSmallRange() throws {
        let (source, size, hash) = try largeSource()
        let target = documents.appendingPathComponent("attachments/large-copy.bin")
        let copy = try call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString])
        XCTAssertNil(copy.value); XCTAssertNil(copy.bytes)
        XCTAssertEqual(try call(["op": "sha256File", "uri": target.absoluteString]).value as? String, hash)
        XCTAssertEqual(try call(["op": "sha256File", "uri": source.absoluteString]).value as? String, hash)
        let info = try XCTUnwrap(call(["op": "getInfo", "uri": target.absoluteString]).value as? [String: Any])
        XCTAssertEqual(info["size"] as? Int64, Int64(size))
        assertError(.tooLarge) { _ = try self.call(["op": "readBytes", "uri": target.absoluteString]) }
        let expected = Data("tail + 世界".utf8)
        XCTAssertEqual(try call(["op": "readBytesRange", "uri": target.absoluteString,
                                 "position": size - expected.count, "length": 1024]).bytes, expected)
    }

    func testStrictURIsRefuseOutsideLibraryPrefixSiblingsAuthorityAndTraversal() throws {
        let outside = root.appendingPathComponent("database-private-name")
        try Data("private".utf8).write(to: outside)
        let peer = root.appendingPathComponent("attachment-files/cache-peer/file")
        let prefix = cache.absoluteString
        let forbidden = [outside.absoluteString, peer.absoluteString, "file://localhost" + outside.path,
                         "file://:123" + cache.path, "file:user-relative", "https://example.invalid/file", "/absolute/file",
                         prefix + "../documents/file", prefix + "%2e%2e/documents/file", prefix + "%2E%2E%2Fdocuments/file",
                         prefix + "file?credential=private", prefix + "file#fragment", prefix + "file%00suffix", prefix + "file\0suffix"]
        for uri in forbidden {
            for op in ["getInfo", "readBytes", "sha256File", "makeDirectory", "delete"] {
                assertError(.invalidRequest) { _ = try self.call(["op": op, "uri": uri]) }
            }
            assertError(.invalidRequest) { try self.files.deleteNow(uri) }
        }
        XCTAssertEqual(try Data(contentsOf: outside), Data("private".utf8))
        XCTAssertEqual(try names(cache), [])
    }

    func testConfiguredRootsCanBeReadButNeverRemovedMovedOrOverwritten() throws {
        let source = cache.appendingPathComponent("source")
        try write(source, Data("original".utf8))
        for rootURL in [documents!, cache!] {
            _ = try call(["op": "makeDirectory", "uri": rootURL.absoluteString])
            _ = try call(["op": "getInfo", "uri": rootURL.absoluteString])
            assertError(.invalidRequest) { try self.write(rootURL, Data()) }
            assertError(.invalidRequest) { _ = try self.call(["op": "delete", "uri": rootURL.absoluteString]) }
            assertError(.invalidRequest) { try self.files.deleteNow(rootURL.absoluteString) }
            assertError(.invalidRequest) { _ = try self.call(["op": "copy", "uri": source.absoluteString, "to": rootURL.absoluteString]) }
            assertError(.invalidRequest) { _ = try self.call(["op": "move", "uri": rootURL.absoluteString, "to": source.absoluteString]) }
        }
        XCTAssertEqual(try read(source), Data("original".utf8))
    }

    func testSymlinkParentAndLeafAreNeverFollowedAndDeleteOnlyLinkEntry() throws {
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let sentinel = outside.appendingPathComponent("sentinel")
        try Data("private".utf8).write(to: sentinel)
        let parentLink = cache.appendingPathComponent("parent-link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: parentLink, withDestinationURL: outside)
        let leafLink = cache.appendingPathComponent("leaf-link")
        try FileManager.default.createSymbolicLink(at: leafLink, withDestinationURL: sentinel)
        for url in [parentLink.appendingPathComponent("sentinel"), leafLink] {
            for op in ["getInfo", "readBytes", "sha256File"] {
                assertError(.unavailable) { _ = try self.call(["op": op, "uri": url.absoluteString]) }
            }
            assertError(.unavailable) { try self.write(url, Data("replacement".utf8)) }
        }
        assertError(.unavailable) { _ = try self.call(["op": "delete", "uri": parentLink.appendingPathComponent("sentinel").absoluteString]) }
        try files.deleteNow(leafLink.absoluteString)
        XCTAssertFalse(FileManager.default.fileExists(atPath: leafLink.path))
        _ = try call(["op": "delete", "uri": parentLink.absoluteString])
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("private".utf8))
    }

    func testDirectDeleteFilesOnlyAndAsyncDeleteEmptyDirectoriesOnly() throws {
        let target = cache.appendingPathComponent("same-turn.bin")
        try write(target, Data("bytes".utf8))
        try files.deleteNow(target.absoluteString)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        try files.deleteNow(target.absoluteString)
        _ = try call(["op": "syncParent", "uri": target.absoluteString])
        let folder = cache.appendingPathComponent("folder", isDirectory: true)
        _ = try call(["op": "makeDirectory", "uri": folder.absoluteString])
        let nested = folder.appendingPathComponent("nested")
        try write(nested, Data("keep".utf8))
        assertError(.unavailable) { try self.files.deleteNow(folder.absoluteString) }
        assertError(.unavailable) { _ = try self.call(["op": "delete", "uri": folder.absoluteString]) }
        XCTAssertEqual(try read(nested), Data("keep".utf8))
        _ = try call(["op": "delete", "uri": nested.absoluteString])
        assertError(.unavailable) { try self.files.deleteNow(folder.absoluteString) }
        _ = try call(["op": "delete", "uri": folder.absoluteString])
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testMissingIsConfirmedAndCannotMaskBrokenOwnedRoot() throws {
        let missing = cache.appendingPathComponent("missing/final")
        let info = try XCTUnwrap(call(["op": "getInfo", "uri": missing.absoluteString]).value as? [String: Any])
        XCTAssertEqual(info["exists"] as? Bool, false)
        assertError(.missing) { _ = try self.call(["op": "readBytes", "uri": missing.absoluteString]) }
        _ = try call(["op": "delete", "uri": missing.absoluteString])
        let unknown = cache.appendingPathComponent("unknown")
        try FileManager.default.removeItem(at: cache)
        assertError(.unavailable) { _ = try self.call(["op": "getInfo", "uri": unknown.absoluteString]) }
        assertError(.unavailable) { _ = try self.call(["op": "delete", "uri": unknown.absoluteString]) }
    }

    func testMoveReplacesOnlyRegularFileAndKeepsSourceOnInvalidDestination() throws {
        let source = cache.appendingPathComponent("source")
        let target = documents.appendingPathComponent("attachments/target")
        try write(source, Data("incoming".utf8)); try write(target, Data("old".utf8))
        _ = try call(["op": "move", "uri": source.absoluteString, "to": target.absoluteString])
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(try read(target), Data("incoming".utf8))
        try write(source, Data("keep".utf8))
        let folder = cache.appendingPathComponent("folder", isDirectory: true)
        _ = try call(["op": "makeDirectory", "uri": folder.absoluteString])
        assertError(.unavailable) { _ = try self.call(["op": "move", "uri": source.absoluteString, "to": folder.absoluteString]) }
        assertError(.unavailable) { try self.write(folder, Data("invalid".utf8)) }
        XCTAssertEqual(try read(source), Data("keep".utf8))
    }

    func testRecreatedPortReadsSameLibraryAndRefusesAnotherLibrary() throws {
        let target = documents.appendingPathComponent("attachments/retained.bin")
        let bytes = Data("retained bytes".utf8)
        try write(target, bytes)
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        XCTAssertEqual(cold.directoriesJSON, files.directoriesJSON)
        XCTAssertEqual(try call(["op": "readBytes", "uri": target.absoluteString], on: cold).bytes, bytes)
        let otherRoot = root.appendingPathComponent("other-library", isDirectory: true)
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: false)
        let other = try NativeAttachmentFiles(libraryRoot: otherRoot)
        assertError(.invalidRequest) { _ = try self.call(["op": "readBytes", "uri": target.absoluteString], on: other) }
        assertError(.invalidRequest) { try other.deleteNow(target.absoluteString) }
        XCTAssertEqual(try read(target), bytes)
    }

    func testMalformedRequestsAreBoundedBeforeIO() throws {
        let uri = cache.appendingPathComponent("untouched").absoluteString
        for request: [String: Any] in [["op": "unknown"], ["op": "barrier", "uri": uri], ["op": "getInfo", "uri": uri, "extra": false],
                                       ["op": "writeBytes", "uri": uri], ["op": "copy", "uri": uri], ["op": "getInfo", "uri": true],
                                       ["op": "sha256", "base64": "", "uri": uri]] {
            assertError(.invalidRequest) { _ = try self.call(request) }
        }
        for raw in ["[]", "null", "{broken", "{\"op\":\"barrier\"}" + String(repeating: " ", count: 65536),
                    String(repeating: " ", count: 24 * 1024 * 1024 + 1)] {
            assertError(.invalidRequest) { _ = try self.files.call(raw) }
        }
        XCTAssertEqual(try names(cache), [])
    }

    func testInitializerRefusesLibraryAndNamespaceAncestorSymlinks() throws {
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let alias = root.appendingPathComponent("alias", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: outside)
        assertError(.unavailable) { _ = try NativeAttachmentFiles(libraryRoot: alias) }
        let descendant = alias.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: outside.appendingPathComponent("nested"), withIntermediateDirectories: false)
        assertError(.unavailable) { _ = try NativeAttachmentFiles(libraryRoot: descendant) }
        XCTAssertEqual(try names(outside), ["nested"])
        let owner = root.appendingPathComponent("attachment-files", isDirectory: true)
        let saved = root.appendingPathComponent("saved-owner", isDirectory: true)
        try FileManager.default.moveItem(at: owner, to: saved)
        try FileManager.default.createSymbolicLink(at: owner, withDestinationURL: outside)
        assertError(.unavailable) { _ = try NativeAttachmentFiles(libraryRoot: self.root) }
    }

    func testFrozenRootIdentityRefusesReplacementWithoutTreatingItAsMissing() throws {
        let saved = root.appendingPathComponent("saved-cache", isDirectory: true)
        try FileManager.default.moveItem(at: cache, to: saved)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: false)
        let sentinel = cache.appendingPathComponent("private-sentinel")
        try Data("untouched".utf8).write(to: sentinel)
        assertError(.unavailable) { _ = try self.call(["op": "getInfo", "uri": sentinel.absoluteString]) }
        assertError(.unavailable) { try self.write(sentinel, Data("replacement".utf8)) }
        assertError(.unavailable) { try self.files.deleteNow(sentinel.absoluteString) }
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("untouched".utf8))
    }

    #if DEBUG
    func testCopySourceMutationAfterOpenAndBeforePromotionKeepsOldTarget() throws {
        let source = cache.appendingPathComponent("source")
        let target = documents.appendingPathComponent("target")
        for phase in ["opened", "promotion"] {
            try write(source, Data("original source".utf8)); try write(target, Data("old target".utf8))
            let mutate = { try Data("changed source".utf8).write(to: source, options: []) }
            if phase == "opened" { files.afterSourceOpened = mutate } else { files.beforePublish = mutate }
            assertError(.unavailable) { _ = try self.call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString]) }
            files.afterSourceOpened = nil; files.beforePublish = nil
            XCTAssertEqual(try read(target), Data("old target".utf8))
            XCTAssertEqual(try names(documents), ["target"])
        }
    }

    func testNamedSourceReplacementBeforePublicationKeepsBothGenerationsAndTarget() throws {
        let source = cache.appendingPathComponent("source")
        let original = cache.appendingPathComponent("original")
        let target = documents.appendingPathComponent("target")
        try write(source, Data("original source".utf8)); try write(target, Data("old target".utf8))
        files.beforePublish = {
            try FileManager.default.moveItem(at: source, to: original)
            try Data("new source".utf8).write(to: source)
        }
        assertError(.unavailable) { _ = try self.call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString]) }
        files.beforePublish = nil
        XCTAssertEqual(try read(target), Data("old target".utf8))
        XCTAssertEqual(try read(source), Data("new source".utf8))
        XCTAssertEqual(try read(original), Data("original source".utf8))
        XCTAssertEqual(try names(documents), ["target"])
    }

    func testCancellationDuringStreamingAndImmediatelyBeforePublishKeepsOldTarget() throws {
        let (source, _, _) = try largeSource()
        let target = documents.appendingPathComponent("target")
        try write(target, Data("old target".utf8))
        var checks = 0
        XCTAssertThrowsError(try call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString], check: {
            checks += 1
            if checks == 4 { throw Cancelled.stopped }
        })) { XCTAssertTrue($0 is Cancelled) }
        XCTAssertEqual(try read(target), Data("old target".utf8))
        XCTAssertEqual(try names(documents), ["target"])
        var cancelled = false
        files.beforePublish = { cancelled = true }
        XCTAssertThrowsError(try call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString], check: {
            if cancelled { throw Cancelled.stopped }
        })) { XCTAssertTrue($0 is Cancelled) }
        files.beforePublish = nil
        XCTAssertEqual(try read(target), Data("old target".utf8))
        XCTAssertEqual(try names(documents), ["target"])
    }

    func testDestinationAncestorReplacementBeforePublishCannotWriteThroughLink() throws {
        let source = cache.appendingPathComponent("source")
        let folder = documents.appendingPathComponent("folder", isDirectory: true)
        let target = folder.appendingPathComponent("target")
        let displaced = documents.appendingPathComponent("displaced", isDirectory: true)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let sentinel = outside.appendingPathComponent("target")
        try Data("outside sentinel".utf8).write(to: sentinel)
        try write(source, Data("incoming".utf8)); try write(target, Data("old target".utf8))
        files.beforePublish = {
            try FileManager.default.moveItem(at: folder, to: displaced)
            try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: outside)
        }
        assertError(.unavailable) { _ = try self.call(["op": "copy", "uri": source.absoluteString, "to": target.absoluteString]) }
        files.beforePublish = nil
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("outside sentinel".utf8))
        XCTAssertEqual(try Data(contentsOf: displaced.appendingPathComponent("target")), Data("old target".utf8))
        XCTAssertEqual(try names(displaced), ["target"])
        XCTAssertEqual(try names(outside), ["target"])
    }

    func testWriteFaultAndCancellationNeverTruncateOldFileAndCleanOnlyOwnedStage() throws {
        let target = cache.appendingPathComponent("target")
        let peer = cache.appendingPathComponent(".mindwtr-native-file-peer.tmp")
        try write(target, Data("old target".utf8)); try write(peer, Data("unrelated stage".utf8))
        files.beforeStageSync = { throw NativeAttachmentFilesError.unavailable }
        assertError(.unavailable) { try self.write(target, Data("replacement".utf8)) }
        files.beforeStageSync = nil
        var cancelled = false
        files.beforePublish = { cancelled = true }
        XCTAssertThrowsError(try call(["op": "writeBytes", "uri": target.absoluteString, "base64": Data("replacement".utf8).base64EncodedString()], check: {
            if cancelled { throw Cancelled.stopped }
        }))
        files.beforePublish = nil
        XCTAssertEqual(try read(target), Data("old target".utf8))
        XCTAssertEqual(try read(peer), Data("unrelated stage".utf8))
        XCTAssertEqual(try names(cache), [peer.lastPathComponent, "target"])
    }

    func testCancellationCallbackCannotReplaceStageAfterPublicationProof() throws {
        for threshold in [1, 2] {
            let folder = cache.appendingPathComponent("callback-\(threshold)", isDirectory: true)
            let target = folder.appendingPathComponent("target")
            let retained = folder.appendingPathComponent("retained-original-stage")
            let requested = Data("requested bytes".utf8)
            let malicious = Data("untrusted replacement stage".utf8)
            try write(target, Data("old target".utf8))
            var armed = false, callbacks = 0, replaced = false
            files.beforePublish = { armed = true }
            var failure: Error?
            do {
                _ = try call(["op": "writeBytes", "uri": target.absoluteString, "base64": requested.base64EncodedString()], check: {
                    guard armed else { return }
                    callbacks += 1
                    if callbacks == threshold {
                        let stage = try XCTUnwrap(self.names(folder).first { $0.hasPrefix(".mindwtr-native-file-") })
                        let named = folder.appendingPathComponent(stage)
                        try FileManager.default.moveItem(at: named, to: retained)
                        try malicious.write(to: named)
                        replaced = true
                    }
                })
            } catch { failure = error }
            files.beforePublish = nil
            if replaced {
                XCTAssertEqual(failure as? NativeAttachmentFilesError, .unavailable)
                XCTAssertEqual(try read(target), Data("old target".utf8))
                XCTAssertEqual(try Data(contentsOf: retained), requested)

                let remaining = try XCTUnwrap(names(folder).first { $0.hasPrefix(".mindwtr-native-file-") })
                XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent(remaining)), malicious)
            } else {
                XCTAssertNil(failure)
                XCTAssertEqual(try read(target), requested)
                XCTAssertEqual(try names(folder), ["target"])
            }
        }
    }

    func testHashAndReadRejectChangedSourceInsteadOfReturningUnstableBytes() throws {
        let source = cache.appendingPathComponent("source")
        for op in ["sha256File", "readBytes", "readBytesRange"] {
            try write(source, Data("original".utf8))
            files.afterSourceOpened = { try Data("changed longer".utf8).write(to: source, options: []) }
            var request: [String: Any] = ["op": op, "uri": source.absoluteString]
            if op == "readBytesRange" { request["position"] = 0; request["length"] = 4 }
            assertError(.unavailable) { _ = try self.call(request) }
            files.afterSourceOpened = nil
        }
    }
    #endif

    func testUnreadableParentIsUnavailableNotMissingAndWriteLeavesTargetIntact() throws {
        if geteuid() == 0 { throw XCTSkip("Permission regression requires an unprivileged test account") }
        let folder = cache.appendingPathComponent("locked", isDirectory: true)
        let target = folder.appendingPathComponent("target")
        try write(target, Data("old".utf8))
        guard Darwin.chmod(folder.path, mode_t(0o000)) == 0 else { throw NativeAttachmentFilesError.unavailable }
        defer { _ = Darwin.chmod(folder.path, mode_t(0o700)) }
        assertError(.unavailable) { _ = try self.call(["op": "getInfo", "uri": target.absoluteString]) }
        assertError(.unavailable) { try self.write(target, Data("replacement".utf8)) }
        guard Darwin.chmod(folder.path, mode_t(0o700)) == 0 else { throw NativeAttachmentFilesError.unavailable }
        XCTAssertEqual(try read(target), Data("old".utf8))
        guard Darwin.chmod(folder.path, mode_t(0o500)) == 0 else { throw NativeAttachmentFilesError.unavailable }

        assertError(.unavailable) { try self.write(target, Data("replacement".utf8)) }
        XCTAssertEqual(try read(target), Data("old".utf8))
        XCTAssertEqual(try names(folder), ["target"])
    }
}
