const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const buildStartupTraceSource = (packageName) => `package ${packageName}

import android.os.SystemClock
import android.os.Trace
import android.util.Log

private const val STARTUP_TAG = "MindwtrStartup"

fun startupMark(phase: String, extra: String? = null) {
  val uptimeMs = SystemClock.elapsedRealtime()
  val payload = if (extra.isNullOrBlank()) "" else " $extra"
  Log.i(STARTUP_TAG, "phase=$phase uptimeMs=$uptimeMs$payload")
}

inline fun <T> startupSection(phase: String, block: () -> T): T {
  startupMark("$phase:start")
  val startMs = SystemClock.elapsedRealtime()
  Trace.beginSection("Mindwtr.$phase")
  try {
    return block()
  } finally {
    Trace.endSection()
    val durationMs = SystemClock.elapsedRealtime() - startMs
    startupMark("$phase:end", "durationMs=$durationMs")
  }
}
`;

const notificationCacheFunction = `  private fun cacheNotificationOpenPayload(intent: Intent?): LinkedHashMap<String, String>? {
    val extras = intent?.extras ?: return null
    val payload = LinkedHashMap<String, String>()
    fun copyPayloadValue(key: String, value: Any?) {
      if (value != null && value != JSONObject.NULL) payload[key] = value.toString()
    }
    fun copyNestedData(value: Any?) {
      when (value) {
        is Bundle -> {
          listOf("alarmKey", "id", "taskId", "projectId", "kind").forEach { key ->
            copyPayloadValue(key, value.get(key))
          }
        }
        is String -> {
          runCatching {
            val json = JSONObject(value)
            listOf("alarmKey", "id", "taskId", "projectId", "kind").forEach { key ->
              copyPayloadValue(key, json.opt(key))
            }
          }
        }
        else -> {
          runCatching {
            val json = JSONObject(value.toString())
            listOf("alarmKey", "id", "taskId", "projectId", "kind").forEach { key ->
              copyPayloadValue(key, json.opt(key))
            }
          }
        }
      }
    }
    listOf("alarmKey", "id", "taskId", "projectId", "kind").forEach { key ->
      copyPayloadValue(key, extras.get(key))
    }
    copyNestedData(extras.get("data"))
    if (payload.isEmpty()) return null
    NotificationOpenPayloadStore.cache(payload)
    return payload
  }`;

const patchMainApplication = (source) => {
  let next = source;

  if (!next.includes('@Suppress("DEPRECATION")\nclass MainApplication')) {
    next = next.replace(
      /\nclass MainApplication : Application\(\), ReactApplication \{/,
      '\n@Suppress("DEPRECATION")\nclass MainApplication : Application(), ReactApplication {'
    );
  }

  if (next.includes('startupMark("native.main_application.on_create:start")')) {
    return next;
  }

  next = next.replace(
    /override fun onCreate\(\) \{[\s\S]*?\n  \}\n\n  override fun onConfigurationChanged/,
    `override fun onCreate() {
    startupMark("native.main_application.on_create:start")
    startupSection("native.main_application.super_on_create") {
      super.onCreate()
    }
    startupSection("native.react_native.release_level_init") {
      DefaultNewArchitectureEntryPoint.releaseLevel = try {
        ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
      } catch (e: IllegalArgumentException) {
        ReleaseLevel.STABLE
      }
    }
    startupSection("native.react_native.load") {
      loadReactNative(this)
    }
    startupSection("native.expo.lifecycle.on_application_create") {
      ApplicationLifecycleDispatcher.onApplicationCreate(this)
    }
    startupMark("native.main_application.on_create:end")
  }

  override fun onConfigurationChanged`
  );

  return next;
};

const patchMainActivity = (source) => {
  let next = source;

  if (!next.includes('startupMark("native.main_activity.on_create:start")')) {
    next = next.replace(
      /override fun onCreate\(savedInstanceState: Bundle\?\) \{[\s\S]*?\n  \}/,
      `override fun onCreate(savedInstanceState: Bundle?) {
    startupMark("native.main_activity.on_create:start")
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    startupSection("native.main_activity.splash_register") {
      SplashScreenManager.registerOnActivity(this)
    }
    // @generated end expo-splashscreen
    startupSection("native.main_activity.super_on_create") {
      super.onCreate(null)
    }
    startupMark("native.main_activity.on_create:end")
  }`
    );
  }

  if (!next.includes('import android.content.Intent')) {
    next = next.replace(
      'import android.os.Build\n',
      'import android.content.Intent\nimport android.os.Build\n'
    );
  }

  if (!next.includes('import com.facebook.react.ReactApplication')) {
    next = next.replace(
      'import com.facebook.react.ReactActivity\n',
      'import com.facebook.react.ReactApplication\nimport com.facebook.react.ReactActivity\n'
    );
  }

  if (!next.includes('import com.facebook.react.modules.core.DeviceEventManagerModule')) {
    next = next.replace(
      'import com.facebook.react.defaults.DefaultReactActivityDelegate\n',
      'import com.facebook.react.defaults.DefaultReactActivityDelegate\nimport com.facebook.react.modules.core.DeviceEventManagerModule\n'
    );
  }

  if (!next.includes('import org.json.JSONObject')) {
    next = next.replace(
      '\nimport expo.modules.ReactActivityDelegateWrapper\n',
      '\nimport org.json.JSONObject\n\nimport expo.modules.ReactActivityDelegateWrapper\n'
    );
  }

  if (!next.includes('import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore')) {
    next = next.replace(
      'import org.json.JSONObject\n',
      'import org.json.JSONObject\nimport tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore\n'
    );
  }

  next = next.replace(
    'override fun onNewIntent(intent: Intent?) {',
    'override fun onNewIntent(intent: Intent) {'
  );

  next = next.replace(
    /\n  companion object \{\n    @Volatile\n    private var pendingNotificationOpenPayload: LinkedHashMap<String, String>\? = null\n\n    fun consumePendingNotificationOpenPayload\(\): LinkedHashMap<String, String>\? \{\n      val payload = pendingNotificationOpenPayload \?: return null\n      pendingNotificationOpenPayload = null\n      return LinkedHashMap\(payload\)\n    \}\n  \}\n/,
    '\n'
  );

  if (!next.includes('cacheNotificationOpenPayload(intent)')) {
    next = next.replace(
      '    startupMark("native.main_activity.on_create:end")\n',
      '    cacheNotificationOpenPayload(intent)\n    startupMark("native.main_activity.on_create:end")\n'
    );
  }

  if (!next.includes('override fun onNewIntent(intent: Intent)')) {
    next = next.replace(
      '\n  override fun getMainComponentName(): String = "main"\n',
      `
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val payload = cacheNotificationOpenPayload(intent) ?: return
    emitNotificationOpenPayload(payload)
  }

  override fun getMainComponentName(): String = "main"\n`
    );
  }

  if (
    next.includes('private fun cacheNotificationOpenPayload(intent: Intent?)')
    && !next.includes('copyNestedData(extras.get("data"))')
  ) {
    next = next.replace(
      /  private fun cacheNotificationOpenPayload\(intent: Intent\?\): LinkedHashMap<String, String>\? \{[\s\S]*?\n  \}\n\n  private fun emitNotificationOpenPayload/,
      `${notificationCacheFunction}\n\n  private fun emitNotificationOpenPayload`
    );
  }

  if (!next.includes('private fun cacheNotificationOpenPayload(intent: Intent?)')) {
    next = next.replace(
      '\n}\n',
      `
${notificationCacheFunction}

  private fun emitNotificationOpenPayload(payload: Map<String, String>) {
    val reactApplication = application as? ReactApplication ?: return
    val reactContext = reactApplication.reactNativeHost.reactInstanceManager.currentReactContext ?: return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("OnNotificationOpened", JSONObject(payload).toString())
  }
}
`
    );
  }

  next = next.replace(
    '    pendingNotificationOpenPayload = LinkedHashMap(payload)\n',
    '    NotificationOpenPayloadStore.cache(payload)\n'
  );

  return next;
};

module.exports = function withAndroidStartupTrace(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const packageName = cfg.android?.package || cfg.modRequest.projectName;
      if (!packageName) {
        return cfg;
      }
      const startupTraceSource = buildStartupTraceSource(packageName);
      const packageDir = packageName.replace(/\./g, path.sep);
      const sourceDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        packageDir
      );
      const mainApplicationPath = path.join(sourceDir, 'MainApplication.kt');
      const mainActivityPath = path.join(sourceDir, 'MainActivity.kt');
      const startupTracePath = path.join(sourceDir, 'StartupTrace.kt');

      if (fs.existsSync(mainApplicationPath)) {
        const original = fs.readFileSync(mainApplicationPath, 'utf8');
        const patched = patchMainApplication(original);
        if (patched !== original) {
          fs.writeFileSync(mainApplicationPath, patched);
        }
        if (!patched.includes('startupMark("native.main_application.on_create:start")')) {
          console.warn(`[android-startup-trace] unable to patch ${mainApplicationPath}`);
        }
      }

      if (fs.existsSync(mainActivityPath)) {
        const original = fs.readFileSync(mainActivityPath, 'utf8');
        const patched = patchMainActivity(original);
        if (patched !== original) {
          fs.writeFileSync(mainActivityPath, patched);
        }
        if (!patched.includes('startupMark("native.main_activity.on_create:start")')) {
          console.warn(`[android-startup-trace] unable to patch ${mainActivityPath}`);
        }
      }

      if (fs.existsSync(sourceDir)) {
        const existing = fs.existsSync(startupTracePath) ? fs.readFileSync(startupTracePath, 'utf8') : null;
        if (existing !== startupTraceSource) {
          fs.writeFileSync(startupTracePath, startupTraceSource);
        }
      }

      return cfg;
    },
  ]);
};

module.exports.__testables = {
  buildStartupTraceSource,
  patchMainApplication,
  patchMainActivity,
};
