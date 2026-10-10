use super::*;
use tb_protocol::{flags, node, stage};
use LinkId::*;

const CTX: u32 = 7;

/// Test harness: frames go through the real codec, like on a MessagePort.
struct H {
    c: Coordinator,
    now: f64,
}

type Out = Vec<(LinkId, Frame)>;

fn frame(kind: Kind) -> Frame {
    Frame::new(Header::new(kind), Vec::new())
}

impl H {
    /// Context 7 loaded, slots 1 and 2 in the pool.
    fn new() -> H {
        H::with_config(r#"{"freeSlots":[1,2]}"#)
    }
    fn with_config(config: &str) -> H {
        let mut h = H { c: Coordinator::new(), now: 1_000.0 };
        h.config(config);
        h.context(CTX);
        h
    }
    fn send(&mut self, link: LinkId, frame: Frame) -> Out {
        self.try_send(link, frame).expect("input failed")
    }
    fn try_send(&mut self, link: LinkId, frame: Frame) -> Result<Out, InputError> {
        let bytes = frame.encode();
        let decoded = tb_protocol::decode(&bytes).unwrap();
        self.c.input(link, decoded, self.now)?;
        Ok(self.c.drain().collect())
    }
    fn at(&mut self, now: f64) -> &mut H {
        self.now = now;
        self
    }
    fn config(&mut self, json: &str) -> Out {
        self.send(Ui, Frame::new(Header::new(Kind::Config), json.as_bytes()))
    }
    fn context(&mut self, id: u32) -> Out {
        let mut f = Frame::new(Header::new(Kind::Context), format!(r#"{{"id":{id}}}"#).into_bytes());
        f.header.context = id;
        self.send(Database, f)
    }
    fn draft_frame(kind: Kind, revision: u32, text: &str, now: f64) -> Frame {
        let mut f = Frame::new(Header::new(kind), text.as_bytes());
        f.header.revision = revision;
        f.header.context = CTX;
        f.stamp(stage::KEY_INPUT, node::UI, now - 2.0).stamp(stage::DRAFT_SENT, node::UI, now - 1.0)
    }
    fn draft(&mut self, revision: u32, text: &str) -> Out {
        let f = H::draft_frame(Kind::Draft, revision, text, self.now);
        self.send(Ui, f)
    }
    fn commit(&mut self, revision: u32, text: &str) -> Out {
        let f = H::draft_frame(Kind::Commit, revision, text, self.now);
        self.send(Ui, f)
    }
    fn cancel(&mut self) -> Out {
        self.send(Ui, frame(Kind::Cancel))
    }
    fn epoch(&self) -> u32 {
        self.c.epoch()
    }
    fn req_frame(&self, kind: Kind, request: u32, payload: &[u8]) -> Frame {
        let mut f = Frame::new(Header::new(kind), payload);
        f.header.request = request;
        f.header.epoch = self.epoch();
        f
    }
    fn sql(&mut self, request: u32, sql: &str) -> Out {
        let f = self.req_frame(Kind::Sql, request, sql.as_bytes()).stamp(stage::SQL_COMPLETE, node::INFERENCE, self.now - 0.5);
        self.send(Inference, f)
    }
    fn schema(&mut self, request: u32) -> Out {
        let mut f = self.req_frame(Kind::ResultSchema, request, &[]).stamp(stage::EXEC_RECEIVED, node::DATABASE, self.now);
        f.header.flags = flags::HEADER_ONLY;
        self.send(Database, f)
    }
    fn batch(&mut self, request: u32) -> Out {
        let mut f = self.req_frame(Kind::Batch, request, &[]).stamp(stage::DB_FIRST_BATCH, node::DATABASE, self.now);
        f.header.flags = flags::HEADER_ONLY;
        self.send(Database, f)
    }
    fn done(&mut self, request: u32) -> Out {
        let mut payload = 10u64.to_le_bytes().to_vec();
        payload.extend_from_slice(&800u64.to_le_bytes());
        let f = self.req_frame(Kind::Done, request, &payload).stamp(stage::DB_DONE, node::DATABASE, self.now);
        self.send(Database, f)
    }
    fn drawn(&mut self, request: u32, slot: u32) -> Out {
        let mut payload = slot.to_le_bytes().to_vec();
        payload.extend_from_slice(&5u32.to_le_bytes());
        let f = self
            .req_frame(Kind::Drawn, request, &payload)
            .stamp(stage::RENDER_FIRST_BATCH, node::RENDERER, self.now - 0.2)
            .stamp(stage::FIRST_DRAW_SUBMITTED, node::RENDERER, self.now);
        self.send(Renderer, f)
    }
    fn error(&mut self, link: LinkId, request: u32) -> Out {
        let f = self.req_frame(Kind::Error, request, br#"{"code":"x","message":"boom"}"#);
        self.send(link, f)
    }
    /// Draft → SQL → schema → batch → drawn → done, returning the request id.
    fn full(&mut self, revision: u32, text: &str, sql: &str) -> u32 {
        let out = self.draft(revision, text);
        let id = one(&out, Inference, Kind::Infer).header.request;
        self.sql(id, sql);
        self.schema(id);
        self.batch(id);
        let slot = self.c.live_slot().unwrap();
        self.drawn(id, slot);
        self.done(id);
        id
    }
}

fn kinds(out: &Out) -> Vec<(LinkId, Kind)> {
    out.iter().map(|(l, f)| (*l, f.header.kind)).collect()
}
fn all<'a>(out: &'a Out, link: LinkId, kind: Kind) -> Vec<&'a Frame> {
    out.iter().filter(|(l, f)| *l == link && f.header.kind == kind).map(|(_, f)| f).collect()
}
fn one(out: &Out, link: LinkId, kind: Kind) -> &Frame {
    let found = all(out, link, kind);
    assert_eq!(found.len(), 1, "expected one {link:?} {kind:?} in {:?}", kinds(out));
    found[0]
}
fn none(out: &Out, link: LinkId, kind: Kind) {
    assert!(all(out, link, kind).is_empty(), "unexpected {link:?} {kind:?} in {:?}", kinds(out));
}
fn slot_of(f: &Frame) -> u32 {
    u32::from_le_bytes(f.payload[..4].try_into().unwrap())
}
fn stages(f: &Frame) -> Vec<u16> {
    f.stamps.iter().map(|s| s.stage).collect()
}
fn text(f: &Frame) -> &str {
    core::str::from_utf8(&f.payload).unwrap()
}

// ───────────────────────── drafts, revisions, context ─────────────────────────

#[test]
fn draft_starts_inference_with_identities_and_stamps() {
    let mut h = H::new();
    h.at(2_000.0);
    let out = h.draft(1, "avg speed");
    assert_eq!(kinds(&out), [(Inference, Kind::Infer)]);
    let infer = &out[0].1;
    assert_eq!((infer.header.request, infer.header.revision, infer.header.context, infer.header.epoch), (1, 1, CTX, 0));
    assert_eq!(text(infer), "avg speed");
    assert_eq!(stages(infer), [stage::KEY_INPUT, stage::DRAFT_SENT, stage::COORD_RECEIVED, stage::INFER_SENT]);
    assert_eq!(infer.stamps[0], Stamp { stage: stage::KEY_INPUT, node: node::UI, at: 1_998.0 });
    assert_eq!(infer.stamps[2], Stamp { stage: stage::COORD_RECEIVED, node: node::COORDINATOR, at: 2_000.0 });
    assert_eq!(infer.stamps[3].node, node::COORDINATOR);
}

#[test]
fn drafts_for_another_context_wait_for_that_context() {
    let mut h = H::with_config(r#"{"freeSlots":[1]}"#);
    let mut f = H::draft_frame(Kind::Draft, 1, "avg speed", h.now);
    f.header.context = 9;
    assert!(h.send(Ui, f).is_empty());
    let out = h.context(9);
    assert_eq!(kinds(&out), [(Inference, Kind::Context), (Inference, Kind::Infer)]);
    assert_eq!(out[1].1.header.context, 9);
}

#[test]
fn drafts_before_any_context_are_translated_when_it_arrives() {
    let mut h = H { c: Coordinator::new(), now: 0.0 };
    h.config(r#"{"freeSlots":[1]}"#);
    assert!(h.draft(1, "avg speed").is_empty());
    let out = h.context(CTX);
    one(&out, Inference, Kind::Infer);
}

#[test]
fn older_and_duplicate_revisions_are_dropped() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart"}"#);
    h.draft(5, "avg speed");
    assert!(h.draft(4, "avg spee").is_empty());
    assert!(h.draft(5, "avg speed!").is_empty());
    assert_eq!(h.c.stats().dropped_revision, 2);
    one(&h.draft(6, "avg speed by"), Inference, Kind::Infer);
}

#[test]
fn composing_drafts_do_not_translate_until_composition_ends() {
    let mut h = H::new();
    let mut f = H::draft_frame(Kind::Draft, 1, "avg sp", h.now);
    f.header.flags = flags::COMPOSING;
    assert!(h.send(Ui, f).is_empty());
    // Composition ends with the same revision.
    let out = h.draft(1, "avg speed");
    assert_eq!(text(one(&out, Inference, Kind::Infer)), "avg speed");
}

#[test]
fn short_draft_cancels_speculation_and_unbinds_live_slot() {
    let mut h = H::new();
    let first = h.full(1, "avg speed", "SELECT 1");
    let out = h.draft(2, "avg speed by hour");
    let second = one(&out, Inference, Kind::Infer).header.request;
    let out = h.draft(3, " a  ");
    assert_eq!(one(&out, Inference, Kind::Cancel).header.request, second);
    let unbind = one(&out, Renderer, Kind::Unbind);
    assert_eq!((unbind.header.request, slot_of(unbind)), (first, 1));
    one(&out, Ui, Kind::Unbind);
    none(&out, Database, Kind::Cancel); // first already DONE
    // The cancelled translation's late SQL is dropped.
    assert!(h.sql(second, "SELECT 2").is_empty());
}

#[test]
fn short_draft_cancels_running_speculative_exec() {
    let mut h = H::new();
    let out = h.draft(1, "avg speed");
    let id = out[0].1.header.request;
    h.sql(id, "SELECT 1");
    let out = h.draft(2, "av");
    assert_eq!(one(&out, Database, Kind::Cancel).header.request, id);
    assert!(h.schema(id).is_empty());
}

#[test]
fn min_chars_counts_trimmed_characters_not_bytes() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"minChars":3}"#);
    assert!(h.draft(1, "  äö  ").is_empty());
    one(&h.draft(2, " äöü "), Inference, Kind::Infer);
    let mut h = H::with_config(r#"{"freeSlots":[1],"minChars":0}"#);
    one(&h.draft(1, "a"), Inference, Kind::Infer);
}

#[test]
fn invalid_utf8_is_an_input_error() {
    let mut h = H::new();
    let mut f = H::draft_frame(Kind::Draft, 1, "", h.now);
    f.payload = vec![0xff, 0xfe];
    assert_eq!(h.try_send(Ui, f).unwrap_err(), InputError::InvalidUtf8);
}

// ───────────────────────── policies ─────────────────────────

#[test]
fn latest_lets_inflight_finish_then_translates_newest_only() {
    let mut h = H::new();
    let first = one(&h.draft(1, "avg"), Inference, Kind::Infer).header.request;
    assert!(h.draft(2, "avg s").is_empty());
    assert!(h.draft(3, "avg sp").is_empty());
    assert!(h.draft(4, "avg speed").is_empty());
    let out = h.sql(first, "SELECT avg(x)");
    let infer = one(&out, Inference, Kind::Infer);
    assert_eq!((infer.header.request, infer.header.revision, text(infer)), (first + 1, 4, "avg speed"));
    // The older result is still shown while typing: nothing newer is bound.
    let bind = one(&out, Renderer, Kind::Bind);
    assert_eq!((bind.header.request, bind.header.revision), (first, 1));
    // INFER goes out before EXEC (the in-process database may block).
    let pos = |k: Kind| out.iter().position(|(_, f)| f.header.kind == k).unwrap();
    assert!(pos(Kind::Infer) < pos(Kind::Exec));
    assert_eq!(h.c.stats().infer_sent, 2);
}

#[test]
fn latest_without_change_does_not_retranslate() {
    let mut h = H::new();
    let id = one(&h.draft(1, "avg speed"), Inference, Kind::Infer).header.request;
    let out = h.sql(id, "SELECT 1");
    none(&out, Inference, Kind::Infer);
}

#[test]
fn restart_cancels_inflight_and_starts_newest_at_once() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart"}"#);
    let first = one(&h.draft(1, "avg"), Inference, Kind::Infer).header.request;
    let out = h.draft(2, "avg speed");
    assert_eq!(kinds(&out), [(Inference, Kind::Cancel), (Inference, Kind::Infer)]);
    let cancel = &out[0].1;
    assert_eq!((cancel.header.request, cancel.header.epoch), (first, 0), "targeted cancel keeps the epoch");
    assert_eq!(out[1].1.header.request, first + 1);
    assert!(h.sql(first, "SELECT stale").is_empty(), "cancelled request's SQL is dropped");
    assert!(h.c.stats().dropped_request >= 1);
}

#[test]
fn restart_never_cancels_committed_translation() {
    let mut h = H::with_config(r#"{"freeSlots":[1,2],"inferencePolicy":"restart"}"#);
    let committed = one(&h.commit(1, "avg speed"), Inference, Kind::Infer).header.request;
    let out = h.draft(2, "avg speed by hour");
    assert!(out.is_empty(), "waits behind committed work: {:?}", kinds(&out));
    let out = h.sql(committed, "SELECT 1");
    one(&out, Ui, Kind::Keep);
    assert_eq!(text(one(&out, Inference, Kind::Infer)), "avg speed by hour");
}

#[test]
fn request_ids_are_monotonic_and_never_reused() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart"}"#);
    let mut seen = Vec::new();
    for revision in 1..20u32 {
        let out = h.draft(revision, &format!("query number {revision}"));
        seen.push(one(&out, Inference, Kind::Infer).header.request);
        if revision % 5 == 0 {
            h.cancel();
        }
    }
    assert!(seen.windows(2).all(|w| w[1] > w[0]), "{seen:?}");
}

// ───────────────────────── SQL, exec, bind ─────────────────────────

#[test]
fn sql_binds_renderer_and_ui_then_execs_speculatively() {
    let mut h = H::new();
    let id = one(&h.draft(1, "avg speed"), Inference, Kind::Infer).header.request;
    h.at(1_100.0);
    let out = h.sql(id, "SELECT avg(speed) FROM t");
    assert_eq!(kinds(&out), [(Renderer, Kind::Bind), (Ui, Kind::Bind), (Database, Kind::Exec)]);
    let bind = &out[0].1;
    assert_eq!((bind.header.request, bind.header.revision, slot_of(bind)), (id, 1, 1));
    let exec = &out[2].1;
    assert_eq!((exec.header.request, exec.header.context, exec.header.flags), (id, CTX, flags::SPECULATIVE));
    assert_eq!(text(exec), "SELECT avg(speed) FROM t");
    assert_eq!(exec.stamps, [Stamp { stage: stage::EXEC_SENT, node: node::COORDINATOR, at: 1_100.0 }]);
}

#[test]
fn first_sql_delta_is_stamped_by_coordinator_if_inference_did_not() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    h.at(1_050.0);
    h.send(Inference, h.req_frame(Kind::SqlDelta, id, b"SEL"));
    h.at(1_060.0);
    h.send(Inference, h.req_frame(Kind::SqlDelta, id, b"ECT"));
    h.sql(id, "SELECT 1");
    h.schema(id);
    h.drawn(id, 1);
    let timing = h.done(id);
    let ledger = &one(&timing, Ui, Kind::Timing).stamps;
    let delta: Vec<_> = ledger.iter().filter(|s| s.stage == stage::SQL_FIRST_DELTA).collect();
    assert_eq!(delta.len(), 1);
    assert_eq!((delta[0].node, delta[0].at), (node::COORDINATOR, 1_050.0));

    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    let f = h.req_frame(Kind::SqlDelta, id, b"SEL").stamp(stage::SQL_FIRST_DELTA, node::INFERENCE, 1_040.0);
    h.send(Inference, f);
    h.sql(id, "SELECT 1");
    h.drawn(id, 1);
    let out = h.done(id);
    let ledger = &one(&out, Ui, Kind::Timing).stamps;
    let delta = ledger.iter().find(|s| s.stage == stage::SQL_FIRST_DELTA).unwrap();
    assert_eq!((delta.node, delta.at), (node::INFERENCE, 1_040.0));
}

#[test]
fn identical_sql_rebinds_revision_without_exec() {
    let mut h = H::new();
    let first = h.full(1, "avg speed", "SELECT avg(speed) FROM t");
    let second = one(&h.draft(2, "average speed"), Inference, Kind::Infer).header.request;
    let out = h.sql(second, "SELECT avg(speed) FROM t");
    none(&out, Database, Kind::Exec);
    none(&out, Renderer, Kind::Bind);
    let bind = one(&out, Ui, Kind::Bind);
    assert_eq!((bind.header.request, bind.header.revision, slot_of(bind)), (first, 2, 1));
    let timing = one(&out, Ui, Kind::Timing);
    assert_eq!(timing.header.request, second);
    assert_eq!(*stages(timing).last().unwrap(), stage::SQL_RECEIVED);
    assert_eq!(h.c.stats().sql_dedups, 1);
    // A third, different SQL compares against the bound request's SQL and executes.
    let third = one(&h.draft(3, "max speed"), Inference, Kind::Infer).header.request;
    one(&h.sql(third, "SELECT max(speed) FROM t"), Database, Kind::Exec);
}

#[test]
fn dedup_does_not_apply_to_a_failed_bound_request() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(id, "SELECT broken");
    h.error(Database, id);
    let second = one(&h.draft(2, "avg speed!"), Inference, Kind::Infer).header.request;
    one(&h.sql(second, "SELECT broken"), Database, Kind::Exec);
}

#[test]
fn newer_result_supersedes_bound_request_and_cancels_its_exec() {
    let mut h = H::new();
    let first = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(first, "SELECT 1");
    let second = one(&h.draft(2, "max speed"), Inference, Kind::Infer).header.request;
    let out = h.sql(second, "SELECT 2");
    assert_eq!(kinds(&out), [(Database, Kind::Cancel), (Renderer, Kind::Bind), (Ui, Kind::Bind), (Database, Kind::Exec)]);
    assert_eq!(out[0].1.header.request, first);
    // Late frames of the superseded request are fenced.
    assert!(h.schema(first).is_empty());
    assert!(h.drawn(first, 1).is_empty());
}

#[test]
fn result_is_sent_once_on_schema_with_escaped_sql_and_view_hint() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    let sql = "-- view: Bar\nSELECT \"a\\b\"\t1";
    h.sql(id, sql);
    let out = h.schema(id);
    let result = one(&out, Ui, Kind::Result);
    assert_eq!((result.header.request, result.header.revision, result.header.context), (id, 1, CTX));
    assert_eq!(text(result), r#"{"slot":1,"sql":"-- view: Bar\nSELECT \"a\\b\"\t1","columns":[],"view":"bar","cached":false}"#);
    assert!(h.schema(id).iter().all(|(_, f)| f.header.kind != Kind::Result));
}

#[test]
fn result_view_is_null_without_hint_and_controls_are_escaped() {
    assert_eq!(json::result_payload(3, b"SELECT 1\x01", true), br#"{"slot":3,"sql":"SELECT 1\u0001","columns":[],"view":null,"cached":true}"#);
    assert_eq!(json::view_hint(b"  --view:map\nSELECT"), Some(&b"map"[..]));
    assert_eq!(json::view_hint(b"-- view: pie\nSELECT"), None);
    assert_eq!(json::view_hint(b"SELECT 1 -- view: bar"), None);
}

#[test]
fn timing_after_drawn_and_after_done_carries_full_ledger() {
    let mut h = H::new();
    h.at(1_000.0);
    let id = h.draft(1, "avg speed")[0].1.header.request;
    h.at(1_200.0);
    h.sql(id, "SELECT 1");
    h.at(1_210.0);
    h.schema(id);
    h.batch(id);
    h.batch(id);
    h.at(1_220.0);
    let out = h.drawn(id, 1);
    let timing = one(&out, Ui, Kind::Timing);
    assert_eq!((timing.header.request, timing.header.revision), (id, 1));
    assert!(timing.payload.is_empty());
    assert_eq!(
        stages(timing),
        [
            stage::KEY_INPUT, stage::DRAFT_SENT, stage::COORD_RECEIVED, stage::INFER_SENT, stage::SQL_COMPLETE,
            stage::SQL_RECEIVED, stage::EXEC_SENT, stage::EXEC_RECEIVED, stage::DB_FIRST_BATCH,
            stage::RENDER_FIRST_BATCH, stage::FIRST_DRAW_SUBMITTED,
        ]
    );
    let out = h.done(id);
    assert_eq!(*stages(one(&out, Ui, Kind::Timing)).last().unwrap(), stage::DB_DONE);
    // FIRST_PRESENTED arriving later still reaches the ledger (DRAWN after DONE).
    let mut f = h.req_frame(Kind::Drawn, id, &[1, 0, 0, 0, 5, 0, 0, 0]);
    f = f.stamp(stage::FIRST_PRESENTED, node::RENDERER, 1_230.0);
    let out = h.send(Renderer, f);
    assert_eq!(*stages(one(&out, Ui, Kind::Timing)).last().unwrap(), stage::FIRST_PRESENTED);
}

// ───────────────────────── commit / keep / pool ─────────────────────────

#[test]
fn commit_keeps_immediately_when_live_slot_shows_that_text() {
    let mut h = H::new();
    let id = h.full(3, "avg speed", "SELECT 1");
    let out = h.commit(3, "avg speed");
    assert_eq!(kinds(&out), [(Ui, Kind::Keep)]);
    let keep = &out[0].1;
    assert_eq!((keep.header.request, keep.header.revision, slot_of(keep)), (id, 3, 1));
    assert_eq!(h.c.live_slot(), Some(2));
    assert!(h.c.stats().infer_sent == 1 && h.c.stats().exec_sent == 1);
    // The kept request's late frames still reach the ledger.
    let mut f = h.req_frame(Kind::Drawn, id, &[1, 0, 0, 0, 5, 0, 0, 0]);
    f = f.stamp(stage::FIRST_PRESENTED, node::RENDERER, 1_230.0);
    one(&h.send(Renderer, f), Ui, Kind::Timing);
}

#[test]
fn commit_keeps_bound_request_before_it_has_drawn() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(id, "SELECT 1");
    let out = h.commit(1, "avg speed");
    assert_eq!(slot_of(one(&out, Ui, Kind::Keep)), 1);
    // Its stream continues into the kept slot.
    assert!(text(one(&h.schema(id), Ui, Kind::Result)).starts_with(r#"{"slot":1,"#));
}

#[test]
fn commit_of_untranslated_text_runs_committed_and_keeps_when_bound() {
    let mut h = H::new();
    let shown = h.full(1, "avg speed", "SELECT 1");
    let out = h.commit(2, "avg speed by hour");
    let id = one(&out, Inference, Kind::Infer).header.request;
    let out = h.sql(id, "SELECT 2");
    assert_eq!(kinds(&out), [(Renderer, Kind::Bind), (Ui, Kind::Bind), (Ui, Kind::Keep), (Database, Kind::Exec)]);
    assert_eq!(out[3].1.header.flags & flags::SPECULATIVE, 0, "committed EXEC is not speculative");
    assert_eq!(slot_of(&out[2].1), 1);
    assert_eq!(h.c.live_slot(), Some(2));
    // Next keystroke binds the new live slot.
    let next = one(&h.draft(3, "max speed"), Inference, Kind::Infer).header.request;
    let out = h.sql(next, "SELECT 3");
    assert_eq!(slot_of(one(&out, Renderer, Kind::Bind)), 2);
    none(&out, Database, Kind::Cancel);
    let _ = shown;
}

#[test]
fn commit_with_identical_sql_to_live_slot_keeps_without_exec() {
    let mut h = H::new();
    let shown = h.full(1, "avg speed", "SELECT 1");
    let id = one(&h.commit(2, "average speed"), Inference, Kind::Infer).header.request;
    let out = h.sql(id, "SELECT 1");
    none(&out, Database, Kind::Exec);
    let keep = one(&out, Ui, Kind::Keep);
    assert_eq!((keep.header.request, keep.header.revision, slot_of(keep)), (shown, 2, 1));
}

#[test]
fn commit_cancels_conflicting_speculative_translation_under_latest() {
    let mut h = H::new();
    let spec = one(&h.draft(1, "avg"), Inference, Kind::Infer).header.request;
    h.draft(2, "avg speed");
    let out = h.commit(2, "avg speed");
    assert_eq!(kinds(&out), [(Inference, Kind::Cancel), (Inference, Kind::Infer)]);
    assert_eq!(out[0].1.header.request, spec);
    assert!(h.sql(spec, "SELECT stale").is_empty());
}

#[test]
fn commit_adopts_inflight_translation_of_same_text() {
    let mut h = H::new();
    let id = one(&h.draft(1, "avg speed"), Inference, Kind::Infer).header.request;
    assert!(h.commit(1, "avg speed").is_empty());
    let out = h.sql(id, "SELECT 1");
    assert_eq!(kinds(&out), [(Renderer, Kind::Bind), (Ui, Kind::Bind), (Ui, Kind::Keep), (Database, Kind::Exec)]);
    assert_eq!(out[3].1.header.flags, 0);
}

#[test]
fn commit_waits_for_a_slot_when_pool_is_empty() {
    let mut h = H::with_config(r#"{"freeSlots":[1]}"#);
    h.full(1, "avg speed", "SELECT 1");
    one(&h.commit(1, "avg speed"), Ui, Kind::Keep);
    assert_eq!(h.c.live_slot(), None);
    let id = one(&h.commit(2, "max speed"), Inference, Kind::Infer).header.request;
    assert!(h.sql(id, "SELECT 2").is_empty(), "queued: no slot");
    let out = h.config(r#"{"freeSlots":[5]}"#);
    assert_eq!(kinds(&out), [(Renderer, Kind::Bind), (Ui, Kind::Bind), (Ui, Kind::Keep), (Database, Kind::Exec)]);
    assert_eq!(slot_of(&out[2].1), 5);
}

#[test]
fn queued_commits_keep_slots_in_order_then_newest_speculation_shows() {
    let mut h = H::with_config(r#"{"freeSlots":[1]}"#);
    h.full(1, "avg speed", "SELECT 1");
    h.commit(1, "avg speed");
    let a = h.commit(2, "max speed")[0].1.header.request;
    h.sql(a, "SELECT 2");
    let b = h.commit(3, "min speed")[0].1.header.request;
    h.sql(b, "SELECT 3");
    let s = h.draft(4, "sum speed")[0].1.header.request;
    assert!(h.sql(s, "SELECT 4").is_empty());
    let out = h.config(r#"{"freeSlots":[7,8,9]}"#);
    let keeps: Vec<_> = all(&out, Ui, Kind::Keep).iter().map(|f| (f.header.request, slot_of(f))).collect();
    assert_eq!(keeps, [(a, 7), (b, 8)]);
    let binds: Vec<_> = all(&out, Renderer, Kind::Bind).iter().map(|f| (f.header.request, slot_of(f))).collect();
    assert_eq!(binds, [(a, 7), (b, 8), (s, 9)]);
}

#[test]
fn double_enter_is_idempotent() {
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    one(&h.commit(1, "avg speed"), Ui, Kind::Keep);
    assert!(h.commit(1, "avg speed").is_empty());
    assert_eq!(h.c.live_slot(), Some(2));
}

#[test]
fn free_slots_are_added_once() {
    let mut h = H::with_config(r#"{"freeSlots":[1,2,2]}"#);
    h.config(r#"{"freeSlots":[1,3]}"#);
    assert_eq!(h.c.pool().collect::<Vec<_>>(), [1, 2, 3]);
}

// ───────────────────────── cancel and epochs ─────────────────────────

#[test]
fn ui_cancel_bumps_epoch_propagates_and_unbinds() {
    let mut h = H::new();
    let shown = h.full(1, "avg speed", "SELECT 1");
    let inflight = one(&h.draft(2, "max speed"), Inference, Kind::Infer).header.request;
    let out = h.cancel();
    assert_eq!(kinds(&out), [(Inference, Kind::Cancel), (Database, Kind::Cancel), (Renderer, Kind::Unbind), (Ui, Kind::Unbind)]);
    assert!(out[..2].iter().all(|(_, f)| f.header.epoch == 1 && f.header.request == 0));
    assert_eq!(out[2].1.header.request, shown);
    // Old-epoch frames are dropped; new work carries the new epoch.
    let mut stale = h.req_frame(Kind::Sql, inflight, b"SELECT 2");
    stale.header.epoch = 0;
    assert!(h.send(Inference, stale).is_empty());
    assert_eq!(h.c.stats().dropped_epoch, 1);
    // Cancel does not re-trigger the cancelled revision (e.g. on a CONFIG).
    assert!(h.config(r#"{"minChars":2}"#).is_empty());
    let infer = one(&h.draft(3, "min speed"), Inference, Kind::Infer).clone();
    assert_eq!(infer.header.epoch, 1);
    assert!(infer.header.request > inflight);
}

#[test]
fn ui_cancel_honours_a_higher_epoch_from_the_ui() {
    let mut h = H::new();
    let mut f = frame(Kind::Cancel);
    f.header.epoch = 40;
    let out = h.send(Ui, f);
    assert_eq!(out[0].1.header.epoch, 40);
    h.cancel();
    assert_eq!(h.epoch(), 41);
}

#[test]
fn commit_after_cancel_runs() {
    let mut h = H::new();
    h.draft(1, "avg speed");
    h.cancel();
    one(&h.commit(1, "avg speed"), Inference, Kind::Infer);
}

#[test]
fn epoch_fencing_drops_old_database_and_renderer_frames() {
    let mut h = H::new();
    h.cancel();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(id, "SELECT 1");
    for kind in [Kind::ResultSchema, Kind::Batch, Kind::Done, Kind::Drawn, Kind::Error] {
        let mut f = h.req_frame(kind, id, if kind == Kind::Drawn { &[1, 0, 0, 0, 0, 0, 0, 0] } else { &[] });
        f.header.epoch = 0;
        let link = if kind == Kind::Drawn { Renderer } else { Database };
        assert!(h.send(link, f).is_empty(), "{kind:?}");
    }
    assert_eq!(h.c.stats().dropped_epoch, 5);
}

#[test]
fn frames_for_unknown_requests_are_dropped() {
    let mut h = H::new();
    assert!(h.sql(99, "SELECT 1").is_empty());
    assert!(h.schema(99).is_empty());
    assert!(h.error(Database, 99).is_empty());
    assert_eq!(h.c.stats().dropped_request, 3);
}

#[test]
fn frames_on_wrong_links_are_dropped() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    let f = h.req_frame(Kind::Sql, id, b"SELECT 1");
    assert!(h.send(Database, f).is_empty());
    assert!(h.send(Inference, H::draft_frame(Kind::Draft, 2, "x y z", 0.0)).is_empty());
    assert!(h.send(Renderer, frame(Kind::Cancel)).is_empty());
    assert_eq!(h.c.stats().dropped_link, 3);
}

// ───────────────────────── cache and latency dial ─────────────────────────

#[test]
fn cache_hit_releases_immediately_without_inference() {
    let mut h = H::new();
    let first = h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    h.at(5_000.0);
    let out = h.draft(3, "avg speed");
    none(&out, Inference, Kind::Infer);
    let exec = one(&out, Database, Kind::Exec);
    assert_eq!(text(exec), "SELECT 1");
    assert!(exec.header.request > first);
    let id = exec.header.request;
    assert!(text(one(&h.schema(id), Ui, Kind::Result)).contains(r#""cached":true"#));
    let out = h.drawn(id, 1);
    assert_eq!(
        stages(one(&out, Ui, Kind::Timing))[..5],
        [stage::KEY_INPUT, stage::DRAFT_SENT, stage::COORD_RECEIVED, stage::CACHE_HIT, stage::SQL_RECEIVED]
    );
    assert_eq!(h.c.stats().cache_hits, 1);
}

#[test]
fn cache_is_keyed_by_context_and_exact_text() {
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    one(&h.draft(2, "avg speed "), Inference, Kind::Infer);
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    h.context(8);
    let mut f = H::draft_frame(Kind::Draft, 2, "avg speed", h.now);
    f.header.context = 8;
    one(&h.send(Ui, f), Inference, Kind::Infer);
}

#[test]
fn cache_can_be_disabled() {
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    h.config(r#"{"translationCache":false}"#);
    let id = one(&h.draft(3, "avg speed"), Inference, Kind::Infer).header.request;
    h.sql(id, "SELECT 1");
    // Re-enabling starts from an empty cache.
    h.config(r#"{"translationCache":true}"#);
    h.full(4, "min speed", "SELECT 4");
    one(&h.draft(5, "avg speed"), Inference, Kind::Infer);
}

#[test]
fn cache_is_a_bounded_lru() {
    let mut cache = Cache::default();
    for i in 0..CACHE_CAPACITY {
        cache.put(1, &format!("q{i}"), b"S");
    }
    assert!(cache.get(1, "q0").is_some()); // refresh q0
    cache.put(1, "new", b"N");
    assert_eq!(cache.entries.len(), CACHE_CAPACITY);
    assert!(cache.get(1, "q0").is_some());
    assert!(cache.get(1, "q1").is_none(), "least recently used entry evicted");
    assert_eq!(cache.get(1, "new"), Some(&b"N"[..]));
}

#[test]
fn latency_dial_releases_cache_hit_after_exactly_the_delay() {
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    h.config(r#"{"latencyDialMs":50}"#);
    h.at(10_000.0);
    assert!(h.draft(3, "avg speed").is_empty());
    assert_eq!(h.c.next_deadline(), Some(10_050.0));
    h.c.tick(10_049.9);
    assert!(h.c.drain().next().is_none());
    h.c.tick(10_050.0);
    let out: Out = h.c.drain().collect();
    let exec = one(&out, Database, Kind::Exec);
    assert_eq!(text(exec), "SELECT 1");
    assert_eq!(h.c.next_deadline(), None);
    h.now = 10_051.0;
    let ledger = one(&h.drawn(exec.header.request, 1), Ui, Kind::Timing).stamps.clone();
    let at = |s: u16| ledger.iter().find(|x| x.stage == s).unwrap().at;
    assert_eq!(at(stage::SQL_RECEIVED) - at(stage::CACHE_HIT), 50.0);
}

#[test]
fn dial_pending_hit_counts_as_inflight() {
    // latest: a newer draft waits for the delayed hit.
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    h.config(r#"{"latencyDialMs":50}"#);
    h.at(10_000.0);
    h.draft(3, "avg speed");
    assert!(h.draft(4, "avg speed by hour").is_empty());
    h.c.tick(10_050.0);
    let out: Out = h.c.drain().collect();
    one(&out, Inference, Kind::Infer);
    one(&out, Database, Kind::Exec);
    // restart: a newer draft drops the delayed hit without a CANCEL frame.
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart","latencyDialMs":50}"#);
    h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    h.draft(3, "avg speed");
    let out = h.draft(4, "avg speed by hour");
    assert_eq!(kinds(&out), [(Inference, Kind::Infer)]);
    assert_eq!(h.c.next_deadline(), None);
}

#[test]
fn null_dial_releases_immediately() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"latencyDialMs":50}"#);
    h.config(r#"{"latencyDialMs":null}"#);
    assert_eq!(h.c.config().latency_dial_ms, None);
    h.full(1, "avg speed", "SELECT 1");
    h.full(2, "max speed", "SELECT 2");
    one(&h.draft(3, "avg speed"), Database, Kind::Exec);
}

// ───────────────────────── forwarding and errors ─────────────────────────

#[test]
fn context_is_forwarded_to_inference_and_again_after_ready() {
    let mut h = H { c: Coordinator::new(), now: 0.0 };
    let out = h.context(CTX);
    let ctx = one(&out, Inference, Kind::Context);
    assert_eq!((ctx.header.context, text(ctx)), (CTX, r#"{"id":7}"#));
    let out = h.send(Inference, Frame::new(Header::new(Kind::Ready), &b"{}"[..]));
    assert_eq!(text(one(&out, Inference, Kind::Context)), r#"{"id":7}"#);
}

#[test]
fn inference_ready_retries_lost_inflight_translation() {
    let mut h = H::new();
    let lost = one(&h.draft(1, "avg speed"), Inference, Kind::Infer).header.request;
    let out = h.send(Inference, Frame::new(Header::new(Kind::Ready), &b"{}"[..]));
    assert_eq!(kinds(&out), [(Inference, Kind::Context), (Inference, Kind::Infer)]);
    assert!(out[1].1.header.request > lost);
}

#[test]
fn context_change_cancels_old_work_and_unbinds() {
    let mut h = H::new();
    h.full(1, "avg speed", "SELECT 1");
    let id = h.draft(2, "max speed")[0].1.header.request;
    let out = h.context(8);
    assert_eq!(one(&out, Inference, Kind::Cancel).header.request, id);
    one(&out, Renderer, Kind::Unbind);
    one(&out, Inference, Kind::Context);
    none(&out, Inference, Kind::Infer); // latest draft is for context 7
}

#[test]
fn status_infer_stats_and_errors_are_forwarded_to_ui() {
    let mut h = H::new();
    let status = Frame::new(Header::new(Kind::Status), &br#"{"component":"inference","state":"ready","label":"x"}"#[..]);
    assert_eq!(h.send(Inference, status.clone()), [(Ui, status.clone())]);
    assert_eq!(h.send(Database, status.clone()), [(Ui, status)]);
    let stats = h.req_frame(Kind::InferStats, 3, br#"{"model":"m"}"#);
    assert_eq!(h.send(Inference, stats.clone()), [(Ui, stats)]);
    let error = Frame::new(Header::new(Kind::Error), &br#"{"code":"x","message":"y"}"#[..]);
    assert_eq!(h.send(Database, error.clone()), [(Ui, error)]);
}

#[test]
fn database_error_falls_back_to_previous_complete_result() {
    let mut h = H::new();
    let good = h.full(1, "avg speed", "SELECT 1");
    let bad = h.draft(2, "max speed")[0].1.header.request;
    h.sql(bad, "SELECT broken");
    let out = h.error(Database, bad);
    assert_eq!(kinds(&out), [(Ui, Kind::Error), (Renderer, Kind::Bind), (Ui, Kind::Bind)]);
    assert_eq!((out[1].1.header.request, out[1].1.header.revision, slot_of(&out[1].1)), (good, 1, 1));
    // The failed revision is not retried; the next keystroke is.
    let next = one(&h.draft(3, "max speed!"), Inference, Kind::Infer).header.request;
    let out = h.sql(next, "SELECT 3");
    one(&out, Database, Kind::Exec);
}

#[test]
fn database_error_without_complete_result_unbinds() {
    let mut h = H::new();
    let bad = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(bad, "SELECT broken");
    let out = h.error(Database, bad);
    assert_eq!(kinds(&out), [(Ui, Kind::Error), (Renderer, Kind::Unbind), (Ui, Kind::Unbind)]);
}

#[test]
fn error_on_a_superseded_request_changes_nothing() {
    let mut h = H::new();
    let first = h.draft(1, "avg speed")[0].1.header.request;
    h.sql(first, "SELECT 1");
    let second = h.draft(2, "max speed")[0].1.header.request;
    h.sql(second, "SELECT 2");
    assert!(h.error(Database, first).is_empty());
}

#[test]
fn inference_error_frees_the_slot_for_the_newest_draft_without_retrying() {
    let mut h = H::new();
    let first = h.draft(1, "avg speed")[0].1.header.request;
    let out = h.error(Inference, first);
    assert_eq!(kinds(&out), [(Ui, Kind::Error)]);
    assert!(h.config("{}").is_empty(), "a failed revision is not retried");
    let first = h.draft(2, "max speed")[0].1.header.request;
    h.draft(3, "max speed by hour");
    let out = h.error(Inference, first);
    assert_eq!(kinds(&out), [(Ui, Kind::Error), (Inference, Kind::Infer)]);
    // Enter retries a failed revision once.
    let failed = out[1].1.header.request;
    h.error(Inference, failed);
    one(&h.commit(3, "max speed by hour"), Inference, Kind::Infer);
}

#[test]
fn hello_is_answered_with_ready() {
    let mut h = H::new();
    let out = h.send(Inference, frame(Kind::Hello));
    let ready = one(&out, Inference, Kind::Ready);
    assert_eq!(text(ready), r#"{"node":"coordinator","name":"tb-coordinator","version":1}"#);
}

// ───────────────────────── config switches ─────────────────────────

#[test]
fn config_updates_only_named_fields_and_rejects_garbage() {
    let mut h = H::new();
    h.config(r#"{"minChars":5,"unknown":{"nested":[1,"x",null,{"a":true}]},"inferencePolicy":"restart"}"#);
    let c = h.c.config().clone();
    assert_eq!((c.min_chars, c.policy, c.live, c.translation_cache, c.speculate), (5, Policy::Restart, true, true, true));
    h.config(r#" { "latencyDialMs" : 12.5e1 , "live" : false } "#);
    assert_eq!(h.c.config().latency_dial_ms, Some(125.0));
    assert!(!h.c.config().live);
    for bad in [r#"{"live":1}"#, r#"{"inferencePolicy":"eager"}"#, r#"{"freeSlots":[-1]}"#, "{", "[]", r#"{"minChars":3}x"#, r#"{"latencyDialMs":-5}"#] {
        let f = Frame::new(Header::new(Kind::Config), bad.as_bytes());
        assert_eq!(h.try_send(Ui, f).unwrap_err(), InputError::InvalidConfig, "{bad}");
    }
    assert_eq!(h.c.config().min_chars, 5);
}

#[test]
fn live_off_translates_only_commits() {
    let mut h = H::with_config(r#"{"freeSlots":[1,2],"live":false}"#);
    assert!(h.draft(1, "avg speed").is_empty());
    let id = one(&h.commit(1, "avg speed"), Inference, Kind::Infer).header.request;
    one(&h.sql(id, "SELECT 1"), Ui, Kind::Keep);
}

#[test]
fn speculate_off_translates_without_executing_and_enter_reuses_the_sql() {
    let mut h = H::with_config(r#"{"freeSlots":[1,2],"speculate":false}"#);
    let id = h.draft(1, "avg speed")[0].1.header.request;
    assert!(h.sql(id, "SELECT 1").is_empty());
    let out = h.commit(1, "avg speed");
    assert_eq!(kinds(&out), [(Renderer, Kind::Bind), (Ui, Kind::Bind), (Ui, Kind::Keep), (Database, Kind::Exec)]);
    assert_eq!(out[0].1.header.request, id);
}

#[test]
fn retyping_the_shown_text_rebinds_revision_without_inference() {
    let mut h = H::new();
    let id = h.full(1, "avg speed", "SELECT 1");
    let other = one(&h.draft(2, "avg speedx"), Inference, Kind::Infer).header.request;
    // latest: the detour's translation may finish (it warms the cache) but is never shown.
    let out = h.draft(3, "avg speed");
    assert_eq!(kinds(&out), [(Ui, Kind::Bind)]);
    assert_eq!((out[0].1.header.request, out[0].1.header.revision), (id, 3));
    let out = h.sql(other, "SELECT 1x");
    assert!(out.is_empty(), "older than what is shown: {:?}", kinds(&out));
    // Enter now keeps the shown request at once.
    let keep = one(&h.commit(3, "avg speed"), Ui, Kind::Keep).clone();
    assert_eq!((keep.header.request, keep.header.revision), (id, 3));
}

#[test]
fn adoption_of_inflight_same_text_serves_newer_revision() {
    let mut h = H::new();
    let id = h.draft(1, "avg speed")[0].1.header.request;
    assert!(h.draft(2, "avg speedx").is_empty());
    assert!(h.draft(3, "avg speed").is_empty());
    let out = h.sql(id, "SELECT 1");
    none(&out, Inference, Kind::Infer);
    let bind = one(&out, Ui, Kind::Bind);
    assert_eq!((bind.header.request, bind.header.revision), (id, 3));
    assert_eq!(h.c.stats().text_adoptions, 1);
}

#[test]
fn bound_text_adoption_emits_ui_bind_with_new_revision() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart","translationCache":false}"#);
    let id = h.full(1, "avg speed", "SELECT 1");
    let x = h.draft(2, "avg speedx")[0].1.header.request;
    let out = h.draft(3, "avg speed");
    // restart: the detour's translation is useless and cancelled; nothing is re-translated.
    assert_eq!(kinds(&out), [(Inference, Kind::Cancel), (Ui, Kind::Bind)]);
    assert_eq!(out[0].1.header.request, x);
    assert_eq!((out[1].1.header.request, out[1].1.header.revision), (id, 3));
    // A different text after that translates normally.
    let y = one(&h.draft(4, "avg speed by hour"), Inference, Kind::Infer).header.request;
    let out = h.sql(y, "SELECT 1");
    let bind = one(&out, Ui, Kind::Bind);
    assert_eq!((bind.header.request, bind.header.revision), (id, 4), "SQL dedup rebinds");
}

// ───────────────────────── bounded state and invariants ─────────────────────────

#[test]
fn tracked_requests_stay_bounded() {
    let mut h = H::with_config(r#"{"freeSlots":[1],"inferencePolicy":"restart"}"#);
    for revision in 1..2_000u32 {
        let out = h.draft(revision, &format!("query {revision}"));
        let id = one(&out, Inference, Kind::Infer).header.request;
        if revision % 3 == 0 || revision % 50 == 0 {
            h.sql(id, &format!("SELECT {revision}"));
            h.schema(id);
        }
        if revision % 50 == 0 {
            h.commit(revision, &format!("query {revision}"));
            h.config(&format!(r#"{{"freeSlots":[{}]}}"#, 1000 + revision));
        }
    }
    assert!(h.c.tracked_requests() <= REQUEST_CAPACITY, "{}", h.c.tracked_requests());
}

/// Deterministic random sessions; checks the invariants that must hold under any order.
#[test]
fn random_sessions_keep_invariants() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut rand = move |n: u32| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as u32
    };
    for policy in ["latest", "restart"] {
        for dial in ["null", "20"] {
            let mut h = H::with_config(&format!(r#"{{"freeSlots":[1,2],"inferencePolicy":"{policy}","latencyDialMs":{dial}}}"#));
            let mut revision = 0;
            let mut outstanding: Vec<u32> = Vec::new(); // INFERs without SQL/CANCEL
            let mut executing: Vec<u32> = Vec::new();
            let mut next_slot = 10;
            let mut live_revision = 0;
            let mut last_request = 0;
            for _step in 0..4_000 {
                h.now += rand(30) as f64;
                let out = match rand(12) {
                    0..=4 => {
                        revision += 1;
                        let words = ["avg", "speed", "max", "by", "hour", "x"];
                        let text: Vec<_> = (0..1 + rand(3)).map(|_| words[rand(6) as usize]).collect();
                        h.draft(revision, &text.join(" "))
                    }
                    5 if revision > 0 => {
                        let words = ["avg speed", "max speed"];
                        h.commit(revision, words[rand(2) as usize])
                    }
                    6 | 7 if !outstanding.is_empty() => {
                        let id = outstanding.remove(rand(outstanding.len() as u32) as usize);
                        h.sql(id, ["SELECT 1", "SELECT 2", "SELECT 3"][rand(3) as usize])
                    }
                    8 if !executing.is_empty() => {
                        let id = executing[rand(executing.len() as u32) as usize];
                        let mut out = h.schema(id);
                        out.extend(h.drawn(id, 1));
                        out.extend(h.done(id));
                        out
                    }
                    9 if rand(20) == 0 => h.cancel(),
                    10 => {
                        h.c.tick(h.now);
                        h.c.drain().collect()
                    }
                    11 if h.c.pool().count() < 2 => {
                        next_slot += 1;
                        h.config(&format!(r#"{{"freeSlots":[{next_slot}]}}"#))
                    }
                    _ => Vec::new(),
                };
                for (link, f) in &out {
                    match (link, f.header.kind) {
                        (Inference, Kind::Infer) => {
                            assert!(f.header.request > last_request, "request ids increase");
                            last_request = f.header.request;
                            assert!(outstanding.is_empty(), "at most one INFER in flight: {outstanding:?}");
                            outstanding.push(f.header.request);
                        }
                        (Inference, Kind::Cancel) => outstanding.retain(|&r| r != f.header.request && f.header.request != 0),
                        (Database, Kind::Exec) => executing.push(f.header.request),
                        (Database, Kind::Cancel) => executing.retain(|&r| r != f.header.request && f.header.request != 0),
                        (Ui, Kind::Bind) => {
                            // The live card never goes back to an older revision.
                            if Some(slot_of(f)) == h.c.live_slot() {
                                assert!(f.header.revision >= live_revision, "live revision went back");
                                live_revision = f.header.revision;
                            }
                        }
                        (Ui, Kind::Keep) | (Ui, Kind::Unbind) => live_revision = 0,
                        _ => {}
                    }
                    if f.header.kind != Kind::Cancel && f.header.request != 0 && *link != Ui {
                        assert_eq!(f.header.epoch, h.epoch(), "outputs carry the current epoch");
                    }
                }
                assert!(h.c.tracked_requests() <= REQUEST_CAPACITY + 4);
            }
            assert!(h.c.stats().infer_sent > 100);
        }
    }
}

// ───────────────────────── C ABI ─────────────────────────

#[test]
fn abi_round_trip() {
    unsafe {
        let h = abi::tb_coord_new();
        let send = |link: u32, f: &Frame, now: f64| {
            let bytes = f.encode();
            let ptr = abi::tb_alloc(bytes.len());
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let code = abi::tb_coord_input(h, link, ptr, bytes.len(), now);
            abi::tb_free(ptr, bytes.len());
            code
        };
        assert_eq!(send(0, &Frame::new(Header::new(Kind::Config), &br#"{"freeSlots":[1]}"#[..]), 0.0), 0);
        let mut ctx = Frame::new(Header::new(Kind::Context), &b"{}"[..]);
        ctx.header.context = CTX;
        assert_eq!(send(2, &ctx, 0.0), 0);
        assert_eq!(send(0, &H::draft_frame(Kind::Draft, 1, "avg speed", 5.0), 5.0), 0);
        let count = abi::tb_coord_flush(h);
        assert_eq!(count, 2);
        let index = core::slice::from_raw_parts(abi::tb_coord_out_index(h), 6);
        let bytes = abi::tb_coord_out_bytes(h);
        let second = tb_protocol::decode(core::slice::from_raw_parts(bytes.add(index[4] as usize), index[5] as usize)).unwrap();
        assert_eq!((index[0], index[3], second.header.kind, second.header.request), (1, 1, Kind::Infer, 1));
        assert_eq!(abi::tb_coord_flush(h), 0);
        assert!(abi::tb_coord_next_deadline(h).is_nan());
        // Errors.
        assert_eq!(send(9, &frame(Kind::Draft), 0.0), abi::ERR_LINK);
        let mut bad = Frame::new(Header::new(Kind::Config), &b"{"[..]);
        assert_eq!(send(0, &bad, 0.0), abi::ERR_CONFIG);
        let message = core::slice::from_raw_parts(abi::tb_last_error_ptr(), abi::tb_last_error_len());
        assert_eq!(message, InputError::InvalidConfig.message().as_bytes());
        bad.payload.clear();
        let mut truncated = bad.encode();
        truncated.pop();
        let ptr = abi::tb_alloc(truncated.len());
        core::ptr::copy_nonoverlapping(truncated.as_ptr(), ptr, truncated.len() - 1);
        assert_eq!(abi::tb_coord_input(h, 0, ptr, 10, 0.0), abi::ERR_DECODE);
        abi::tb_free(ptr, truncated.len());
        abi::tb_coord_free(h);
    }
}

// ───────────────────────── native benchmark (opt-in) ─────────────────────────

/// `cargo test -p tb-coordinator --release -- --ignored --nocapture bench_`
#[test]
#[ignore]
fn bench_draft_input_native() {
    use std::time::Instant;
    const N: usize = 200_000;
    const WARMUP: usize = 20_000;
    let texts: Vec<String> = (0..64).map(|i| format!("average speed by hour for vessel {i}")).collect();
    let frames: Vec<Vec<u8>> = (0..N + WARMUP).map(|i| H::draft_frame(Kind::Draft, i as u32 + 2, &texts[i & 63], 2.0).encode()).collect();
    let report = |name: &str, mut samples: Vec<f64>| {
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| samples[((samples.len() as f64 * q) as usize).min(samples.len() - 1)] * 1e6;
        println!("{name}: median {:.3} µs, p99 {:.3} µs, p99.9 {:.3} µs", p(0.5), p(0.99), p(0.999));
    };
    let t = Instant::now();
    for _ in 0..N {
        std::hint::black_box(Instant::now());
    }
    println!("Instant::now() overhead ≈ {:.3} µs", t.elapsed().as_secs_f64() * 1e6 / N as f64);
    for (name, config) in [
        ("latest, in flight (stored only)", r#"{"freeSlots":[1,2],"inferencePolicy":"latest"}"#),
        ("restart, CANCEL+INFER", r#"{"freeSlots":[1,2],"inferencePolicy":"restart","translationCache":false}"#),
    ] {
        let mut h = H::with_config(config);
        h.draft(1, "avg speed");
        let mut c = h.c;
        c.clear_outbox();
        let mut input_samples = Vec::with_capacity(N);
        let mut encode_samples = Vec::with_capacity(N);
        let mut out = Vec::with_capacity(4096);
        for (i, bytes) in frames.iter().enumerate() {
            let t0 = Instant::now();
            let frame = tb_protocol::decode(bytes).unwrap();
            c.input(Ui, frame, 3.0).unwrap();
            let t1 = Instant::now();
            out.clear();
            for (_, f) in c.drain() {
                tb_protocol::encode_into(&f.header, &f.stamps, &f.payload, &mut out);
            }
            let t2 = Instant::now();
            if i >= WARMUP {
                input_samples.push((t1 - t0).as_secs_f64());
                encode_samples.push((t2 - t1).as_secs_f64());
            }
        }
        report(&format!("native {name}: decode+input"), input_samples);
        report(&format!("native {name}: drain+encode"), encode_samples);
    }
}
