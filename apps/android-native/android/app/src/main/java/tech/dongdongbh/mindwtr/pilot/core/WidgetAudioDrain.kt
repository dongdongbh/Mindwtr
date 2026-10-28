package tech.dongdongbh.mindwtr.pilot.core

/**
 * When the widget's queued recordings go to core (ProcessCoreHost.drainAudio). A recording with no speech key stays queued and
 * is asked for again on every resume, so the call waits behind [WidgetRefreshGate], as the widget build and the resume reminder
 * cycle do: the resumed screen's reads go first. With no recording waiting it costs the folder listing only. A wait the app left
 * ends the drain: the queue keeps the recording, the next resume asks again, and RN drains only in the foreground too.
 */
internal object WidgetAudioDrain {
    /** Answers how it ended: "empty" or "left" with core never called, else the gate's answer once [ingest] ran. */
    fun run(hasRecording: () -> Boolean, awaitQuiet: () -> String, ingest: () -> Unit): String {
        if (!hasRecording()) return "empty"
        val ended = awaitQuiet()
        if (ended != "left") ingest()
        return ended
    }
}
