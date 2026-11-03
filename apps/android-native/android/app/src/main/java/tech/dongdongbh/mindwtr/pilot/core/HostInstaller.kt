package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import tech.dongdongbh.mindwtr.attachmentfileinstaller.AndroidAttachmentInstallerFileOps
import tech.dongdongbh.mindwtr.attachmentfileinstaller.AttachmentFileHasherCore
import tech.dongdongbh.mindwtr.attachmentfileinstaller.AttachmentFileInstallerCore
import tech.dongdongbh.mindwtr.attachmentfileinstaller.AttachmentInstallOutcome
import tech.dongdongbh.mindwtr.attachmentfileinstaller.AttachmentInstallerFileOps
import tech.dongdongbh.mindwtr.attachmentfileinstaller.ExpectedAttachmentGeneration
import tech.dongdongbh.mindwtr.attachmentfileinstaller.InterruptedInstallRecovery
import tech.dongdongbh.mindwtr.attachmentfileinstaller.SHA256_HEX_PATTERN
import java.io.File


class HostInstaller internal constructor(
    private val filesDir: File,
    private val cacheDir: File,
    private val ops: () -> AttachmentInstallerFileOps,
) {
    constructor(filesDir: File, cacheDir: File) : this(filesDir, cacheDir, { AndroidAttachmentInstallerFileOps() })

    private fun installer(ops: AttachmentInstallerFileOps = this.ops()) =
        AttachmentFileInstallerCore(targetRoot = File(filesDir, "attachments"), sourceRoots = listOf(filesDir, cacheDir), ops = ops)


    internal fun recover(): List<InterruptedInstallRecovery> = installer().recoverInterruptedInstalls()


    fun call(json: String, @Suppress("UNUSED_PARAMETER") bytes: ByteArray? = null): HostFiles.Reply {
        val request = JSONObject(json)
        return when (val op = request.getString("op")) {
            "install" -> {
                val ops = this.ops().let { if (debugProperty("install_stop") == "journal") StopAfterJournal(it) else it }
                val outcome = installer(ops).install(
                    stagedInput = file(request.getString("staged")),
                    targetInput = file(request.getString("target")),
                    expected = request.getJSONObject("expected").let { expected ->
                        when (expected.getString("kind")) {
                            "absent" -> ExpectedAttachmentGeneration.Absent
                            "present" -> ExpectedAttachmentGeneration.Present(sha256(expected.getString("sha256")))
                            else -> throw IllegalArgumentException("Expected attachment generation is invalid")
                        }
                    },
                    expectedDownloadSha256 = sha256(request.getString("expectedDownloadSha256")),
                )
                HostFiles.Reply(when (outcome) {
                    is AttachmentInstallOutcome.Installed -> JSONObject().put("status", "installed").apply {
                        if ((ops as? AndroidAttachmentInstallerFileOps)?.usedExclusiveCopyFallback == true) put("publication", "exclusive-copy")
                        outcome.preservedFile?.let { put("preservedPath", "file://${it.path}") }
                    }
                    is AttachmentInstallOutcome.Conflict -> JSONObject().put("status", "conflict").put("preservedPath", "file://${outcome.preservedFile.path}")
                })
            }
            "hash" -> {
                val snapshot = AttachmentFileHasherCore(targetRoot = File(filesDir, "attachments"), ops = ops()).hash(file(request.getString("path")))
                HostFiles.Reply(JSONObject().put("sha256", snapshot.sha256).put("size", snapshot.size.toDouble())
                    .put("modificationTimeMs", snapshot.modificationTimeMs))
            }
            else -> throw IllegalArgumentException("Unsupported installer call $op")
        }
    }


    private fun file(value: String): File {
        require(value.isNotBlank()) { "Attachment path is required" }
        return when {
            value.startsWith("file://") -> File(java.net.URLDecoder.decode(value.removePrefix("file://").replace("+", "%2B"), "UTF-8"))
            "://" in value -> throw IllegalArgumentException("Only app-private file paths are supported")
            else -> File(value)
        }
    }

    private fun sha256(value: String): String = value.trim().lowercase().also { require(SHA256_HEX_PATTERN.matches(it)) { "SHA-256 is invalid" } }
}


private class StopAfterJournal(private val delegate: AttachmentInstallerFileOps) : AttachmentInstallerFileOps by delegate {
    override fun writeUtf8Durably(file: File, content: String) {
        delegate.writeUtf8Durably(file, content)
        android.util.Log.i(CoreHost.TAG, "Native Android install stop at=journal")
        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
