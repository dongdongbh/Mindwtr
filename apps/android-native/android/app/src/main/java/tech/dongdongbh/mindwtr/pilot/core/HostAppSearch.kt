package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android system search (RN's #1017, pass O2d): core's AppSearch service (bundle/host-app-search.ts, core's
 * app-search-service.ts) decides what is indexed and when; this only runs RN's index ([MindwtrAppSearchIndex]) for it.
 * [scheme] is the build's link scheme (`mindwtr_link_scheme`), so a result opens this build.
 */
class HostAppSearch(private val context: Context, private val scheme: String) {
    /** `{ supported, scheme }`: Android 12 (API 31) or later, as RN's isAppSearchSupported. */
    fun info(): String = JSONObject().put("supported", MindwtrAppSearchIndex.isSupported()).put("scheme", scheme).toString()

    /** `{ op: "upsert", docs } | { op: "remove", ids } | { op: "wipe" } | { op: "ids" }`; [reply] answers once AppSearch did. */
    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        val request = JSONObject(json)
        val done = { result: Result<Unit> -> reply(result.map { null }) }
        when (val op = request.getString("op")) {
            "upsert" -> MindwtrAppSearchIndex.upsert(context, docs(request.getJSONArray("docs")), done)
            "remove" -> request.getJSONArray("ids").let { ids -> MindwtrAppSearchIndex.remove(context, List(ids.length()) { ids.getString(it) }, done) }
            "wipe" -> MindwtrAppSearchIndex.wipeAll(context, done)
            "ids" -> MindwtrAppSearchIndex.ids(context) { result -> reply(result.map { JSONArray(it) }) }
            else -> reply(Result.failure(IllegalArgumentException("Unknown AppSearch call $op")))
        }
    }

    private fun docs(items: JSONArray): List<MindwtrAppSearchDoc> = List(items.length()) { items.getJSONObject(it) }.mapNotNull { item ->
        MindwtrAppSearchDoc.fromMap(item.keys().asSequence().associateWith { key -> item.opt(key).takeUnless { it == JSONObject.NULL } })
    }
}
