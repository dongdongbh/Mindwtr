package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONObject

internal data class QuickCaptureDestination(
  val destination: WidgetPayload.CaptureDestination,
  val projectToCreate: String? = null,
) {
  companion object {
    private val commandBoundary = """(?=\s/(?:\*(?:\s+focus\b)?|link:|note:|start:|due:|review:|remind-due:|remind-start:|remind:|project:|area:|energy:|priority:|estimate:|duration:|inbox\b|next\b|in-progress\b|waiting\b|someday\b|reference\b|done\b|archived\b)|$)"""
    private data class NameMatch(val raw: String, val value: String)

    fun requiresExplicitDestination(title: String): Boolean {
      val input = routingInput(title)
      return Regex("""(?:^|\s)(?:[+!]|/(?:project|area):)""", RegexOption.IGNORE_CASE).containsMatchIn(input) &&
        Regex("""(?:^|\s)(?:[@#%]|/(?:start|due|review|remind(?:-due|-start)?|energy|priority|estimate|duration):)""", RegexOption.IGNORE_CASE).containsMatchIn(input)
    }

    private fun routingInput(title: String): String {
      val protectedInput = Regex("""\\([@#+/!%])""").replace(title) { "__MW_ESC__${it.groupValues[1][0].code}__" }
      val linked = normalized(protectedInput.replace(Regex("""(?:^|\s)/link:[\s\S]*?$commandBoundary""", RegexOption.IGNORE_CASE), ""))
      val tokens = normalized(linked.replace(Regex("""(?:^|\s)[@#](?:"(?:\\.|[^"\\])*"|[“”„][^"“”]*["“”])"""), " "))
      val person = quotedNameAt(tokens, '%')
      return if (person != null) normalized(tokens.replaceFirst(person.raw, "")) else tokens
    }

    fun resolve(
      title: String,
      catalog: WidgetPayload.CaptureDestinations?,
      baseline: WidgetPayload.CaptureDestination?,
      selected: WidgetPayload.CaptureDestination?,
    ): QuickCaptureDestination? {
      val resolved = resolveValue(title, catalog, baseline, selected) ?: return null
      val destination = resolved.destination
      val available = when (destination.kind) {
        "none" -> true
        "area" -> catalog?.areas?.any { it.id == destination.id } == true
        "project" -> catalog?.projects?.any { it.id == destination.id } == true &&
          (destination.sectionId == null || catalog?.sections?.any { it.id == destination.sectionId && it.projectId == destination.id } == true)
        else -> false
      }
      return resolved.takeIf { available }
    }

    private fun resolveValue(
      title: String,
      catalog: WidgetPayload.CaptureDestinations?,
      baseline: WidgetPayload.CaptureDestination?,
      selected: WidgetPayload.CaptureDestination?,
    ): QuickCaptureDestination? {
      if (selected != null) return QuickCaptureDestination(selected)
      if (baseline == null) return null
      if (requiresExplicitDestination(title)) return null
      val input = normalized(routingInput(title).replace(Regex("""(?:^|\s)[@#][\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*"""), " "))
      val (area, afterArea) = areaDestination(input, catalog)
      val withoutNote = normalized(afterArea.replaceFirst(Regex("""(?:^|\s)/note:[\s\S]+?$commandBoundary""", RegexOption.IGNORE_CASE), ""))
      val withoutStatus = normalized(withoutNote.replaceFirst(Regex("""(?:^|\s)/(inbox|next|in-progress|waiting|someday|reference|done|archived)(?=\s|$)""", RegexOption.IGNORE_CASE), ""))
      val projectInput = normalized(withoutStatus.replaceFirst(Regex("""(?:^|\s)/\*(?:\s+focus\b)?(?=\s|$)""", RegexOption.IGNORE_CASE), ""))
      val projectId = Regex("(?:^|\\s)/project:([^\\s/]+)", RegexOption.IGNORE_CASE).find(projectInput)?.groupValues?.get(1)
      if (projectId != null) return QuickCaptureDestination(WidgetPayload.CaptureDestination("project", projectId))
      val project = nameAt(projectInput, '+', catalog?.projects.orEmpty().map { it.title })
      if (project != null) {
        val existing = catalog?.projects?.firstOrNull { normalized(it.title).equals(project.value, ignoreCase = true) }
        return if (existing != null) QuickCaptureDestination(WidgetPayload.CaptureDestination("project", existing.id))
        else QuickCaptureDestination(area ?: baseline, project.value)
      }
      return QuickCaptureDestination(area ?: baseline)
    }

    private fun areaDestination(title: String, catalog: WidgetPayload.CaptureDestinations?): Pair<WidgetPayload.CaptureDestination?, String> {
      val explicit = Regex("(?:^|\\s)/area:([^\\s/]+)", RegexOption.IGNORE_CASE).find(title)
      val name = if (explicit == null) nameAt(title, '!', catalog?.areas.orEmpty().map { it.name }) else null
      val token = explicit?.groupValues?.get(1)?.let(::restoreEscapes)
      val area = if (token != null) catalog?.areas?.firstOrNull { it.id == token || it.name.equals(token, true) }
      else name?.let { match -> catalog?.areas?.firstOrNull { normalized(it.name).equals(match.value, true) } }
      return area?.let { WidgetPayload.CaptureDestination("area", it.id) to normalized(title.replaceFirst(explicit?.value ?: name!!.raw, "")) }
        ?: (null to title)
    }

    private fun normalized(value: String) = value.trim().replace(Regex("\\s+"), " ")
    private fun restoreEscapes(value: String) = Regex("__MW_ESC__(\\d+)__").replace(value) { it.groupValues[1].toInt().toChar().toString() }

    private fun quotedNameAt(text: String, marker: Char): NameMatch? {
      val prefix = "(?:^|\\s)${Regex.escape(marker.toString())}"
      val quoted = Regex("""$prefix(?:"((?:\\.|[^"\\])*)"|[“”]([^"“”]*)["“”]|„([^"“”]*)["“”]|'([^']*)'|[‘’]([^’]*)’)""").find(text)
      if (quoted != null) {
        val value = quoted.groups.drop(1).firstNotNullOfOrNull { it?.value }.orEmpty()
        val restored = normalized(restoreEscapes(value.replace(Regex("""\\(["\\])"""), "$1")))
        if (restored.isNotBlank()) return NameMatch(quoted.value.trimStart(), restored)
      }
      return null
    }

    private fun nameAt(text: String, marker: Char, names: List<String>): NameMatch? {
      quotedNameAt(text, marker)?.let { return it }
      val prefix = "(?:^|\\s)${Regex.escape(marker.toString())}"
      val blocked = if (marker == '+') "[@#+/%]" else "[@#+/!%]"
      val match = Regex("""$prefix([^\s/]+(?:\s+(?!$blocked)[^/\s]+)*)""").find(text) ?: return null
      val rest = match.groupValues[1]
      val words = Regex("\\S+").findAll(rest).toList()
      for (end in words.indices.reversed()) {
        val raw = rest.substring(0, words[end].range.last + 1)
        val candidate = normalized(restoreEscapes(raw))
        names.firstOrNull { normalized(it).equals(candidate, true) }?.let { return NameMatch("$marker$raw", normalized(it)) }
      }
      return if (marker == '+') NameMatch("$marker$rest", normalized(restoreEscapes(rest))) else null
    }
  }
}

internal fun WidgetPayload.CaptureDestination.toJson(): JSONObject = JSONObject().put("kind", kind).apply {
  id?.let { put("id", it) }
  sectionId?.let { put("sectionId", it) }
}
