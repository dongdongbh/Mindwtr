import ExpoModulesCore
import Foundation
import UIKit

public final class MindwtrIosSceneLifecycleModule: Module {
    private static let diagnosticsNotification = Notification.Name(
        "tech.dongdongbh.mindwtr.iosSceneLifecycleDiagnostics.changed"
    )
    private var diagnosticsObserver: NSObjectProtocol?
    // #1432: background tasks JS has begun and not yet ended. iOS may call an expiration
    // handler on the main thread while JS ends a task on its own thread.
    private let backgroundTaskLock = NSLock()
    private var backgroundTasks = Set<Int>()

    public func definition() -> ModuleDefinition {
        Name("MindwtrIosSceneLifecycle")

        Events("onDiagnosticsChanged", "onBackgroundTaskExpired")

        OnCreate {
            self.diagnosticsObserver = NotificationCenter.default.addObserver(
                forName: Self.diagnosticsNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.sendEvent("onDiagnosticsChanged", [:])
            }
        }

        OnDestroy {
            if let observer = self.diagnosticsObserver {
                NotificationCenter.default.removeObserver(observer)
                self.diagnosticsObserver = nil
            }
            self.backgroundTaskLock.lock()
            let open = self.backgroundTasks
            self.backgroundTasks.removeAll()
            self.backgroundTaskLock.unlock()
            for id in open {
                UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
            }
        }

        // Both UIApplication calls are documented as safe off the main thread. Returns 0 when
        // iOS grants no time.
        Function("beginBackgroundTask") { (name: String) -> Int in
            let task = BackgroundTaskIdentifierBox()
            let identifier = UIApplication.shared.beginBackgroundTask(withName: name) {
                // Ended here, before JS hears of it, so a busy or suspended JS thread can never
                // leave the task open past its time (iOS would terminate the app).
                let id = task.identifier.rawValue
                let wasOpen = self.removeBackgroundTask(id)
                UIApplication.shared.endBackgroundTask(task.identifier)
                if wasOpen { self.sendEvent("onBackgroundTaskExpired", ["id": id]) }
            }
            task.identifier = identifier
            guard identifier != .invalid else { return 0 }
            self.backgroundTaskLock.lock()
            self.backgroundTasks.insert(identifier.rawValue)
            self.backgroundTaskLock.unlock()
            return identifier.rawValue
        }

        // Ends a task once; an id that expired or was already ended is ignored.
        Function("endBackgroundTask") { (id: Int) in
            guard self.removeBackgroundTask(id) else { return }
            UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
        }

        Function("drainDiagnostics") {
            let records = self.drainDiagnosticsOnMainQueue()
            NSLog(
                "[MindwtrScene] stage=bridgeReady deliveryKind=none count=%d",
                records.count
            )
            return records
        }
    }

    private func removeBackgroundTask(_ id: Int) -> Bool {
        backgroundTaskLock.lock()
        defer { backgroundTaskLock.unlock() }
        return backgroundTasks.remove(id) != nil
    }

    private func drainDiagnosticsOnMainQueue() -> [[String: Any]] {
        if Thread.isMainThread {
            return drainDiagnosticsFromAppDelegate()
        }
        return DispatchQueue.main.sync {
            drainDiagnosticsFromAppDelegate()
        }
    }

    private func drainDiagnosticsFromAppDelegate() -> [[String: Any]] {
        let selector = NSSelectorFromString("drainMindwtrSceneDiagnostics")
        guard let appDelegate = UIApplication.shared.delegate as? NSObject,
              appDelegate.responds(to: selector),
              let result = appDelegate.perform(selector)?.takeUnretainedValue(),
              let records = result as? [[String: Any]] else {
            return []
        }
        return records
    }
}

// The expiration handler needs the identifier that beginBackgroundTask returns. It fires
// seconds later on the main thread, long after the identifier is stored.
private final class BackgroundTaskIdentifierBox: @unchecked Sendable {
    var identifier = UIBackgroundTaskIdentifier.invalid
}
