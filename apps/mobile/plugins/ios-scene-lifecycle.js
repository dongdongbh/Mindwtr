const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withPlugins,
  withXcodeProject,
} = require('@expo/config-plugins');

const SCENE_DELEGATE_FILE = 'MindwtrSceneDelegate.swift';
const ALARM_NOTIFICATION_IMPORT = '#import <RnAlarmNotification.h>';
const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).MindwtrSceneDelegate';
const SCENE_CONFIGURATION_NAME = 'Default Configuration';
const SCENE_ROLE = 'UIWindowSceneSessionRoleApplication';
const MIGRATION_MARKER = 'MINDWTR_SCENE_LIFECYCLE_BEGIN';
const RUN_LAUNCH_SUBSCRIBERS = '    return mindwtrRunLaunchSubscribers(application, launchOptions: launchOptions)';
const NOTIFICATION_CENTER_DELEGATE = `
extension AppDelegate: UNUserNotificationCenterDelegate {
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    DispatchQueue.main.async {
      RnAlarmNotification.didReceive(response)
      completionHandler()
    }
  }
}
`;

const LEGACY_ROOT_STARTUP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const SCENE_ROOT_STARTUP = `#if os(iOS)
    // Expo Dev Launcher reads UIApplication.shared.delegate.window from its
    // didFinishLaunching subscriber. Keep a scene-less placeholder until the
    // scene connects; app geometry comes from the connected window scene.
    window = UIWindow()
#endif
    mindwtrApplicationLaunchOptions = launchOptions`;

const APP_DELEGATE_STATE = `  // ${MIGRATION_MARKER}
  private var mindwtrApplicationLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private var mindwtrDeferredDevLauncherSubscriber: ExpoAppDelegateSubscriberProtocol?
  private var mindwtrPendingDevLauncherColdURL: URL?
  private var mindwtrPendingDevLauncherColdURLOptions: [UIApplication.OpenURLOptionsKey: Any] = [:]
  private var mindwtrReactNativeStarted = false
  private var mindwtrSceneDiagnostics: [[String: Any]] = []
  private var mindwtrSceneDiagnosticCounts: [String: Int] = [:]
  private let mindwtrSceneDiagnosticsNotification = Notification.Name(
    "tech.dongdongbh.mindwtr.iosSceneLifecycleDiagnostics.changed"
  )
  // MINDWTR_SCENE_LIFECYCLE_END
`;

const APP_DELEGATE_METHODS = `  // MINDWTR_SCENE_LIFECYCLE_METHODS_BEGIN
  private func mindwtrSubscriber(named className: String) -> ExpoAppDelegateSubscriberProtocol? {
    ExpoAppDelegateSubscriberRepository.subscribers.first { subscriber in
      let reflectedName = String(reflecting: type(of: subscriber))
      return reflectedName == className || reflectedName.hasSuffix(".\\(className)")
    }
  }

  private func mindwtrRunLaunchSubscribers(
    _ application: UIApplication,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    guard let devLauncherSubscriber = mindwtrSubscriber(
      named: "ExpoDevLauncherAppDelegateSubscriber"
    ) else {
      return super.application(
        application,
        didFinishLaunchingWithOptions: launchOptions
      )
    }

    // Expo Dev Launcher must run after its React delegate handler has called
    // autoSetupPrepare. Every other launch subscriber still runs now so a
    // background-only launch registers tasks, notifications, Watch and other
    // non-UI capabilities without requiring a scene.
    ExpoAppDelegateSubscriberRepository.subscribers.forEach { subscriber in
      guard (subscriber as AnyObject) !== (devLauncherSubscriber as AnyObject) else {
        return
      }
      _ = subscriber.application?(
        application,
        didFinishLaunchingWithOptions: launchOptions
      )
    }
    mindwtrDeferredDevLauncherSubscriber = devLauncherSubscriber
    return true
  }

  private func mindwtrCompleteDeferredLaunchSubscriber() {
    guard let subscriber = mindwtrDeferredDevLauncherSubscriber else { return }
    _ = subscriber.application?(
      UIApplication.shared,
      didFinishLaunchingWithOptions: mindwtrApplicationLaunchOptions
    )

    // Expo Dev Launcher returns early from autoSetupStart when launch options
    // contain a URL. Re-deliver that cold URL only to its subscriber, after
    // autoSetupPrepare and autoSetupStart, so it can populate its pending-deep-
    // link registry without creating a duplicate warm React Native delivery.
    let coldURL = mindwtrPendingDevLauncherColdURL
    let coldURLOptions = mindwtrPendingDevLauncherColdURLOptions
    mindwtrDeferredDevLauncherSubscriber = nil
    mindwtrPendingDevLauncherColdURL = nil
    mindwtrPendingDevLauncherColdURLOptions = [:]
    if let coldURL {
      _ = subscriber.application?(
        UIApplication.shared,
        open: coldURL,
        options: coldURLOptions
      )
    }
  }

  func mindwtrLaunchOptionsForScene() -> [UIApplication.LaunchOptionsKey: Any] {
    mindwtrApplicationLaunchOptions ?? [:]
  }

  var mindwtrHasStartedReactNative: Bool {
    mindwtrReactNativeStarted
  }

  func mindwtrStartReactNative(
    in sceneWindow: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]
  ) {
    window = sceneWindow
    guard !mindwtrReactNativeStarted else {
      sceneWindow.makeKeyAndVisible()
      return
    }
    guard let factory = reactNativeFactory else {
      fatalError("Mindwtr scene connected before the React Native factory was bound")
    }

    mindwtrReactNativeStarted = true
    factory.startReactNative(
      withModuleName: "main",
      in: sceneWindow,
      launchOptions: launchOptions
    )
    // startReactNative invokes the Dev Launcher React delegate handler first,
    // satisfying autoSetupPrepare before the one deferred subscriber starts it.
    mindwtrCompleteDeferredLaunchSubscriber()
  }

  func mindwtrSeedColdURL(
    _ url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any]
  ) {
    if mindwtrDeferredDevLauncherSubscriber != nil {
      mindwtrPendingDevLauncherColdURL = url
      mindwtrPendingDevLauncherColdURLOptions = options
    }
    guard let subscriber = mindwtrSubscriber(named: "LinkingAppDelegateSubscriber") else {
      return
    }
    // This runs before the React root exists. It seeds Expo Linking's initial
    // URL registry without emitting a second warm RCTLinkingManager delivery.
    _ = subscriber.application?(UIApplication.shared, open: url, options: options)
  }

  func mindwtrSeedColdUserActivity(_ userActivity: NSUserActivity) {
    guard let subscriber = mindwtrSubscriber(named: "LinkingAppDelegateSubscriber") else {
      return
    }
    _ = subscriber.application?(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  func mindwtrForwardWarmURL(
    _ url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any]
  ) -> Bool {
    application(UIApplication.shared, open: url, options: options)
  }

  func mindwtrForwardWarmUserActivity(_ userActivity: NSUserActivity) -> Bool {
    application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  func mindwtrSceneDidBecomeActive() {
    ExpoAppDelegateSubscriberManager.applicationDidBecomeActive(UIApplication.shared)
  }

  func mindwtrSceneWillResignActive() {
    ExpoAppDelegateSubscriberManager.applicationWillResignActive(UIApplication.shared)
  }

  func mindwtrSceneDidEnterBackground() {
    ExpoAppDelegateSubscriberManager.applicationDidEnterBackground(UIApplication.shared)
  }

  func mindwtrSceneWillEnterForeground() {
    ExpoAppDelegateSubscriberManager.applicationWillEnterForeground(UIApplication.shared)
  }

  func mindwtrRecordSceneDiagnostic(stage: String, deliveryKind: String) {
    let signature = "\\(stage):\\(deliveryKind)"
    let count = (mindwtrSceneDiagnosticCounts[signature] ?? 0) + 1
    mindwtrSceneDiagnosticCounts[signature] = count
    mindwtrSceneDiagnostics.append([
      "stage": stage,
      "deliveryKind": deliveryKind,
      "count": count,
    ])
    if mindwtrSceneDiagnostics.count > 32 {
      mindwtrSceneDiagnostics.removeFirst(mindwtrSceneDiagnostics.count - 32)
    }
    NSLog(
      "[MindwtrScene] stage=%@ deliveryKind=%@ count=%d",
      stage,
      deliveryKind,
      count
    )
    NotificationCenter.default.post(
      name: mindwtrSceneDiagnosticsNotification,
      object: nil
    )
  }

  @objc(drainMindwtrSceneDiagnostics)
  public func drainMindwtrSceneDiagnostics() -> [[String: Any]] {
    let records = mindwtrSceneDiagnostics
    mindwtrSceneDiagnostics.removeAll(keepingCapacity: true)
    return records
  }
  // MINDWTR_SCENE_LIFECYCLE_METHODS_END

`;

const replaceExactlyOnce = (contents, search, replacement, label) => {
  const first = contents.indexOf(search);
  if (first === -1 || contents.indexOf(search, first + search.length) !== -1) {
    throw new Error(
      `[ios-scene-lifecycle] Unsupported Expo AppDelegate template: expected one ${label}`
    );
  }
  return contents.replace(search, replacement);
};

const registerNotificationCenterDelegate = (contents) => {
  if (contents.includes(NOTIFICATION_CENTER_DELEGATE)) return contents;
  const imported = replaceExactlyOnce(contents, 'import ExpoModulesCore\n', 'import ExpoModulesCore\nimport UserNotifications\n', 'ExpoModulesCore import');
  const registered = replaceExactlyOnce(
    imported,
    RUN_LAUNCH_SUBSCRIBERS,
    `    UNUserNotificationCenter.current().delegate = self\n${RUN_LAUNCH_SUBSCRIBERS}`,
    'scene didFinishLaunching return',
  );
  return `${registered.trimEnd()}\n${NOTIFICATION_CENTER_DELEGATE}`;
};

const migrateAppDelegate = (contents) => {
  if (contents.includes(MIGRATION_MARKER)) return registerNotificationCenterDelegate(contents);
  if (!contents.includes('public class AppDelegate: ExpoAppDelegate {')) {
    throw new Error(
      '[ios-scene-lifecycle] Unsupported Expo AppDelegate template: AppDelegate class not found'
    );
  }

  let next = contents;
  if (!next.includes('import ExpoModulesCore')) {
    next = replaceExactlyOnce(next, 'import Expo\n', 'import Expo\nimport ExpoModulesCore\n', 'Expo import');
  }
  next = replaceExactlyOnce(
    next,
    'public class AppDelegate: ExpoAppDelegate {\n',
    `public class AppDelegate: ExpoAppDelegate {\n${APP_DELEGATE_STATE}`,
    'AppDelegate class declaration'
  );
  next = replaceExactlyOnce(next, LEGACY_ROOT_STARTUP, SCENE_ROOT_STARTUP, 'legacy React root startup');
  next = replaceExactlyOnce(
    next,
    '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    RUN_LAUNCH_SUBSCRIBERS,
    'didFinishLaunching return'
  );
  next = replaceExactlyOnce(next, '  // Linking API\n', `${APP_DELEGATE_METHODS}  // Linking API\n`, 'Linking API marker');
  return registerNotificationCenterDelegate(next);
};

const migrateBridgingHeader = (contents) => {
  if (contents.includes(ALARM_NOTIFICATION_IMPORT)) return contents;
  return `${contents.trimEnd()}\n\n${ALARM_NOTIFICATION_IMPORT}\n`;
};

const addSceneManifest = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        [SCENE_ROLE]: [
          {
            UISceneConfigurationName: SCENE_CONFIGURATION_NAME,
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return cfg;
  });

const installSceneDelegateSource = (config) =>
  withXcodeProject(config, (cfg) => {
    const appName = IOSConfig.XcodeUtils.sanitizedName(cfg.name);
    const sourcePath = path.join(__dirname, 'ios-scene-lifecycle', SCENE_DELEGATE_FILE);
    const targetPath = path.join(cfg.modRequest.platformProjectRoot, appName, SCENE_DELEGATE_FILE);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`[ios-scene-lifecycle] Missing scene delegate template: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, targetPath);

    const project = cfg.modResults;
    const mainGroupKey =
      project.findPBXGroupKey({ name: appName })
      || project.findPBXGroupKey({ path: appName });
    if (!mainGroupKey) {
      throw new Error(`[ios-scene-lifecycle] Could not find main iOS group: ${appName}`);
    }
    const projectPath = `${appName}/${SCENE_DELEGATE_FILE}`;
    if (!project.hasFile(projectPath)) {
      project.addSourceFile(
        projectPath,
        { target: project.getFirstTarget().uuid },
        mainGroupKey
      );
    }

    return cfg;
  });

const migrateGeneratedAppDelegate = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const appName = IOSConfig.XcodeUtils.sanitizedName(cfg.name);
      const appDelegatePath = path.join(
        cfg.modRequest.platformProjectRoot,
        appName,
        'AppDelegate.swift'
      );
      const bridgingHeaderPath = path.join(
        cfg.modRequest.platformProjectRoot,
        appName,
        `${appName}-Bridging-Header.h`
      );
      if (!fs.existsSync(appDelegatePath)) {
        throw new Error(`[ios-scene-lifecycle] Missing generated AppDelegate: ${appDelegatePath}`);
      }
      if (!fs.existsSync(bridgingHeaderPath)) {
        throw new Error(`[ios-scene-lifecycle] Missing generated bridging header: ${bridgingHeaderPath}`);
      }
      const contents = fs.readFileSync(appDelegatePath, 'utf8');
      fs.writeFileSync(appDelegatePath, migrateAppDelegate(contents));
      const bridgingHeader = fs.readFileSync(bridgingHeaderPath, 'utf8');
      fs.writeFileSync(bridgingHeaderPath, migrateBridgingHeader(bridgingHeader));
      return cfg;
    },
  ]);

function withIosSceneLifecycle(config) {
  return withPlugins(config, [
    addSceneManifest,
    installSceneDelegateSource,
    migrateGeneratedAppDelegate,
  ]);
}

module.exports = withIosSceneLifecycle;
module.exports.__testables = {
  APP_DELEGATE_METHODS,
  APP_DELEGATE_STATE,
  ALARM_NOTIFICATION_IMPORT,
  LEGACY_ROOT_STARTUP,
  MIGRATION_MARKER,
  SCENE_CONFIGURATION_NAME,
  SCENE_DELEGATE_CLASS,
  SCENE_DELEGATE_FILE,
  SCENE_ROLE,
  SCENE_ROOT_STARTUP,
  migrateAppDelegate,
  migrateBridgingHeader,
  replaceExactlyOnce,
};
