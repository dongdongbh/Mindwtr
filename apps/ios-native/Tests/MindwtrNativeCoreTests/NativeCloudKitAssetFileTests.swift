import XCTest
import Foundation
import CryptoKit
@testable import MindwtrNativeCore

final class NativeCloudKitAssetFileTests: XCTestCase {
    private var root: URL!
    private var jobs: NativeAttachmentFileJobs!
    private var documents: URL!
    private var cache: URL!
    private let token = NativeAttachmentCancellation()

    override func setUpWithError() throws {
        let temporary = try XCTUnwrap(ProcessInfo.processInfo.environment["TMPDIR"])
        root = URL(fileURLWithPath: temporary).resolvingSymlinksInPath()
            .appendingPathComponent("cloudkit-files-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let directories = try XCTUnwrap(NativeJSON.jsonObject(with: Data(jobs.directoriesJSON.utf8)) as? [String: String])
        documents = try XCTUnwrap(URL(string: XCTUnwrap(directories["document"])))
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"])))
        try FileManager.default.createDirectory(at: documents.appendingPathComponent("attachments"), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        jobs?.shutdown()
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func retire(_ receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt) throws {
        _ = try jobs.retireProviderSource(receipt, requireOwner: {})
    }

    func testUploadFreezesExactBytesAndRejectsOutsideLibraryOrStaleHash() throws {
        let bytes = Data("original attachment".utf8)
        let source = documents.appendingPathComponent("attachments/task.txt")
        try bytes.write(to: source)
        let receipt = try jobs.prepareCloudKitUpload(source.absoluteString, expectedHash: digest(bytes),
            expectedSize: Int64(bytes.count), cancellation: token)
        defer { try? retire(receipt) }
        try Data("later edit".utf8).write(to: source)
        try jobs.requireProviderSource(receipt)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: receipt.sourceURI))), bytes)
        XCTAssertThrowsError(try jobs.prepareCloudKitUpload(source.absoluteString, expectedHash: digest(bytes),
            expectedSize: nil, cancellation: token))
        let outside = root.appendingPathComponent("outside.txt")
        try bytes.write(to: outside)
        XCTAssertThrowsError(try jobs.prepareCloudKitUpload(outside.absoluteString, expectedHash: nil,
            expectedSize: nil, cancellation: token))
        let alias = documents.appendingPathComponent("attachments/alias.txt")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: source)
        XCTAssertThrowsError(try jobs.prepareCloudKitUpload(alias.absoluteString, expectedHash: nil,
            expectedSize: nil, cancellation: token))
    }

    func testSDKSourceCanOnlyFillFreshDownloadScratch() throws {
        let bytes = Data("download bytes".utf8), provider = root.appendingPathComponent("sdk-asset")
        try bytes.write(to: provider)
        let receipt = try jobs.copyProviderSource(provider, cancellation: token)
        defer { try? retire(receipt) }
        let target = documents.appendingPathComponent("attachments/.mindwtr-download-100-1-abcd-task.staged")
        try jobs.stageCloudKitSource(receipt, targetURI: target.absoluteString, cancellation: token)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertThrowsError(try jobs.stageCloudKitSource(receipt, targetURI: target.absoluteString, cancellation: token))
        let canonical = documents.appendingPathComponent("attachments/task.txt")
        let original = Data("keep canonical".utf8); try original.write(to: canonical)
        XCTAssertThrowsError(try jobs.stageCloudKitSource(receipt, targetURI: canonical.absoluteString, cancellation: token))
        XCTAssertEqual(try Data(contentsOf: canonical), original)
        let outside = cache.appendingPathComponent(target.lastPathComponent)
        XCTAssertThrowsError(try jobs.stageCloudKitSource(receipt, targetURI: outside.absoluteString, cancellation: token))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
    }

    func testChangedReceiptAndCancellationCannotPublishScratch() throws {
        let provider = root.appendingPathComponent("sdk-asset")
        try Data("download".utf8).write(to: provider)
        let receipt = try jobs.copyProviderSource(provider, cancellation: token)
        let owned = try XCTUnwrap(URL(string: receipt.sourceURI))
        try Data("changed receipt".utf8).write(to: owned)
        let target = documents.appendingPathComponent("attachments/.mindwtr-download-100-1-abcd-task.staged")
        XCTAssertThrowsError(try jobs.stageCloudKitSource(receipt, targetURI: target.absoluteString, cancellation: token))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let fresh = try jobs.copyProviderSource(provider, cancellation: token)
        defer { try? retire(fresh) }
        token.cancel()
        XCTAssertThrowsError(try jobs.stageCloudKitSource(fresh, targetURI: target.absoluteString, cancellation: token))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}
