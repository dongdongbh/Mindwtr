package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Core's Gmail receipt store on this host (gmail-receipt-store.ts GmailReceiptFiles, design G2): the file calls reach only the
 * receipts files in filesDir/GmailCapture, and the SQL runs on the bundled driver, so the strict two-table check finds no
 * android_metadata table.
 */
class HostGmailReceiptsTest {
    private fun withFolder(test: (File, HostGmailReceipts) -> Unit) {
        val dir = Files.createTempDirectory("gmail-receipts").toFile()
        try {
            val folder = File(dir, "GmailCapture")
            test(folder, HostGmailReceipts(folder))
        } finally {
            dir.deleteRecursively()
        }
    }

    private fun refused(action: () -> Unit) {
        try { action(); fail("expected a refusal") } catch (_: IllegalArgumentException) {}
    }

    @Test fun everyNameOutsideTheReceiptsFilesIsRefused() = withFolder { folder, receipts ->
        for (name in listOf("mindwtr-native-dev.db", "../receipts.sqlite", "receipts.sqlite/x", "receipts.corrupt-x.sqlite",
            "receipts.corrupt-.sqlite", "receipts.sqlite-wal2", "", "/data/receipts.sqlite", "receipts-reset-1")) {
            refused { receipts.file("exists", name, "") }
            refused { receipts.file("create", name, "") }
            refused { receipts.file("rename", "receipts.sqlite", name) }
            refused { receipts.file("open", name, "") }
        }
        // A journal of a moved file is a receipts file; the marker is too; the task database never is.
        for (name in listOf("receipts.sqlite", "receipts.sqlite-wal", "receipts.sqlite-shm", "receipts.sqlite-journal",
            "receipts.corrupt-1730000000000.sqlite", "receipts.corrupt-1730000000000.sqlite-journal", "receipts-reset")) {
            assertEquals("false", receipts.file("exists", name, ""))
        }
        refused { receipts.file("chmod", "receipts.sqlite", "") }
        assertFalse(folder.resolve("../receipts.sqlite").normalize().exists())
    }

    @Test fun createFailsOverAFileAndRenameNeverReplacesOne() = withFolder { folder, receipts ->
        receipts.file("create", "receipts.sqlite", "")
        assertTrue(File(folder, "receipts.sqlite").isFile)
        assertEquals("0", receipts.file("size", "receipts.sqlite", ""))
        try { receipts.file("create", "receipts.sqlite", ""); fail("created over a file") } catch (_: IllegalStateException) {}
        receipts.file("create", "receipts-reset", "")
        try { receipts.file("rename", "receipts.sqlite", "receipts-reset"); fail("renamed over a file") } catch (_: Exception) {}
        receipts.file("rename", "receipts.sqlite", "receipts.corrupt-7.sqlite")
        assertEquals(listOf("receipts-reset", "receipts.corrupt-7.sqlite"), JSONArray(receipts.file("list", "", "")).let { names -> List(names.length()) { names.getString(it) } }.sorted())
        receipts.file("remove", "receipts-reset", "")
        assertEquals("false", receipts.file("exists", "receipts-reset", ""))
    }

    @Test fun theListShowsOnlyReceiptsFiles() = withFolder { folder, receipts ->
        receipts.file("create", "receipts.sqlite", "")
        File(folder, "notes.txt").writeText("x")
        assertEquals("[\"receipts.sqlite\"]", receipts.file("list", "", ""))
    }

    @Test fun theStoreRunsOnTheBundledDriverWithNoAndroidMetadataAndTypedRows() = withFolder { _, receipts ->
        receipts.file("create", "receipts.sqlite", "")
        receipts.file("open", "receipts.sqlite", "")
        receipts.sql("receipts.sqlite", "BEGIN IMMEDIATE", "[]")
        receipts.sql("receipts.sqlite", "CREATE TABLE receipts (account TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (account, message))", "[]")
        receipts.sql("receipts.sqlite", "CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), account TEXT, label TEXT, enabled INTEGER NOT NULL, blocked INTEGER NOT NULL)", "[]")
        receipts.sql("receipts.sqlite", "INSERT INTO control VALUES (1, NULL, NULL, 0, 1)", "[]")
        receipts.sql("receipts.sqlite", "COMMIT", "[]")
        val tables = JSONArray(receipts.sql("receipts.sqlite", "SELECT name FROM sqlite_master WHERE type = 'table'", "[]"))
        assertEquals(listOf("control", "receipts"), List(tables.length()) { tables.getJSONObject(it).getString("name") }.sorted())
        receipts.sql("receipts.sqlite", "UPDATE control SET account = ?, label = ?, enabled = ?, blocked = ? WHERE id = 1", "[\"a\",\"L\",1,0]")
        val row = JSONArray(receipts.sql("receipts.sqlite", "SELECT * FROM control", "[]")).getJSONObject(0)
        assertEquals(1L, row.getLong("enabled"))
        assertTrue(row.get("enabled") is Number)
        assertEquals("a", row.getString("account"))
        receipts.sql("receipts.sqlite", "UPDATE control SET label = ? WHERE id = 1", "[null]")
        assertTrue(JSONArray(receipts.sql("receipts.sqlite", "SELECT label FROM control", "[]")).getJSONObject(0).isNull("label"))
        receipts.file("close", "receipts.sqlite", "")
        // A closed file runs nothing until it opens again; its rows stayed.
        try { receipts.sql("receipts.sqlite", "SELECT 1", "[]"); fail("ran on a closed file") } catch (_: IllegalStateException) {}
        receipts.file("open", "receipts.sqlite", "")
        assertEquals("a", JSONArray(receipts.sql("receipts.sqlite", "SELECT account FROM control", "[]")).getJSONObject(0).getString("account"))
        assertTrue(receipts.file("size", "receipts.sqlite", "").toLong() >= 100)
    }
}
