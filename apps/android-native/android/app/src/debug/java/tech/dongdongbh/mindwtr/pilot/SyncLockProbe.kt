package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import tech.dongdongbh.mindwtr.syncfilelock.SyncFileLockCore


open class SyncLockProbe : Activity() {
    private companion object {

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


class SyncLockHolder : SyncLockProbe() {
    override val processName = "holder"
}
