package tech.dongdongbh.mindwtr.pilot


class AIRequestSlots<T : Any>(private val cancel: (T) -> Unit) {
    private val slots = HashMap<String, T>()


    fun start(scope: String, call: T) {
        val replaced = synchronized(this) { slots.put(scope, call) }
        if (replaced != null && replaced !== call) cancel(replaced)
    }


    fun finished(scope: String, call: T) = synchronized(this) { if (slots[scope] === call) slots.remove(scope) }


    fun cancel(vararg scopes: String) {
        val gone = synchronized(this) { scopes.mapNotNull { slots.remove(it) } }
        gone.forEach(cancel)
    }


    fun wanted(scope: String, call: T): Boolean = synchronized(this) { slots[scope] === call }


    fun reply(scope: String, call: T, post: (() -> Unit) -> Unit, answer: () -> Unit) = post {
        val wanted = wanted(scope, call)
        finished(scope, call)
        if (wanted) answer()
    }
}


data class InboxStepKey(val sessionId: String, val taskId: String, val step: String) {
    companion object {
        fun of(flow: InboxProcessing?): InboxStepKey? = flow?.let { InboxStepKey(it.sessionId, it.taskId, it.step) }
    }
}


fun captureCopilotKey(session: String, request: String?): String? = request?.let { "$session\n$it" }


fun typedKey(current: String?, mask: String, text: String): String =
    if (current == null && text.startsWith(mask)) text.removePrefix(mask) else text.replace("\u2022", "")


class KeyTexts {
    private val texts = HashMap<String, String>()
    private val edits = HashMap<String, Long>()
    val shown: Map<String, String> get() = texts.toMap()

    fun typed(field: String, text: String) { texts[field] = text; edits[field] = edit(field) + 1 }

    fun edit(field: String): Long = edits[field] ?: 0L

    fun saved(field: String, upTo: Long) { if (edits[field] == upTo) texts.remove(field) }
    fun clear() { texts.clear() }
}
