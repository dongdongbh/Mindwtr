package tech.dongdongbh.mindwtr.androidwidget

/**
 * Retained state machine for one quick-capture dialog. Android recreation may
 * replace the Activity, but it must not replace the in-flight recorder/draft,
 * typed title/description, or publication retry state.
 */
internal class QuickCaptureAudioSession(
  private val startRecorder: ((QuickCaptureAudioRecorder.Outcome) -> Unit) -> RecordingControl,
  private val publishAudio: (QuickCaptureAudioDraft, String, String, (Boolean) -> Unit) -> Unit,
  private val discardAudio: (QuickCaptureAudioDraft) -> Unit,
  private val onTerminal: () -> Unit = {},
  val defaultStatus: String = "inbox",
  initialCaptureStatus: String? = null,
  initialTitle: String = "",
) {
  var captureStatus: String? = PendingCaptureWriter.creationStatus(initialCaptureStatus)
    private set

  fun selectCaptureStatus(value: String) {
    if (state == State.SAVING || state == State.SAVED || state == State.CLOSED) return
    captureStatus = PendingCaptureWriter.creationStatus(value) ?: return
    notifyChanged()
  }
  internal interface RecordingControl {
    val id: String?
    fun stop()
    fun cancel()
  }

  internal enum class State { IDLE, PERMISSION, RECORDING, STOPPING, READY, SAVING, SAVED, CLOSED }
  internal enum class Status { RECORD, RECORDING, READY, ERROR, PERMISSION_DENIED }

  internal data class Snapshot(
    val state: State,
    val status: Status,
    val title: String,
    val note: String,
    val hasDraft: Boolean,
  ) {
    val canSaveText: Boolean get() = state == State.IDLE && title.isNotBlank()
    val canSaveAudio: Boolean get() = state == State.READY && hasDraft
  }

  private var state = State.IDLE
  private var status = Status.RECORD
  private var title = initialTitle
  private var note = ""
  private var recorder: RecordingControl? = null
  private var draft: QuickCaptureAudioDraft? = null
  private var saveWhenReady = false
  private var discardRequested = false
  private var keepTextAfterCancel = false
  private var savedConsumed = false
  private var ownerCleared = false
  private var nextPermissionRequestId = 0L
  private var activePermissionRequestId: Long? = null
  private var observerToken: Any? = null
  private var observer: ((Snapshot) -> Unit)? = null

  val snapshot: Snapshot get() = Snapshot(state, status, title, note, draft != null)

  val activeIds: Set<String>
    get() = listOfNotNull(recorder?.id, draft?.id).toSet()

  val permissionRequestId: Long?
    get() = activePermissionRequestId

  fun attach(nextObserver: (Snapshot) -> Unit): Any {
    ownerCleared = false
    val token = Any()
    observerToken = token
    observer = nextObserver
    nextObserver(snapshot)
    return token
  }

  fun detach(token: Any) {
    if (observerToken !== token) return
    observerToken = null
    observer = null
  }

  fun updateTitle(nextTitle: String) {
    title = nextTitle
    notifyChanged()
  }

  fun updateNote(nextNote: String) {
    note = nextNote
    notifyChanged()
  }

  fun awaitPermission(): Long? {
    if (state != State.IDLE) return null
    nextPermissionRequestId += 1
    activePermissionRequestId = nextPermissionRequestId
    state = State.PERMISSION
    notifyChanged()
    return activePermissionRequestId
  }

  fun permissionDenied(requestId: Long) {
    if (state != State.PERMISSION || activePermissionRequestId != requestId) return
    activePermissionRequestId = null
    state = State.IDLE
    status = Status.PERMISSION_DENIED
    notifyChanged()
  }

  fun permissionGranted(requestId: Long) {
    if (state != State.PERMISSION || activePermissionRequestId != requestId) return
    activePermissionRequestId = null
    state = State.IDLE
    beginRecording()
  }

  fun beginRecording() {
    if (state != State.IDLE) return
    saveWhenReady = false
    discardRequested = false
    keepTextAfterCancel = false
    status = Status.RECORDING
    state = State.RECORDING
    notifyChanged()
    try {
      val control = startRecorder(::onRecorderOutcome)
      if (state == State.RECORDING || state == State.STOPPING) {
        recorder = control
      } else if (state == State.CLOSED) {
        control.cancel()
      }
    } catch (_: Exception) {
      state = State.IDLE
      status = Status.ERROR
      notifyChanged()
    }
  }

  fun stopRecording() {
    if (state != State.RECORDING) return
    state = State.STOPPING
    notifyChanged()
    recorder?.stop()
  }

  /** Stop visible recording and persist a usable result without an Activity. */
  fun onHostStopped() {
    if (discardRequested) return
    when (state) {
      State.RECORDING -> {
        saveWhenReady = true
        stopRecording()
      }
      State.STOPPING -> saveWhenReady = true
      State.READY -> saveAudio()
      else -> Unit
    }
  }

  fun saveAudio() {
    val ready = draft ?: return
    if (state != State.READY || discardRequested) return
    state = State.SAVING
    status = Status.READY
    notifyChanged()
    try {
      publishAudio(ready, title, note, ::onPublicationFinished)
    } catch (_: Exception) {
      onPublicationFinished(false)
    }
  }

  /** Returns true only once so queued feedback cannot duplicate. */
  fun consumeSaved(): Boolean {
    if (state != State.SAVED || savedConsumed) return false
    savedConsumed = true
    return true
  }

  /** Ends the retained session after the legacy text writer has durably queued. */
  fun completeTextCapture() {
    if (state != State.IDLE) return
    title = ""
    note = ""
    state = State.CLOSED
    onTerminal()
    notifyChanged()
  }

  /** Returns true when the dialog should close; otherwise only audio was cancelled. */
  fun cancelAudioOrClose(): Boolean {
    if (state == State.SAVING) return false
    val activeRecorder = recorder
    val readyDraft = draft
    val hasAudio = activeRecorder != null || readyDraft != null || state == State.RECORDING || state == State.STOPPING
    if (!hasAudio) {
      state = State.CLOSED
      onTerminal()
      notifyChanged()
      return true
    }

    discardRequested = true
    saveWhenReady = false
    keepTextAfterCancel = title.isNotBlank() || note.isNotBlank()
    if (readyDraft != null) {
      draft = null
      discardAudio(readyDraft)
    }
    if (activeRecorder != null) {
      state = if (keepTextAfterCancel) State.STOPPING else State.CLOSED
      notifyChanged()
      activeRecorder.cancel()
    } else {
      finishCancellation()
    }
    return !keepTextAfterCancel
  }

  fun onOwnerCleared() {
    if (ownerCleared) return
    ownerCleared = true
    observer = null
    observerToken = null
    // noHistory may clear the Activity after Home/onStop. That is an
    // interruption, not explicit Cancel: let the retained callbacks finish the
    // same stop/publish sequence even though no UI owner remains.
    when (state) {
      State.PERMISSION -> {
        activePermissionRequestId = null
        state = State.IDLE
        status = Status.RECORD
      }
      State.RECORDING -> {
        saveWhenReady = true
        stopRecording()
      }
      State.STOPPING -> saveWhenReady = true
      State.READY -> saveAudio()
      else -> Unit
    }
  }

  private fun onRecorderOutcome(outcome: QuickCaptureAudioRecorder.Outcome) {
    recorder = null
    when (outcome) {
      is QuickCaptureAudioRecorder.Outcome.Ready -> {
        if (discardRequested || state == State.CLOSED) {
          discardAudio(outcome.draft)
          finishCancellation()
          return
        }
        draft = outcome.draft
        state = State.READY
        status = Status.READY
        notifyChanged()
        if (saveWhenReady) saveAudio()
      }
      is QuickCaptureAudioRecorder.Outcome.Failed -> {
        if (discardRequested || state == State.CLOSED) {
          finishCancellation()
        } else {
          state = State.IDLE
          status = Status.ERROR
          notifyChanged()
        }
      }
      QuickCaptureAudioRecorder.Outcome.Cancelled -> finishCancellation()
    }
  }

  private fun onPublicationFinished(saved: Boolean) {
    if (state != State.SAVING) return
    if (saved) {
      draft = null
      state = State.SAVED
    } else {
      state = State.READY
      status = Status.ERROR
    }
    if (saved) onTerminal()
    notifyChanged()
  }

  private fun finishCancellation() {
    discardRequested = false
    if (keepTextAfterCancel) {
      keepTextAfterCancel = false
      state = State.IDLE
      status = Status.RECORD
    } else {
      state = State.CLOSED
    }
    if (state == State.CLOSED) onTerminal()
    notifyChanged()
  }

  private fun notifyChanged() {
    observer?.invoke(snapshot)
  }
}

/** Activity-local permission delivery state with an explicit STARTED gate. */
internal class QuickCapturePermissionOwner {
  private var requestId: Long? = null
  private var started = false

  fun restore(requestId: Long?) {
    this.requestId = requestId
  }

  fun launched(requestId: Long) {
    this.requestId = requestId
  }

  fun onStarting() {
    started = true
  }

  fun onStopped() {
    started = false
  }

  fun consumeResult(): Long? {
    if (!started) return null
    val current = requestId ?: return null
    requestId = null
    return current
  }
}

/**
 * A noHistory Activity loses its ViewModelStore after Home. Retain only its
 * small in-process session so a failed publication remains reachable on the
 * next native quick-capture open; terminal sessions remove themselves.
 */
internal object QuickCaptureAudioSessionStore {
  private val retained = mutableMapOf<String, QuickCaptureAudioSession>()

  @Synchronized
  fun acquire(owner: String = "standalone", factory: () -> QuickCaptureAudioSession): QuickCaptureAudioSession =
    retained.getOrPut(owner, factory)

  @Synchronized
  fun release(session: QuickCaptureAudioSession) {
    retained.entries.removeAll { it.value === session }
  }

  @Synchronized
  fun activeIds(): Set<String> = retained.values.flatMap { it.activeIds }.toSet()

  @Synchronized
  fun clearForTests() {
    retained.clear()
  }
}
