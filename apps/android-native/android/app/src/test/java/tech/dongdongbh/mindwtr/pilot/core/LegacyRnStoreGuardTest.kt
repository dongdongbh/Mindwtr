package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class LegacyRnStoreGuardTest {
    /** A copy that cannot be made throws (the boot stops: requireClear does not catch it) and leaves RN's files and no copy. */
    @Test fun aFailedRkStorageCopyThrowsAndLeavesRnFilesAndNoPartialCopy() {
        val dataDir = Files.createTempDirectory("rn-guard").toFile()
        try {
            val rkStorage = File(dataDir, "databases/RKStorage").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1, 2, 3)) }
            val wal = File(dataDir, "databases/RKStorage-wal").apply { writeBytes(byteArrayOf(4, 5)) }
            // files/SQLite is a file, so the checkpoint's folder cannot be made.
            File(dataDir, "files").mkdirs()
            File(dataDir, "files/SQLite").writeText("not a folder")
            val failed = runCatching { LegacyRnStoreGuard.checkpointRnState(dataDir) }
            assertTrue(failed.isFailure)
            assertArrayEquals(byteArrayOf(1, 2, 3), rkStorage.readBytes())
            assertArrayEquals(byteArrayOf(4, 5), wal.readBytes())
            assertFalse(File(dataDir, "files/SQLite/RKStorage.prewrite").exists())
            assertFalse(File(dataDir, "files/SQLite/RKStorage.prewrite.building").exists())
        } finally {
            dataDir.deleteRecursively()
        }
    }
}
