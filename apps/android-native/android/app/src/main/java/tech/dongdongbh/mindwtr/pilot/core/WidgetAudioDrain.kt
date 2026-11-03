package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import org.json.JSONObject


internal object WidgetAudioDrain {


    fun hasQueuedRecording(queue: File): Boolean =
        queue.listFiles { file -> file.name.endsWith(".json") }
            ?.any { item -> runCatching { JSONObject(item.readText()).optString("kind") == "audio" }.getOrDefault(false) } == true

    fun run(hasRecording: () -> Boolean, awaitQuiet: () -> String, ingest: () -> Unit): String {
        if (!hasRecording()) return "empty"
        val ended = awaitQuiet()
        if (ended != "left") ingest()
        return ended
    }
}
