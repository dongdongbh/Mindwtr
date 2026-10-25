package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Core's reminder plan applied in core's order (native-host-contract-reminders.ts), and React Native's old alarms cancelled once. */
class ReminderPlanTest {
    private val events = mutableListOf<String>()
    private var scheduleFailure: Throwable? = null
    /** Only the alarm with this id is refused (null: every alarm, with [scheduleFailure]). */
    private var refusedId: Int? = null

    private val port = object : ReminderPlan.Port {
        override fun store(entries: Map<String, String>) { events += "store ${entries.values.joinToString(" + ")}" }
        override fun removeDelivered(id: Int) { events += "remove $id" }
        override fun cancel(id: Int) { events += "cancel $id" }
        override fun schedule(alarm: JSONObject) {
            scheduleFailure?.takeIf { refusedId == null || refusedId == alarm.getInt("id") }?.let { events += "refused ${alarm.getInt("id")}"; throw it }
            events += "schedule ${alarm.getInt("id")} ${alarm.getString("key")}"
        }
        override fun clearDelivered() { events += "clear" }
    }

    private fun alarm(key: String, id: Int, replacing: String?) = JSONObject().put("key", key).put("id", id).put("fireAtMs", 1_000L)
        .put("repeat", "once").put("details", JSONObject().put("title", "t")).put("replacing", replacing ?: JSONObject.NULL)

    private fun plan(writeAhead: String?, cancel: List<Pair<Int, String>>, schedule: List<JSONObject>, clearDelivered: Boolean = false) = JSONObject()
        .put("mode", if (clearDelivered) "revoked" else "active")
        .put("writeAhead", writeAhead ?: JSONObject.NULL)
        .put("cancel", JSONArray(cancel.map { (id, reason) -> JSONObject().put("key", "task:$id").put("id", id).put("reason", reason) }))
        .put("schedule", JSONArray(schedule))
        .put("alarms", "{after}")
        .put("topUpDelayMs", JSONObject.NULL)
        .put("clearDelivered", clearDelivered)

    @Test fun theWriteAheadIsStoredBeforeAnyAlarmChangesAndTheAlarmsLast() {
        ReminderPlan.apply(plan("{ahead}", listOf(7 to "expired"), listOf(alarm("task:a", 11, null))), port)
        assertEquals(listOf("store {ahead}", "cancel 7", "schedule 11 task:a", "store {after}"), events)
    }

    @Test fun aWithdrawnAlarmRemovesWhatItDeliveredFirstAndAnExpiredOneKeepsIt() {
        ReminderPlan.apply(plan("{ahead}", listOf(7 to "withdrawn", 8 to "expired"),
            listOf(alarm("task:a", 11, "withdrawn"), alarm("task:b", 12, "expired"), alarm("task:c", 13, null))), port)
        assertEquals(listOf("store {ahead}", "remove 7", "cancel 7", "cancel 8", "remove 11", "schedule 11 task:a", "schedule 12 task:b",
            "schedule 13 task:c", "store {after}"), events)
    }

    @Test fun aPlanThatMakesNothingStoresOnlyTheAlarms() {
        ReminderPlan.apply(plan(null, listOf(7 to "expired"), emptyList()), port)
        assertEquals(listOf("cancel 7", "store {after}"), events)
    }

    @Test fun theNativeStateIsStoredWithTheAlarmsInOneWrite() {
        val keys = mutableListOf<Set<String>>()
        val recording = object : ReminderPlan.Port by port {
            override fun store(entries: Map<String, String>) { keys += entries.keys; port.store(entries) }
        }
        ReminderPlan.apply(plan(null, listOf(7 to "expired"), emptyList()).put("state", "{delivered}"), recording)
        ReminderPlan.apply(plan(null, emptyList(), emptyList()).put("unchanged", true).put("state", "{none}"), recording)
        assertEquals(listOf("cancel 7", "store {after} + {delivered}", "store {none}"), events)
        assertEquals(listOf(setOf(ReminderPlan.MAP_KEY, ReminderPlan.STATE_KEY), setOf(ReminderPlan.STATE_KEY)), keys)
    }

    @Test fun aSnoozesStateAheadIsStoredBeforeItsAlarmAndItsStateAfter() {
        val snooze = plan(null, emptyList(), listOf(alarm("snooze:u", 1_073_741_900, null))).put("unchanged", true)
            .put("stateAhead", "{pending}").put("state", "{made}")
        ReminderPlan.apply(snooze, port)
        ReminderPlan.apply(plan("{ahead}", emptyList(), listOf(alarm("task:a", 11, null))).put("stateAhead", "{pending}"), port)
        assertEquals(listOf("store {pending}", "schedule 1073741900 snooze:u", "store {made}",
            "store {ahead} + {pending}", "schedule 11 task:a", "store {after}"), events)
    }

    @Test fun aPlanThatChangesNothingWritesNothing() {
        ReminderPlan.apply(plan(null, emptyList(), emptyList()).put("unchanged", true), port)
        assertEquals(emptyList<String>(), events)
    }

    @Test fun reactNativesMapsAreRemovedOnlyWhenTheyExist() {
        RnAlarmCleanup.run(rows = { emptyList<List<Int>>() }, cancel = { events += "cancel $it" }, cancelNative = { events += "native" }, stripButtons = { events += "strip" }, forgetMaps = { events += "forget" }, deleteTable = { events += "delete" })
        assertEquals(listOf("native", "strip", "forget", "delete"), events)
    }

    @Test fun noPermissionClearsTheDeliveredRemindersBeforeTheEmptyMapIsStored() {
        ReminderPlan.apply(plan(null, listOf(7 to "withdrawn"), emptyList(), clearDelivered = true), port)
        assertEquals(listOf("remove 7", "cancel 7", "clear", "store {after}"), events)
    }

    // RN 271fb6be2: one refused alarm (a revoked exact-alarm grant, Android's 500 cap) is skipped and the rest are made.
    @Test fun aRefusedAlarmIsSkippedAndTheRestAreMade() {
        scheduleFailure = SecurityException("Too many alarms")
        refusedId = 11
        val ahead = """{"task:a":{"id":11,"pending":true},"task:b":{"id":12,"pending":true}}"""
        val refused = ReminderPlan.apply(plan(ahead, listOf(7 to "expired"), listOf(alarm("task:a", 11, null), alarm("task:b", 12, null)))
            .put("alarms", """{"task:a":{"id":11},"task:b":{"id":12}}"""), port)
        assertEquals(1, refused)
        assertEquals(listOf("store $ahead", "cancel 7", "refused 11", "cancel 11", "schedule 12 task:b"), events.dropLast(1))
    }

    // RN 271fb6be2's map: the final map is stored with only the refused alarm put back as not yet made (its write-ahead entry), so a
    // cancel in that plan stays cancelled and a moved alarm is judged by its new version; the refused one is made again next time.
    // Its replacement never armed, so the alarm it was replacing is cancelled too: it must not fire at its old time with the new payload.
    @Test fun aRefusalStoresTheFinalMapWithTheRefusedAlarmPendingAndCancelsWhatItWasReplacing() {
        scheduleFailure = SecurityException("Too many alarms")
        refusedId = 11
        val ahead = JSONObject().put("task:a", JSONObject().put("id", 11).put("signature", "old").put("pending", true))
            .put("task:b", JSONObject().put("id", 12).put("signature", "b2").put("pending", true))
            .put("task:gone", JSONObject().put("id", 7).put("signature", "g"))
        val final = JSONObject().put("task:a", JSONObject().put("id", 11).put("signature", "new"))
            .put("task:b", JSONObject().put("id", 12).put("signature", "b2"))
        val refused = ReminderPlan.apply(plan(ahead.toString(), listOf(7 to "withdrawn"), listOf(alarm("task:a", 11, "withdrawn"), alarm("task:b", 12, null)))
            .put("alarms", final.toString()).put("state", "{state}"), port)
        assertEquals(1, refused)
        val stored = JSONObject(events.last().removePrefix("store ").substringBefore(" + "))
        assertEquals(listOf("task:a", "task:b"), stored.keys().asSequence().sorted().toList())
        assertEquals("old", stored.getJSONObject("task:a").getString("signature"))
        assertEquals(true, stored.getJSONObject("task:a").getBoolean("pending"))
        assertEquals("b2", stored.getJSONObject("task:b").getString("signature"))
        assertEquals("{state}", events.last().substringAfter(" + "))
        assertEquals(listOf("remove 7", "cancel 7", "remove 11", "refused 11", "cancel 11", "schedule 12 task:b"), events.drop(1).dropLast(1))
    }

    // A refused Snooze (its own plan: no map, `stateAhead` says not yet made) keeps that state, so the retry makes it once.
    @Test fun aRefusedSnoozeKeepsItsNotYetMadeState() {
        scheduleFailure = SecurityException("Too many alarms")
        val snooze = plan(null, emptyList(), listOf(alarm("snooze:u", 1073741900, null))).put("stateAhead", "{ahead-state}")
            .put("state", "{made}").put("unchanged", true)
        assertEquals(1, ReminderPlan.apply(snooze, port))
        assertEquals(listOf("store {ahead-state}", "refused 1073741900", "cancel 1073741900"), events)
    }

    @Test fun aPlanWithNoRefusalReportsNone() {
        assertEquals(0, ReminderPlan.apply(plan("{ahead}", emptyList(), listOf(alarm("task:a", 11, null))), port))
    }

    @Test fun aRemovalThatFailsNeverStopsTheCancel() {
        val failing = object : ReminderPlan.Port by port {
            override fun removeDelivered(id: Int) { events += "remove $id"; throw IllegalStateException("gone") }
        }
        ReminderPlan.apply(plan(null, listOf(7 to "withdrawn"), emptyList()), failing)
        assertEquals(listOf("remove 7", "cancel 7", "store {after}"), events)
    }

    @Test fun theCheckpointsSitAfterTheWriteAheadAndAfterTheAlarmsAreMade() {
        ReminderPlan.apply(plan("{ahead}", emptyList(), listOf(alarm("task:a", 11, null))), port) { events += "checkpoint $it" }
        assertEquals(listOf("store {ahead}", "checkpoint write-ahead", "schedule 11 task:a", "checkpoint scheduled", "store {after}"), events)
    }

    /** A ledger on [store], as a new process would open it (SharedPreferences in the app). */
    private fun ledger(store: MutableMap<Int, String>) = ReminderLedger(read = { store.toMap() },
        write = { changes -> changes.forEach { (id, value) -> if (value == null) store.remove(id) else store[id] = value }; true })

    @Test fun aLedgerWriteThatFailsStopsThePlanBeforeAnyAlarmChangesButNeverHidesADelivery() {
        val disk = mutableMapOf(5 to "armed:1000")
        val failing = ReminderLedger(read = { disk.toMap() }, write = { false })
        assertThrows(IllegalStateException::class.java) { failing.record(cancelled = listOf(5), armed = listOf(6 to 2_000L)) }
        assertThrows(IllegalStateException::class.java) { failing.clear() }
        // Through a plan: the write-ahead is stored, then the ledger write fails, and no alarm is cancelled or made.
        val port = object : ReminderPlan.Port by port {
            override fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) = failing.record(cancelled, armed)
        }
        assertThrows(IllegalStateException::class.java) {
            ReminderPlan.apply(plan("{ahead}", listOf(5 to "expired"), listOf(alarm("task:a", 6, null))), port)
        }
        assertEquals(listOf("store {ahead}"), events)
        // A one-shot whose fired mark cannot be written still shows once: silence is worse than a rare second showing.
        assertEquals(true, failing.deliver(5, 1000, "once", 1001))
    }

    @Test fun aDeliveryShowsOnlyWhileTheLedgerOnDiskHoldsItsAlarmAtItsTimeAcrossProcesses() {
        val disk = mutableMapOf<Int, String>()
        val hour = 3_600_000L
        // Unknown to the ledger (cancelled, or never this app's): nothing shows.
        assertEquals(false, ledger(disk).deliver(5, 10 * hour, "once", 10 * hour + 1))
        ledger(disk).record(cancelled = emptyList(), armed = listOf(5 to 10 * hour, 6 to 8 * hour, 7 to 9 * hour))
        // Made again for 11:00 (the task moved) while the 10:00 delivery was queued: that one shows nothing.
        ledger(disk).record(cancelled = emptyList(), armed = listOf(5 to 11 * hour))
        assertEquals(false, ledger(disk).deliver(5, 10 * hour, "once", 10 * hour + 1))
        // Cancelled, then the process died: the queued delivery in the next process shows nothing (a disabled digest too).
        ledger(disk).record(cancelled = listOf(6), armed = emptyList())
        assertEquals(false, ledger(disk).deliver(6, 8 * hour, "daily", 8 * hour + 1))
        // A one-shot shows once and is recorded as fired, on disk; a repeating one stays armed until core makes it again.
        assertEquals(true, ledger(disk).deliver(5, 11 * hour, "once", 11 * hour + 1))
        assertEquals(false, ledger(disk).deliver(5, 11 * hour, "once", 11 * hour + 2))
        assertEquals(listOf(5), ledger(disk).fired())
        ledger(disk).record(cancelled = emptyList(), armed = listOf(8 to 8 * hour))
        assertEquals(true, ledger(disk).deliver(8, 8 * hour, "daily", 8 * hour + 1))
        assertEquals(true, ledger(disk).deliver(8, 8 * hour, "daily", 8 * hour + 2))
        assertEquals(setOf(5, 7, 8), ledger(disk).ids())
    }

    @Test fun aOneShotMoreThanADayLateShowsNothingAsReactNativesLibraryDiscardsIt() {
        val disk = mutableMapOf<Int, String>()
        val day = 24 * 3_600_000L
        ledger(disk).record(cancelled = emptyList(), armed = listOf(5 to 0L, 6 to 0L, 7 to 0L))
        assertEquals(true, ledger(disk).deliver(5, 0, "once", day))
        assertEquals(false, ledger(disk).deliver(6, 0, "once", day + 1))
        assertEquals(true, ledger(disk).deliver(7, 0, "weekly", 3 * day))
    }

    @Test fun thePlansLedgerIsWrittenAfterTheWriteAheadAndBeforeAnyAlarmChanges() {
        val recording = object : ReminderPlan.Port by port {
            override fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) { events += "ledger -$cancelled +${armed.map { it.first }}" }
        }
        ReminderPlan.apply(plan("{ahead}", listOf(7 to "expired"), listOf(alarm("task:a", 11, null))), recording)
        assertEquals(listOf("store {ahead}", "ledger -[7] +[11]", "cancel 7", "schedule 11 task:a", "store {after}"), events)
    }

    @Test fun reactNativesAlarmsAreCancelledBeforeItsMapGoesAndTheTableLast() {
        val done = RnAlarmCleanup.run(rows = { listOf(listOf(1_790_000_001), listOf(3, 1_790_000_002)) }, cancel = { events += "cancel $it" },
            cancelNative = { events += "native" }, stripButtons = { events += "strip" }, forgetMaps = { events += "forget" }, deleteTable = { events += "delete" })
        assertEquals(2, done)
        // RN's delivered reminders lose their buttons (they target RN's receiver, which is gone) while RN's inventory still exists.
        // An RN build ran since this app's last start (native → RN → native): every alarm this app made before goes too, so one
        // whose task was completed in RN never shows.
        assertEquals(listOf("cancel 1790000001", "cancel 3", "cancel 1790000002", "native", "strip", "forget", "delete"), events)
    }

    @Test fun aCleanupStoppedPartWayKeepsTheMapAndTheTableForTheNextStart() {
        assertThrows(IllegalStateException::class.java) {
            RnAlarmCleanup.run(rows = { listOf(listOf(1), listOf(2)) }, cancel = { events += "cancel $it"; if (it == 2) throw IllegalStateException("stopped") },
                cancelNative = { events += "native" }, stripButtons = { events += "strip" }, forgetMaps = { events += "forget" }, deleteTable = { events += "delete" })
        }
        assertEquals(listOf("cancel 1", "cancel 2"), events)
    }

    @Test fun aReactNativeRowThatCannotBeReadFailsTheCleanupAndKeepsEverything() {
        assertEquals(listOf(listOf(1_790_000_001)), RnAlarmCleanup.requestCodes(listOf("""{"alarmId":1790000001,"id":3}""")))
        // RN's release builds shrink AlarmModel's field names (R8): every whole number in the row is a candidate request code. A code
        // that names no RN alarm finds no PendingIntent and cancels nothing (FLAG_NO_CREATE).
        assertEquals(listOf(listOf(3, 1_790_000_001)), RnAlarmCleanup.requestCodes(listOf("""{"A":3,"B":"Pay rent","q":1790000001,"r":true,"s":1.5,"t":99999999999}""")))
        for (row in listOf(null, "{not json", """{"A":"x","B":true}""")) {
            assertThrows(IllegalStateException::class.java) { RnAlarmCleanup.requestCodes(listOf("""{"alarmId":1}""", row)) }
        }
        assertThrows(IllegalStateException::class.java) {
            RnAlarmCleanup.run(rows = { RnAlarmCleanup.requestCodes(listOf("{not json")) }, cancel = { events += "cancel $it" },
                cancelNative = { events += "native" }, stripButtons = { events += "strip" }, forgetMaps = { events += "forget" }, deleteTable = { events += "delete" })
        }
        assertEquals(emptyList<String>(), events)
    }

    @Test fun onlyAMissingTableReadsAsNoReactNativeAlarm() {
        assertEquals(true, RnAlarmCleanup.isMissingTable(RuntimeException("no such table: alarmtbl (code 1 SQLITE_ERROR)")))
        assertEquals(false, RnAlarmCleanup.isMissingTable(RuntimeException("database disk image is malformed (code 11)")))
        assertEquals(false, RnAlarmCleanup.isMissingTable(RuntimeException("no such column: gson_data")))
    }

    @Test fun theCleanupForgetsOnlyReactNativesAlarmMapNeverItsPomodoroRecord() {
        // The upgrade allows exactly one RKStorage key to change; RN's Pomodoro record belongs to the Pomodoro pass (R2).
        assertEquals(listOf("mindwtr:local:alarms:v1"), RnAlarmCleanup.FORGOTTEN_KEYS)
    }

    @Test fun noReactNativeTableMeansNothingToDo() {
        assertEquals(0, RnAlarmCleanup.run(rows = { null }, cancel = { events += "cancel $it" }, cancelNative = { events += "native" }, stripButtons = { events += "strip" }, forgetMaps = { events += "forget" }, deleteTable = { events += "delete" }))
        assertEquals(emptyList<String>(), events)
    }
}
