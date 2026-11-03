package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class DraftAttachmentsTest {
    private val a = """{"id":"a","kind":"file","title":"A.pdf","uri":"","localStatus":"missing","createdAt":"t","updatedAt":"t"}"""
    private val aDownloaded = """{"id":"a","kind":"file","title":"A.pdf","uri":"file:///f/attachments/a.pdf","localStatus":"available","createdAt":"t","updatedAt":"t"}"""
    private val b = """{"id":"b","kind":"link","title":"B","uri":"https://b.example","createdAt":"t","updatedAt":"t"}"""

    @Test fun anAnswerForAListTheDraftNoLongerHoldsIsSentAgain() {

        val sent = "[$a,$b]"
        val now = "[$aDownloaded,$b]"
        val removed = JSONObject().put("kind", "saved").put("attachments", org.json.JSONArray("[$a,${b.dropLast(1)},\"deletedAt\":\"t\"}]"))
        assertTrue(draftMoved(sent, now, removed))

        assertFalse(draftMoved(now, now, removed))
    }

    @Test fun aRefusalOrAnUnchangedDraftNeverResends() {
        assertFalse(draftMoved("[$a]", "[$aDownloaded]", JSONObject().put("kind", "refused").put("message", "no")))
        assertFalse(draftMoved("[$a]", "[$a]", JSONObject().put("kind", "saved")))
    }

    @Test fun aDiscardSettlesTheDraftOnlyWhenNoSaveIsOwed() {
        assertTrue(discardSettles(settle = true, saveOwed = false, attachmentsRead = true, readOnly = false))

        assertFalse(discardSettles(settle = true, saveOwed = true, attachmentsRead = true, readOnly = false))
        assertFalse(discardSettles(settle = false, saveOwed = false, attachmentsRead = true, readOnly = false))
        assertFalse(discardSettles(settle = true, saveOwed = false, attachmentsRead = false, readOnly = false))
        assertFalse(discardSettles(settle = true, saveOwed = false, attachmentsRead = true, readOnly = true))
    }

    @Test fun aSavesSettlementCommitsTheListTheSaveWroteNotTheDraft() {

        val half = JSONObject().put("base", org.json.JSONArray("[$a]")).put("value", org.json.JSONArray("[$aDownloaded,$b]"))
        val saved = JSONObject().put("taskRevision", "r2").put("attachmentsBase", org.json.JSONArray("[$a,$b]"))
        val input = savedSettlement("t1", half, saved)
        assertTrue(input.getJSONArray("committed").toString() == saved.getJSONArray("attachmentsBase").toString())
        assertTrue(input.getString("taskRevision") == "r2" && input.getString("taskId") == "t1")
        assertTrue(input.getJSONArray("draft").toString() == half.getJSONArray("value").toString())
    }

    @Test fun aTaskLinkFieldIsTouchedOnBlurAndAProjectsIsNot() {

        assertTrue(LinkSheet(AttachmentOwner("task", "t1")).blurred().touched)
        assertFalse(LinkSheet(AttachmentOwner("project", "p1")).blurred().touched)
    }
}
