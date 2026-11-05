package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException


class WriteJournal(
    private val dir: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,
    private val log: (String) -> Unit = {},
    floor: Long = 0,
) {
    companion object {


        val SHAPES = mapOf(
            "captureSubmit" to listOf("{captureId}"), "captureLines" to listOf("{captureIds[]}"), "capturePicker" to listOf("{requestId}"),
            "captureModalSubmit" to listOf("{captureId}"), "captureModalLines" to listOf("{captureIds[]}"),
            "complete" to listOf("id", "id"), "completeUndo" to listOf("{id,taskRevision}"), "update" to listOf("{id,requestId}"), "saveDraft" to listOf("{id,requestId}"),
            "resetChecklist" to listOf("{id,requestId,taskRevision}"), "taskFocus" to listOf("id", "bool", "id"), "projectFocus" to listOf("id", "bool", "id"),
            "createProject" to listOf("id", "text", "id"), "setAreaFilter" to listOf("{included[],excluded[]}"), "saveSearch" to listOf("{requestId}"),
            "inboxCommit" to listOf("{sessionId,taskId,requestId}"), "inboxDecisionUndo" to listOf("{taskId,kind}"), "inboxSkip" to listOf("{sessionId,taskId,requestId}"), "menuCommand" to listOf("menu", "{menu}"),
            "ingest" to listOf("id"), "reminderDone" to listOf("id", "id"), "reminderSnooze" to listOf("{requestId}"),


            "backupDocumentCommit" to listOf("{id,sha256}", "id"),

            "pomodoroTransitionCommit" to listOf("text", "bool"),
        )

        val MENU = mapOf(
            "activateProject" to "{projectId,projectRevision}", "somedayMove" to "{requestId,taskIds[]}", "somedayProjectMove" to "{requestId,projectId}", "taskDestinationMove" to "{requestId,id}", "taskDatesSave" to "{requestId,taskId}", "taskSwipeFocus" to "{requestId,taskId,taskRevision}", "somedayUndo" to "{moveRequestId,requestId}",
            "somedayTask" to "{captureId}", "somedaySection" to "{requestId}", "taskListSort" to "{sortBy}", "somedayRename" to "{id}",
            "somedayReorder" to "{ids[]}", "somedayDelete" to "{id}",

            "openSyncSettings" to "{}", "closeSyncSettings" to "{}", "selectSyncBackend" to "{requestId}", "saveSyncBackend" to "{requestId,revision}",
            "syncNow" to "{requestId}", "testSyncConnection" to "{}", "pickSyncFolder" to "{requestId}", "connectDropbox" to "{requestId}",
            "disconnectDropbox" to "{requestId}", "runSyncEncryptionAction" to "{}", "answerSyncMissingFiles" to "{questionId}",

            "setAIKey" to "{requestId}", "setAIEndpoint" to "{requestId}",

            "calendarFeedAdd" to "{requestId}",

            "attachmentAddFile" to "{requestId}", "attachmentLinks" to "{requestId}", "attachmentRemove" to "{requestId,attachmentId}",

            "projectEdit" to "{requestId,projectId,kind}",

            "areaOrder" to "{requestId,order[]}",

            "areaColor" to "{requestId,areaId}",

            "gettingStarted" to "{requestId,language}",

            "supportPromptShown" to "{requestId,shownAt}",

            "taskEditorAction" to "{requestId,taskId,kind}",
        ) + listOf("archiveAction", "contextsAction", "trashAction", "reviewAction", "reviewTask", "calendarAction", "calendarCreate", "boardAction",
            "boardCreate", "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder", "bulkCreate", "mindSweepAdd", "projectNextAction", "taskCompletedAt",
            "savedSearchDelete", "savedSearchSort", "generalSetting", "gtdSetting", "dataSetting", "notificationsSetting", "manageEditor", "manageDelete", "syncPreference",
            "setAISetting", "openAISettings", "calendarSetting").associateWith { "{requestId}" }
        val WRITES = SHAPES.keys


        val UNJOURNALED = setOf("openSyncSettings", "closeSyncSettings", "selectSyncBackend", "saveSyncBackend", "syncNow", "testSyncConnection",
            "pickSyncFolder", "connectDropbox", "disconnectDropbox", "runSyncEncryptionAction", "answerSyncMissingFiles", "setAIKey", "setAIEndpoint",
            "calendarFeedAdd")


        fun unjournaled(method: String, args: List<Any?>): Boolean = method in WRITES && key(method, args) in UNJOURNALED


        fun key(method: String, args: List<Any?>): Any? = if (method == "menuCommand") args.firstOrNull() else method
        const val ASIDE = "aside"
        private val NAME = Regex("""^(\d{16})\.json$""")

        private val SEQUENCE = Regex("""^(\d{16})\.json""")
        private const val PARTIAL = ".tmp"


        fun keeps(error: String?): Boolean = error?.startsWith("SAVE_FAILED") == true


        fun malformed(error: String?): Boolean = error?.startsWith("INVALID_INPUT") == true
    }


    class Entry(val file: File, val method: String, val args: List<Any>, val text: String) {

        val sequence: Long get() = file.name.substring(0, 16).toLong()
    }

    private val entries = ArrayList<Entry>()
    private var next = 1L

    init {
        dir.mkdirs()

        val files = dir.listFiles() ?: throw IOException("Cannot read the write journal")
        var partial = 0
        var aside = 0
        for (file in files.filter { it.isFile }.sortedBy { it.name }) {

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


    @Synchronized fun pending(): List<Entry> = entries.toList()


    @Synchronized fun append(method: String, args: List<Any?>): Entry? {
        require(method in WRITES) { "$method is not a write" }
        if (key(method, args) in UNJOURNALED) return null
        val text = JSONObject().put("method", method).put("args", JSONArray().apply { args.forEach { put(requireNotNull(it)) } }).toString()
        entries.firstOrNull { it.text == text }?.let { return it }
        val file = File(dir, "%016d.json".format(next++))

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


    private fun holds(arg: Any?, keys: String): Boolean {
        val json = (arg as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return false
        return keys.removeSurrounding("{", "}").split(',').all { key ->
            if (key.endsWith("[]")) json.opt(key.dropLast(2)) is JSONArray else (json.opt(key) as? String).orEmpty().isNotEmpty()
        }
    }


    private fun moveAside(file: File): Boolean {
        val aside = File(dir, ASIDE).apply { mkdirs() }
        var target = File(aside, file.name)
        var copy = 1
        while (target.exists()) target = File(aside, "${file.name}.${copy++}")

        val moved = file.renameTo(target)
        log(if (moved) "Native Android journal entry set aside ${file.name}" else "Native Android journal entry not moved aside ${file.name}")
        return moved
    }
}
