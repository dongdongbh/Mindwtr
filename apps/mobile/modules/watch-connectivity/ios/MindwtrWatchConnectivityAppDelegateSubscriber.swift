import ExpoModulesCore
import UIKit

public final class MindwtrWatchConnectivityAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {


        MindwtrWatchConnectivityReceiver.shared.activateAtLaunch()
        return true
    }
}
