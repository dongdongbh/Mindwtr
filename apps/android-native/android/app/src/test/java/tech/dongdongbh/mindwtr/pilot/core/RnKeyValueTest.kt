package tech.dongdongbh.mindwtr.pilot.core

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files


class RnKeyValueTest {
    private fun withStore(test: (File, RnKeyValue) -> Unit) {
        val dir = Files.createTempDirectory("rkstorage").toFile()
        try {
            val file = File(dir, "databases/RKStorage")
            test(file, RnKeyValue(file))
        } finally {
            dir.deleteRecursively()
        }
    }


    private fun failWritesOf(file: File, key: String) = BundledSQLiteDriver().open(file.path).use { connection ->
        connection.execSQL("CREATE TRIGGER fail_${key.hashCode().toUInt()} BEFORE INSERT ON catalystLocalStorage WHEN NEW.key = '$key' " +
            "BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    }

    @Test fun aFailedMultiSetWritesNoneOfItsKeysAndTheReopenedStoreKeepsTheOldValues() = withStore { file, store ->
        store.multiSet(listOf("@mindwtr_sync_backend" to "webdav", "@mindwtr_pending_remote_write" to "old"))
        failWritesOf(file, "boom")

        val failed = runCatching {
            store.multiSet(listOf("@mindwtr_sync_backend" to "cloud", "@mindwtr_pending_remote_write" to "new", "boom" to "x"))
        }

        assertTrue(failed.isFailure)
        val reopened = RnKeyValue(file)
        assertEquals("webdav", reopened.get("@mindwtr_sync_backend"))
        assertEquals("old", reopened.get("@mindwtr_pending_remote_write"))
        assertNull(reopened.get("boom"))

        reopened.set("@mindwtr_sync_backend", "cloud")
        assertEquals("cloud", RnKeyValue(file).get("@mindwtr_sync_backend"))
    }

    @Test fun aFailedApplyUndoesTheRemovalAndTheWriteItHadAlreadyRun() = withStore { file, store ->
        store.multiSet(listOf("a" to "1", "b" to "2"))
        failWritesOf(file, "boom")

        val failed = runCatching { store.apply(linkedMapOf("a" to null, "b" to "3", "boom" to "x")) }

        assertTrue(failed.isFailure)
        val reopened = RnKeyValue(file)
        assertEquals("1", reopened.get("a"))
        assertEquals("2", reopened.get("b"))
    }
}
