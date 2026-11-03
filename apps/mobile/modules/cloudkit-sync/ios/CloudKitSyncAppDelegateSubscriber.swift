import ExpoModulesCore
import UIKit

public final class CloudKitSyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {


    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        application.registerForRemoteNotifications()
        return true
    }


    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        let handled = CloudKitSyncModule.handleRemoteNotificationPayload(userInfo)
        completionHandler(handled ? .newData : .noData)
    }
}
