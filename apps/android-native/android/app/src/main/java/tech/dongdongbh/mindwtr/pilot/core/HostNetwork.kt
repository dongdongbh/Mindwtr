package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONObject


class HostNetwork(context: Context, private val changed: (String) -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = report()
        override fun onLost(network: Network) = report()
    }

    fun state(): String = runCatching {
        val network = manager.activeNetwork
        val capabilities = network?.let { manager.getNetworkCapabilities(it) }
        val transports = listOf(NetworkCapabilities.TRANSPORT_CELLULAR, NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_WIFI_AWARE,
            NetworkCapabilities.TRANSPORT_BLUETOOTH, NetworkCapabilities.TRANSPORT_ETHERNET, NetworkCapabilities.TRANSPORT_VPN)
        JSONObject().put("isInternetReachable", network != null)
            .put("isConnected", capabilities != null && transports.any { capabilities.hasTransport(it) })
    }.getOrElse { JSONObject().put("isInternetReachable", false).put("isConnected", false) }.toString()

    fun start() = manager.registerNetworkCallback(NetworkRequest.Builder().build(), callback)

    private fun report() {
        runCatching { changed(state()) }
    }
}
