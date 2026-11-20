import ExpoModulesCore
import Foundation
import UIKit

public final class MindwtrIosSiriActionsModule: Module {
    private static let ioQueue = DispatchQueue(
        label: "tech.dongdongbh.mindwtr.iosSiriActions.io",
        qos: .userInitiated
    )
    private var pendingObserver: NSObjectProtocol?
    private var resignObserver: NSObjectProtocol?
    private var becomeActiveObserver: NSObjectProtocol?
    private var accessSessionGeneration: UInt64?

    public func definition() -> ModuleDefinition {
        Name("MindwtrIosSiriActions")

        Events("onPendingActionsChanged")

        Function("isAvailable") {
#if compiler(>=6.4)
            if #available(iOS 27.0, *) { return true }
#endif
            return false
        }

        OnCreate {
            Self.performOnMain {
                self.resignObserver = NotificationCenter.default.addObserver(
                    forName: UIApplication.willResignActiveNotification,
                    object: nil,
                    queue: .main
                ) { [weak self] _ in
                    MindwtrSiriActionStore.endAccessSession()
                    self?.accessSessionGeneration = nil
                }
                self.becomeActiveObserver = NotificationCenter.default.addObserver(
                    forName: UIApplication.didBecomeActiveNotification,
                    object: nil,
                    queue: .main
                ) { [weak self] _ in
                    guard UIApplication.shared.applicationState == .active else {
                        MindwtrSiriActionStore.endAccessSession()
                        self?.accessSessionGeneration = nil
                        return
                    }
                    self?.accessSessionGeneration = MindwtrSiriActionStore.beginAccessSession()
                }
                if UIApplication.shared.applicationState == .active {
                    self.accessSessionGeneration = MindwtrSiriActionStore.beginAccessSession()
                } else {
                    MindwtrSiriActionStore.endAccessSession()
                    self.accessSessionGeneration = nil
                }
            }
            self.pendingObserver = NotificationCenter.default.addObserver(
                forName: MindwtrSiriActionStore.pendingActionsChangedNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.sendEvent("onPendingActionsChanged", [:])
            }
        }

        OnDestroy {
            Self.performOnMain {
                MindwtrSiriActionStore.endAccessSession()
                self.accessSessionGeneration = nil
                if let observer = self.resignObserver {
                    NotificationCenter.default.removeObserver(observer)
                    self.resignObserver = nil
                }
                if let observer = self.becomeActiveObserver {
                    NotificationCenter.default.removeObserver(observer)
                    self.becomeActiveObserver = nil
                }
            }
            if let observer = self.pendingObserver {
                NotificationCenter.default.removeObserver(observer)
                self.pendingObserver = nil
            }
        }

        AsyncFunction("claimPending") { () throws -> [[String: Any]] in
            guard let session = MindwtrSiriActionStore.allowedAccessSession else { return [] }
            let requests = try MindwtrSiriActionStore.appGroupStore().claimPending(now: Date(), accessSession: session)
            let claims = try requests.map { claim in
                var request = try Self.dictionary(from: claim.request)
                request["replayOnly"] = claim.replayOnly
                return request
            }
            guard MindwtrSiriActionStore.allowedAccessSession == session else { return [] }
            return claims
        }.runOnQueue(Self.ioQueue)

        AsyncFunction("acknowledge") { (id: String, resultJSON: String) throws -> Void in
            guard MindwtrSiriActionStore.isAccessAllowed else {
                throw MindwtrSiriActionStoreError.accessUnavailable
            }
            let result = try MindwtrSiriActionStore.decodeResultJSON(resultJSON)
            try MindwtrSiriActionStore.appGroupStore().acknowledge(
                id: id,
                result: result,
                now: Date()
            )
        }.runOnQueue(Self.ioQueue)

        AsyncFunction("publishSnapshot") { (snapshotJSON: String, promise: Promise) -> Void in
            guard UIApplication.shared.applicationState == .active,
                  let generation = self.accessSessionGeneration else {
                promise.reject("ERR_SIRI_ACCESS", "Siri reminder access is unavailable.")
                return
            }
            Self.ioQueue.async {
                do {
                    try MindwtrSiriActionStore.appGroupStore().publishSnapshotForAccessSession(
                        snapshotJSON,
                        generation: generation
                    )
                    promise.resolve(nil)
                } catch {
                    promise.reject("ERR_SIRI_SNAPSHOT", "Siri reminders could not publish a snapshot.")
                }
            }
        }.runOnQueue(.main)

        AsyncFunction("clearSnapshot") { () throws -> Void in
            try MindwtrSiriActionStore.appGroupStore().clearSnapshot()
        }.runOnQueue(Self.ioQueue)

        AsyncFunction("setAccessAllowed") { (allowed: Bool) throws -> Void in
            guard UIApplication.shared.applicationState == .active,
                  let generation = self.accessSessionGeneration else {
                MindwtrSiriActionStore.endAccessSession()
                self.accessSessionGeneration = nil
                if allowed { throw MindwtrSiriActionStoreError.accessUnavailable }
                return
            }
            self.accessSessionGeneration = MindwtrSiriActionStore.setAccessAllowed(allowed, forSession: generation)
            if allowed && !MindwtrSiriActionStore.isAccessAllowed {
                throw MindwtrSiriActionStoreError.accessUnavailable
            }
        }.runOnQueue(.main)
    }

    private static func dictionary(
        from request: MindwtrSiriActionRequest
    ) throws -> [String: Any] {
        let encoder = JSONEncoder()
        let data = try encoder.encode(request)
        guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MindwtrSiriActionStoreError.corruptState("could not bridge a request")
        }
        return dictionary
    }

    private static func performOnMain(_ body: () -> Void) {
        if Thread.isMainThread {
            body()
            return
        }
        DispatchQueue.main.sync(execute: body)
    }
}
