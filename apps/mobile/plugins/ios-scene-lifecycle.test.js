import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('./ios-scene-lifecycle');

const {
  ALARM_NOTIFICATION_IMPORT,
  LEGACY_ROOT_STARTUP,
  MIGRATION_MARKER,
  SCENE_CONFIGURATION_NAME,
  SCENE_DELEGATE_CLASS,
  SCENE_DELEGATE_FILE,
  SCENE_ROLE,
  migrateAppDelegate,
  migrateBridgingHeader,
} = plugin.__testables;

const appDelegateFixture = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

    if #available(iOS 16.0, *) {
      MindwtrSiriCaptureShortcuts.updateAppShortcutParameters()
    }

    ${LEGACY_ROOT_STARTUP}

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {}
`;

describe('ios-scene-lifecycle', () => {
  it.each(['Mindwtr', 'Mindwtr Dev', 'Mindwtr Benchmark'])('migrates the generated header for %s', async (name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-scene-'));
    const appName = name.replaceAll(' ', '');
    const appDir = path.join(root, appName);
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, 'AppDelegate.swift'), appDelegateFixture);
    const header = path.join(appDir, `${appName}-Bridging-Header.h`);
    fs.writeFileSync(header, '// Generated bridging header\n');
    try {
      const config = plugin({ name, slug: 'mindwtr', _internal: { projectRoot: root } });
      await config.mods.ios.dangerous({
        ...config,
        modRequest: { platformProjectRoot: root, projectRoot: root, platform: 'ios' },
      });
      expect(fs.readFileSync(header, 'utf8')).toContain(ALARM_NOTIFICATION_IMPORT);
      expect(fs.readFileSync(path.join(appDir, 'AppDelegate.swift'), 'utf8')).toContain(MIGRATION_MARKER);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates the locked Expo 54 AppDelegate exactly once', () => {
    const migrated = migrateAppDelegate(appDelegateFixture);

    expect(migrated).toContain(`// ${MIGRATION_MARKER}`);
    expect(migrated).toContain('import ExpoModulesCore');
    expect(migrated).toContain('var window: UIWindow?');
    expect(migrated).toContain('window = UIWindow()');
    expect(migrated).not.toContain('UIScreen.main');
    expect(migrated).not.toContain(LEGACY_ROOT_STARTUP);
    expect(migrated).toContain('return mindwtrRunLaunchSubscribers(application, launchOptions: launchOptions)');
    expect(migrated).toContain('named: "ExpoDevLauncherAppDelegateSubscriber"');
    expect(migrated).toContain('guard (subscriber as AnyObject) !== (devLauncherSubscriber as AnyObject)');
    const sceneStart = migrated.slice(migrated.indexOf('func mindwtrStartReactNative'));
    expect(sceneStart).toContain('factory.startReactNative(');
    expect(sceneStart.indexOf('factory.startReactNative(')).toBeLessThan(
      sceneStart.indexOf('mindwtrCompleteDeferredLaunchSubscriber()'),
    );
    const deferredLaunch = migrated.slice(
      migrated.indexOf('private func mindwtrCompleteDeferredLaunchSubscriber'),
      migrated.indexOf('func mindwtrLaunchOptionsForScene'),
    );
    expect(deferredLaunch.indexOf('didFinishLaunchingWithOptions:')).toBeLessThan(
      deferredLaunch.indexOf('open: coldURL'),
    );
    expect(deferredLaunch).toContain('mindwtrPendingDevLauncherColdURL = nil');
    const coldURLSeed = migrated.slice(
      migrated.indexOf('func mindwtrSeedColdURL'),
      migrated.indexOf('func mindwtrSeedColdUserActivity'),
    );
    expect(coldURLSeed).toContain('mindwtrPendingDevLauncherColdURL = url');
    expect(coldURLSeed).toContain('named: "LinkingAppDelegateSubscriber"');
    expect(coldURLSeed).not.toContain('mindwtrForwardWarmURL');
    expect(migrated).toContain('@objc(drainMindwtrSceneDiagnostics)');
    expect(migrated).toContain('var mindwtrHasStartedReactNative: Bool');
    expect(migrateAppDelegate(migrated)).toBe(migrated);
  });

  it('fails clearly when the Expo generator shape drifts', () => {
    const withoutLegacyRoot = appDelegateFixture.replace(LEGACY_ROOT_STARTUP, '// changed upstream');
    expect(() => migrateAppDelegate(withoutLegacyRoot)).toThrow(
      'Unsupported Expo AppDelegate template: expected one legacy React root startup',
    );
  });

  it('receives notification responses while the existing scene is connected', () => {
    const migrated = migrateAppDelegate(appDelegateFixture);

    expect(migrated).toContain('extension AppDelegate: UNUserNotificationCenterDelegate');
    expect(migrated).toContain('UNUserNotificationCenter.current().delegate = self');
    const callback = migrated.slice(migrated.indexOf('extension AppDelegate: UNUserNotificationCenterDelegate'));
    expect(callback).toContain('didReceive response: UNNotificationResponse');
    expect(callback).toContain('RnAlarmNotification.didReceive(response)');
    expect(callback.match(/completionHandler\(\)/g)).toHaveLength(1);

    const olderGeneratedDelegate = migrated.replace(callback, '').replace('import UserNotifications\n', '')
      .replace('    UNUserNotificationCenter.current().delegate = self\n', '');
    expect(migrateAppDelegate(olderGeneratedDelegate)).toBe(migrated);
  });

  it('exposes the maintained RNAlarm cold-start API to generated Swift once', () => {
    const fixture = '// Generated bridging header\n';
    const migrated = migrateBridgingHeader(fixture);

    expect(migrated).toContain(ALARM_NOTIFICATION_IMPORT);
    expect(migrateBridgingHeader(migrated)).toBe(migrated);
  });

  it('ships a single-scene host delegate with cold and warm delivery owners', () => {
    const sourcePath = path.join(__dirname, 'ios-scene-lifecycle', SCENE_DELEGATE_FILE);
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(SCENE_DELEGATE_CLASS).toBe('$(PRODUCT_MODULE_NAME).MindwtrSceneDelegate');
    expect(SCENE_CONFIGURATION_NAME).toBe('Default Configuration');
    expect(SCENE_ROLE).toBe('UIWindowSceneSessionRoleApplication');
    expect(source).not.toContain('@objc(MindwtrSceneDelegate)');
    expect(source).toContain('UIWindowSceneDelegate');
    expect(source).toContain('sceneWindow.windowScene = windowScene');
    expect(source).toContain('windowScene.coordinateSpace.bounds');
    expect(source).toContain('mindwtrStartReactNative(');
    expect(source).toContain('launchOptions[.url] = context.url');
    expect(source).toContain('launchOptions[.userActivityDictionary]');
    expect(source).toContain('connectionOptions.shortcutItem');
    expect(source).toContain('connectionOptions.notificationResponse');
    expect(source).toContain('cacheForColdStart: true');
    expect(source).toContain('mindwtrForwardWarmURL(');
    expect(source).toContain('mindwtrForwardWarmUserActivity(');
    expect(source).toContain('if appDelegate.mindwtrHasStartedReactNative');
    expect(source).toContain('forwardReconnectDeliveries(connectionOptions');
    expect(source).toContain('stage: "coldDelivery"');
    expect(source).toContain('stage: "warmDelivery"');
    expect(source).not.toContain('application.open(');
    expect(source).not.toContain('asyncAfter');
    expect(source).not.toContain('UIScreen.main');

    const coldDelivery = source.slice(
      source.indexOf('private func prepareColdDelivery'),
      source.indexOf('private func forwardReconnectDeliveries'),
    );
    expect(coldDelivery).toContain('RnAlarmNotification.didReceive(');
    expect(coldDelivery).toContain('cacheForColdStart: true');
    const reconnectDelivery = source.slice(
      source.indexOf('private func forwardReconnectDeliveries'),
      source.indexOf('private func openOptions'),
    );
    expect(reconnectDelivery).toContain(
      'RnAlarmNotification.didReceive(response)',
    );
    expect(reconnectDelivery).not.toContain('cacheForColdStart: true');
    expect(source).not.toContain('RnAlarmNotification.didReceiveNotificationResponse');
  });

  it('forwards scene lifecycle to Expo subscribers without synthesizing app notifications', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'ios-scene-lifecycle', SCENE_DELEGATE_FILE),
      'utf8',
    );
    for (const callback of [
      'sceneDidBecomeActive',
      'sceneWillResignActive',
      'sceneDidEnterBackground',
      'sceneWillEnterForeground',
    ]) {
      expect(source).toContain(callback);
    }
    expect(source).not.toContain('UIApplication.didBecomeActiveNotification');
    expect(source).not.toContain('UIApplication.didEnterBackgroundNotification');
    expect(source).not.toContain('UIApplication.willResignActiveNotification');
    expect(source).not.toContain('UIApplication.willEnterForegroundNotification');
  });

  it('keeps quick actions out of the old AppDelegate timer/double-delivery path', () => {
    const widgetsPlugin = fs.readFileSync(
      path.join(__dirname, 'ios-widgets-and-shortcuts.js'),
      'utf8',
    );
    expect(widgetsPlugin).not.toContain('handleHomeScreenQuickAction');
    expect(widgetsPlugin).not.toContain('DispatchQueue.main.asyncAfter');
    expect(widgetsPlugin).not.toContain('application.open(destinationUrl');
  });

  it('ships an in-memory bounded diagnostic bridge with fixed fields only', () => {
    const pluginSource = fs.readFileSync(path.join(__dirname, 'ios-scene-lifecycle.js'), 'utf8');
    const moduleSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'modules', 'ios-scene-lifecycle', 'ios', 'MindwtrIosSceneLifecycleModule.swift'),
      'utf8',
    );

    expect(pluginSource).toContain('if mindwtrSceneDiagnostics.count > 32');
    expect(pluginSource).toContain('"stage": stage');
    expect(pluginSource).toContain('"deliveryKind": deliveryKind');
    expect(pluginSource).toContain('"count": count');
    expect(pluginSource).not.toContain('UserDefaults');
    expect(moduleSource).toContain('drainMindwtrSceneDiagnostics');
    expect(moduleSource).toContain('stage=bridgeReady deliveryKind=none');
  });
});
