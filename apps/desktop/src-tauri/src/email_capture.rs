use crate::*;
use mail_parser::MessageParser;
use native_tls::{TlsConnector, TlsStream};
use std::net::{TcpStream, ToSocketAddrs};

const EMAIL_CAPTURE_STATE_FILE_NAME: &str = "email-capture-state.json";
const EMAIL_CAPTURE_DEFAULT_PORT: u16 = 993;
const EMAIL_CAPTURE_DEFAULT_FOLDER: &str = "Mindwtr";
// Bounded work per poll; the mailbox is the queue, so leftovers are picked up
// by follow-up polls (`has_more`) instead of one unbounded fetch.
const EMAIL_CAPTURE_BATCH_LIMIT: usize = 25;
const EMAIL_CAPTURE_BODY_CHAR_LIMIT: usize = 16_000;
// Only the head of each message is fetched: headers and the text part come first in
// normal mail, and nothing past EMAIL_CAPTURE_BODY_CHAR_LIMIT characters is kept anyway.
// A full `BODY.PEEK[]` would download every attachment into memory.
const EMAIL_CAPTURE_FETCH_BYTE_LIMIT: usize = 262_144;
const EMAIL_CAPTURE_FETCH_QUERY: &str = "(UID BODY.PEEK[]<0.262144>)";
const EMAIL_CAPTURE_FULL_FETCH_QUERY: &str = "(UID BODY.PEEK[])";
const EMAIL_CAPTURE_SEEN_MESSAGE_ID_LIMIT: usize = 500;
const EMAIL_CAPTURE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const EMAIL_CAPTURE_IO_TIMEOUT: Duration = Duration::from_secs(60);

fn default_email_capture_port() -> u16 {
    EMAIL_CAPTURE_DEFAULT_PORT
}

fn default_email_capture_folder() -> String {
    EMAIL_CAPTURE_DEFAULT_FOLDER.to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCaptureConfigPayload {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    host: String,
    #[serde(default = "default_email_capture_port")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default = "default_email_capture_folder")]
    folder: String,
}

impl Default for EmailCaptureConfigPayload {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: EMAIL_CAPTURE_DEFAULT_PORT,
            username: String::new(),
            folder: default_email_capture_folder(),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCaptureError {
    pub kind: String,
    pub message: String,
}

impl EmailCaptureError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }

    fn auth(message: impl Into<String>) -> Self {
        Self::new("auth", message)
    }

    fn network(message: impl Into<String>) -> Self {
        Self::new("network", message)
    }

    fn config(message: impl Into<String>) -> Self {
        Self::new("config", message)
    }

    fn other(message: impl Into<String>) -> Self {
        Self::new("other", message)
    }
}

fn classify_imap_error(error: imap::error::Error, fallback_kind: &str) -> EmailCaptureError {
    match error {
        imap::error::Error::Io(inner) => EmailCaptureError::network(inner.to_string()),
        imap::error::Error::Tls(inner) => EmailCaptureError::network(inner.to_string()),
        imap::error::Error::TlsHandshake(inner) => EmailCaptureError::network(inner.to_string()),
        imap::error::Error::ConnectionLost => {
            EmailCaptureError::network("Connection lost".to_string())
        }
        other => EmailCaptureError::new(fallback_kind, other.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCaptureState {
    #[serde(default)]
    mailbox_identity: Option<EmailCaptureMailboxIdentity>,
    uid_validity: Option<u32>,
    #[serde(default)]
    last_seen_uid: u32,
    #[serde(default)]
    seen_message_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EmailCaptureMailboxIdentity {
    host: String,
    port: u16,
    username: String,
    folder: String,
}

fn email_capture_mailbox_identity(
    payload: &EmailCaptureConfigPayload,
) -> EmailCaptureMailboxIdentity {
    EmailCaptureMailboxIdentity {
        host: payload.host.to_ascii_lowercase(),
        port: payload.port,
        username: payload.username.clone(),
        folder: payload.folder.clone(),
    }
}

fn scope_email_capture_state(
    mut state: EmailCaptureState,
    identity: &EmailCaptureMailboxIdentity,
) -> EmailCaptureState {
    if state
        .mailbox_identity
        .as_ref()
        .is_some_and(|stored| stored != identity)
    {
        return EmailCaptureState {
            mailbox_identity: Some(identity.clone()),
            ..EmailCaptureState::default()
        };
    }
    state.mailbox_identity = Some(identity.clone());
    state
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCaptureMessage {
    pub uid: u32,
    pub message_id: String,
    pub subject: String,
    pub from: String,
    pub received_at: Option<String>,
    pub body_text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmailCapturePollResult {
    pub uid_validity: u32,
    pub messages: Vec<EmailCaptureMessage>,
    /// Highest UID fetched this round, including messages skipped by the
    /// Message-ID dedupe — the frontend commits this as the new watermark so
    /// already-seen mail is not refetched every poll. Zero when nothing was fetched.
    pub max_fetched_uid: u32,
    pub has_more: bool,
}

pub(crate) fn normalize_email_capture_payload(
    payload: EmailCaptureConfigPayload,
) -> EmailCaptureConfigPayload {
    let host = payload.host.trim().to_string();
    let username = payload.username.trim().to_string();
    let folder = {
        let trimmed = payload.folder.trim();
        if trimmed.is_empty() {
            default_email_capture_folder()
        } else {
            trimmed.to_string()
        }
    };
    let port = if payload.port == 0 {
        EMAIL_CAPTURE_DEFAULT_PORT
    } else {
        payload.port
    };
    EmailCaptureConfigPayload {
        enabled: payload.enabled && !host.is_empty() && !username.is_empty(),
        host,
        port,
        username,
        folder,
    }
}

fn read_email_capture_payload(config: &AppConfigToml) -> EmailCaptureConfigPayload {
    let Some(raw) = config.email_capture_config.as_ref() else {
        return EmailCaptureConfigPayload::default();
    };
    serde_json::from_str::<EmailCaptureConfigPayload>(raw)
        .map(normalize_email_capture_payload)
        .unwrap_or_default()
}

fn email_capture_state_path(app: &tauri::AppHandle) -> PathBuf {
    get_data_dir(app).join(EMAIL_CAPTURE_STATE_FILE_NAME)
}

// The state file is a read-modify-write watermark. Its writers used to be plain
// `#[tauri::command]`s that the main thread serialized for free; now that they
// run off the UI thread, a settings save landing between a commit's read and
// its write would drop the advanced watermark and re-import the same mail.
static EMAIL_CAPTURE_STATE_MUTEX: Mutex<()> = Mutex::new(());

fn lock_email_capture_state() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    EMAIL_CAPTURE_STATE_MUTEX
        .lock()
        .map_err(|_| "Email capture state lock is unavailable".to_string())
}

fn read_email_capture_state(app: &tauri::AppHandle) -> EmailCaptureState {
    let path = email_capture_state_path(app);
    let Ok(content) = fs::read_to_string(&path) else {
        return EmailCaptureState::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn write_email_capture_state(
    app: &tauri::AppHandle,
    state: &EmailCaptureState,
) -> Result<(), String> {
    let path = email_capture_state_path(app);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid email capture state path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let payload = serde_json::to_string(state).map_err(|e| e.to_string())?;
    let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    fs::write(temp.path(), payload).map_err(|e| e.to_string())?;
    temp.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pick which UIDs to fetch, oldest first, bounded by `limit`.
///
/// When the mailbox `UIDVALIDITY` matches the stored state, only UIDs above the
/// last-seen watermark are new. On a validity change (or first run) every UID is
/// a candidate again and the seen Message-ID set is the only dedupe layer.
pub(crate) fn select_new_uids(
    candidates: impl IntoIterator<Item = u32>,
    state: &EmailCaptureState,
    mailbox_uid_validity: u32,
    limit: usize,
) -> (Vec<u32>, bool) {
    let same_generation = state.uid_validity == Some(mailbox_uid_validity);
    let mut uids: Vec<u32> = candidates
        .into_iter()
        .filter(|uid| !same_generation || *uid > state.last_seen_uid)
        .collect();
    uids.sort_unstable();
    uids.dedup();
    let has_more = uids.len() > limit;
    uids.truncate(limit);
    (uids, has_more)
}

/// Advance the dedupe state after the frontend confirmed the fetched batch was
/// durably persisted as tasks. The UID watermark only moves forward within the
/// same UIDVALIDITY generation; Message-IDs are capped to a recent window.
pub(crate) fn merge_email_capture_state(
    mut state: EmailCaptureState,
    uid_validity: u32,
    processed_max_uid: u32,
    message_ids: Vec<String>,
) -> EmailCaptureState {
    if state.uid_validity == Some(uid_validity) {
        state.last_seen_uid = state.last_seen_uid.max(processed_max_uid);
    } else {
        state.uid_validity = Some(uid_validity);
        state.last_seen_uid = processed_max_uid;
    }
    for id in message_ids {
        let trimmed = id.trim().to_string();
        if trimmed.is_empty() || state.seen_message_ids.contains(&trimmed) {
            continue;
        }
        state.seen_message_ids.push(trimmed);
    }
    if state.seen_message_ids.len() > EMAIL_CAPTURE_SEEN_MESSAGE_ID_LIMIT {
        let excess = state.seen_message_ids.len() - EMAIL_CAPTURE_SEEN_MESSAGE_ID_LIMIT;
        state.seen_message_ids.drain(0..excess);
    }
    state
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push('…');
    truncated
}

pub(crate) fn build_email_capture_message(
    uid: u32,
    uid_validity: u32,
    raw: &[u8],
) -> EmailCaptureMessage {
    let parsed = MessageParser::default().parse(raw);
    let (message_id, subject, from, received_at, body_text) = match parsed.as_ref() {
        Some(message) => {
            let message_id = message
                .message_id()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("uid:{uid_validity}:{uid}"));
            let subject = message
                .subject()
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            let from = message
                .from()
                .and_then(|address| address.first())
                .map(|addr| {
                    let name = addr
                        .name
                        .as_deref()
                        .map(str::trim)
                        .unwrap_or_default()
                        .to_string();
                    let email = addr
                        .address
                        .as_deref()
                        .map(str::trim)
                        .unwrap_or_default()
                        .to_string();
                    if name.is_empty() {
                        email
                    } else if email.is_empty() {
                        name
                    } else {
                        format!("{name} <{email}>")
                    }
                })
                .unwrap_or_default();
            let received_at = message.date().map(|value| value.to_rfc3339());
            let body_text = message
                .body_text(0)
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            (message_id, subject, from, received_at, body_text)
        }
        None => (
            format!("uid:{uid_validity}:{uid}"),
            String::new(),
            String::new(),
            None,
            String::new(),
        ),
    };
    EmailCaptureMessage {
        uid,
        message_id,
        subject,
        from,
        received_at,
        body_text: truncate_chars(&body_text, EMAIL_CAPTURE_BODY_CHAR_LIMIT),
    }
}

// Did the text part `build_email_capture_message` read finish inside the bytes we were
// given? A part that closed before the end of the buffer is followed by the next MIME
// boundary, so its recorded end offset is short of the buffer; a part the fetch cut in
// half runs to the very end. No text part at all (it sits behind a big attachment)
// counts as not finished.
fn text_part_ended_before(raw: &[u8]) -> bool {
    MessageParser::default()
        .parse(raw)
        .and_then(|message| {
            let part = message.part(*message.text_body.first()?)?;
            Some((part.offset_end as usize) < raw.len())
        })
        .unwrap_or(false)
}

// A prefix fetch that came back full may have cut the message anywhere. Trust it only
// when the text provably ended before the cut, or when we already hold every character
// capture would keep; otherwise the import would silently lose body text.
fn prefix_fetch_may_have_cut_text(prefix: &[u8], body_text: &str) -> bool {
    prefix.len() >= EMAIL_CAPTURE_FETCH_BYTE_LIMIT
        && body_text.chars().count() < EMAIL_CAPTURE_BODY_CHAR_LIMIT
        && !text_part_ended_before(prefix)
}

// `FnOnce` is the bound: at most one full refetch per UID per poll. A refetch that fails,
// or comes back without a body, is a fetch failure like any other: it aborts the poll, so
// the message is left in the mailbox for the next one. Falling back to the cut prefix here
// would import exactly the empty body the refetch exists to prevent.
fn email_capture_message_from_prefix<F>(
    uid: u32,
    uid_validity: u32,
    prefix: &[u8],
    refetch_full: F,
) -> Result<EmailCaptureMessage, EmailCaptureError>
where
    F: FnOnce(u32) -> Result<Option<Vec<u8>>, EmailCaptureError>,
{
    let message = build_email_capture_message(uid, uid_validity, prefix);
    if !prefix_fetch_may_have_cut_text(prefix, &message.body_text) {
        return Ok(message);
    }
    let full = refetch_full(uid)?.ok_or_else(|| {
        EmailCaptureError::other(format!("Message {uid} was fetched without a body"))
    })?;
    Ok(build_email_capture_message(uid, uid_validity, &full))
}

type EmailSession = imap::Session<TlsStream<TcpStream>>;

fn open_email_session(
    config: &EmailCaptureConfigPayload,
    password: &str,
) -> Result<EmailSession, EmailCaptureError> {
    let addrs: Vec<_> = (config.host.as_str(), config.port)
        .to_socket_addrs()
        .map_err(|error| EmailCaptureError::network(error.to_string()))?
        .collect();
    if addrs.is_empty() {
        return Err(EmailCaptureError::network(format!(
            "Could not resolve {}",
            config.host
        )));
    }
    let mut stream: Option<TcpStream> = None;
    let mut last_error: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, EMAIL_CAPTURE_CONNECT_TIMEOUT) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let stream = stream.ok_or_else(|| {
        EmailCaptureError::network(
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "Connection failed".to_string()),
        )
    })?;
    stream
        .set_read_timeout(Some(EMAIL_CAPTURE_IO_TIMEOUT))
        .map_err(|error| EmailCaptureError::network(error.to_string()))?;
    stream
        .set_write_timeout(Some(EMAIL_CAPTURE_IO_TIMEOUT))
        .map_err(|error| EmailCaptureError::network(error.to_string()))?;

    let connector = TlsConnector::builder()
        .build()
        .map_err(|error| EmailCaptureError::network(error.to_string()))?;
    let tls_stream = connector
        .connect(config.host.as_str(), stream)
        .map_err(|error| EmailCaptureError::network(error.to_string()))?;
    let mut client = imap::Client::new(tls_stream);
    client
        .read_greeting()
        .map_err(|error| classify_imap_error(error, "network"))?;
    client
        .login(config.username.as_str(), password)
        .map_err(|(error, _)| classify_imap_error(error, "auth"))
}

/// Login + folder round-trip used before persisting an enabled config. Creates
/// the capture folder when it does not exist yet, so setup stays one step.
fn verify_email_capture_connection(
    config: &EmailCaptureConfigPayload,
    password: &str,
) -> Result<(), EmailCaptureError> {
    let mut session = open_email_session(config, password)?;
    let examined = session.examine(config.folder.as_str());
    let result = match examined {
        Ok(_) => Ok(()),
        Err(imap::error::Error::No(_)) => session
            .create(config.folder.as_str())
            .and_then(|_| session.examine(config.folder.as_str()).map(|_| ()))
            .map_err(|error| classify_imap_error(error, "folder")),
        Err(error) => Err(classify_imap_error(error, "folder")),
    };
    let _ = session.logout();
    result
}

fn email_capture_status(
    config: &EmailCaptureConfigPayload,
    has_password: bool,
) -> Result<Value, String> {
    let mut status = serde_json::to_value(config).map_err(|e| e.to_string())?;
    if let Some(object) = status.as_object_mut() {
        object.insert("hasPassword".to_string(), Value::Bool(has_password));
    }
    Ok(status)
}

// read_bound_credential holds lock_dropbox_credential_state across its whole
// read (and possible first-binding write) already — safe as-is (B2).
#[tauri::command(async)]
pub(crate) fn get_email_capture_config(app: tauri::AppHandle) -> Result<Value, String> {
    let (config, password) = read_bound_credential(&app, CredentialService::Email)?;
    let payload = read_email_capture_payload(&config);
    email_capture_status(&payload, password.is_some())
}

// Off the UI thread: enabling capture validates the account with a real
// DNS + TCP + TLS + LOGIN round trip, which blocks for the connect timeout
// against an unreachable host.
#[tauri::command(async)]
pub(crate) fn set_email_capture_config(
    app: tauri::AppHandle,
    config: Value,
    password: Option<String>,
) -> Result<Value, EmailCaptureError> {
    // I1: both branches below write config.toml via update_bound_credential,
    // which only holds lock_dropbox_credential_state for its own transaction
    // — an RMW-lock holder's gap could still land here and lose it. Disjoint
    // from lock_email_capture_state (protects the separate IMAP watermark
    // file), so ordering between the two doesn't matter; RMW first to match
    // every other config.toml writer's convention.
    let _config_guard = lock_config_read_modify_write().map_err(EmailCaptureError::other)?;
    let _state_guard = lock_email_capture_state().map_err(EmailCaptureError::other)?;
    let payload = serde_json::from_value::<EmailCaptureConfigPayload>(config)
        .map(normalize_email_capture_payload)
        .map_err(|error| EmailCaptureError::config(format!("Invalid email settings: {error}")))?;

    let (app_config, previous_password) =
        read_bound_credential(&app, CredentialService::Email).map_err(EmailCaptureError::other)?;
    let previous_payload = read_email_capture_payload(&app_config);
    let previous_identity = email_capture_mailbox_identity(&previous_payload);
    let next_identity = email_capture_mailbox_identity(&payload);
    let mailbox_identity_changed = previous_identity != next_identity;
    let mut email_capture_state = read_email_capture_state(&app);
    let next_password = password
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if payload.host.is_empty() {
        // Clearing the host removes the account, matching the WebDAV behavior.
        update_bound_credential(
            &app,
            CredentialService::Email,
            CredentialSecretUpdate::Replace(None),
            |config| config.email_capture_config = None,
        )
        .map_err(EmailCaptureError::other)?;
        let _ = fs::remove_file(email_capture_state_path(&app));
        return email_capture_status(&EmailCaptureConfigPayload::default(), false)
            .map_err(EmailCaptureError::other);
    }

    let effective_password = next_password.clone().or(previous_password);

    let mut payload = payload;
    let mut validation_error: Option<EmailCaptureError> = None;
    if payload.enabled {
        let Some(ref current_password) = effective_password else {
            return Err(EmailCaptureError::config(
                "An app password is required to enable email capture.",
            ));
        };
        // Never persist an enabled capture config before one successful
        // login + folder round-trip.
        if let Err(error) = verify_email_capture_connection(&payload, current_password) {
            payload.enabled = false;
            validation_error = Some(error);
        }
    }

    let serialized_payload = serde_json::to_string(&payload)
        .map_err(|error| EmailCaptureError::other(error.to_string()))?;
    let secret_update = next_password
        .clone()
        .map(|password| CredentialSecretUpdate::Replace(Some(password)))
        .unwrap_or(CredentialSecretUpdate::Keep);
    let persisted =
        update_bound_credential(&app, CredentialService::Email, secret_update, |config| {
            config.email_capture_config = Some(serialized_payload)
        })
        .map_err(EmailCaptureError::other)?;
    if persisted.email_capture_password.is_some() && next_password.is_some() {
        emit_keyring_fallback_warning(&app, "Email app password");
    }

    if let Some(error) = validation_error {
        // A failed connection check is persisted disabled so the form keeps the
        // attempted values. Keep ownership of the old watermark explicit: a
        // successful retry can then tell that the configured mailbox changed.
        if mailbox_identity_changed && email_capture_state.mailbox_identity.is_none() {
            email_capture_state.mailbox_identity = Some(previous_identity);
            write_email_capture_state(&app, &email_capture_state)
                .map_err(EmailCaptureError::other)?;
        }
        return Err(error);
    }
    let state_owner_changed = email_capture_state
        .mailbox_identity
        .as_ref()
        .is_some_and(|stored| stored != &next_identity);
    if mailbox_identity_changed || state_owner_changed {
        email_capture_state = EmailCaptureState::default();
    }
    // Scope the UID watermark to the normalized host/account/folder only after
    // the new configuration has passed validation and been persisted. Merely
    // toggling capture or changing its password keeps the existing watermark.
    email_capture_state.mailbox_identity = Some(next_identity);
    write_email_capture_state(&app, &email_capture_state).map_err(EmailCaptureError::other)?;
    let has_password = effective_password.is_some();
    email_capture_status(&payload, has_password).map_err(EmailCaptureError::other)
}

// Off the UI thread: this opens an IMAP session (DNS + TCP + TLS + LOGIN) and
// then EXAMINE + FETCH on a five-minute timer, up to ten rounds back to back.
// A plain `#[tauri::command]` runs that on the main thread and freezes the
// window for the whole round trip — and until the socket times out when the
// host is unreachable.
#[tauri::command(async)]
pub(crate) fn email_capture_poll(
    app: tauri::AppHandle,
) -> Result<EmailCapturePollResult, EmailCaptureError> {
    let (app_config, password) =
        read_bound_credential(&app, CredentialService::Email).map_err(EmailCaptureError::other)?;
    let payload = read_email_capture_payload(&app_config);
    if !payload.enabled {
        return Err(EmailCaptureError::config("Email capture is disabled."));
    }
    let password = password.ok_or_else(|| EmailCaptureError::auth("No app password is stored."))?;
    let state = scope_email_capture_state(
        read_email_capture_state(&app),
        &email_capture_mailbox_identity(&payload),
    );

    let mut session = open_email_session(&payload, &password)?;
    let result = poll_mailbox(&mut session, &payload, &state);
    let _ = session.logout();
    result
}

fn poll_mailbox(
    session: &mut EmailSession,
    payload: &EmailCaptureConfigPayload,
    state: &EmailCaptureState,
) -> Result<EmailCapturePollResult, EmailCaptureError> {
    // EXAMINE opens the folder read-only, so polling can never mutate flags
    // or move the user's mail.
    let mailbox = session
        .examine(payload.folder.as_str())
        .map_err(|error| classify_imap_error(error, "folder"))?;
    let uid_validity = mailbox.uid_validity.unwrap_or(0);

    let query = if state.uid_validity == Some(uid_validity) && state.last_seen_uid > 0 {
        format!("UID {}:*", state.last_seen_uid.saturating_add(1))
    } else {
        "ALL".to_string()
    };
    let candidates = session
        .uid_search(&query)
        .map_err(|error| classify_imap_error(error, "other"))?;
    let (uids, has_more) =
        select_new_uids(candidates, state, uid_validity, EMAIL_CAPTURE_BATCH_LIMIT);

    let mut messages = Vec::new();
    let mut max_fetched_uid = 0;
    if !uids.is_empty() {
        let set = uids
            .iter()
            .map(|uid| uid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(set, EMAIL_CAPTURE_FETCH_QUERY)
            .map_err(|error| classify_imap_error(error, "other"))?;
        for fetch in fetches.iter() {
            let Some(uid) = fetch.uid else { continue };
            max_fetched_uid = max_fetched_uid.max(uid);
            let Some(raw) = fetch.body() else { continue };
            let message = email_capture_message_from_prefix(uid, uid_validity, raw, |uid| {
                let refetched = session
                    .uid_fetch(uid.to_string(), EMAIL_CAPTURE_FULL_FETCH_QUERY)
                    .map_err(|error| classify_imap_error(error, "other"))?;
                Ok(refetched
                    .iter()
                    .find(|fetch| fetch.uid == Some(uid))
                    .and_then(|fetch| fetch.body())
                    .map(|body| body.to_vec()))
            })?;
            if state.seen_message_ids.contains(&message.message_id) {
                continue;
            }
            messages.push(message);
        }
        messages.sort_by_key(|message| message.uid);
    }

    Ok(EmailCapturePollResult {
        uid_validity,
        messages,
        max_fetched_uid,
        has_more,
    })
}

// Off the UI thread for the same reason as `email_capture_poll`; the state
// lock keeps its read-modify-write atomic against a concurrent settings save.
#[tauri::command(async)]
pub(crate) fn email_capture_commit(
    app: tauri::AppHandle,
    uid_validity: u32,
    last_seen_uid: u32,
    message_ids: Vec<String>,
) -> Result<(), String> {
    let _state_guard = lock_email_capture_state()?;
    let (app_config, _) = read_bound_credential(&app, CredentialService::Email)?;
    let payload = read_email_capture_payload(&app_config);
    let state = scope_email_capture_state(
        read_email_capture_state(&app),
        &email_capture_mailbox_identity(&payload),
    );
    let next = merge_email_capture_state(state, uid_validity, last_seen_uid, message_ids);
    write_email_capture_state(&app, &next)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises the real DNS + TCP + TLS + greeting + LOGIN stack against a
    // public server. Ignored by default because it needs network access:
    // `cargo test --lib email_capture -- --ignored`
    #[test]
    #[ignore = "hits the public network"]
    fn live_imap_login_failure_classifies_as_auth() {
        let config = EmailCaptureConfigPayload {
            enabled: true,
            host: "imap.gmail.com".to_string(),
            port: 993,
            username: "mindwtr-smoke-test@gmail.com".to_string(),
            folder: default_email_capture_folder(),
        };
        let error = open_email_session(&config, "not-a-real-password")
            .err()
            .expect("login with bogus credentials must fail");
        assert_eq!(error.kind, "auth", "unexpected error: {error:?}");
    }

    fn state(uid_validity: Option<u32>, last_seen_uid: u32, ids: &[&str]) -> EmailCaptureState {
        EmailCaptureState {
            mailbox_identity: None,
            uid_validity,
            last_seen_uid,
            seen_message_ids: ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn normalize_defaults_port_and_folder_and_requires_host_for_enabled() {
        let normalized = normalize_email_capture_payload(EmailCaptureConfigPayload {
            enabled: true,
            host: "  imap.example.com  ".to_string(),
            port: 0,
            username: " user@example.com ".to_string(),
            folder: "   ".to_string(),
        });
        assert!(normalized.enabled);
        assert_eq!(normalized.host, "imap.example.com");
        assert_eq!(normalized.port, EMAIL_CAPTURE_DEFAULT_PORT);
        assert_eq!(normalized.username, "user@example.com");
        assert_eq!(normalized.folder, EMAIL_CAPTURE_DEFAULT_FOLDER);

        let disabled = normalize_email_capture_payload(EmailCaptureConfigPayload {
            enabled: true,
            host: String::new(),
            port: 993,
            username: "user".to_string(),
            folder: "Mindwtr".to_string(),
        });
        assert!(!disabled.enabled);
    }

    #[test]
    fn mailbox_identity_ignores_enablement_and_host_case() {
        let base = normalize_email_capture_payload(EmailCaptureConfigPayload {
            enabled: true,
            host: "IMAP.Example.com".to_string(),
            port: 993,
            username: "user@example.com".to_string(),
            folder: "Mindwtr".to_string(),
        });
        let same_mailbox = normalize_email_capture_payload(EmailCaptureConfigPayload {
            enabled: false,
            host: "imap.example.com".to_string(),
            ..base.clone()
        });

        assert_eq!(
            email_capture_mailbox_identity(&base),
            email_capture_mailbox_identity(&same_mailbox)
        );
    }

    #[test]
    fn mailbox_identity_changes_for_account_port_or_folder() {
        let base = normalize_email_capture_payload(EmailCaptureConfigPayload {
            enabled: true,
            host: "imap.example.com".to_string(),
            port: 993,
            username: "first@example.com".to_string(),
            folder: "Mindwtr".to_string(),
        });
        for changed in [
            EmailCaptureConfigPayload {
                host: "imap.other.example".to_string(),
                ..base.clone()
            },
            EmailCaptureConfigPayload {
                port: 1993,
                ..base.clone()
            },
            EmailCaptureConfigPayload {
                username: "second@example.com".to_string(),
                ..base.clone()
            },
            EmailCaptureConfigPayload {
                folder: "Other".to_string(),
                ..base.clone()
            },
        ] {
            assert_ne!(
                email_capture_mailbox_identity(&base),
                email_capture_mailbox_identity(&changed)
            );
        }
    }

    #[test]
    fn mailbox_scope_preserves_watermark_only_for_the_same_identity() {
        let first = EmailCaptureMailboxIdentity {
            host: "imap.example.com".to_string(),
            port: 993,
            username: "first@example.com".to_string(),
            folder: "Mindwtr".to_string(),
        };
        let second = EmailCaptureMailboxIdentity {
            username: "second@example.com".to_string(),
            ..first.clone()
        };
        let owned = scope_email_capture_state(state(Some(7), 42, &["message-id"]), &first);

        let unchanged = scope_email_capture_state(owned.clone(), &first);
        assert_eq!(unchanged.uid_validity, Some(7));
        assert_eq!(unchanged.last_seen_uid, 42);
        assert_eq!(unchanged.seen_message_ids, vec!["message-id"]);

        let reset = scope_email_capture_state(owned, &second);
        assert_eq!(reset.mailbox_identity, Some(second));
        assert_eq!(reset.uid_validity, None);
        assert_eq!(reset.last_seen_uid, 0);
        assert!(reset.seen_message_ids.is_empty());
    }

    #[test]
    fn select_new_uids_filters_by_watermark_within_same_generation() {
        let state = state(Some(7), 40, &[]);
        let (uids, has_more) = select_new_uids(vec![41, 39, 40, 45, 42], &state, 7, 25);
        assert_eq!(uids, vec![41, 42, 45]);
        assert!(!has_more);
    }

    #[test]
    fn select_new_uids_rescans_on_uidvalidity_change() {
        let state = state(Some(7), 40, &[]);
        let (uids, has_more) = select_new_uids(vec![10, 2], &state, 8, 25);
        assert_eq!(uids, vec![2, 10]);
        assert!(!has_more);
    }

    #[test]
    fn select_new_uids_caps_batch_and_reports_more() {
        let state = state(None, 0, &[]);
        let (uids, has_more) = select_new_uids(1..=30, &state, 5, 3);
        assert_eq!(uids, vec![1, 2, 3]);
        assert!(has_more);
    }

    #[test]
    fn merge_state_advances_watermark_only_forward() {
        let merged =
            merge_email_capture_state(state(Some(5), 90, &["a"]), 5, 42, vec!["b".to_string()]);
        assert_eq!(merged.last_seen_uid, 90);
        assert_eq!(merged.seen_message_ids, vec!["a", "b"]);
    }

    #[test]
    fn merge_state_resets_watermark_on_new_generation() {
        let merged = merge_email_capture_state(state(Some(5), 90, &["a"]), 6, 3, vec![]);
        assert_eq!(merged.uid_validity, Some(6));
        assert_eq!(merged.last_seen_uid, 3);
        assert_eq!(merged.seen_message_ids, vec!["a"]);
    }

    #[test]
    fn merge_state_caps_seen_message_ids() {
        let existing: Vec<String> = (0..EMAIL_CAPTURE_SEEN_MESSAGE_ID_LIMIT)
            .map(|index| format!("id-{index}"))
            .collect();
        let merged = merge_email_capture_state(
            EmailCaptureState {
                mailbox_identity: None,
                uid_validity: Some(1),
                last_seen_uid: 10,
                seen_message_ids: existing,
            },
            1,
            11,
            vec!["fresh".to_string(), "fresh".to_string()],
        );
        assert_eq!(
            merged.seen_message_ids.len(),
            EMAIL_CAPTURE_SEEN_MESSAGE_ID_LIMIT
        );
        assert_eq!(
            merged.seen_message_ids.first().map(String::as_str),
            Some("id-1")
        );
        assert_eq!(
            merged.seen_message_ids.last().map(String::as_str),
            Some("fresh")
        );
    }

    #[test]
    fn build_message_extracts_subject_from_and_text_body() {
        let raw = concat!(
            "Message-ID: <abc-123@example.com>\r\n",
            "From: Jane Doe <jane@example.com>\r\n",
            "To: capture@example.com\r\n",
            "Subject: =?utf-8?q?Renew_passport?=\r\n",
            "Date: Tue, 14 Jul 2026 08:30:00 +0000\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "Bring the old passport and two photos.\r\n",
        );
        let message = build_email_capture_message(12, 7, raw.as_bytes());
        assert_eq!(message.uid, 12);
        assert_eq!(message.message_id, "abc-123@example.com");
        assert_eq!(message.subject, "Renew passport");
        assert_eq!(message.from, "Jane Doe <jane@example.com>");
        assert_eq!(message.body_text, "Bring the old passport and two photos.");
        assert!(message.received_at.is_some());
    }

    // Japanese mail clients still send ISO-2022-JP and Shift_JIS; mail-parser decodes
    // them only with its full_encoding feature (#1466).
    #[test]
    fn build_message_decodes_japanese_legacy_charsets() {
        let iso_2022_jp = concat!(
            "Subject: =?ISO-2022-JP?B?GyRCMnE1RCROO3FOQRsoQg==?=\r\n",
            "Content-Type: text/plain; charset=ISO-2022-JP\r\n",
            "Content-Transfer-Encoding: 7bit\r\n",
            "\r\n",
            "\x1b$BL@F|$^$G$KAw$k\x1b(B\r\n",
        );
        let message = build_email_capture_message(1, 7, iso_2022_jp.as_bytes());
        assert_eq!(message.subject, "会議の資料");
        assert_eq!(message.body_text, "明日までに送る");

        let shift_jis = concat!(
            "Subject: =?Shift_JIS?B?ie+LY4LMjpGXvw==?=\r\n",
            "Content-Type: text/plain; charset=Shift_JIS\r\n",
            "Content-Transfer-Encoding: base64\r\n",
            "\r\n",
            "lr6T+oLcgsWCyZGXguk=\r\n",
        );
        let message = build_email_capture_message(2, 7, shift_jis.as_bytes());
        assert_eq!(message.subject, "会議の資料");
        assert_eq!(message.body_text, "明日までに送る");
    }

    #[test]
    fn build_message_converts_html_only_mail_to_text() {
        let raw = concat!(
            "From: sender@example.com\r\n",
            "Subject: Weekly report\r\n",
            "Content-Type: text/html; charset=utf-8\r\n",
            "\r\n",
            "<html><body><p>Numbers are <b>up</b>.</p></body></html>\r\n",
        );
        let message = build_email_capture_message(3, 7, raw.as_bytes());
        assert_eq!(message.subject, "Weekly report");
        assert!(message.body_text.contains("Numbers are up"));
        assert!(!message.body_text.contains('<'));
        // No Message-ID header: falls back to a UID-scoped synthetic id.
        assert_eq!(message.message_id, "uid:7:3");
    }

    #[test]
    fn fetch_query_asks_for_a_bounded_part_of_each_message() {
        assert_eq!(EMAIL_CAPTURE_FETCH_QUERY, "(UID BODY.PEEK[]<0.262144>)");
        assert_eq!(EMAIL_CAPTURE_FETCH_BYTE_LIMIT, 262_144);
        assert_eq!(EMAIL_CAPTURE_FULL_FETCH_QUERY, "(UID BODY.PEEK[])");
    }

    fn text_part(body: &str) -> String {
        format!("--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n")
    }

    fn attachment_part(base64_chars: usize) -> String {
        format!(
            "--b1\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\n{}\r\n",
            "QUJD".repeat(base64_chars / 4)
        )
    }

    fn multipart_mail(first: &str, second: &str) -> String {
        format!(
            "Message-ID: <report-9@example.com>\r\n\
             From: Reports <reports@example.com>\r\n\
             Subject: Report\r\n\
             Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
             \r\n\
             {first}{second}--b1--\r\n"
        )
    }

    /// Runs the prefix-fetch path over `raw` the way `poll_mailbox` does: the first
    /// EMAIL_CAPTURE_FETCH_BYTE_LIMIT bytes are what the server returned. Reports which
    /// UIDs the code asked to refetch in full.
    fn message_from_prefix(raw: &str) -> (EmailCaptureMessage, Vec<u32>) {
        let cut = raw.len().min(EMAIL_CAPTURE_FETCH_BYTE_LIMIT);
        let mut refetched = Vec::new();
        let message = email_capture_message_from_prefix(9, 7, &raw.as_bytes()[..cut], |uid| {
            refetched.push(uid);
            Ok(Some(raw.as_bytes().to_vec()))
        })
        .expect("build message from prefix");
        (message, refetched)
    }

    #[test]
    fn prefix_fetch_keeps_a_message_that_fits_in_the_window() {
        let raw = concat!(
            "Message-ID: <abc-123@example.com>\r\n",
            "From: Jane Doe <jane@example.com>\r\n",
            "Subject: Renew passport\r\n",
            "Content-Type: text/plain; charset=utf-8\r\n",
            "\r\n",
            "Bring the old passport and two photos.\r\n",
        );
        assert!(raw.len() < EMAIL_CAPTURE_FETCH_BYTE_LIMIT);

        let (message, refetched) = message_from_prefix(raw);

        assert_eq!(message.body_text, "Bring the old passport and two photos.");
        assert!(
            refetched.is_empty(),
            "a message under the window must never be refetched"
        );
    }

    #[test]
    fn prefix_fetch_keeps_text_that_ended_before_the_cut() {
        let raw = multipart_mail(
            &text_part("See the attached report."),
            &attachment_part(400_000),
        );
        assert!(raw.len() > EMAIL_CAPTURE_FETCH_BYTE_LIMIT);

        let (message, refetched) = message_from_prefix(&raw);

        assert_eq!(message.subject, "Report");
        assert_eq!(message.from, "Reports <reports@example.com>");
        assert_eq!(message.message_id, "report-9@example.com");
        assert_eq!(message.body_text, "See the attached report.");
        assert!(
            refetched.is_empty(),
            "the text part closed inside the fetched bytes, so no refetch is needed"
        );
    }

    #[test]
    fn prefix_fetch_refetches_text_that_starts_after_a_large_attachment() {
        let raw = multipart_mail(
            &attachment_part(400_000),
            &text_part("See the attached report."),
        );
        assert!(raw.len() > EMAIL_CAPTURE_FETCH_BYTE_LIMIT);

        let (message, refetched) = message_from_prefix(&raw);

        assert_eq!(message.subject, "Report");
        assert_eq!(message.body_text, "See the attached report.");
        assert_eq!(refetched, vec![9], "exactly one full refetch of that UID");
    }

    #[test]
    fn prefix_fetch_refetches_text_cut_in_the_middle() {
        let body = "b".repeat(20_000);
        let raw = multipart_mail(&attachment_part(256_000), &text_part(&body));
        assert!(raw.len() > EMAIL_CAPTURE_FETCH_BYTE_LIMIT);

        let (message, refetched) = message_from_prefix(&raw);

        assert_eq!(refetched, vec![9], "exactly one full refetch of that UID");
        assert_eq!(
            message.body_text.chars().count(),
            EMAIL_CAPTURE_BODY_CHAR_LIMIT + 1
        );
        assert!(message.body_text.starts_with("bbb"));
        assert!(message.body_text.ends_with('…'));
    }

    // A long plain-text mail is cut by the fetch too, but capture keeps only the first
    // 16 000 characters, and the prefix already holds them. Refetching it would undo the
    // whole point of the partial fetch.
    #[test]
    fn prefix_fetch_keeps_text_that_already_reached_the_kept_character_cap() {
        let raw = format!(
            "Message-ID: <long-1@example.com>\r\n\
             From: Reports <reports@example.com>\r\n\
             Subject: Report\r\n\
             Content-Type: text/plain; charset=utf-8\r\n\
             \r\n\
             {}",
            "c".repeat(300_000)
        );
        assert!(raw.len() > EMAIL_CAPTURE_FETCH_BYTE_LIMIT);

        let (message, refetched) = message_from_prefix(&raw);

        assert_eq!(
            message.body_text.chars().count(),
            EMAIL_CAPTURE_BODY_CHAR_LIMIT + 1
        );
        assert!(
            refetched.is_empty(),
            "nothing past the kept-character cap would be stored, so no refetch"
        );
    }

    #[test]
    fn prefix_fetch_reports_a_refetch_reply_without_a_body_like_a_failed_fetch() {
        let raw = multipart_mail(
            &attachment_part(400_000),
            &text_part("See the attached report."),
        );

        let error = email_capture_message_from_prefix(
            9,
            7,
            &raw.as_bytes()[..EMAIL_CAPTURE_FETCH_BYTE_LIMIT],
            |_| Ok(None),
        )
        .expect_err("a refetch reply without a body must not fall back to the cut prefix");

        assert_eq!(error.kind, "other");
        assert!(
            error.message.contains('9'),
            "the error should name the message: {}",
            error.message
        );
    }

    #[test]
    fn prefix_fetch_reports_a_failed_refetch_like_any_other_fetch_failure() {
        let raw = multipart_mail(
            &attachment_part(400_000),
            &text_part("See the attached report."),
        );

        let error = email_capture_message_from_prefix(
            9,
            7,
            &raw.as_bytes()[..EMAIL_CAPTURE_FETCH_BYTE_LIMIT],
            |_| Err(EmailCaptureError::network("Connection lost")),
        )
        .expect_err("a failed refetch must surface as a poll error");

        assert_eq!(error.kind, "network");
        assert_eq!(error.message, "Connection lost");
    }

    #[test]
    fn build_message_truncates_very_long_bodies() {
        let body = "x".repeat(EMAIL_CAPTURE_BODY_CHAR_LIMIT + 100);
        let raw = format!(
            "From: a@example.com\r\nSubject: Long\r\nContent-Type: text/plain\r\n\r\n{body}"
        );
        let message = build_email_capture_message(1, 1, raw.as_bytes());
        assert_eq!(
            message.body_text.chars().count(),
            EMAIL_CAPTURE_BODY_CHAR_LIMIT + 1
        );
        assert!(message.body_text.ends_with('…'));
    }
}
