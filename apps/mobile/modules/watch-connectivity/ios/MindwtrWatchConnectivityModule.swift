import ExpoModulesCore
import Foundation

public final class MindwtrWatchConnectivityModule: Module {
    private var pendingCaptureObserver: NSObjectProtocol?

    public func definition() -> ModuleDefinition {
        Name("MindwtrWatchConnectivity")

        Events("onPendingCapture")

        OnCreate {
            self.pendingCaptureObserver = NotificationCenter.default.addObserver(
                forName: MindwtrWatchConnectivityReceiver.pendingCaptureNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                // The event is a wake-up edge only. Queue content stays on disk
                // until the existing pending-capture ingestion path reads it.
                self?.sendEvent("onPendingCapture", [:])
            }
        }

        OnDestroy {
            if let observer = self.pendingCaptureObserver {
                NotificationCenter.default.removeObserver(observer)
                self.pendingCaptureObserver = nil
            }
        }

        Function("isWatchConnectivityAvailable") {
            MindwtrWatchConnectivityReceiver.shared.isAvailable
        }

        AsyncFunction("activateWatchConnectivity") { () async throws -> Void in
            try await MindwtrWatchConnectivityReceiver.shared.activate()
        }

        AsyncFunction("updateWatchApplicationContext") {
            (context: [String: Any]) async throws -> Void in
            try await MindwtrWatchConnectivityReceiver.shared.updateApplicationContext(context)
        }

        AsyncFunction("settleWatchChecklist") { (id: String, outcome: String) async throws -> Void in
            try await MindwtrWatchConnectivityReceiver.shared.settleChecklist(id: id, outcome: outcome)
        }
    }
}
