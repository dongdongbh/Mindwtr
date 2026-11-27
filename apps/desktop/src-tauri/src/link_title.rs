use reqwest::{dns, header, redirect::Policy, Client, Url};
use std::io;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const MAX_URL_BYTES: usize = 4096;
const MAX_HTML_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const LINK_TITLE_USER_AGENT: &str = "Mindwtr (Desktop; +https://github.com/dongdongbh/Mindwtr)";
static LOOKUP_LIMIT: Semaphore = Semaphore::const_new(4);
static DNS_LIMIT: Semaphore = Semaphore::const_new(4);

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => !matches!(
            ip.octets(),
            [0 | 10 | 127 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [169, 254, ..]
                | [172, 16..=31, ..]
                | [192, 0, 0 | 2, _]
                | [192, 88, 99, _]
                | [192, 168, ..]
                | [198, 18 | 19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        ),
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            first & 0xe000 == 0x2000
                && !matches!(first, 0x2002 | 0x3fff)
                && !(first == 0x2001 && (second <= 0x01ff || second == 0x0db8))
        }
    }
}

fn is_public_domain(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    host.rsplit_once('.').is_some_and(|(_, suffix)| {
        !matches!(
            suffix,
            "localhost"
                | "local"
                | "localdomain"
                | "internal"
                | "intranet"
                | "lan"
                | "home"
                | "onion"
                | "arpa"
                | "test"
                | "example"
                | "invalid"
        )
    })
}

fn public_page_url(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    let port = match url.scheme() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    if url.port_or_known_default() != Some(port)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let is_public = match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) => is_public_ip(ip),
        Err(_) => is_public_domain(host),
    };
    if !is_public {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

struct PublicPageDns;

impl dns::Resolve for PublicPageDns {
    fn resolve(&self, name: dns::Name) -> dns::Resolving {
        Box::pin(async move {
            let name = name.as_str();
            if !is_public_domain(name) {
                return Err(io::Error::other("Non-public page hostname").into());
            }
            let permit = DNS_LIMIT.try_acquire()?;
            let host = name.to_owned();
            let addresses = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                (host.as_str(), 0).to_socket_addrs()
            })
            .await??;
            let addresses: Vec<_> = addresses.collect();
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
                return Err(io::Error::other("Non-public page address").into());
            }
            Ok(Box::new(addresses.into_iter()) as dns::Addrs)
        })
    }
}

fn link_title_client() -> Option<Client> {
    Client::builder()
        .dns_resolver(Arc::new(PublicPageDns))
        .user_agent(LINK_TITLE_USER_AGENT)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .referer(false)
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok()
}

#[tauri::command]
pub(crate) async fn load_public_link_html(
    window: tauri::WebviewWindow,
    url: String,
) -> Option<String> {
    if window.label() != "main" {
        return None;
    }
    let url = public_page_url(&url)?;
    let _permit = LOOKUP_LIMIT.try_acquire().ok()?;
    let mut response = link_title_client()?
        .get(url)
        .header(header::ACCEPT, "text/html, application/xhtml+xml")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .ok()?;
    let media_type = response
        .headers()
        .get(header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim();
    if !response.status().is_success()
        || !(media_type.eq_ignore_ascii_case("text/html")
            || media_type.eq_ignore_ascii_case("application/xhtml+xml"))
    {
        return None;
    }
    let mut html = Vec::new();
    while html.len() < MAX_HTML_BYTES {
        let Some(chunk) = response.chunk().await.ok()? else {
            break;
        };
        let limit = (MAX_HTML_BYTES - html.len()).min(chunk.len());
        html.extend_from_slice(&chunk[..limit]);
    }
    Some(String::from_utf8_lossy(&html).into_owned())
}

#[cfg(test)]
mod tests {
    use super::{link_title_client, public_page_url};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn link_lookup_names_mindwtr_in_the_user_agent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            String::from_utf8_lossy(&request[..read]).to_ascii_lowercase()
        });
        link_title_client()
            .unwrap()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(
            request.contains(
                "\r\nuser-agent: mindwtr (desktop; +https://github.com/dongdongbh/mindwtr)\r\n"
            ),
            "{request}"
        );
    }

    #[test]
    fn link_lookup_skips_nonpublic_destinations_and_non_web_ports() {
        for url in [
            "file:///etc/hosts",
            "https://name:token@example.org/",
            "http://example.org:3000/",
            "http://router/",
            "http://host.localhost./",
            "http://host.local/",
            "http://host.home.arpa/",
            "http://127.1/",
            "http://0x7f000001/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://192.168.0.1/",
            "http://[::ffff:10.0.0.1]/",
            "http://[fd00::1]/",
            "http://[2002:7f00:1::]/",
        ] {
            assert!(public_page_url(url).is_none(), "{url}");
        }
        let url = public_page_url("https://example.org:443/path?query=1#part").unwrap();
        assert_eq!(url.as_str(), "https://example.org/path?query=1");
        assert!(public_page_url("http://1.1.1.1/").is_some());
        assert!(public_page_url("https://[2606:4700::1111]/").is_some());
    }
}
