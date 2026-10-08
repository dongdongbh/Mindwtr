import XCTest
import Foundation
import CryptoKit
import Darwin
import UniformTypeIdentifiers
import CryptoKit
@testable import MindwtrNativeCore
#if canImport(UIKit)
import UIKit
#endif

/// Controlled callbacks exercise the actual native load frame and descriptors.
/// Only the UIKit cases establish actual photo encoding/V3 producer behavior.
final class NativePhotoProviderHostTests: XCTestCase {
    private final class Provider: NSItemProvider, @unchecked Sendable {
        private let stateLock = NSLock()
        private var callback: ((URL?, Error?) -> Void)?
        let returnedProgress = Progress(totalUnitCount: 1)
        var requested: (() -> Void)?
        var synchronousURL: URL?
        var afterDelivery: (() -> Void)?
        private(set) var loads = 0
        override init() {
            super.init()
            registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
                done(nil, NativeAttachmentFilesError.unavailable); return nil
            }
        }
        override func loadFileRepresentation(forTypeIdentifier typeIdentifier: String,
                                             completionHandler: @escaping (URL?, Error?) -> Void) -> Progress {
            stateLock.lock(); loads += 1; callback = completionHandler; let url = synchronousURL; stateLock.unlock()
            requested?()
            if let url { completionHandler(url, nil); afterDelivery?() }
            return returnedProgress
        }
        func deliver(_ url: URL?, error: Error? = nil) {
            stateLock.lock(); let reply = callback; stateLock.unlock()
            reply?(url, error); afterDelivery?()
        }
    }
    private var root: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private let taskID = "photo-provider-task"
    private let at = "2026-10-06T12:00:00.000Z"
    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task283/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func source(_ bytes: Data = Data("borrowed callback bytes".utf8)) throws -> URL {
        let directory = root.appendingPathComponent("provider", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("Private.png"); try bytes.write(to: url); return url
    }
    private func entries() throws -> [URL] { try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil) }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture missing") }
        return "\(value.st_dev):\(value.st_ino)"
    }
    private func replace(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), previous = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained")); try bytes.write(to: url)
        XCTAssertNotEqual(try inode(url), previous)
    }
    private func expectRefusal(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }

    func testSynchronousCaptureFinishesBeforeBorrowedCallbackURLExpires() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        defer { jobs.shutdown() }
        let selected = try source(), bytes = try Data(contentsOf: selected), token = NativeAttachmentCancellation()
        let provider = Provider(); provider.synchronousURL = selected
        var callbackEnded = false, captures = 0, expiryFailure: Error?
        provider.afterDelivery = {
            callbackEnded = true
            do { try FileManager.default.removeItem(at: selected) } catch { expiryFailure = error }
        }
        let frame = NativeAttachmentPhotoLoadFrame { url in
            XCTAssertFalse(callbackEnded); captures += 1
            return try jobs.copyProviderSource(url, cancellation: token)
        }
        let receipt = try await frame.load(provider, typeIdentifier: UTType.png.identifier)
        XCTAssertEqual(captures, 1); XCTAssertEqual(provider.loads, 1); XCTAssertTrue(callbackEnded); XCTAssertNil(expiryFailure)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: receipt.sourceURI))), bytes)
        try jobs.requireProviderSource(receipt)
    }

    func testCancelBeforeLoadAndLateDuplicateCallbackDoNoIO() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source()
        let before = try Data(contentsOf: selected)
        var captures = 0
        let early = NativeAttachmentPhotoLoadFrame { url in captures += 1; return try files.copyProviderSource(url, checkCancellation: {}) }
        early.cancel(); let never = Provider()
        await expectRefusal { _ = try await early.load(never, typeIdentifier: UTType.png.identifier) }
        XCTAssertEqual(never.loads, 0)
        let waiting = NativeAttachmentPhotoLoadFrame { url in captures += 1; return try files.copyProviderSource(url, checkCancellation: {}) }
        let provider = Provider(), requested = expectation(description: "load requested")
        provider.requested = { requested.fulfill() }
        let task = Task { try await waiting.load(provider, typeIdentifier: UTType.png.identifier) }
        await fulfillment(of: [requested], timeout: 2)
        waiting.cancel()
        await expectRefusal { _ = try await task.value }
        XCTAssertTrue(provider.returnedProgress.isCancelled)
        provider.deliver(selected); provider.deliver(selected)
        XCTAssertEqual(captures, 0); XCTAssertTrue(try entries().isEmpty)
        XCTAssertEqual(try Data(contentsOf: selected), before)
    }

    func testCancelWhileCopyingStillDeliversExactCreatedReceiptOnce() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source(), bytes = try Data(contentsOf: selected)
        let provider = Provider(); provider.synchronousURL = selected
        var captures = 0, frame: NativeAttachmentPhotoLoadFrame!
        frame = NativeAttachmentPhotoLoadFrame { url in
            captures += 1
            let receipt = try files.copyProviderSource(url, checkCancellation: {})
            frame.cancel() // Creation succeeded; copying frame must retain the receipt.
            return receipt
        }
        let receipt = try await frame.load(provider, typeIdentifier: UTType.png.identifier)
        provider.deliver(selected)
        XCTAssertEqual(captures, 1); XCTAssertTrue(provider.returnedProgress.isCancelled)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: receipt.sourceURI))), bytes)
        XCTAssertEqual(try files.retireProviderSource(receipt, checkCancellation: {}), .removed)
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testLateCaptureAfterJobsShutdownRefusesWithoutCacheCreation() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        let selected = try source(), bytes = try Data(contentsOf: selected), token = NativeAttachmentCancellation()
        let frame = NativeAttachmentPhotoLoadFrame { url in try jobs.copyProviderSource(url, cancellation: token) }
        let provider = Provider(), requested = expectation(description: "awaiting provider")
        provider.requested = { requested.fulfill() }
        let task = Task { try await frame.load(provider, typeIdentifier: UTType.png.identifier) }
        await fulfillment(of: [requested], timeout: 2)
        jobs.shutdown(); provider.deliver(selected)
        await expectRefusal { _ = try await task.value }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testCancellationCallbacksRunOutsideRegistryAndTokenLocks() {
        let requests = NativeAttachmentLocalRequests(), token = NativeAttachmentCancellation(), id = UUID()
        var hits = 0
        token.setCancellationHandler { hits += 1; requests.remove(id); XCTAssertTrue(token.isCancelled) }
        requests.close(); requests.register(token, id: id)
        XCTAssertEqual(hits, 1)
        token.cancel(); XCTAssertEqual(hits, 1)
        token.setCancellationHandler(nil)
    }

    func testSparseOversizePhotoSourceRefusesBeforeReadDecodeOrOutput() throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), selected = try source(Data())
        let fd = Darwin.open(selected.path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(fd, 0); guard fd >= 0 else { return }; defer { Darwin.close(fd) }
        XCTAssertEqual(Darwin.ftruncate(fd, NativeAttachmentPhotoEncoder.maximumInputBytes + 1), 0)
        let identity = try inode(selected)
        let selection = NativeAttachmentPhotoSelection(loadType: UTType.png.identifier, preferredType: UTType.png.identifier, suggestedName: "Private")
        XCTAssertThrowsError(try files.copyPhotoProviderSource(selected, selection: selection, checkCancellation: {})) { error in
            guard case NativeAttachmentFilesError.providerTooLarge = error else { return XCTFail("Expected bounded size admission") }
        }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try inode(selected), identity)
        var current = stat(); XCTAssertEqual(lstat(selected.path, &current), 0)
        XCTAssertEqual(current.st_size, NativeAttachmentPhotoEncoder.maximumInputBytes + 1)
    }

    #if canImport(UIKit)
    private func core() throws -> CoreHost {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        let host = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func lastAdd() throws -> NativeAttachmentDraftStore.Operation {
        guard let entry = try store.readMixed()?.operations.last, case .add(let op) = entry else { throw HostFailure("Fixture Add missing") }; return op
    }
    private func imageBytes() throws -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 8)).image { context in
            UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 16, height: 8))
        }
        return try XCTUnwrap(image.pngData())
    }
    private func provider(_ url: URL) -> NSItemProvider {
        let item = NSItemProvider()
        item.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { done in
            done(url, false, nil); return Progress(totalUnitCount: 1)
        }
        item.suggestedName = "Private.photo.png"
        return item
    }
    private func seed(hooks: NativeAttachmentHostHooks? = nil) async throws -> (CoreHost, [String: Any]) {
        let boot = try core(); _ = try await boot.start(); await boot.close()
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,checklist,createdAt,updatedAt,rev,revBy) VALUES (?,'Photo task','inbox','[]','[]',NULL,NULL,?,?,1,'fixture')", [taskID, at, at])
        let host = try core(); if let hooks { try await host.configureAttachmentHost(hooks) }; _ = try await host.start()
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        try await host.checkpointEditorDraft(.init(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload))
        return (host, opening)
    }
    private func add(_ host: CoreHost, item: NSItemProvider, id: String = UUID().uuidString.lowercased(), historyVersion: Int = 3) async throws -> String {
        let snapshot = try latest()
        return try await historyVersion == 4 ? host.addPhotoProviderAttachmentV4(itemProvider: item, expectedSession: snapshot.sessionID,
            expectedGeneration: snapshot.generation, requestId: id) : host.addPhotoProviderAttachmentV3(itemProvider: item, expectedSession: snapshot.sessionID,
            expectedGeneration: snapshot.generation, requestId: id)
    }
    func testActualPhotoAddSaveAndColdOpenUseProcessedMetadataAndExactBytes() async throws {
        let (host, opening) = try await seed(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        let id = UUID().uuidString.lowercased(), reply = try object(await add(host, item: provider(selected), id: id)), op = try lastAdd()
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(op.requestId, id); XCTAssertEqual(op.phase, .checkpointed)
        let oracle = try XCTUnwrap(UIImage(data: bytes)?.pngData()), target = try XCTUnwrap(URL(string: op.targetURI))
        XCTAssertEqual(try Data(contentsOf: target), oracle); XCTAssertEqual(op.source.size, Int64(oracle.count))
        let picked = try XCTUnwrap(object(op.requestJSON)["picked"] as? [String: Any])
        XCTAssertEqual(picked["name"] as? String, "Private.photo.png.png"); XCTAssertEqual(picked["mimeType"] as? String, "image/png")
        XCTAssertEqual(picked["size"] as? Int, oracle.count); XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        let snapshot = try latest(), attachments = try XCTUnwrap(object(snapshot.payloadJSON)["attachments"] as? [[String: Any]])
        let save: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:], "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": attachments]]
        _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: json(save), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        await host.close(); let cold = try core(); _ = try await cold.start()
        let savedRows = try rows(), plan = try object(await cold.prepareTaskFileOpen(requestJSON: json(["owner": ["kind": "task", "taskId": taskID, "attachments": attachments], "attachmentId": id])))
        XCTAssertEqual(plan["status"] as? String, "available"); XCTAssertEqual((plan["open"] as? [String: Any])?["kind"] as? String, "image")
        XCTAssertEqual(try Data(contentsOf: target), oracle); XCTAssertEqual(try rows(), savedRows)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertTrue(log.contains("v1.3.5/ios-task-photo-add")); XCTAssertFalse(log.contains("Private.photo"))
    }
    func testProcessedPhotoInterruptedCompleteSaveRecoversColdExactlyOnceWithoutProvider() async throws {
        let bootstrap = try core(); _ = try await bootstrap.start(); await bootstrap.close()
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,checklist,createdAt,updatedAt,rev,revBy) VALUES ('unrelated-photo-save','Untouched','inbox','[]','[]',NULL,NULL,?,?,1,'fixture')", [at, at])
        let (host, opening) = try await seed(), initial = try latest(), savedTitle = "Photo recovery / 文"
        var payload = try object(initial.payloadJSON), raw = try XCTUnwrap(payload["raw"] as? [String: Any])
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any])
        payload["touchedBase"] = ["title": try XCTUnwrap(draft["title"])]; payload["edited"] = ["title": savedTitle]
        raw["title"] = savedTitle; payload["raw"] = raw
        try await host.checkpointEditorDraft(.init(sessionID: initial.sessionID, taskID: taskID,
            generation: initial.generation + 1, payloadJSON: json(payload)))
        let before = try rows(), unrelated = try json(NativeJSON.jsonObject(with:
            Data(sql("SELECT * FROM tasks WHERE id='unrelated-photo-save'").utf8)))
        let bytes = try imageBytes(), selected = try source(bytes), item = Provider(), addID = UUID().uuidString.lowercased()
        item.synchronousURL = selected; item.suggestedName = "Private.photo.png"
        _ = try await add(host, item: item, id: addID, historyVersion: 4)
        let added = try lastAdd(), snapshot = try latest(), target = try XCTUnwrap(URL(string: added.targetURI))
        let processed = try XCTUnwrap(UIImage(data: bytes)?.pngData()), targetIdentity = try inode(target)
        XCTAssertEqual(item.loads, 1); XCTAssertEqual(added.requestId, addID); XCTAssertEqual(added.phase, .checkpointed)
        XCTAssertEqual(try Data(contentsOf: target), processed); XCTAssertEqual(added.source.size, Int64(processed.count))
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: selected), bytes)
        let afterPayload = try object(snapshot.payloadJSON), attachments = try XCTUnwrap(afterPayload["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1); XCTAssertEqual(attachments[0]["id"] as? String, addID)
        let digest = SHA256.hash(data: processed).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(added.source.sha256, digest); XCTAssertEqual(try store.readMixed()?.version, 4)
        XCTAssertEqual(attachments[0]["fileHash"] as? String, digest)
        let frozenAdd = try object(added.preparedJSON)
        XCTAssertEqual(frozenAdd["version"] as? Int, 2); XCTAssertEqual(frozenAdd["sourceSha256"] as? String, digest)
        let requestID = UUID().uuidString.lowercased()
        let saveJSON = try json(["id": taskID, "requestId": requestID, "base": try XCTUnwrap(afterPayload["touchedBase"]),
            "patch": try XCTUnwrap(afterPayload["edited"]), "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": attachments]] as [String: Any])
        let ownerBytes = try Data(contentsOf: store.url), ownerIdentity = try inode(store.url)
        let hooks = AttachmentDraftHostHooks(); var terminalHits = 0
        hooks.boundary = { if $0 == .afterSaveTerminal { terminalHits += 1; throw HostFailure("Controlled photo Save terminal") } }
        await host.configureAttachmentDraftHost(hooks)
        var known: CoreHostAttachmentCleanupPending?
        do {
            _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: saveJSON,
                expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
            XCTFail("Expected saved photo with retained cleanup")
        } catch let pending as CoreHostAttachmentCleanupPending { known = pending }
        XCTAssertEqual(terminalHits, 1)
        let acknowledged = try object(XCTUnwrap(known).resultJSON), journal = database.appendingPathExtension("pending.json")
        let command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(command["method"] as? String, "attachmentFileEditSaveCommit")
        let argumentsJSON = try XCTUnwrap(command["argumentsJSON"] as? String)
        let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(argumentsJSON.utf8)) as? [String])
        XCTAssertEqual(arguments.count, 1)
        let wrapper = try object(XCTUnwrap(arguments.first)), envelope = try XCTUnwrap(wrapper["envelope"] as? [String: Any])
        XCTAssertEqual(wrapper["version"] as? Int, 4)
        let frozenRequest = try XCTUnwrap(envelope["request"] as? [String: Any])
        XCTAssertEqual(try json(XCTUnwrap(frozenRequest["saveRequest"])), saveJSON)
        let lineage = try XCTUnwrap(frozenRequest["ownedDraft"] as? [String: Any])
        let operations = try XCTUnwrap(lineage["priorOperations"] as? [[String: Any]])
        XCTAssertEqual(operations.count, 1); XCTAssertEqual(operations[0]["kind"] as? String, "add")
        XCTAssertEqual((operations[0]["operation"] as? [String: Any])?["requestId"] as? String, addID)
        let terminal = try XCTUnwrap(command["terminal"] as? [String: Any])
        let state = try object(XCTUnwrap((terminal["success"] as? [String: Any])?["_0"] as? String))
        XCTAssertEqual(state["phase"] as? String, "domainSaved")
        XCTAssertEqual(try json(object(XCTUnwrap(state["resultJSON"] as? String))), try json(acknowledged))
        XCTAssertEqual(try editor.read()?.snapshot, snapshot)
        XCTAssertEqual(try editor.read()?.attempt?.argumentsJSON, try json([saveJSON]))
        XCTAssertEqual(try lastAdd(), added); XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes)
        XCTAssertEqual(try inode(store.url), ownerIdentity); XCTAssertEqual(try inode(target), targetIdentity)
        let frozenEditor = try Data(contentsOf: editor.url), editorIdentity = try inode(editor.url), savedRows = try rows()
        XCTAssertNotEqual(savedRows, before)
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        let decision = try XCTUnwrap(prepared["decision"] as? [String: Any]); XCTAssertEqual(decision["kind"] as? String, "changed")
        let effect = try XCTUnwrap((decision["prepared"] as? [String: Any])?["effect"] as? [String: Any])
        let effects = try XCTUnwrap(effect["tasks"] as? [[String: Any]]); XCTAssertEqual(effects.count, 1)
        let after = try XCTUnwrap(effects[0]["after"] as? [String: Any])
        XCTAssertEqual(after["id"] as? String, taskID); XCTAssertEqual(after["title"] as? String, savedTitle)
        XCTAssertEqual(try json(XCTUnwrap(after["attachments"])), try json(attachments))
        let saved = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(saved["title"] as? String, savedTitle); XCTAssertEqual(saved["rev"] as? Int, 2)
        XCTAssertEqual(saved["rev"] as? Int, after["rev"] as? Int)
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(saved["attachments"] as? String).utf8))), try json(attachments))
        XCTAssertEqual(try json(NativeJSON.jsonObject(with:
            Data(sql("SELECT * FROM tasks WHERE id='unrelated-photo-save'").utf8))), unrelated)
        XCTAssertEqual(acknowledged["id"] as? String, taskID)
        XCTAssertEqual((acknowledged["draft"] as? [String: Any])?["title"] as? String, savedTitle)
        try FileManager.default.removeItem(at: selected); await host.close()
        let originalBundle = try XCTUnwrap(ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"])
        let probe = root.appendingPathComponent("photo-save-recovery-core-host.js")
        try (String(contentsOfFile: originalBundle, encoding: .utf8)
            + "\n;(()=>{for(const name of ['attachmentFileEditSavePrepare','attachmentDraftPrepareV3','attachmentDraftPrepareV4']){if(typeof MindwtrHost[name]!=='function')throw Error('Missing recovery fixture method');MindwtrHost[name]=function(){throw Error('Terminal photo recovery must not prepare');};}})();\n")
            .write(to: probe, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(); var taskWrites = 0
        faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) {
                taskWrites += 1; throw HostFailure("Terminal photo recovery must not write tasks")
            }
        }
        let cold = CoreHost(databaseURL: database, bundleURL: probe, faults: faults)
        addTeardownBlock { await cold.close() }
        let recoveryHooks = AttachmentDraftHostHooks(); var detachHits = 0
        recoveryHooks.boundary = { if $0 == .beforeSaveEditorDetach {
            detachHits += 1
            XCTAssertEqual(try self.lastAdd(), added)
            XCTAssertEqual(try Data(contentsOf: self.store.url), ownerBytes); XCTAssertEqual(try self.inode(self.store.url), ownerIdentity)
            XCTAssertEqual(try Data(contentsOf: self.editor.url), frozenEditor); XCTAssertEqual(try self.inode(self.editor.url), editorIdentity)
            let actual = try self.object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
            XCTAssertEqual(actual["argumentsJSON"] as? String, argumentsJSON)
        } }
        await cold.configureAttachmentDraftHost(recoveryHooks)
        let startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(detachHits, 1); XCTAssertEqual(Set(recovery.keys), Set(["method", "result"]))
        XCTAssertEqual(recovery["method"] as? String, "attachmentFileEditSaveCommit")
        XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), try json(acknowledged))
        XCTAssertEqual(taskWrites, 0); XCTAssertEqual(item.loads, 1); XCTAssertEqual(try rows(), savedRows)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path)); XCTAssertEqual(try Data(contentsOf: target), processed)
        XCTAssertEqual(try inode(target), targetIdentity); XCTAssertTrue(try entries().isEmpty)
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.readMixed()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let plan = try object(await cold.prepareTaskFileOpen(requestJSON: json([
            "owner": ["kind": "task", "taskId": taskID, "attachments": attachments], "attachmentId": addID])))
        XCTAssertEqual(plan["status"] as? String, "available"); XCTAssertEqual((plan["open"] as? [String: Any])?["kind"] as? String, "image")
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try Data(contentsOf: target), processed)
        await cold.close(); let clean = try core(); let ordinary = try object(await clean.start())
        XCTAssertNil(ordinary["recovery"]); XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(item.loads, 1)
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.readMixed()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testWaitingPhotoBlocksConflictingOwnersAndCancelPreservesProtectedEditor() async throws {
        let (host, opening) = try await seed(), snapshot = try latest(), rowsBefore = try rows(), selected = try source(imageBytes())
        let controlled = Provider(), requested = expectation(description: "photo is awaiting selection bytes")
        controlled.requested = { requested.fulfill() }
        let requestID = UUID().uuidString.lowercased()
        let operation = Task { try await host.addPhotoProviderAttachmentV3(itemProvider: controlled,
            expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation, requestId: requestID) }
        await fulfillment(of: [requested], timeout: 2)
        let ownerBytes = try Data(contentsOf: store.url), editorBytes = try Data(contentsOf: editor.url)
        let ownerIdentity = try inode(store.url), editorIdentity = try inode(editor.url)
        XCTAssertEqual(try store.readMixed()?.operations.count, 0)
        await expectRefusal { try await host.checkpointEditorDraft(snapshot) }
        await expectRefusal { _ = try await host.recoverAttachmentDraftV3(expectedSession: snapshot.sessionID) }
        await expectRefusal { _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        let validSave: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]), "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": []]]
        let validDiscard = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": snapshot.sessionID, "generation": snapshot.generation])
        await expectRefusal { _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: self.json(validSave), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        await expectRefusal { _ = try await host.discardAttachmentDraftV3(requestJSON: validDiscard) }
        operation.cancel(); await expectRefusal { _ = try await operation.value }
        controlled.deliver(selected); controlled.deliver(selected)
        XCTAssertTrue(controlled.returnedProgress.isCancelled)
        XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try inode(store.url), ownerIdentity); XCTAssertEqual(try inode(editor.url), editorIdentity)
        XCTAssertEqual(try rows(), rowsBefore); XCTAssertTrue(try entries().isEmpty)
        _ = try await host.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        _ = try await add(host, item: provider(selected))
        XCTAssertEqual(try lastAdd().phase, .checkpointed)
    }

    func testProviderFailureAndMalformedAdmissionNeverCreateAnAdd() async throws {
        let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), selected = try source(imageBytes())
        let invalid = Provider()
        for (session, generation, request) in [(snapshot.sessionID, snapshot.generation, "not-a-uuid"),
            (snapshot.sessionID, snapshot.generation + 1, UUID().uuidString.lowercased()),
            (UUID().uuidString.lowercased(), snapshot.generation, UUID().uuidString.lowercased())] {
            await expectRefusal { _ = try await host.addPhotoProviderAttachmentV3(itemProvider: invalid,
                expectedSession: session, expectedGeneration: generation, requestId: request) }
        }
        XCTAssertEqual(invalid.loads, 0); XCTAssertNil(try store.readVersioned())
        let controlled = Provider(), requested = expectation(description: "provider load")
        controlled.requested = { requested.fulfill() }
        let operation = Task { try await self.add(host, item: controlled) }
        await fulfillment(of: [requested], timeout: 2)
        controlled.deliver(nil, error: NSError(domain: "private-provider", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Private failure file:///private/secret.png"]))
        await expectRefusal { _ = try await operation.value }
        XCTAssertEqual(try store.readMixed()?.operations.count, 0); XCTAssertEqual(try latest(), snapshot)
        XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        _ = try await add(host, item: provider(selected))
    }

    func testSameByteEditorOrOwnerReplacementDuringLoadRefusesAddAndKeepsCreationReceipt() async throws {
        let outer = try XCTUnwrap(root)
        for ownerFile in [false, true] {
            root = outer.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { root = outer }
            let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
            let controlled = Provider(), requested = expectation(description: "provider awaiting owner")
            controlled.requested = { requested.fulfill() }
            let operation = Task { try await self.add(host, item: controlled) }
            await fulfillment(of: [requested], timeout: 2)
            let file = ownerFile ? store.url : editor.url
            try replace(file); let replacementBytes = try Data(contentsOf: file), replacementIdentity = try inode(file)
            controlled.deliver(selected)
            await expectRefusal { _ = try await operation.value }
            XCTAssertEqual(try store.readMixed()?.operations.count, 0); XCTAssertEqual(try latest(), snapshot)
            XCTAssertEqual(try Data(contentsOf: file), replacementBytes); XCTAssertEqual(try inode(file), replacementIdentity)
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try entries().count, 1)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(entries().first)), try XCTUnwrap(UIImage(data: bytes)?.pngData()))
            XCTAssertEqual(try Data(contentsOf: selected), bytes); await host.close()
        }
    }

    func testHostCloseCancelsAwaitingPhotoAndLateDeliveryNeverCopies() async throws {
        let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), selected = try source(imageBytes())
        let controlled = Provider(), requested = expectation(description: "provider waiting before close")
        controlled.requested = { requested.fulfill() }
        let operation = Task { try await self.add(host, item: controlled) }
        await fulfillment(of: [requested], timeout: 2)
        let ownerBytes = try Data(contentsOf: store.url), editorBytes = try Data(contentsOf: editor.url)
        await host.close(); await expectRefusal { _ = try await operation.value }
        controlled.deliver(selected)
        XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        let cold = try core(); _ = try await cold.start()
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
    }

    func testCancellationWhileEncodedOutputIsBeingFilledRemovesOnlyCreationAndDoesNotAdd() async throws {
        let hooks = NativeAttachmentHostHooks()
        var operation: Task<String, Error>?, reached = false
        hooks.configureJobs = { jobs in jobs.beforeStageSync = { reached = true; operation?.cancel() } }
        let (host, _) = try await seed(hooks: hooks), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        operation = Task { try await self.add(host, item: provider(selected)) }
        await expectRefusal { _ = try await XCTUnwrap(operation).value }
        XCTAssertTrue(reached); XCTAssertEqual(try store.readMixed()?.operations.count, 0)
        XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try rows(), before); XCTAssertTrue(try entries().isEmpty)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testInterruptedProcessedPhotoRecoversColdWithOriginalUUIDWithoutProviderReload() async throws {
        let outer = try XCTUnwrap(root)
        for boundary in [AttachmentDraftBoundary.afterIntent, .afterFilled] {
            root = outer.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { root = outer }
            let (host, _) = try await seed(), snapshot = try latest(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
            let hooks = AttachmentDraftHostHooks(); var fired = false
            hooks.boundary = { if $0 == boundary { fired = true; throw HostFailure("Controlled photo interruption") } }
            await host.configureAttachmentDraftHost(hooks)
            let item = provider(selected), requestID = UUID().uuidString.lowercased()
            await expectRefusal { _ = try await self.add(host, item: item, id: requestID) }
            XCTAssertTrue(fired)
            let pending = try lastAdd(), scratch = try XCTUnwrap(URL(string: pending.source.sourceURI)), processed = try Data(contentsOf: scratch)
            XCTAssertEqual(pending.requestId, requestID); XCTAssertEqual(pending.phase, boundary == .afterIntent ? .intent : .stageFilled)
            XCTAssertEqual(processed, try XCTUnwrap(UIImage(data: bytes)?.pngData())); XCTAssertEqual(try latest(), snapshot)
            let log = root.appendingPathComponent("logs/mindwtr.log")
            if FileManager.default.fileExists(atPath: log.path) {
                XCTAssertFalse(try String(contentsOf: log).contains("v1.3.5/ios-task-photo-add"))
            }
            try FileManager.default.removeItem(at: selected)
            await host.close(); let cold = try core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: snapshot.sessionID)
            let completed = try lastAdd()
            XCTAssertEqual(completed.requestId, requestID); XCTAssertEqual(completed.phase, .checkpointed)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: completed.targetURI))), processed)
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path)); await cold.close()
        }
    }

    func testProcessedPhotoDiscardRetiresTargetAndPreservesBorrowedSourceAndTask() async throws {
        let (host, _) = try await seed(), before = try rows(), bytes = try imageBytes(), selected = try source(bytes)
        _ = try await add(host, item: provider(selected))
        let op = try lastAdd(), target = try XCTUnwrap(URL(string: op.targetURI)), snapshot = try latest(), discardID = UUID().uuidString.lowercased()
        let result = try object(await host.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID, "sessionID": snapshot.sessionID, "generation": snapshot.generation])))
        XCTAssertEqual(result["status"] as? String, "cleanupPending")
        _ = try await host.finishAttachmentDraftDiscardV3(expectedSession: snapshot.sessionID, requestId: discardID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertNil(try store.readVersioned()); XCTAssertNil(try editor.read())
        XCTAssertEqual(try Data(contentsOf: selected), bytes); XCTAssertEqual(try rows(), before)
    }
    #endif
}
