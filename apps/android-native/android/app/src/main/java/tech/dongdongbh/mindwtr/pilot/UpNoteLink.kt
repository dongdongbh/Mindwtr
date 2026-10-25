package tech.dongdongbh.mindwtr.pilot

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * RN's openExternalLink (c2e30c2e5): one explicit attempt with the exact string; when nothing opens it, [failed] gets that string
 * to offer Copy link. Injected boundaries keep the original intact and test missing handlers.
 */
internal fun attemptExternalLink(original: String, open: (String) -> Unit, failed: (String) -> Unit): Boolean =
    try { open(original); true } catch (_: Exception) { failed(original); false }

/** An UpNote link's handoff attempt (#1331); null for any other link. */
internal fun attemptUpNoteLink(original: String, open: (String) -> Unit, failed: (String) -> Unit): Boolean? =
    if (!isUpNoteLink(original)) null else attemptExternalLink(original, open, failed)

private fun isUpNoteLink(original: String) = original.startsWith("upnote://", ignoreCase = true)

/** RN's failed-link alert: "Could not open this link", Cancel and Copy link (the exact text), and a failed copy says so. */
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

internal fun openUpNoteLink(context: Context, original: String, t: (String) -> String, diagnostic: (String) -> Unit): Boolean? {
    val result = attemptUpNoteLink(original, open = { viewLink(context, it) }, failed = { offerLinkCopy(context, it, t) })
    if (result != null) diagnostic(if (result) "opened" else "failed")
    return result
}

/** A description's or project notes' external link (RN's markdown surface): any scheme, Copy link when nothing opens it. */
internal fun openExternalLink(context: Context, original: String, t: (String) -> String, diagnostic: (String) -> Unit) {
    val opened = attemptExternalLink(original, open = { viewLink(context, it) }, failed = { offerLinkCopy(context, it, t) })
    if (isUpNoteLink(original)) diagnostic(if (opened) "opened" else "failed")
}
