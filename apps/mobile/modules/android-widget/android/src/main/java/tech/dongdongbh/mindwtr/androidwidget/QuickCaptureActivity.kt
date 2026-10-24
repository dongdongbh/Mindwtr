package tech.dongdongbh.mindwtr.androidwidget

import android.Manifest
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
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
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
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
  private lateinit var statusButton: Button
  private lateinit var contextsButton: Button
  private lateinit var contextPanel: View
  private lateinit var contextFilter: EditText
  private lateinit var contextMatches: LinearLayout
  private var contextOptions: List<WidgetPayload.SavedFilterOption> = emptyList()
  private var palette: WidgetPayload.Palette? = null
  private lateinit var labels: WidgetPayload.QuickCaptureLabels
  private lateinit var audioSession: QuickCaptureAudioSession
  private var observerToken: Any? = null
  private var visible = false
  private var rendering = false
  private val microphonePermissionOwner = QuickCapturePermissionOwner()

  private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    onMicrophonePermissionResult(granted)
  }

  internal fun onMicrophonePermissionResult(granted: Boolean) {
    val requestId = microphonePermissionOwner.consumeResult() ?: return
    if (audioSession.snapshot.state != QuickCaptureAudioSession.State.PERMISSION || isFinishing || isDestroyed) {
      return
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
    audioSession = obtainAudioSession(savedInstanceState)
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
    statusButton = findViewById<Button>(R.id.mindwtr_quick_capture_status).apply {
      setOnClickListener {
        val statuses = PendingCaptureWriter.CREATION_STATUSES
        AlertDialog.Builder(this@QuickCaptureActivity)
          .setTitle(labels.statusLabel)
          .setSingleChoiceItems(statuses.map { labels.statusLabels.getValue(it) }.toTypedArray(),
            statuses.indexOf(audioSession.captureStatus ?: audioSession.defaultStatus)) { dialog, position ->
            // A click is explicit even when Inbox was already selected initially.
            audioSession.selectCaptureStatus(statuses[position])
            dialog.dismiss()
          }
          .setNegativeButton(labels.cancel, null)
          .show()
      }
    }
    contextOptions = payload.contexts
    contextPanel = findViewById(R.id.mindwtr_quick_capture_context_panel)
    contextMatches = findViewById(R.id.mindwtr_quick_capture_context_matches)
    contextFilter = findViewById<EditText>(R.id.mindwtr_quick_capture_context_filter).apply {
      hint = payload.listTitles["search"] ?: "Search"
      doAfterTextChanged { showContextMatches() }
      // Done picks the top match, so a keyboard user never has to leave the keys.
      setOnEditorActionListener { _, actionId, event ->
        val enterPressed = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
        if (actionId != EditorInfo.IME_ACTION_DONE && !enterPressed) return@setOnEditorActionListener false
        currentContextChoices().firstOrNull()?.let(::insertContext) ?: closeContextPanel()
        true
      }
    }
    contextsButton = findViewById<Button>(R.id.mindwtr_quick_capture_contexts).apply {
      text = payload.listTitles["contexts"] ?: "Contexts"
      visibility = if (contextChoices(contextOptions, "", "").isEmpty()) View.GONE else View.VISIBLE
      setOnClickListener { if (contextPanel.visibility == View.VISIBLE) closeContextPanel() else openContextPanel() }
    }
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
    palette = payload.resolvedPalette(this)
    palette?.let { applyPalette(it, title, cancel) }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Back closes the context list first, so the draft is never lost to it.
        if (contextPanel.visibility == View.VISIBLE) closeContextPanel() else audioSession.cancelAudioOrClose()
      }
    })
    observerToken = audioSession.attach(::render)
    val cleanupFilesDir = filesDir
    val activeIds = QuickCaptureAudioSessionStore.activeIds()
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

  override fun onNewIntent(nextIntent: Intent) {
    super.onNewIntent(nextIntent)
    if (captureOwner(nextIntent) == captureOwner(intent)) return
    // singleTask can deliver another widget/shortcut while this draft is open.
    // Retire its UI/permission owner before background publication can complete.
    visible = false
    microphonePermissionOwner.onStopped()
    observerToken?.let(audioSession::detach)
    observerToken = null
    audioSession.updateTitle(input.text?.toString().orEmpty())
    audioSession.updateNote(description.text?.toString().orEmpty())
    audioSession.onHostStopped()
    val origin = widgetOrigin(nextIntent)
    val launch = origin?.let { (kind, id) -> WidgetRenderer.captureIntent(this, id, kind) }
      ?: Intent(this, QuickCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    finish()
    startActivity(launch)
  }

  private fun widgetOrigin(launch: Intent): Pair<WidgetKind, Int>? {
    val id = launch.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    if (id < 0) return null
    val kind = WidgetKind.entries.firstOrNull { it.name == launch.getStringExtra(WidgetRenderer.EXTRA_KIND) } ?: return null
    return kind to id
  }

  private fun captureOwner(launch: Intent): String =
    widgetOrigin(launch)?.let { (kind, id) -> "${kind.name}/$id" } ?: "standalone"

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

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putString(STATE_DEFAULT_STATUS, audioSession.defaultStatus)
    outState.putString(STATE_CAPTURE_STATUS, audioSession.captureStatus)
    super.onSaveInstanceState(outState)
  }

  private fun obtainAudioSession(savedInstanceState: Bundle?): QuickCaptureAudioSession {
    val appContext = applicationContext
    val captureFilesDir = filesDir
    val mainExecutor = ContextCompat.getMainExecutor(appContext)
    val model = ViewModelProvider(this, object : ViewModelProvider.Factory {
      @Suppress("UNCHECKED_CAST")
      override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(AudioSessionModel::class.java))
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val kind = intent.getStringExtra(WidgetRenderer.EXTRA_KIND)
        val widgetList = if (widgetId >= 0 && kind == WidgetKind.TASKS.name) WidgetListStore.baseListId(WidgetListStore.read(appContext, widgetId)) else null
        val session = QuickCaptureAudioSessionStore.acquire(captureOwner(intent)) {
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
                  PendingCaptureWriter.publishAudio(captureFilesDir, draft, typedTitle, typedNote,
                    retainedSession.defaultStatus, retainedSession.captureStatus)
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
            defaultStatus = if (savedInstanceState != null) {
              PendingCaptureWriter.creationStatus(savedInstanceState.getString(STATE_DEFAULT_STATUS)) ?: "inbox"
            } else {
              PendingCaptureWriter.creationStatus(widgetList) ?: "inbox"
            },
            initialCaptureStatus = savedInstanceState?.getString(STATE_CAPTURE_STATUS),
            // A recreated Activity restores the user's own text; only a fresh open pre-fills.
            initialTitle = if (savedInstanceState == null) widgetList?.let(WidgetListStore::captureText).orEmpty() else "",
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
    statusButton.isEnabled = input.isEnabled
    contextsButton.isEnabled = input.isEnabled
    if (!input.isEnabled && contextPanel.visibility == View.VISIBLE) contextPanel.visibility = View.GONE
    val captureStatus = audioSession.captureStatus ?: audioSession.defaultStatus
    statusButton.text = "${labels.statusLabel}: ${labels.statusLabels.getValue(captureStatus)}"

    if (snapshot.state == QuickCaptureAudioSession.State.SAVED) {
      if (audioSession.consumeSaved()) {
        Toast.makeText(applicationContext, labels.audioSaved, Toast.LENGTH_LONG).show()
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
    statusButton.setTextColor(palette.accent)
    contextsButton.setTextColor(palette.accent)
    contextFilter.setTextColor(palette.text)
    contextFilter.setHintTextColor(palette.mutedText)
    tint(contextFilter, palette.card)
  }

  private fun currentContextChoices() =
    contextChoices(contextOptions, input.text?.toString().orEmpty(), contextFilter.text?.toString().orEmpty())

  private fun openContextPanel() {
    contextFilter.setText("")
    contextPanel.visibility = View.VISIBLE
    showContextMatches()
    // The title box keeps its caret while the filter has focus; the pick lands there.
    contextFilter.requestFocus()
  }

  private fun closeContextPanel() {
    contextPanel.visibility = View.GONE
    input.requestFocus()
  }

  private fun showContextMatches() {
    contextMatches.removeAllViews()
    val density = resources.displayMetrics.density
    val textColor = palette?.text ?: getColor(R.color.mindwtr_widget_text)
    val ripple = obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackground))
    val rowBackground = ripple.getResourceId(0, 0)
    ripple.recycle()
    for ((name, token) in currentContextChoices()) {
      contextMatches.addView(TextView(this).apply {
        text = name
        setTextColor(textColor)
        textSize = 15f
        minHeight = (48 * density).toInt()
        gravity = android.view.Gravity.CENTER_VERTICAL
        setPadding((12 * density).toInt(), 0, (12 * density).toInt(), 0)
        if (rowBackground != 0) setBackgroundResource(rowBackground)
        isClickable = true
        isFocusable = true
        setOnClickListener { insertContext(name to token) }
      })
    }
  }

  private fun insertContext(choice: Pair<String, String>) {
    val text = input.text?.toString().orEmpty()
    val start = input.selectionStart.takeIf { it >= 0 } ?: text.length
    val end = input.selectionEnd.takeIf { it >= 0 } ?: start
    val (next, caret) = insertToken(text, start, end, choice.second)
    contextPanel.visibility = View.GONE
    input.setText(next)
    input.setSelection(caret.coerceAtMost(input.text?.length ?: 0))
    input.requestFocus()
    (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
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
      PendingCaptureWriter.write(filesDir, title, note = description.text?.toString().orEmpty(),
        defaultStatus = audioSession.defaultStatus, status = audioSession.captureStatus)
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
    Toast.makeText(this, labels.queued, Toast.LENGTH_SHORT).show()
    CaptureSyncHeadlessService.start(this)
  }

  private class AudioSessionModel(val session: QuickCaptureAudioSession) : ViewModel() {
    override fun onCleared() {
      session.onOwnerCleared()
    }
  }

  companion object {
    private const val TAG = "Mindwtr"
    private const val MAX_CONTEXT_MATCHES = 8

    /**
     * What the Contexts button offers (#1418), as (name, token). Mirrors core getTaskContextMatches
     * (task-token-usage.ts): exact label, then prefix, then substring; ties keep the payload's order, which core
     * already sorts the same way (WidgetPayload.contexts). An empty query lists them all, like the in-app picker.
     * Only names captureText can write back exactly, and never one the text already holds.
     */
    internal fun contextChoices(options: List<WidgetPayload.SavedFilterOption>, text: String, query: String): List<Pair<String, String>> {
      val needle = query.trim().removePrefix("@").lowercase()
      fun quality(name: String): Int {
        val label = name.removePrefix("@").lowercase()
        return if (label == needle) 0 else if (label.startsWith(needle)) 1 else if (label.contains(needle)) 2 else -1
      }
      return options
        .map { Triple(it.name, WidgetListStore.captureText(it.id).trimEnd(), quality(it.name)) }
        .filter { (name, token, rank) ->
          name.startsWith("@") && rank >= 0 && token.isNotEmpty() &&
            !Regex("(^|\\s)${Regex.escape(token)}(?=\\s|$)", RegexOption.IGNORE_CASE).containsMatchIn(text)
        }
        .sortedBy { it.third }
        .take(MAX_CONTEXT_MATCHES)
        .map { (name, token) -> name to token }
    }

    /** Puts [token] over the selection with a space on each side the text lacks; returns the text and the caret after it. */
    internal fun insertToken(text: String, start: Int, end: Int, token: String): Pair<String, Int> {
      val from = minOf(start, end).coerceIn(0, text.length)
      val to = maxOf(start, end).coerceIn(0, text.length)
      val before = if (from > 0 && !text[from - 1].isWhitespace()) " " else ""
      val spaceFollows = to < text.length && text[to].isWhitespace()
      val inserted = before + token + if (spaceFollows) "" else " "
      return text.substring(0, from) + inserted + text.substring(to) to from + inserted.length + if (spaceFollows) 1 else 0
    }
    private const val STATE_DEFAULT_STATUS = "captureDefaultStatus"
    private const val STATE_CAPTURE_STATUS = "captureStatus"
    private val CAPTURE_IO = Executors.newSingleThreadExecutor { work -> Thread(work, "MindwtrCaptureSave") }
  }
}
