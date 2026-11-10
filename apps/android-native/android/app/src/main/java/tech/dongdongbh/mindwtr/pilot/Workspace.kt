package tech.dongdongbh.mindwtr.pilot

import android.content.Context
import android.content.Intent
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import org.json.JSONObject
import java.io.File


internal object Workspace {
    const val BOOT_PREFS = "workspace-boot"
    const val REQUEST_KEY = "sandboxBootRequest"
    const val SANDBOX_VIEW_PREFS = "mindwtr-view-state-sandbox"
    const val REQUEST_MAX_AGE_MS = 60_000L

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


    fun fresh(raw: String, now: Long = System.currentTimeMillis()): Boolean = runCatching {
        val request = JSONObject(raw)
        request.optInt("version") == 1 && (now - request.getLong("requestedAt")) in 0..REQUEST_MAX_AGE_MS
    }.getOrDefault(false)


    fun take(store: RequestStore, now: Long = System.currentTimeMillis(), refused: (String) -> Unit = {}): String? {
        val raw = store.read() ?: return null
        if (!store.write(null)) {
            refused("unconsumed")
            return null
        }
        return raw.takeIf { fresh(it, now) }.also { if (it == null) refused("stale") }
    }


    fun decide(store: RequestStore, booted: Boolean, begin: () -> Boolean, restart: () -> Unit, refused: (String) -> Unit = {},
               enter: () -> Unit = { sandbox = true }): String? {
        val raw = take(store, refused = refused) ?: return null
        if (booted) {
            if (fresh(raw)) store.write(raw)
            restart()
            return null
        }
        if (!begin()) {
            refused("scratch")
            return null
        }
        enter()
        return raw
    }


    fun settled(store: RequestStore, request: String?, sandboxed: Boolean, runtimeSandbox: Boolean, restart: () -> Unit): Boolean {
        if (runtimeSandbox == sandboxed) return true
        if (request != null && fresh(request)) store.write(request)
        restart()
        return false
    }


    const val SAVED_WORKSPACE_KEY = "workspace"


    fun marker(sandbox: Boolean) = if (sandbox) "sandbox" else "personal"


    fun savedStateFits(stored: String?, sandbox: Boolean) = (stored ?: marker(false)) == marker(sandbox)


    fun scratch(context: Context) = File(context.noBackupFilesDir, "sandbox")


    fun dir(noBackup: File, name: String, sandbox: Boolean): File = if (sandbox) File(File(noBackup, "sandbox"), name) else File(noBackup, name)


    fun dir(context: Context, name: String, sandbox: Boolean = this.sandbox) = dir(context.noBackupFilesDir, name, sandbox)


    fun begin(context: Context, scratch: File = scratch(context)): Boolean {
        val wiped = !scratch.exists() || scratch.deleteRecursively()
        viewPrefs(context, sandbox = true).edit().clear().commit()
        return wiped && scratch.mkdirs()
    }


    fun freshBootFiles(scratch: File): Boolean =
        (scratch.isDirectory || scratch.mkdirs()) && listOf("sandbox.db", "sandbox.db-wal", "sandbox.db-shm", "journal", "RKStorage", "RKStorage-wal", "RKStorage-shm")
            .map { File(scratch, it) }.all { !it.exists() || it.deleteRecursively() }


    fun store(context: Context): RequestStore = object : RequestStore {
        private val prefs = context.getSharedPreferences(BOOT_PREFS, Context.MODE_PRIVATE)
        override fun read(): String? = prefs.getString(REQUEST_KEY, null)
        override fun write(value: String?): Boolean = prefs.edit().apply { if (value == null) remove(REQUEST_KEY) else putString(REQUEST_KEY, value) }.commit()
    }


    fun prefsName(sandbox: Boolean) = if (sandbox) SANDBOX_VIEW_PREFS else DEVICE_PREFS


    fun viewPrefs(context: Context, sandbox: Boolean = this.sandbox) = context.getSharedPreferences(prefsName(sandbox), Context.MODE_PRIVATE)


    fun restart(context: Context) {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        Runtime.getRuntime().exit(0)
    }
}


internal object SandboxReminders : CoreHost.Reminders {
    override fun apply(plan: String): Int = 0
    override fun permissionGranted(): Boolean = false
    override fun cleanupRn(): Int = 0
    override fun receiverCounts(): String = """{"dropped":0,"notQueued":0}"""
    override fun ledger(): String = """{"fired":[],"shown":[]}"""
}
