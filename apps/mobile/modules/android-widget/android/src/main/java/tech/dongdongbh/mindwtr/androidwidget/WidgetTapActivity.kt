package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.content.Intent
import android.os.Bundle


class WidgetTapActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val data = intent?.data
    when {
      data == null -> Unit
      data.scheme == CHECKOFF_SCHEME && data.host == PEEK_HOST -> {


        val taskId = data.lastPathSegment?.trim().orEmpty()
        val item = WidgetPayloadStore.read(this).itemFor(taskId)
        if (item == null) startActivity(WidgetRenderer.appIntent(this, WidgetPayloadStore.read(this).focusUri))
        else startActivity(
          Intent(this, TaskPeekActivity::class.java)
            .putExtra(TaskPeekActivity.EXTRA_TASK_ID, taskId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
      data.scheme == CHECKOFF_SCHEME && data.host == CHECKOFF_HOST -> {
        val taskId = data.lastPathSegment?.trim().orEmpty()
        if (taskId.isNotEmpty()) {
          when (CheckoffStore.tapAction(this, taskId)) {
            CheckoffStore.TapAction.TOGGLE_PENDING -> {
              CheckoffStore.toggle(this, taskId)
              WidgetRenderer.refreshAll(this)
            }


            CheckoffStore.TapAction.RECONCILE -> CheckoffStore.reconcileFromInteraction(this)
            CheckoffStore.TapAction.NO_OP -> Unit
          }
        }
      }
      data.scheme == "mindwtr" -> startActivity(WidgetRenderer.appIntent(this, data.toString()))
    }
    finish()
  }

  companion object {
    const val CHECKOFF_SCHEME = "mindwtr-widget"
    const val CHECKOFF_HOST = "checkoff"
    const val PEEK_HOST = "task"

    fun checkoffUri(taskId: String): String = "$CHECKOFF_SCHEME://$CHECKOFF_HOST/${android.net.Uri.encode(taskId)}"

    fun peekUri(taskId: String): String = "$CHECKOFF_SCHEME://$PEEK_HOST/${android.net.Uri.encode(taskId)}"
  }
}
