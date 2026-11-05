import Foundation

/// Frozen, receiver-owned WAV bytes bound to one published queue generation.
public struct MindwtrWatchPendingAudio: Sendable {
    public let command: MindwtrWatchPendingCommand
    public let bytes: Data
    fileprivate let wave: MindwtrWatchFileProof
    fileprivate let receipt: MindwtrWatchFileProof
    fileprivate init(command: MindwtrWatchPendingCommand, audio: MindwtrWatchRetainedAudio, receipt: MindwtrWatchFileProof) {
        self.command = command; bytes = audio.bytes; wave = audio.proof; self.receipt = receipt
    }
}

#if os(iOS)
import AudioToolbox
import Darwin
import Foundation
import WatchConnectivity

enum MindwtrWatchConnectivityError: Error {
    case featureUnavailable
    case activationFailed
    case sessionInactive
    case invalidPayload
    case identifierCollision
    case invalidReceipt
    case invalidAudioFile
    case fileOperationFailed
    case audioConversionFailed(OSStatus)

    var replyCode: String {
        switch self {
        case .featureUnavailable, .sessionInactive:
            return "unavailable"
        case .activationFailed:
            return "activation-failed"
        case .invalidPayload:
            return "invalid-payload"
        case .identifierCollision:
            return "identifier-collision"
        case .invalidReceipt:
            return "invalid-receipt"
        case .invalidAudioFile:
            return "invalid-audio"
        case .fileOperationFailed:
            return "storage-failed"
        case .audioConversionFailed:
            return "audio-conversion-failed"
        }
    }
}

extension MindwtrWatchConnectivityError: LocalizedError {
    var errorDescription: String? {
        "Mindwtr Watch Connectivity failed (\(replyCode))."
    }
}

private struct MindwtrWatchReceipt {
    let id: String
    let kind: MindwtrWatchPayloadKind
    let state: MindwtrWatchReceiptState
    let payload: [String: Any]?
    let originalAudioPath: String?
}

public final class MindwtrWatchConnectivityReceiver: NSObject, WCSessionDelegate {
    public static let shared = MindwtrWatchConnectivityReceiver()
    public static let pendingCaptureNotification = Notification.Name(
        "tech.dongdongbh.mindwtr.watchConnectivity.pendingCapture"
    )

    private static let featureFlag = "MindwtrWatchEnabled"
    private static let pendingDirectoryName = "pending-captures"
    private static let receiptDirectoryName = "watch-receipts"
    private static let originalAudioDirectoryName = "watch-audio-original"
    private static let audioDirectoryName = "watch-audio"
    private static let receiptVersion = 1
    private static let maxReceiptBytes = 32 * 1_024
    private static let maxAudioBytes = 50 * 1_024 * 1_024
    private static let maxWaveBytes = 256 * 1_024 * 1_024
    private static let audioBufferFrames: UInt32 = 4_096

    private let workQueue = DispatchQueue(
        label: "tech.dongdongbh.mindwtr.watchConnectivity.receiver",
        qos: .utility
    )
    private var activationRequested = false
    private var activationWaiters: [CheckedContinuation<Void, Error>] = []

    public var isAvailable: Bool {
        Self.isFeatureEnabled && WCSession.isSupported()
    }

    private static var isFeatureEnabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: featureFlag) as? Bool == true
    }

    public func activateAtLaunch() {
        guard isAvailable else { return }
        workQueue.async { [weak self] in
            self?.recoverReceiptsLocked()
            self?.ensureActivationLocked()
        }
    }

    public func activate() async throws {
        guard isAvailable else { throw MindwtrWatchConnectivityError.featureUnavailable }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workQueue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: MindwtrWatchConnectivityError.activationFailed)
                    return
                }
                if WCSession.default.activationState == .activated {
                    self.recoverAudioCleanupLocked()
                    continuation.resume()
                    return
                }
                self.activationWaiters.append(continuation)
                self.recoverReceiptsLocked()
                self.ensureActivationLocked()
            }
        }
    }

    public func updateApplicationContext(_ context: [String: Any], isCurrent: @escaping @Sendable () -> Bool = { true }) async throws {
        let normalized: [String: Any]
        do {
            normalized = try MindwtrWatchPayloadValidator.normalizeApplicationContext(context)
        } catch {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
        try await activate()
        try workQueue.sync {
            guard isCurrent(), WCSession.default.activationState == .activated else {
                throw MindwtrWatchConnectivityError.sessionInactive
            }
            try WCSession.default.updateApplicationContext(normalized)
        }
    }

    public func settleChecklist(id rawID: String, outcome: String) async throws {
        try workQueue.sync { try settleChecklistLocked(id: rawID, outcome: outcome) }
    }

    private func settleChecklistLocked(id rawID: String, outcome: String) throws {
        guard let uuid = UUID(uuidString: rawID),
              ["applied", "stale", "missing", "terminal", "changed"].contains(outcome) else {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
        let id = uuid.uuidString.lowercased()
        guard let receipt = try loadReceiptLocked(id: id), receipt.kind == .checklist,
              receipt.state == .published else { throw MindwtrWatchConnectivityError.invalidReceipt }
        let url = try ensuredDirectory(named: "watch-checklist-results").appendingPathComponent("\(id).json")
        if !FileManager.default.fileExists(atPath: url.path) {
            let result: [String: Any] = ["outcome": outcome, "settledAt": Date().timeIntervalSince1970]
            try atomicWrite(try jsonData(result), to: url, replacing: false)
        }
        sendDeliveryReceiptLocked(id: id)
        NotificationCenter.default.post(name: Self.pendingCaptureNotification, object: nil)
    }

    public func pendingCommands() async throws -> [MindwtrWatchPendingCommand] {
        try await withCheckedThrowingContinuation { continuation in
            workQueue.async {
                continuation.resume(with: Result {
                    let directory = try self.pendingDirectory()
                    var result: [MindwtrWatchPendingCommand] = []
                    for name in try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() {
                        guard name.hasSuffix(".json"), let id = UUID(uuidString: String(name.dropLast(5))),
                              name == id.uuidString.lowercased() + ".json",
                              let receipt = try self.loadReceiptLocked(id: id.uuidString.lowercased()), receipt.state == .published,
                              [.text, .audio, .complete, .deferTask, .checklist, .pomodoro].contains(receipt.kind) else { continue }
                        let command = try MindwtrWatchPendingCommand.read(directory: directory, name: name)
                        guard let payload = try JSONSerialization.jsonObject(with: Data(command.body.utf8)) as? [String: Any] else {
                            throw MindwtrWatchConnectivityError.invalidPayload
                        }
                        try self.validatePreparedQueuePayload(payload, receipt: receipt, requireAudioFile: false)
                        result.append(command)
                    }
                    return result
                })
            }
        }
    }

    public func pendingAudio(for command: MindwtrWatchPendingCommand) async throws -> MindwtrWatchPendingAudio {
        try await withCheckedThrowingContinuation { continuation in
            workQueue.async {
                continuation.resume(with: Result {
                    let (url, receipt) = try self.pendingAudioSourceLocked(command)
                    guard let audio = try MindwtrWatchRetainedAudio.read(at: url) else {
                        throw MindwtrWatchConnectivityError.invalidAudioFile
                    }
                    try command.validate()
                    try self.validateAudioReceiptLocked(receipt, id: String(command.name.dropLast(5)))
                    try self.retainAudioAdmissionLocked(MindwtrWatchAudioAdmission(id: String(command.name.dropLast(5)),
                        source: command.proof, receipt: receipt, wave: audio.proof))
                    return MindwtrWatchPendingAudio(command: command, audio: audio, receipt: receipt)
                })
            }
        }
    }

    /// May be called by the native Engine queue; never invokes Engine or UI work.
    public func validatePendingAudio(_ audio: MindwtrWatchPendingAudio) throws {
        try workQueue.sync { try validatePendingAudioLocked(audio) }
    }

    public func retirePendingAudio(_ audio: MindwtrWatchPendingAudio) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workQueue.async {
                continuation.resume(with: Result {
                    let id = String(audio.command.name.dropLast(5))
                    guard let admission = try self.loadAudioAdmissionLocked(id: id), admission.record.wave == audio.wave else {
                        throw MindwtrWatchConnectivityError.invalidReceipt
                    }
                    let marker = try admission.record.confirmedCleanup(source: audio.command.proof, receipt: audio.receipt,
                        audioDirectory: try self.documentsDirectory().appendingPathComponent(Self.audioDirectoryName))
                    try self.acknowledgeAudioCleanupLocked(marker, command: audio.command)
                })
            }
        }
    }

    /// For a host-proven committed receipt: absence of WAV must not prevent source retirement.
    public func retirePendingAudio(for command: MindwtrWatchPendingCommand) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workQueue.async {
                continuation.resume(with: Result {
                    let (url, receipt) = try self.pendingAudioSourceLocked(command)
                    let id = String(command.name.dropLast(5))
                    let marker: MindwtrWatchAudioCleanup
                    if let admission = try self.loadAudioAdmissionLocked(id: id) {
                        marker = try admission.record.confirmedCleanup(source: command.proof, receipt: receipt,
                                                                        audioDirectory: url.deletingLastPathComponent())
                    } else {
                        let wave = try MindwtrWatchRetainedAudio.proofForRetirement(at: url)
                        marker = MindwtrWatchAudioCleanup(id: id, source: command.proof, receipt: receipt, wave: wave)
                    }
                    try self.acknowledgeAudioCleanupLocked(marker, command: command)
                })
            }
        }
    }

    private func pendingAudioSourceLocked(_ command: MindwtrWatchPendingCommand) throws -> (URL, MindwtrWatchFileProof) {
        try command.validate()
        let id = String(command.name.dropLast(5))
        guard let receipt = try loadReceiptLocked(id: id), receipt.kind == .audio, receipt.state == .published,
              let payload = try JSONSerialization.jsonObject(with: Data(command.body.utf8)) as? [String: Any] else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        try validatePreparedQueuePayload(payload, receipt: receipt, requireAudioFile: false)
        guard let path = payload["audioPath"] as? String,
              let url = MindwtrWatchAudioPathResolver.rebase(absoluteString: path, id: id, kind: .wave,
                                                          currentDocumentsURL: try documentsDirectory()),
              let file = try MindwtrWatchFileProof.read(directory: try receiptDirectory(), name: id + ".json",
                                                       maximumBytes: Self.maxReceiptBytes) else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        try validateAudioReceiptLocked(file.proof, id: id)
        return (url, file.proof)
    }

    private func validateAudioReceiptLocked(_ proof: MindwtrWatchFileProof, id: String) throws {
        try proof.validate(directory: try receiptDirectory(), name: id + ".json", maximumBytes: Self.maxReceiptBytes)
        guard let receipt = try loadReceiptLocked(id: id), receipt.kind == .audio, receipt.state == .published else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
    }

    private func validatePendingAudioLocked(_ audio: MindwtrWatchPendingAudio) throws {
        let (url, receipt) = try pendingAudioSourceLocked(audio.command)
        guard receipt == audio.receipt,
              let admission = try loadAudioAdmissionLocked(id: String(audio.command.name.dropLast(5))),
              admission.record.source == audio.command.proof, admission.record.receipt == receipt,
              admission.record.wave == audio.wave else { throw MindwtrWatchConnectivityError.invalidReceipt }
        try audio.wave.validate(directory: url.deletingLastPathComponent(), name: url.lastPathComponent,
                                maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
    }

    private func loadAudioAdmissionLocked(id: String) throws -> (record: MindwtrWatchAudioAdmission, proof: MindwtrWatchFileProof)? {
        let directory = try ensuredDirectory(named: "watch-audio-admissions")
        guard let file = try MindwtrWatchFileProof.read(directory: directory, name: id + ".json", maximumBytes: Self.maxReceiptBytes) else { return nil }
        let record = try JSONDecoder().decode(MindwtrWatchAudioAdmission.self, from: file.bytes)
        try record.validateName(id + ".json")
        return (record, file.proof)
    }

    private func retainAudioAdmissionLocked(_ admission: MindwtrWatchAudioAdmission) throws {
        let directory = try ensuredDirectory(named: "watch-audio-admissions")
        if let existing = try loadAudioAdmissionLocked(id: admission.id) {
            guard existing.record == admission else { throw MindwtrWatchConnectivityError.invalidReceipt }
            try syncDirectory(directory)
        } else {
            try atomicWrite(try JSONEncoder().encode(admission), to: directory.appendingPathComponent(admission.id + ".json"), replacing: false)
        }
    }

    private func acknowledgeAudioCleanupLocked(_ marker: MindwtrWatchAudioCleanup, command: MindwtrWatchPendingCommand) throws {
        let directory = try ensuredDirectory(named: "watch-audio-cleanup")
        let name = marker.id + ".json"
        let url = directory.appendingPathComponent(name)
        if let existing = try MindwtrWatchFileProof.read(directory: directory, name: name, maximumBytes: Self.maxReceiptBytes) {
            guard try JSONDecoder().decode(MindwtrWatchAudioCleanup.self, from: existing.bytes) == marker else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        } else {
            try command.validate()
            try validateAudioReceiptLocked(marker.receipt, id: marker.id)
            if let wave = marker.wave {
                try wave.validateForRetirement(directory: try documentsDirectory().appendingPathComponent(Self.audioDirectoryName),
                                               name: marker.id + ".wav", maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
            }
            try atomicWrite(try JSONEncoder().encode(marker), to: url, replacing: false)
        }
        try finishAudioCleanupLocked(marker, markerDirectory: directory)
    }

    private func finishAudioCleanupLocked(_ marker: MindwtrWatchAudioCleanup, markerDirectory: URL) throws {
        let name = marker.id + ".json"
        try marker.validateName(name)
        guard let stored = try MindwtrWatchFileProof.read(directory: markerDirectory, name: name, maximumBytes: Self.maxReceiptBytes),
              try JSONDecoder().decode(MindwtrWatchAudioCleanup.self, from: stored.bytes) == marker else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        try validateAudioReceiptLocked(marker.receipt, id: marker.id)
        let admission = try loadAudioAdmissionLocked(id: marker.id)
        if let admission {
            guard admission.record.source == marker.source, admission.record.receipt == marker.receipt,
                  admission.record.wave == marker.wave else { throw MindwtrWatchConnectivityError.invalidReceipt }
        }
        try marker.retire(pendingDirectory: try pendingDirectory(),
                          audioDirectory: try documentsDirectory().appendingPathComponent(Self.audioDirectoryName))
        if let admission {
            try admission.proof.retire(directory: try ensuredDirectory(named: "watch-audio-admissions"),
                                       name: name, maximumBytes: Self.maxReceiptBytes)
        }
        try stored.proof.retire(directory: markerDirectory, name: name, maximumBytes: Self.maxReceiptBytes)
    }

    private func recoverAudioCleanupLocked() {
        guard let directory = try? ensuredDirectory(named: "watch-audio-cleanup"),
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasSuffix(".json") {
            do {
                guard let file = try MindwtrWatchFileProof.read(directory: directory, name: name, maximumBytes: Self.maxReceiptBytes) else { continue }
                let marker = try JSONDecoder().decode(MindwtrWatchAudioCleanup.self, from: file.bytes)
                try marker.validateName(name)
                try finishAudioCleanupLocked(marker, markerDirectory: directory)
            } catch { continue }
        }
    }

    public func retirePendingCommand(_ command: MindwtrWatchPendingCommand, checklistOutcome: String? = nil) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workQueue.async {
                continuation.resume(with: Result {
                    let id = String(command.name.dropLast(5))
                    guard let receipt = try self.loadReceiptLocked(id: id), receipt.state == .published,
                          [.text, .complete, .deferTask, .checklist, .pomodoro].contains(receipt.kind),
                          let payload = try JSONSerialization.jsonObject(with: Data(command.body.utf8)) as? [String: Any] else {
                        throw MindwtrWatchConnectivityError.invalidReceipt
                    }
                    try self.validatePreparedQueuePayload(payload, receipt: receipt, requireAudioFile: false)
                    guard (receipt.kind == .checklist) == (checklistOutcome != nil) else {
                        throw MindwtrWatchConnectivityError.invalidPayload
                    }
                    try command.retire {
                        if let checklistOutcome { try self.settleChecklistLocked(id: id, outcome: checklistOutcome) }
                    }
                })
            }
        }
    }

    private func ensureActivationLocked() {
        guard !activationRequested else { return }
        let session = WCSession.default
        if session.activationState == .activated {
            finishActivationLocked(with: .success(()))
            return
        }
        activationRequested = true
        session.delegate = self
        session.activate()
    }

    private func finishActivationLocked(with result: Result<Void, Error>) {
        let waiters = activationWaiters
        activationWaiters.removeAll()
        for waiter in waiters {
            switch result {
            case .success:
                waiter.resume()
            case .failure(let error):
                waiter.resume(throwing: error)
            }
        }
    }

    // MARK: - WCSessionDelegate

    public func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        workQueue.async { [weak self] in
            guard let self else { return }
            if activationState == .activated, error == nil {
                self.finishActivationLocked(with: .success(()))
            } else {
                self.activationRequested = false
                self.finishActivationLocked(
                    with: .failure(error ?? MindwtrWatchConnectivityError.activationFailed)
                )
            }
        }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {
        // iOS can briefly make the session inactive while the paired Watch changes.
    }

    public func sessionDidDeactivate(_ session: WCSession) {
        workQueue.async { [weak self] in
            guard let self, self.isAvailable else { return }
            self.activationRequested = false
            self.ensureActivationLocked()
        }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        workQueue.sync {
            if let id = try? receivePayloadLocked(userInfo) {
                sendDeliveryReceiptLocked(id: id)
            }
        }
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        workQueue.sync {
            _ = try? receivePayloadLocked(message)
        }
    }

    public func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        let reply: [String: Any] = workQueue.sync {
            do {
                let id = try receivePayloadLocked(message)
                if message["kind"] as? String == "checklist" { sendDeliveryReceiptLocked(id: id) }
                return ["accepted": true]
            } catch let error as MindwtrWatchConnectivityError {
                return ["accepted": false, "error": error.replyCode]
            } catch {
                return ["accepted": false, "error": "receiver-failed"]
            }
        }
        replyHandler(reply)
    }

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        var retainedID: String?
        workQueue.sync {
            retainedID = try? retainTransferredAudioLocked(file)
        }
        guard let retainedID else { return }
        workQueue.async { [weak self] in
            self?.recoverReceiptLocked(id: retainedID, sendDeliveryReceipt: true)
        }
    }

    // MARK: - Durable receive journal

    @discardableResult
    private func receivePayloadLocked(_ raw: [String: Any]) throws -> String {
        guard isAvailable else { throw MindwtrWatchConnectivityError.featureUnavailable }
        let validated: MindwtrValidatedWatchPayload
        do {
            validated = try MindwtrWatchPayloadValidator.validateTransport(raw)
        } catch {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
        guard validated.kind != .audio else {
            throw MindwtrWatchConnectivityError.invalidPayload
        }

        if let existing = try loadReceiptLocked(id: validated.id) {
            guard existing.kind == validated.kind else {
                throw MindwtrWatchConnectivityError.identifierCollision
            }
            switch existing.state {
            case .published:
                return validated.id
            case .prepared:
                try finishPreparedReceiptLocked(existing)
                return validated.id
            case .awaitingAudio, .audioRetained:
                throw MindwtrWatchConnectivityError.identifierCollision
            }
        }

        try stageQueuePayloadLocked(
            validated.queuePayload,
            id: validated.id,
            kind: validated.kind,
            requireAudioFile: false
        )
        try writeReceiptLocked(
            id: validated.id,
            kind: validated.kind,
            state: .prepared,
            payload: validated.queuePayload,
            originalAudioPath: nil,
            replacing: false
        )
        let receipt = MindwtrWatchReceipt(
            id: validated.id,
            kind: validated.kind,
            state: .prepared,
            payload: validated.queuePayload,
            originalAudioPath: nil
        )
        try finishPreparedReceiptLocked(receipt)
        return validated.id
    }

    private func retainTransferredAudioLocked(_ file: WCSessionFile) throws -> String {
        guard isAvailable, let metadata = file.metadata else {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
        let validated: MindwtrValidatedWatchPayload
        do {
            validated = try MindwtrWatchPayloadValidator.validateTransport(
                metadata,
                expectedKind: .audio
            )
        } catch {
            throw MindwtrWatchConnectivityError.invalidPayload
        }

        if let existing = try loadReceiptLocked(id: validated.id) {
            guard existing.kind == .audio else {
                throw MindwtrWatchConnectivityError.identifierCollision
            }
            switch existing.state {
            case .published, .prepared:
                return validated.id
            case .audioRetained:
                if let path = existing.originalAudioPath,
                   let originalURL = MindwtrWatchAudioPathResolver.rebase(
                    absoluteString: path,
                    id: validated.id,
                    kind: .retainedOriginal,
                    currentDocumentsURL: try documentsDirectory()
                   ),
                   validRetainedAudioFile(at: originalURL) {
                    return validated.id
                }
            case .awaitingAudio:
                break
            }
        } else {
            // This journal entry is durable before the temporary WCSession file is
            // touched. If the process dies while copying, a redelivery with the
            // same id safely resumes instead of creating a second operation.
            try writeReceiptLocked(
                id: validated.id,
                kind: .audio,
                state: .awaitingAudio,
                payload: validated.queuePayload,
                originalAudioPath: nil,
                replacing: false
            )
        }

        let incomingURL = file.fileURL
        try validateIncomingAudioURL(incomingURL)
        let originalURL = try originalAudioURL(id: validated.id)
        if FileManager.default.fileExists(atPath: originalURL.path) {
            if !validRetainedAudioFile(at: originalURL) {
                try FileManager.default.removeItem(at: originalURL)
                try syncDirectory(originalURL.deletingLastPathComponent())
                try copyTransferredAudio(from: incomingURL, to: originalURL)
            }
        } else {
            try copyTransferredAudio(from: incomingURL, to: originalURL)
        }

        try writeReceiptLocked(
            id: validated.id,
            kind: .audio,
            state: .audioRetained,
            payload: validated.queuePayload,
            originalAudioPath: originalURL.absoluteString,
            replacing: true
        )
        return validated.id
    }

    private func recoverReceiptsLocked() {
        recoverAudioCleanupLocked()
        guard let directory = try? receiptDirectory() else { return }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return }
        for file in files where file.pathExtension == "json" {
            let id = file.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id) != nil else { continue }
            recoverReceiptLocked(id: id.lowercased(), sendDeliveryReceipt: false)
        }
    }

    private func recoverReceiptLocked(id: String, sendDeliveryReceipt: Bool) {
        do {
            guard var receipt = try loadReceiptLocked(id: id) else { return }
            switch receipt.state {
            case .published:
                break
            case .prepared:
                try finishPreparedReceiptLocked(receipt)
            case .awaitingAudio:
                let original = try originalAudioURL(id: receipt.id)
                guard validRetainedAudioFile(at: original) else { return }
                try writeReceiptLocked(
                    id: receipt.id,
                    kind: .audio,
                    state: .audioRetained,
                    payload: receipt.payload,
                    originalAudioPath: original.absoluteString,
                    replacing: true
                )
                receipt = MindwtrWatchReceipt(
                    id: receipt.id,
                    kind: .audio,
                    state: .audioRetained,
                    payload: receipt.payload,
                    originalAudioPath: original.absoluteString
                )
                try prepareRetainedAudioLocked(receipt)
            case .audioRetained:
                try prepareRetainedAudioLocked(receipt)
            }
            if sendDeliveryReceipt {
                sendDeliveryReceiptLocked(id: receipt.id)
            }
        } catch {
            // A retained audio original or prepared receipt stays durable for a
            // later launch/redelivery retry. Never delete it on a failed recovery.
        }
    }

    private func prepareRetainedAudioLocked(_ receipt: MindwtrWatchReceipt) throws {
        guard receipt.kind == .audio,
              let basePayload = receipt.payload,
              let originalPath = receipt.originalAudioPath,
              let originalURL = MindwtrWatchAudioPathResolver.rebase(
                absoluteString: originalPath,
                id: receipt.id,
                kind: .retainedOriginal,
                currentDocumentsURL: try documentsDirectory()
              ),
              validRetainedAudioFile(at: originalURL) else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        do {
            let validated = try MindwtrWatchPayloadValidator.validateTransport(
                basePayload,
                expectedKind: .audio
            )
            guard validated.id == receipt.id else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        } catch let error as MindwtrWatchConnectivityError {
            throw error
        } catch {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }

        let wavURL = try audioURL(id: receipt.id)
        if FileManager.default.fileExists(atPath: wavURL.path), !validWaveFile(at: wavURL) {
            try FileManager.default.removeItem(at: wavURL)
            try syncDirectory(wavURL.deletingLastPathComponent())
        }
        if !FileManager.default.fileExists(atPath: wavURL.path) {
            try convertToMonoPCM16Wave(from: originalURL, to: wavURL)
        }
        guard validWaveFile(at: wavURL) else {
            throw MindwtrWatchConnectivityError.invalidAudioFile
        }

        var queuePayload = basePayload
        queuePayload["audioPath"] = wavURL.absoluteString
        try stageQueuePayloadLocked(
            queuePayload,
            id: receipt.id,
            kind: .audio,
            requireAudioFile: true
        )
        try writeReceiptLocked(
            id: receipt.id,
            kind: .audio,
            state: .prepared,
            payload: queuePayload,
            originalAudioPath: originalURL.absoluteString,
            replacing: true
        )
        try finishPreparedReceiptLocked(MindwtrWatchReceipt(
            id: receipt.id,
            kind: .audio,
            state: .prepared,
            payload: queuePayload,
            originalAudioPath: originalURL.absoluteString
        ))
    }

    private func finishPreparedReceiptLocked(_ receipt: MindwtrWatchReceipt) throws {
        guard receipt.state == .prepared,
              let payload = receipt.payload else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        let data = try jsonData(payload)
        let directory = try pendingDirectory()
        let stageURL = stageURL(id: receipt.id, directory: directory)
        let queueURL = directory.appendingPathComponent("\(receipt.id).json")
        let stageExists = FileManager.default.fileExists(atPath: stageURL.path)
        let queueExists = FileManager.default.fileExists(atPath: queueURL.path)
        let existingURL = stageExists ? stageURL : queueURL
        let bytesMatch = (try? Data(contentsOf: existingURL)) == data
        let action = MindwtrWatchReceiptStateMachine.preparedRecoveryAction(
            stageExists: stageExists,
            queueExists: queueExists,
            bytesMatch: bytesMatch
        )
        var shouldNotify = false

        switch action {
        case .publishStage:
            try validatePreparedQueuePayload(
                payload,
                receipt: receipt,
                requireAudioFile: receipt.kind == .audio
            )
            // Stage and destination share a directory. The missing stage is the
            // durable publication marker used after a crash, even when JS has
            // already consumed and removed the destination queue file.
            guard Darwin.rename(stageURL.path, queueURL.path) == 0 else {
                throw MindwtrWatchConnectivityError.fileOperationFailed
            }
            try syncDirectory(directory)
            shouldNotify = true
        case .compactPublishedQueue:
            try validatePreparedQueuePayload(
                payload,
                receipt: receipt,
                requireAudioFile: false
            )
            shouldNotify = true
        case .compactConsumedQueue:
            try validatePreparedQueuePayload(
                payload,
                receipt: receipt,
                requireAudioFile: false
            )
        case .collision:
            throw MindwtrWatchConnectivityError.identifierCollision
        }

        if let originalPath = receipt.originalAudioPath,
           let originalURL = MindwtrWatchAudioPathResolver.rebase(
            absoluteString: originalPath,
            id: receipt.id,
            kind: .retainedOriginal,
            currentDocumentsURL: try documentsDirectory()
           ),
           FileManager.default.fileExists(atPath: originalURL.path) {
            try? FileManager.default.removeItem(at: originalURL)
            try? syncDirectory(originalURL.deletingLastPathComponent())
        }

        // Compact published receipts deliberately omit title, task id, and paths.
        // The UUID and kind are enough for stable redelivery dedupe after relaunch.
        try writeReceiptLocked(
            id: receipt.id,
            kind: receipt.kind,
            state: .published,
            payload: nil,
            originalAudioPath: nil,
            replacing: true
        )
        if shouldNotify {
            NotificationCenter.default.post(
                name: Self.pendingCaptureNotification,
                object: nil
            )
        }
    }

    private func stageQueuePayloadLocked(
        _ payload: [String: Any],
        id: String,
        kind: MindwtrWatchPayloadKind,
        requireAudioFile: Bool
    ) throws {
        let receipt = MindwtrWatchReceipt(
            id: id,
            kind: kind,
            state: .prepared,
            payload: payload,
            originalAudioPath: nil
        )
        try validatePreparedQueuePayload(
            payload,
            receipt: receipt,
            requireAudioFile: requireAudioFile
        )
        let data = try jsonData(payload)
        let directory = try pendingDirectory()
        let stage = stageURL(id: id, directory: directory)
        let stageExists = FileManager.default.fileExists(atPath: stage.path)
        let bytesMatch = (try? Data(contentsOf: stage)) == data
        switch MindwtrWatchReceiptStateMachine.stageAction(
            stageExists: stageExists,
            bytesMatch: bytesMatch
        ) {
        case .reuse:
            return
        case .collision:
                throw MindwtrWatchConnectivityError.identifierCollision
        case .create:
            try atomicWrite(data, to: stage, replacing: false)
        }
    }

    private func validatePreparedQueuePayload(
        _ payload: [String: Any],
        receipt: MindwtrWatchReceipt,
        requireAudioFile: Bool
    ) throws {
        do {
            if receipt.kind == .audio {
                var transport = payload
                guard let path = transport.removeValue(forKey: "audioPath") as? String,
                      let expectedURL = MindwtrWatchAudioPathResolver.rebase(
                        absoluteString: path,
                        id: receipt.id,
                        kind: .wave,
                        currentDocumentsURL: try documentsDirectory()
                      ) else {
                    throw MindwtrWatchConnectivityError.invalidReceipt
                }
                if requireAudioFile, !validWaveFile(at: expectedURL) {
                    throw MindwtrWatchConnectivityError.invalidAudioFile
                }
                let validated = try MindwtrWatchPayloadValidator.validateTransport(
                    transport,
                    expectedKind: .audio
                )
                guard validated.id == receipt.id else {
                    throw MindwtrWatchConnectivityError.invalidReceipt
                }
            } else {
                let validated = try MindwtrWatchPayloadValidator.validateTransport(
                    payload,
                    expectedKind: receipt.kind
                )
                guard validated.id == receipt.id else {
                    throw MindwtrWatchConnectivityError.invalidReceipt
                }
            }
        } catch let error as MindwtrWatchConnectivityError {
            throw error
        } catch {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
    }

    // MARK: - Receipt serialization

    private func loadReceiptLocked(id: String) throws -> MindwtrWatchReceipt? {
        let url = try receiptDirectory().appendingPathComponent("\(id).json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maxReceiptBytes,
              let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(raw.keys).isSubset(of: [
                "receiptVersion", "id", "kind", "state", "payload", "originalAudioPath",
              ]),
              (raw["receiptVersion"] as? NSNumber)?.intValue == Self.receiptVersion,
              raw["id"] as? String == id,
              let kindValue = raw["kind"] as? String,
              let kind = MindwtrWatchPayloadKind(rawValue: kindValue),
              let stateValue = raw["state"] as? String,
              let state = MindwtrWatchReceiptState(rawValue: stateValue) else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        let payload = raw["payload"] as? [String: Any]
        let originalAudioPath = raw["originalAudioPath"] as? String
        switch state {
        case .awaitingAudio:
            guard kind == .audio, payload != nil, originalAudioPath == nil else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        case .audioRetained:
            guard kind == .audio, payload != nil, originalAudioPath != nil else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        case .prepared:
            guard payload != nil else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        case .published:
            guard payload == nil, originalAudioPath == nil else {
                throw MindwtrWatchConnectivityError.invalidReceipt
            }
        }
        return MindwtrWatchReceipt(
            id: id,
            kind: kind,
            state: state,
            payload: payload,
            originalAudioPath: originalAudioPath
        )
    }

    private func writeReceiptLocked(
        id: String,
        kind: MindwtrWatchPayloadKind,
        state: MindwtrWatchReceiptState,
        payload: [String: Any]?,
        originalAudioPath: String?,
        replacing: Bool
    ) throws {
        var raw: [String: Any] = [
            "receiptVersion": Self.receiptVersion,
            "id": id,
            "kind": kind.rawValue,
            "state": state.rawValue,
        ]
        if let payload { raw["payload"] = payload }
        if let originalAudioPath { raw["originalAudioPath"] = originalAudioPath }
        let data = try jsonData(raw)
        guard data.count <= Self.maxReceiptBytes else {
            throw MindwtrWatchConnectivityError.invalidReceipt
        }
        try atomicWrite(
            data,
            to: try receiptDirectory().appendingPathComponent("\(id).json"),
            replacing: replacing
        )
    }

    // MARK: - Audio retention and conversion

    private func validateIncomingAudioURL(_ url: URL) throws {
        guard url.isFileURL, url.pathExtension.lowercased() == "m4a" else {
            throw MindwtrWatchConnectivityError.invalidAudioFile
        }
        let values = try url.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        )
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let size = values.fileSize,
              size > 0,
              size <= Self.maxAudioBytes else {
            throw MindwtrWatchConnectivityError.invalidAudioFile
        }
    }

    private func validRetainedAudioFile(at url: URL) -> Bool {
        do {
            try validateIncomingAudioURL(url)
            return true
        } catch {
            return false
        }
    }

    private func copyTransferredAudio(from source: URL, to destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp"
        )
        defer { try? FileManager.default.removeItem(at: temp) }
        do {
            try FileManager.default.copyItem(at: source, to: temp)
            try syncFile(temp)
            try setBackgroundFileProtection(temp)
            guard Darwin.rename(temp.path, destination.path) == 0 else {
                throw MindwtrWatchConnectivityError.fileOperationFailed
            }
            try syncDirectory(directory)
        } catch let error as MindwtrWatchConnectivityError {
            throw error
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }

    private func convertToMonoPCM16Wave(from source: URL, to destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp"
        )
        defer { try? FileManager.default.removeItem(at: temp) }

        var inputFile: ExtAudioFileRef?
        try checkAudioStatus(ExtAudioFileOpenURL(source as CFURL, &inputFile))
        guard let inputFile else { throw MindwtrWatchConnectivityError.invalidAudioFile }
        defer { ExtAudioFileDispose(inputFile) }

        guard FileManager.default.createFile(atPath: temp.path, contents: nil) else {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
        let outputHandle: FileHandle
        do {
            outputHandle = try FileHandle(forWritingTo: temp)
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
        var outputClosed = false
        defer {
            if !outputClosed { try? outputHandle.close() }
        }
        try outputHandle.write(contentsOf: MindwtrCanonicalWave.header(dataByteCount: 0))

        let writtenBytes = try MindwtrCanonicalWave.streamPCM(inputFile, maximumDataBytes: Self.maxWaveBytes - MindwtrCanonicalWave.headerSize) { bytes in
            try outputHandle.write(contentsOf: bytes)
        }

        try outputHandle.seek(toOffset: 0)
        try outputHandle.write(contentsOf: MindwtrCanonicalWave.header(dataByteCount: writtenBytes))
        try outputHandle.synchronize()
        try outputHandle.close()
        outputClosed = true
        try setBackgroundFileProtection(temp)
        guard MindwtrCanonicalWave.validateFile(at: temp, maximumFileSize: Self.maxWaveBytes) else {
            throw MindwtrWatchConnectivityError.invalidAudioFile
        }
        guard Darwin.rename(temp.path, destination.path) == 0 else {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
        try syncDirectory(directory)
    }

    private func checkAudioStatus(_ status: OSStatus) throws {
        guard status == noErr else {
            throw MindwtrWatchConnectivityError.audioConversionFailed(status)
        }
    }

    private func validWaveFile(at url: URL) -> Bool {
        guard url.isFileURL, url.pathExtension.lowercased() == "wav" else {
            return false
        }
        return MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: Self.maxWaveBytes)
    }

    // MARK: - Filesystem primitives

    private func documentsDirectory() throws -> URL {
        guard let directory = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
        return directory
    }

    private func pendingDirectory() throws -> URL {
        try ensuredDirectory(named: Self.pendingDirectoryName)
    }

    private func receiptDirectory() throws -> URL {
        try ensuredDirectory(named: Self.receiptDirectoryName)
    }

    private func originalAudioDirectory() throws -> URL {
        try ensuredDirectory(named: Self.originalAudioDirectoryName)
    }

    private func audioDirectory() throws -> URL {
        try ensuredDirectory(named: Self.audioDirectoryName)
    }

    private func originalAudioURL(id: String) throws -> URL {
        try originalAudioDirectory().appendingPathComponent("\(id).m4a")
    }

    private func audioURL(id: String) throws -> URL {
        try audioDirectory().appendingPathComponent("\(id).wav")
    }

    private func stageURL(id: String, directory: URL) -> URL {
        directory.appendingPathComponent(".\(id).watch-stage")
    }

    private func sendDeliveryReceiptLocked(id: String) {
        let session = WCSession.default
        guard session.activationState == .activated,
              session.isPaired,
              session.isWatchAppInstalled else { return }
        var payload: [String: Any] = [
            "protocolVersion": MindwtrWatchPayloadValidator.protocolVersion,
            "kind": "receipt",
            "id": id,
            "accepted": true,
        ]
        if let url = try? ensuredDirectory(named: "watch-checklist-results").appendingPathComponent("\(id).json"),
           let data = try? Data(contentsOf: url),
           let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let outcome = result["outcome"] as? String,
           let settledAt = result["settledAt"] as? Double {
            payload["outcome"] = outcome
            payload["settledAt"] = settledAt
        }
        if session.isReachable { session.sendMessage(payload, replyHandler: nil, errorHandler: nil) }
        _ = session.transferUserInfo(payload)
    }

    private func ensuredDirectory(named name: String) throws -> URL {
        let documents = try documentsDirectory()
        let directory = documents.appendingPathComponent(name, isDirectory: true)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            let values = try directory.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard isDirectory.boolValue, values.isSymbolicLink != true else {
                throw MindwtrWatchConnectivityError.fileOperationFailed
            }
            return directory
        }
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false,
                attributes: [
                    .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
                ]
            )
            try syncDirectory(documents)
            return directory
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }

    private func jsonData(_ value: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
        do {
            return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        } catch {
            throw MindwtrWatchConnectivityError.invalidPayload
        }
    }

    private func atomicWrite(_ data: Data, to destination: URL, replacing: Bool) throws {
        let directory = destination.deletingLastPathComponent()
        let temp = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp"
        )
        defer { try? FileManager.default.removeItem(at: temp) }
        do {
            guard FileManager.default.createFile(atPath: temp.path, contents: nil) else {
                throw MindwtrWatchConnectivityError.fileOperationFailed
            }
            let handle = try FileHandle(forWritingTo: temp)
            do {
                try handle.write(contentsOf: data)
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            try setBackgroundFileProtection(temp)
            if !replacing, FileManager.default.fileExists(atPath: destination.path) {
                throw MindwtrWatchConnectivityError.identifierCollision
            }
            guard Darwin.rename(temp.path, destination.path) == 0 else {
                throw MindwtrWatchConnectivityError.fileOperationFailed
            }
            try syncDirectory(directory)
        } catch let error as MindwtrWatchConnectivityError {
            throw error
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }

    private func setBackgroundFileProtection(_ url: URL) throws {
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }

    private func syncFile(_ url: URL) throws {
        do {
            let handle = try FileHandle(forWritingTo: url)
            try handle.synchronize()
            try handle.close()
        } catch {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }

    private func syncDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw MindwtrWatchConnectivityError.fileOperationFailed
        }
    }
}

#endif
