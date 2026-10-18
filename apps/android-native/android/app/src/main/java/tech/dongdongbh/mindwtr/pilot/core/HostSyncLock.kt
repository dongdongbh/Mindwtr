package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.util.Log
import org.json.JSONObject
import tech.dongdongbh.mindwtr.syncfilelock.SyncFileLockCore

/**
 * File Sync's folder lock (core's SyncFileLockNativePort, bundle/host-sync.ts): React Native's SyncFileLockCore.kt, compiled as
 * it is, with its JNI library built from RN's C++ (the app's CMake build). [call] takes `{ op: "acquire", uri }` and answers
 * the lease's token, or `{ op: "revalidate" | "release", token }`. Refusals carry the lock's coded text, as RN's module does.
 * [close] releases every lease the process still holds (the host is closing).
 */
class HostSyncLock internal constructor(private val core: SyncFileLockCore) : AutoCloseable {
    constructor(context: Context) : this(SyncFileLockCore { context })

    fun call(json: String, @Suppress("UNUSED_PARAMETER") bytes: ByteArray? = null): HostFiles.Reply {
        val request = JSONObject(json)
        return when (val op = request.getString("op")) {
            "acquire" -> HostFiles.Reply(core.acquire(request.getString("uri")))
            "revalidate" -> HostFiles.Reply(null.also { core.revalidate(request.getString("token")) })
            "release" -> HostFiles.Reply(null.also { core.release(request.getString("token")) })
            else -> throw IllegalArgumentException("Unsupported lock call $op")
        }
    }

    override fun close() {
        for (error in core.destroy()) Log.w(CoreHost.TAG, "Failed to release a File Sync lease while the host closed", error)
    }
}
