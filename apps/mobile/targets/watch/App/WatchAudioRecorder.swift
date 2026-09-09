import AVFoundation
import Foundation

@MainActor
final class MindwtrWatchAudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    @Published private(set) var hasPendingRecording = false
    @Published private(set) var errorMessage: String?

    private var recorder: AVAudioRecorder?
    private var pendingCapture = MindwtrWatchPendingCaptureOwner()
    private var handledCompletion = false
    private weak var connectivity: MindwtrWatchConnectivityModel?

    func toggle(using connectivity: MindwtrWatchConnectivityModel) {
        if isRecording {
            stopAndTransfer(using: connectivity)
        } else if hasPendingRecording {
            retryTransfer(using: connectivity)
        } else {
            start(using: connectivity)
        }
    }

    private func start(using connectivity: MindwtrWatchConnectivityModel) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)

            let id = UUID()
            let startedAt = Date()
            let url = try MindwtrWatchOutbox.prepareAudioURL(id: id)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.delegate = self
            recorder.prepareToRecord()
            guard recorder.record(forDuration: 120) else { throw RecordingError.couldNotStart }
            self.recorder = recorder
            _ = pendingCapture.prepareAudio(fileURL: url, id: id, createdAt: startedAt)
            handledCompletion = false
            self.connectivity = connectivity
            isRecording = true
            hasPendingRecording = false
            errorMessage = nil
        } catch {
            errorMessage = String(localized: "Couldn’t start recording.")
            isRecording = false
        }
    }

    private func stopAndTransfer(using connectivity: MindwtrWatchConnectivityModel) {
        guard let recorder, pendingCapture.pending != nil else { return }
        recorder.stop()
        finishOnce(recorder: recorder, successfully: true, using: connectivity)
    }

    private func finishOnce(
        recorder: AVAudioRecorder,
        successfully: Bool,
        using connectivity: MindwtrWatchConnectivityModel?
    ) {
        guard let currentRecorder = self.recorder,
              recorder === currentRecorder,
              !handledCompletion
        else { return }
        handledCompletion = true
        guard successfully, let connectivity else {
            failRecording()
            return
        }
        finishAndTransfer(recorder: recorder, using: connectivity)
    }

    private func retryTransfer(using connectivity: MindwtrWatchConnectivityModel) {
        guard let recorder, pendingCapture.pending != nil else { return }
        finishAndTransfer(recorder: recorder, using: connectivity)
    }

    private func finishAndTransfer(recorder: AVAudioRecorder, using connectivity: MindwtrWatchConnectivityModel) {
        guard let currentRecorder = self.recorder, recorder === currentRecorder else { return }
        isRecording = false
        let saved = pendingCapture.persistPending { capture in
            guard case let .audio(fileURL) = capture.content else { return false }
            return connectivity.transferAudio(
                fileURL: fileURL,
                id: capture.id,
                createdAt: capture.createdAt,
                outboxRetried: capture.outboxRetried
            )
        }
        hasPendingRecording = !saved
        if saved {
            self.recorder = nil
            self.connectivity = nil
            errorMessage = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.finishOnce(recorder: recorder, successfully: flag, using: self.connectivity)
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.finishOnce(recorder: recorder, successfully: false, using: nil)
        }
    }

    private func failRecording() {
        isRecording = false
        hasPendingRecording = false
        recorder = nil
        pendingCapture.discardPending()
        errorMessage = String(localized: "Recording stopped unexpectedly.")
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum RecordingError: Error {
        case couldNotStart
    }
}
