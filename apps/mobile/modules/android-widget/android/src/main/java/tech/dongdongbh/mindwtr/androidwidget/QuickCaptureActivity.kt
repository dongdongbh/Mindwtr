package tech.dongdongbh.mindwtr.androidwidget

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Floating quick-capture dialog (#1169). Runs in its own task, never brings
 * the main app forward, and only appends to the pending-captures queue.
 */
class QuickCaptureActivity : AppCompatActivity() {
  private lateinit var input: EditText
  private lateinit var description: EditText
  private lateinit var save: Button
  private lateinit var cancel: Button
  private lateinit var audio: ImageButton
  private lateinit var audioStatus: TextView
  private lateinit var labels: WidgetPayload.QuickCaptureLabels
  private lateinit var audioSession: QuickCaptureAudioSession
  private var observerToken: Any? = null
  private var visible = false
  private var rendering = false
  private val microphonePermissionOwner = QuickCapturePermissionOwner()

  private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val requestId = microphonePermissionOwner.consumeResult() ?: return@registerForActivityResult
    if (audioSession.snapshot.state != QuickCaptureAudioSession.State.PERMISSION || isFinishing || isDestroyed) {
      return@registerForActivityResult
    }
    if (granted && visible) {
      hideKeyboard()
      audioSession.permissionGranted(requestId)
    } else {
      audioSession.permissionDenied(requestId)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.mindwtr_quick_capture)
    val payload = WidgetPayloadStore.read(this)
    labels = payload.quickCapture
    audioSession = obtainAudioSession()
    // ActivityResultRegistry may redeliver a permission result after a config
    // recreation. The ViewModel/session survives, so restore its request token
    // before this Activity reaches STARTED and callbacks can run.
    microphonePermissionOwner.restore(audioSession.permissionRequestId)

    val title = findViewById<TextView>(R.id.mindwtr_quick_capture_title)
    title.text = labels.title
    input = findViewById(R.id.mindwtr_quick_capture_input)
    input.hint = labels.placeholder
    input.setText(audioSession.snapshot.title)
    input.setSelection(input.text?.length ?: 0)
    description = findViewById(R.id.mindwtr_quick_capture_description)
    description.hint = labels.descriptionPlaceholder
    description.setText(audioSession.snapshot.note)
    description.doAfterTextChanged { text ->
      if (!rendering) audioSession.updateNote(text?.toString().orEmpty())
    }
    cancel = findViewById<Button>(R.id.mindwtr_quick_capture_cancel).apply {
      text = labels.cancel
      setOnClickListener { audioSession.cancelAudioOrClose() }
    }
    save = findViewById<Button>(R.id.mindwtr_quick_capture_save).apply {
      text = labels.save
      setOnClickListener { save() }
    }
    audio = findViewById(R.id.mindwtr_quick_capture_audio)
    audioStatus = findViewById(R.id.mindwtr_quick_capture_audio_status)
    findViewById<View>(R.id.mindwtr_quick_capture_audio_row).visibility =
      if (labels.audioEnabled) View.VISIBLE else View.GONE
    audio.setOnClickListener {
      when (audioSession.snapshot.state) {
        QuickCaptureAudioSession.State.IDLE -> requestRecording()
        QuickCaptureAudioSession.State.RECORDING -> audioSession.stopRecording()
        else -> Unit
      }
    }
    input.doAfterTextChanged { text ->
      if (!rendering) audioSession.updateTitle(text?.toString().orEmpty())
    }
    input.setOnEditorActionListener { _, actionId, event ->
      val enterPressed = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
      if (actionId == EditorInfo.IME_ACTION_DONE || enterPressed) {
        save()
        true
      } else {
        false
      }
    }
    payload.resolvedPalette(this)?.let { applyPalette(it, title, cancel) }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        audioSession.cancelAudioOrClose()
      }
    })
    observerToken = audioSession.attach(::render)
    val cleanupFilesDir = filesDir
    val activeIds = audioSession.activeIds
    CAPTURE_IO.execute { QuickCaptureAudioCleanup.sweep(cleanupFilesDir, activeIds) }
    input.requestFocus()
  }

  override fun onStart() {
    // ActivityResultRegistry may deliver a pending permission result from
    // super.onStart(); mark this recreated owner ready before that dispatch.
    visible = true
    microphonePermissionOwner.onStarting()
    super.onStart()
  }

  override fun onStop() {
    visible = false
    microphonePermissionOwner.onStopped()
    audioSession.updateTitle(input.text?.toString().orEmpty())
    audioSession.updateNote(description.text?.toString().orEmpty())
    audioSession.onHostStopped()
    super.onStop()
  }

  override fun onDestroy() {
    observerToken?.let(audioSession::detach)
    observerToken = null
    super.onDestroy()
  }

  private fun obtainAudioSession(): QuickCaptureAudioSession {
    val appContext = applicationContext
    val captureFilesDir = filesDir
    val mainExecutor = ContextCompat.getMainExecutor(appContext)
    val model = ViewModelProvider(this, object : ViewModelProvider.Factory {
      @Suppress("UNCHECKED_CAST")
      override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(AudioSessionModel::class.java))
        val session = QuickCaptureAudioSessionStore.acquire {
          lateinit var retainedSession: QuickCaptureAudioSession
          retainedSession = QuickCaptureAudioSession(
            startRecorder = { callback ->
              val id = UUID.randomUUID().toString()
              val recorder = QuickCaptureAudioRecorder(
                filesDir = captureFilesDir,
                idFactory = { id },
                callbackExecutor = mainExecutor,
              )
              recorder.start { outcome ->
                if (outcome is QuickCaptureAudioRecorder.Outcome.Failed) {
                  Log.w(TAG, "Native quick capture recording failed")
                }
                callback(outcome)
              }
              object : QuickCaptureAudioSession.RecordingControl {
                override val id: String = id
                override fun stop() = recorder.stop()
                override fun cancel() = recorder.cancel()
              }
            },
            publishAudio = { draft, typedTitle, typedNote, complete ->
              CAPTURE_IO.execute {
                val saved = try {
                  PendingCaptureWriter.publishAudio(captureFilesDir, draft, typedTitle, typedNote)
                  Log.i(TAG, "Native quick capture audio queued")
                  true
                } catch (_: Exception) {
                  Log.w(TAG, "Native quick capture audio queue write failed")
                  false
                }
                mainExecutor.execute { complete(saved) }
              }
            },
            discardAudio = { draft ->
              CAPTURE_IO.execute { PendingCaptureWriter.discardAudioDraft(captureFilesDir, draft) }
            },
            onTerminal = { QuickCaptureAudioSessionStore.release(retainedSession) },
          )
          retainedSession
        }
        return AudioSessionModel(session) as T
      }
    })[AudioSessionModel::class.java]
    return model.session
  }

  private fun requestRecording() {
    if (!labels.audioEnabled || !visible || audioSession.snapshot.state != QuickCaptureAudioSession.State.IDLE) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      hideKeyboard()
      audioSession.beginRecording()
    } else {
      val requestId = audioSession.awaitPermission() ?: return
      microphonePermissionOwner.launched(requestId)
      microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  private fun hideKeyboard() {
    (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(input.windowToken, 0)
  }

  private fun render(snapshot: QuickCaptureAudioSession.Snapshot) {
    if (input.text?.toString().orEmpty() != snapshot.title) {
      rendering = true
      input.setText(snapshot.title)
      input.setSelection(input.text?.length ?: 0)
      rendering = false
    }
    if (description.text?.toString().orEmpty() != snapshot.note) {
      rendering = true
      description.setText(snapshot.note)
      description.setSelection(description.text?.length ?: 0)
      rendering = false
    }
    audioStatus.text = when (snapshot.status) {
      QuickCaptureAudioSession.Status.RECORD -> labels.audioRecord
      QuickCaptureAudioSession.Status.RECORDING -> labels.audioRecording
      QuickCaptureAudioSession.Status.READY -> labels.audioReady
      QuickCaptureAudioSession.Status.ERROR -> labels.audioError
      QuickCaptureAudioSession.Status.PERMISSION_DENIED -> labels.audioPermissionDenied
    }

    val recording = snapshot.state == QuickCaptureAudioSession.State.RECORDING
    val editable = snapshot.state == QuickCaptureAudioSession.State.IDLE ||
      snapshot.state == QuickCaptureAudioSession.State.READY
    save.isEnabled = snapshot.canSaveText || snapshot.canSaveAudio
    save.alpha = if (save.isEnabled) 1f else 0.5f
    cancel.isEnabled = snapshot.state != QuickCaptureAudioSession.State.SAVING &&
      snapshot.state != QuickCaptureAudioSession.State.SAVED &&
      snapshot.state != QuickCaptureAudioSession.State.CLOSED
    audio.isEnabled = snapshot.state == QuickCaptureAudioSession.State.IDLE || recording
    audio.alpha = if (audio.isEnabled) 1f else 0.5f
    audio.setImageResource(if (recording) R.drawable.mindwtr_capture_stop else R.drawable.mindwtr_capture_mic)
    audio.contentDescription = if (recording) labels.audioStop else labels.audioRecord
    input.isEnabled = editable || recording || snapshot.state == QuickCaptureAudioSession.State.STOPPING
    description.isEnabled = input.isEnabled

    if (snapshot.state == QuickCaptureAudioSession.State.SAVED) {
      if (audioSession.consumeSaved()) {
        Toast.makeText(applicationContext, labels.audioSaved, Toast.LENGTH_LONG).show()
        WidgetPayloadStore.incrementInboxCount(applicationContext)
        WidgetRenderer.refreshAll(applicationContext)
      }
      finish()
    } else if (snapshot.state == QuickCaptureAudioSession.State.CLOSED) {
      finish()
    }
  }

  private fun applyPalette(palette: WidgetPayload.Palette, title: TextView, cancel: Button) {
    tint(findViewById(R.id.mindwtr_quick_capture_root), palette.background)
    title.setTextColor(palette.text)
    input.setTextColor(palette.text)
    input.setHintTextColor(palette.mutedText)
    tint(input, palette.card)
    description.setTextColor(palette.text)
    description.setHintTextColor(palette.mutedText)
    tint(description, palette.card)
    cancel.setTextColor(palette.accent)
    tint(save, palette.accent)
    save.setTextColor(palette.onAccent)
    audio.imageTintList = ColorStateList.valueOf(palette.accent)
    audioStatus.setTextColor(palette.mutedText)
  }

  private fun tint(view: View, color: Int) {
    (view.background?.mutate() as? GradientDrawable)?.setColor(color)
  }

  private fun save() {
    when (audioSession.snapshot.state) {
      QuickCaptureAudioSession.State.READY -> {
        audioSession.saveAudio()
        return
      }
      QuickCaptureAudioSession.State.IDLE -> Unit
      else -> return
    }
    val title = input.text?.toString().orEmpty()
    val written = try {
      PendingCaptureWriter.write(filesDir, title, note = description.text?.toString().orEmpty())
    } catch (error: IOException) {
      Log.w(TAG, "quick capture write failed: ${error.message}")
      Toast.makeText(this, error.message ?: "Could not save", Toast.LENGTH_SHORT).show()
      return
    }
    if (written == null) {
      input.requestFocus()
      return
    }
    audioSession.completeTextCapture()
    Log.i(TAG, "quick capture queued ${written.name}")
    Toast.makeText(this, labels.added, Toast.LENGTH_SHORT).show()
    WidgetPayloadStore.incrementInboxCount(this)
    WidgetRenderer.refreshAll(this)
    CaptureSyncHeadlessService.start(this)
  }

  private class AudioSessionModel(val session: QuickCaptureAudioSession) : ViewModel() {
    override fun onCleared() {
      session.onOwnerCleared()
    }
  }

  companion object {
    private const val TAG = "Mindwtr"
    private val CAPTURE_IO = Executors.newSingleThreadExecutor { work -> Thread(work, "MindwtrCaptureSave") }
  }
}
