import { describe, expect, it } from 'vitest';

const plugin = require('./android-startup-trace');

const { patchMainActivity } = plugin.__testables;

describe('android-startup-trace', () => {
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
    expect(output).toContain('import com.facebook.react.ReactApplication');
    expect(output).toContain('import com.facebook.react.modules.core.DeviceEventManagerModule');
    expect(output).toContain('import org.json.JSONObject');
    expect(output).toContain('import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore');
    expect(output).toContain('cacheNotificationOpenPayload(intent)');
    expect(output).toContain('NotificationOpenPayloadStore.cache(payload)');
    expect(output).toContain('override fun onNewIntent(intent: Intent)');
    expect(output).toContain('copyNestedData(extras.get("data"))');
    expect(output).toContain('value != JSONObject.NULL');
    expect(output).toContain('emit("OnNotificationOpened", JSONObject(payload).toString())');
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
    expect(output).toContain('override fun onNewIntent(intent: Intent)');
    expect(output).not.toContain('fun consumePendingNotificationOpenPayload()');
    expect(output).not.toContain('override fun onNewIntent(intent: Intent?)');
    expect(output).not.toContain('pendingNotificationOpenPayload = LinkedHashMap(payload)');
    expect(output).toContain('copyNestedData(extras.get("data"))');
    expect(output).toContain('NotificationOpenPayloadStore.cache(payload)');
  });
});
