package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Debug builds only (scripts/check-share-files-device.mjs): sends a file share to this app's launcher alias as another app's
 * share sheet does, which `am start` cannot (it has no list of URIs for SEND_MULTIPLE). Extras: `action` (SEND or
 * SEND_MULTIPLE), `type`, `uris` (a string list), and `subject` and `text` when set. Only this app's own URIs go out:
 * ShareTestProvider's files, and the hostile ones the check expects refused (a `file://` URI, this app's other providers,
 * with or without a user prefix).
 */
class ShareTestSender : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val uris = intent.getStringArrayListExtra("uris").orEmpty().map(Uri::parse).filter { uri ->
                (uri.scheme == "file" && uri.path?.startsWith(dataDir.absolutePath) == true)
                    || (uri.scheme == "content" && uri.authority?.substringAfterLast('@')?.startsWith("$packageName.") == true)
            }
            val action = if (intent.getStringExtra("action") == Intent.ACTION_SEND_MULTIPLE) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND
            val share = Intent(action).setClassName(this, "$packageName.MainActivity").setType(intent.getStringExtra("type") ?: "*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (action == Intent.ACTION_SEND_MULTIPLE) share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
            else uris.firstOrNull()?.let { share.putExtra(Intent.EXTRA_STREAM, it) }
            if (uris.isNotEmpty()) share.clipData = ClipData.newRawUri(null, uris[0]).also { clip -> uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) } }
            intent.getStringExtra("subject")?.let { share.putExtra(Intent.EXTRA_SUBJECT, it) }
            intent.getStringExtra("text")?.let { share.putExtra(Intent.EXTRA_TEXT, it) }
            startActivity(share)
        } finally {
            finish()
        }
    }
}
