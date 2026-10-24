const fs = require('fs');
const path = require('path');
import { describe, expect, it } from 'vitest';

const plugin = require('./android-startup-trace');

const {
  patchMainActivity,
} = plugin.__testables;

// ContextAutomationReceiver.kt and ContextAutomationHeadlessService.kt used to be
// generated here as template strings (see git history); they are now real .kt
// files in the local context-automation Expo module. These tests read that
// module's source directly to keep the 9-fallback deep-link payload parser and
// the headless task wiring covered now that this plugin no longer builds them.
const contextAutomationModuleDir = path.join(
  __dirname,
  '..',
  'modules',
  'context-automation',
  'android',
  'src',
  'main',
  'java',
  'tech',
  'dongdongbh',
  'mindwtr',
  'contextautomation'
);

const readModuleFile = (fileName) => (
  fs.readFileSync(path.join(contextAutomationModuleDir, fileName), 'utf8')
);

describe('android-startup-trace', () => {
  it('keeps the context automation receiver and headless service in the local Expo module', () => {
    const receiver = readModuleFile('ContextAutomationReceiver.kt');
    const service = readModuleFile('ContextAutomationHeadlessService.kt');

    expect(receiver).toContain('package tech.dongdongbh.mindwtr.contextautomation');
    expect(receiver).toContain('class ContextAutomationReceiver : BroadcastReceiver()');
    expect(receiver).toContain('tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT');
    expect(receiver).toContain('tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT');
    expect(receiver).toContain('ContextAutomationHeadlessService::class.java');
    expect(receiver).toContain('HeadlessJsTaskService.acquireWakeLockNow(context)');

    // The 9-fallback deep-link payload parser (#819-adjacent): every branch,
    // in order. A dropped fallback here breaks a real intent shape silently.
    const fallbackOrder = [
      'clean(intent.getStringExtra("context"))',
      'clean(intent.getStringExtra("name"))',
      'clean(intent.getStringExtra("token"))',
      'clean(intent.getStringExtra(Intent.EXTRA_TEXT))',
      'clean(data?.getQueryParameter("context"))',
      'clean(data?.getQueryParameter("name"))',
      'clean(data?.getQueryParameter("token"))',
      'clean(pathContext)',
      'clean(hostContext)',
    ];
    let lastIndex = -1;
    fallbackOrder.forEach((fallback) => {
      const index = receiver.indexOf(fallback);
      expect(index, `${fallback} present`).toBeGreaterThan(-1);
      expect(index, `${fallback} in order`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    });

    expect(service).toContain('package tech.dongdongbh.mindwtr.contextautomation');
    expect(service).toContain('class ContextAutomationHeadlessService : HeadlessJsTaskService()');
    expect(service).toContain('MindwtrContextAutomation');
    expect(service).toContain('CONTEXT_AUTOMATION_HEADLESS_TIMEOUT_MS = 15_000L');
    expect(service).toContain('HeadlessJsTaskConfig(');
  });

  it('no longer writes the context automation classes into the app package', () => {
    const source = fs.readFileSync(path.join(__dirname, 'android-startup-trace.js'), 'utf8');
    expect(source).not.toContain('buildContextAutomationReceiverSource');
    expect(source).not.toContain('buildContextAutomationHeadlessServiceSource');
  });

  it('adds notification intent replay support to MainActivity', () => {
    const input = `package tech.dongdongbh.mindwtr
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

    const output = patchMainActivity(input);

    expect(output).toContain('import android.content.Intent');
    expect(output).toContain('import android.net.Uri');
    expect(output).toContain('import com.facebook.react.ReactApplication');
    expect(output).toContain('import com.facebook.react.modules.core.DeviceEventManagerModule');
    expect(output).toContain('import org.json.JSONObject');
    expect(output).toContain('import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore');
    expect(output).toContain('normalizeCreateNoteIntent(intent)');
    expect(output).toContain('com.google.android.gms.actions.CREATE_NOTE');
    expect(output).toContain('com.google.android.gms.actions.extra.NAME');
    expect(output).toContain('com.google.android.gms.actions.extra.TEXT');
    expect(output).toContain('.scheme("mindwtr")');
    expect(output).toContain('.path("capture")');
    expect(output).toContain('normalizeContextAutomationIntent(intent)');
    expect(output).toContain('tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT');
    expect(output).toContain('tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT');
    expect(output).toContain('.path("contexts")');
    expect(output).toContain('.appendQueryParameter("contextAction", contextAction)');
    expect(output).toContain('cacheNotificationOpenPayload(intent)');
    expect(output).toContain('"context"');
    expect(output).toContain('NotificationOpenPayloadStore.cache(payload)');
    expect(output).toContain('override fun onNewIntent(intent: Intent)');
    expect(output).toContain('normalizeCreateNoteIntent(intent)\n    normalizeContextAutomationIntent(intent)\n    WidgetLaunchCover.receive(this, intent)\n    AndroidWidgetModule.suppressWidgetModalExitAnimations(this)\n    super.onNewIntent(intent)');
    expect(output.match(/WidgetLaunchCover\.receive\(this, intent\)/g)).toHaveLength(2);
    expect(output).toContain('WidgetLaunchCover.receive(this, intent)\n    AndroidWidgetModule.suppressWidgetModalExitAnimations(this)\n    startupMark("native.main_activity.on_create:end")');
    expect(output).toContain('override fun onPause() {\n    WidgetLaunchCover.cancel(this)\n    super.onPause()');
    expect(output).toContain('override fun onResume() {\n    super.onResume()\n    AndroidWidgetModule.suppressWidgetModalExitAnimations(this)\n    WidgetLaunchCover.resume(this)');
    expect(output).toContain('override fun onDestroy() {\n    WidgetLaunchCover.cancel(this)\n    super.onDestroy()');
    expect(patchMainActivity(output)).toBe(output);
    expect(output).toContain('copyNestedData(extras.get("data"))');
    expect(output).toContain('value != JSONObject.NULL');
    expect(output).toContain('emit("OnNotificationOpened", JSONObject(payload).toString())');
  });

  it('only accepts notification payloads from this app', () => {
    const input = `package tech.dongdongbh.mindwtr
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

    const output = patchMainActivity(input);

    // Both entry points run through cacheNotificationOpenPayload, so guarding it
    // once covers the cold start and the onNewIntent replay.
    expect(output).toContain('private fun isSelfLaunchedIntent(intent: Intent?): Boolean');
    expect(output).toContain('if (!isSelfLaunchedIntent(intent)) return null');
    expect(output).toContain('referrer?.host == packageName');
    // getReferrer() prefers the caller-supplied extras, so those disqualify the intent.
    expect(output).toContain('Intent.EXTRA_REFERRER');
    expect(output).toContain('Intent.EXTRA_REFERRER_NAME');
  });

  it('adds the payload caller guard to an already-patched MainActivity', () => {
    const input = `package tech.dongdongbh.mindwtr
import expo.modules.splashscreen.SplashScreenManager

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactApplication
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

import org.json.JSONObject
import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    startupMark("native.main_activity.on_create:start")
    normalizeCreateNoteIntent(intent)
    normalizeContextAutomationIntent(intent)
    startupSection("native.main_activity.super_on_create") {
      super.onCreate(null)
    }
    cacheNotificationOpenPayload(intent)
    startupMark("native.main_activity.on_create:end")
  }

  override fun onNewIntent(intent: Intent) {
    normalizeCreateNoteIntent(intent)
    normalizeContextAutomationIntent(intent)
    super.onNewIntent(intent)
    setIntent(intent)
    val payload = cacheNotificationOpenPayload(intent) ?: return
    emitNotificationOpenPayload(payload)
  }

  override fun getMainComponentName(): String = "main"

  private fun normalizeCreateNoteIntent(intent: Intent?) {
  }

  private fun normalizeContextAutomationIntent(intent: Intent?) {
  }

  private fun cacheNotificationOpenPayload(intent: Intent?): LinkedHashMap<String, String>? {
    val extras = intent?.extras ?: return null
    val payload = LinkedHashMap<String, String>()
    fun copyPayloadValue(key: String, value: Any?) {
      if (value != null && value != JSONObject.NULL) payload[key] = value.toString()
    }
    fun copyNestedData(value: Any?) {
    }
    listOf("alarmKey", "id", "taskId", "projectId", "context", "kind", "actionIdentifier").forEach { key ->
      copyPayloadValue(key, extras.get(key))
    }
    copyNestedData(extras.get("data"))
    if (payload.isEmpty()) return null
    NotificationOpenPayloadStore.cache(payload)
    return payload
  }

  private fun emitNotificationOpenPayload(payload: Map<String, String>) {
  }
}
`;

    const output = patchMainActivity(input);

    expect(output).toContain('private fun isSelfLaunchedIntent(intent: Intent?): Boolean');
    expect(output).toContain('if (!isSelfLaunchedIntent(intent)) return null');
    expect(patchMainActivity(output)).toBe(output);
  });

  it('keeps the MainActivity notification patch idempotent', () => {
    const input = `package tech.dongdongbh.mindwtr
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

    const patched = patchMainActivity(input);
    expect(patchMainActivity(patched)).toBe(patched);
  });

  it('migrates the legacy MainActivity notification cache to the shared store', () => {
    const input = `package tech.dongdongbh.mindwtr
import expo.modules.splashscreen.SplashScreenManager

import android.content.Intent
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactApplication
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

import org.json.JSONObject

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  companion object {
    @Volatile
    private var pendingNotificationOpenPayload: LinkedHashMap<String, String>? = null

    fun consumePendingNotificationOpenPayload(): LinkedHashMap<String, String>? {
      val payload = pendingNotificationOpenPayload ?: return null
      pendingNotificationOpenPayload = null
      return LinkedHashMap(payload)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    startupMark("native.main_activity.on_create:start")
    startupSection("native.main_activity.super_on_create") {
      super.onCreate(null)
    }
    cacheNotificationOpenPayload(intent)
    startupMark("native.main_activity.on_create:end")
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    setIntent(intent)
    val payload = cacheNotificationOpenPayload(intent) ?: return
    emitNotificationOpenPayload(payload)
  }

  override fun getMainComponentName(): String = "main"

  private fun cacheNotificationOpenPayload(intent: Intent?): LinkedHashMap<String, String>? {
    val extras = intent?.extras ?: return null
    val payload = LinkedHashMap<String, String>()
    listOf("alarmKey", "id", "taskId", "projectId", "kind").forEach { key ->
      val value = extras.get(key) ?: return@forEach
      payload[key] = value.toString()
    }
    if (payload.isEmpty()) return null
    pendingNotificationOpenPayload = LinkedHashMap(payload)
    return payload
  }

  private fun emitNotificationOpenPayload(payload: Map<String, String>) {
    val reactApplication = application as? ReactApplication ?: return
    val reactContext = reactApplication.reactNativeHost.reactInstanceManager.currentReactContext ?: return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("OnNotificationOpened", JSONObject(payload).toString())
  }
}
`;

    const output = patchMainActivity(input);

    expect(output).toContain('import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore');
    expect(output).toContain('import android.net.Uri');
    expect(output).toContain('private fun normalizeCreateNoteIntent(intent: Intent?)');
    expect(output).toContain('private fun normalizeContextAutomationIntent(intent: Intent?)');
    expect(output).toContain('override fun onNewIntent(intent: Intent)');
    expect(output).toContain('normalizeCreateNoteIntent(intent)\n    normalizeContextAutomationIntent(intent)\n    WidgetLaunchCover.receive(this, intent)\n    AndroidWidgetModule.suppressWidgetModalExitAnimations(this)\n    super.onNewIntent(intent)');
    expect(output).not.toContain('fun consumePendingNotificationOpenPayload()');
    expect(output).not.toContain('override fun onNewIntent(intent: Intent?)');
    expect(output).not.toContain('pendingNotificationOpenPayload = LinkedHashMap(payload)');
    expect(output).toContain('copyNestedData(extras.get("data"))');
    expect(output).toContain('NotificationOpenPayloadStore.cache(payload)');
  });
});
