package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONObject
import java.util.Locale

internal data class QuickCaptureDestination(
  val destination: WidgetPayload.CaptureDestination,
  val projectToCreate: String? = null,
) {
  companion object {
    private val commandBoundary = """(?=\s/(?:\*(?:\s+focus(?![A-Za-z0-9_]))?|link:|note:|start:|due:|review:|remind-due:|remind-start:|remind:|project:|area:|energy:|priority:|estimate:|duration:|inbox(?![A-Za-z0-9_])|next(?![A-Za-z0-9_])|in-progress(?![A-Za-z0-9_])|waiting(?![A-Za-z0-9_])|someday(?![A-Za-z0-9_])|reference(?![A-Za-z0-9_])|done(?![A-Za-z0-9_])|archived(?![A-Za-z0-9_]))|$)"""
    private data class NameMatch(val raw: String, val value: String)

    fun requiresExplicitDestination(title: String): Boolean {
      val input = routingInput(title)
      return syntaxRegex("""(?:^|\s)(?:[+!]|/(?:project|area):)""").containsMatchIn(asciiCommandInput(input)) &&
        syntaxRegex("""(?:^|\s)(?:[@#%]|/(?:start|due|review|remind(?:-due|-start)?|energy|priority|estimate|duration):)""").containsMatchIn(asciiCommandInput(input))
    }

    private fun routingInput(title: String): String {
      val protectedInput = syntaxRegex("""\\([@#+/!%])""").replace(title) { "__MW_ESC__${it.groupValues[1][0].code}__" }
      var linked = protectedInput
      while (true) {
        val link = firstCommand(linked, """(?:^|\s)/link:[\s\S]*?$commandBoundary""") ?: break
        linked = normalized(linked.removeRange(link.range))
      }
      val tokens = normalized(linked.replace(syntaxRegex("""(?:^|\s)[@#](?:"((?:\\.|[^"\\])*)"|[“”„]([^"“”]*)["“”])""")) { match ->
        if (normalized(match.groups[1]?.value ?: match.groups[2]?.value.orEmpty()).isNotEmpty()) " " else match.value
      })
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
      val input = normalized(routingInput(title).replace(syntaxRegex("""(?:^|\s)[@#][\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*"""), " "))
      val (area, afterArea) = areaDestination(input, catalog)
      val withoutNote = stripFirstCommand(afterArea, """(?:^|\s)/note:[\s\S]+?$commandBoundary""")
      val withoutStatus = stripFirstCommand(withoutNote, """(?:^|\s)/(inbox|next|in-progress|waiting|someday|reference|done|archived)(?=\s|$)""")
      val projectInput = stripFirstCommand(withoutStatus, """(?:^|\s)/\*(?:\s+focus(?![A-Za-z0-9_]))?(?=\s|$)""")
      val projectId = firstCommand(projectInput, "(?:^|\\s)/project:([^\\s/]+)")?.groups?.get(1)?.range?.let { projectInput.substring(it) }
      if (projectId != null) return QuickCaptureDestination(WidgetPayload.CaptureDestination("project", projectId))
      val project = nameAt(projectInput, '+', catalog?.projects.orEmpty().map { it.title })
      if (project != null) {
        val existing = catalog?.projects?.firstOrNull { normalizedName(it.title) == normalizedName(project.value) }
        return if (existing != null) QuickCaptureDestination(WidgetPayload.CaptureDestination("project", existing.id))
        else QuickCaptureDestination(area ?: baseline, project.value)
      }
      return QuickCaptureDestination(area ?: baseline)
    }

    private fun areaDestination(title: String, catalog: WidgetPayload.CaptureDestinations?): Pair<WidgetPayload.CaptureDestination?, String> {
      val explicit = firstCommand(title, "(?:^|\\s)/area:([^\\s/]+)")
      val name = if (explicit == null) nameAt(title, '!', catalog?.areas.orEmpty().map { it.name }) else null
      val token = explicit?.groups?.get(1)?.range?.let { restoreEscapes(title.substring(it)) }
      val area = if (token != null) catalog?.areas?.firstOrNull { it.id == token || it.name.lowercase(Locale.ROOT) == token.lowercase(Locale.ROOT) }
      else name?.let { match -> catalog?.areas?.firstOrNull { normalizedName(it.name) == normalizedName(match.value) } }
      return area?.let { WidgetPayload.CaptureDestination("area", it.id) to normalized(explicit?.let { title.removeRange(it.range) } ?: title.replaceFirst(name!!.raw, "")) }
        ?: (null to title)
    }

    private val whitespaceCharacters = """\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"""

    private fun syntaxRegex(pattern: String) = Regex(pattern
      .replace("[\\s\\S]", "[\\d\\D]")
      .replace("\\S", "[^$whitespaceCharacters]")
      .replace("[^\\s", "[^$whitespaceCharacters")
      .replace("[^/\\s", "[^/$whitespaceCharacters")
      .replace("\\s", "[$whitespaceCharacters]"))

    private fun asciiCommandInput(value: String) = buildString(value.length) {
      for (character in value) append(if (character in 'A'..'Z') character.lowercaseChar() else character)
    }

    private fun firstCommand(value: String, pattern: String) = syntaxRegex(pattern).find(asciiCommandInput(value))
    private fun stripFirstCommand(value: String, pattern: String) = firstCommand(value, pattern)?.let {
      normalized(value.removeRange(it.range))
    } ?: value

    private fun normalized(value: String) = value.replace(syntaxRegex("\\s+"), " ").trim(' ')
    private fun normalizedName(value: String) = normalized(value).lowercase(Locale.ROOT)
    private fun restoreEscapes(value: String) = syntaxRegex("__MW_ESC__(\\d+)__").replace(value) { it.groupValues[1].toInt().toChar().toString() }

    private fun quotedNameAt(text: String, marker: Char): NameMatch? {
      val prefix = "(?:^|\\s)${Regex.escape(marker.toString())}"
      val quoted = syntaxRegex("""$prefix(?:"((?:\\.|[^"\\])*)"|[“”]([^"“”]*)["“”]|„([^"“”]*)["“”]|'([^']*)'|[‘’]([^’]*)’)""").find(text)
      if (quoted != null) {
        val value = quoted.groups.drop(1).firstNotNullOfOrNull { it?.value }.orEmpty()
        val restored = normalized(restoreEscapes(value.replace(syntaxRegex("""\\(["\\])"""), "$1")))
        if (restored.isNotBlank()) return NameMatch(quoted.value.trimStart(), restored)
      }
      return null
    }

    private fun nameAt(text: String, marker: Char, names: List<String>): NameMatch? {
      quotedNameAt(text, marker)?.let { return it }
      val prefix = "(?:^|\\s)${Regex.escape(marker.toString())}"
      val blocked = if (marker == '+') "[@#+/%]" else "[@#+/!%]"
      val match = syntaxRegex("""$prefix([^\s/]+(?:\s+(?!$blocked)[^/\s]+)*)""").find(text) ?: return null
      val rest = match.groupValues[1]
      val words = syntaxRegex("\\S+").findAll(rest).toList()
      for (end in words.indices.reversed()) {
        val raw = rest.substring(0, words[end].range.last + 1)
        val candidate = normalized(restoreEscapes(raw))
        names.firstOrNull { normalizedName(it) == normalizedName(candidate) }?.let { return NameMatch("$marker$raw", normalized(it)) }
      }
      return if (marker == '+') NameMatch("$marker$rest", normalized(restoreEscapes(rest))) else null
    }
  }
}

internal fun WidgetPayload.CaptureDestination.toJson(): JSONObject = JSONObject().put("kind", kind).apply {
  id?.let { put("id", it) }
  sectionId?.let { put("sectionId", it) }
}
