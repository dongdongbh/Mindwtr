package tech.dongdongbh.mindwtr.pilot

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject


data class VoiceUi(
    val session: Int? = null,
    val recording: Boolean = false,
    val busy: Boolean = false,

    val held: Boolean = false,
)


enum class AutoRecord {

    DEFAULT,

    OPPOSITE,

    ON,

    OFF,
    ;

    fun wants(defaultAudio: Boolean): Boolean = when (this) {
        DEFAULT -> defaultAudio
        OPPOSITE -> !defaultAudio
        ON -> true
        OFF -> false
    }

    companion object {


        fun forCaptureLink(url: String?): AutoRecord {
            val query = url?.substringAfter('?', "")?.substringBefore('#').orEmpty()
            val params = query.split('&').filter { it.isNotEmpty() }.associate { it.substringBefore('=') to it.substringAfter('=', "") }
            params["mode"]?.let { return if (it == "audio") ON else OFF }
            params["autoRecord"]?.let { return if (it == "1" || it.lowercase() == "true") ON else OFF }
            return DEFAULT
        }
    }
}


sealed class VoiceNotice {
    data class Toast(val titleKey: String, val messageKey: String) : VoiceNotice()
    data class Alert(val titleKey: String, val messageKey: String) : VoiceNotice()

    data class Core(val notice: JSONObject) : VoiceNotice()
}


class CaptureVoice(
    private val call: (String, JSONObject) -> JSONObject,
    private val io: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val notice: (VoiceNotice) -> Unit,

    private val saved: (JSONObject) -> Unit,

    private val later: (Long, () -> Unit) -> Unit,
) {
    var state by mutableStateOf(VoiceUi())
        private set


    var defaultAudio by mutableStateOf(false)
        private set


    private var openGeneration = 0

    private fun request(name: String, input: JSONObject = JSONObject(), answer: (JSONObject?) -> Unit) = io {
        val reply = runCatching { call(name, input) }.getOrNull()
        ui { answer(reply) }
    }

    private fun sessionInput(): JSONObject? = state.session?.let { JSONObject().put("session", it) }


    fun opened(auto: AutoRecord) {
        val requestGeneration = ++openGeneration
        state = VoiceUi()
        request("open") { reply ->
            if (requestGeneration != openGeneration || reply == null) return@request
            state = VoiceUi(session = reply.optInt("session"))
            defaultAudio = reply.optBoolean("defaultAudio")

            if (!reply.optBoolean("sandbox") && auto.wants(defaultAudio)) later(150) { if (requestGeneration == openGeneration) start() }
        }
    }


    fun refreshDefault() = request("defaults") { reply -> reply?.let { defaultAudio = it.optBoolean("defaultAudio") } }


    fun toggle(text: String, options: JSONObject) {
        val current = state
        if (current.busy || current.session == null) return
        if (current.recording) stop(text, options) else start()
    }

    private fun start() {
        val input = sessionInput() ?: return
        if (state.busy || state.recording) return
        state = state.copy(busy = true)
        request("start", input) { reply ->
            if (state.session != input.getInt("session")) return@request
            state = state.copy(busy = false, recording = reply?.optString("status") == "recording")
            when (reply?.optString("status")) {
                "recording", "stale", "busy" -> Unit
                "not-configured" -> notice(VoiceNotice.Toast("common.notice", "quickAdd.speechNotConfigured"))
                "permission-denied" -> notice(VoiceNotice.Alert("quickAdd.audioPermissionTitle", "quickAdd.audioPermissionBody"))
                "sandbox" -> notice(VoiceNotice.Toast("common.notice", "sandbox.unavailable"))
                else -> notice(VoiceNotice.Alert("quickAdd.audioErrorTitle", "quickAdd.audioErrorBody"))
            }
        }
    }

    private fun stop(text: String, options: JSONObject) {
        val input = sessionInput() ?: return
        state = state.copy(recording = false, busy = true)
        request("stop", input.put("save", true).put("text", text).put("options", options)) { reply -> finished(input, reply) }
    }


    fun saveHeld(text: String, options: JSONObject, openAfterSave: Boolean): Boolean {
        val input = sessionInput() ?: return false
        if (!state.held || state.busy) return false
        state = state.copy(busy = true)
        request("save", input.put("text", text).put("options", options).put("openAfterSave", openAfterSave)) { reply -> finished(input, reply) }
        return true
    }

    private fun finished(input: JSONObject, reply: JSONObject?) {
        if (state.session != input.getInt("session")) return

        state = state.copy(busy = false, held = reply?.takeIf { it.has("held") }?.getBoolean("held") ?: state.held)
        when (reply?.optString("status")) {
            "saved" -> saved(reply)
            "refused" -> reply.optJSONObject("notice")?.let { notice(VoiceNotice.Core(it)) }
            "cancelled", "stale", "idle", "busy" -> Unit
            else -> notice(VoiceNotice.Alert("quickAdd.audioErrorTitle", "quickAdd.audioErrorBody"))
        }
    }


    fun closed() {
        openGeneration++
        val input = sessionInput()
        state = VoiceUi()
        if (input != null) request("close", input) { }
    }


    fun left() {
        if (!state.recording && !state.busy) return
        state = state.copy(recording = false, busy = false)
        request("leave") { }
    }
}
