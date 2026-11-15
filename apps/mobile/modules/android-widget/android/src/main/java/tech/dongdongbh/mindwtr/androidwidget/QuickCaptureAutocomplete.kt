package tech.dongdongbh.mindwtr.androidwidget

internal object QuickCaptureAutocomplete {
  data class Token(val prefix: Char, val start: Int, val end: Int, val query: String)
  data class Choice(val label: String, val token: String, val projectId: String? = null)

  fun tokenAt(text: String, caret: Int): Token? {
    if (caret !in 0..text.length) return null
    var index = 0
    while (index < text.length) {
      if (text[index] !in "@#+" || (index > 0 && !text[index - 1].isWhitespace())) {
        index++
        continue
      }
      val start = index
      val prefix = text[index++]
      val quoted = index < text.length && text[index] == '"'
      if (quoted) index++
      val queryStart = index
      var closing = false
      while (index < text.length) {
        if (quoted && text[index] == '\\' && index + 1 < text.length) {
          index += 2
        } else if (quoted && text[index] == '"') {
          closing = true
          break
        } else if (!quoted && text[index].isWhitespace()) {
          break
        } else {
          index++
        }
      }
      val contentEnd = index
      val end = index + if (closing) 1 else 0
      if (caret in (start + 1)..end) {
        val query = text.substring(queryStart.coerceAtMost(caret), caret.coerceAtMost(contentEnd))
          .replace(Regex("\\\\(.)"), "$1")
        return Token(prefix, start, end, query)
      }
      index = end.coerceAtLeast(start + 1)
    }
    return null
  }

  fun matches(token: Token, options: List<Choice>): List<Choice> {
    val query = token.query.lowercase()
    return options.filter { it.label.removePrefix(token.prefix.toString()).lowercase().contains(query) }
      .sortedBy {
        val name = it.label.removePrefix(token.prefix.toString()).lowercase()
        when { name == query -> 0; name.startsWith(query) -> 1; else -> 2 }
      }.take(8)
  }

  fun replace(text: String, token: Token, choice: Choice): Pair<String, Int> {
    if (choice.projectId == null) return QuickCaptureActivity.insertToken(text, token.start, token.end, choice.token)
    val before = text.substring(0, token.start)
    val after = text.substring(token.end)
    val suffix = if (before.isEmpty() || before.last().isWhitespace()) after.trimStart() else after
    return before + suffix to before.length
  }
}
