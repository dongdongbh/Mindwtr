package tech.dongdongbh.mindwtr.syncfilelock

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import java.util.concurrent.TimeUnit
import okhttp3.Interceptor
import okhttp3.Response


object SyncHttpClientConfig {
  const val CONNECT_TIMEOUT_MS = 10_000L

  @Volatile
  var installedConnectTimeoutMs: Long = 0L
}


internal object WriteRedirectRefusal : Interceptor {
  private val methods = setOf("PUT", "POST", "PATCH", "DELETE")

  override fun intercept(chain: Interceptor.Chain): Response {
    val response = chain.proceed(chain.request())
    if (!response.isRedirect || chain.request().method !in methods) return response
    return response.newBuilder().removeHeader("Location").build()
  }
}


class SyncHttpClientPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> {
    return listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {


        OkHttpClientProvider.setOkHttpClientFactory {
          OkHttpClientProvider.createClientBuilder(application)
            .connectTimeout(SyncHttpClientConfig.CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .addNetworkInterceptor(WriteRedirectRefusal)
            .build()
        }
        SyncHttpClientConfig.installedConnectTimeoutMs = SyncHttpClientConfig.CONNECT_TIMEOUT_MS
      }
    })
  }
}
