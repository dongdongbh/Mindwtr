import Foundation
import AttachmentFileInstallerEngine

enum NativeAttachmentInstallerError: LocalizedError, Equatable {
    case invalidRequest, unavailable

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Attachment installer request is invalid"
        case .unavailable: return "Attachment file operation is unavailable"
        }
    }
}

/// The native file bridge's install/hash boundary. Storage roots come from the
/// library owner, never from a JS request. RN's existing Apple engine owns file
/// identity, locking, streaming hashes, and interrupted-install recovery.
/// Calls must be serialized by the file-port owner, outside the JS engine queue.
final class NativeAttachmentInstaller {
    private let managedRoot: URL
    private let sourceRoots: [URL]
    private let candidateFiles: NativeAttachmentFiles?
    private var installer: AttachmentFileInstaller {
        get throws {
            // A missing root can canonicalize differently once the existing
            // owned ensure creates it. RN binds its stateless facade per call.
            do { return try AttachmentFileInstaller(targetRoot: managedRoot, sourceRoots: sourceRoots) }
            catch { throw NativeAttachmentInstallerError.unavailable }
        }
    }

    init(managedRoot: URL, sourceRoots: [URL], filePort: NativeAttachmentFiles? = nil) throws {
        self.managedRoot = managedRoot
        self.sourceRoots = sourceRoots
        candidateFiles = filePort?.isRNCandidate == true ? filePort : nil
        if let candidateFiles {
            guard managedRoot == candidateFiles.managedRoot,
                  !sourceRoots.isEmpty, sourceRoots.allSatisfy({ candidateFiles.sourceRoots.contains($0) }) else {
                throw NativeAttachmentInstallerError.invalidRequest
            }
        }
        do {
            _ = try AttachmentFileInstaller(targetRoot: managedRoot, sourceRoots: sourceRoots)
        } catch {
            throw NativeAttachmentInstallerError.unavailable
        }
    }

    func handle(_ json: String) throws -> String {
        guard json.utf8.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let request = object as? [String: Any],
              let operation = request["op"] as? String else {
            throw NativeAttachmentInstallerError.invalidRequest
        }
        let response: [String: Any]
        switch operation {
        case "install":
            guard Set(request.keys) == Set(["op", "staged", "target", "expected", "expectedDownloadSha256"]),
                  let rawExpected = request["expected"] as? [String: Any],
                  let kind = rawExpected["kind"] as? String else {
                throw NativeAttachmentInstallerError.invalidRequest
            }
            let expected: ExpectedAttachmentGeneration
            switch kind {
            case "absent":
                guard Set(rawExpected.keys) == Set(["kind"]) else { throw NativeAttachmentInstallerError.invalidRequest }
                expected = .absent
            case "present":
                guard Set(rawExpected.keys) == Set(["kind", "sha256"]) else { throw NativeAttachmentInstallerError.invalidRequest }
                expected = .present(sha256: try digest(rawExpected["sha256"]))
            default: throw NativeAttachmentInstallerError.invalidRequest
            }
            let staged = try fileURL(request["staged"])
            let target = try fileURL(request["target"])
            let downloadDigest = try digest(request["expectedDownloadSha256"])
            do {
                let outcome: AttachmentInstallOutcome
                if let candidateFiles {
                    let staged = URL(fileURLWithPath: try NativeAttachmentFiles.filePath(staged.absoluteString))
                    let target = URL(fileURLWithPath: try NativeAttachmentFiles.filePath(target.absoluteString))
                    outcome = try candidateFiles.withCandidateManagedDirectory { directory, check in
                        try installer.install(stagedInput: staged, targetInput: target, expected: expected,
                            expectedDownloadSha256: downloadDigest, directoryDescriptor: directory, requireAuthority: check)
                    }
                } else {
                    outcome = try installer.install(stagedInput: staged, targetInput: target,
                        expected: expected, expectedDownloadSha256: downloadDigest)
                }
                switch outcome {
                case .installed(let preserved):
                    var result = ["status": "installed"]
                    if let preserved { result["preservedPath"] = preserved.absoluteString }
                    response = result
                case .conflict(let preserved):
                    response = ["status": "conflict", "preservedPath": preserved.absoluteString]
                }
            } catch { throw NativeAttachmentInstallerError.unavailable }
        case "hash":
            guard Set(request.keys) == Set(["op", "path"]) else { throw NativeAttachmentInstallerError.invalidRequest }
            let path = try fileURL(request["path"])
            do {
                let snapshot: AttachmentFileHashSnapshot
                if let candidateFiles {
                    let path = URL(fileURLWithPath: try NativeAttachmentFiles.filePath(path.absoluteString))
                    snapshot = try candidateFiles.withCandidateManagedDirectory { directory, check in
                        try installer.hash(path, directoryDescriptor: directory, requireAuthority: check)
                    }
                } else { snapshot = try installer.hash(path) }
                response = ["sha256": snapshot.sha256, "size": Double(snapshot.size),
                            "modificationTimeMs": snapshot.modificationTimeMs]
            } catch { throw NativeAttachmentInstallerError.unavailable }
        default: throw NativeAttachmentInstallerError.invalidRequest
        }
        if candidateFiles != nil {
            let outcome = operation == "hash" ? "verified" : response["status"] as? String ?? "refused"
            NSLog("Native iOS RN candidate provider attachment operation confirmed releaseCheck=v1.3.8/ios-rn-candidate-provider-installer operation=%@ outcome=%@", operation, outcome)
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), as: UTF8.self)
    }

    /// Native-only FIFO operation; never reachable from the compatibility JSON
    /// handler. The RN facade retains all reservation/publication semantics.
    func prepareStage(targetURI: String, operationID: String) throws -> NativeAttachmentFiles.ReservedAttachmentStageProof {
        let target = try fileURL(targetURI)
        guard operationID.utf8.count == 32,
              operationID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw NativeAttachmentInstallerError.invalidRequest
        }
        do {
            let prepared: ImmutableAttachmentPreparedStage
            if let candidateFiles {
                prepared = try candidateFiles.withCandidateManagedDirectory { directory, check in
                    try installer.prepareImmutableStage(targetInput: target, operationId: operationID,
                        directoryDescriptor: directory, requireAuthority: check)
                }
            } else { prepared = try installer.prepareImmutableStage(targetInput: target, operationId: operationID) }
            let expected = target.deletingLastPathComponent()
                .appendingPathComponent(".mindwtr-install-" + operationID + ".candidate", isDirectory: true).appendingPathComponent("stage")
            // Retain the native record's root spelling across RN system aliases.
            guard prepared.stagedUrl.standardizedFileURL.resolvingSymlinksInPath() == expected.standardizedFileURL.resolvingSymlinksInPath() else {
                throw NativeAttachmentInstallerError.unavailable
            }
            return NativeAttachmentFiles.ReservedAttachmentStageProof(
                stageURI: expected.absoluteString, stagedIdentity: prepared.stagedIdentity,
                directoryIdentity: prepared.directoryIdentity, privateDirectoryIdentity: prepared.privateDirectoryIdentity)
        } catch { throw NativeAttachmentInstallerError.unavailable }
    }

    func publishStage(stage: NativeAttachmentFiles.ReservedAttachmentStageProof,
                      targetURI: String, sha256: String) throws -> String {
        let staged = try fileURL(stage.stageURI), target = try fileURL(targetURI)
        let hash = try digest(sha256)
        do {
            let outcome: ImmutableAttachmentPublishOutcome
            if let candidateFiles {
                outcome = try candidateFiles.withCandidateManagedDirectory { directory, check in
                    try installer.publishImmutable(stagedInput: staged, targetInput: target,
                        expectedStagedSha256: hash, expectedStagedIdentity: stage.stagedIdentity,
                        expectedDirectoryIdentity: stage.directoryIdentity, expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity,
                        directoryDescriptor: directory, requireAuthority: check)
                }
            } else {
                outcome = try installer.publishImmutable(stagedInput: staged, targetInput: target,
                    expectedStagedSha256: hash, expectedStagedIdentity: stage.stagedIdentity,
                    expectedDirectoryIdentity: stage.directoryIdentity, expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity)
            }
            switch outcome {
            case .published: return "published"
            case .alreadyExists: return "alreadyExists"
            }
        } catch { throw NativeAttachmentInstallerError.unavailable }
    }

    /// Native-only strict retirement; the caller owns its durable decision and
    /// latest live-reference check. The compatibility JSON allowlist is sealed.
    func retirePrivateStage(stage: NativeAttachmentFiles.ReservedAttachmentStageProof,
                            targetURI: String, operationID: String) throws -> String {
        _ = try fileURL(stage.stageURI)
        _ = try fileURL(targetURI)
        guard operationID.utf8.count == 32,
              operationID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw NativeAttachmentInstallerError.invalidRequest
        }
        do {
            if let candidateFiles {
                let result = try candidateFiles.withCandidateManagedDirectory { directory, check in
                    try installer.retireOwnedPrivateStage(stagedInput: fileURL(stage.stageURI), targetInput: fileURL(targetURI),
                        operationId: operationID, expectedStagedIdentity: stage.stagedIdentity,
                        expectedDirectoryIdentity: stage.directoryIdentity, expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity,
                        directoryDescriptor: directory, requireAuthority: check)
                }
                switch result { case .removed: return "removed"; case .missing: return "missing"; case .conflict: return "conflict" }
            }
            let candidate = ".mindwtr-install-" + operationID + ".candidate"
            var rootParts = try NativeAttachmentFiles.filePath(managedRoot.absoluteString).split(separator: "/", omittingEmptySubsequences: false)
            if rootParts.last?.isEmpty == true { rootParts.removeLast() }
            let targetParts = try NativeAttachmentFiles.filePath(targetURI).split(separator: "/", omittingEmptySubsequences: false)
            let stageParts = try NativeAttachmentFiles.filePath(stage.stageURI).split(separator: "/", omittingEmptySubsequences: false)
            guard let targetName = targetParts.last, !targetName.isEmpty,
                  targetParts.dropLast().elementsEqual(rootParts, by: { $0.utf8.elementsEqual($1.utf8) }),
                  stageParts.last == "stage", let candidateName = stageParts.dropLast().last,
                  candidateName.utf8.elementsEqual(candidate.utf8),
                  stageParts.dropLast(2).elementsEqual(rootParts, by: { $0.utf8.elementsEqual($1.utf8) }) else {
                throw NativeAttachmentInstallerError.unavailable
            }
            // Missing children can retain an Apple alias after canonicalization.
            // Translate only the validated root; RN still checks each named child.
            let root = managedRoot.standardizedFileURL.resolvingSymlinksInPath()
            let target = root.appendingPathComponent(String(targetName))
            let staged = root.appendingPathComponent(candidate, isDirectory: true).appendingPathComponent("stage")
            switch try installer.retireOwnedPrivateStage(stagedInput: staged, targetInput: target,
                operationId: operationID, expectedStagedIdentity: stage.stagedIdentity,
                expectedDirectoryIdentity: stage.directoryIdentity,
                expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity) {
            case .removed: return "removed"
            case .missing: return "missing"
            case .conflict: return "conflict"
            }
        } catch { throw NativeAttachmentInstallerError.unavailable }
    }

    private func digest(_ value: Any?) throws -> String {
        guard let text = value as? String, text.utf8.count == 64,
              text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw NativeAttachmentInstallerError.invalidRequest
        }
        return text
    }

    private func fileURL(_ value: Any?) throws -> URL {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= 16 * 1024,
              !text.utf8.contains(0), let url = URL(string: text), url.isFileURL,
              url.host == nil || url.host == "", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil, url.path.hasPrefix("/"),
              !url.pathComponents.contains("."), !url.pathComponents.contains(".."),
              !url.path.utf8.contains(0) else {
            throw NativeAttachmentInstallerError.invalidRequest
        }
        return url
    }
}
