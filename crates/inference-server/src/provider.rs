//! Direct pooled OpenAI-compatible streaming HTTP. No agent framework or SQL execution.
use crate::plan::{
    self, DatasetContext, Draft, ErrorKind, InferenceDiagnostics, InferenceError,
    InferenceResponse, ModelResponseFailure,
};
use futures_util::StreamExt;
use reqwest::{Client, header};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const MAX_STREAM_BYTES: usize = 1_048_576;
const MAX_FRAME_BYTES: usize = 65_536;
const MAX_COMPLETION_TOKENS: u32 = 256;

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
    pub timeout: Duration,
    pub max_concurrent: usize,
}

#[derive(Clone)]
pub struct Provider {
    inner: Arc<Inner>,
}
struct Inner {
    client: Client,
    config: ProviderConfig,
    slots: Semaphore,
    response_format: Value,
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
        let response_format = json!({"type":"json_schema","json_schema":{
            "name":"time_blast_query","strict":true,"schema":plan::response_schema()
        }});
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                config,
                slots,
                response_format,
            }),
        })
    }

    /// Establish DNS/TCP/TLS and a reusable provider connection without buying a
    /// generation. Any HTTP status proves transport only, not model readiness.
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

    pub async fn infer(
        &self,
        context: &DatasetContext,
        draft: &Draft,
        cancel: CancellationToken,
    ) -> Result<InferenceResponse, InferenceError> {
        let start = Instant::now();
        context
            .validate()
            .and_then(|_| draft.validate(context))
            .map_err(InferenceError::new)?;
        if cancel.is_cancelled() {
            return Err(InferenceError::with_kind(
                ErrorKind::Canceled,
                "Inference canceled.",
            ));
        }
        // Reject saturation instead of accumulating an unbounded speculative queue.
        let _slot = self.inner.slots.try_acquire().map_err(|_| {
            InferenceError::with_kind(
                ErrorKind::Busy,
                "Inference is busy; try again after the current request.",
            )
        })?;
        let mut diagnostics = InferenceDiagnostics {
            queue_ms: Some(ms(start.elapsed())),
            ..Default::default()
        };
        let generation_start = Instant::now();
        let mut repair_start = None;
        let remaining = self.inner.config.timeout.saturating_sub(start.elapsed());
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(InferenceError::with_kind(ErrorKind::Canceled, "Inference canceled.")),
            result = tokio::time::timeout(remaining, self.infer_inner(context, draft, &mut diagnostics, &mut repair_start, generation_start)) => {
                match result { Ok(result) => result, Err(_) => Err(InferenceError::with_kind(ErrorKind::Timeout, "Inference exceeded its total deadline.")) }
            }
        };
        diagnostics.generation_ms = Some(ms(generation_start.elapsed()));
        diagnostics.repair_ms = repair_start.map(|start: Instant| ms(start.elapsed()));
        match result {
            Ok(mut response) => {
                response.tokens = diagnostics.completion_tokens;
                response.diagnostics = diagnostics;
                Ok(response)
            }
            Err(mut error) => {
                error.model = Some(self.inner.config.model.clone());
                error.diagnostics = Some(diagnostics);
                Err(error)
            }
        }
    }

    async fn infer_inner(
        &self,
        context: &DatasetContext,
        draft: &Draft,
        diagnostics: &mut InferenceDiagnostics,
        repair_start: &mut Option<Instant>,
        generation_start: Instant,
    ) -> Result<InferenceResponse, InferenceError> {
        let mut messages = vec![
            json!({"role":"system","content":plan::system_prompt(context)}),
            json!({"role":"user","content":draft.text}),
        ];
        for attempt in 1..=2 {
            diagnostics.attempts = Some(attempt);
            if attempt == 2 {
                *repair_start = Some(Instant::now());
            }
            let output = self
                .generate(&messages, diagnostics, generation_start)
                .await?;
            add_count(&mut diagnostics.prompt_tokens, output.prompt_tokens);
            add_count(&mut diagnostics.completion_tokens, output.completion_tokens);
            let validation = if output.refused {
                Err("The model refused this request.".to_string())
            } else if output.finish_reason.as_deref() != Some("stop") {
                Err(format!(
                    "The model did not finish a complete answer (finish reason: {}).",
                    output.finish_reason.as_deref().unwrap_or("missing")
                ))
            } else if output.tool_call {
                Err("The model attempted a tool call; return only the query JSON.".to_string())
            } else {
                plan::parse_model_plan(&output.content, context)
            };
            match validation {
                Ok(plan) => {
                    return Ok(InferenceResponse {
                        plan,
                        model: output
                            .model
                            .unwrap_or_else(|| self.inner.config.model.clone()),
                        tokens: None,
                        diagnostics: InferenceDiagnostics::default(),
                    });
                }
                Err(message) if attempt == 1 => {
                    messages.push(json!({"role":"assistant","content":output.content}));
                    messages.push(json!({"role":"user","content":format!("Your previous answer failed validation: {message} Correct it once for the ORIGINAL request, preserving every supported requirement. Return the complete result wrapper JSON only; if unsupported, return {{\"result\":{{\"error\":\"unsupported_request\"}}}}.")}));
                }
                Err(message) => {
                    let mut error = InferenceError::with_kind(ErrorKind::InvalidModel, message);
                    error.response = Some(ModelResponseFailure {
                        text: output.content,
                        truncated: output.finish_reason.as_deref() == Some("length"),
                        finish_reason: output.finish_reason,
                    });
                    return Err(error);
                }
            }
        }
        unreachable!("one initial generation and at most one correction")
    }

    async fn generate(
        &self,
        messages: &[Value],
        diagnostics: &mut InferenceDiagnostics,
        generation_start: Instant,
    ) -> Result<StreamOutput, InferenceError> {
        let mut request = json!({"model":self.inner.config.model,"messages":messages,
            "max_tokens":MAX_COMPLETION_TOKENS,"stream":true,"stream_options":{"include_usage":true},
            "response_format":self.inner.response_format});
        if let Some(temperature) = self.inner.config.temperature {
            request["temperature"] = json!(temperature);
        }
        if self.inner.config.openrouter {
            request["provider"] = json!({"sort":"latency","require_parameters":true});
            // Leave model defaults untouched unless explicitly configured.
            // Omitting reasoning is not a promise that a model will not think.
            if let Some(effort) = self.inner.config.reasoning_effort {
                request["reasoning"] = json!({"effort":effort});
            }
        }
        let response = self
            .inner
            .client
            .post(&self.inner.config.endpoint)
            .json(&request)
            .send()
            .await
            .map_err(|_| upstream("Could not reach the inference provider."))?;
        if !response.status().is_success() {
            // Provider bodies and reqwest errors may contain credentials/URLs or
            // arbitrary echoed input. Return only the bounded status code.
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
            decoder.feed(&chunk)?;
            if diagnostics.first_token_ms.is_none() && !decoder.output.content.is_empty() {
                diagnostics.first_token_ms = Some(ms(generation_start.elapsed()));
            }
            if decoder.done {
                break;
            }
        }
        decoder.finish()
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
fn add_count(target: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *target = Some(target.unwrap_or(0).saturating_add(value));
    }
}
fn upstream(message: impl Into<String>) -> InferenceError {
    InferenceError::with_kind(ErrorKind::Upstream, message)
}

#[derive(Default, Debug)]
struct StreamOutput {
    content: String,
    finish_reason: Option<String>,
    refused: bool,
    tool_call: bool,
    model: Option<String>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

/// Byte-wise line framing handles CR/LF and split UTF-8 without ever decoding an
/// incomplete code point. Limits apply before allocation, including comments.
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    frame_bytes: usize,
    total_bytes: usize,
    previous_cr: bool,
    done: bool,
    output: StreamOutput,
}

impl SseDecoder {
    fn feed(&mut self, bytes: &[u8]) -> Result<(), InferenceError> {
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| upstream("Provider stream exceeded its size limit."))?;
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
                self.line_complete()?;
            } else {
                self.line.push(byte);
            }
        }
        Ok(())
    }

    fn line_complete(&mut self) -> Result<(), InferenceError> {
        if self.line.is_empty() {
            if !self.data.is_empty() {
                self.data.pop(); // Remove the SSE-added final newline.
                let data = std::mem::take(&mut self.data);
                self.event(&data)?;
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

    fn event(&mut self, data: &[u8]) -> Result<(), InferenceError> {
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
        if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
            self.output.prompt_tokens = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .filter(|n| *n <= 9_007_199_254_740_991);
            self.output.completion_tokens = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .filter(|n| *n <= 9_007_199_254_740_991);
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| upstream("Provider event is missing completion choices."))?;
        if choices.is_empty() {
            return Ok(());
        }
        if choices.len() != 1 || choices[0].get("index").and_then(Value::as_u64) != Some(0) {
            return Err(upstream("Provider returned unexpected completion choices."));
        }
        let choice = &choices[0];
        if let Some(delta) = choice.get("delta").filter(|v| !v.is_null()) {
            if let Some(content) = delta.get("content").filter(|v| !v.is_null()) {
                let content = content
                    .as_str()
                    .ok_or_else(|| upstream("Provider returned a non-text completion."))?;
                if !content.is_empty() && self.output.finish_reason.is_some() {
                    return Err(upstream("Provider continued content after completion."));
                }
                if self.output.content.len() + content.len() > plan::MAX_MODEL_BYTES {
                    return Err(upstream("Model output exceeded the plan size limit."));
                }
                self.output.content.push_str(content);
            }
            if let Some(refusal) = delta.get("refusal").filter(|v| !v.is_null()) {
                let refusal = refusal
                    .as_str()
                    .ok_or_else(|| upstream("Provider returned an invalid refusal."))?;
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
            if let Some(previous) = self.output.finish_reason.as_deref() {
                // OpenRouter includes the same completion marker again in its
                // final usage event. Accept that metadata-only repetition; a
                // changed reason, further content, or bare duplicate is invalid.
                if previous != reason || !value.get("usage").is_some_and(Value::is_object) {
                    return Err(upstream(
                        "Provider repeated or changed its completion marker.",
                    ));
                }
            } else {
                self.output.finish_reason = Some(reason.to_string());
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<StreamOutput, InferenceError> {
        // A valid-looking JSON prefix, [DONE] without a choice finish, or a lost
        // TCP stream never becomes executable. Length/refusal are corrected once.
        if !self.line.is_empty() || !self.data.is_empty() || self.output.finish_reason.is_none() {
            return Err(upstream(
                "Provider stream ended without a complete terminal response.",
            ));
        }
        Ok(self.output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::State,
        response::{IntoResponse, Response},
        routing::post,
        serve::ListenerExt,
    };
    use std::{collections::VecDeque, sync::Mutex};
    fn event(value: Value) -> String {
        format!("data: {}\n\n", value)
    }
    fn chunk(content: &str) -> Value {
        json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":null}]})
    }
    fn terminal(reason: &str) -> String {
        event(json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]}))
    }
    #[test]
    fn fragmented_utf8_crlf_comments_and_usage_are_streamed() {
        let raw = format!(
            ": keepalive\r\n\r\n{}{}{}data: [DONE]\r\n\r\n",
            event(chunk("船")),
            terminal("stop"),
            event(json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}))
        );
        let mut decoder = SseDecoder::default();
        for byte in raw.as_bytes() {
            decoder.feed(&[*byte]).unwrap();
        }
        let output = decoder.finish().unwrap();
        assert_eq!(output.content, "船");
        assert_eq!(output.completion_tokens, Some(4));
    }
    #[test]
    fn incomplete_or_nonterminal_json_never_executes() {
        for raw in [
            event(chunk("{}")),
            format!("{}data: [DONE]\n\n", event(chunk("{}"))),
            terminal("stop").trim_end().to_owned(),
        ] {
            let mut decoder = SseDecoder::default();
            decoder.feed(raw.as_bytes()).unwrap();
            assert!(decoder.finish().is_err());
        }
        let mut decoder = SseDecoder::default();
        decoder.feed(terminal("stop").as_bytes()).unwrap();
        assert!(decoder.finish().is_ok());
    }
    #[test]
    fn stream_error_and_post_terminal_content_fail() {
        for raw in [
            event(json!({"error":{"message":"private upstream details"}})),
            format!("{}{}", terminal("stop"), event(chunk("x"))),
            "data: invalid\n\n".into(),
        ] {
            assert!(SseDecoder::default().feed(raw.as_bytes()).is_err());
        }
    }
    #[test]
    fn openrouter_final_usage_may_repeat_same_empty_terminal_choice() {
        let usage = event(
            json!({"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"prompt_tokens":18,"completion_tokens":5}}),
        );
        let raw = format!(
            "{}{}{}data: [DONE]\n\n",
            event(chunk("{\"ok\":true}")),
            terminal("stop"),
            usage
        );
        let mut decoder = SseDecoder::default();
        for part in raw.as_bytes().chunks(7) {
            decoder.feed(part).unwrap();
        }
        let output = decoder.finish().unwrap();
        assert_eq!(output.finish_reason.as_deref(), Some("stop"));
        assert_eq!(output.content, "{\"ok\":true}");
        assert_eq!(output.prompt_tokens, Some(18));
        assert_eq!(output.completion_tokens, Some(5));
    }
    #[test]
    fn final_usage_cannot_change_reason_resume_content_or_mask_errors() {
        for final_event in [
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{}}),
            json!({"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{}}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
            json!({"error":{"message":"failed"},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}),
        ] {
            let raw = format!("{}{}", terminal("stop"), event(final_event));
            assert!(SseDecoder::default().feed(raw.as_bytes()).is_err());
        }
        let raw = format!(
            "{}{}",
            terminal("length"),
            event(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{}}))
        );
        assert!(SseDecoder::default().feed(raw.as_bytes()).is_err());
    }
    #[test]
    fn byte_and_output_limits_are_enforced() {
        assert!(
            SseDecoder::default()
                .feed(&vec![b':'; MAX_FRAME_BYTES + 1])
                .is_err()
        );
        assert!(
            SseDecoder::default()
                .feed(&vec![b'\n'; MAX_STREAM_BYTES + 1])
                .is_err()
        );
        assert!(
            SseDecoder::default()
                .feed(event(chunk(&"x".repeat(plan::MAX_MODEL_BYTES + 1))).as_bytes())
                .is_err()
        );
        assert!(SseDecoder::default().feed(b"data: \xff\n\n").is_err());
    }
    #[test]
    fn length_refusal_and_tool_calls_are_marked_for_validation() {
        let mut decoder = SseDecoder::default();
        decoder
            .feed(
                format!(
                    "{}{}",
                    event(
                        json!({"choices":[{"index":0,"delta":{"refusal":"no","tool_calls":[]}}]})
                    ),
                    terminal("length")
                )
                .as_bytes(),
            )
            .unwrap();
        let output = decoder.finish().unwrap();
        assert!(output.refused);
        assert!(output.tool_call);
        assert_eq!(output.finish_reason.as_deref(), Some("length"));
    }

    struct Reply {
        body: String,
        status: axum::http::StatusCode,
        delay: Duration,
    }
    impl Reply {
        fn completion(content: Value, reason: &str) -> Self {
            Self {
                body: format!(
                    "{}{}{}data: [DONE]\n\n",
                    event(chunk(&content.to_string())),
                    terminal(reason),
                    event(
                        json!({"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":20}})
                    )
                ),
                status: axum::http::StatusCode::OK,
                delay: Duration::ZERO,
            }
        }
    }
    struct MockState {
        replies: Mutex<VecDeque<Reply>>,
        requests: Mutex<Vec<Value>>,
    }
    struct Mock {
        state: Arc<MockState>,
        task: tokio::task::JoinHandle<()>,
        endpoint: String,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Mock {
        async fn new(replies: Vec<Reply>) -> Self {
            async fn handler(
                State(state): State<Arc<MockState>>,
                Json(body): Json<Value>,
            ) -> Response {
                state.requests.lock().unwrap().push(body);
                let reply = state.replies.lock().unwrap().pop_front();
                let Some(reply) = reply else {
                    return axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                tokio::time::sleep(reply.delay).await;
                (
                    reply.status,
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    reply.body,
                )
                    .into_response()
            }
            let state = Arc::new(MockState {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(vec![]),
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}/completions", listener.local_addr().unwrap());
            let app = Router::new()
                .route("/completions", post(handler))
                .with_state(state.clone());
            let task = tokio::spawn(async move {
                axum::serve(
                    listener.tap_io(|socket| {
                        socket.set_nodelay(true).unwrap();
                    }),
                    app,
                )
                .await
                .unwrap();
            });
            Self {
                state,
                task,
                endpoint,
            }
        }
        fn config(&self, timeout: Duration) -> ProviderConfig {
            ProviderConfig {
                endpoint: self.endpoint.clone(),
                model: "test-nonthinking".into(),
                api_key: None,
                openrouter: true,
                reasoning_effort: None,
                temperature: Some(0.0),
                timeout,
                max_concurrent: 1,
            }
        }
        fn provider(&self, timeout: Duration) -> Provider {
            Provider::new(self.config(timeout)).unwrap()
        }
        async fn wait_requests(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if self.state.requests.lock().unwrap().len() >= count {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    fn context() -> DatasetContext {
        DatasetContext {
            id: "demo".into(),
            label: "demo".into(),
            row_count: 100,
            start: 0,
            end: 86400000,
            vessels: vec!["Aurora".into(), "Meridian".into()],
            description: String::new(),
        }
    }
    fn draft() -> Draft {
        Draft {
            revision: 1,
            text: "Compare vessel wave height by minute over the last 7 days".into(),
            context_id: "demo".into(),
            sent_at: 0.0,
        }
    }
    fn valid_plan() -> Value {
        json!({"result":{"metric":"wave_height","aggregate":"avg","bucketMinutes":1,"windowHours":168,"splitByVessel":true,"vessel":null,"view":"line"}})
    }

    #[tokio::test]
    async fn real_http_uses_owned_schema_and_returns_validated_diagnostics() {
        let mock = Mock::new(vec![Reply::completion(valid_plan(), "stop")]).await;
        let response = mock
            .provider(Duration::from_secs(2))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.plan.window_hours, 168);
        assert_eq!(response.tokens, Some(20));
        assert_eq!(response.diagnostics.attempts, Some(1));
        assert!(response.diagnostics.first_token_ms.is_some());
        assert!(
            response.diagnostics.generation_ms.unwrap()
                >= response.diagnostics.first_token_ms.unwrap()
        );
        let requests = mock.state.requests.lock().unwrap();
        let request = &requests[0];
        assert_eq!(
            request["provider"],
            json!({"sort":"latency","require_parameters":true})
        );
        assert_eq!(
            request["response_format"]["json_schema"]["schema"],
            plan::response_schema()
        );
        assert_eq!(request["stream"], true);
        assert_eq!(request["temperature"], 0.0);
        assert!(request.get("reasoning").is_none());
    }

    #[tokio::test]
    async fn configured_reasoning_effort_is_sent_unchanged_on_initial_and_repair_requests() {
        for (effort, value) in [
            (ReasoningEffort::None, "none"),
            (ReasoningEffort::Minimal, "minimal"),
            (ReasoningEffort::Low, "low"),
            (ReasoningEffort::Medium, "medium"),
            (ReasoningEffort::High, "high"),
        ] {
            let mock = Mock::new(vec![
                Reply::completion(json!({"result":{}}), "stop"),
                Reply::completion(valid_plan(), "stop"),
            ])
            .await;
            let mut config = mock.config(Duration::from_secs(2));
            config.reasoning_effort = Some(effort);
            let result = Provider::new(config)
                .unwrap()
                .infer(&context(), &draft(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(result.diagnostics.attempts, Some(2));
            let requests = mock.state.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            for request in requests.iter() {
                assert_eq!(request["reasoning"], json!({"effort":value}));
                assert_eq!(request["provider"]["require_parameters"], true);
            }
        }
    }

    #[tokio::test]
    async fn temperature_can_be_omitted_or_configured_for_any_provider() {
        for openrouter in [false, true] {
            for temperature in [None, Some(0.5)] {
                let mock = Mock::new(vec![Reply::completion(valid_plan(), "stop")]).await;
                let mut config = mock.config(Duration::from_secs(2));
                config.openrouter = openrouter;
                config.temperature = temperature;
                Provider::new(config)
                    .unwrap()
                    .infer(&context(), &draft(), CancellationToken::new())
                    .await
                    .unwrap();
                let requests = mock.state.requests.lock().unwrap();
                assert_eq!(
                    requests[0].get("temperature"),
                    temperature.map(|value| json!(value)).as_ref()
                );
                assert!(requests[0].get("reasoning").is_none());
            }
        }
    }

    #[tokio::test]
    async fn direct_provider_configuration_rejects_invalid_reasoning_and_temperature() {
        let mock = Mock::new(vec![]).await;
        let mut config = mock.config(Duration::from_secs(2));
        config.openrouter = false;
        config.reasoning_effort = Some(ReasoningEffort::None);
        assert!(Provider::new(config).is_err());
        for value in [f64::NAN, f64::INFINITY, -0.1, 2.1] {
            let mut config = mock.config(Duration::from_secs(2));
            config.temperature = Some(value);
            assert!(Provider::new(config).is_err());
        }
        assert!(mock.state.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn first_token_waits_for_content_instead_of_headers_role_or_comments() {
        async fn handler() -> Response {
            let segments = vec![
                (
                    Duration::ZERO,
                    format!(
                        ": provider ready\n\n{}",
                        event(
                            json!({"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]})
                        )
                    ),
                ),
                (
                    Duration::from_millis(60),
                    event(chunk(&valid_plan().to_string())),
                ),
                (
                    Duration::from_millis(40),
                    format!("{}data: [DONE]\n\n", terminal("stop")),
                ),
            ];
            let stream =
                futures_util::stream::unfold(segments.into_iter(), |mut segments| async move {
                    let (delay, text) = segments.next()?;
                    tokio::time::sleep(delay).await;
                    Some((Ok::<_, std::convert::Infallible>(text), segments))
                });
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/completions", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener.tap_io(|socket| {
                    socket.set_nodelay(true).unwrap();
                }),
                Router::new().route("/completions", post(handler)),
            )
            .await
            .unwrap();
        });
        let provider = Provider::new(ProviderConfig {
            endpoint,
            model: "test".into(),
            api_key: None,
            openrouter: false,
            reasoning_effort: None,
            temperature: Some(0.0),
            timeout: Duration::from_secs(3),
            max_concurrent: 1,
        })
        .unwrap();
        let response = provider
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap();
        task.abort();
        let first = response.diagnostics.first_token_ms.unwrap();
        assert!(
            first >= 55.0,
            "first content arrived after a60ms delay, measured {first}"
        );
        assert!(response.diagnostics.generation_ms.unwrap() - first >= 35.0);
        assert_eq!(
            response.tokens, None,
            "Missing provider usage must not be fabricated."
        );
    }

    #[tokio::test]
    async fn corrects_model_validation_once_with_exact_error_and_cumulative_usage() {
        let mut invalid = valid_plan();
        invalid["result"]["view"] = json!("map");
        invalid["result"]["splitByVessel"] = json!(false);
        let mock = Mock::new(vec![
            Reply::completion(invalid, "stop"),
            Reply::completion(valid_plan(), "stop"),
        ])
        .await;
        let response = mock
            .provider(Duration::from_secs(2))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.diagnostics.attempts, Some(2));
        assert_eq!(response.diagnostics.prompt_tokens, Some(80));
        assert_eq!(response.tokens, Some(40));
        assert!(
            response.diagnostics.repair_ms.unwrap() <= response.diagnostics.generation_ms.unwrap()
        );
        let requests = mock.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1]["messages"][3]["content"]
                .as_str()
                .unwrap()
                .contains("Geographic views require splitByVessel true")
        );
    }

    #[tokio::test]
    async fn even_valid_json_at_length_limit_must_be_corrected() {
        let mock = Mock::new(vec![
            Reply::completion(valid_plan(), "length"),
            Reply::completion(valid_plan(), "stop"),
        ])
        .await;
        let response = mock
            .provider(Duration::from_secs(2))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.diagnostics.attempts, Some(2));
    }

    #[tokio::test]
    async fn numeric_bucket_outside_allowlist_gets_one_correction() {
        let mut invalid = valid_plan();
        invalid["result"]["bucketMinutes"] = json!(2);
        let mock = Mock::new(vec![
            Reply::completion(invalid, "stop"),
            Reply::completion(valid_plan(), "stop"),
        ])
        .await;
        let response = mock
            .provider(Duration::from_secs(2))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.plan.bucket_minutes, 1);
        assert_eq!(response.diagnostics.attempts, Some(2));
        let requests = mock.state.requests.lock().unwrap();
        assert!(
            requests[1]["messages"][3]["content"]
                .as_str()
                .unwrap()
                .contains("Unsupported time bucket.")
        );
    }

    #[tokio::test]
    async fn second_invalid_answer_reports_bounded_response_without_third_attempt() {
        let refusal = json!({"result":{"error":"unsupported_request"}});
        let mock = Mock::new(vec![
            Reply::completion(refusal.clone(), "stop"),
            Reply::completion(refusal, "stop"),
        ])
        .await;
        let error = mock
            .provider(Duration::from_secs(2))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidModel);
        assert_eq!(error.diagnostics.unwrap().attempts, Some(2));
        assert!(error.response.unwrap().text.contains("unsupported_request"));
        assert_eq!(mock.state.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn provider_status_and_lost_stream_never_retry_or_echo_private_errors() {
        for reply in [
            Reply {
                body: "private credential".into(),
                status: axum::http::StatusCode::UNAUTHORIZED,
                delay: Duration::ZERO,
            },
            Reply {
                body: event(chunk(&valid_plan().to_string())),
                status: axum::http::StatusCode::OK,
                delay: Duration::ZERO,
            },
        ] {
            let mock = Mock::new(vec![reply]).await;
            let error = mock
                .provider(Duration::from_secs(2))
                .infer(&context(), &draft(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Upstream);
            assert!(!error.message.contains("private credential"));
            assert_eq!(mock.state.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn cancellation_releases_admission_without_waiting_for_upstream() {
        let mut reply = Reply::completion(valid_plan(), "stop");
        reply.delay = Duration::from_secs(10);
        let mock = Mock::new(vec![reply, Reply::completion(valid_plan(), "stop")]).await;
        let provider = mock.provider(Duration::from_secs(20));
        let cancel = CancellationToken::new();
        let task = {
            let provider = provider.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { provider.infer(&context(), &draft(), cancel).await })
        };
        mock.wait_requests(1).await;
        assert_eq!(
            provider
                .infer(&context(), &draft(), CancellationToken::new())
                .await
                .unwrap_err()
                .kind,
            ErrorKind::Busy
        );
        cancel.cancel();
        assert_eq!(task.await.unwrap().unwrap_err().kind, ErrorKind::Canceled);
        assert!(
            provider
                .infer(&context(), &draft(), CancellationToken::new())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn one_total_deadline_covers_initial_attempt_and_repair() {
        let mut first =
            Reply::completion(json!({"result":{"error":"unsupported_request"}}), "stop");
        first.delay = Duration::from_millis(60);
        let mut second = Reply::completion(valid_plan(), "stop");
        second.delay = Duration::from_millis(100);
        let mock = Mock::new(vec![first, second]).await;
        let error = mock
            .provider(Duration::from_millis(120))
            .infer(&context(), &draft(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Timeout);
        assert_eq!(error.diagnostics.as_ref().unwrap().attempts, Some(2));
        assert!(error.diagnostics.unwrap().repair_ms.is_some());
        assert_eq!(mock.state.requests.lock().unwrap().len(), 2);
    }
}
