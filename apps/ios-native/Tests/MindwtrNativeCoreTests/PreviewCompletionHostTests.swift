import XCTest
import SQLite3
@testable import MindwtrNativeCore

final class PreviewCompletionHostTests: XCTestCase {
    private var directory: URL!
    private var bundle: URL!
    private var database: URL { directory.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build the current core bundle first") }
        bundle = URL(fileURLWithPath: path)
        directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/preview-completion/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let directory { try FileManager.default.removeItem(at: directory) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await value.close() }
        return value
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func rows() throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT * FROM tasks ORDER BY id", parametersJSON: "[]").utf8)) as? [[String: Any]])
    }
    private func prepare(_ core: CoreHost) async throws -> (id: String, snapshot: EditorDraftSnapshot, arguments: String) {
        let id = UUID().uuidString.lowercased()
        let capture = try object(await core.call("captureOpen"))
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Original Preview task", "options": try XCTUnwrap(capture["options"]), "captureId": id, "openAfterSave": false])]))
        let opening = try object(await core.call("editorModel", argumentsJSON: json([id])))
        let original = try XCTUnwrap(opening["draft"] as? [String: Any])
        let recurring = try object(await core.call("editDraft", argumentsJSON: json([json(["id": id, "draft": original, "edit": ["type": "recurrence", "edit": ["kind": "rule", "rule": "weekly"]]])])))
        let appended = try object(await core.call("checklistEdit", argumentsJSON: json([json(["id": id, "draft": try XCTUnwrap(recurring["draft"]), "checklist": [], "edit": ["kind": "append", "title": "Pending checklist input"]])])))
        let checklist = try XCTUnwrap(appended["checklist"] as? [[String: Any]])
        let edited = try object(await core.call("editDraft", argumentsJSON: json([json(["id": id, "draft": try XCTUnwrap(appended["draft"]), "checklist": checklist,
            "edit": ["type": "fields", "patch": ["status": "done", "title": "Edited Preview title", "description": "Edited Preview notes", "contexts": "@home", "tags": "#edited"]]])])))
        let changed = try XCTUnwrap(edited["draft"] as? [String: Any])
        let fields = ["title", "description", "contexts", "tags", "status", "recurrence", "recurrenceStrategy", "recurrenceRRule", "showFutureRecurrence", "preserveChecklistOnRepeat"]
        var base: [String: Any] = [:], patch: [String: Any] = [:]
        for field in fields where try json([original[field] ?? NSNull()]) != json([changed[field] ?? NSNull()]) {
            base[field] = original[field] ?? NSNull(); patch[field] = changed[field] ?? NSNull()
        }
        for field in ["recurrence", "recurrenceStrategy", "recurrenceRRule", "showFutureRecurrence", "preserveChecklistOnRepeat"] {
            base[field] = try XCTUnwrap(original[field]); patch[field] = try XCTUnwrap(changed[field])
        }
        let link: [String: Any] = ["id": "550e8400-e29b-41d4-a716-446655440099", "kind": "link", "title": "Reference", "uri": "https://example.com/preview", "createdAt": "2026-11-10T12:00:00.000Z", "updatedAt": "2026-11-10T12:00:00.000Z"]
        let request = try json(["id": id, "requestId": UUID().uuidString.lowercased(), "base": base, "patch": patch,
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]), "recurrenceBase": try XCTUnwrap(opening["recurrenceBase"]),
            "checklist": ["base": [], "value": checklist], "attachments": ["base": [], "value": [link]]])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id, generation: 1,
            payloadJSON: try json(["raw": ["title": "Edited Preview title", "description": "Edited Preview notes"], "checklist": checklist]))
        try await core.checkpointEditorDraft(snapshot)
        return (id, snapshot, try json([request]))
    }
    private func assertCompleted(_ id: String) throws {
        let saved = try rows()
        XCTAssertEqual(saved.count, 2)
        let source = try XCTUnwrap(saved.first { $0["id"] as? String == id })
        XCTAssertEqual(source["status"] as? String, "done")
        XCTAssertEqual(source["title"] as? String, "Edited Preview title")
        XCTAssertEqual(source["description"] as? String, "Edited Preview notes")
        let checklist = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(source["checklist"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(checklist.count, 1); XCTAssertEqual(checklist[0]["title"] as? String, "Pending checklist input")
        XCTAssertEqual(checklist[0]["isCompleted"] as? Bool, false)
        let links = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(source["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(links.count, 1); XCTAssertEqual(links[0]["id"] as? String, "550e8400-e29b-41d4-a716-446655440099")
        let next = try XCTUnwrap(saved.first { $0["id"] as? String != id })
        XCTAssertEqual(next["title"] as? String, "Edited Preview title")
        XCTAssertEqual(next["description"] as? String, "Edited Preview notes")
        XCTAssertNotEqual(next["status"] as? String, "done")
        let recurrence = try object(XCTUnwrap(next["recurrence"] as? String))
        XCTAssertEqual(recurrence["rule"] as? String, "weekly")
        XCTAssertEqual(recurrence["seriesId"] as? String, id)
        let nextChecklist = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(next["checklist"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(nextChecklist.count, 1)
        XCTAssertEqual(nextChecklist[0]["title"] as? String, "Pending checklist input")
        XCTAssertEqual(nextChecklist[0]["isCompleted"] as? Bool, false)
        XCTAssertNotEqual(nextChecklist[0]["id"] as? String, checklist[0]["id"] as? String)
        let nextLinks = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(next["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(nextLinks.count, 1)
        XCTAssertEqual(nextLinks[0]["uri"] as? String, "https://example.com/preview")
        XCTAssertNotEqual(nextLinks[0]["id"] as? String, links[0]["id"] as? String)
    }

    private func request(_ arguments: String, method: String, value: Any? = nil, legacy: Bool = false) throws -> String {
        let args = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String])
        var input = try object(XCTUnwrap(args.first))
        var base = try XCTUnwrap(input["base"] as? [String: Any]), patch = try XCTUnwrap(input["patch"] as? [String: Any])
        if legacy { base.removeValue(forKey: "preserveChecklistOnRepeat"); patch.removeValue(forKey: "preserveChecklistOnRepeat") }
        else if let value { patch["preserveChecklistOnRepeat"] = value }
        if method == "saveDraft" {
            for field in ["status", "focusedToday", "completedAt"] { base.removeValue(forKey: field); patch.removeValue(forKey: field) }
            input.removeValue(forKey: "checklist"); input.removeValue(forKey: "requestId")
        }
        input["base"] = base; input["patch"] = patch
        return try json([json(input)])
    }

    func testRecurrencePolicyAcceptsTrueFalseAndLegacyFourFieldClients() async throws {
        let writing = host(); _ = try await writing.start()
        for method in ["saveDraft", "checklistSave"] {
            for policy in ["true", "false", "legacy"] {
                let prepared = try await prepare(writing)
                _ = try await writing.saveEditorDraft(method,
                    argumentsJSON: request(prepared.arguments, method: method, value: policy == "true", legacy: policy == "legacy"),
                    expectedSession: prepared.snapshot.sessionID, expectedGeneration: 1)
                let source = try XCTUnwrap(rows().first { $0["id"] as? String == prepared.id })
                let recurrence = try object(XCTUnwrap(source["recurrence"] as? String))
                XCTAssertEqual(recurrence["rule"] as? String, "weekly")
                XCTAssertEqual(recurrence["preserveChecklistOnRepeat"] as? Bool, policy == "true" ? true : nil)
                XCTAssertEqual(source["status"] as? String, method == "checklistSave" ? "done" : "inbox")
            }
        }
    }

    func testRecurrencePolicyRejectsNullNonBooleanAndUnknownFieldsWithoutMutation() async throws {
        let writing = host(); _ = try await writing.start()
        let prepared = try await prepare(writing)
        let before = try json(rows())
        for method in ["saveDraft", "checklistSave"] {
            for invalid: Any in [NSNull(), 1, "true", [], ["value": true]] {
                do {
                    _ = try await writing.saveEditorDraft(method, argumentsJSON: request(prepared.arguments, method: method, value: invalid),
                        expectedSession: prepared.snapshot.sessionID, expectedGeneration: 1)
                    XCTFail("Expected invalid recurrence policy refusal")
                } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT"), error.localizedDescription) }
                XCTAssertEqual(try json(rows()), before)
                XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, prepared.snapshot)
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
            let args = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(request(prepared.arguments, method: method).utf8)) as? [String])
            var input = try object(XCTUnwrap(args.first))
            var base = try XCTUnwrap(input["base"] as? [String: Any]), patch = try XCTUnwrap(input["patch"] as? [String: Any])
            base["unknownPolicy"] = false; patch["unknownPolicy"] = true; input["base"] = base; input["patch"] = patch
            do {
                _ = try await writing.saveEditorDraft(method, argumentsJSON: json([json(input)]), expectedSession: prepared.snapshot.sessionID, expectedGeneration: 1)
                XCTFail("Expected unknown field refusal")
            } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT"), error.localizedDescription) }
            XCTAssertEqual(try json(rows()), before)
        }
    }

    func testFailedCompletionKeepsExactDraftAndColdRecoveryCreatesOneEditedSuccessor() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let prepared = try await prepare(writing)
        let before = try json(rows())
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Preview COMMIT failure") } }
        do {
            _ = try await writing.saveEditorDraft("checklistSave", argumentsJSON: prepared.arguments, expectedSession: prepared.snapshot.sessionID, expectedGeneration: 1)
            XCTFail("Expected failed completion")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(rows()), before)
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, prepared.snapshot)
        let frozen = try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal)))
        do { _ = try await writing.retryPending(); XCTFail("Expected repeated failure") } catch {}
        XCTAssertEqual(try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal))), frozen)
        await writing.close()
        let recovered = host(); _ = try await recovered.start()
        try assertCompleted(prepared.id)
        let completed = try json(rows())
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(rows()), completed)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostCompletionAcknowledgementReplaysWithoutAnotherSuccessorOrRevision() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let prepared = try await prepare(writing)
        var journalWrites = 0
        faults.journalWrite = { journalWrites += 1; if journalWrites == 2 { throw HostFailure("Injected Preview terminal loss") } }
        do {
            _ = try await writing.saveEditorDraft("checklistSave", argumentsJSON: prepared.arguments, expectedSession: prepared.snapshot.sessionID, expectedGeneration: 1)
            XCTFail("Expected lost acknowledgement")
        } catch { XCTAssertTrue(error.localizedDescription.contains("terminal loss"), error.localizedDescription) }
        try assertCompleted(prepared.id)
        let completed = try json(rows())
        faults.journalWrite = {}
        _ = try await writing.retryPending()
        XCTAssertEqual(try json(rows()), completed)
        await writing.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(rows()), completed)
    }
}
