package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a card read plans the alerts: a session the alerts were not planned for (a journal replay), or a plan a newer read took over. */
class PomodoroPlanGateTest {
    @Test fun aReplayedTransitionPlansOnTheNextRead() {
        val gate = PomodoroPlanGate()
        assertTrue(gate.take("s:1"))
        assertFalse(gate.take("s:1"))
        // The boot's journal replay committed a Start: the next plain Focus read finds a new generation.
        assertTrue(gate.take("s:2"))
        assertFalse(gate.take("s:2"))
    }

    @Test fun aRequestedPlanSurvivesANewerRead() {
        val gate = PomodoroPlanGate()
        gate.take("s:1")
        // A resume asks for a plan; its read loses to a newer Focus read, which must plan instead.
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
