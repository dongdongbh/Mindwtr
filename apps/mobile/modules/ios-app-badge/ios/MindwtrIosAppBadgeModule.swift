import ExpoModulesCore
import UIKit
import UserNotifications

public final class MindwtrIosAppBadgeModule: Module {
    public func definition() -> ModuleDefinition {
        Name("MindwtrIosAppBadge")

        AsyncFunction("isBadgeAuthorized") { (promise: Promise) in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                promise.resolve(settings.badgeSetting == .enabled)
            }
        }

        // Only this explicit settings action may prompt. Alerts and sounds are not requested.
        AsyncFunction("requestBadgeAuthorization") { (promise: Promise) in
            let center = UNUserNotificationCenter.current()
            center.requestAuthorization(options: [.badge]) { _, error in
                if let error = error {
                    promise.reject("ERR_BADGE_AUTHORIZATION", "Badge authorization failed: \(error.localizedDescription)")
                    return
                }
                center.getNotificationSettings { settings in
                    promise.resolve(settings.badgeSetting == .enabled)
                }
            }
        }

        AsyncFunction("setBadgeCount") { (count: Double, promise: Promise) in
            guard count.isFinite, count >= 0, count.rounded(.towardZero) == count, count <= Double(Int32.max) else {
                promise.reject("ERR_BADGE_COUNT", "Badge count must be a nonnegative integer")
                return
            }
            let value = Int(count)
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(value) { error in
                    if let error = error {
                        promise.reject("ERR_BADGE_UPDATE", "Badge update failed: \(error.localizedDescription)")
                    } else {
                        promise.resolve(nil)
                    }
                }
            } else {
                DispatchQueue.main.async {
                    UIApplication.shared.applicationIconBadgeNumber = value
                    promise.resolve(nil)
                }
            }
        }
    }
}
