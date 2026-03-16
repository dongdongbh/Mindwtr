import ExpoModulesCore
import UIKit

public final class CloudKitSyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) -> Bool {
        let handled = CloudKitSyncModule.handleRemoteNotificationPayload(userInfo)
        completionHandler(handled ? .newData : .noData)
        return handled
    }
}
