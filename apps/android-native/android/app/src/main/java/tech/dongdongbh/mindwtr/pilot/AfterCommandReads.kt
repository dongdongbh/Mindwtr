package tech.dongdongbh.mindwtr.pilot


internal object AfterCommandReads {

    enum class Read { Search, Menu, Focus, Projects, AllLists }


    fun order(screen: Screen, menuOnShow: Boolean, searchOpen: Boolean): List<Set<Read>> = when {
        searchOpen -> listOf(setOf(Read.Search), setOf(Read.AllLists, Read.Menu))
        menuOnShow || screen == Screen.Inbox -> listOf(setOf(Read.Menu), setOf(Read.AllLists))
        screen == Screen.Projects -> listOf(setOf(Read.Projects), setOf(Read.Focus, Read.Menu))
        else -> listOf(setOf(Read.Focus), setOf(Read.Projects, Read.Menu))
    }


    fun run(groups: List<Set<Read>>, start: (Read, () -> Unit) -> Unit) {
        val group = groups.firstOrNull() ?: return
        var left = group.size
        for (read in group) start(read) {
            left -= 1
            if (left == 0) run(groups.drop(1), start)
        }
    }
}
