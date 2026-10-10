//! One translation: question → streamed SQL_DELTA → SQL → INFER_STATS (or ERROR).
//!
//! The job only produces frames; the session decides whether they still leave the
//! process (cancellation and epoch fencing live there). Dropping the job's future drops
//! the provider stream, which cancels the upstream generation.
use std::{
    collections::{HashMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use tb_protocol::{Frame, Header, Kind, flags, node, stage};
use tokio::sync::mpsc;

use crate::{
    prompt::{self, DatasetContext},
    provider::{Completion, Provider, ProviderError, Usage, error},
    sql::{self, SqlStream},
};

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// A stored CONTEXT with its prebuilt, stable system prompt.
pub struct Prepared {
    pub context: DatasetContext,
    pub system: String,
    pub prefix_hash: u64,
}

impl Prepared {
    pub fn new(context: DatasetContext) -> Self {
        let system = prompt::system_prompt(&context);
        let mut hasher = DefaultHasher::new();
        system.hash(&mut hasher);
        Prepared {
            context,
            prefix_hash: hasher.finish(),
            system,
        }
    }
}

/// Process-wide exact (prompt prefix, question) → SQL cache. Temperature 0 makes the
/// translation deterministic enough that a repeated question need not be paid twice.
pub struct SqlCache {
    entries: Mutex<(HashMap<(u64, String), Arc<str>>, VecDeque<(u64, String)>)>,
    capacity: usize,
}

impl SqlCache {
    pub fn new(capacity: usize) -> Self {
        SqlCache {
            entries: Mutex::new((HashMap::new(), VecDeque::new())),
            capacity,
        }
    }
    pub fn get(&self, prefix: u64, question: &str) -> Option<Arc<str>> {
        if self.capacity == 0 {
            return None;
        }
        self.entries
            .lock()
            .unwrap()
            .0
            .get(&(prefix, question.to_string()))
            .cloned()
    }
    pub fn put(&self, prefix: u64, question: &str, sql: &str) {
        if self.capacity == 0 {
            return;
        }
        let mut guard = self.entries.lock().unwrap();
        let (map, order) = &mut *guard;
        let key = (prefix, question.to_string());
        if map.insert(key.clone(), Arc::from(sql)).is_none() {
            order.push_back(key);
            while order.len() > self.capacity {
                if let Some(old) = order.pop_front() {
                    map.remove(&old);
                }
            }
        }
    }
}

/// Frames from a job to its session: (request, frame, is_last).
pub type Outbox = mpsc::UnboundedSender<(u32, Frame, bool)>;

pub struct Job {
    pub header: Header,
    pub question: String,
    pub prepared: Arc<Prepared>,
    pub received_at: f64,
    /// What the job has spent so far, readable by the session if it cancels the job.
    pub progress: Arc<Mutex<Spent>>,
}

#[derive(Default, Debug, Clone)]
pub struct Spent {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub attempts: u32,
    pub model: Option<String>,
}

impl Spent {
    fn add(&mut self, usage: &Usage) {
        self.prompt_tokens += usage.prompt_tokens.unwrap_or(0);
        self.completion_tokens += usage.completion_tokens.unwrap_or(0);
        if let Some(n) = usage.cached_tokens {
            self.cached_tokens = Some(self.cached_tokens.unwrap_or(0) + n);
        }
        if let Some(n) = usage.reasoning_tokens {
            self.reasoning_tokens = Some(self.reasoning_tokens.unwrap_or(0) + n);
        }
        if let Some(c) = usage.cost_usd {
            self.cost_usd = Some(self.cost_usd.unwrap_or(0.0) + c);
        }
    }

    /// INFER_STATS for a request cancelled after the provider was called: usage of finished
    /// attempts only (an aborted stream reports none), flagged `cancelled`.
    pub fn cancelled_frame(&self, base: &Header, configured_model: &str) -> Option<Frame> {
        if self.attempts == 0 {
            return None;
        }
        let mut stats = self.stats_json(configured_model);
        stats["cancelled"] = json!(true);
        Some(Frame::new(reply(Kind::InferStats, base), stats.to_string()))
    }

    pub fn stats_json(&self, configured_model: &str) -> Value {
        let mut stats = json!({
            "model": self.model.as_deref().unwrap_or(configured_model),
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "attempts": self.attempts,
        });
        if let Some(n) = self.cached_tokens {
            stats["cachedTokens"] = json!(n);
        }
        if let Some(n) = self.reasoning_tokens {
            stats["reasoningTokens"] = json!(n);
        }
        if let Some(c) = self.cost_usd {
            stats["costUsd"] = json!(c);
        }
        stats
    }
}

fn reply(kind: Kind, base: &Header) -> Header {
    Header {
        kind,
        flags: 0,
        ..*base
    }
}

pub fn error_frame(base: &Header, code: &str, message: &str) -> Frame {
    Frame::new(
        reply(Kind::Error, base),
        json!({"code": code, "message": message}).to_string(),
    )
}

/// Answer from the SQL cache: SQL (CACHED) and zero-cost stats.
pub fn cached_frames(job: &Job, sql: &str, model: &str) -> [Frame; 2] {
    let mut header = reply(Kind::Sql, &job.header);
    header.flags = flags::CACHED;
    let sql = Frame::new(header, sql.as_bytes().to_vec())
        .stamp(stage::INFER_RECEIVED, node::INFERENCE, job.received_at)
        .stamp(stage::SQL_COMPLETE, node::INFERENCE, now_ms());
    let stats = Spent {
        model: Some(model.into()),
        cost_usd: Some(0.0),
        ..Default::default()
    };
    [
        sql,
        Frame::new(
            reply(Kind::InferStats, &job.header),
            stats.stats_json(model).to_string(),
        ),
    ]
}

/// Run one translation to completion, sending frames to `out`. Returns what was spent and
/// the final SQL (for caching).
pub async fn run(
    provider: &Provider,
    cache: &SqlCache,
    job: &Job,
    out: &Outbox,
) -> (Spent, Result<String, ProviderError>) {
    let mut spent = Spent::default();
    let request = job.header.request;
    let result = tokio::time::timeout(
        provider.config().timeout,
        translate(provider, cache, job, out, &mut spent),
    )
    .await
    .unwrap_or_else(|_| Err(error("timeout", "Inference exceeded its deadline.")));
    let model = provider.config().model.clone();
    let stats = (spent.attempts > 0).then(|| {
        Frame::new(
            reply(Kind::InferStats, &job.header),
            spent.stats_json(&model).to_string(),
        )
    });
    if let Err(e) = &result {
        let _ = out.send((
            request,
            error_frame(&job.header, e.code, &e.message),
            stats.is_none(),
        ));
    }
    // INFER_STATS closes every request that reached the provider, including failed ones,
    // so speculative cost is always reported.
    if let Some(stats) = stats {
        let _ = out.send((request, stats, true));
    }
    (spent, result)
}

async fn translate(
    provider: &Provider,
    cache: &SqlCache,
    job: &Job,
    out: &Outbox,
    spent: &mut Spent,
) -> Result<String, ProviderError> {
    let _slot = provider.slot()?;
    let request = job.header.request;
    let mut messages = vec![
        json!({"role": "system", "content": job.prepared.system}),
        json!({"role": "user", "content": prompt::user_message(&job.question)}),
    ];
    let mut ledger = vec![(stage::INFER_RECEIVED, node::INFERENCE, job.received_at)];
    let mut streamed_any = false;
    for attempt in 1..=2u32 {
        spent.attempts = attempt;
        *job.progress.lock().unwrap() = spent.clone();
        if attempt == 1 {
            ledger.push((stage::PROVIDER_REQUEST, node::INFERENCE, now_ms()));
        }
        // Deltas are streamed only while no earlier attempt has streamed any, so the
        // concatenated deltas of a request are always a prefix of its final SQL.
        let stream_deltas = !streamed_any;
        let mut sql_stream = SqlStream::default();
        let completion: Completion = provider
            .stream(&messages, |content| {
                if !ledger.iter().any(|s| s.0 == stage::FIRST_TOKEN) {
                    ledger.push((stage::FIRST_TOKEN, node::PROVIDER, now_ms()));
                }
                let Some(delta) = sql_stream.push(content) else {
                    return;
                };
                if !stream_deltas {
                    return;
                }
                let mut frame = Frame::new(reply(Kind::SqlDelta, &job.header), delta.into_bytes());
                if !streamed_any {
                    ledger.push((stage::SQL_FIRST_DELTA, node::INFERENCE, now_ms()));
                    for &(s, n, at) in &ledger {
                        frame = frame.stamp(s, n, at);
                    }
                    streamed_any = true;
                }
                let _ = out.send((request, frame, false));
            })
            .await?;
        spent.add(&completion.usage);
        if completion.model.is_some() {
            spent.model = completion.model.clone();
        }
        *job.progress.lock().unwrap() = spent.clone();
        let sql = sql_stream.finish();
        let verdict = if completion.refused {
            Err("the model refused".to_string())
        } else if completion.tool_call {
            Err("tool calls are not allowed".to_string())
        } else if completion.finish_reason.as_deref() != Some("stop") {
            Err(format!(
                "the reply was cut off (finish reason {})",
                completion.finish_reason.as_deref().unwrap_or("missing")
            ))
        } else {
            sql::check(&sql)
        };
        match verdict {
            Ok(()) => {
                if !ledger.iter().any(|s| s.0 == stage::SQL_FIRST_DELTA) {
                    ledger.push((stage::SQL_FIRST_DELTA, node::INFERENCE, now_ms()));
                }
                cache.put(
                    job.prepared.prefix_hash,
                    &prompt::user_message(&job.question),
                    &sql,
                );
                ledger.push((stage::SQL_COMPLETE, node::INFERENCE, now_ms()));
                let mut frame = Frame::new(reply(Kind::Sql, &job.header), sql.clone().into_bytes());
                for &(s, n, at) in &ledger {
                    frame = frame.stamp(s, n, at);
                }
                let _ = out.send((request, frame, false));
                return Ok(sql);
            }
            Err(reason) if attempt == 1 => {
                messages.push(json!({"role": "assistant", "content": completion.content}));
                messages.push(json!({"role": "user", "content": prompt::repair_message(&job.prepared.context, &reason)}));
            }
            Err(reason) => {
                return Err(error(
                    "invalid_sql",
                    format!("No valid SQL after one repair: {reason}."),
                ));
            }
        }
    }
    unreachable!("at most two attempts")
}
