package tech.dongdongbh.mindwtr.pilot.core

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException
import org.json.JSONObject


class HostVoice(
    private val granted: () -> Boolean,
    private val recorder: () -> VoiceRecorder,
    private val prompt: PermissionPrompt = MicrophonePermissionPrompt,
) {
    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        val request = JSONObject(json)
        when (request.optString("op")) {
            "permission" -> if (granted()) reply(Result.success("granted"))
                else prompt.ask { yes -> reply(Result.success(if (yes || granted()) "granted" else "denied")) }
            "start" -> recorder().start(format(request.getString("format"))) { result ->
                reply(result.fold({ Result.success(JSONObject().put("id", it)) }, { Result.failure(IOException(code(it))) }))
            }
            "stop" -> recorder().stop(request.getString("id")) { result ->
                reply(result.fold({ Result.success(JSONObject().put("uri", uriOf(it)).put("size", it.length())) }, { Result.failure(IOException(code(it))) }))
            }
            "cancel" -> {
                recorder().cancel(request.getString("id"))
                reply(Result.success(null))
            }
            else -> reply(Result.failure(IOException("E_VOICE_UNKNOWN")))
        }
    }

    companion object {

        fun code(error: Throwable): String = when (error) {
            is VoiceRecorder.StartFailed -> "E_VOICE_START_FAILED"
            is VoiceRecorder.Refused -> "E_VOICE_BUSY"
            is VoiceRecorder.Cancelled -> "E_VOICE_CANCELLED"
            else -> "E_VOICE_FAILED"
        }

        fun format(name: String): VoiceFormat = when (name) {
            "m4a" -> VoiceFormat.M4A
            "wav" -> VoiceFormat.WAV
            else -> throw IllegalArgumentException("Unknown recording format")
        }


        fun uriOf(file: File): String = "file://${file.absolutePath}"

        fun forApp(context: Context): HostVoice {
            val app = context.applicationContext
            return HostVoice(
                granted = { ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED },
                recorder = { VoiceCapture.recorderFor(app) },
            )
        }
    }
}
