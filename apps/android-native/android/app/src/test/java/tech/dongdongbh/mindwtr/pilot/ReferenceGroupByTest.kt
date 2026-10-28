package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * RN 51703a756 (feedback 70cdb7d2): Reference remembers its grouping between visits. A new visit (or a new process) has no choice
 * of its own and reads the one saved under RN's key; a value core's picker does not offer is core's default.
 */
class ReferenceGroupByTest {
    @Test fun usesRnsKey() = assertEquals("mindwtr:view:reference:groupBy:v1", REFERENCE_GROUP_BY_KEY)

    @Test fun aNewVisitReadsTheSavedChoice() {
        for (saved in listOf("none", "context", "area", "project", "tag")) assertEquals(saved, referenceGroupBy(null, saved))
    }

    @Test fun thisVisitsChoiceWins() = assertEquals("project", referenceGroupBy("project", "tag"))

    @Test fun nothingOrAnUnknownValueIsCoresDefault() {
        assertNull(referenceGroupBy(null, null))
        assertNull(referenceGroupBy(null, "status"))
        assertNull(referenceGroupBy(null, ""))
    }
}
