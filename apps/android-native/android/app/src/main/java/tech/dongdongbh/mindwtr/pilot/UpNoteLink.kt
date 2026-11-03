package tech.dongdongbh.mindwtr.pilot

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri


internal fun attemptExternalLink(original: String, open: (String) -> Unit, failed: (String) -> Unit,
                                 logFailure: (Exception) -> Unit = {}): Boolean =
    try { open(original); true } catch (failure: Exception) { logFailure(failure); failed(original); false }


internal fun attemptUpNoteLink(original: String, open: (String) -> Unit, failed: (String) -> Unit): Boolean? =
    if (!isUpNoteLink(original)) null else attemptExternalLink(original, open, failed)

private fun isUpNoteLink(original: String) = original.startsWith("upnote://", ignoreCase = true)


private fun offerLinkCopy(context: Context, exact: String, t: (String) -> String) {
    AlertDialog.Builder(context).setTitle(t("common.error")).setMessage(t("markdown.openLinkFailed"))
        .setPositiveButton(t("markdown.copyLink")) { _, _ ->
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("", exact))
            } catch (_: Exception) {
                AlertDialog.Builder(context).setTitle(t("common.error")).setMessage(t("markdown.copyLinkFailed"))
                    .setPositiveButton(t("common.ok"), null).show()
            }
        }.setNegativeButton(t("common.cancel"), null).show()
}

private fun viewLink(context: Context, link: String) = context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))


internal fun openExternalLink(context: Context, original: String, t: (String) -> String, logFailure: (Exception) -> Unit = {},
                              diagnostic: (String) -> Unit) {
    val opened = attemptExternalLink(original, open = { viewLink(context, it) }, failed = { offerLinkCopy(context, it, t) }, logFailure)
    if (isUpNoteLink(original)) diagnostic(if (opened) "opened" else "failed")
}
