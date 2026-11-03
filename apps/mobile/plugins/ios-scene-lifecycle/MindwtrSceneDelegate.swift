import UIKit

private enum MindwtrSceneDeliveryKind: String {
    case none
    case url
    case userActivity
    case shortcut
    case notification
}

public final class MindwtrSceneDelegate: UIResponder, UIWindowSceneDelegate {
    public var window: UIWindow?

    private let quickActionTypeToURL: [String: String] = [
        "tech.dongdongbh.mindwtr.add_task": "mindwtr:///capture-quick?mode=text",
        "tech.dongdongbh.mindwtr.open_focus": "mindwtr:///focus",
        "tech.dongdongbh.mindwtr.open_calendar": "mindwtr:///calendar",
    ]

    public func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
            assertionFailure("MindwtrSceneDelegate requires the generated AppDelegate")
            return
        }


        let sceneWindow = appDelegate.window ?? UIWindow()
        sceneWindow.windowScene = windowScene
        sceneWindow.frame = windowScene.coordinateSpace.bounds
        window = sceneWindow

        if appDelegate.mindwtrHasStartedReactNative {
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "sceneConnected",
                deliveryKind: MindwtrSceneDeliveryKind.none.rawValue
            )
            appDelegate.mindwtrStartReactNative(
                in: sceneWindow,
                launchOptions: appDelegate.mindwtrLaunchOptionsForScene()
            )
            forwardReconnectDeliveries(connectionOptions, appDelegate: appDelegate)
            return
        }

        var launchOptions = appDelegate.mindwtrLaunchOptionsForScene()
        let deliveryKind = prepareColdDelivery(
            connectionOptions,
            launchOptions: &launchOptions,
            appDelegate: appDelegate
        )
        appDelegate.mindwtrRecordSceneDiagnostic(
            stage: "sceneConnected",
            deliveryKind: deliveryKind.rawValue
        )
        appDelegate.mindwtrStartReactNative(
            in: sceneWindow,
            launchOptions: launchOptions
        )
        appDelegate.mindwtrRecordSceneDiagnostic(
            stage: "rootStarted",
            deliveryKind: deliveryKind.rawValue
        )
        if deliveryKind != .none {
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "coldDelivery",
                deliveryKind: deliveryKind.rawValue
            )
        }
    }

    public func scene(
        _ scene: UIScene,
        openURLContexts URLContexts: Set<UIOpenURLContext>
    ) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }


        for context in URLContexts {
            _ = appDelegate.mindwtrForwardWarmURL(
                context.url,
                options: openOptions(for: context)
            )
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "warmDelivery",
                deliveryKind: MindwtrSceneDeliveryKind.url.rawValue
            )
        }
    }

    public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        _ = appDelegate.mindwtrForwardWarmUserActivity(userActivity)
        appDelegate.mindwtrRecordSceneDiagnostic(
            stage: "warmDelivery",
            deliveryKind: MindwtrSceneDeliveryKind.userActivity.rawValue
        )
    }

    public func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
              let destinationURL = quickActionURL(shortcutItem) else {
            completionHandler(false)
            return
        }
        let handled = appDelegate.mindwtrForwardWarmURL(destinationURL, options: [:])
        appDelegate.mindwtrRecordSceneDiagnostic(
            stage: "warmDelivery",
            deliveryKind: MindwtrSceneDeliveryKind.shortcut.rawValue
        )
        completionHandler(handled)
    }

    public func sceneDidBecomeActive(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        appDelegate.mindwtrSceneDidBecomeActive()
        appDelegate.mindwtrRecordSceneDiagnostic(stage: "didBecomeActive", deliveryKind: "none")
    }

    public func sceneWillResignActive(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        appDelegate.mindwtrSceneWillResignActive()
        appDelegate.mindwtrRecordSceneDiagnostic(stage: "willResignActive", deliveryKind: "none")
    }

    public func sceneDidEnterBackground(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        appDelegate.mindwtrSceneDidEnterBackground()
        appDelegate.mindwtrRecordSceneDiagnostic(stage: "didEnterBackground", deliveryKind: "none")
    }

    public func sceneWillEnterForeground(_ scene: UIScene) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        appDelegate.mindwtrSceneWillEnterForeground()
        appDelegate.mindwtrRecordSceneDiagnostic(stage: "willEnterForeground", deliveryKind: "none")
    }

    private func prepareColdDelivery(
        _ connectionOptions: UIScene.ConnectionOptions,
        launchOptions: inout [UIApplication.LaunchOptionsKey: Any],
        appDelegate: AppDelegate
    ) -> MindwtrSceneDeliveryKind {
        if let response = connectionOptions.notificationResponse {


            RnAlarmNotification.didReceive(
                response,
                cacheForColdStart: true
            )
            return .notification
        }

        if let shortcutItem = connectionOptions.shortcutItem,
           let destinationURL = quickActionURL(shortcutItem) {
            launchOptions[.shortcutItem] = shortcutItem
            launchOptions[.url] = destinationURL
            appDelegate.mindwtrSeedColdURL(destinationURL, options: [:])
            return .shortcut
        }

        if let context = connectionOptions.urlContexts.first {
            let options = openOptions(for: context)
            launchOptions[.url] = context.url
            for (key, value) in options {
                launchOptions[UIApplication.LaunchOptionsKey(rawValue: key.rawValue)] = value
            }
            appDelegate.mindwtrSeedColdURL(context.url, options: options)
            return .url
        }

        if let userActivity = connectionOptions.userActivities.first {
            launchOptions[.userActivityDictionary] = [
                "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
                "UIApplicationLaunchOptionsUserActivityKey": userActivity,
            ]
            appDelegate.mindwtrSeedColdUserActivity(userActivity)
            return .userActivity
        }

        return .none
    }

    private func forwardReconnectDeliveries(
        _ connectionOptions: UIScene.ConnectionOptions,
        appDelegate: AppDelegate
    ) {
        if let response = connectionOptions.notificationResponse {


            RnAlarmNotification.didReceive(response)
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "warmDelivery",
                deliveryKind: MindwtrSceneDeliveryKind.notification.rawValue
            )
        }
        for context in connectionOptions.urlContexts {
            _ = appDelegate.mindwtrForwardWarmURL(
                context.url,
                options: openOptions(for: context)
            )
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "warmDelivery",
                deliveryKind: MindwtrSceneDeliveryKind.url.rawValue
            )
        }
        for userActivity in connectionOptions.userActivities {
            _ = appDelegate.mindwtrForwardWarmUserActivity(userActivity)
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "warmDelivery",
                deliveryKind: MindwtrSceneDeliveryKind.userActivity.rawValue
            )
        }
        if let shortcutItem = connectionOptions.shortcutItem,
           let destinationURL = quickActionURL(shortcutItem) {
            _ = appDelegate.mindwtrForwardWarmURL(destinationURL, options: [:])
            appDelegate.mindwtrRecordSceneDiagnostic(
                stage: "warmDelivery",
                deliveryKind: MindwtrSceneDeliveryKind.shortcut.rawValue
            )
        }
    }

    private func openOptions(
        for context: UIOpenURLContext
    ) -> [UIApplication.OpenURLOptionsKey: Any] {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: context.options.openInPlace,
        ]

        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }
        if let sourceApplication = context.options.sourceApplication {
            options[.sourceApplication] = sourceApplication
        }
        return options
    }

    private func quickActionURL(_ shortcutItem: UIApplicationShortcutItem) -> URL? {
        if let rawURL = shortcutItem.userInfo?["url"] as? String,
           let parsedURL = URL(string: rawURL) {
            return parsedURL
        }
        guard let mappedURL = quickActionTypeToURL[shortcutItem.type] else { return nil }
        return URL(string: mappedURL)
    }
}
