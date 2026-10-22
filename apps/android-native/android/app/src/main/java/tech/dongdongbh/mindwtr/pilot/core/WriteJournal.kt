package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The write-ahead journal under the app's `files/journal`: every write request (a [WRITES] method and its exact arguments,
 * its request UUID included) is on disk before the engine sees it, and leaves only after core's final reply. After process
 * death or a stopped engine, the next boot replays what is left, in order (CoreHost.replayJournal); core's crash-safe
 * commands make a replay write nothing wrong. The engine thread sends and settles; a Project details edit is also journaled
 * ahead from the main thread (CoreHost.journalAhead), so [pending], [append] and [settle] are synchronized.
 *
 * An entry is one file, `<sequence>.json`: written whole to a temporary file, synced, renamed into place, and the directory
 * synced. A temporary file left by a death mid-write was never sent, so it is removed. An entry that cannot be read, or names
 * a method that is not a write, is moved to [ASIDE], never replayed and never deleted. A journal that cannot be listed refuses
 * to open (the boot fails as a failed load does, so no write runs), and an entry never takes the name of a file on disk.
 * [floor] is the highest sequence recorded outside the journal (DeviceWrites): a new entry is numbered above it too, so the
 * numbering never goes back after the journal empties.
 */
class WriteJournal(
    private val dir: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,
    private val log: (String) -> Unit = {},
    floor: Long = 0,
) {
    companion object {
        /**
         * CoreHost's write methods (host-entry.ts's task commands, each answered through taskResult) and the arguments each takes,
         * which an entry read at boot must still fit to be replayed: "id" non-empty text (an id, a revision, a request UUID),
         * "text" any text, "bool" a boolean, "menu" a command of [MENU], and "{a,b[]}" a JSON object text whose `a` is non-empty
         * text and `b` an array ("{menu}": the keys [MENU] gives the command). check-boot-gates.mjs keeps the methods and their
         * arguments equal to host-entry's, and the methods to core's write commands.
         */
        val SHAPES = mapOf(
            "captureSubmit" to listOf("{captureId}"), "captureLines" to listOf("{captureIds[]}"), "capturePicker" to listOf("{requestId}"),
            "captureModalSubmit" to listOf("{captureId}"), "captureModalLines" to listOf("{captureIds[]}"),
            "complete" to listOf("id", "id"), "update" to listOf("{id,requestId}"), "saveDraft" to listOf("{id,requestId}"),
            "resetChecklist" to listOf("{id,requestId,taskRevision}"), "taskFocus" to listOf("id", "bool", "id"), "projectFocus" to listOf("id", "bool", "id"),
            "createProject" to listOf("id", "text", "id"), "setAreaFilter" to listOf("{included[],excluded[]}"), "saveSearch" to listOf("{requestId}"),
            "inboxCommit" to listOf("{sessionId,taskId,requestId}"), "inboxSkip" to listOf("{sessionId,taskId,requestId}"), "menuCommand" to listOf("menu", "{menu}"),
            "ingest" to listOf("id"), "reminderDone" to listOf("id", "id"), "reminderSnooze" to listOf("{requestId}"),
            // Settings › Data's restore, merge and import: the operation's reference and its snapshot name. CoreHost sends the checked plan
            // (BackupOperations) between them, so the journal never holds library data.
            "backupDocumentCommit" to listOf("{id,sha256}", "id"),
            // The native Pomodoro (R2b): core's prepared plan and replayOnly=false; its receipt answers a replay of one that landed.
            "pomodoroTransitionCommit" to listOf("text", "bool"),
        )
        /** host-entry.ts's MENU_COMMANDS and the keys each one's JSON input holds (check-boot-gates.mjs keeps the names equal). */
        val MENU = mapOf(
            "activateProject" to "{projectId,projectRevision}", "somedayMove" to "{requestId,taskIds[]}", "somedayUndo" to "{moveRequestId,requestId}",
            "somedayTask" to "{captureId}", "somedaySection" to "{requestId}", "taskListSort" to "{sortBy}", "somedayRename" to "{id}",
            "somedayReorder" to "{ids[]}", "somedayDelete" to "{id}",
            // Settings › Sync's screen commands: never on disk (UNJOURNALED), so their shapes are never checked.
            "openSyncSettings" to "{}", "closeSyncSettings" to "{}", "selectSyncBackend" to "{requestId}", "saveSyncBackend" to "{requestId,revision}",
            "syncNow" to "{requestId}", "testSyncConnection" to "{}", "pickSyncFolder" to "{requestId}", "connectDropbox" to "{requestId}",
            "disconnectDropbox" to "{requestId}", "runSyncEncryptionAction" to "{}", "answerSyncMissingFiles" to "{questionId}",
            // Settings › AI's key and base URL: never on disk either (UNJOURNALED).
            "setAIKey" to "{requestId}", "setAIEndpoint" to "{requestId}",
            // Settings › Calendar's new subscription: never on disk (UNJOURNALED), its URL may carry a password.
            "calendarFeedAdd" to "{requestId}",
            // Attachments: Add file and Add photo, the link sheet's Save, Remove (a project's written at once through receipts).
            "attachmentAddFile" to "{requestId}", "attachmentLinks" to "{requestId}", "attachmentRemove" to "{requestId,attachmentId}",
            // Project details (ProjectDetails.kt): the user's edit, journaled ahead of its send (core's runProjectEdit).
            "projectEdit" to "{requestId,projectId,kind}",
            // Settings › Data's Getting Started row: the request UUID and the app language, both frozen at the tap.
            "gettingStarted" to "{requestId,language}",
            // The donation ask's synced record: the request UUID and the time the ask showed, both frozen at the showing.
            "supportPromptShown" to "{requestId,shownAt}",
        ) + listOf("archiveAction", "contextsAction", "trashAction", "reviewAction", "reviewTask", "calendarAction", "calendarCreate", "boardAction",
            "boardCreate", "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder", "bulkCreate", "mindSweepAdd",
            "savedSearchDelete", "generalSetting", "gtdSetting", "dataSetting", "notificationsSetting", "manageEditor", "manageDelete", "syncPreference",
            "setAISetting", "openAISettings", "calendarSetting").associateWith { "{requestId}" }
        val WRITES = SHAPES.keys
        /**
         * Writes never journaled: a key (the host method, or a Menu command's name) whose core command is in core's
         * NATIVE_UNJOURNALED_COMMANDS, a payload that can carry a secret. check-boot-gates.mjs keeps it equal to core's set.
         */
        val UNJOURNALED = setOf("openSyncSettings", "closeSyncSettings", "selectSyncBackend", "saveSyncBackend", "syncNow", "testSyncConnection",
            "pickSyncFolder", "connectDropbox", "disconnectDropbox", "runSyncEncryptionAction", "answerSyncMissingFiles", "setAIKey", "setAIEndpoint",
            "calendarFeedAdd")

        /** Whether [method] with [args] is an [UNJOURNALED] write: CoreHost's long calls (callLong) take only these. */
        fun unjournaled(method: String, args: List<Any?>): Boolean = method in WRITES && key(method, args) in UNJOURNALED

        /** A write's journal key: the host method, or a Menu command's name. */
        fun key(method: String, args: List<Any?>): Any? = if (method == "menuCommand") args.firstOrNull() else method
        const val ASIDE = "aside"
        private val NAME = Regex("""^(\d{16})\.json$""")
        /** A sequence number on disk: an entry's, one set aside here, or one cut short. */
        private val SEQUENCE = Regex("""^(\d{16})\.json""")
        private const val PARTIAL = ".tmp"

        /**
         * SAVE_FAILED keeps an entry: the write landed in memory only, and the owed retry (or the next boot) saves it. Every
         * other reply is final (a success, changed or not, STALE_REVISION, INVALID_INPUT, NOT_FOUND and other refusals).
         */
        fun keeps(error: String?): Boolean = error?.startsWith("SAVE_FAILED") == true

        /**
         * A replay's reply that says the entry is not a request core takes (INVALID_INPUT, host-entry's unknown Menu command
         * too): the entry is set aside intact, never deleted. [SHAPES] is only the first filter; this makes the check complete
         * without copying core's schema. A first send's INVALID_INPUT is a refusal like any other.
         */
        fun malformed(error: String?): Boolean = error?.startsWith("INVALID_INPUT") == true
    }

    /** One journaled request: [text] is the file's exact contents, and two equal requests have equal texts. */
    class Entry(val file: File, val method: String, val args: List<Any>, val text: String) {
        /** Its place in the journal's order (the number in its name). */
        val sequence: Long get() = file.name.substring(0, 16).toLong()
    }

    private val entries = ArrayList<Entry>()
    private var next = 1L

    init {
        dir.mkdirs()
        // Never read as empty when it cannot be listed: the next entry could take the name of one on disk.
        val files = dir.listFiles() ?: throw IOException("Cannot read the write journal")
        var partial = 0
        var aside = 0
        for (file in files.filter { it.isFile }.sortedBy { it.name }) {
            // The next entry comes after every sequence number on disk, set aside or cut short too.
            SEQUENCE.find(file.name)?.let { next = maxOf(next, it.groupValues[1].toLong() + 1) }
            if (file.name.endsWith(PARTIAL)) {
                file.delete()
                partial += 1
                continue
            }
            val entry = NAME.matchEntire(file.name)?.let { runCatching { read(file) }.getOrNull() }
            if (entry == null) {
                moveAside(file)
                aside += 1
                continue
            }
            entries += entry
        }
        next = maxOf(next, floor + 1)
        log("Native Android journal open entries=${entries.size} aside=$aside partial=$partial")
    }

    /** The entries on disk, oldest first. */
    @Synchronized fun pending(): List<Entry> = entries.toList()

    /**
     * [method] with [args], durable before this returns; null for an [UNJOURNALED] write, which never reaches the disk. The
     * same request while its entry is still here (an owed retry) returns that entry: the journal never holds a request twice.
     */
    @Synchronized fun append(method: String, args: List<Any?>): Entry? {
        require(method in WRITES) { "$method is not a write" }
        if (key(method, args) in UNJOURNALED) return null
        val text = JSONObject().put("method", method).put("args", JSONArray().apply { args.forEach { put(requireNotNull(it)) } }).toString()
        entries.firstOrNull { it.text == text }?.let { return it }
        val file = File(dir, "%016d.json".format(next++))
        // The rename below would replace a file of that name: never over one on disk.
        check(!file.exists()) { "The write journal already holds ${file.name}" }
        val partial = File(dir, file.name + PARTIAL)
        try {
            FileOutputStream(partial).use { out -> out.write(text.toByteArray()); out.fd.sync() }
            check(partial.renameTo(file)) { "Cannot save the write journal entry" }
        } catch (failure: Throwable) {
            partial.delete()
            throw failure
        }
        syncDirectory(dir)
        return Entry(file, method, args.map { it!! }, text).also { entries += it }
    }

    /**
     * Core's final reply for [entry] ([error] null for a success): the entry goes, unless the reply [keeps] it; a [replay] core
     * refused as [malformed] goes to [ASIDE] instead. True once it is gone. It leaves (in memory too) only after its delete or
     * move and the folder sync: one that fails keeps it for the next boot's replay (core's crash-safe commands allow that), and
     * no receipt it may need is pruned while it stays.
     */
    @Synchronized fun settle(entry: Entry, error: String?, replay: Boolean = false): Boolean {
        if (keeps(error)) return false
        if (replay && malformed(error)) {
            if (!moveAside(entry.file)) return false
        } else if (!entry.file.delete() && entry.file.exists()) {
            log("Native Android journal entry not deleted ${entry.file.name}")
            return false
        }
        try {
            syncDirectory(dir)
        } catch (failure: Exception) {
            log("Native Android journal delete not synced ${entry.file.name}")
            return false
        }
        entries.remove(entry)
        return true
    }

    private fun read(file: File): Entry? {
        val text = file.readText()
        val json = JSONObject(text)
        val method = json.getString("method")
        val array = json.getJSONArray("args")
        val args = List(array.length()) { array.get(it) }
        if (!fits(method, args) || key(method, args) in UNJOURNALED) return null
        return Entry(file, method, args, text)
    }

    /** Whether [args] still fit [method] as host-entry takes it ([SHAPES]): a retired write or a missing id never replays. */
    private fun fits(method: String, args: List<Any?>): Boolean {
        val shape = SHAPES[method] ?: return false
        return args.size == shape.size && shape.indices.all { index ->
            val arg = args[index]
            when (val kind = shape[index]) {
                "id" -> arg is String && arg.isNotEmpty()
                "text" -> arg is String
                "bool" -> arg is Boolean
                "menu" -> arg in MENU
                "{menu}" -> holds(arg, MENU[args[0]] ?: return false)
                else -> holds(arg, kind)
            }
        }
    }

    /** [arg] is a JSON object text with [keys] (`{a,b[]}`): `a` non-empty text, `b` an array. */
    private fun holds(arg: Any?, keys: String): Boolean {
        val json = (arg as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return false
        return keys.removeSurrounding("{", "}").split(',').all { key ->
            if (key.endsWith("[]")) json.opt(key.dropLast(2)) is JSONArray else (json.opt(key) as? String).orEmpty().isNotEmpty()
        }
    }

    /** [file] moved into [ASIDE] as it is (never over a file there); true once it moved. */
    private fun moveAside(file: File): Boolean {
        val aside = File(dir, ASIDE).apply { mkdirs() }
        var target = File(aside, file.name)
        var copy = 1
        while (target.exists()) target = File(aside, "${file.name}.${copy++}")
        // The file's name only: its request (a task's words) never reaches the log.
        val moved = file.renameTo(target)
        log(if (moved) "Native Android journal entry set aside ${file.name}" else "Native Android journal entry not moved aside ${file.name}")
        return moved
    }
}
