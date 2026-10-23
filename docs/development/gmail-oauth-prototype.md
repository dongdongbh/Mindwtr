# Gmail OAuth prototype: desktop and React Native (#1326)

Status: implementation is for designated test accounts, not general availability. It covers desktop and the shipping React Native app in `apps/mobile`; migration apps are outside this scope. Release builds do not enable Gmail unless the maintainer supplies the verified-production build configuration after completing the gates below. Desktop IMAP remains independent. Mobile Gmail capture runs only while the app is in the foreground, after canonical data hydration; it does not add an OS background polling job.

## Desktop registration and local test setup

1. Create/select a Google Cloud project owned by Mindwtr and enable Gmail API.
2. Configure Google Auth Platform Branding (Mindwtr, support and developer contacts); Audience External, publishing status Testing, explicitly designated test users.
3. Data Access: request only `https://www.googleapis.com/auth/gmail.readonly`.
4. Create a Desktop app OAuth client and save its installed-client JSON outside the repository. If Google no longer offers a download for an existing client, use Add secret and immediately save the client ID and new secret in an `installed` object with `client_id` and `client_secret` fields; retain the existing secret during testing. Do not use a Web client, an embedded login webview, OAuth IMAP, or a Mindwtr-hosted callback.
5. Set `MINDWTR_GMAIL_OAUTH_CLIENT_FILE` to the absolute JSON path when launching a debug desktop build. The release build does not accept this runtime override. The JSON contains client registration metadata, not a mailbox access/refresh token; distributed desktop client secrets are not confidential credentials and never replace PKCE.
6. Use an isolated Mindwtr test profile and disposable messages in a designated Gmail account. Create a label in Gmail, for example Mindwtr, and assign a few test messages. Creating/renaming labels remains a Gmail action.
7. In Settings → Integrations → Gmail, connect Gmail through the system browser, verify the returned account, select a label, then explicitly start capture. Merely connecting or highlighting a label imports nothing.

Testing-mode Gmail refresh tokens generally expire after seven days; that is not an acceptable production deployment configuration.

## React Native registration and local test setup

Use the same Mindwtr-owned Google project and restricted `gmail.readonly` scope. Register platform clients for the build identity being tested, rather than distributing a desktop client secret to the phone.

- **Android:** register the Android application ID and signing-certificate fingerprint in Google Cloud. The `.dev` application ID and its debug certificate need their own registration. The native Expo module uses Google Identity Services `AuthorizationClient` and explicit account selection. Subsequent requests must use that selected account and cannot open consent UI. Access tokens remain in native memory/the Google service; native preferences retain the selected account. No app refresh-token or server-auth-code flow is introduced.
- **iOS:** register the iOS bundle ID, provide public `MINDWTR_GMAIL_IOS_CLIENT_ID`, and let `app.config.ts` install its reversed-client-ID URL scheme plus `MindwtrGmailClientId`/`MindwtrGmailEnabled` Info.plist values. The native module uses `ASWebAuthenticationSession`, code flow with PKCE/state, and this-device-only Keychain storage. The callback is the registered custom scheme, not desktop loopback.
- **Build gates:** `APP_VARIANT=development` requires `MINDWTR_GMAIL_DEV_ENABLED=1`; ordinary release variants require `MINDWTR_GMAIL_PRODUCTION_VERIFIED=1`. Both default off. FOSS and benchmark variants stay disabled. FOSS preparation removes the Google-dependent Android module; JS resolves it optionally and shows Gmail unavailable. Do not bypass the gate to claim production readiness.
- **UI:** open Settings → GTD → Capture defaults → Gmail, connect a designated account, choose an existing label, and confirm Start capture / save label. Connect and label selection do not enable capture by themselves. Test opening/foregrounding the app and Check now; background/inactive transitions must stop task admission without cancelling the Google authorization screen.

Keep emulator/device test data separate from production app data. Android dev install evidence, iOS compile/device evidence, and actual Google consent evidence are separate acceptance gates.

## Data flow and ownership

- Desktop authorization is system-browser code flow with S256 PKCE, random state and a bounded one-shot IPv4 loopback callback. Callback requests must match the method, host, path and state. Mobile authorization uses the platform flows above. Cancelling or starting another connection invalidates the old attempt.
- Only native authorization code sees tokens. Desktop credentials live in the OS credential store (or the encrypted Flatpak Secret portal store), scoped to the app and local configuration path; iOS uses Keychain and Android uses the device Google service. There is no plaintext token fallback. Tokens never enter JavaScript/frontend responses, task data, ordinary backups/exports, or synchronized settings. Native modules expose status and bounded read-only Google JSON, not tokens or authorization URLs.
- Gmail profile and label/message reads go directly from each device to fixed Google HTTPS endpoints. No mailbox proxy or Mindwtr account is introduced. Gmail requests do not send mail, modify flags, add/remove labels, or delete messages. Native HTTP rejects redirects and bounds response bytes during receipt.
- The selected label is an application filter. Google grants read access to the mailbox, not to that label alone. The pre-connect UI explains this distinction.
- Sender, subject and bounded body text become normal Inbox tasks via the existing email builder and core capture factory. File attachments are not imported. Capture requires a complete supported body response before acknowledgement; it does not replace an unavailable body with a snippet and claim success.
- Imported content subsequently follows existing task storage, user-configured sync, backup/export and optional AI paths. Disconnect does not erase these tasks, remote copies or exports. Users delete tasks and retained backups separately. The pre-connect disclosure must name these destinations; existing AI settings and consent still apply.
- Analytics and diagnostics carry aggregate outcomes only. OAuth codes, authorization URLs, tokens, account addresses, label names, identifiers and message contents must not be logged.

## Duplicate prevention and races

Task identity is deterministic from the canonical Gmail profile address digest and Gmail message ID, independent of label. A reconnect to the same mailbox or a second device capturing it creates the same task IDs; the normal sync merge converges those IDs and replay does not overwrite an existing task or tombstone. A different account has a different identity. A Workspace account address rename changes this prototype identity; it must be treated as a different account until a stable-subject migration is designed.

Device-private SQLite receipts retain acknowledged opaque account/message IDs across disconnect and label changes, without a finite recent-ID window. Desktop and RN use separate receipt databases outside the task data database. Receipt storage is not task data and does not sync. Corrupt/unreadable/incomplete existing storage fails closed rather than recreating an empty history. Capture commits the receipt only after task persistence succeeds. Failed saves can replay with the same deterministic IDs and preserve edits. If both the task/tombstone and private receipts have been purged or the device profile reset, old labelled messages may be captured again; remove their capture label to avoid that intentional reset case.

`packages/core/src/gmail-capture.ts` owns the shared runtime, generation checks, status subscriptions, deterministic IDs and controller. Desktop binds Tauri IPC; RN binds `gmail-capture-service.ts` and its optional native module. The runtime polls outside `runStoreCommand`, then validates the batch and rechecks generation inside the writer gate immediately before core `addTasks` and the durable flush. RN supplies `flushPendingTaskActionSave` to recover exhausted optimistic saves. `useRootLayoutGmailCapture` starts only after `canonicalDataReady` outside sandbox, disposes the controller on inactive/background, and creates one on foreground. It does not cancel OAuth merely because the browser became active.

Polling is bounded and read-only. A batch is bound to its connection generation, account, label and page. Config changes, disconnect, cancellation and reconnect invalidate stale batches and pending OAuth/refresh completions. The frontend checks this authority again inside the shared writer gate immediately before task creation. A save already admitted before disconnect can finish; later batches cannot start. Capture acknowledgement validates the issued batch rather than trusting caller-supplied IDs. Pagination advances only on acknowledgement, including pages containing previously acknowledged mail.

Disconnect first disables capture durably, then removes device credentials and attempts Google token revocation. If Google cannot confirm revocation, the UI directs the tester to Google Account permissions; offline disconnect must still stop local polling. Disconnecting one client can revoke the shared Google app grant and require reconnect on another device; it never deletes previously captured tasks.

## Required production gate — still open

Do not set compiled `MINDWTR_GMAIL_PRODUCTION_VERIFIED=1` or distribute a broadly enabled client until all of these have evidence:

- Mindwtr-owned Google project/client, verified domain ownership and matching app branding, support contact, homepage and public privacy disclosures.
- Restricted `gmail.readonly` scope justification and a demonstration showing consent, label filtering, capture, reconnect and disconnect. Submit the actual desktop and mobile flows for Google's restricted-scope verification or document an applicable exception.
- A review of the complete derived-data flow: every supported user sync provider (including self-hosted Cloud and CloudKit), app backups/exports, diagnostics/feedback, and every optional remote AI provider. Determine permitted use, consent, retention/deletion and provider training terms for email-derived data. Do not assume local token storage exempts downstream content transfers.
- Confirm security-assessment applicability with Google for this actual flow. Google distinguishes local-only access from restricted data stored/transmitted through servers; neither “all desktop apps need an annual assessment” nor “local tokens always exempt us” is a valid shortcut.
- Final public privacy wording and the required affirmative Limited Use disclosure. No sale, ads, unrelated model training or unrelated human access. Resolve any incompatible optional provider/data path before enabling it for Gmail-derived data.
- Production publishing status and valid refresh-token lifecycle; Testing status and seven-day tokens are prototype-only.
- Native browser/loopback and secure-storage acceptance on supported desktop channels (Linux/Flatpak, macOS, Windows), plus RN Android/iOS consent, credential persistence and foreground lifecycle acceptance, using designated accounts. Verify FOSS exclusion separately. Source/unit coverage is not live Google consent evidence.

Compiled desktop client settings are `MINDWTR_GMAIL_CLIENT_ID` and `MINDWTR_GMAIL_CLIENT_SECRET` (public desktop metadata); iOS uses public `MINDWTR_GMAIL_IOS_CLIENT_ID`. Android identifies its registered client through the application ID and signing certificate, without a client-secret input. Release workflows pass the configured client inputs separately from `MINDWTR_GMAIL_PRODUCTION_VERIFIED`; configuring credentials does not enable the feature. There is no end-user client-secret field or global account requirement.

## Evidence required before calling the prototype accepted

Connect → label selection → capture → app restart → reconnect → disconnect on each platform. Check no mail/labels changed; saved tasks survive and checks do not duplicate them. Exercise consent denial, stale callback, cancellation, expired/revoked access, offline failure, failed task persistence and two clients with one mailbox. Confirm no token appears in task export, synchronized payload or diagnostics. Test account switching while a batch waits for the actual shared writer gate. On RN, pause during a network/validation/save await, foreground again, and prove no stale task admission or acknowledgement; also verify canonical startup, sandbox exclusion and FOSS unavailability. Keep failures and limits in the task handoff, not fabricated success claims.

## Primary references (checked 2026-10-20)

- [Desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Workspace user-data policy and Limited Use](https://developers.google.com/workspace/workspace-api-user-data-developer-policy?hl=en)
- [Refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Read-only message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
