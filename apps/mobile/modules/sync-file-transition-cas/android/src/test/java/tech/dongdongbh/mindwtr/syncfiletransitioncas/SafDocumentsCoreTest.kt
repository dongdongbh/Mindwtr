package tech.dongdongbh.mindwtr.syncfiletransitioncas

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SafDocumentsCoreTest {
    private open class FakeProvider : SafDocumentProvider {
        var children: List<SafDocumentRow>? = emptyList()
        var childrenError: Throwable? = null
        var document: SafDocumentQuery = SafDocumentQuery.Missing
        var documentError: Throwable? = null
        var reachable = true

        override fun queryChildren(dirUri: String): List<SafDocumentRow>? {
            childrenError?.let { throw it }
            return children
        }

        override fun queryDocument(uri: String): SafDocumentQuery {
            documentError?.let { throw it }
            return document
        }

        override fun isReachable(uri: String) = reachable
        override fun openRead(uri: String): SafOpenedDocument = throw UnsupportedOperationException()
        var written: java.io.ByteArrayOutputStream? = null
        var writeError: Throwable? = null
        override fun openWrite(uri: String): java.io.OutputStream {
            writeError?.let { throw it }
            return java.io.ByteArrayOutputStream().also { written = it }
        }
    }

    private fun row(name: String) = SafDocumentRow("content://p/tree/t/document/$name", name, null, 3, 0, null)

    private fun assertUnavailable(block: () -> Unit) {
        try {
            block()
            fail("expected SafDocumentUnavailableException")
        } catch (error: SafDocumentUnavailableException) {
            assertTrue(error.message!!.startsWith(SafDocumentsCore.UNAVAILABLE))
        }
    }

    @Test
    fun listingReturnsWhatTheProviderListed() {
        val provider = FakeProvider().apply { children = listOf(row("data.json")) }
        assertEquals(listOf("data.json"), SafDocumentsCore(provider).listChildren("content://p/tree/t").map { it.name })
        provider.children = emptyList()
        assertTrue(SafDocumentsCore(provider).listChildren("content://p/tree/t").isEmpty())
    }

    @Test
    fun aListingWithNoCursorIsAnErrorNotAnEmptyFolder() {
        val provider = FakeProvider().apply { children = null }
        assertUnavailable { SafDocumentsCore(provider).listChildren("content://p/tree/t") }
    }

    @Test
    fun aListingTheProviderFailsIsAnErrorNotAnEmptyFolder() {
        val provider = FakeProvider().apply { childrenError = IllegalStateException("query failed") }
        assertUnavailable { SafDocumentsCore(provider).listChildren("content://p/tree/t") }
    }

    @Test
    fun statAnswersNullOnlyWhenTheProviderAnsweredAnEmptyCursor() {
        val provider = FakeProvider()
        assertNull(SafDocumentsCore(provider).stat("content://p/tree/t/document/x"))
    }

    @Test
    fun aLookupWithNoCursorIsAnErrorEvenFromAReachableProvider() {
        // No cursor proves nothing: DocumentsProvider.query answers null for a vanished document and for a provider that
        // failed the query alike, so only an empty cursor means "absent".
        val provider = FakeProvider().apply { document = SafDocumentQuery.NoCursor }
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
        provider.reachable = false
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
    }

    @Test
    fun statThrowsWhenThePermissionIsGone() {
        val provider = FakeProvider().apply { documentError = SecurityException("Permission Denial") }
        assertUnavailable { SafDocumentsCore(provider).stat("content://p/tree/t/document/x") }
    }

    @Test
    fun aWriteGoesStraightToTheOutputStreamWithNoFlagCheck() {
        // FLAG_SUPPORTS_WRITE (2) is absent from the row, as RSAF reports it.
        val provider = FakeProvider().apply { document = SafDocumentQuery.Found(row("x").copy(flags = 0)) }
        SafDocumentsCore(provider).writeBytes("content://p/tree/t/document/x", byteArrayOf(1, 2, 3))
        assertEquals(listOf<Byte>(1, 2, 3), provider.written!!.toByteArray().toList())
    }

    @Test
    fun aFailedWriteIsAnError() {
        val provider = FakeProvider().apply { writeError = java.io.IOException("disk full") }
        assertUnavailable { SafDocumentsCore(provider).writeBytes("content://p/tree/t/document/x", byteArrayOf(1)) }
    }

    @Test
    fun statReturnsTheRow() {
        val provider = FakeProvider().apply { document = SafDocumentQuery.Found(row("data.json")) }
        assertEquals("data.json", SafDocumentsCore(provider).stat("content://p/tree/t/document/data.json")?.name)
    }
}

class SafDocumentsCoreReadTest {
    private class Opened(bytes: ByteArray, private val sizes: MutableList<Long?>, private val failAfter: Int? = null) : SafOpenedDocument {
        override val stream: java.io.InputStream = object : java.io.InputStream() {
            private val source = bytes.inputStream()
            private var count = 0
            override fun read(): Int {
                if (failAfter != null && count >= failAfter) throw java.io.IOException("connection reset")
                count += 1
                return source.read()
            }
        }
        override fun size(): Long? = if (sizes.size > 1) sizes.removeAt(0) else sizes.first()
        override fun close() = Unit
    }

    private class Provider(
        val bytes: ByteArray,
        val columnSizes: MutableList<Long?>,
        val descriptorSizes: MutableList<Long?>,
        val flags: Long = 0,
        val failAfter: Int? = null,
    ) : SafDocumentProvider {
        override fun queryChildren(dirUri: String): List<SafDocumentRow>? = emptyList()
        override fun queryDocument(uri: String): SafDocumentQuery {
            val size = if (columnSizes.size > 1) columnSizes.removeAt(0) else columnSizes.first()
            return SafDocumentQuery.Found(SafDocumentRow(uri, "data.json", "application/json", size, flags, null))
        }
        override fun isReachable(uri: String) = true
        override fun openRead(uri: String): SafOpenedDocument = Opened(bytes, descriptorSizes, failAfter)
        override fun openWrite(uri: String): java.io.OutputStream = throw UnsupportedOperationException()
    }

    private val uri = "content://p/tree/t/document/t%2Fdata.json"
    private val document = ByteArray(113) { 'a'.code.toByte() }
    private val waits = mutableListOf<Long>()

    private fun core(provider: Provider) = SafDocumentsCore(provider) { waits.add(it) }

    private fun assertIncomplete(expected: String, block: () -> Unit) {
        try {
            block()
            fail("expected SafDocumentIncompleteException")
        } catch (error: SafDocumentIncompleteException) {
            assertEquals("${SafDocumentsCore.INCOMPLETE}: $expected", error.message)
        }
    }

    @Test
    fun aDocumentWhoseLengthsAgreeIsReadAndVerified() {
        val read = core(Provider(document, mutableListOf(113L), mutableListOf(113L))).readBytes(uri, 1_000)
        assertEquals(113, read.bytes.size)
        assertTrue(read.lengthVerified)
        assertTrue(waits.isEmpty())
    }

    @Test
    fun aCleanShortEofIsRefused() {
        assertIncomplete("short read") {
            core(Provider(document.copyOf(32), mutableListOf(113L), mutableListOf(null))).readBytes(uri, 1_000)
        }
        assertIncomplete("short read") {
            core(Provider(ByteArray(0), mutableListOf(113L), mutableListOf(null))).readBytes(uri, 1_000)
        }
    }

    @Test
    fun sizesThatStayInconsistentAreRefusedAfterTheBoundedWait() {
        // COLUMN_SIZE 113, a truncated 32-byte descriptor, 32 bytes then EOF.
        assertIncomplete("the provider reports inconsistent sizes") {
            core(Provider(document.copyOf(32), mutableListOf(113L), mutableListOf(32L))).readBytes(uri, 1_000)
        }
        assertEquals(SafDocumentsCore.SIZE_SETTLE_DELAYS_MS, waits)
    }

    @Test
    fun aDownloadsSizeThatCatchesUpIsAccepted() {
        // The Downloads provider: metadata 0 while the descriptor already holds 113 bytes, then 113.
        val read = core(Provider(document, mutableListOf(0L, 113L), mutableListOf(113L))).readBytes(uri, 1_000)
        assertTrue(read.lengthVerified)
        assertEquals(listOf(250L), waits)
    }

    @Test
    fun aPartialDocumentIsRefused() {
        assertIncomplete("the document is still downloading") {
            core(Provider(document, mutableListOf(113L), mutableListOf(113L), flags = SafDocumentsCore.FLAG_PARTIAL)).readBytes(uri, 1_000)
        }
    }

    @Test
    fun aDocumentWithNoReportedLengthIsReadUnverified() {
        val read = core(Provider(document, mutableListOf(null), mutableListOf(null))).readBytes(uri, 1_000)
        assertEquals(113, read.bytes.size)
        assertFalse(read.lengthVerified)
    }

    @Test
    fun aStreamErrorAndAnOversizedDocumentThrowAndNameNoFile() {
        try {
            core(Provider(document, mutableListOf(113L), mutableListOf(113L), failAfter = 10)).readBytes(uri, 1_000)
            fail("expected a stream error")
        } catch (error: SafDocumentUnavailableException) {
            assertFalse(error.message!!.contains("json", ignoreCase = true))
        }
        try {
            core(Provider(document, mutableListOf(113L), mutableListOf(113L))).readBytes(uri, 100)
            fail("expected an oversize error")
        } catch (error: SafDocumentTooLargeException) {
            assertFalse(error.message!!.contains("json", ignoreCase = true))
        }
    }
}
