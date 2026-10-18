package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import tech.dongdongbh.mindwtr.syncfilelock.SyncFileLockCore

/**
 * Debug builds only (scripts/check-file-sync-device.mjs): File Sync's folder lock, taken and dropped from the shell. The
 * app's own process runs [SyncLockProbe] (the production lock code, SyncFileLockCore, as HostSyncLock runs it); the
 * `:lockholder` process runs [SyncLockHolder], the second holder. Extras: `op` = hold (uri), revalidate (count), release,
 * or revoke (uri: the folder's persisted grant is released, as a user's revoke in Android's settings). Each answer is one
 * logcat line, `Native Android sync lock probe process=<main|holder> op=<op> outcome=<held|revalidated|released|revoked|refused>
 * code=<the refusal's code>`.
 */
open class SyncLockProbe : Activity() {
    private companion object {
        /** One lease per process, kept while the process lives (the activity finishes at once). */
        var token: String? = null
        var core: SyncFileLockCore? = null
    }

    protected open val processName = "main"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val op = intent.getStringExtra("op").orEmpty()
        val outcome = try {
            val lock = core ?: SyncFileLockCore { applicationContext }.also { core = it }
            when (op) {
                "hold" -> { token = lock.acquire(intent.getStringExtra("uri")!!); "held" }
                "revalidate" -> { repeat(intent.getIntExtra("count", 1)) { lock.revalidate(token!!) }; "revalidated" }
                "release" -> { token?.let(lock::release); token = null; "released" }
                "revoke" -> {
                    contentResolver.releasePersistableUriPermission(Uri.parse(intent.getStringExtra("uri")!!),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    "revoked"
                }
                else -> "unknown"
            } to ""
        } catch (error: Throwable) {
            "refused" to (error.message?.substringBefore(':') ?: error.javaClass.simpleName)
        }
        Log.i("MindwtrNativeDev", "Native Android sync lock probe process=$processName op=$op outcome=${outcome.first} code=${outcome.second}")
        finish()
    }
}

/** [SyncLockProbe] in the `:lockholder` process: another process of the same app, as RN's lock refuses it. */
class SyncLockHolder : SyncLockProbe() {
    override val processName = "holder"
}
