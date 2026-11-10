//! Local addition: record each forwarded request and its response for an
//! outside consumer (NanoClaw's per-session ontology expansion).
//!
//! Off unless `GATEWAY_CAPTURE_DIR` is set. Each forwarded HTTP request whose
//! host is not excluded becomes one JSON line in `<dir>/<YYYYMMDDHH>.jsonl`
//! (UTC hour, file mode 0600), written when the response body has been fully
//! relayed (or the client went away). Recording never delays or changes the
//! request: bodies are copied as they stream past, up to a cap.
//!
//! What a record holds, and what it never holds:
//! - the request as the agent sent it — headers before the gateway injects
//!   credentials (minus `authorization`, `x-api-key`, `cookie`, proxy
//!   headers), the body before any provider transform;
//! - the response status, headers (minus `set-cookie`) and body, gzip
//!   decoded;
//! - bodies pass through [`summary::mask_secrets`] (secret-named JSON / form
//!   values become `***`); Vercel environment-variable values are withheld;
//! - the URL's query is masked like the gateway's log lines.
//!
//! Env:
//! - `GATEWAY_CAPTURE_DIR` — directory to write to (enables capture);
//! - `GATEWAY_CAPTURE_EXCLUDE` — comma-separated hosts, `*.` prefix allowed
//!   (default `api.anthropic.com,*.datadoghq.com`);
//! - `GATEWAY_CAPTURE_MAX_BODY` — bytes kept per body (default 1 MiB).
//!
//! Ids are `<unix ms, 13 digits>-<sequence, 6 digits>`: they sort in time
//! order, so a consumer keeps its place with the last id it handled.

use std::io::Write as _;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::task::{Context, Poll};

use futures_util::StreamExt;
use hyper::body::{Bytes, Frame};
use hyper::HeaderMap;
use serde_json::{json, Map, Value};

use context::ProxyContext;

const DEFAULT_EXCLUDE: &str = "api.anthropic.com,*.datadoghq.com";
const DEFAULT_MAX_BODY: usize = 1024 * 1024;

const DROPPED_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "cookie",
    "proxy-connection",
];
const DROPPED_RESPONSE_HEADERS: &[&str] = &["set-cookie"];

struct Config {
    dir: PathBuf,
    exclude: Vec<String>,
    max_body: usize,
    writer: Mutex<mpsc::Sender<(String, String)>>,
}

fn config() -> Option<&'static Config> {
    static CONFIG: OnceLock<Option<Config>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let dir = std::env::var("GATEWAY_CAPTURE_DIR").ok().filter(|d| !d.is_empty())?;
            let dir = PathBuf::from(dir);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                tracing::warn!(error = %e, dir = %dir.display(), "capture directory unusable; capture off");
                return None;
            }
            let exclude = std::env::var("GATEWAY_CAPTURE_EXCLUDE")
                .unwrap_or_else(|_| DEFAULT_EXCLUDE.to_string())
                .split(',')
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect();
            let max_body = std::env::var("GATEWAY_CAPTURE_MAX_BODY")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_MAX_BODY);
            let (tx, rx) = mpsc::channel::<(String, String)>();
            let writer_dir = dir.clone();
            std::thread::Builder::new()
                .name("capture-writer".into())
                .spawn(move || write_loop(&writer_dir, rx))
                .ok()?;
            tracing::info!(dir = %dir.display(), "recording forwarded requests (GATEWAY_CAPTURE_DIR)");
            Some(Config {
                dir,
                exclude,
                max_body,
                writer: Mutex::new(tx),
            })
        })
        .as_ref()
}

fn write_loop(dir: &std::path::Path, rx: mpsc::Receiver<(String, String)>) {
    use std::os::unix::fs::OpenOptionsExt as _;
    for (file, line) in rx {
        let path = dir.join(file);
        let opened = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path);
        match opened {
            Ok(mut f) => {
                if let Err(e) = f.write_all(line.as_bytes()) {
                    tracing::warn!(error = %e, path = %path.display(), "capture write failed");
                }
            }
            Err(e) => tracing::warn!(error = %e, path = %path.display(), "capture file unusable"),
        }
    }
}

fn excluded(exclude: &[String], host: &str) -> bool {
    let host = common::util::strip_port(host).to_ascii_lowercase();
    exclude.iter().any(|pattern| match pattern.strip_prefix("*.") {
        Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
        None => host == *pattern,
    })
}

fn header_map(headers: &HeaderMap, dropped: &[&str]) -> Value {
    let mut out = Map::new();
    for (name, value) in headers {
        if dropped.contains(&name.as_str()) {
            continue;
        }
        let v = Value::String(value.to_str().unwrap_or("<non-text>").to_string());
        match out.get_mut(name.as_str()) {
            Some(Value::Array(list)) => list.push(v),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, v]);
            }
            None => {
                out.insert(name.as_str().to_string(), v);
            }
        }
    }
    Value::Object(out)
}

#[derive(Default)]
struct Body {
    bytes: Vec<u8>,
    total: usize,
}

impl Body {
    fn push(&mut self, chunk: &[u8], max: usize) {
        self.total += chunk.len();
        let room = max.saturating_sub(self.bytes.len());
        self.bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

struct State {
    request: Body,
    response: Body,
    status: Option<u16>,
    response_headers: Option<HeaderMap>,
    response_complete: bool,
}

/// One request being recorded. Shared by the request-body and response-body
/// copies; the record is written when the last copy is dropped.
pub struct Capture {
    id: String,
    started: std::time::Instant,
    file: String,
    record: Map<String, Value>,
    request_headers: HeaderMap,
    host: String,
    path: String,
    max_body: usize,
    state: Mutex<State>,
}

pub type Handle = Option<Arc<Capture>>;

/// Begin recording a request, if capture is on and the host is not excluded.
/// `url` is the log-masked URL; `request_headers` are the agent's own
/// (before injection).
pub fn start(
    proxy_ctx: &ProxyContext,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    request_headers: &HeaderMap,
) -> Handle {
    let cfg = config()?;
    if excluded(&cfg.exclude, host) {
        return None;
    }
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = time::OffsetDateTime::now_utc();
    let ms = (now.unix_timestamp_nanos() / 1_000_000) as u64;
    let id = format!("{ms:013}-{:06}", SEQ.fetch_add(1, Ordering::Relaxed) % 1_000_000);
    let file = format!(
        "{:04}{:02}{:02}{:02}.jsonl",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour()
    );
    let ts = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    );
    let mut record = Map::new();
    record.insert("id".into(), json!(id));
    record.insert("ts".into(), json!(ts));
    record.insert(
        "agent".into(),
        json!({
            "id": proxy_ctx.agent_id,
            "identifier": proxy_ctx.agent_identifier,
            "name": proxy_ctx.agent_name,
        }),
    );
    record.insert("method".into(), json!(method));
    record.insert("host".into(), json!(common::util::strip_port(host)));
    record.insert("url".into(), json!(url));
    Some(Arc::new(Capture {
        id,
        started: std::time::Instant::now(),
        file,
        record,
        request_headers: request_headers.clone(),
        host: common::util::strip_port(host).to_ascii_lowercase(),
        path: path.split('?').next().unwrap_or("").to_string(),
        max_body: cfg.max_body,
        state: Mutex::new(State {
            request: Body::default(),
            response: Body::default(),
            status: None,
            response_headers: None,
            response_complete: false,
        }),
    }))
}

impl Capture {
    fn with_state(&self, f: impl FnOnce(&mut State)) {
        if let Ok(mut s) = self.state.lock() {
            f(&mut s);
        }
    }

    /// The response head, before its body streams.
    pub fn response_head(&self, status: u16, headers: &HeaderMap) {
        self.with_state(|s| {
            s.status = Some(status);
            s.response_headers = Some(headers.clone());
        });
    }

    /// A response that was read whole before relaying.
    pub fn response_whole(&self, status: u16, headers: &HeaderMap, body: &[u8]) {
        let max = self.max_body;
        self.with_state(|s| {
            s.status = Some(status);
            s.response_headers = Some(headers.clone());
            s.response.push(body, max);
            s.response_complete = true;
        });
    }

    /// Vercel environment-variable endpoints answer with variable values
    /// (decrypted on request): withhold those bodies entirely.
    fn withheld(&self) -> Option<&'static str> {
        (self.host == "api.vercel.com" && self.path.contains("/env"))
            .then_some("withheld: Vercel environment-variable values")
    }

    fn body_value(&self, body: &Body, headers: Option<&HeaderMap>, complete: bool) -> Value {
        if body.total == 0 {
            return json!({ "bytes": 0 });
        }
        let truncated = body.total > body.bytes.len() || !complete;
        if let Some(why) = self.withheld() {
            return json!({ "bytes": body.total, "truncated": truncated, "withheld": why });
        }
        let decoded = match headers {
            Some(h) => crate::body::decoded(h, &body.bytes, self.max_body),
            None => Some(body.bytes.clone()),
        };
        match decoded.map(String::from_utf8) {
            Some(Ok(text)) => {
                let (masked, hit) = summary::mask_secrets(&text);
                json!({ "bytes": body.total, "truncated": truncated, "text": masked, "masked": hit })
            }
            Some(Err(_)) => json!({ "bytes": body.total, "truncated": truncated, "binary": true }),
            None => json!({ "bytes": body.total, "truncated": truncated, "undecoded_encoding": true }),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let Some(cfg) = config() else { return };
        let mut record = std::mem::take(&mut self.record);
        let Ok(state) = self.state.lock() else { return };
        record.insert(
            "latency_ms".into(),
            json!(self.started.elapsed().as_millis() as u64),
        );
        record.insert(
            "request".into(),
            json!({
                "headers": header_map(&self.request_headers, DROPPED_REQUEST_HEADERS),
                "body": self.body_value(&state.request, Some(&self.request_headers), true),
            }),
        );
        record.insert(
            "response".into(),
            json!({
                "status": state.status,
                "headers": state.response_headers.as_ref().map(|h| header_map(h, DROPPED_RESPONSE_HEADERS)),
                "body": self.body_value(&state.response, state.response_headers.as_ref(), state.response_complete),
                "complete": state.response_complete,
            }),
        );
        let mut line = Value::Object(record).to_string();
        line.push('\n');
        if let Ok(tx) = cfg.writer.lock() {
            if tx.send((self.file.clone(), line)).is_err() {
                tracing::warn!(id = %self.id, "capture writer gone; record dropped");
            }
        }
    }
}

/// The request body, copied into the record as it streams to the upstream.
/// Size hints pass through, so a known `content-length` is kept.
pub fn tee_request(handle: &Handle, body: reqwest::Body) -> reqwest::Body {
    match handle {
        Some(cap) => reqwest::Body::wrap(TeeBody {
            inner: body,
            cap: cap.clone(),
        }),
        None => body,
    }
}

struct TeeBody {
    inner: reqwest::Body,
    cap: Arc<Capture>,
}

impl hyper::body::Body for TeeBody {
    type Data = Bytes;
    type Error = reqwest::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled {
            if let Some(data) = frame.data_ref() {
                let max = self.cap.max_body;
                self.cap.with_state(|s| s.request.push(data, max));
            }
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

/// The response body, copied into the record as it streams to the agent.
pub fn tee_response<S>(
    handle: &Handle,
    status: u16,
    headers: &HeaderMap,
    stream: S,
) -> futures_util::stream::BoxStream<'static, Result<Bytes, reqwest::Error>>
where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    let Some(cap) = handle.clone() else {
        return stream.boxed();
    };
    cap.response_head(status, headers);
    let end = cap.clone();
    stream
        .inspect(move |item| {
            if let Ok(chunk) = item {
                let max = cap.max_body;
                cap.with_state(|s| s.response.push(chunk, max));
            }
        })
        .chain(futures_util::stream::poll_fn(move |_| {
            end.with_state(|s| s.response_complete = true);
            Poll::Ready(None)
        }))
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_matches_exact_hosts_and_suffixes() {
        let ex: Vec<String> = DEFAULT_EXCLUDE.split(',').map(String::from).collect();
        assert!(excluded(&ex, "api.anthropic.com:443"));
        assert!(excluded(&ex, "http-intake.logs.us5.datadoghq.com:443"));
        assert!(!excluded(&ex, "api.githubcopilot.com:443"));
        assert!(!excluded(&ex, "anthropic.com"));
    }

    #[test]
    fn body_keeps_the_first_max_bytes_and_counts_all() {
        let mut b = Body::default();
        b.push(b"hello", 3);
        b.push(b"world", 3);
        assert_eq!(b.bytes, b"hel");
        assert_eq!(b.total, 10);
    }

    #[test]
    fn dropped_headers_never_reach_the_record() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer x".parse().unwrap());
        h.insert("accept", "application/json".parse().unwrap());
        let v = header_map(&h, DROPPED_REQUEST_HEADERS);
        assert!(v.get("authorization").is_none());
        assert_eq!(v["accept"], "application/json");
    }
}
