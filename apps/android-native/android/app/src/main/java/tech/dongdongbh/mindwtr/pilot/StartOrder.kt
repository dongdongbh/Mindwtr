package tech.dongdongbh.mindwtr.pilot


internal object StartOrder {

    sealed interface Drain {

        data object Done : Drain

        data object Waiting : Drain

        data class Failed(val message: String) : Drain


        data object Unswept : Drain
    }


    fun queueEmpty(names: Array<String>?, exists: Boolean): Boolean? = when {
        names != null -> names.isEmpty()
        exists -> null
        else -> true
    }

    fun afterReplay(drain: () -> Drain, owe: (String) -> Unit, retryLater: () -> Unit, startSync: () -> Unit, refreshWidgets: () -> Unit): Boolean {
        when (val result = drain()) {
            Drain.Done -> {
                startSync()
                return true
            }
            Drain.Unswept -> {
                startSync()

                refreshWidgets()
                retryLater()
            }
            Drain.Waiting -> retryLater()
            is Drain.Failed -> {
                owe(result.message)
                retryLater()
            }
        }
        return false
    }
}
