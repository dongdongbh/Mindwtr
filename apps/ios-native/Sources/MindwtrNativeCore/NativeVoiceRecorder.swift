import Foundation

enum NativeVoiceRecordingError: Error, Equatable {
    case permissionDenied, unavailable, stale, cancelled, interrupted, backgrounded, routeLost, tooLarge, emptyRecording
}
enum NativeVoiceRecordingCancellation: Sendable { case cancelled, interrupted, backgrounded, routeLost, failed }
enum NativeVoiceRecorderEvent: Sendable { case interrupted, backgrounded, routeLost, failed }

struct NativeVoiceRecordingSession: Sendable, Equatable {
    fileprivate let ownerID: UUID
    let presentationID: UUID
    let captureID: UUID
    let recordingID: UUID
    fileprivate init(ownerID: UUID, presentationID: UUID, captureID: UUID) {
        self.ownerID = ownerID; self.presentationID = presentationID; self.captureID = captureID; recordingID = UUID()
    }
}
struct NativeVoiceRecordingSource: Sendable {
    let session: NativeVoiceRecordingSession
    let receipt: NativeAttachmentFiles.ProviderCacheCopyReceipt
    let proof: NativeAttachmentFiles.CacheSourceProof
    var fileName: String { receipt.fileName }
    var mimeType: String { "audio/mp4" }
    var size: Int64 { proof.size }
    var sha256: String { proof.sha256 }
}

protocol NativeVoiceRecordingAdapter: AnyObject {
    func start() throws
    func close() throws
}
protocol NativeVoiceRecorderBackend: Sendable {
    func requestPermission() async throws -> Bool
    func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws
        -> any NativeVoiceRecordingAdapter
}

actor NativeVoiceRecorder {
    static let maximumAudioBytes = NativeAttachmentFiles.maximumVoiceRecordingBytes
    private let ownerID = UUID()
    private let files: NativeAttachmentFiles
    private let backend: any NativeVoiceRecorderBackend
    private var session: NativeVoiceRecordingSession?
    private enum State { case ready, permission, recording, stopped, cancelled(NativeVoiceRecordingError), retired }
    private var observations: [UUID: AsyncStream<NativeVoiceRecordingState>.Continuation] = [:]
    private var state: State = .ready {
        didSet { for continuation in observations.values { continuation.yield(projectedState) } }
    }
    private var projectedState: NativeVoiceRecordingState {
        switch state {
        case .ready, .permission: return .ready
        case .recording: return .recording
        case .stopped, .retired: return .stopped
        case .cancelled(let reason):
            switch reason {
            case .permissionDenied: return .permissionDenied
            case .cancelled: return .cancelled
            case .interrupted: return .interrupted
            case .backgrounded: return .backgrounded
            case .routeLost: return .routeLost
            case .tooLarge: return .tooLarge
            default: return .failed
            }
        }
    }
    func events(_ selected: NativeVoiceRecordingSession) throws -> AsyncStream<NativeVoiceRecordingState> {
        try require(selected)
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            observations[id] = continuation
            continuation.yield(projectedState)
            continuation.onTermination = { [weak self] _ in Task { await self?.removeObservation(id) } }
        }
    }
    private func removeObservation(_ id: UUID) { observations.removeValue(forKey: id) }
    private var reservation: NativeAttachmentFiles.VoiceRecordingReservation?
    private var adapter: (any NativeVoiceRecordingAdapter)?
    private var source: NativeVoiceRecordingSource?
    private var monitor: Task<Void, Never>?

    init(files: NativeAttachmentFiles, backend: any NativeVoiceRecorderBackend) {
        self.files = files; self.backend = backend
    }

    func begin(presentationID: UUID, captureID: UUID) throws -> NativeVoiceRecordingSession {
        if session != nil { throw NativeVoiceRecordingError.stale }
        let selected = NativeVoiceRecordingSession(ownerID: ownerID, presentationID: presentationID, captureID: captureID)
        session = selected; return selected
    }

    func start(_ selected: NativeVoiceRecordingSession) async throws {
        try require(selected)
        guard case .ready = state else { throw stateError() }
        if Task.isCancelled { state = .cancelled(.cancelled); throw NativeVoiceRecordingError.cancelled }
        state = .permission
        let granted: Bool
        do { granted = try await backend.requestPermission() }
        catch {
            try require(selected)
            guard case .permission = state else { throw stateError() }
            let fixed = error as? NativeVoiceRecordingError ?? .unavailable
            state = .cancelled(fixed); throw fixed
        }
        try require(selected)
        guard case .permission = state else { throw stateError() }
        if Task.isCancelled { state = .cancelled(.cancelled); throw NativeVoiceRecordingError.cancelled }
        guard granted else { state = .cancelled(.permissionDenied); throw NativeVoiceRecordingError.permissionDenied }
        do {
            let reserved = try files.reserveVoiceRecording(); reservation = reserved
            adapter = try files.withVoiceRecordingURL(reserved, discard: { try? $0.close() }) { url in
                let created = try backend.makeRecorder(at: url) { [weak self] event in
                    Task { await self?.receive(event, session: selected) }
                }
                do { try created.start(); return created }
                catch { try? created.close(); throw error }
            }
            state = .recording
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                    guard let self else { return }
                    if !(await self.checkRecordingSize(selected)) { return }
                }
            }
        } catch {
            try? adapter?.close(); adapter = nil
            let cleanup = cleanupReservation()
            state = .cancelled(.unavailable)
            if !cleanup { throw NativeVoiceRecordingError.unavailable }
            throw NativeVoiceRecordingError.unavailable
        }
    }

    func stop(_ selected: NativeVoiceRecordingSession) throws -> NativeVoiceRecordingSource {
        try require(selected)
        if case .stopped = state, let source { return source }
        guard case .recording = state, let reservation, let adapter else { throw stateError() }
        monitor?.cancel(); monitor = nil
        do {
            try adapter.close(); self.adapter = nil
            guard try files.voiceRecordingSize(reservation) > 0 else {
                _ = try files.cancelVoiceRecording(reservation)
                self.reservation = nil; state = .cancelled(.emptyRecording)
                throw NativeVoiceRecordingError.emptyRecording
            }
            let frozen = try files.finishVoiceRecording(reservation, maximumBytes: Self.maximumAudioBytes)
            let result = NativeVoiceRecordingSource(session: selected, receipt: frozen.receipt, proof: frozen.source)
            source = result; self.reservation = nil; state = .stopped
            NSLog("Native iOS voice source frozen releaseCheck=v1.3.9/ios-native-voice stage=recording outcome=stopped")
            return result
        } catch {
            self.adapter = nil
            let fixed: NativeVoiceRecordingError
            if let typed = error as? NativeVoiceRecordingError { fixed = typed }
            else if error as? NativeAttachmentFilesError == .tooLarge { fixed = .tooLarge }
            else { fixed = .unavailable }
            let cleaned = cleanupReservation()
            state = .cancelled(fixed)
            throw cleaned ? fixed : NativeVoiceRecordingError.unavailable
        }
    }

    func cancel(_ selected: NativeVoiceRecordingSession, reason: NativeVoiceRecordingCancellation = .cancelled) throws {
        try require(selected)
        switch state {
        case .stopped, .retired: return
        case .cancelled: return
        default: break
        }
        monitor?.cancel(); monitor = nil
        var closed = true
        do { try adapter?.close() } catch { closed = false }
        adapter = nil
        let cleaned = cleanupReservation()
        state = .cancelled(Self.error(reason))
        if !closed || !cleaned { throw NativeVoiceRecordingError.unavailable }
    }

    func retire(_ selected: NativeVoiceRecordingSource) throws -> NativeAttachmentFiles.BaselineAttachmentRetirementOutcome {
        try require(selected.session)
        guard let source, source.receipt.matches(selected.proof), selected.receipt.matches(source.proof) else {
            throw NativeVoiceRecordingError.stale
        }
        let outcome = try files.retireProviderSource(source.receipt, checkCancellation: {})
        if outcome == .removed || outcome == .absent { state = .retired }
        return outcome
    }

    private func require(_ selected: NativeVoiceRecordingSession) throws {
        guard selected.ownerID == ownerID, selected == session else { throw NativeVoiceRecordingError.stale }
    }
    private func stateError() -> NativeVoiceRecordingError {
        if case .cancelled(let reason) = state { return reason }
        return .stale
    }
    private func cleanupReservation() -> Bool {
        guard let reservation else { return true }
        do { _ = try files.cancelVoiceRecording(reservation); self.reservation = nil; return true }
        catch { return false }
    }
    private func checkRecordingSize(_ selected: NativeVoiceRecordingSession) -> Bool {
        guard selected == session, case .recording = state, let reservation else { return false }
        do {
            if try files.voiceRecordingSize(reservation) > Int64(Self.maximumAudioBytes) {
                try? cancel(selected); state = .cancelled(.tooLarge); return false
            }
            return true
        } catch { try? cancel(selected, reason: .failed); return false }
    }
    private func receive(_ event: NativeVoiceRecorderEvent, session: NativeVoiceRecordingSession) {
        let reason: NativeVoiceRecordingCancellation
        switch event {
        case .interrupted: reason = .interrupted
        case .backgrounded: reason = .backgrounded
        case .routeLost: reason = .routeLost
        case .failed: reason = .failed
        }
        try? cancel(session, reason: reason)
    }
    private static func error(_ reason: NativeVoiceRecordingCancellation) -> NativeVoiceRecordingError {
        switch reason {
        case .cancelled: return .cancelled
        case .interrupted: return .interrupted
        case .backgrounded: return .backgrounded
        case .routeLost: return .routeLost
        case .failed: return .unavailable
        }
    }
}

#if os(iOS)
import AVFoundation
import UIKit

struct NativeAVAudioRecorderBackend: NativeVoiceRecorderBackend {
    private let permissionRequest: @Sendable () async -> Bool
    private let applicationState: @MainActor @Sendable () -> UIApplication.State
    private let notifications: NotificationCenter
    private let foregroundTimeout: TimeInterval

    init(permissionRequest: @escaping @Sendable () async -> Bool = {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
    }, applicationState: @escaping @MainActor @Sendable () -> UIApplication.State = {
        UIApplication.shared.applicationState
    }, notifications: NotificationCenter = .default, foregroundTimeout: TimeInterval = 2) {
        self.permissionRequest = permissionRequest; self.applicationState = applicationState
        self.notifications = notifications; self.foregroundTimeout = foregroundTimeout
    }

    func requestPermission() async throws -> Bool {
        let background = NativeAttachmentCancellation()
        let observer = notifications.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
            background.cancel()
        }
        defer { notifications.removeObserver(observer) }
        let granted = await permissionRequest()
        guard granted else { return false }
        let deadline = ProcessInfo.processInfo.systemUptime + foregroundTimeout
        var waited = false
        while true {
            if Task.isCancelled { throw NativeVoiceRecordingError.cancelled }
            let state = await applicationState()
            if Task.isCancelled { throw NativeVoiceRecordingError.cancelled }
            guard !background.isCancelled, state != .background else { throw NativeVoiceRecordingError.backgrounded }
            guard !waited || ProcessInfo.processInfo.systemUptime < deadline else { throw NativeVoiceRecordingError.unavailable }
            if state == .active {
                if waited {
                    NSLog("Native iOS voice permission foreground readmitted releaseCheck=v1.3.9/ios-voice-permission-foreground outcome=active")
                }
                return true
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw NativeVoiceRecordingError.unavailable }
            waited = true
            do { try await Task.sleep(nanoseconds: 10_000_000) }
            catch { throw NativeVoiceRecordingError.cancelled }
        }
    }
    func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws
        -> any NativeVoiceRecordingAdapter {
        try NativeAVAudioRecordingAdapter(url: url, onEvent: onEvent)
    }
}

private final class NativeAVAudioRecordingAdapter: NSObject, NativeVoiceRecordingAdapter, AVAudioRecorderDelegate {
    private let audioSession = AVAudioSession.sharedInstance()
    private let previousCategory: AVAudioSession.Category
    private let previousMode: AVAudioSession.Mode
    private let previousOptions: AVAudioSession.CategoryOptions
    private let recorder: AVAudioRecorder
    private let onEvent: @Sendable (NativeVoiceRecorderEvent) -> Void
    private var observers: [NSObjectProtocol] = []
    private var closed = false

    init(url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws {
        let selected = AVAudioSession.sharedInstance()
        let category = selected.category, mode = selected.mode, options = selected.categoryOptions
        previousCategory = category; previousMode = mode; previousOptions = options
        self.onEvent = onEvent
        do {
            try selected.setCategory(.record, mode: .default, options: [])
            try selected.setActive(true)
            recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128_000,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue])
        } catch {
            try? selected.setActive(false, options: .notifyOthersOnDeactivation)
            try? selected.setCategory(category, mode: mode, options: options)
            throw NativeVoiceRecordingError.unavailable
        }
        super.init()
        recorder.delegate = self
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: selected, queue: nil) { note in
            if (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue == AVAudioSession.InterruptionType.began.rawValue {
                onEvent(.interrupted)
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: selected, queue: nil) { note in
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                onEvent(.routeLost)
            }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
            onEvent(.backgrounded)
        })
    }
    func start() throws {
        guard !closed, recorder.prepareToRecord(), recorder.record() else { throw NativeVoiceRecordingError.unavailable }
    }
    func close() throws {
        if closed { return }; closed = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        recorder.delegate = nil; recorder.stop()
        var failed = false
        do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) } catch { failed = true }
        do { try audioSession.setCategory(previousCategory, mode: previousMode, options: previousOptions) } catch { failed = true }
        if failed { throw NativeVoiceRecordingError.unavailable }
    }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) { onEvent(.failed) }
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        if !flag { onEvent(.failed) }
    }
    deinit { try? close() }
}
#endif
