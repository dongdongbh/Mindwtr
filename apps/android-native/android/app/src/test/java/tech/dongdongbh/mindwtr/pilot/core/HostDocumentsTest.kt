package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentProvider
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentQuery
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentRow
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafOpenedDocument

class HostDocumentsTest {
    private val folder = "content://p/tree/t/document/t"

    private class Folder : SafDocumentProvider, HostDocuments.DocumentOps {
        val documents = linkedMapOf<String, Pair<String, ByteArray>>()
        var reportSizes = true
        var deleteFails = false
        override fun queryChildren(dirUri: String) = documents.map { (uri, doc) -> row(uri, doc) }
        override fun queryDocument(uri: String) = documents[uri]?.let { SafDocumentQuery.Found(row(uri, it)) } ?: SafDocumentQuery.Missing
        override fun isReachable(uri: String) = true
        override fun openRead(uri: String): SafOpenedDocument {
            val bytes = documents.getValue(uri).second
            return object : SafOpenedDocument {
                override val stream = bytes.inputStream()
                override fun size(): Long? = if (reportSizes) bytes.size.toLong() else null
                override fun close() = Unit
            }
        }
        override fun openWrite(uri: String): java.io.OutputStream = object : java.io.ByteArrayOutputStream() {
            override fun close() { documents[uri] = documents.getValue(uri).first to toByteArray() }
        }
        override fun create(dirUri: String, mimeType: String, name: String): String =
            "content://p/tree/t/document/${documents.size + 1}".also { documents[it] = name to ByteArray(0) }
        override fun delete(uri: String): Boolean {
            if (deleteFails) throw java.io.IOException("provider refused")
            return documents.remove(uri) != null
        }
        override fun rename(uri: String, name: String): Pair<String, String> {
            documents[uri] = name to documents.getValue(uri).second
            return uri to name
        }
        private fun row(uri: String, doc: Pair<String, ByteArray>) =
            SafDocumentRow(uri, doc.first, null, if (reportSizes) doc.second.size.toLong() else null, 0, null)
    }

    private fun call(host: HostDocuments, vararg pairs: Pair<String, String>, bytes: ByteArray? = null) =
        host.call(JSONObject(pairs.toMap()).toString(), bytes)

    @Test
    fun createsWritesListsAndReadsDocumentsByDisplayName() {
        val folder = Folder()
        val host = HostDocuments(folder, folder)
        val created = call(host, "op" to "createFile", "uri" to this.folder, "name" to "data.json", "mimeType" to "application/json").value as String
        call(host, "op" to "write", "uri" to created, bytes = "{}".toByteArray())
        val listed = call(host, "op" to "listChildren", "uri" to this.folder).value as JSONArray
        assertEquals("data.json", listed.getJSONObject(0).getString("name"))
        val read = call(host, "op" to "read", "uri" to created)
        assertArrayEquals("{}".toByteArray(), read.bytes)
        assertTrue((read.value as JSONObject).getBoolean("lengthVerified"))
        folder.reportSizes = false
        assertFalse((call(host, "op" to "read", "uri" to created).value as JSONObject).getBoolean("lengthVerified"))
        val renamed = call(host, "op" to "rename", "uri" to created, "name" to "data.json.bak").value as JSONObject
        assertEquals("data.json.bak", renamed.getString("name"))
    }

    @Test
    fun aDeleteIsIdempotentOnlyForADocumentTheProviderSaysIsGone() {
        val folder = Folder()
        val host = HostDocuments(folder, folder)
        call(host, "op" to "delete", "uri" to "content://p/tree/t/document/missing")
        val created = call(host, "op" to "createFile", "uri" to this.folder, "name" to "x", "mimeType" to "text/plain").value as String
        folder.deleteFails = true
        try {
            call(host, "op" to "delete", "uri" to created)
            fail("a document still there after a refused delete is an error")
        } catch (error: java.io.IOException) {
            assertEquals("provider refused", error.message)
        }
    }

    @Test
    fun aStatOfAMissingDocumentAnswersNull() {
        val folder = Folder()
        assertEquals(null, call(HostDocuments(folder, folder), "op" to "stat", "uri" to "content://p/tree/t/document/9").value)
    }
}
