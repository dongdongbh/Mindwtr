package tech.dongdongbh.mindwtr.pilot

import android.content.Context
import android.content.Intent
import java.io.File


internal object Workspace {
    const val BOOT_PREFS = "workspace-boot"
    const val REQUEST_KEY = "sandboxBootRequest"
    const val SANDBOX_VIEW_PREFS = "mindwtr-view-state-sandbox"

    @Volatile var sandbox = false
        private set


    interface RequestStore {
        fun read(): String?
        fun write(value: String?): Boolean
    }


    data class Files(val database: File, val journal: File, val keyValue: File)


    fun files(personalDatabase: File, personalJournal: File, personalKeyValue: File, scratch: File, sandbox: Boolean): Files =
        if (sandbox) Files(File(scratch, "sandbox.db"), File(scratch, "journal"), File(scratch, "RKStorage"))
        else Files(personalDatabase, personalJournal, personalKeyValue)


    fun take(store: RequestStore): String? {
        val raw = store.read() ?: return null
        check(store.write(null)) { "The sandbox boot request was not consumed" }
        return raw
    }


    fun opened(sandbox: Boolean) { this.sandbox = sandbox }


    fun scratch(context: Context) = File(context.noBackupFilesDir, "sandbox")


    fun store(context: Context): RequestStore = object : RequestStore {
        private val prefs = context.getSharedPreferences(BOOT_PREFS, Context.MODE_PRIVATE)
        override fun read(): String? = prefs.getString(REQUEST_KEY, null)
        override fun write(value: String?): Boolean = prefs.edit().apply { if (value == null) remove(REQUEST_KEY) else putString(REQUEST_KEY, value) }.commit()
    }


    fun viewPrefs(context: Context, sandbox: Boolean = this.sandbox) =
        context.getSharedPreferences(if (sandbox) SANDBOX_VIEW_PREFS else DEVICE_PREFS, Context.MODE_PRIVATE)


    fun restart(context: Context) {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        Runtime.getRuntime().exit(0)
    }
}
