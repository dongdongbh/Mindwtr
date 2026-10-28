package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import org.json.JSONObject

/**
 * When the widget's queued recordings go to core (ProcessCoreHost.drainAudio). A recording with no speech key stays queued and
 * is asked for again on every resume, so the call waits behind [WidgetRefreshGate], as the widget build and the resume reminder
 * cycle do: the resumed screen's reads go first. With no recording waiting it costs the queue's listing (and a read of its small
 * items) only. A wait the app left ends the drain: the queue keeps the recording, the next resume asks again, and RN drains only
 * in the foreground too.
 */
internal object WidgetAudioDrain {
    /**
     * Whether [queue] (files/pending-captures) holds an audio item. The queue, not the WAV folder, decides: the widget writes the
     * WAV before its item, and a WAV with no item is core's to delete, so it never asks for a drain.
     */
    fun hasQueuedRecording(queue: File): Boolean =
        queue.listFiles { file -> file.name.endsWith(".json") }
            ?.any { item -> runCatching { JSONObject(item.readText()).optString("kind") == "audio" }.getOrDefault(false) } == true
    /** Answers how it ended: "empty" or "left" with core never called, else the gate's answer once [ingest] ran. */
    fun run(hasRecording: () -> Boolean, awaitQuiet: () -> String, ingest: () -> Unit): String {
        if (!hasRecording()) return "empty"
        val ended = awaitQuiet()
        if (ended != "left") ingest()
        return ended
    }
}
