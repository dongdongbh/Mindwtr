package tech.dongdongbh.mindwtr.syncfiletransitioncas


class SafDocumentsCore(
    private val provider: SafDocumentProvider,

    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {

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


    fun stat(uri: String): SafDocumentRow? {
        val answer = try {
            provider.queryDocument(uri)
        } catch (error: Throwable) {
            throw SafDocumentUnavailableException("$UNAVAILABLE: the provider could not describe the document", error)
        }
        return when (answer) {
            is SafDocumentQuery.Found -> answer.row
            SafDocumentQuery.Missing -> null


            SafDocumentQuery.NoCursor -> throw SafDocumentUnavailableException(
                if (provider.isReachable(uri)) "$UNAVAILABLE: the provider gave no answer for the document"
                else "$UNAVAILABLE: the document provider is not available",
            )
        }
    }


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

        const val FLAG_PARTIAL = 8192L

        val SIZE_SETTLE_DELAYS_MS = listOf(250L, 500L, 1250L)
    }
}


class SafDocumentRead(val bytes: ByteArray, val lengthVerified: Boolean)


interface SafOpenedDocument : AutoCloseable {
    val stream: java.io.InputStream
    fun size(): Long?
}


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

    object Missing : SafDocumentQuery()

    object NoCursor : SafDocumentQuery()
}


interface SafDocumentProvider {

    fun queryChildren(dirUri: String): List<SafDocumentRow>?
    fun queryDocument(uri: String): SafDocumentQuery

    fun isReachable(uri: String): Boolean
    fun openRead(uri: String): SafOpenedDocument

    fun openWrite(uri: String): java.io.OutputStream
}

open class SafDocumentUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)
class SafDocumentIncompleteException(message: String) : SafDocumentUnavailableException(message)
class SafDocumentTooLargeException(message: String) : SafDocumentUnavailableException(message)
