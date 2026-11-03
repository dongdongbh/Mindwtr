package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class CaptureVoiceTest {
    private class Harness(var defaultAudio: Boolean = false, var sandbox: Boolean = false) {
        val calls = mutableListOf<String>()
        val notices = mutableListOf<VoiceNotice>()
        val saved = mutableListOf<String>()
        val inputs = mutableListOf<JSONObject>()
        val replies = mutableMapOf<String, ArrayDeque<JSONObject>>()
        var duringStop: VoiceUi? = null
        lateinit var voice: CaptureVoice
        fun answer(name: String, vararg json: String) { replies.getOrPut(name) { ArrayDeque() }.addAll(json.map(::JSONObject)) }
        fun make(): CaptureVoice = CaptureVoice(
            call = { name, input ->
                calls += if (input.has("text")) "$name:${input.getString("text")}" else name
                inputs += JSONObject(input.toString())
                if (name == "stop") duringStop = voice.state
                when (name) {
                    "open" -> JSONObject().put("session", 7).put("defaultAudio", defaultAudio).put("sandbox", sandbox)
                    "defaults" -> JSONObject().put("defaultAudio", defaultAudio)
                    else -> replies[name]?.removeFirstOrNull() ?: JSONObject().put("status", "closed")
                }
            },
            io = { it() }, ui = { it() }, notice = { notices += it }, saved = { saved += it.getString("taskId") }, later = { _, run -> run() },
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


    @Test fun theAutomaticStartRunsOncePerOpenPopupAndFollowsTheDefaultMethod() {
        val h = Harness(defaultAudio = true)
        h.answer("start", """{"status":"not-configured"}""", """{"status":"not-configured"}""")
        val voice = h.make()
        voice.opened(AutoRecord.DEFAULT)
        assertEquals(listOf("open", "start"), h.calls)

        assertEquals(1, h.calls.count { it == "start" })
        voice.closed()
        voice.opened(AutoRecord.OPPOSITE)
        assertEquals(1, h.calls.count { it == "start" })
        h.defaultAudio = false
        voice.opened(AutoRecord.OPPOSITE)
        assertEquals(2, h.calls.count { it == "start" })
    }


    @Test fun theAutomaticStartWaitsOutSandboxMode() {
        val h = Harness(defaultAudio = true, sandbox = true)
        val voice = h.make()
        voice.opened(AutoRecord.DEFAULT)
        voice.opened(AutoRecord.ON)
        assertEquals(0, h.calls.count { it == "start" })
        assertTrue(h.notices.isEmpty())
    }


    @Test fun theDefaultCaptureMethodIsReadForTheCenterButton() {
        val h = Harness(defaultAudio = true)
        val voice = h.make()
        assertFalse(voice.defaultAudio)
        voice.refreshDefault()
        assertTrue(voice.defaultAudio)
        h.defaultAudio = false
        voice.opened(AutoRecord.OFF)
        assertFalse(voice.defaultAudio)
    }


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
        assertTrue(voice.saveHeld("Call mom", JSONObject(), openAfterSave = true))
        assertEquals(listOf("t9"), h.saved)

        assertTrue(h.inputs.last().getBoolean("openAfterSave"))
        assertFalse(voice.state.held)
        assertFalse(voice.saveHeld("Again", JSONObject(), openAfterSave = false))
    }


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
