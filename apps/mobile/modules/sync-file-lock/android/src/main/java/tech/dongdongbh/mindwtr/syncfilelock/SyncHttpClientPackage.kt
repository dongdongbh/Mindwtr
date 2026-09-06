package tech.dongdongbh.mindwtr.syncfilelock

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import java.util.concurrent.TimeUnit

/** Connect timeout for every fetch/XHR the app makes on Android. Zero means not installed. */
object SyncHttpClientConfig {
  const val CONNECT_TIMEOUT_MS = 10_000L

  @Volatile
  var installedConnectTimeoutMs: Long = 0L
}

// Auto-discovered by expo-modules autolinking (any *Package.kt in a module's
// android source), so this needs no entry in expo-module.config.json.
class SyncHttpClientPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> {
    return listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        // React Native builds its OkHttp client with no connect timeout at all, so a
        // host whose published IPv6 address drops SYNs holds the connect until the
        // kernel gives up (about two minutes), long past the app's 30 s request
        // timer. Browsers fall back to IPv4 in milliseconds (Happy Eyeballs);
        // OkHttp only moves to the next address once a connect attempt fails, so
        // give it a bounded connect and let it fail over well inside 30 s (#1150).
        OkHttpClientProvider.setOkHttpClientFactory {
          OkHttpClientProvider.createClientBuilder(application)
            .connectTimeout(SyncHttpClientConfig.CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
        }
        SyncHttpClientConfig.installedConnectTimeoutMs = SyncHttpClientConfig.CONNECT_TIMEOUT_MS
      }
    })
  }
}
