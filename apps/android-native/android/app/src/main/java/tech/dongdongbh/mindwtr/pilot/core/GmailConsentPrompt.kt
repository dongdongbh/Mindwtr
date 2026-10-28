package tech.dongdongbh.mindwtr.pilot.core

import android.content.Intent
import android.content.IntentSender

/**
 * Gmail's account picker and Google's consent screen (GmailAuthorization, Play only), through MainActivity's two result launchers:
 * a recreated Activity registers its own, and the answer reaches the process-scope authorization either way.
 */
object GmailConsentPrompt {
    /** The open Activity's launchers; null while none is open. Main thread. */
    var picker: ((Intent) -> Unit)? = null
    var consent: ((IntentSender) -> Unit)? = null
    /** Where an answer goes: [kind] "picker" or "consent", with the result's code and data. Main thread. */
    @Volatile var answered: (kind: String, resultCode: Int, data: Intent?) -> Unit = { _, _, _ -> }
}
