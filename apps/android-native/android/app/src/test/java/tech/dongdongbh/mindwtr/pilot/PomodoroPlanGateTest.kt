package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class PomodoroPlanGateTest {
    @Test fun aReplayedTransitionPlansOnTheNextRead() {
        val gate = PomodoroPlanGate()
        assertTrue(gate.take("s:1"))
        assertFalse(gate.take("s:1"))

        assertTrue(gate.take("s:2"))
        assertFalse(gate.take("s:2"))
    }

    @Test fun aRequestedPlanSurvivesANewerRead() {
        val gate = PomodoroPlanGate()
        gate.take("s:1")

        gate.request()
        assertTrue(gate.take("s:1"))
        assertFalse(gate.take("s:1"))
    }

    @Test fun aTransitionThatPlannedIsNotPlannedAgain() {
        val gate = PomodoroPlanGate()
        gate.planned("s:3")
        assertFalse(gate.take("s:3"))
    }
}
