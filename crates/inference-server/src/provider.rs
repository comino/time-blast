//! Direct pooled OpenAI-compatible streaming HTTP (OpenRouter or any Chat Completions
//! endpoint). Dropping the future returned by [`Provider::stream`] drops the response body,
//! which resets the HTTP/2 stream (or closes the HTTP/1 connection) upstream immediately.
use futures_util::StreamExt;
use reqwest::{Client, header};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Semaphore, SemaphorePermit};

const MAX_STREAM_BYTES: usize = 1_048_576;
const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_OUTPUT_BYTES: usize = 32_768;

/// OpenRouter's unified effort values. Availability is model-specific: `none`
/// disables reasoning only on models that allow it; `minimal` still reasons.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
}

pub struct ProviderConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub openrouter: bool,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub temperature: Option<f64>,
    pub max_tokens: u32,
    pub timeout: Duration,
    pub max_concurrent: usize,
    /// Extra top-level request fields (`TIME_BLAST_REQUEST_EXTRA`), merged last: e.g. an
    /// OpenRouter `provider` routing object (replaces the default), `service_tier`, `verbosity`.
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderError {
    pub code: &'static str,
    pub message: String,
}

pub fn error(code: &'static str, message: impl Into<String>) -> ProviderError {
    ProviderError {
        code,
        message: message.into(),
    }
}
fn upstream(message: impl Into<String>) -> ProviderError {
    error("upstream", message)
}

#[derive(Clone)]
pub struct Provider {
    inner: Arc<Inner>,
}
struct Inner {
    client: Client,
    config: ProviderConfig,
    slots: Semaphore,
}

#[derive(Default, Debug, Clone, PartialEq)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Default, Debug)]
pub struct Completion {
    pub content: String,
    pub finish_reason: Option<String>,
    pub refused: bool,
    pub tool_call: bool,
    pub model: Option<String>,
    pub usage: Usage,
}

impl Provider {
    pub fn new(config: ProviderConfig) -> Result<Self, String> {
        let url =
            reqwest::Url::parse(&config.endpoint).map_err(|_| "Invalid provider endpoint.")?;
        if !["https", "http"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || config.model.trim().is_empty()
            || config.model.len() > 200
            || config.max_concurrent == 0
            || config.max_concurrent > 1024
            || config.max_tokens == 0
            || config.timeout.is_zero()
            || (!config.openrouter && config.reasoning_effort.is_some())
            || config
                .temperature
                .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        {
            return Err("Invalid provider configuration.".into());
        }
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static("text/event-stream"),
        );
        if let Some(key) = &config.api_key {
            let mut value = header::HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| "Invalid provider credential header.")?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(config.max_concurrent)
            .http2_adaptive_window(true)
            .connect_timeout(config.timeout.min(Duration::from_secs(10)))
            .build()
            .map_err(|_| "Could not create provider HTTP client.")?;
        let slots = Semaphore::new(config.max_concurrent);
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                config,
                slots,
            }),
        })
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.inner.config
    }

    /// Establish DNS/TCP/TLS and a reusable connection without buying a generation.
    pub async fn warm_connection(&self) -> Result<(), String> {
        let limit = self.inner.config.timeout.min(Duration::from_secs(3));
        match tokio::time::timeout(
            limit,
            self.inner.client.head(&self.inner.config.endpoint).send(),
        )
        .await
        {
            Ok(Ok(_response)) => Ok(()),
            _ => Err("Provider connection warmup did not complete.".into()),
        }
    }

    /// Reserve one of the process-wide upstream slots, or fail fast.
    pub fn slot(&self) -> Result<SemaphorePermit<'_>, ProviderError> {
        self.inner
            .slots
            .try_acquire()
            .map_err(|_| error("busy", "All upstream slots are busy."))
    }

    pub fn request_body(&self, messages: &[Value]) -> Value {
        let config = &self.inner.config;
        let mut request = json!({"model":config.model,"messages":messages,
            "max_tokens":config.max_tokens,"stream":true,"stream_options":{"include_usage":true}});
        if let Some(temperature) = config.temperature {
            request["temperature"] = json!(temperature);
        }
        if config.openrouter {
            request["provider"] = json!({"sort":"latency","require_parameters":true});
            if let Some(effort) = config.reasoning_effort {
                request["reasoning"] = json!({"effort":effort});
            }
        }
        for (key, value) in &config.extra {
            request[key.as_str()] = value.clone();
        }
        request
    }

    /// Stream one completion. `on_content` sees every content fragment as it arrives.
    pub async fn stream(
        &self,
        messages: &[Value],
        mut on_content: impl FnMut(&str),
    ) -> Result<Completion, ProviderError> {
        let response = self
            .inner
            .client
            .post(&self.inner.config.endpoint)
            .json(&self.request_body(messages))
            .send()
            .await
            .map_err(|_| upstream("Could not reach the inference provider."))?;
        if !response.status().is_success() {
            // Provider bodies may echo credentials or input. Return only the status.
            return Err(upstream(format!(
                "Inference provider returned HTTP {}.",
                response.status().as_u16()
            )));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_type
            .split(';')
            .next()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
        {
            return Err(upstream(
                "Inference provider did not return an event stream.",
            ));
        }
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| upstream("The inference provider stream was interrupted."))?;
            decoder.feed(&chunk, &mut on_content)?;
            if decoder.done {
                break;
            }
        }
        decoder.finish()
    }
}

/// Byte-wise SSE line framing: handles CR/LF and split UTF-8; limits apply before allocation.
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    frame_bytes: usize,
    total_bytes: usize,
    previous_cr: bool,
    done: bool,
    output: Completion,
}

impl SseDecoder {
    fn feed(
        &mut self,
        bytes: &[u8],
        on_content: &mut impl FnMut(&str),
    ) -> Result<(), ProviderError> {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        if self.total_bytes > MAX_STREAM_BYTES {
            return Err(upstream("Provider stream exceeded its size limit."));
        }
        for &byte in bytes {
            if byte == b'\n' && self.previous_cr {
                self.previous_cr = false;
                continue;
            }
            self.previous_cr = false;
            self.frame_bytes += 1;
            if self.frame_bytes > MAX_FRAME_BYTES {
                return Err(upstream("Provider event exceeded its size limit."));
            }
            if byte == b'\n' || byte == b'\r' {
                self.previous_cr = byte == b'\r';
                self.line_complete(on_content)?;
            } else {
                self.line.push(byte);
            }
        }
        Ok(())
    }

    fn line_complete(&mut self, on_content: &mut impl FnMut(&str)) -> Result<(), ProviderError> {
        if self.line.is_empty() {
            if !self.data.is_empty() {
                self.data.pop(); // the SSE-added final newline
                let data = std::mem::take(&mut self.data);
                self.event(&data, on_content)?;
                self.data = data;
                self.data.clear();
            }
            self.frame_bytes = 0;
            return Ok(());
        }
        std::str::from_utf8(&self.line)
            .map_err(|_| upstream("Provider event contains invalid UTF-8."))?;
        if let Some(mut data) = self.line.strip_prefix(b"data:") {
            if data.first() == Some(&b' ') {
                data = &data[1..];
            }
            self.data.extend_from_slice(data);
            self.data.push(b'\n');
        } else if self.line == b"data" {
            self.data.push(b'\n');
        }
        self.line.clear();
        Ok(())
    }

    fn event(
        &mut self,
        data: &[u8],
        on_content: &mut impl FnMut(&str),
    ) -> Result<(), ProviderError> {
        if data.is_empty() {
            return Ok(());
        }
        if self.done {
            return Err(upstream("Provider sent data after stream completion."));
        }
        if data == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_slice(data)
            .map_err(|_| upstream("Provider event contains invalid JSON."))?;
        if value.get("error").is_some() {
            return Err(upstream("The inference provider reported a stream error."));
        }
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            if model.len() <= 200 {
                self.output.model = Some(model.to_owned());
            }
        }
        if let Some(usage) = value.get("usage").filter(|v| v.is_object()) {
            self.output.usage = parse_usage(usage);
        }
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            // Usage-only events may omit choices entirely.
            return if value.get("usage").is_some() {
                Ok(())
            } else {
                Err(upstream("Provider event is missing completion choices."))
            };
        };
        if choices.is_empty() {
            return Ok(());
        }
        if choices.len() != 1 || choices[0].get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
            return Err(upstream("Provider returned unexpected completion choices."));
        }
        let choice = &choices[0];
        if let Some(delta) = choice.get("delta").filter(|v| !v.is_null()) {
            if let Some(content) = delta.get("content").filter(|v| !v.is_null()) {
                let content = content
                    .as_str()
                    .ok_or_else(|| upstream("Provider returned a non-text completion."))?;
                if !content.is_empty() {
                    if self.output.finish_reason.is_some() {
                        return Err(upstream("Provider continued content after completion."));
                    }
                    if self.output.content.len() + content.len() > MAX_OUTPUT_BYTES {
                        return Err(upstream("Model output exceeded its size limit."));
                    }
                    self.output.content.push_str(content);
                    on_content(content);
                }
            }
            if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
                self.output.refused |= !refusal.is_empty();
            }
            self.output.tool_call |= delta.get("tool_calls").is_some_and(|v| !v.is_null())
                || delta.get("function_call").is_some_and(|v| !v.is_null());
        }
        if let Some(reason) = choice.get("finish_reason").filter(|v| !v.is_null()) {
            let reason = reason
                .as_str()
                .filter(|r| r.len() <= 64)
                .ok_or_else(|| upstream("Provider returned an invalid completion reason."))?;
            match self.output.finish_reason.as_deref() {
                // OpenRouter repeats the same marker in its final usage event.
                Some(previous)
                    if previous != reason || !value.get("usage").is_some_and(Value::is_object) =>
                {
                    return Err(upstream(
                        "Provider repeated or changed its completion marker.",
                    ));
                }
                Some(_) => {}
                None => self.output.finish_reason = Some(reason.to_string()),
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<Completion, ProviderError> {
        if !self.line.is_empty() || !self.data.is_empty() || self.output.finish_reason.is_none() {
            return Err(upstream(
                "Provider stream ended without a complete terminal response.",
            ));
        }
        Ok(self.output)
    }
}

fn count(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|n| *n <= 9_007_199_254_740_991)
}

/// OpenAI/OpenRouter usage: `prompt_tokens_details.cached_tokens` and, on OpenRouter,
/// `cost` in USD credits. Missing fields stay None; nothing is estimated.
fn parse_usage(usage: &Value) -> Usage {
    Usage {
        prompt_tokens: count(usage.get("prompt_tokens")),
        completion_tokens: count(usage.get("completion_tokens")),
        cached_tokens: count(usage.pointer("/prompt_tokens_details/cached_tokens")),
        reasoning_tokens: count(usage.pointer("/completion_tokens_details/reasoning_tokens")),
        cost_usd: usage
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c >= 0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(value: Value) -> String {
        format!("data: {}\n\n", value)
    }
    fn chunk(content: &str) -> Value {
        json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":null}]})
    }
    fn terminal(reason: &str) -> String {
        event(json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]}))
    }
    fn decode(raw: &str, step: usize) -> (Result<Completion, ProviderError>, Vec<String>) {
        let mut seen = Vec::new();
        let mut decoder = SseDecoder::default();
        for part in raw.as_bytes().chunks(step) {
            if let Err(e) = decoder.feed(part, &mut |c: &str| seen.push(c.to_string())) {
                return (Err(e), seen);
            }
        }
        (decoder.finish(), seen)
    }

    #[test]
    fn fragmented_utf8_crlf_comments_and_usage_are_streamed() {
        let raw = format!(
            ": keepalive\r\n\r\n{}{}{}{}data: [DONE]\r\n\r\n",
            event(chunk("SELECT '船'")),
            event(chunk(" AS x")),
            terminal("stop"),
            event(
                json!({"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":4,
                "prompt_tokens_details":{"cached_tokens":1024},"cost":0.0000512,
                "completion_tokens_details":{"reasoning_tokens":0}}})
            )
        );
        let (output, seen) = decode(&raw, 1);
        let output = output.unwrap();
        assert_eq!(output.content, "SELECT '船' AS x");
        assert_eq!(seen, vec!["SELECT '船'", " AS x"]);
        assert_eq!(
            output.usage,
            Usage {
                prompt_tokens: Some(1200),
                completion_tokens: Some(4),
                cached_tokens: Some(1024),
                reasoning_tokens: Some(0),
                cost_usd: Some(0.0000512)
            }
        );
    }

    #[test]
    fn openrouter_final_usage_may_repeat_the_terminal_choice() {
        let usage = event(
            json!({"choices":[{"index":0,"delta":{"content":"","role":"assistant"},
            "finish_reason":"stop"}],"usage":{"prompt_tokens":18,"completion_tokens":5,"cost":0.00001}}),
        );
        let raw = format!(
            "{}{}{}data: [DONE]\n\n",
            event(chunk("SELECT 1")),
            terminal("stop"),
            usage
        );
        let (output, _) = decode(&raw, 7);
        let output = output.unwrap();
        assert_eq!(output.finish_reason.as_deref(), Some("stop"));
        assert_eq!(output.usage.cost_usd, Some(0.00001));
        assert_eq!(
            output.usage.cached_tokens, None,
            "missing usage is never fabricated"
        );
    }

    #[test]
    fn incomplete_streams_errors_and_post_terminal_content_fail() {
        for raw in [
            event(chunk("SELECT 1")),
            format!("{}data: [DONE]\n\n", event(chunk("SELECT 1"))),
            event(json!({"error":{"message":"private upstream details"}})),
            format!("{}{}", terminal("stop"), event(chunk("x"))),
            "data: invalid\n\n".into(),
            format!(
                "{}{}",
                terminal("stop"),
                event(
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{}})
                )
            ),
        ] {
            let (output, _) = decode(&raw, 3);
            match output {
                Err(e) => assert!(!e.message.contains("private")),
                Ok(_) => panic!("accepted {raw:?}"),
            }
        }
    }

    #[test]
    fn byte_and_output_limits_are_enforced() {
        assert!(
            decode(&":".repeat(MAX_FRAME_BYTES + 1), MAX_FRAME_BYTES + 1)
                .0
                .is_err()
        );
        assert!(
            decode(&event(chunk(&"x".repeat(MAX_OUTPUT_BYTES + 1))), 1 << 20)
                .0
                .is_err()
        );
        let mut d = SseDecoder::default();
        assert!(d.feed(b"data: \xff\n\n", &mut |_: &str| {}).is_err());
    }

    #[test]
    fn length_refusal_and_tool_calls_are_marked() {
        let raw = format!(
            "{}{}",
            event(json!({"choices":[{"index":0,"delta":{"refusal":"no","tool_calls":[]}}]})),
            terminal("length")
        );
        let output = decode(&raw, 64).0.unwrap();
        assert!(output.refused && output.tool_call);
        assert_eq!(output.finish_reason.as_deref(), Some("length"));
    }

    fn config(
        openrouter: bool,
        effort: Option<ReasoningEffort>,
        temperature: Option<f64>,
    ) -> ProviderConfig {
        ProviderConfig {
            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            model: "m".into(),
            api_key: None,
            openrouter,
            reasoning_effort: effort,
            temperature,
            max_tokens: 300,
            timeout: Duration::from_secs(1),
            max_concurrent: 1,
            extra: Default::default(),
        }
    }

    #[test]
    fn request_body_streams_bounded_and_deterministic() {
        let p = Provider::new(config(true, Some(ReasoningEffort::None), Some(0.0))).unwrap();
        let body = p.request_body(&[json!({"role":"user","content":"q"})]);
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 300);
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["reasoning"], json!({"effort":"none"}));
        assert_eq!(
            body["provider"],
            json!({"sort":"latency","require_parameters":true})
        );
        assert!(body.get("response_format").is_none());
        let p = Provider::new(config(false, None, None)).unwrap();
        let body = p.request_body(&[]);
        assert!(body.get("temperature").is_none() && body.get("provider").is_none());
        assert!(Provider::new(config(false, Some(ReasoningEffort::Low), None)).is_err());
        assert!(Provider::new(config(true, None, Some(f64::NAN))).is_err());
    }

    #[test]
    fn request_extra_replaces_routing_and_adds_fields() {
        let mut c = config(true, None, Some(0.0));
        c.extra = json!({"provider":{"only":["cerebras"]},"service_tier":"priority"})
            .as_object()
            .unwrap()
            .clone();
        let body = Provider::new(c).unwrap().request_body(&[]);
        assert_eq!(body["provider"], json!({"only":["cerebras"]}));
        assert_eq!(body["service_tier"], "priority");
        assert_eq!(body["stream"], true);
    }
}
