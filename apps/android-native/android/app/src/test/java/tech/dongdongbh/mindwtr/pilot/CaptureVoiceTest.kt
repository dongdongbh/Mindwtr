package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Voice pass V5: the popup's microphone states (RN's recording, recordingBusy and recordingReady) over stand-in voice requests. */
class CaptureVoiceTest {
    private class Harness(var defaultAudio: Boolean = false) {
        val calls = mutableListOf<String>()
        val notices = mutableListOf<VoiceNotice>()
        val saved = mutableListOf<String>()
        val replies = mutableMapOf<String, ArrayDeque<JSONObject>>()
        var duringStop: VoiceUi? = null
        lateinit var voice: CaptureVoice
        fun answer(name: String, vararg json: String) { replies.getOrPut(name) { ArrayDeque() }.addAll(json.map(::JSONObject)) }
        fun make(): CaptureVoice = CaptureVoice(
            call = { name, input ->
                calls += if (input.has("text")) "$name:${input.getString("text")}" else name
                if (name == "stop") duringStop = voice.state
                when (name) {
                    "open" -> JSONObject().put("session", 7).put("defaultAudio", defaultAudio)
                    else -> replies[name]?.removeFirstOrNull() ?: JSONObject().put("status", "closed")
                }
            },
            io = { it() }, ui = { it() }, notice = { notices += it }, saved = { saved += it }, later = { _, run -> run() },
        ).also { voice = it }
    }

    @Test fun aRecordingStartsThenItsStopShowsProcessingAndASaveClosesThePopup() {
        val h = Harness()
        h.answer("start", """{"status":"recording","format":"m4a"}""")
        h.answer("stop", """{"status":"saved","taskId":"t1","held":false}""")
        val voice = h.make()
        voice.opened(AutoRecord.OFF)
        assertEquals(VoiceUi(session = 7), voice.state)
        voice.toggle("", JSONObject())
        assertEquals(VoiceUi(session = 7, recording = true), voice.state)
        voice.toggle("Call mom", JSONObject())
        // While the stop and save run: not recording, busy (RN's processing row and faded mic).
        assertEquals(VoiceUi(session = 7, recording = false, busy = true), h.duringStop)
        assertEquals(listOf("t1"), h.saved)
        assertEquals(listOf("open", "start", "stop:Call mom"), h.calls)
        assertFalse(voice.state.busy)
    }

    @Test fun noSpeechSetUpShowsRnsNoticeAndADeniedPermissionRnsAlert() {
        val h = Harness()
        h.answer("start", """{"status":"not-configured"}""", """{"status":"permission-denied"}""")
        val voice = h.make()
        voice.opened(AutoRecord.OFF)
        voice.toggle("", JSONObject())
        voice.toggle("", JSONObject())
        assertEquals(listOf(VoiceNotice.Toast("common.notice", "quickAdd.speechNotConfigured"),
            VoiceNotice.Alert("quickAdd.audioPermissionTitle", "quickAdd.audioPermissionBody")), h.notices)
        assertFalse(voice.state.recording)
    }

    // RN 4dea768a2: the automatic start runs once per open popup, never again after it records nothing.
    @Test fun theAutomaticStartRunsOncePerOpenPopupAndFollowsTheDefaultMethod() {
        val h = Harness(defaultAudio = true)
        h.answer("start", """{"status":"not-configured"}""", """{"status":"not-configured"}""")
        val voice = h.make()
        voice.opened(AutoRecord.DEFAULT)
        assertEquals(listOf("open", "start"), h.calls)
        // Its notice changed the state; nothing starts again by itself.
        assertEquals(1, h.calls.count { it == "start" })
        voice.closed()
        voice.opened(AutoRecord.OPPOSITE)
        assertEquals(1, h.calls.count { it == "start" })
        h.defaultAudio = false
        voice.opened(AutoRecord.OPPOSITE)
        assertEquals(2, h.calls.count { it == "start" })
    }

    // Voice V3 review N5: leaving the app ends the recording; the bundle forgets it and the next tap starts again.
    @Test fun leavingTheAppDuringARecordingClearsItAndTellsTheBundle() {
        val h = Harness()
        h.answer("start", """{"status":"recording"}""", """{"status":"recording"}""")
        val voice = h.make()
        voice.opened(AutoRecord.OFF)
        voice.toggle("", JSONObject())
        voice.left()
        assertEquals(VoiceUi(session = 7), voice.state)
        voice.toggle("", JSONObject())
        assertTrue(voice.state.recording)
        assertEquals(listOf("open", "start", "leave", "start"), h.calls)
    }

    // Voice V3 review N2: a refused save keeps its recording; the next Save sends the fixed draft with it.
    @Test fun aRefusedSaveKeepsTheRecordingAndTheNextSaveSendsIt() {
        val h = Harness()
        h.answer("start", """{"status":"recording"}""")
        h.answer("stop", """{"status":"refused","notice":{"title":"Date","message":"Unreadable"},"held":true}""")
        h.answer("save", """{"status":"saved","taskId":"t9","held":false}""")
        val voice = h.make()
        voice.opened(AutoRecord.OFF)
        voice.toggle("", JSONObject())
        voice.toggle("Call /due:someday", JSONObject())
        assertTrue(voice.state.held)
        assertEquals("Unreadable", (h.notices.single() as VoiceNotice.Core).notice.getString("message"))
        assertTrue(voice.saveHeld("Call mom", JSONObject()))
        assertEquals(listOf("t9"), h.saved)
        assertFalse(voice.state.held)
        assertFalse(voice.saveHeld("Again", JSONObject()))
    }

    // RN's capture-quick route: a mode decides, else autoRecord, else the default capture method.
    @Test fun aCaptureLinkRecordsByItsModeThenItsAutoRecordThenTheDefault() {
        assertEquals(AutoRecord.OFF, AutoRecord.forCaptureLink("mindwtr:///capture-quick?mode=text&entry=details"))
        assertEquals(AutoRecord.ON, AutoRecord.forCaptureLink("mindwtr://capture-quick?mode=audio"))
        assertEquals(AutoRecord.ON, AutoRecord.forCaptureLink("mindwtr://capture-quick?autoRecord=TRUE"))
        assertEquals(AutoRecord.OFF, AutoRecord.forCaptureLink("mindwtr://capture-quick?autoRecord=0"))
        assertEquals(AutoRecord.DEFAULT, AutoRecord.forCaptureLink("mindwtr://open?feature=capture"))
        assertEquals(AutoRecord.DEFAULT, AutoRecord.forCaptureLink(null))
        assertTrue(AutoRecord.DEFAULT.wants(defaultAudio = true))
        assertFalse(AutoRecord.OPPOSITE.wants(defaultAudio = true))
    }

    @Test fun closingThePopupEndsItsSessionAndIgnoresALateAnswer() {
        val h = Harness()
        h.answer("start", """{"status":"recording"}""")
        val voice = h.make()
        voice.opened(AutoRecord.OFF)
        voice.toggle("", JSONObject())
        voice.closed()
        assertEquals(VoiceUi(), voice.state)
        assertEquals("close", h.calls.last())
        voice.toggle("", JSONObject())
        assertEquals(listOf("open", "start", "close"), h.calls)
    }
}
