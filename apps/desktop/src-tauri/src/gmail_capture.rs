//! Desktop prototype. Credentials stay in the OS vault; receipts are private device state.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN: &str = "https://oauth2.googleapis.com/token";
const REVOKE: &str = "https://oauth2.googleapis.com/revoke";
const RESPONSE_LIMIT: u64 = 2 * 1024 * 1024;
const CALLBACK_PATH: &str = "/oauth2/callback";
const RECEIPTS_SCHEMA: &str = "CREATE TABLE receipts(account TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(account,message))";
const CONTROL_SCHEMA: &str =
    "CREATE TABLE control(id INTEGER PRIMARY KEY CHECK(id=1), blocked INTEGER NOT NULL)";

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct GmailError {
    kind: &'static str,
    message: &'static str,
}
type Result<T> = std::result::Result<T, GmailError>;
fn error(kind: &'static str) -> GmailError {
    GmailError {
        kind,
        message: match kind {
            "auth" => "Gmail authorization expired or was denied. Reconnect Gmail.",
            "network" => "Gmail could not be reached. Try again later.",
            "config" => "Choose an existing Gmail label before starting capture.",
            "cancelled" => "Gmail connection was cancelled.",
            "storage" => "Secure Gmail storage is unavailable. Capture is stopped.",
            _ => "Gmail returned an unsupported or oversized response. No messages were acknowledged.",
        },
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GmailStatus {
    available: bool,
    connected: bool,
    account: Option<String>,
    account_id: Option<String>,
    label_id: Option<String>,
    enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct GmailLabel {
    id: String,
    name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GmailMessage {
    id: String,
    subject: String,
    from: String,
    body_text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GmailBatch {
    batch_id: String,
    account_id: String,
    messages: Vec<GmailMessage>,
    has_more: bool,
}
#[derive(Serialize)]
pub(crate) struct GmailDisconnect {
    revoked: bool,
}
#[derive(Clone, Deserialize, Serialize)]
struct Credentials {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    account: String,
    account_id: String,
    label_id: Option<String>,
    enabled: bool,
}
#[derive(Clone, Deserialize)]
struct OAuthClient {
    client_id: String,
    #[serde(default)]
    client_secret: String,
}
fn client_config() -> Option<OAuthClient> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("MINDWTR_GMAIL_OAUTH_CLIENT_FILE") {
        #[derive(Deserialize)]
        struct Installed {
            installed: OAuthClient,
        }
        let file = fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 64 * 1024 {
            return None;
        }
        let config: Installed = serde_json::from_slice(&bytes).ok()?;
        return (!config.installed.client_id.trim().is_empty()).then_some(config.installed);
    }
    if !cfg!(debug_assertions) && option_env!("MINDWTR_GMAIL_PRODUCTION_VERIFIED") != Some("1") {
        return None;
    }
    let client_id = option_env!("MINDWTR_GMAIL_CLIENT_ID")?.to_owned();
    (!client_id.trim().is_empty()).then(|| OAuthClient {
        client_id,
        client_secret: option_env!("MINDWTR_GMAIL_CLIENT_SECRET")
            .unwrap_or_default()
            .to_owned(),
    })
}

trait Vault: Send + Sync {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, value: Option<String>) -> Result<()>;
}
struct SystemVault {
    app: tauri::AppHandle,
    name: String,
}
impl Vault for SystemVault {
    fn get(&self) -> Result<Option<String>> {
        // The shared getter treats portable storage as absent; Gmail must fail closed.
        if crate::storage::is_portable_mode() {
            return Err(error("storage"));
        }
        crate::config::get_keyring_secret(&self.app, &self.name).map_err(|_| error("storage"))
    }
    fn set(&self, value: Option<String>) -> Result<()> {
        crate::config::set_keyring_secret(&self.app, &self.name, value.clone())
            .map_err(|_| error("storage"))?;
        if self.get()? != value {
            return Err(error("storage"));
        }
        Ok(())
    }
}

struct Request {
    url: reqwest::Url,
    token: Option<String>,
    form: Option<Vec<(String, String)>>,
}
trait Transport: Send + Sync {
    fn send(&self, request: Request) -> Result<Vec<u8>>;
}
struct GoogleTransport(reqwest::blocking::Client);
impl Transport for GoogleTransport {
    fn send(&self, request: Request) -> Result<Vec<u8>> {
        let is_api = request.url.as_str().starts_with(&format!("{API}/"));
        let is_oauth = request.url.as_str() == TOKEN || request.url.as_str() == REVOKE;
        if request.url.scheme() != "https"
            || (!is_api && !is_oauth)
            || (is_api && request.form.is_some())
            || (is_oauth && request.form.is_none())
        {
            return Err(error("other"));
        }
        let mut builder = if let Some(form) = request.form {
            self.0.post(request.url).form(&form)
        } else {
            self.0.get(request.url)
        };
        if let Some(token) = request.token {
            builder = builder.bearer_auth(token);
        }
        let response = builder.send().map_err(|_| error("network"))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
            || (is_oauth && status == reqwest::StatusCode::BAD_REQUEST)
        {
            return Err(error("auth"));
        }
        if !status.is_success() {
            return Err(error(
                if status.is_server_error() || status.as_u16() == 429 {
                    "network"
                } else {
                    "other"
                },
            ));
        }
        let length = response.content_length();
        read_response(response, length)
    }
}
fn read_response(response: impl Read, length: Option<u64>) -> Result<Vec<u8>> {
    if length.is_some_and(|n| n > RESPONSE_LIMIT) {
        return Err(error("other"));
    }
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("network"))?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return Err(error("other"));
    }
    Ok(bytes)
}

#[derive(Default)]
struct Runtime {
    generation: u64,
    credentials: Option<Credentials>,
    blocked: bool,
    auth_failed: bool,
    refreshing: bool,
    revoking: bool,
    polling: bool,
    page: Option<String>,
    batch: Option<PendingBatch>,
}
#[derive(Clone)]
struct PendingBatch {
    generation: u64,
    label: String,
    next_page: Option<String>,
    response: GmailBatch,
}
impl Runtime {
    fn invalidate(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.page = None;
        self.batch = None;
        self.polling = false;
        self.refreshing = false;
        self.generation
    }
}
struct Context {
    state: Mutex<Runtime>,
    vault: Arc<dyn Vault>,
    http: Arc<dyn Transport>,
    client: Option<OAuthClient>,
    receipts: PathBuf,
}
fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
fn random_secret() -> String {
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn receipts(path: &Path) -> Result<Connection> {
    let parent = path.parent().ok_or_else(|| error("storage"))?;
    fs::create_dir_all(parent).map_err(|_| error("storage"))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let created = match options.open(path) {
        Ok(file) => {
            file.sync_all().map_err(|_| error("storage"))?;
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(error("storage")),
    };
    if !created && fs::metadata(path).map_err(|_| error("storage"))?.len() < 100 {
        return Err(error("storage"));
    }
    let mut connection =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| error("storage"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| error("storage"))?;
    connection
        .execute_batch("PRAGMA synchronous=FULL;")
        .map_err(|_| error("storage"))?;
    if created {
        let transaction = connection.transaction().map_err(|_| error("storage"))?;
        transaction
            .execute_batch(&format!(
                "{RECEIPTS_SCHEMA};{CONTROL_SCHEMA};INSERT INTO control(id,blocked) VALUES(1,0);"
            ))
            .map_err(|_| error("storage"))?;
        transaction.commit().map_err(|_| error("storage"))?;
    }
    // An existing receipt file is evidence, even if damaged; never recreate its history.
    for (table, expected) in [("receipts", RECEIPTS_SCHEMA), ("control", CONTROL_SCHEMA)] {
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| error("storage"))?;
        if actual != expected {
            return Err(error("storage"));
        }
    }
    let valid_control: bool = connection.query_row(
        "SELECT COUNT(*)=1 AND COUNT(CASE WHEN id=1 AND typeof(blocked)='integer' AND blocked IN(0,1) THEN 1 END)=1 FROM control",
        [], |row| row.get(0),
    ).map_err(|_| error("storage"))?;
    if !valid_control {
        return Err(error("storage"));
    }
    Ok(connection)
}
impl Context {
    fn lock(&self) -> Result<MutexGuard<'_, Runtime>> {
        self.state.lock().map_err(|_| error("storage"))
    }
    fn current<'a>(&'a self, state: &'a mut Runtime, generation: u64) -> Result<&'a mut Runtime> {
        if state.generation != generation {
            return Err(error("cancelled"));
        }
        Ok(state)
    }
    fn check(&self, generation: u64) -> Result<()> {
        let mut state = self.lock()?;
        self.current(&mut state, generation).map(|_| ())
    }
    fn set_blocked(&self, state: &mut Runtime, blocked: bool) -> Result<()> {
        // Runtime stops first even if durable storage is unavailable.
        if blocked {
            state.blocked = true;
        }
        receipts(&self.receipts)?
            .execute("UPDATE control SET blocked=? WHERE id=1", [blocked])
            .map_err(|_| error("storage"))?;
        state.blocked = blocked;
        Ok(())
    }
    fn persist(&self, credentials: &Credentials) -> Result<()> {
        self.vault.set(Some(
            serde_json::to_string(credentials).map_err(|_| error("storage"))?,
        ))
    }
    fn status(&self) -> Result<GmailStatus> {
        let state = self.lock()?;
        let connected = self.client.is_some()
            && state.credentials.is_some()
            && !state.blocked
            && !state.auth_failed;
        let credentials = state.credentials.as_ref().filter(|_| connected);
        Ok(GmailStatus {
            available: self.client.is_some(),
            connected,
            account: credentials.map(|c| c.account.clone()),
            account_id: credentials.map(|c| c.account_id.clone()),
            label_id: credentials.and_then(|c| c.label_id.clone()),
            enabled: credentials.is_some_and(|c| c.enabled),
        })
    }
    fn auth_error(&self, generation: u64, failure: GmailError) -> GmailError {
        if failure.kind == "auth" {
            if let Ok(mut state) = self.lock() {
                if state.generation == generation {
                    state.auth_failed = true;
                    state.invalidate();
                    let _ = self.set_blocked(&mut state, true);
                }
            }
        }
        failure
    }
    fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &[&str],
        query: &[(&str, &str)],
        token: &str,
    ) -> Result<T> {
        let mut url = reqwest::Url::parse(API).map_err(|_| error("other"))?;
        url.path_segments_mut()
            .map_err(|_| error("other"))?
            .extend(path);
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let bytes = self.http.send(Request {
            url,
            token: Some(token.to_owned()),
            form: None,
        })?;
        serde_json::from_slice(&bytes).map_err(|_| error("other"))
    }
    fn oauth(&self, url: &str, form: Vec<(String, String)>) -> Result<Vec<u8>> {
        self.http.send(Request {
            url: reqwest::Url::parse(url).map_err(|_| error("other"))?,
            token: None,
            form: Some(form),
        })
    }
    fn profile(&self, token: &str) -> Result<(String, String)> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Profile {
            email_address: String,
        }
        let profile: Profile = self.get(&["profile"], &[], token)?;
        let account = profile.email_address.trim().to_ascii_lowercase();
        if account.len() > 320 || !account.contains('@') || account.chars().any(char::is_control) {
            return Err(error("other"));
        }
        Ok((account.clone(), digest(&account)))
    }
    fn access(&self, generation: u64) -> Result<String> {
        let credentials = {
            let mut state = self.lock()?;
            let state = self.current(&mut state, generation)?;
            if state.blocked || state.auth_failed || self.client.is_none() {
                return Err(error("auth"));
            }
            let credentials = state.credentials.clone().ok_or_else(|| error("auth"))?;
            if credentials.expires_at > now() + 60 {
                return Ok(credentials.access_token);
            }
            if state.refreshing {
                return Err(error("network"));
            }
            state.refreshing = true;
            credentials
        };
        let result = (|| {
            let client = self.client.as_ref().ok_or_else(|| error("config"))?;
            let bytes = self.oauth(
                TOKEN,
                vec![
                    ("grant_type".into(), "refresh_token".into()),
                    ("refresh_token".into(), credentials.refresh_token.clone()),
                    ("client_id".into(), client.client_id.clone()),
                    ("client_secret".into(), client.client_secret.clone()),
                ],
            )?;
            let token: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| error("auth"))?;
            token.validate(false)?;
            self.check(generation)?;
            let (account, account_id) = self.profile(&token.access_token)?;
            if account != credentials.account || account_id != credentials.account_id {
                return Err(error("auth"));
            }
            let mut state = self.lock()?;
            let state = self.current(&mut state, generation)?;
            let mut updated = state.credentials.clone().ok_or_else(|| error("auth"))?;
            updated.access_token = token.access_token.clone();
            updated.expires_at = now().saturating_add(token.expires_in.min(86_400));
            if let Some(refresh) = token.refresh_token.filter(|s| !s.is_empty()) {
                updated.refresh_token = refresh;
            }
            self.persist(&updated)?;
            state.credentials = Some(updated);
            Ok(token.access_token)
        })();
        if let Ok(mut state) = self.lock() {
            if state.generation == generation {
                state.refreshing = false;
            }
        }
        result.map_err(|e| self.auth_error(generation, e))
    }
    fn labels(&self) -> Result<Vec<GmailLabel>> {
        #[derive(Deserialize)]
        struct Labels {
            #[serde(default)]
            labels: Vec<GmailLabel>,
        }
        let generation = self.lock()?.generation;
        let token = self.access(generation)?;
        let response: Labels = self
            .get(&["labels"], &[], &token)
            .map_err(|e| self.auth_error(generation, e))?;
        self.check(generation)?;
        if response
            .labels
            .iter()
            .any(|l| !valid_id(&l.id) || l.name.len() > 4096)
        {
            return Err(error("other"));
        }
        Ok(response.labels)
    }
    fn configure(&self, label_id: String, enabled: bool) -> Result<GmailStatus> {
        let generation = {
            let mut state = self.lock()?;
            let generation = state.invalidate();
            self.set_blocked(&mut state, true)?;
            let mut credentials = state.credentials.clone().ok_or_else(|| error("auth"))?;
            credentials.enabled = false;
            self.persist(&credentials)?;
            state.credentials = Some(credentials);
            // A disabled configuration can still verify the selected label.
            self.set_blocked(&mut state, false)?;
            generation
        };
        if !valid_id(&label_id) {
            return Err(error("config"));
        }
        let token = self.access(generation)?;
        let label: GmailLabel = self
            .get(&["labels", &label_id], &[], &token)
            .map_err(|e| self.auth_error(generation, e))?;
        if label.id != label_id {
            return Err(error("config"));
        }
        {
            let mut state = self.lock()?;
            let state = self.current(&mut state, generation)?;
            let mut credentials = state.credentials.clone().ok_or_else(|| error("auth"))?;
            credentials.label_id = Some(label_id);
            credentials.enabled = enabled;
            self.set_blocked(state, true)?;
            self.persist(&credentials)?;
            state.credentials = Some(credentials);
            self.set_blocked(state, false)?;
        }
        self.status()
    }
    fn poll(&self) -> Result<GmailBatch> {
        let (generation, account, label, page) = {
            let mut state = self.lock()?;
            if let Some(batch) = &state.batch {
                return Ok(batch.response.clone());
            }
            if state.polling {
                return Err(error("network"));
            }
            let credentials = state.credentials.as_ref().ok_or_else(|| error("auth"))?;
            if !credentials.enabled || state.blocked || state.auth_failed {
                return Err(error("config"));
            }
            let label = credentials
                .label_id
                .clone()
                .filter(|s| valid_id(s))
                .ok_or_else(|| error("config"))?;
            let values = (
                state.generation,
                credentials.account_id.clone(),
                label,
                state.page.clone(),
            );
            state.polling = true;
            values
        };
        let result = (|| {
            #[derive(Deserialize)]
            struct MessageId {
                id: String,
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Page {
                #[serde(default)]
                messages: Vec<MessageId>,
                next_page_token: Option<String>,
            }
            let token = self.access(generation)?;
            let mut query = vec![("labelIds", label.as_str()), ("maxResults", "25")];
            if let Some(page) = page.as_deref() {
                query.push(("pageToken", page));
            }
            let page: Page = self.get(&["messages"], &query, &token)?;
            if page.messages.len() > 25
                || page
                    .next_page_token
                    .as_ref()
                    .is_some_and(|v| v.len() > 4096)
            {
                return Err(error("other"));
            }
            let connection = receipts(&self.receipts)?;
            let mut messages = Vec::new();
            let mut ids = HashSet::new();
            for item in page.messages {
                self.check(generation)?;
                if !valid_id(&item.id) || !ids.insert(item.id.clone()) {
                    return Err(error("other"));
                }
                let seen: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM receipts WHERE account=? AND message=?)",
                        params![account, item.id],
                        |row| row.get(0),
                    )
                    .map_err(|_| error("storage"))?;
                if seen {
                    continue;
                }
                let message: ApiMessage =
                    self.get(&["messages", &item.id], &[("format", "full")], &token)?;
                if message.id != item.id {
                    return Err(error("other"));
                }
                if !message.label_ids.contains(&label) {
                    continue;
                }
                messages.push(parse_message(message)?);
            }
            let response = GmailBatch {
                batch_id: random_secret(),
                account_id: account,
                messages,
                has_more: page.next_page_token.is_some(),
            };
            let mut state = self.lock()?;
            let state = self.current(&mut state, generation)?;
            state.batch = Some(PendingBatch {
                generation,
                label,
                next_page: page.next_page_token,
                response: response.clone(),
            });
            Ok(response)
        })();
        if let Ok(mut state) = self.lock() {
            if state.generation == generation {
                state.polling = false;
            }
        }
        result.map_err(|e| self.auth_error(generation, e))
    }
    fn valid_batch(state: &Runtime, batch_id: &str) -> bool {
        !state.blocked
            && !state.auth_failed
            && state.batch.as_ref().is_some_and(|b| {
                b.generation == state.generation
                    && b.response.batch_id == batch_id
                    && state.credentials.as_ref().is_some_and(|c| {
                        c.enabled
                            && c.account_id == b.response.account_id
                            && c.label_id.as_ref() == Some(&b.label)
                    })
            })
    }
    fn commit(&self, batch_id: &str) -> Result<()> {
        let mut state = self.lock()?;
        if !Self::valid_batch(&state, batch_id) {
            return Err(error("cancelled"));
        }
        let batch = state.batch.as_ref().ok_or_else(|| error("cancelled"))?;
        let mut connection = receipts(&self.receipts)?;
        let transaction = connection.transaction().map_err(|_| error("storage"))?;
        for message in &batch.response.messages {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO receipts(account,message) VALUES(?,?)",
                    params![batch.response.account_id, message.id],
                )
                .map_err(|_| error("storage"))?;
        }
        transaction.commit().map_err(|_| error("storage"))?;
        state.page = batch.next_page.clone();
        state.batch = None;
        Ok(())
    }
    fn disconnect(&self) -> Result<GmailDisconnect> {
        let revoke = {
            let mut state = self.lock()?;
            state.invalidate();
            let credentials = state.credentials.take();
            let blocked = self.set_blocked(&mut state, true);
            let cleared = self.vault.set(None);
            blocked?;
            cleared?;
            if credentials.is_some() {
                state.revoking = true;
            }
            credentials.map(|c| c.refresh_token)
        };
        let revoked = if let Some(token) = revoke {
            let revoked = self.oauth(REVOKE, vec![("token".into(), token)]).is_ok();
            self.lock()?.revoking = false;
            revoked
        } else {
            true
        };
        Ok(GmailDisconnect { revoked })
    }
    fn connect(&self, open_browser: impl FnOnce(&str) -> Result<()>) -> Result<GmailStatus> {
        let generation = {
            let mut state = self.lock()?;
            // Google revocation can revoke the entire grant, including a fresh reconnect.
            if state.revoking {
                return Err(error("network"));
            }
            let generation = state.invalidate();
            state.credentials = None;
            state.auth_failed = false;
            let blocked = self.set_blocked(&mut state, true);
            let cleared = self.vault.set(None);
            blocked?;
            cleared?;
            generation
        };
        let client = self.client.as_ref().ok_or_else(|| error("config"))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| error("network"))?;
        let port = listener.local_addr().map_err(|_| error("network"))?.port();
        let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let verifier = random_secret();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let oauth_state = random_secret();
        let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
            .map_err(|_| error("other"))?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", client.client_id.as_str()),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("state", &oauth_state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "select_account consent"),
        ]);
        self.check(generation)?;
        open_browser(url.as_str())?;
        let code = wait_callback(listener, &oauth_state, Duration::from_secs(180), || {
            self.check(generation)
        })?;
        self.check(generation)?;
        let bytes = self.oauth(
            TOKEN,
            vec![
                ("grant_type".into(), "authorization_code".into()),
                ("code".into(), code),
                ("redirect_uri".into(), redirect),
                ("code_verifier".into(), verifier),
                ("client_id".into(), client.client_id.clone()),
                ("client_secret".into(), client.client_secret.clone()),
            ],
        )?;
        let token: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| error("auth"))?;
        token.validate(true)?;
        self.check(generation)?;
        let (account, account_id) = self.profile(&token.access_token)?;
        let credentials = Credentials {
            access_token: token.access_token,
            refresh_token: token.refresh_token.ok_or_else(|| error("auth"))?,
            expires_at: now().saturating_add(token.expires_in.min(86_400)),
            account,
            account_id,
            label_id: None,
            enabled: false,
        };
        {
            let mut state = self.lock()?;
            let state = self.current(&mut state, generation)?;
            self.persist(&credentials)?;
            state.credentials = Some(credentials);
            self.set_blocked(state, false)?;
        }
        self.status()
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
    token_type: String,
}
impl TokenResponse {
    fn validate(&self, initial: bool) -> Result<()> {
        if self.access_token.is_empty()
            || self.access_token.len() > 16_384
            || self.expires_in == 0
            || !self.token_type.eq_ignore_ascii_case("bearer")
            || self
                .scope
                .as_ref()
                .is_some_and(|s| !s.split_whitespace().any(|s| s == SCOPE))
            || (initial
                && (self.scope.is_none()
                    || self.refresh_token.as_ref().map_or(true, String::is_empty)))
            || self
                .refresh_token
                .as_ref()
                .is_some_and(|s| s.len() > 16_384)
        {
            return Err(error("auth"));
        }
        Ok(())
    }
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMessage {
    id: String,
    #[serde(default)]
    label_ids: Vec<String>,
    payload: MimePart,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MimePart {
    #[serde(default)]
    mime_type: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    headers: Vec<Header>,
    #[serde(default)]
    body: MimeBody,
    #[serde(default)]
    parts: Vec<MimePart>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MimeBody {
    #[serde(default)]
    size: u64,
    data: Option<String>,
    attachment_id: Option<String>,
}
#[derive(Deserialize)]
struct Header {
    name: String,
    value: String,
}
fn body_text(part: &MimePart, depth: usize) -> Result<Option<String>> {
    if depth > 32 {
        return Err(error("other"));
    }
    if !part.filename.is_empty()
        || part.headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("content-disposition")
                && h.value
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("attachment")
        })
    {
        return Ok(None);
    }
    if part.mime_type.eq_ignore_ascii_case("text/plain") {
        if part.body.attachment_id.is_some() || (part.body.size > 0 && part.body.data.is_none()) {
            return Err(error("other"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(
                part.body
                    .data
                    .as_deref()
                    .unwrap_or_default()
                    .trim_end_matches('='),
            )
            .map_err(|_| error("other"))?;
        if part.body.size != bytes.len() as u64 {
            return Err(error("other"));
        }
        return String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| error("other"));
    }
    let mut text = Vec::new();
    for child in &part.parts {
        if let Some(value) = body_text(child, depth + 1)? {
            text.push(value);
            if part.mime_type.eq_ignore_ascii_case("multipart/alternative")
                && child.mime_type.eq_ignore_ascii_case("text/plain")
            {
                return Ok(text.pop());
            }
        }
    }
    if !text.is_empty() {
        return Ok(Some(text.join("\n")));
    }
    // HTML-only mail is parsed through the existing mail parser's text conversion.
    if part.mime_type.eq_ignore_ascii_case("text/html") {
        if part.body.attachment_id.is_some() || (part.body.size > 0 && part.body.data.is_none()) {
            return Err(error("other"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(
                part.body
                    .data
                    .as_deref()
                    .unwrap_or_default()
                    .trim_end_matches('='),
            )
            .map_err(|_| error("other"))?;
        if part.body.size != bytes.len() as u64 {
            return Err(error("other"));
        }
        let html = String::from_utf8(bytes).map_err(|_| error("other"))?;
        let raw =
            format!("MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}");
        let parsed = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .ok_or_else(|| error("other"))?;
        return parsed
            .body_text(0)
            .map(|v| Some(v.into_owned()))
            .ok_or_else(|| error("other"));
    }
    Ok(None)
}
fn parse_message(message: ApiMessage) -> Result<GmailMessage> {
    let header = |name: &str, limit: usize| {
        message
            .payload
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.chars().filter(|c| *c != '\0').take(limit).collect())
            .unwrap_or_default()
    };
    let body = body_text(&message.payload, 0)?.ok_or_else(|| error("other"))?;
    Ok(GmailMessage {
        subject: header("subject", 1024),
        from: header("from", 2048),
        body_text: body.chars().take(16_000).collect(),
        id: message.id,
    })
}

enum Callback {
    Ignore,
    Code(String),
    Denied,
}
fn parse_callback(request: &str, port: u16, state: &str) -> Callback {
    let mut lines = request.split("\r\n");
    let Some(first) = lines.next() else {
        return Callback::Ignore;
    };
    let fields: Vec<_> = first.split(' ').collect();
    if fields.len() != 3 || fields[0] != "GET" || !matches!(fields[2], "HTTP/1.1" | "HTTP/1.0") {
        return Callback::Ignore;
    }
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .collect();
    if hosts.len() != 1 || hosts[0].1.trim() != format!("127.0.0.1:{port}") {
        return Callback::Ignore;
    }
    if !fields[1].starts_with(&format!("{CALLBACK_PATH}?")) {
        return Callback::Ignore;
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{}", fields[1])) else {
        return Callback::Ignore;
    };
    if url.path() != CALLBACK_PATH || url.fragment().is_some() {
        return Callback::Ignore;
    }
    let values: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = values.iter().filter(|(k, _)| k == "state").collect();
    if states.len() != 1 || states[0].1 != state {
        return Callback::Ignore;
    }
    let codes: Vec<_> = values.iter().filter(|(k, _)| k == "code").collect();
    let errors: Vec<_> = values.iter().filter(|(k, _)| k == "error").collect();
    if codes.is_empty() && errors.len() == 1 {
        return Callback::Denied;
    }
    if codes.len() != 1 || !errors.is_empty() || codes[0].1.is_empty() || codes[0].1.len() > 4096 {
        return Callback::Ignore;
    }
    Callback::Code(codes[0].1.to_string())
}
fn read_callback(
    stream: &mut TcpStream,
    current: &impl Fn() -> Result<()>,
) -> Result<Option<String>> {
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| error("network"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .map_err(|_| error("network"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    while bytes.len() < 16_384 && Instant::now() < deadline {
        current()?;
        let mut buffer = [0; 1024];
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Ok(None),
        }
        if bytes.ends_with(b"\r\n\r\n") {
            return Ok(String::from_utf8(bytes).ok());
        }
    }
    Ok(None)
}
fn wait_callback(
    listener: TcpListener,
    state: &str,
    timeout: Duration,
    current: impl Fn() -> Result<()>,
) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| error("network"))?;
    let port = listener.local_addr().map_err(|_| error("network"))?.port();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        current()?;
        match listener.accept() {
            Ok((mut stream, address)) if address.ip().is_loopback() => {
                let callback = read_callback(&mut stream, &current)?
                    .map(|r| parse_callback(&r, port, state))
                    .unwrap_or(Callback::Ignore);
                let accepted = !matches!(callback, Callback::Ignore);
                let status = if accepted {
                    "200 OK"
                } else {
                    "400 Bad Request"
                };
                let body = if accepted {
                    "Return to Mindwtr. You may close this tab."
                } else {
                    "Invalid callback."
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                match callback {
                    Callback::Code(code) => return Ok(code),
                    Callback::Denied => return Err(error("cancelled")),
                    Callback::Ignore => (),
                }
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(_) => return Err(error("network")),
        }
    }
    Err(error("cancelled"))
}

fn context(app: &tauri::AppHandle) -> Result<Arc<Context>> {
    static CONTEXTS: OnceLock<Mutex<HashMap<String, Arc<Context>>>> = OnceLock::new();
    let config_path = crate::get_config_path(app);
    let namespace = digest(&format!(
        "{}:{}",
        app.config().identifier,
        config_path.to_string_lossy()
    ));
    let mut contexts = CONTEXTS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| error("storage"))?;
    if let Some(context) = contexts.get(&namespace) {
        return Ok(context.clone());
    }
    let path = config_path.with_file_name("gmail-capture-receipts.sqlite");
    let vault = Arc::new(SystemVault {
        app: app.clone(),
        name: format!("gmail-capture:{namespace}"),
    });
    let client = client_config();
    let mut state = Runtime::default();
    if client.is_some() {
        state.blocked = receipts(&path)?
            .query_row("SELECT blocked FROM control WHERE id=1", [], |row| {
                row.get(0)
            })
            .map_err(|_| error("storage"))?;
        state.credentials = vault
            .get()?
            .map(|v| serde_json::from_str(&v).map_err(|_| error("storage")))
            .transpose()?;
    }
    let proxy = crate::config::read_config(app).proxy_url;
    let http = crate::sync::blocking_http_client_builder(proxy.as_deref())
        .map_err(|_| error("network"))?
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| error("network"))?;
    let context = Arc::new(Context {
        state: Mutex::new(state),
        vault,
        http: Arc::new(GoogleTransport(http)),
        client,
        receipts: path,
    });
    contexts.insert(namespace, context.clone());
    Ok(context)
}
async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(Arc<Context>) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || work(context(&app)?))
        .await
        .map_err(|_| error("other"))?
}
#[tauri::command]
pub(crate) async fn gmail_capture_status(app: tauri::AppHandle) -> Result<GmailStatus> {
    blocking(app, |c| c.status()).await
}
#[tauri::command]
pub(crate) async fn gmail_capture_connect(app: tauri::AppHandle) -> Result<GmailStatus> {
    blocking(app, |c| {
        c.connect(|url| open::that_detached(url).map_err(|_| error("other")))
    })
    .await
}
#[tauri::command]
pub(crate) async fn gmail_capture_cancel(app: tauri::AppHandle) -> Result<()> {
    blocking(app, |c| {
        c.lock()?.invalidate();
        Ok(())
    })
    .await
}
#[tauri::command]
pub(crate) async fn gmail_capture_labels(app: tauri::AppHandle) -> Result<Vec<GmailLabel>> {
    blocking(app, |c| c.labels()).await
}
#[tauri::command]
pub(crate) async fn gmail_capture_configure(
    app: tauri::AppHandle,
    label_id: String,
    enabled: bool,
) -> Result<GmailStatus> {
    blocking(app, move |c| c.configure(label_id, enabled)).await
}
#[tauri::command]
pub(crate) async fn gmail_capture_disconnect(app: tauri::AppHandle) -> Result<GmailDisconnect> {
    blocking(app, |c| c.disconnect()).await
}
#[tauri::command]
pub(crate) async fn gmail_capture_poll(app: tauri::AppHandle) -> Result<GmailBatch> {
    blocking(app, |c| c.poll()).await
}
#[tauri::command]
pub(crate) async fn gmail_capture_validate(
    app: tauri::AppHandle,
    batch_id: String,
) -> Result<bool> {
    blocking(app, move |c| {
        Ok(Context::valid_batch(&*c.lock()?, &batch_id))
    })
    .await
}
#[tauri::command]
pub(crate) async fn gmail_capture_commit(app: tauri::AppHandle, batch_id: String) -> Result<()> {
    blocking(app, move |c| c.commit(&batch_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[derive(Default)]
    struct MemoryVault {
        value: Mutex<Option<String>>,
        fail: AtomicBool,
        writes: AtomicUsize,
    }
    impl Vault for MemoryVault {
        fn get(&self) -> Result<Option<String>> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, value: Option<String>) -> Result<()> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(error("storage"));
            }
            *self.value.lock().unwrap() = value;
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    struct MockTransport(Box<dyn Fn(Request) -> Result<Vec<u8>> + Send + Sync>);
    impl Transport for MockTransport {
        fn send(&self, request: Request) -> Result<Vec<u8>> {
            self.0(request)
        }
    }
    fn account() -> Credentials {
        Credentials {
            access_token: "test-access".into(),
            refresh_token: "test-refresh".into(),
            expires_at: now() + 3600,
            account: "designated@example.test".into(),
            account_id: digest("designated@example.test"),
            label_id: Some("Label_1".into()),
            enabled: true,
        }
    }
    fn setup(
        http: impl Fn(Request) -> Result<Vec<u8>> + Send + Sync + 'static,
    ) -> (tempfile::TempDir, Arc<Context>, Arc<MemoryVault>) {
        let directory = tempfile::Builder::new()
            .prefix("gmail-test-")
            .tempdir_in(env!("CARGO_MANIFEST_DIR"))
            .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let credentials = account();
        vault
            .set(Some(serde_json::to_string(&credentials).unwrap()))
            .unwrap();
        let context = Arc::new(Context {
            state: Mutex::new(Runtime {
                credentials: Some(credentials),
                ..Runtime::default()
            }),
            vault: vault.clone(),
            http: Arc::new(MockTransport(Box::new(http))),
            client: Some(OAuthClient {
                client_id: "test-client".into(),
                client_secret: "".into(),
            }),
            receipts: directory.path().join("receipts.sqlite"),
        });
        receipts(&context.receipts).unwrap();
        (directory, context, vault)
    }
    fn json(value: serde_json::Value) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&value).unwrap())
    }
    fn mail(id: &str, label: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "id":id, "labelIds":[label], "payload": {
                "mimeType":"text/plain", "headers":[{"name":"Subject","value":"Test subject"},{"name":"From","value":"Sender"}],
                "body":{"size":text.len(),"data":URL_SAFE_NO_PAD.encode(text)}
            }
        })
    }
    fn refresh_response() -> Result<Vec<u8>> {
        json(
            serde_json::json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600,"scope":SCOPE,"token_type":"Bearer"}),
        )
    }
    fn check_read_only(request: &Request) {
        assert_eq!(request.url.scheme(), "https");
        assert_eq!(request.url.host_str(), Some("gmail.googleapis.com"));
        assert!(request.form.is_none());
        assert!(request.token.is_some());
        assert!(!request.url.path().contains("attachments"));
        assert!(!request.url.path().contains("modify"));
    }

    #[test]
    fn pages_replay_until_atomic_ack_and_receipts_survive_account_label_changes() {
        let lists = Arc::new(AtomicUsize::new(0));
        let counted = lists.clone();
        let (_directory, context, _) = setup(move |request| {
            if request.url.as_str() == REVOKE {
                return Err(error("network"));
            }
            check_read_only(&request);
            if request.url.path().ends_with("/messages") {
                counted.fetch_add(1, Ordering::SeqCst);
                let query: HashMap<_, _> = request.url.query_pairs().into_owned().collect();
                assert_eq!(query.get("maxResults").map(String::as_str), Some("25"));
                assert_eq!(query.get("labelIds").map(String::as_str), Some("Label_1"));
                return if query.contains_key("pageToken") {
                    json(serde_json::json!({"messages":[{"id":"second"}]}))
                } else {
                    json(
                        serde_json::json!({"messages":[{"id":"first"}],"nextPageToken":"page-two"}),
                    )
                };
            }
            let id = request.url.path_segments().unwrap().next_back().unwrap();
            json(mail(id, "Label_1", "Body"))
        });
        let first = context.poll().unwrap();
        assert!(first.has_more);
        assert_eq!(first.messages.len(), 1);
        assert_eq!(context.poll().unwrap().batch_id, first.batch_id);
        assert_eq!(lists.load(Ordering::SeqCst), 1);
        context.commit(&first.batch_id).unwrap();
        assert!(!Context::valid_batch(
            &context.lock().unwrap(),
            &first.batch_id
        ));
        let second = context.poll().unwrap();
        assert_eq!(second.messages[0].id, "second");
        assert!(!second.has_more);
        context.commit(&second.batch_id).unwrap();
        let skipped = context.poll().unwrap();
        assert!(skipped.messages.is_empty());
        assert!(skipped.has_more);
        context.commit(&skipped.batch_id).unwrap();
        assert_eq!(context.poll().unwrap().messages.len(), 0);
        context.disconnect().unwrap();
        assert_eq!(
            receipts(&context.receipts)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM receipts", [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            receipts(&context.receipts)
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM receipts WHERE account=? AND message='first')",
                    [digest("another@example.test")],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap(),
            false
        );
    }

    #[test]
    fn failed_atomic_ack_keeps_batch_page_and_all_receipts_uncommitted() {
        let (_directory, context, _) = setup(|request| {
            if request.url.path().ends_with("/messages") {
                return json(
                    serde_json::json!({"messages":[{"id":"first"},{"id":"second"}],"nextPageToken":"later"}),
                );
            }
            let id = request.url.path_segments().unwrap().next_back().unwrap();
            json(mail(id, "Label_1", "Body"))
        });
        let batch = context.poll().unwrap();
        let connection = receipts(&context.receipts).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_ack BEFORE INSERT ON receipts WHEN NEW.message='second' BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
        assert_eq!(context.commit(&batch.batch_id).unwrap_err().kind, "storage");
        assert!(Context::valid_batch(
            &context.lock().unwrap(),
            &batch.batch_id
        ));
        assert!(context.lock().unwrap().page.is_none());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM receipts", [], |r| r
                    .get::<_, usize>(0))
                .unwrap(),
            0
        );
        connection.execute_batch("DROP TRIGGER reject_ack").unwrap();
        context.commit(&batch.batch_id).unwrap();
        assert_eq!(context.lock().unwrap().page.as_deref(), Some("later"));
    }

    #[test]
    fn removed_label_is_skipped_but_empty_page_can_advance() {
        let (_directory, context, _) = setup(|request| {
            check_read_only(&request);
            if request.url.path().ends_with("/messages") {
                return json(
                    serde_json::json!({"messages":[{"id":"removed"}],"nextPageToken":"next"}),
                );
            }
            json(mail("removed", "Label_other", "Body"))
        });
        let batch = context.poll().unwrap();
        assert!(batch.messages.is_empty());
        context.commit(&batch.batch_id).unwrap();
        assert_eq!(context.lock().unwrap().page.as_deref(), Some("next"));
    }

    #[test]
    fn missing_inline_body_never_yields_acknowledgeable_batch() {
        let (_directory, context, _) = setup(|request| {
            if request.url.path().ends_with("/messages") {
                return json(serde_json::json!({"messages":[{"id":"missing"}]}));
            }
            json(
                serde_json::json!({"id":"missing","labelIds":["Label_1"],"payload":{"mimeType":"text/plain","body":{"size":200,"attachmentId":"unavailable"}}}),
            )
        });
        assert_eq!(context.poll().err().unwrap().kind, "other");
        assert!(context.lock().unwrap().batch.is_none());
        assert!(context.lock().unwrap().page.is_none());
    }

    #[test]
    fn corrupt_receipts_fail_closed() {
        let (_directory, context, _) = setup(|request| {
            assert!(request.url.path().ends_with("/messages"));
            json(serde_json::json!({"messages":[{"id":"first"}]}))
        });
        fs::write(&context.receipts, b"corrupted database").unwrap();
        assert_eq!(context.poll().err().unwrap().kind, "storage");
        assert!(context.lock().unwrap().batch.is_none());
        assert_eq!(fs::read(&context.receipts).unwrap(), b"corrupted database");
    }

    #[test]
    fn existing_empty_truncated_or_incomplete_receipts_are_never_reinitialized() {
        for damage in [
            "empty",
            "truncated",
            "receipts",
            "control",
            "control-row",
            "invalid-control",
            "schema",
        ] {
            let (_directory, context, _) =
                setup(|_| panic!("database validation must not need Gmail"));
            match damage {
                "empty" => fs::write(&context.receipts, []).unwrap(),
                "truncated" => {
                    let length = fs::metadata(&context.receipts).unwrap().len();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&context.receipts)
                        .unwrap()
                        .set_len(length / 2)
                        .unwrap();
                }
                _ => {
                    let connection = Connection::open(&context.receipts).unwrap();
                    connection.execute_batch(match damage {
                        "receipts" => "DROP TABLE receipts",
                        "control" => "DROP TABLE control",
                        "control-row" => "DELETE FROM control",
                        "invalid-control" => "UPDATE control SET blocked=2",
                        "schema" => "DROP TABLE receipts;CREATE TABLE receipts(account TEXT,message TEXT)",
                        _ => unreachable!(),
                    }).unwrap();
                }
            }
            let before = fs::read(&context.receipts).unwrap();
            assert_eq!(
                receipts(&context.receipts).err().unwrap().kind,
                "storage",
                "damage: {damage}"
            );
            assert_eq!(
                fs::read(&context.receipts).unwrap(),
                before,
                "damage: {damage}"
            );
        }
    }

    #[test]
    fn failed_vault_delete_durably_blocks_restart_and_stops_current_batch() {
        let (_directory, context, vault) = setup(|_| json(serde_json::json!({})));
        vault.fail.store(true, Ordering::SeqCst);
        assert_eq!(context.disconnect().err().unwrap().kind, "storage");
        assert!(!context.status().unwrap().connected);
        assert!(context.lock().unwrap().credentials.is_none());
        assert!(vault.get().unwrap().is_some());
        assert!(receipts(&context.receipts)
            .unwrap()
            .query_row("SELECT blocked FROM control WHERE id=1", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
    }

    #[test]
    fn offline_disconnect_deletes_tokens_retains_receipts_and_reports_revocation_failure() {
        let (_directory, context, vault) = setup(|request| {
            assert_eq!(request.url.as_str(), REVOKE);
            assert!(request.token.is_none());
            Err(error("network"))
        });
        assert!(!context.disconnect().unwrap().revoked);
        assert!(vault.get().unwrap().is_none());
        assert!(!context.status().unwrap().enabled);
    }

    #[test]
    fn reconnect_waits_for_remote_revocation_and_guard_releases_on_success_or_failure() {
        for offline in [false, true] {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let (_directory, context, _) = setup(move |request| {
                assert_eq!(request.url.as_str(), REVOKE);
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                if offline {
                    Err(error("network"))
                } else {
                    Ok(Vec::new())
                }
            });
            let worker = context.clone();
            let join = std::thread::spawn(move || worker.disconnect());
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(
                context
                    .connect(|_| panic!("must not start consent during revocation"))
                    .err()
                    .unwrap()
                    .kind,
                "network"
            );
            // A second disconnect/cancel cannot release the first request's guard.
            context.lock().unwrap().invalidate();
            context.disconnect().unwrap();
            assert!(context.lock().unwrap().revoking);
            release_tx.send(()).unwrap();
            assert_eq!(join.join().unwrap().unwrap().revoked, !offline);
            assert!(!context.lock().unwrap().revoking);
            assert_eq!(
                context
                    .connect(|_| Err(error("cancelled")))
                    .err()
                    .unwrap()
                    .kind,
                "cancelled"
            );
        }
    }

    #[test]
    fn refresh_returning_after_disconnect_cannot_restore_rotated_credentials() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (_directory, context, vault) = setup(move |request| {
            if request.url.as_str() == TOKEN {
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                return refresh_response();
            }
            assert_eq!(request.url.as_str(), REVOKE);
            Err(error("network"))
        });
        context
            .lock()
            .unwrap()
            .credentials
            .as_mut()
            .unwrap()
            .expires_at = 0;
        let worker = context.clone();
        let join = std::thread::spawn(move || worker.access(0));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        context.disconnect().unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(join.join().unwrap().err().unwrap().kind, "cancelled");
        assert!(vault.get().unwrap().is_none());
        assert!(!context.status().unwrap().connected);
    }

    #[test]
    fn refresh_verifies_profile_before_saving_rotation() {
        let (_directory, context, vault) = setup(|request| {
            if request.url.as_str() == TOKEN {
                return refresh_response();
            }
            check_read_only(&request);
            assert!(request.url.path().ends_with("/profile"));
            json(serde_json::json!({"emailAddress":"other@example.test"}))
        });
        context
            .lock()
            .unwrap()
            .credentials
            .as_mut()
            .unwrap()
            .expires_at = 0;
        let writes = vault.writes.load(Ordering::SeqCst);
        assert_eq!(context.access(0).err().unwrap().kind, "auth");
        assert_eq!(vault.writes.load(Ordering::SeqCst), writes);
        assert!(!context.status().unwrap().connected);
        assert_eq!(context.poll().err().unwrap().kind, "config");
    }

    #[test]
    fn stale_label_validation_cannot_enable_after_disconnect() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (_directory, context, _) = setup(move |request| {
            if request.url.as_str() == REVOKE {
                return Err(error("network"));
            }
            check_read_only(&request);
            assert!(request.url.path().ends_with("/labels/Label_2"));
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            json(serde_json::json!({"id":"Label_2","name":"Mindwtr"}))
        });
        let worker = context.clone();
        let join = std::thread::spawn(move || worker.configure("Label_2".into(), true));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        context.disconnect().unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(join.join().unwrap().err().unwrap().kind, "cancelled");
        assert!(!context.status().unwrap().enabled);
    }

    #[test]
    fn stale_poll_cannot_issue_or_ack_batch_after_cancel() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (_directory, context, _) = setup(move |request| {
            check_read_only(&request);
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            json(serde_json::json!({"messages":[]}))
        });
        let worker = context.clone();
        let join = std::thread::spawn(move || worker.poll());
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        context.lock().unwrap().invalidate();
        release_tx.send(()).unwrap();
        assert_eq!(join.join().unwrap().err().unwrap().kind, "cancelled");
        assert!(context.lock().unwrap().batch.is_none());
    }

    #[test]
    fn mime_handles_nested_plain_html_attachments_and_intended_character_limit() {
        let text = "界".repeat(16_010);
        let message: ApiMessage = serde_json::from_value(mail("body", "Label_1", &text)).unwrap();
        assert_eq!(
            parse_message(message).unwrap().body_text.chars().count(),
            16_000
        );
        let body = serde_json::json!({"id":"nested","payload":{"mimeType":"multipart/mixed","parts":[
            {"mimeType":"multipart/alternative","parts":[
                {"mimeType":"text/plain","body":{"size":5,"data":URL_SAFE_NO_PAD.encode("plain")}},
                {"mimeType":"text/html","body":{"size":11,"data":URL_SAFE_NO_PAD.encode("<b>html</b>")}}
            ]},
            {"mimeType":"text/plain","filename":"private.txt","body":{"size":100,"attachmentId":"file"}}
        ]}});
        let parsed = parse_message(serde_json::from_value(body).unwrap()).unwrap();
        assert_eq!(parsed.body_text, "plain");
        let html = serde_json::json!({"id":"html","payload":{"mimeType":"text/html","body":{"size":12,"data":URL_SAFE_NO_PAD.encode("<b>Hello</b>")}}});
        assert!(parse_message(serde_json::from_value(html).unwrap())
            .unwrap()
            .body_text
            .contains("Hello"));
    }

    #[test]
    fn response_cap_is_enforced_with_and_without_content_length() {
        let bytes = vec![0; RESPONSE_LIMIT as usize + 1];
        assert_eq!(
            read_response(bytes.as_slice(), Some(bytes.len() as u64))
                .err()
                .unwrap()
                .kind,
            "other"
        );
        assert_eq!(
            read_response(bytes.as_slice(), None).err().unwrap().kind,
            "other"
        );
        assert_eq!(read_response(&b"{}"[..], None).unwrap(), b"{}");
    }

    #[test]
    fn callback_validates_method_exact_path_host_state_and_duplicate_parameters() {
        fn request(target: &str, host: &str) -> String {
            format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n")
        }
        let valid = request("/oauth2/callback?state=expected&code=one", "127.0.0.1:1234");
        assert!(
            matches!(parse_callback(&valid, 1234, "expected"), Callback::Code(code) if code == "one")
        );
        for invalid in [
            valid.replace("GET", "POST"),
            valid.replace("127.0.0.1:1234", "evil.test"),
            valid.replace("state=expected", "state=wrong"),
            valid.replace("code=one", "code=one&code=two"),
            valid.replace("state=expected", "state=expected&state=expected"),
            valid.replace("/oauth2/callback?", "/oauth2/callback/extra?"),
            valid.replace("Host: ", "Host: 127.0.0.1:1234\r\nHost: "),
        ] {
            assert!(matches!(
                parse_callback(&invalid, 1234, "expected"),
                Callback::Ignore
            ));
        }
        assert!(matches!(
            parse_callback(
                &request(
                    "/oauth2/callback?state=expected&error=access_denied",
                    "127.0.0.1:1234"
                ),
                1234,
                "expected"
            ),
            Callback::Denied
        ));
    }

    #[test]
    fn real_loopback_ignores_wrong_state_accepts_once_and_cancels_partial_reader() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            wait_callback(listener, "expected", Duration::from_secs(3), || Ok(()))
        });
        let mut queued = None;
        for state in ["wrong", "expected"] {
            let mut stream = TcpStream::connect(address).unwrap();
            if state == "expected" {
                // Queue before completion so another test cannot reuse the closed listener's port.
                let stream = TcpStream::connect(address).unwrap();
                // macOS rejects timeout changes after the queued connection has been reset.
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                queued = Some(stream);
            }
            write!(
                stream,
                "GET /oauth2/callback?state={state}&code=one HTTP/1.1\r\nHost: {address}\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with(if state == "wrong" {
                "HTTP/1.1 400"
            } else {
                "HTTP/1.1 200"
            }));
        }
        assert_eq!(worker.join().unwrap().unwrap(), "one");
        let mut queued = queued.unwrap();
        assert!(match queued.read(&mut [0; 1]) {
            Ok(0) => true,
            Err(err) => err.kind() == std::io::ErrorKind::ConnectionReset,
            Ok(_) => false,
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let check = cancelled.clone();
        let worker = std::thread::spawn(move || {
            wait_callback(listener, "expected", Duration::from_secs(3), || {
                if check.load(Ordering::SeqCst) {
                    Err(error("cancelled"))
                } else {
                    Ok(())
                }
            })
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(b"GET /oauth2/callback?").unwrap();
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap().err().unwrap().kind, "cancelled");
    }

    #[test]
    fn connect_uses_pkce_readonly_scope_and_never_auto_enables_or_reuses_old_account() {
        let (_directory, context, _) = setup(|request| {
            if request.url.as_str() == TOKEN {
                let form: HashMap<_, _> = request.form.unwrap().into_iter().collect();
                assert_eq!(
                    form.get("grant_type").map(String::as_str),
                    Some("authorization_code")
                );
                assert_eq!(
                    form.get("code").map(String::as_str),
                    Some("designated-code")
                );
                assert!(form.get("code_verifier").unwrap().len() >= 43);
                return refresh_response();
            }
            check_read_only(&request);
            json(serde_json::json!({"emailAddress":"Designated@Example.Test"}))
        });
        let status = context.connect(|url| {
            let url = reqwest::Url::parse(url).unwrap();
            assert_eq!(url.host_str(), Some("accounts.google.com"));
            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(query.get("scope").map(String::as_str), Some(SCOPE));
            assert_eq!(query.get("code_challenge_method").map(String::as_str), Some("S256"));
            assert!(query.get("state").unwrap().len() >= 43);
            assert!(query.get("code_challenge").unwrap().len() >= 43);
            let redirect = reqwest::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
            let mut stream = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
            write!(stream, "GET {CALLBACK_PATH}?state={}&code=designated-code HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", query.get("state").unwrap(), redirect.port().unwrap()).unwrap();
            Ok(())
        }).unwrap();
        assert!(status.connected);
        assert!(!status.enabled);
        assert!(status.label_id.is_none());
        assert_eq!(
            status.account_id.as_deref(),
            Some(digest("designated@example.test").as_str())
        );
        let denied = context.connect(|url| {
            let url = reqwest::Url::parse(url).unwrap();
            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
            let redirect = reqwest::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
            let mut stream = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
            write!(stream, "GET {CALLBACK_PATH}?state={}&error=access_denied HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", query.get("state").unwrap(), redirect.port().unwrap()).unwrap();
            Ok(())
        });
        assert_eq!(denied.err().unwrap().kind, "cancelled");
        assert!(!context.status().unwrap().connected);
    }

    #[test]
    fn cancelled_connect_returning_from_token_exchange_cannot_persist_or_fetch_profile() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (_directory, context, vault) = setup(move |request| {
            assert_eq!(request.url.as_str(), TOKEN);
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            refresh_response()
        });
        let worker = context.clone();
        let join = std::thread::spawn(move || {
            worker.connect(|url| {
                let url = reqwest::Url::parse(url).unwrap();
                let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
                let redirect = reqwest::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
                let mut stream =
                    TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
                write!(
                    stream,
                    "GET {CALLBACK_PATH}?state={}&code=one HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                    query.get("state").unwrap(),
                    redirect.port().unwrap()
                )
                .unwrap();
                Ok(())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        context.lock().unwrap().invalidate();
        release_tx.send(()).unwrap();
        assert_eq!(join.join().unwrap().err().unwrap().kind, "cancelled");
        assert!(vault.get().unwrap().is_none());
    }

    #[test]
    fn token_without_granted_readonly_scope_is_rejected_and_errors_are_fixed() {
        let token: TokenResponse = serde_json::from_value(serde_json::json!({"access_token":"private","refresh_token":"private","expires_in":3600,"scope":"gmail.modify","token_type":"Bearer"})).unwrap();
        assert_eq!(token.validate(true).unwrap_err().kind, "auth");
        for kind in ["auth", "network", "config", "cancelled", "storage", "other"] {
            let serialized = serde_json::to_string(&error(kind)).unwrap();
            assert!(!serialized.contains("private"));
            assert!(!serialized.contains("example.test"));
            assert!(!serialized.contains("http"));
        }
    }
}
