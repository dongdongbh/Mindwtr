package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


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
