import Foundation
import Darwin
import MindwtrWatchPayloadValidation
#if canImport(MindwtrWhisperEngine)
import MindwtrWhisperEngine
#endif

struct NativeWhisperVoiceModel: Sendable {
    let store: NativeWhisperModelStore
    let spec: NativeWhisperModelSpec
    let language: String
}

// Own every C inference until its engine and model lease have both drained.
final class NativeWhisperInferenceJobs: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [UUID: Task<String, Error>] = [:]
    private var terminal = false
    static var supported: Bool {
        #if canImport(MindwtrWhisperEngine)
        return true
        #else
        return false
        #endif
    }
    func transcribe(_ model: NativeWhisperVoiceModel, bytes: Data, canonicalWave: Bool,
                    cancellation: NativeAttachmentCancellation) async throws -> String {
        let id = UUID()
        let task = try begin(id: id, model: model, bytes: bytes, canonicalWave: canonicalWave, cancellation: cancellation)
        cancellation.setCancellationHandler { task.cancel() }
        defer { remove(id); cancellation.setCancellationHandler(nil) }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: { cancellation.cancel(); task.cancel() }
    }
    private func begin(id: UUID, model: NativeWhisperVoiceModel, bytes: Data, canonicalWave: Bool,
                       cancellation: NativeAttachmentCancellation) throws -> Task<String, Error> {
        lock.lock(); defer { lock.unlock() }
        guard !terminal, !cancellation.isCancelled else { throw CancellationError() }
        let task = Task.detached(priority: .userInitiated) { () async throws -> String in
            #if canImport(MindwtrWhisperEngine)
            try cancellation.check(); try Task.checkCancellation()
            let lease = try await model.store.acquire(model.spec)
            do {
                try await lease.validate()
                let descriptor = try await lease.duplicateDescriptor()
                let engine: WhisperEngine
                do { engine = try await WhisperEngine.open(modelDescriptor: descriptor); Darwin.close(descriptor) }
                catch { Darwin.close(descriptor); throw error }
                do {
                    try await lease.validate()
                    let check = { try cancellation.check(); try Task.checkCancellation() }
                    try check()
                    let samples: [Float]
                    if canonicalWave { samples = try MindwtrCanonicalWave.samplesFromCanonicalWave(bytes, maximumSamples: WhisperEngine.maximumSamples) }
                    else { samples = try MindwtrCanonicalWave.samplesFromAudio(bytes, maximumSamples: WhisperEngine.maximumSamples, checkCancellation: check) }
                    let value = try await engine.transcribe(samples: samples, language: model.language)
                    try check(); try await lease.validate()
                    let transcript = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !transcript.isEmpty, transcript != "[BLANK_AUDIO]", transcript.utf8.count <= 65536 else { throw NativeVoiceJSON.invalid }
                    await engine.close(); await lease.release()
                    return transcript
                } catch { await engine.close(); throw error }
            } catch { await lease.release(); throw error }
            #else
            throw NativeVoiceJSON.invalid
            #endif
        }
        tasks[id] = task; return task
    }
    private func remove(_ id: UUID) { lock.lock(); tasks.removeValue(forKey: id); lock.unlock() }
    private func snapshot(terminal: Bool) -> [Task<String, Error>] {
        lock.lock(); defer { lock.unlock() }
        if terminal { self.terminal = true }
        let selected = Array(tasks.values)
        for task in selected { task.cancel() }
        return selected
    }
    func cancelAndDrain(terminal: Bool) async {
        for task in snapshot(terminal: terminal) { _ = await task.result }
    }
    func cancel() { _ = snapshot(terminal: true) }
    deinit { cancel() }
}
