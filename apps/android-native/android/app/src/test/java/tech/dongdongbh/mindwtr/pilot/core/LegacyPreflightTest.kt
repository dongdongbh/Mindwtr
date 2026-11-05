package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class LegacyPreflightTest {
    private fun needed(jsonAhead: Boolean = false, reconciled: Boolean = false, backup: Boolean = false, database: Boolean = true) =
        LegacyRnStoreGuard.preflightNeeded(jsonAhead, reconciled, backup, database)

    @Test fun theJsonAheadMarkerAlwaysNeedsIt() {
        assertTrue(needed(jsonAhead = true))
        assertTrue(needed(jsonAhead = true, reconciled = true, backup = true))

        assertTrue(needed(jsonAhead = true, reconciled = true))
    }

    @Test fun aBackupTheImportStillReadsNeedsIt() {
        assertTrue(needed(backup = true))
        assertTrue(needed(backup = true, reconciled = true, database = false))
    }

    @Test fun aFinishedImportOrNoBackupOpensAtOnce() {
        assertFalse(needed(backup = true, reconciled = true))
        assertFalse(needed())
        assertFalse(needed(database = false))
        assertFalse(needed(reconciled = true))
    }
}
