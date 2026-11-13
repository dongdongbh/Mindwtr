package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File


class WriteJournalTest {
    @get:Rule val folder = TemporaryFolder()


    private val syncs = mutableListOf<List<String>>()
    private val logged = mutableListOf<String>()

    private fun open(dir: File = File(folder.root, "journal")) =
        WriteJournal(dir, syncDirectory = { syncs += names(it) }, log = { logged += it })

    private fun names(dir: File) = dir.listFiles().orEmpty().filter { it.isFile }.map { it.name }.sorted()

    private fun bulk(requestId: String) = """{"list":"inbox","action":{"type":"moveTasks","taskIds":["a"],"taskRevisions":{"a":"1:x:t"}},"requestId":"$requestId"}"""

    @Test fun entriesKeepTheirOrderAcrossAReopen() {
        val journal = open()
        journal.append("complete", listOf("task-1", "3:dev:2026"))
        journal.append("menuCommand", listOf("bulkAction", bulk("r-1")))
        journal.append("taskFocus", listOf("task-2", true, "4:dev:2026"))
        val reopened = open()
        assertEquals(listOf("complete", "menuCommand", "taskFocus"), reopened.pending().map { it.method })
        assertEquals(listOf("task-2", true, "4:dev:2026"), reopened.pending()[2].args)

        assertEquals(listOf("bulkAction", bulk("r-1")), reopened.pending()[1].args)

        reopened.append("update", listOf("""{"id":"t","base":{},"patch":{},"requestId":"r-9"}"""))
        assertEquals(listOf("complete", "menuCommand", "taskFocus", "update"), open().pending().map { it.method })
    }

    @Test fun aFrozenProjectCalendarReferenceSurvivesJournalRecreation() {
        val envelope = """{"request":{"requestId":"r","projectId":"p","value":null},"prepared":{"version":1}}"""
        val entry = open().append("projectCalendarReferenceCommit", listOf(envelope))!!
        assertTrue(entry.file.exists())
        val restored = open().pending().single()
        assertEquals("projectCalendarReferenceCommit", restored.method)
        assertEquals(listOf(envelope), restored.args)
        assertEquals(entry.text, restored.text)
    }

    @Test fun anEntryIsDurableBeforeAppendReturns() {
        val dir = File(folder.root, "journal")
        val entry = open(dir).append("complete", listOf("task-1", "3:dev:2026"))!!


        assertTrue(entry.file.exists())
        assertEquals(listOf(entry.file.name), syncs.last())
        assertEquals(listOf(entry.file.name), names(dir))
        assertEquals(entry.text, entry.file.readText())
    }

    @Test fun aWriteCutShortIsNeverAnEntry() {
        val dir = File(folder.root, "journal").apply { mkdirs() }

        File(dir, "0000000000000001.json.tmp").writeText("""{"method":"compl""")
        val journal = open(dir)
        assertEquals(emptyList<WriteJournal.Entry>(), journal.pending())
        assertEquals(emptyList<String>(), names(dir))
        assertTrue(logged.any { it.contains("partial=1") })
    }

    @Test fun anyFinalReplyDropsTheEntry() {
        val journal = open()
        for (error in listOf(null, "STALE_REVISION: changed", "INVALID_INPUT: no", "TASK_NOT_FOUND: gone", "NOT_FOUND: gone", "ACTION_FAILED: refused")) {
            val entry = journal.append("complete", listOf("task-1", "rev-$error"))!!
            journal.settle(entry, error)
            assertFalse("$error drops the entry", entry.file.exists())
        }
        assertEquals(emptyList<WriteJournal.Entry>(), open().pending())
    }

    @Test fun saveFailedKeepsTheEntryAndItsRetryReusesIt() {
        val journal = open()
        val entry = journal.append("menuCommand", listOf("bulkAction", bulk("r-2")))!!
        journal.settle(entry, "SAVE_FAILED: disk full")
        assertTrue(entry.file.exists())

        val again = journal.append("menuCommand", listOf("bulkAction", bulk("r-2")))!!
        assertSame(entry, again)
        assertEquals(1, File(folder.root, "journal").listFiles()!!.count { it.isFile })
        journal.settle(again, null)
        assertFalse(entry.file.exists())
        assertEquals(emptyList<WriteJournal.Entry>(), open().pending())
    }

    @Test fun damagedOrUnknownEntriesMoveAsideAndAreNeverReplayed() {
        val dir = File(folder.root, "journal").apply { mkdirs() }
        val good = open(dir).append("complete", listOf("task-1", "3:dev:2026"))!!
        val damaged = mapOf(
            "0000000000000002.json" to "not json",
            "0000000000000003.json" to """{"method":"boot","args":["",""]}""",
            "0000000000000004.json" to """{"method":"complete","args":[{"id":"x"}]}""",
            "0000000000000005.json" to """{"method":"complete"}""",
            "stray.json" to """{"method":"complete","args":["a","b"]}""",
        )
        for ((name, text) in damaged) File(dir, name).writeText(text)
        val journal = open(dir)
        assertEquals(listOf(good.text), journal.pending().map { it.text })
        val aside = File(dir, WriteJournal.ASIDE)

        for ((name, text) in damaged) assertEquals(text, File(aside, name).readText())
        assertEquals(listOf(good.file.name), names(dir))
        assertTrue(logged.any { it.contains("aside=5") })

        File(dir, "0000000000000002.json").writeText("also not json")
        open(dir)
        assertEquals(setOf("not json", "also not json"), aside.listFiles()!!.filter { it.name.startsWith("0000000000000002.json") }.map { it.readText() }.toSet())
    }

    @Test fun onlyWriteMethodsAreJournaled() {
        val journal = open()
        for (read in listOf("boot", "focus", "menuRead", "language", "captureSnapshot")) {
            val refused = runCatching { journal.append(read, listOf("x")) }.exceptionOrNull()
            assertTrue("$read is not a write", refused is IllegalArgumentException)
        }
        assertEquals(emptyList<WriteJournal.Entry>(), journal.pending())
    }


    @Test fun aJournalThatCannotBeListedRefusesToOpen() {
        val notADirectory = File(folder.root, "journal").apply { writeText("") }
        val refused = runCatching { open(notADirectory) }.exceptionOrNull()
        assertTrue("an unlistable journal refuses to open: $refused", refused is java.io.IOException)
    }

    @Test fun anAppendNeverReplacesAnEntryOnDisk() {
        val dir = File(folder.root, "journal")
        val journal = open(dir)

        val stray = File(dir, "0000000000000001.json").apply { writeText("""{"method":"complete","args":["a","1:x:t"]}""") }
        val refused = runCatching { journal.append("complete", listOf("task-1", "3:dev:2026")) }.exceptionOrNull()
        assertTrue("the append refuses: $refused", refused != null)
        assertEquals("""{"method":"complete","args":["a","1:x:t"]}""", stray.readText())
    }

    @Test fun theSequenceResumesAfterTheHighestNameSeen() {
        val dir = File(folder.root, "journal").apply { mkdirs() }
        File(dir, "0000000000000009.json").writeText("not json")
        File(dir, "0000000000000012.json.tmp").writeText("""{"method":"compl""")
        val entry = open(dir).append("complete", listOf("task-1", "3:dev:2026"))!!
        assertEquals("0000000000000013.json", entry.file.name)
    }


    @Test fun aDropIsDurableBeforeTheEntryLeaves() {
        val dir = File(folder.root, "journal")
        val journal = open(dir)
        val entry = journal.append("complete", listOf("task-1", "3:dev:2026"))!!
        assertTrue(journal.settle(entry, null))
        assertEquals(emptyList<String>(), syncs.last())
        assertEquals(emptyList<WriteJournal.Entry>(), journal.pending())
    }

    @Test fun aDeleteThatFailsKeepsTheEntry() {
        val dir = File(folder.root, "journal")
        val journal = open(dir)
        val entry = journal.append("complete", listOf("task-1", "3:dev:2026"))!!
        dir.setWritable(false)
        try {
            assertFalse(journal.settle(entry, null))
        } finally {
            dir.setWritable(true)
        }
        assertTrue(entry.file.exists())
        assertEquals(listOf(entry), journal.pending())
    }

    @Test fun aDropWhoseFolderSyncFailsKeepsTheEntry() {
        val dir = File(folder.root, "journal")
        var failing = false
        val journal = WriteJournal(dir, syncDirectory = { if (failing) throw java.io.IOException("sync failed") }, log = { logged += it })
        val entry = journal.append("complete", listOf("task-1", "3:dev:2026"))!!
        failing = true
        assertFalse(journal.settle(entry, null))
        assertEquals(listOf(entry), journal.pending())
    }


    @Test fun entriesThatNoLongerFitAWriteMoveAsideIntact() {
        val dir = File(folder.root, "journal").apply { mkdirs() }
        val misfits = mapOf(
            "0000000000000001.json" to """{"method":"menuCommand","args":["retiredCommand","{\"requestId\":\"secret-title\"}"]}""",
            "0000000000000002.json" to """{"method":"complete","args":["task-1"]}""",
            "0000000000000003.json" to """{"method":"complete","args":["task-1",""]}""",
            "0000000000000004.json" to """{"method":"update","args":["{\"id\":\"t\",\"base\":{},\"patch\":{}}"]}""",
            "0000000000000005.json" to """{"method":"taskFocus","args":["t","true","3:dev:2026"]}""",
            "0000000000000006.json" to """{"method":"menuCommand","args":["bulkAction","not json"]}""",
            "0000000000000007.json" to """{"method":"captureLines","args":["{\"text\":\"a\",\"captureIds\":\"x\"}"]}""",
        )
        for ((name, text) in misfits) File(dir, name).writeText(text)
        val fits = """{"method":"menuCommand","args":["bulkAction",${org.json.JSONObject.quote(bulk("r-3"))}]}"""
        File(dir, "0000000000000008.json").writeText(fits)
        val journal = open(dir)
        assertEquals(listOf(fits), journal.pending().map { it.text })
        for ((name, text) in misfits) assertEquals(text, File(dir, "${WriteJournal.ASIDE}/$name").readText())
        assertTrue(logged.any { it.contains("aside=7") })
        assertFalse(logged.any { it.contains("secret-title") || it.contains("task-1") })
    }


    @Test fun aReplayCoreRefusesAsMalformedMovesAsideIntact() {
        val dir = File(folder.root, "journal")

        val move = """{"taskIds":["a"],"requestId":"r-5","sectionId":null}"""
        val text = open(dir).append("menuCommand", listOf("somedayMove", move))!!.text
        val journal = open(dir)
        val entry = journal.pending().single()
        assertTrue(journal.settle(entry, "INVALID_INPUT: taskRevisions are required", replay = true))
        assertEquals(text, File(dir, "${WriteJournal.ASIDE}/${entry.file.name}").readText())
        assertEquals(emptyList<String>(), names(dir))
        assertEquals(emptyList<String>(), syncs.last())
        assertEquals(emptyList<WriteJournal.Entry>(), journal.pending())
        assertEquals(emptyList<WriteJournal.Entry>(), open(dir).pending())

        val retired = journal.append("menuCommand", listOf("bulkAction", bulk("r-6")))!!
        assertTrue(journal.settle(retired, "INVALID_INPUT: no menu command bulkAction", replay = true))
        assertTrue(File(dir, "${WriteJournal.ASIDE}/${retired.file.name}").exists())

        val sent = journal.append("complete", listOf("task-1", "3:dev:2026"))!!
        assertTrue(journal.settle(sent, "INVALID_INPUT: no"))
        assertFalse(sent.file.exists())
        assertFalse(File(dir, "${WriteJournal.ASIDE}/${sent.file.name}").exists())
    }

    @Test fun onlySaveFailedKeeps() {
        assertTrue(WriteJournal.keeps("SAVE_FAILED: Injected commit failure"))
        for (error in listOf(null, "STALE_REVISION: x", "INVALID_INPUT: x", "ACTION_FAILED: x", "Incomplete tasks load")) assertFalse(WriteJournal.keeps(error))
    }


    @Test fun aSyncScreenCommandNeverReachesTheDisk() {
        val dir = File(folder.root, "journal")
        val journal = open(dir)
        val save = """{"requestId":"r-1","revision":"c","webdav":{"url":"https://dav.example","username":"alice","password":"hunter22","allowInsecureHttp":false}}"""
        assertEquals(null, journal.append("menuCommand", listOf("saveSyncBackend", save)))
        assertEquals(emptyList<String>(), names(dir))
        for (command in WriteJournal.UNJOURNALED) assertTrue(command, WriteJournal.unjournaled("menuCommand", listOf(command, "{}")))

        assertFalse(WriteJournal.unjournaled("menuCommand", listOf("syncPreference", """{"requestId":"r-2"}""")))
        assertTrue(journal.append("menuCommand", listOf("syncPreference", """{"requestId":"r-2","key":"appearance","value":true}""")) != null)

        File(dir, "0000000000000099.json").writeText("""{"method":"menuCommand","args":["saveSyncBackend",${org.json.JSONObject.quote(save)}]}""")
        val reopened = open(dir)
        assertEquals(listOf("menuCommand"), reopened.pending().map { it.method })
        assertEquals("syncPreference", reopened.pending().single().args[0])
        assertTrue(File(dir, "${WriteJournal.ASIDE}/0000000000000099.json").exists())
    }


    @Test fun aProjectEditJournaledAheadSurvivesAKillAndIsSentOnce() {
        val dir = File(folder.root, "journal")
        val title = """{"requestId":"r-1","projectId":"p","kind":"title","title":"New"}"""
        val notes = """{"requestId":"r-2","projectId":"p","kind":"notes","text":"Typed"}"""
        val journal = open(dir)
        val first = journal.append("menuCommand", listOf("projectEdit", title))!!
        journal.append("menuCommand", listOf("projectEdit", notes))

        assertEquals(listOf(title, notes), open(dir).pending().map { it.args[1] })

        assertSame(first, journal.append("menuCommand", listOf("projectEdit", title)))
        assertTrue(journal.settle(first, null))
        assertEquals(listOf(notes), open(dir).pending().map { it.args[1] })

        File(dir, "0000000000000099.json").writeText("""{"method":"menuCommand","args":["projectEdit",${org.json.JSONObject.quote("""{"requestId":"r-3","projectId":"p"}""")}]}""")
        assertEquals(listOf(notes), open(dir).pending().map { it.args[1] })
    }
}
