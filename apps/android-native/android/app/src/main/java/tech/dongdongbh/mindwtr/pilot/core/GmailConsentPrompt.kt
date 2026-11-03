package tech.dongdongbh.mindwtr.pilot.core

import android.content.Intent
import android.content.IntentSender


object GmailConsentPrompt {

    var picker: ((Intent) -> Unit)? = null
    var consent: ((IntentSender) -> Unit)? = null

    @Volatile var answered: (kind: String, resultCode: Int, data: Intent?) -> Unit = { _, _, _ -> }
}
