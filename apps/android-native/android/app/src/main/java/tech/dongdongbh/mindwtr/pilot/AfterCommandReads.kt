package tech.dongdongbh.mindwtr.pilot

/**
 * The reads after a command, in order: what is on screen first, every other list once that read answered (on success or
 * failure). Core runs one call at a time, and a save's new row used to wait behind a hidden Focus read and its Pomodoro read.
 * Nothing is skipped: each hidden list is still read after every command, so a tab switch finds it as fresh as before.
 */
internal object AfterCommandReads {
    /** [AllLists]: Focus, Projects, the open project and the area filter (InboxViewModel.read with no screen). */
    enum class Read { Search, Menu, Focus, Projects, AllLists }

    /** The groups to read one after another: the visible read alone, then the rest together. */
    fun order(screen: Screen, menuOnShow: Boolean, searchOpen: Boolean): List<Set<Read>> = when {
        searchOpen -> listOf(setOf(Read.Search), setOf(Read.AllLists, Read.Menu))
        menuOnShow || screen == Screen.Inbox -> listOf(setOf(Read.Menu), setOf(Read.AllLists))
        screen == Screen.Projects -> listOf(setOf(Read.Projects), setOf(Read.Focus, Read.Menu))
        else -> listOf(setOf(Read.Focus), setOf(Read.Projects, Read.Menu))
    }

    /** Starts [groups] in turn: [start] queues one read and calls its done once that read answered or failed. */
    fun run(groups: List<Set<Read>>, start: (Read, () -> Unit) -> Unit) {
        val group = groups.firstOrNull() ?: return
        var left = group.size
        for (read in group) start(read) {
            left -= 1
            if (left == 0) run(groups.drop(1), start)
        }
    }
}
