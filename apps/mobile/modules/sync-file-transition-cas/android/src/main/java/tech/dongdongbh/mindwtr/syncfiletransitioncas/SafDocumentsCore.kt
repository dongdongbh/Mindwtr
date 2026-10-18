package tech.dongdongbh.mindwtr.syncfiletransitioncas

/**
 * File Sync's Storage Access Framework document calls, with no Android type in sight so the JVM tests drive them through a
 * fake provider. React Native's Expo module and the native Android app both call this one file.
 *
 * The rule every call keeps: a provider failure is an error, never an answer. androidx's TreeDocumentFile.listFiles returns
 * what it has (often nothing) when the children query throws, and DocumentFile.exists reads any error as "absent"; sync then
 * mistook an unreadable folder for an empty one.
 */
class SafDocumentsCore(
    private val provider: SafDocumentProvider,
    /** Waits between size re-queries (tests pass a recorder). */
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    /** The documents in folder [dirUri]. Empty only when the provider listed an empty folder. */
    fun listChildren(dirUri: String): List<SafDocumentRow> {
        val rows = try {
            provider.queryChildren(dirUri)
        } catch (error: SafDocumentUnavailableException) {
            throw error
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not list the folder", error)
        }
        return rows ?: throw SafDocumentUnavailableException("$UNAVAILABLE: the provider returned no folder listing")
    }

    /** [uri]'s row, or null when the provider answered an empty cursor: only a successful query proves absence. */
    fun stat(uri: String): SafDocumentRow? {
        val answer = try {
            provider.queryDocument(uri)
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not describe the document", error)
        }
        return when (answer) {
            is SafDocumentQuery.Found -> answer.row
            SafDocumentQuery.Missing -> null
            // DocumentsProvider.query answers no cursor both for a vanished document and for a query the provider failed,
            // and so does a provider that is not installed: no cursor proves nothing, so it is never "absent". Callers
            // that must know a document is gone confirm it by listing its folder.
            SafDocumentQuery.NoCursor -> throw SafDocumentUnavailableException(
                if (provider.isReachable(uri)) "$UNAVAILABLE: the provider gave no answer for the document"
                else "$UNAVAILABLE: the document provider is not available",
            )
        }
    }

    /**
     * The whole document, or an error; never a part of it. Every length the provider reports (the descriptor's size and
     * COLUMN_SIZE) must equal the bytes read; when they disagree they are asked again after [SIZE_SETTLE_DELAYS_MS]
     * (about 2 s in all), because the Downloads provider updates COLUMN_SIZE from an asynchronous close listener. A document
     * no length is reported for is read and answered with lengthVerified = false: the caller must not repair from it.
     * Error texts carry no URI and no file name (sync reads some words in them as "invalid JSON, repair it").
     */
    fun readBytes(uri: String, maxBytes: Long): SafDocumentRead {
        val row = stat(uri) ?: throw SafDocumentUnavailableException("$UNAVAILABLE: the document is gone")
        if (row.flags and FLAG_PARTIAL != 0L) {
            throw SafDocumentIncompleteException("$INCOMPLETE: the document is still downloading")
        }
        val opened = try {
            provider.openRead(uri)
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not open the document", error)
        }
        opened.use { document ->
            val bytes = try {
                readAll(document.stream, maxBytes)
            } catch (error: SafDocumentTooLargeException) {
                throw error
            } catch (error: Throwable) {
                throw SafDocumentUnavailableException("$UNAVAILABLE: the document read failed", error)
            }
            var columnSize = row.size
            var descriptorSize = document.size()
            for (delay in listOf(0L) + SIZE_SETTLE_DELAYS_MS) {
                if (delay > 0) {
                    sleep(delay)
                    columnSize = stat(uri)?.size
                    descriptorSize = document.size()
                }
                val reported = listOfNotNull(columnSize, descriptorSize)
                if (reported.all { it == bytes.size.toLong() }) return SafDocumentRead(bytes, reported.isNotEmpty())
            }
            throw SafDocumentIncompleteException(
                if (descriptorSize != null && columnSize != null && descriptorSize != columnSize)
                    "$INCOMPLETE: the provider reports inconsistent sizes"
                else "$INCOMPLETE: short read",
            )
        }
    }

    /**
     * Writes [bytes] into document [uri] (File Sync writes only into documents it just created) through the provider's
     * output stream, with no writability pre-check: RSAF (rclone) never sets FLAG_SUPPORTS_WRITE, and expo's legacy SAF
     * write refused every attempt on it (#1001). A failed close is a failed write.
     */
    fun writeBytes(uri: String, bytes: ByteArray) {
        try {
            provider.openWrite(uri).use { it.write(bytes) }
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the document write failed", error)
        }
    }

    private fun readAll(stream: java.io.InputStream, maxBytes: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) return out.toByteArray()
            if (out.size().toLong() + count > maxBytes) {
                throw SafDocumentTooLargeException("$TOO_LARGE: the document exceeds this device's read limit")
            }
            out.write(buffer, 0, count)
        }
    }

    companion object {
        const val UNAVAILABLE = "SAF_DOCUMENT_UNAVAILABLE"
        const val INCOMPLETE = "SAF_DOCUMENT_INCOMPLETE"
        const val TOO_LARGE = "SAF_DOCUMENT_TOO_LARGE"
        /** DocumentsContract.Document.FLAG_PARTIAL. */
        const val FLAG_PARTIAL = 8192L
        /** Re-query after 250 ms, 750 ms and 2 s. */
        val SIZE_SETTLE_DELAYS_MS = listOf(250L, 500L, 1250L)
    }
}

/** A whole document's bytes; [lengthVerified] says a reported length confirmed them. */
class SafDocumentRead(val bytes: ByteArray, val lengthVerified: Boolean)

/** An open read: its stream, and the descriptor's size now (null when the descriptor has none, as a pipe). */
interface SafOpenedDocument : AutoCloseable {
    val stream: java.io.InputStream
    fun size(): Long?
}

/** One document as the provider describes it. [uri] is its tree document URI; [name] is its display name. */
data class SafDocumentRow(
    val uri: String,
    val name: String?,
    val mime: String?,
    val size: Long?,
    val flags: Long,
    val lastModified: Long?,
)

sealed class SafDocumentQuery {
    data class Found(val row: SafDocumentRow) : SafDocumentQuery()
    /** A cursor with no row. */
    object Missing : SafDocumentQuery()
    /** The provider answered no cursor at all. */
    object NoCursor : SafDocumentQuery()
}

/** The part of Android's ContentResolver and DocumentsContract that [SafDocumentsCore] reads through. */
interface SafDocumentProvider {
    /** The children of [dirUri] (a tree URI or a tree document URI); null when the provider answered no cursor. */
    fun queryChildren(dirUri: String): List<SafDocumentRow>?
    fun queryDocument(uri: String): SafDocumentQuery
    /** Whether [uri]'s authority names an installed provider this app can reach. */
    fun isReachable(uri: String): Boolean
    fun openRead(uri: String): SafOpenedDocument
    /** The document's output stream in mode "w". */
    fun openWrite(uri: String): java.io.OutputStream
}

open class SafDocumentUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)
class SafDocumentIncompleteException(message: String) : SafDocumentUnavailableException(message)
class SafDocumentTooLargeException(message: String) : SafDocumentUnavailableException(message)
