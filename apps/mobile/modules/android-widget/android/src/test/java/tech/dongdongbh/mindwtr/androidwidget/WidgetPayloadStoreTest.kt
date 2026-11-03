package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetPayloadStoreTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Test
  fun aStoredPayloadReportsSuccess() {
    assertTrue(WidgetPayloadStore.write(context, """{"items":[]}"""))
    assertEquals("""{"items":[]}""", WidgetPayloadStore.readRaw(context))
  }

  @Test
  fun aCommitThatDidNotReachTheDiskReportsFailure() {
    val real = context.getSharedPreferences(WidgetPayloadStore.PREFS_NAME, Context.MODE_PRIVATE)

    val failingEditor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { proxy, method, args ->
      if (method.name == "commit") false else { method.invoke(real.edit(), *(args ?: emptyArray())); proxy }
    } as SharedPreferences.Editor
    val failingPrefs = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
      if (method.name == "edit") failingEditor else method.invoke(real, *(args ?: emptyArray()))
    } as SharedPreferences
    val failingContext = object : ContextWrapper(context) {
      override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
        if (name == WidgetPayloadStore.PREFS_NAME) failingPrefs else super.getSharedPreferences(name, mode)
    }

    assertFalse(WidgetPayloadStore.write(failingContext, """{"items":[]}"""))
  }
}
