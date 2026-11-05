import Foundation

public struct NativeVoiceCaptureHandle: Sendable, Equatable {
    public let id: UUID
    public let presentationID: UUID
    public let captureID: UUID
}
public enum NativeVoiceRecordingState: Sendable, Equatable { case ready, recording, stopped, cancelled, permissionDenied, interrupted, backgrounded, routeLost, tooLarge, failed }
public struct NativeVoiceRecordingEvent: Sendable { public let handle: NativeVoiceCaptureHandle; public let state: NativeVoiceRecordingState }
public enum NativeVoiceCaptureOutcome: Sendable, Equatable { case saved(taskId: String, speechJobID: UUID?), savePending, refused }
public struct NativeVoiceSpeechSavePending: Error, Sendable { }
public enum NativeVoiceSpeechOutcome: String, Sendable { case applied, discarded, empty, skipped, failed, cancelled }

struct NativeVoiceFileSettlement: Codable {
    struct Source: Codable {
        let sourceURI: String, sha256: String, identity: String, cacheRootIdentity: String, parentIdentity: String
        let size: Int64
        init(_ value: NativeAttachmentFiles.CacheSourceProof) {
            sourceURI = value.sourceURI; sha256 = value.sha256; size = value.size; identity = value.identity
            cacheRootIdentity = value.cacheRootIdentity; parentIdentity = value.parentIdentity
        }
        var proof: NativeAttachmentFiles.CacheSourceProof { .init(sourceURI: sourceURI, sha256: sha256, size: size, identity: identity, cacheRootIdentity: cacheRootIdentity, parentIdentity: parentIdentity) }
    }
    struct Stage: Codable {
        let stageURI: String, stagedIdentity: String, directoryIdentity: String, privateDirectoryIdentity: String
        init(_ value: NativeAttachmentFiles.ReservedAttachmentStageProof) {
            stageURI = value.stageURI; stagedIdentity = value.stagedIdentity; directoryIdentity = value.directoryIdentity; privateDirectoryIdentity = value.privateDirectoryIdentity
        }
        var proof: NativeAttachmentFiles.ReservedAttachmentStageProof { .init(stageURI: stageURI, stagedIdentity: stagedIdentity, directoryIdentity: directoryIdentity, privateDirectoryIdentity: privateDirectoryIdentity) }
    }
    let source: Source
    let targetURI: String
    var operationID: String
    var stage: Stage?
}

final class NativeVoiceFiles: @unchecked Sendable {
    let files: NativeAttachmentFiles
    private let installer: NativeAttachmentInstaller
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.voice-files", qos: .userInitiated)
    let managedRoot: URL
    convenience init(libraryRoot: URL) throws {
        try self.init(files: NativeAttachmentFiles(libraryRoot: libraryRoot))
    }
    convenience init(rnAdoptionContainerURL: URL) throws {
        try self.init(files: NativeAttachmentFiles(rnAdoptionContainerURL: rnAdoptionContainerURL))
    }
    init(files: NativeAttachmentFiles) throws {
        self.files = files
        try files.verifyCandidateRoots()
        managedRoot = files.managedRoot
        installer = try NativeAttachmentInstaller(managedRoot: managedRoot, sourceRoots: [files.cacheRoot], filePort: files)
    }
    func reserve(_ state: NativeVoiceFileSettlement) throws -> NativeVoiceFileSettlement.Stage {
        try queue.sync {
            _ = try files.ensureManagedDirectoryProof(checkCancellation: {})
            let stage = try installer.prepareStage(targetURI: state.targetURI, operationID: state.operationID)
            try files.verifyCandidateRoots()
            return .init(stage)
        }
    }
    func publish(_ state: NativeVoiceFileSettlement) throws {
        try queue.sync {
            guard let stage = state.stage?.proof else { throw NativeVoiceJSON.invalid }
            if (try? files.verifyPublishedAttachment(targetURI: state.targetURI, stageProof: stage, sha256: state.source.sha256, size: state.source.size)) == nil {
                if (try? files.observeFilledAttachmentStage(stageProof: stage, sha256: state.source.sha256, size: state.source.size)) == nil {
                    _ = try files.fillReservedAttachmentStage(sourceProof: state.source.proof, stageProof: stage)
                }
                try files.verifyCandidateRoots()
                _ = try? installer.publishStage(stage: stage, targetURI: state.targetURI, sha256: state.source.sha256)
            }
            _ = try files.verifyPublishedAttachment(targetURI: state.targetURI, stageProof: stage, sha256: state.source.sha256, size: state.source.size)
        }
    }
    func verify(_ state: NativeVoiceFileSettlement) throws {
        try queue.sync {
            guard let stage = state.stage?.proof else { throw NativeVoiceJSON.invalid }
            _ = try files.verifyPublishedAttachment(targetURI: state.targetURI, stageProof: stage, sha256: state.source.sha256, size: state.source.size)
        }
    }
    func retireStage(_ state: NativeVoiceFileSettlement) {
        queue.sync {
            guard (try? files.verifyCandidateRoots()) != nil else { return }
            if let stage = state.stage?.proof { _ = try? installer.retirePrivateStage(stage: stage, targetURI: state.targetURI, operationID: state.operationID) }
        }
    }
    func drain() { queue.sync {} }
    func read(_ source: NativeVoiceRecordingSource, cancellation: NativeAttachmentCancellation) throws -> Data {
        try queue.sync {
            try files.requireProviderSource(source.receipt)
            let before = try files.snapshotCacheSource(source.proof.sourceURI, checkCancellation: cancellation.check)
            guard source.receipt.matches(before), source.size > 0, source.size <= 4 * 1024 * 1024,
                  let bytes = try files.call(NativeVoiceJSON.encode(["op": "readBytes", "uri": source.proof.sourceURI]), maximumReadBytes: 4 * 1024 * 1024, checkCancellation: cancellation.check).bytes,
                  bytes.count == source.size else { throw NativeVoiceJSON.invalid }
            let after = try files.snapshotCacheSource(source.proof.sourceURI, checkCancellation: cancellation.check)
            guard source.receipt.matches(after) else { throw NativeVoiceJSON.invalid }
            return bytes
        }
    }
}

struct NativeVoiceUnavailableBackend: NativeVoiceRecorderBackend {
    func requestPermission() async throws -> Bool { throw NativeVoiceRecordingError.unavailable }
    func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws -> any NativeVoiceRecordingAdapter { throw NativeVoiceRecordingError.unavailable }
}

final class NativeVoiceHTTPWait: @unchecked Sendable {
    private let lock = NSLock()
    private let http: NativeHTTPJobs
    private var continuation: CheckedContinuation<String, Error>?
    private var requestID: String?
    private var cancelled = false
    init(_ http: NativeHTTPJobs) { self.http = http }
    func run(_ json: String) async throws -> String {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                http.setWake { [weak self] in self?.consume() }
                do {
                    requestID = try http.submit(json)
                    lock.unlock(); consume()
                } catch {
                    self.continuation = nil; lock.unlock()
                    continuation.resume(throwing: HostFailure("ACTION_FAILED: Voice request could not be completed"))
                }
            }
        } onCancel: { self.cancel() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let id = requestID; lock.unlock()
        if let id { http.abort(id) }
    }
    func drain() { cancel(); http.cancelAndDrain() }
    private func consume() {
        lock.lock()
        guard continuation != nil else { lock.unlock(); return }
        do {
            guard let answer = try http.next() else { lock.unlock(); return }
            let metadata = try NativeVoiceJSON.object(answer.json, maximum: 128 * 1024)
            guard answer.body else { throw NativeVoiceJSON.invalid }
            let body = try http.body()
            guard !cancelled, body.completed, let status = metadata["status"] as? Int, (200...299).contains(status),
                  let bytes = Data(base64Encoded: body.base64), bytes.count <= 2 * 1024 * 1024,
                  let text = String(data: bytes, encoding: .utf8) else { throw NativeVoiceJSON.invalid }
            let selected = continuation; continuation = nil; lock.unlock(); selected?.resume(returning: text)
        } catch {
            let selected = continuation; continuation = nil; let cancel = cancelled; lock.unlock()
            selected?.resume(throwing: cancel ? CancellationError() : HostFailure("ACTION_FAILED: Voice request could not be completed"))
        }
    }

}
