package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject


class HostAppSearch(private val context: Context, private val scheme: String) {

    fun info(): String = JSONObject().put("supported", MindwtrAppSearchIndex.isSupported()).put("scheme", scheme).toString()


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
