use super::{normalize_webdav_url, NATIVE_HTTP_TIMEOUT_SECS};
use crate::config::read_config;
use reqwest::{Method, Url};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, Resource};
use tokio::sync::watch;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWebdavRequest {
    folder: String,
    url: String,
    method: String,
    authorization: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn document_url(folder: &str) -> Result<Url, String> {
    let url = Url::parse(&normalize_webdav_url(folder)).map_err(|_| "Invalid WebDAV folder")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        || !url.path().starts_with("/webdav/data/")
        || !url.path().ends_with("/data.json")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Expected a local WebDAV folder".into());
    }
    Ok(url)
}

fn validate_request(request: &LocalWebdavRequest) -> Result<(Url, Method), String> {
    let document = document_url(&request.folder)?;
    let url = Url::parse(&request.url).map_err(|_| "Invalid WebDAV resource")?;
    let folder = document.join(".").map_err(|_| "Invalid WebDAV folder")?;
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid WebDAV method")?;
    let raw_path = url.path().to_ascii_lowercase();
    if url.origin() != document.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw_path.contains("%2f")
        || raw_path.contains("%5c")
        || raw_path.contains("%2e")
        || raw_path.contains("%25")
        || !url.path().starts_with(folder.path())
        || !request.authorization.starts_with("Basic ")
    {
        return Err("WebDAV resource outside the selected folder".into());
    }
    let name = &url.path()[folder.path().len()..];
    let filename = document
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or_default();
    let probe = name
        .strip_prefix(filename)
        .and_then(|suffix| suffix.strip_prefix(".mindwtr-etag-probe-"))
        .is_some_and(|id| {
            !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    let attachment = name
        .strip_prefix("attachments/")
        .is_some_and(|file| !file.is_empty() && !file.contains('/'));
    let preserved = name.strip_prefix(".mindwtr-legacy-").is_some_and(|rest| {
        rest.strip_suffix(".bin")
            .or_else(|| rest.strip_prefix("inventory-")?.strip_suffix(".json.enc"))
            .is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
            })
    });
    let artifact = matches!(
        name,
        "data.json"
            | "data.json.enc"
            | "data.json.bak"
            | "data.json.enc.bak"
            | ".mindwtr-sync-fence-v1.json"
    ) || probe
        || attachment
        || preserved;
    let allowed = match method.as_str() {
        "GET" | "HEAD" | "PUT" | "DELETE" => artifact,
        "PROPFIND" | "MKCOL" => name.is_empty() || name == "attachments/",
        _ => false,
    };
    if !allowed {
        return Err("Unsupported WebDAV operation for this folder".into());
    }
    Ok((url, method))
}

struct LocalWebdavTransfer {
    builder: Mutex<Option<reqwest::RequestBuilder>>,
    canceled: watch::Sender<bool>,
    limit: usize,
}

impl Resource for LocalWebdavTransfer {
    fn close(self: Arc<Self>) {
        self.canceled.send_replace(true);
    }
}

#[tauri::command]
pub(crate) fn local_webdav_prepare(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: LocalWebdavRequest,
) -> Result<u32, String> {
    let source = window.url().map_err(|_| "Invalid WebDAV caller")?;
    let bundled = matches!(
        (source.scheme(), source.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    );
    let dev = cfg!(debug_assertions)
        && source.scheme() == "http"
        && source.host_str() == Some("localhost")
        && source.port() == Some(5173);
    if window.label() != "main" || !(bundled || dev) {
        return Err("WebDAV sync requires the Mindwtr main window".into());
    }
    let (url, method) = validate_request(&request)?;
    let limit = if url.path().contains("/attachments/") {
        100 * 1024 * 1024
    } else {
        1024 * 1024 * 1024
    };
    if request.body.len() > limit {
        return Err("WebDAV upload exceeds the size limit".into());
    }
    let config = read_config(&app);
    let mut client = reqwest::Client::builder()
        .timeout(Duration::from_secs(NATIVE_HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = config.proxy_url.as_deref().filter(|p| !p.trim().is_empty()) {
        client = client.proxy(reqwest::Proxy::all(proxy).map_err(|_| "Invalid WebDAV proxy")?);
    }
    let mut builder = client
        .build()
        .map_err(|_| "Unable to initialize WebDAV client")?
        .request(method, url)
        .header("Authorization", request.authorization);
    for (name, value) in request.headers {
        if matches!(
            name.as_str(),
            "accept-encoding"
                | "cache-control"
                | "pragma"
                | "if-match"
                | "if-none-match"
                | "content-type"
                | "depth"
                | "range"
                | "x-nc-webdav-automkcol"
        ) {
            builder = builder.header(name, value);
        }
    }
    let (canceled, _) = watch::channel(false);
    Ok(window.resources_table().add(LocalWebdavTransfer {
        builder: Mutex::new(Some(builder.body(request.body))),
        canceled,
        limit,
    }))
}

#[tauri::command]
pub(crate) fn local_webdav_close(window: tauri::WebviewWindow, rid: u32) -> Result<(), String> {
    window
        .resources_table()
        .take::<LocalWebdavTransfer>(rid)
        .map_err(|_| "Unknown WebDAV transfer")?
        .close();
    Ok(())
}

#[tauri::command]
pub(crate) async fn local_webdav_send(
    window: tauri::WebviewWindow,
    rid: u32,
) -> Result<tauri::ipc::Response, String> {
    let transfer = window
        .resources_table()
        .get::<LocalWebdavTransfer>(rid)
        .map_err(|_| "Unknown WebDAV transfer")?;
    let builder = transfer
        .builder
        .lock()
        .map_err(|_| "WebDAV request interrupted")?
        .take()
        .ok_or("WebDAV request already sent")?;
    let mut canceled = transfer.canceled.subscribe();
    let read = async {
        let mut response = builder
            .send()
            .await
            .map_err(|_| "Local WebDAV request failed")?;
        let status = response.status().as_u16();
        let headers: BTreeMap<_, _> = response
            .headers()
            .iter()
            .filter(|(n, _)| {
                matches!(
                    n.as_str(),
                    "etag"
                        | "date"
                        | "content-length"
                        | "last-modified"
                        | "content-type"
                        | "retry-after"
                        | "content-range"
                )
            })
            .filter_map(|(n, v)| v.to_str().ok().map(|s| (n.as_str(), s)))
            .collect();
        let mut frame = serde_json::to_vec(&(status, headers))
            .map_err(|_| "Invalid WebDAV response headers")?;
        frame.push(b'\n');
        let limit = if status >= 400 { 65536 } else { transfer.limit };
        let mut remaining = limit;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Unable to read WebDAV response")?
        {
            remaining = remaining
                .checked_sub(chunk.len())
                .ok_or("WebDAV response exceeds the size limit")?;
            frame.extend_from_slice(&chunk);
        }
        Ok(tauri::ipc::Response::new(frame))
    };
    tokio::select! {
        biased;
        _ = canceled.wait_for(|value| *value) => Err("WebDAV transfer canceled".into()),
        result = read => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn check(folder: &str, url: &str, method: &str) -> bool {
        validate_request(&LocalWebdavRequest {
            folder: folder.into(),
            url: url.into(),
            method: method.into(),
            authorization: "Basic Zm9vOmJhcg==".into(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        })
        .is_ok()
    }

    #[test]
    fn permits_only_managed_resources_at_the_selected_loopback_folder() {
        let folder = "http://127.0.0.1:6806/webdav/data/webDAV/mindwtr";
        for (method, name) in [
            ("GET", "data.json"),
            ("PUT", "data.json.mindwtr-etag-probe-ab-cd"),
            ("PUT", ".mindwtr-sync-fence-v1.json"),
            ("HEAD", "attachments/a.pdf"),
            ("PROPFIND", "attachments/"),
            ("DELETE", "data.json.enc.bak"),
        ] {
            assert!(check(folder, &format!("{folder}/{name}"), method));
        }
        for (url, method) in [
            (
                "http://127.0.0.1:6807/webdav/data/webDAV/mindwtr/data.json",
                "GET",
            ),
            (
                "http://127.0.0.1:6806/webdav/data/webDAV/other/data.json",
                "GET",
            ),
            (
                "http://127.0.0.1:6806/webdav/data/webDAV/mindwtr/notes.txt",
                "DELETE",
            ),
            (
                "http://127.0.0.1:6806/webdav/data/webDAV/mindwtr/attachments/a%2fb",
                "PUT",
            ),
            (
                "http://127.0.0.1:6806/webdav/data/webDAV/mindwtr/data.json",
                "POST",
            ),
        ] {
            assert!(!check(folder, url, method));
        }
    }
}
