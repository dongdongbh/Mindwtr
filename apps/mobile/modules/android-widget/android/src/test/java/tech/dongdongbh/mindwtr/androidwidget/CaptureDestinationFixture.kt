package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONArray
import org.json.JSONObject

internal fun captureDestinationCatalog(defaultArea: String? = null): JSONObject = JSONObject()
  .put("defaultDestination", if (defaultArea == null) JSONObject().put("kind", "none") else JSONObject().put("kind", "area").put("id", defaultArea))
  .put("areas", JSONArray().put(JSONObject().put("id", "personal").put("name", "Personal"))
    .put(JSONObject().put("id", "work").put("name", "Work")))
  .put("projects", JSONArray().put(JSONObject().put("id", "p1").put("title", "週末 planning").put("areaId", "personal")))
  .put("sections", JSONArray())
