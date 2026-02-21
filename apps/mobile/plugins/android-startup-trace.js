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

const patchMainApplication = (source) => {
  if (source.includes('startupMark("native.main_application.on_create:start")')) {
    return source;
  }

  const next = source.replace(
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
  if (source.includes('startupMark("native.main_activity.on_create:start")')) {
    return source;
  }

  const next = source.replace(
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
          // eslint-disable-next-line no-console
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
          // eslint-disable-next-line no-console
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
