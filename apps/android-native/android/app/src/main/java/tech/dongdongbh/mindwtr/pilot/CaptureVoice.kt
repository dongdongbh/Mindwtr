package tech.dongdongbh.mindwtr.pilot

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

/** RN's quick-capture recording state (use-quick-capture-audio.ts): [recording] is recordingReady, [busy] recordingBusy. */
data class VoiceUi(
    val session: Int? = null,
    val recording: Boolean = false,
    val busy: Boolean = false,
    /** A refused save kept its recording (voice V3 review N2): the next Save attaches it. */
    val held: Boolean = false,
)

/** How a popup opening asks to record (RN's openQuickCapture autoRecord). */
enum class AutoRecord {
    /** RN's center +: record when Settings › GTD's default capture method is Audio. */
    DEFAULT,
    /** RN's long press on the center +: the other method. */
    OPPOSITE,
    /** Record (the Inbox's empty action when core says so; a link's mode=audio). */
    ON,
    /** Never record on open (a typed entry, a project's +). */
    OFF,
    ;

    fun wants(defaultAudio: Boolean): Boolean = when (this) {
        DEFAULT -> defaultAudio
        OPPOSITE -> !defaultAudio
        ON -> true
        OFF -> false
    }

    companion object {
        /**
         * RN's capture-quick route (capture-quick.tsx): a `mode` decides (audio records), else an `autoRecord` of 1 or true, else
         * the default capture method. The detailed capture shortcut's link says mode=text; the capture feature's says neither.
         */
        fun forCaptureLink(url: String?): AutoRecord {
            val query = url?.substringAfter('?', "")?.substringBefore('#').orEmpty()
            val params = query.split('&').filter { it.isNotEmpty() }.associate { it.substringBefore('=') to it.substringAfter('=', "") }
            params["mode"]?.let { return if (it == "audio") ON else OFF }
            params["autoRecord"]?.let { return if (it == "1" || it.lowercase() == "true") ON else OFF }
            return DEFAULT
        }
    }
}

/** What the popup shows after a voice call: RN's toast or Alert.alert, by core key. */
sealed class VoiceNotice {
    data class Toast(val titleKey: String, val messageKey: String) : VoiceNotice()
    data class Alert(val titleKey: String, val messageKey: String) : VoiceNotice()
    /** Core's own notice (an unreadable date command), as the capture popup shows it. */
    data class Core(val notice: JSONObject) : VoiceNotice()
}

/**
 * The capture popup's microphone (voice pass V5), over the bundle's voice requests (CoreHost.voiceRequest: open, close, start, stop,
 * save, leave). [call] runs one request off the main thread and answers on it ([io] runs work there, [ui] posts back). The state is
 * RN's: the mic is red while recording, faded while busy, and the processing row shows while busy. A save closes the popup
 * ([saved]); every other answer leaves it open with RN's notice ([notice]).
 */
class CaptureVoice(
    private val call: (String, JSONObject) -> JSONObject,
    private val io: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val notice: (VoiceNotice) -> Unit,
    private val saved: (String) -> Unit,
    /** RN's 150 ms before the automatic start, on the main thread. */
    private val later: (Long, () -> Unit) -> Unit,
) {
    var state by mutableStateOf(VoiceUi())
        private set

    // The popup's open whose answer we wait for; a newer open or a close makes an older answer void.
    private var opening = 0
    // RN 4dea768a2: an automatic start is tried once per open popup, never again when it fails or records nothing.
    private var automaticTried = false

    private fun request(name: String, input: JSONObject = JSONObject(), answer: (JSONObject?) -> Unit) = io {
        val reply = runCatching { call(name, input) }.getOrNull()
        ui { answer(reply) }
    }

    private fun sessionInput(): JSONObject? = state.session?.let { JSONObject().put("session", it) }

    /** The popup opened: a voice session, then RN's automatic start when [auto] asks for one. */
    fun opened(auto: AutoRecord) {
        val mine = ++opening
        automaticTried = false
        state = VoiceUi()
        request("open") { reply ->
            if (mine != opening || reply == null) return@request
            state = VoiceUi(session = reply.optInt("session"))
            if (auto.wants(reply.optBoolean("defaultAudio")) && !automaticTried) {
                automaticTried = true
                later(150) { if (mine == opening) start() }
            }
        }
    }

    /** RN's mic button: stop and save while recording, else start. */
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

    /** The popup's Save while a refused save holds its recording: the draft saves with it (RN's recovery attachment). */
    fun saveHeld(text: String, options: JSONObject): Boolean {
        val input = sessionInput() ?: return false
        if (!state.held || state.busy) return false
        state = state.copy(busy = true)
        request("save", input.put("text", text).put("options", options)) { reply -> finished(input, reply) }
        return true
    }

    private fun finished(input: JSONObject, reply: JSONObject?) {
        if (state.session != input.getInt("session")) return
        // The bundle says whether it still holds a refused save's recording; with no answer, nothing changed there.
        state = state.copy(busy = false, held = reply?.takeIf { it.has("held") }?.getBoolean("held") ?: state.held)
        when (reply?.optString("status")) {
            "saved" -> saved(reply.optString("taskId"))
            "refused" -> reply.optJSONObject("notice")?.let { notice(VoiceNotice.Core(it)) }
            "cancelled", "stale", "idle", "busy" -> Unit
            else -> notice(VoiceNotice.Alert("quickAdd.audioErrorTitle", "quickAdd.audioErrorBody"))
        }
    }

    /** The popup closed: its session ends, its recording with it, unsaved (RN's sheet close). */
    fun closed() {
        opening++
        val input = sessionInput()
        state = VoiceUi()
        if (input != null) request("close", input) { }
    }

    /** The app left the front: Kotlin's recorder already ended the recording; the bundle forgets it too (review N5). */
    fun left() {
        if (!state.recording && !state.busy) return
        state = state.copy(recording = false, busy = false)
        request("leave") { }
    }
}
