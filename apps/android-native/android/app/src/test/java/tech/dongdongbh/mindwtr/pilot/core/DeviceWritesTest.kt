package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File


class DeviceWritesTest {
    @get:Rule val folder = TemporaryFolder()

    private val prefs = linkedMapOf<String, String>()
    private val devices = DeviceWrites({ prefs.toMap() }, { changes ->
        changes.forEach { (key, value) -> if (value == null) prefs.remove(key) else prefs[key] = value }
        true
    })
    private val key = "mindwtr:view:taskOpenMode:v1"
    private fun openMode(mode: String) = JSONArray().put(JSONObject().put("key", key).put("value", mode))
    private fun gtd(mode: String, requestId: String) = listOf("gtdSetting", """{"edit":{"type":"taskOpenMode","value":"$mode"},"requestId":"$requestId"}""")
    private fun journal(dir: File) = WriteJournal(dir, syncDirectory = {}, floor = devices.highestSequence())


    @Test fun aReplayNeverUndoesANewerSetting() {
        val dir = File(folder.root, "journal")
        val journal = journal(dir)
        val preview = journal.append("menuCommand", gtd("preview", "r-1"))!!
        devices.store(openMode("preview"), preview.sequence, replay = false)
        dir.setWritable(false)
        try {
            assertFalse(journal.settle(preview, null))
        } finally {
            dir.setWritable(true)
        }
        val automatic = journal.append("menuCommand", gtd("automatic", "r-2"))!!
        devices.store(openMode("automatic"), automatic.sequence, replay = false)
        assertTrue(journal.settle(automatic, null))

        val left = journal(dir).pending().single()
        devices.store(openMode("preview"), left.sequence, replay = true)
        assertEquals("automatic", prefs[key])
    }


    @Test fun theJournalStartsAboveEverySequenceASettingHolds() {
        devices.store(openMode("preview"), 10, replay = false)
        val entry = journal(File(folder.root, "journal")).append("menuCommand", gtd("automatic", "r-3"))!!
        assertEquals(11L, entry.sequence)
        devices.store(openMode("automatic"), entry.sequence, replay = true)
        assertEquals("automatic", prefs[key])
    }

    @Test fun aFirstSendAlwaysAppliesAndAFailedCommitThrows() {
        devices.store(openMode("preview"), 20, replay = false)
        devices.store(openMode("automatic"), 3, replay = false)
        assertEquals("automatic", prefs[key])
        val failing = DeviceWrites({ emptyMap<String, String>() }, { false })
        assertTrue(runCatching { failing.store(openMode("edit"), 4, replay = false) }.exceptionOrNull() is IllegalStateException)
    }
}
