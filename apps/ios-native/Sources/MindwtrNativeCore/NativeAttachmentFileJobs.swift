import Foundation

/// A primitive cancellation flag may cross queues; a JS value never does.
final class NativeAttachmentCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var cancellationHandler: (() -> Void)?
    func cancel() {
        lock.lock()
        let first = !cancelled; cancelled = true
        let callback = first ? cancellationHandler : nil
        lock.unlock()
        callback?()
    }
    func setCancellationHandler(_ callback: (() -> Void)?) {
        lock.lock(); cancellationHandler = callback; let alreadyCancelled = cancelled; lock.unlock()
        if alreadyCancelled { callback?() }
    }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func check() throws { if isCancelled { throw NativeAttachmentFileJobsError.cancelled } }
}

final class NativeAttachmentLocalRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [UUID: NativeAttachmentCancellation] = [:]
    private var closing = false
    func register(_ token: NativeAttachmentCancellation, id: UUID) {
        lock.lock(); let shouldCancel = closing; tokens[id] = token; lock.unlock()
        if shouldCancel { token.cancel() }
    }
    func remove(_ id: UUID) { lock.lock(); tokens.removeValue(forKey: id); lock.unlock() }
    func close() {
        lock.lock(); closing = true; let current = Array(tokens.values); lock.unlock()
        current.forEach { $0.cancel() }
    }
}

#if DEBUG
final class NativeAttachmentHostHooks: @unchecked Sendable {
    var configureJobs: ((NativeAttachmentFileJobs) -> Void)?
    var pump: (() -> Void)?
}
#endif

enum NativeAttachmentFileJobsError: LocalizedError {
    case unavailable, capacity, cancelled
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Attachment file operation is unavailable"
        case .capacity: return "Attachment file bridge capacity is unavailable"
        case .cancelled: return "Attachment file operation was cancelled"
        }
    }
}

/// Native-owned proofs only. This is not an extension of either JSON allowlist.
/// Retirement grants no domain authority: a future coordinator must persist its
/// decision and check latest shared live references under Engine/library ownership,
/// held without JSC pumping until the typed operation has completed.
enum NativeAttachmentDraftFileRequest: Sendable {
    case ensureManagedDirectory
    case ensureManagedDirectoryProof
    case snapshotSource(sourceURI: String)
    case snapshotBaseline(attachmentID: String, targetURI: String)
    case prepareStage(targetURI: String, operationID: String)
    case fillStage(source: NativeAttachmentFiles.CacheSourceProof, stage: NativeAttachmentFiles.ReservedAttachmentStageProof)
    case observeFilledStage(stage: NativeAttachmentFiles.ReservedAttachmentStageProof, sha256: String, size: Int64)
    case publishStage(stage: NativeAttachmentFiles.ReservedAttachmentStageProof, targetURI: String, sha256: String)
    case verifyPublication(targetURI: String, stage: NativeAttachmentFiles.ReservedAttachmentStageProof, sha256: String, size: Int64)
    case retirePublished(targetURI: String, proof: NativeAttachmentFiles.PublishedAttachmentProof)
    case retireBaseline(attachmentID: String, proof: NativeAttachmentFiles.BaselineAttachmentProof)
    case retirePrivateStage(stage: NativeAttachmentFiles.ReservedAttachmentStageProof, targetURI: String, operationID: String)

    fileprivate var isInstaller: Bool {
        switch self {
        case .prepareStage, .publishStage, .retirePrivateStage: return true
        case .ensureManagedDirectory, .ensureManagedDirectoryProof, .snapshotSource, .snapshotBaseline, .fillStage, .observeFilledStage, .verifyPublication, .retirePublished, .retireBaseline: return false
        }
    }

    fileprivate func encodedInputSize() throws -> Int {
        func uri(_ value: String) throws {
            guard !value.isEmpty, value.utf8.count <= 16 * 1024, !value.utf8.contains(0) else {
                throw NativeAttachmentFilesError.invalidRequest
            }
        }
        func digest(_ value: String) throws {
            guard value.utf8.count == 64,
                  value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw NativeAttachmentFilesError.invalidRequest
            }
        }
        func token(_ value: String) throws {
            guard value.utf8.count <= 41 else { throw NativeAttachmentFilesError.invalidRequest }
            let parts = value.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2, parts.allSatisfy({ part in
                guard let number = UInt64(part) else { return false }
                return String(number) == part
            }) else { throw NativeAttachmentFilesError.invalidRequest }
        }
        func stageObject(_ stage: NativeAttachmentFiles.ReservedAttachmentStageProof) throws -> [String: String] {
            try uri(stage.stageURI)
            try token(stage.stagedIdentity); try token(stage.directoryIdentity); try token(stage.privateDirectoryIdentity)
            return ["stageURI": stage.stageURI, "stagedIdentity": stage.stagedIdentity,
                    "directoryIdentity": stage.directoryIdentity, "privateDirectoryIdentity": stage.privateDirectoryIdentity]
        }
        let input: [String: Any]
        switch self {
        case .ensureManagedDirectory:
            input = ["op": "ensureManagedDirectory"]
        case .ensureManagedDirectoryProof:
            input = ["op": "ensureManagedDirectoryProof"]
        case .snapshotSource(let sourceURI):
            try uri(sourceURI)
            input = ["op": "snapshotSource", "sourceURI": sourceURI]
        case .snapshotBaseline(let attachmentID, let targetURI):
            try uri(targetURI)
            guard NativeAttachmentFiles.validBaselineAttachmentID(attachmentID) else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "snapshotBaseline", "attachmentID": attachmentID, "targetURI": targetURI]
        case .prepareStage(let targetURI, let operationID):
            try uri(targetURI)
            guard operationID.utf8.count == 32,
                  operationID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw NativeAttachmentInstallerError.invalidRequest
            }
            input = ["op": "prepareStage", "targetURI": targetURI, "operationID": operationID]
        case .fillStage(let source, let stage):
            try uri(source.sourceURI); try digest(source.sha256)
            try token(source.identity); try token(source.cacheRootIdentity); try token(source.parentIdentity)
            guard source.size >= 0, source.size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "fillStage", "source": ["sourceURI": source.sourceURI, "sha256": source.sha256,
                "size": source.size, "identity": source.identity, "cacheRootIdentity": source.cacheRootIdentity,
                "parentIdentity": source.parentIdentity], "stage": try stageObject(stage)]
        case .publishStage(let stage, let targetURI, let sha256):
            try uri(targetURI); try digest(sha256)
            input = ["op": "publishStage", "stage": try stageObject(stage), "targetURI": targetURI, "sha256": sha256]
        case .observeFilledStage(let stage, let sha256, let size):
            try digest(sha256)
            guard size >= 0, size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "observeFilledStage", "stage": try stageObject(stage), "sha256": sha256, "size": size]
        case .verifyPublication(let targetURI, let stage, let sha256, let size):
            try uri(targetURI); try digest(sha256)
            guard size >= 0, size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "verifyPublication", "targetURI": targetURI, "stage": try stageObject(stage),
                     "sha256": sha256, "size": size]
        case .retirePublished(let targetURI, let proof):
            try uri(targetURI); try digest(proof.sha256)
            try token(proof.identity); try token(proof.directoryIdentity)
            guard proof.size >= 0, proof.size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "retirePublished", "targetURI": targetURI,
                     "proof": ["sha256": proof.sha256, "size": proof.size,
                               "identity": proof.identity, "directoryIdentity": proof.directoryIdentity]]
        case .retireBaseline(let attachmentID, let proof):
            guard NativeAttachmentFiles.validBaselineAttachmentID(attachmentID) else { throw NativeAttachmentFilesError.invalidRequest }
            try uri(proof.targetURI); try digest(proof.sha256); try token(proof.identity); try token(proof.directoryIdentity)
            guard proof.size >= 0, proof.size <= 9_007_199_254_740_991 else { throw NativeAttachmentFilesError.invalidRequest }
            input = ["op": "retireBaseline", "attachmentID": attachmentID, "proof": ["targetURI": proof.targetURI,
                "sha256": proof.sha256, "size": proof.size, "identity": proof.identity, "directoryIdentity": proof.directoryIdentity]]
        case .retirePrivateStage(let stage, let targetURI, let operationID):
            try uri(targetURI)
            guard operationID.utf8.count == 32,
                  operationID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw NativeAttachmentInstallerError.invalidRequest
            }
            input = ["op": "retirePrivateStage", "stage": try stageObject(stage),
                     "targetURI": targetURI, "operationID": operationID]
        }
        // Count the actual escaped encoding; bounded individual strings are
        // checked first, so no oversized caller string is copied into a frame.
        let count = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]).count
        guard count <= 64 * 1024 else { throw NativeAttachmentFileJobsError.capacity }
        return count
    }
}

/// Swift-only FIFO and mailbox. The engine takes serialized replies itself,
/// including while its synchronous JSC invoke occupies the engine queue.
final class NativeAttachmentFileJobs: @unchecked Sendable {
    static let maximumJobs = 16
    static let maximumReservedBytes = 48 * 1024 * 1024
    private struct Job {
        let token: NativeAttachmentCancellation
        let reserved: Int
    }
    private struct Answer {
        let id: String
        let json: String
        let body: String?
        let isDraft: Bool
    }
    private enum Work: Sendable {
        case raw(String, installer: Bool)
        case draft(NativeAttachmentDraftFileRequest)
        case ownedBaseline(String, NativeAttachmentFiles.BaselineAttachmentProof, @Sendable () throws -> Void)
        var isInstaller: Bool {
            switch self {
            case .raw(_, let installer): return installer
            case .draft(let request): return request.isInstaller
            case .ownedBaseline: return false
            }
        }
        var isDraft: Bool {
            switch self {
            case .raw: return false
            case .draft: return true
            case .ownedBaseline: return true
            }
        }
    }
    private let files: NativeAttachmentFiles
    private let installer: NativeAttachmentInstaller
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.attachment-files", qos: .userInitiated)
    private let lock = NSLock()
    private let mutationLock = NSLock()
    private var jobs: [String: Job] = [:]
    private var answers: [Answer] = []
    private var taken: Answer?
    private var nextID: UInt64 = 0
    private var reservedBytes = 0
    private var accepting = true
    private var wake: (@Sendable () -> Void)?
    #if DEBUG
    /// Set before submitting work. Hooks run on the file queue, never on JSC.
    var beforeWork: ((String, Bool) throws -> Void)?
    var afterWork: ((String, Bool) -> Void)?
    var beforeProviderOutputNamedStat: ((Bool) throws -> Void)? {
        get { files.beforeProviderOutputNamedStat }
        set { files.beforeProviderOutputNamedStat = newValue }
    }
    var beforeFilePublish: (() throws -> Void)? {
        get { files.beforePublish }
        set { files.beforePublish = newValue }
    }
    var beforeStageSync: (() throws -> Void)? {
        get { files.beforeStageSync }
        set { files.beforeStageSync = newValue }
    }
    var beforeRetirementUnlink: (() throws -> Void)? {
        get { files.beforeRetirementUnlink }
        set { files.beforeRetirementUnlink = newValue }
    }
    var afterRetirementUnlink: (() throws -> Void)? {
        get { files.afterRetirementUnlink }
        set { files.afterRetirementUnlink = newValue }
    }
    var beforeRetirementSync: (() throws -> Void)? {
        get { files.beforeRetirementSync }
        set { files.beforeRetirementSync = newValue }
    }
    var counters: (jobs: Int, bytes: Int) {
        lock.lock(); defer { lock.unlock() }; return (jobs.count, reservedBytes)
    }
    #endif

    init(libraryRoot: URL) throws {
        files = try NativeAttachmentFiles(libraryRoot: libraryRoot)
        installer = try NativeAttachmentInstaller(managedRoot: files.managedRoot, sourceRoots: files.sourceRoots)
    }
    var directoriesJSON: String { files.directoriesJSON }
    func setWake(_ callback: (@Sendable () -> Void)?) { lock.lock(); wake = callback; lock.unlock() }

    func submit(_ json: String, installer isInstaller: Bool = false) throws -> String {
        let count = json.utf8.count
        guard count <= (isInstaller ? 64 * 1024 : 24 * 1024 * 1024) else { throw NativeAttachmentFileJobsError.capacity }
        // Only small requests can return bytes. Large frames are base64 writes
        // or will be refused by the adapter, without allocating on this queue.
        var replyReservation = 64 * 1024
        if !isInstaller, count <= 64 * 1024,
           let value = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
           let op = value["op"] as? String, ["readBytes", "readBytesRange", "readDirectory"].contains(op) {
            replyReservation = NativeAttachmentFiles.maximumBytes
        }
        return try enqueue(.raw(json, installer: isInstaller), inputBytes: count, replyReservation: replyReservation)
    }

    func submitDraft(_ request: NativeAttachmentDraftFileRequest) throws -> String {
        try enqueue(.draft(request), inputBytes: request.encodedInputSize(), replyReservation: 64 * 1024)
    }

    /// Native-only immutable journal lease; no raw JSON request can grant it.
    func submitBaselineRetirement(attachmentID: String, proof: NativeAttachmentFiles.BaselineAttachmentProof,
                                  ownershipBytes: Int, checkOwnership: @escaping @Sendable () throws -> Void) throws -> String {
        guard ownershipBytes >= 0, ownershipBytes <= 8 * 1024 * 1024 else { throw NativeAttachmentFileJobsError.capacity }
        let count = try NativeAttachmentDraftFileRequest.retireBaseline(attachmentID: attachmentID, proof: proof).encodedInputSize()
        return try enqueue(.ownedBaseline(attachmentID, proof, checkOwnership), inputBytes: count + ownershipBytes, replyReservation: 64 * 1024)
    }

    private func enqueue(_ work: Work, inputBytes: Int, replyReservation: Int) throws -> String {
        let reservation = inputBytes + replyReservation
        lock.lock()
        guard accepting, jobs.count < Self.maximumJobs,
              reservation <= Self.maximumReservedBytes - reservedBytes, nextID < UInt64.max else {
            lock.unlock(); throw NativeAttachmentFileJobsError.capacity
        }
        nextID += 1
        let id = String(nextID), token = NativeAttachmentCancellation()
        jobs[id] = Job(token: token, reserved: reservation)
        reservedBytes += reservation
        queue.async { [self] in
            let isInstaller = work.isInstaller
            let answer: Answer
            do {
                try token.check()
                #if DEBUG
                try beforeWork?(id, isInstaller)
                #endif
                try token.check()
                mutationLock.lock()
                defer { mutationLock.unlock() }
                let value: Any
                let bytes: Data?
                switch work {
                case .raw(let json, true):
                    // Once begun the RN installer must finish; cancellation
                    // cannot undo publication or release the library early.
                    value = try NativeJSON.jsonObject(with: Data(installer.handle(json).utf8))
                    bytes = nil
                case .raw(let json, false):
                    let reply = try files.call(json, checkCancellation: token.check)
                    value = reply.value ?? NSNull(); bytes = reply.bytes
                case .draft(let request):
                    value = try executeDraft(request, token: token); bytes = nil
                case .ownedBaseline(let attachmentID, let proof, let ownership):
                    value = ["status": try files.retireBaselineAttachment(attachmentID: attachmentID, proof: proof,
                        checkCancellation: token.check, checkOwnership: ownership).rawValue]
                    bytes = nil
                }
                var envelope: [String: Any] = ["id": id, "value": value]
                if bytes != nil { envelope["body"] = true }
                let encoded = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
                guard encoded.count <= replyReservation else { throw NativeAttachmentFileJobsError.capacity }
                answer = Answer(id: id, json: String(decoding: encoded, as: UTF8.self), body: bytes?.base64EncodedString(), isDraft: work.isDraft)
            } catch {
                let message: String
                if let fixed = error as? NativeAttachmentFilesError { message = fixed.localizedDescription }
                else if let fixed = error as? NativeAttachmentInstallerError { message = fixed.localizedDescription }
                else if let fixed = error as? NativeAttachmentFileJobsError { message = fixed.localizedDescription }
                else { message = NativeAttachmentFileJobsError.unavailable.localizedDescription }
                let envelope = ["id": id, "error": message]
                let encoded = try! JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
                answer = Answer(id: id, json: String(decoding: encoded, as: UTF8.self), body: nil, isDraft: work.isDraft)
            }
            #if DEBUG
            afterWork?(id, isInstaller)
            #endif
            lock.lock(); answers.append(answer); let callback = wake; lock.unlock()
            callback?()
        }
        lock.unlock()
        return id
    }

    /// Called only inside the shared FIFO and mutation lock. Prepare/publish
    /// and private retirement must finish once begun; source/fill and published
    /// retirement retain the existing primitive's cancellation cutover.
    private func executeDraft(_ request: NativeAttachmentDraftFileRequest,
                              token: NativeAttachmentCancellation) throws -> [String: Any] {
        switch request {
        case .ensureManagedDirectory:
            let request = try JSONSerialization.data(withJSONObject: ["op": "makeDirectory", "uri": files.managedRoot.absoluteString])
            _ = try files.call(String(decoding: request, as: UTF8.self), checkCancellation: token.check)
            return [:]
        case .ensureManagedDirectoryProof:
            return ["directoryIdentity": try files.ensureManagedDirectoryProof(checkCancellation: token.check)]
        case .snapshotSource(let sourceURI):
            let proof = try files.snapshotCacheSource(sourceURI, checkCancellation: token.check)
            return ["sourceURI": proof.sourceURI, "sha256": proof.sha256, "size": proof.size,
                    "identity": proof.identity, "cacheRootIdentity": proof.cacheRootIdentity,
                    "parentIdentity": proof.parentIdentity]
        case .snapshotBaseline(let attachmentID, let targetURI):
            switch try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: targetURI, checkCancellation: token.check) {
            case .present(let proof):
                return ["kind": "present", "targetURI": proof.targetURI, "sha256": proof.sha256, "size": proof.size,
                        "identity": proof.identity, "directoryIdentity": proof.directoryIdentity]
            case .noOwnedGeneration(let targetURI, let absence):
                let captured: [String: Any]
                switch absence {
                case .leafAbsent(let directoryIdentity): captured = ["kind": "leafAbsent", "directoryIdentity": directoryIdentity]
                case .managedDirectoryAbsent(let documentsIdentity): captured = ["kind": "managedDirectoryAbsent", "documentsIdentity": documentsIdentity]
                }
                return ["kind": "noOwnedGeneration", "targetURI": targetURI, "absence": captured]
            case .unmanaged(let targetURI): return ["kind": "unmanaged", "targetURI": targetURI]
            case .unsafeEntry(let targetURI): return ["kind": "unsafeEntry", "targetURI": targetURI]
            }
        case .prepareStage(let targetURI, let operationID):
            let proof = try installer.prepareStage(targetURI: targetURI, operationID: operationID)
            return ["stageURI": proof.stageURI, "stagedIdentity": proof.stagedIdentity,
                    "directoryIdentity": proof.directoryIdentity, "privateDirectoryIdentity": proof.privateDirectoryIdentity]
        case .fillStage(let source, let stage):
            let content = try files.fillReservedAttachmentStage(sourceProof: source, stageProof: stage,
                                                                checkCancellation: token.check)
            // Task221 proves successful fill retains the reserved inode.
            return ["sha256": content.sha256, "size": content.size, "identity": stage.stagedIdentity]
        case .publishStage(let stage, let targetURI, let sha256):
            return ["status": try installer.publishStage(stage: stage, targetURI: targetURI, sha256: sha256)]
        case .observeFilledStage(let stage, let sha256, let size):
            let content = try files.observeFilledAttachmentStage(stageProof: stage, sha256: sha256, size: size,
                                                                 checkCancellation: token.check)
            return ["sha256": content.sha256, "size": content.size, "identity": stage.stagedIdentity]
        case .verifyPublication(let targetURI, let stage, let sha256, let size):
            let proof = try files.verifyPublishedAttachment(targetURI: targetURI, stageProof: stage,
                sha256: sha256, size: size, checkCancellation: token.check)
            return ["sha256": proof.sha256, "size": proof.size, "identity": proof.identity,
                    "directoryIdentity": proof.directoryIdentity]
        case .retirePublished(let targetURI, let proof):
            switch try files.retirePublishedAttachment(targetURI: targetURI, proof: proof, checkCancellation: token.check) {
            case .removed: return ["status": "removed"]
            case .absent: return ["status": "absent"]
            }
        case .retireBaseline(let attachmentID, let proof):
            let outcome = try files.retireBaselineAttachment(attachmentID: attachmentID, proof: proof, checkCancellation: token.check)
            return ["status": outcome.rawValue]
        case .retirePrivateStage(let stage, let targetURI, let operationID):
            try token.check()
            // Once entered, the existing installer finishes durability even if
            // cancellation arrives. Keep its actual result for the owner.
            return ["status": try installer.retirePrivateStage(stage: stage, targetURI: targetURI, operationID: operationID)]
        }
    }

    func abort(_ id: String) { lock.lock(); let token = jobs[id]?.token; lock.unlock(); token?.cancel() }
    func next() -> String {
        lock.lock(); defer { lock.unlock() }
        // The polyfill takes a body immediately after its metadata. Retain its
        // admission reservation until that body is actually consumed.
        guard taken == nil, let index = answers.firstIndex(where: { !$0.isDraft }) else { return "" }
        let answer = answers.remove(at: index)
        if answer.body != nil { taken = answer } else { release(answer.id) }
        return answer.json
    }
    /// Native callers consume only their own completed typed proof. This never
    /// takes another ID, a raw reply, or the raw body awaiting consumption.
    func takeDraft(_ id: String) -> String {
        lock.lock(); defer { lock.unlock() }
        guard let index = answers.firstIndex(where: { $0.isDraft && $0.id == id }) else { return "" }
        let answer = answers.remove(at: index)
        release(answer.id)
        return answer.json
    }
    func body() -> String {
        lock.lock(); defer { lock.unlock() }
        guard let answer = taken else { return "" }
        taken = nil; release(answer.id); return answer.body ?? ""
    }
    private func release(_ id: String) {
        if let job = jobs.removeValue(forKey: id) { reservedBytes -= job.reserved }
    }
    func deleteNow(_ uri: String) throws {
        mutationLock.lock(); defer { mutationLock.unlock() }
        try files.deleteNow(uri)
    }
    /// Native-only object transport. Never round-trip creation authority through
    /// the JSON mailbox or call these synchronous wrappers from the file queue.
    func copyProviderSource(_ url: URL, cancellation: NativeAttachmentCancellation) throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt {
        try queue.sync {
            lock.lock(); let ready = accepting; lock.unlock()
            guard ready else { throw NativeAttachmentFileJobsError.unavailable }
            try cancellation.check()
            mutationLock.lock(); defer { mutationLock.unlock() }
            return try files.copyProviderSource(url, checkCancellation: cancellation.check)
        }
    }
    func createPlaintextDownloadSource(bytes: Data, cancellation: NativeAttachmentCancellation) throws
        -> (receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt, source: NativeAttachmentFiles.CacheSourceProof) {
        guard bytes.count <= NativeAttachmentFiles.maximumPlaintextSourceBytes else { throw NativeAttachmentFilesError.tooLarge }
        return try queue.sync {
            lock.lock(); let ready = accepting; lock.unlock()
            guard ready else { throw NativeAttachmentFileJobsError.unavailable }
            try cancellation.check()
            mutationLock.lock(); defer { mutationLock.unlock() }
            return try files.createPlaintextDownloadSource(bytes: bytes, checkCancellation: cancellation.check)
        }
    }
    func copyPhotoProviderSource(_ url: URL, selection: NativeAttachmentPhotoSelection,
                                 cancellation: NativeAttachmentCancellation) throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt {
        try queue.sync {
            lock.lock(); let ready = accepting; lock.unlock()
            guard ready else { throw NativeAttachmentFileJobsError.unavailable }
            try cancellation.check()
            mutationLock.lock(); defer { mutationLock.unlock() }
            return try files.copyPhotoProviderSource(url, selection: selection, checkCancellation: cancellation.check)
        }
    }
    func requireProviderSource(_ receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt) throws {
        try queue.sync {
            lock.lock(); let ready = accepting; lock.unlock()
            guard ready else { throw NativeAttachmentFileJobsError.unavailable }
            mutationLock.lock(); defer { mutationLock.unlock() }
            try files.requireProviderSource(receipt)
        }
    }
    /// After drain, retirement stays on the off-main Engine turn so its final
    /// callback may recheck editor/journal evidence without file-queue JSC use.
    func retireProviderSource(_ receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt,
                              requireOwner: () throws -> Void) throws -> NativeAttachmentFiles.BaselineAttachmentRetirementOutcome {
        lock.lock(); let ready = accepting; lock.unlock()
        guard ready else { throw NativeAttachmentFileJobsError.unavailable }
        mutationLock.lock(); defer { mutationLock.unlock() }
        return try files.retireProviderSource(receipt, checkCancellation: requireOwner)
    }
    func drain() { queue.sync {} }
    func cancelAndDrain() {
        lock.lock(); let tokens = jobs.values.map(\.token); lock.unlock()
        tokens.forEach { $0.cancel() }; drain()
    }
    func shutdown() {
        lock.lock(); accepting = false; wake = nil; lock.unlock()
        cancelAndDrain()
        lock.lock(); answers.removeAll(); taken = nil; jobs.removeAll(); reservedBytes = 0; lock.unlock()
    }
}
