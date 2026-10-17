use super::*;

#[test]
fn adopting_a_displayed_result_advances_the_fence_past_a_pending_detour() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let a = one(&h.target_draft(90, 1, 1, "average wind", false), Inference, Kind::Infer).header.request;
    h.sql(a, "SELECT 1"); h.done(a);
    let b = one(&h.target_draft(90, 1, 2, "maximum wind", false), Inference, Kind::Infer).header.request;
    let adopted = h.target_draft(90, 1, 3, "average wind", false);
    assert_eq!(one(&adopted, Ui, Kind::Candidate).header.revision, 3);
    let stale = h.sql(b, "SELECT 2");
    assert!(!kinds(&stale).contains(&(Database, Kind::Exec)));
    assert!(!kinds(&stale).contains(&(Renderer, Kind::Bind)));
}

#[test]
fn target_sequence_is_immutable_and_registered_slots_cannot_reenter_the_pool() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    h.config(r#"{"freeSlots":[90]}"#);
    assert!(!h.c.pool.contains(&90));
    h.target_draft(90, 1, 1, "average wind", false);
    let mut f = H::draft_frame(Kind::Commit, 1, "", h.now);
    f.header.request = 90; f.payload = 1u32.to_le_bytes().to_vec(); f.payload.extend_from_slice(b"maximum wind");
    assert_eq!(h.try_send(Ui, f).unwrap_err(), InputError::InvalidPayload);
    assert_eq!(h.c.targets[&90].draft.as_ref().unwrap().text, "average wind");
}

#[test]
fn releasing_a_translation_that_was_not_executed_still_emits_a_terminal_outcome() {
    let mut h = H::new(); h.config(r#"{"speculate":false}"#); h.target_control(Kind::RegisterTarget, 90, 1);
    let id = one(&h.target_draft(90, 1, 1, "average wind", false), Inference, Kind::Infer).header.request;
    h.sql(id, "SELECT 1");
    let out = h.target_control(Kind::ReleaseTarget, 90, 1);
    assert!(text(one(&out, Ui, Kind::Execution)).contains("cancelled"));
}

#[test]
fn query_sequence_and_release_tombstones_fence_reordered_controls() {
    let mut h = H::new();
    h.target_control(Kind::ReleaseTarget, 90, 1);
    assert!(h.target_control(Kind::RegisterTarget, 90, 1).is_empty());
    assert!(h.target_query(90, 1, 1, "SELECT 1").is_empty());
    h.target_control(Kind::RegisterTarget, 90, 2);
    let latest = one(&h.target_query(90, 2, 2, "SELECT 2"), Database, Kind::Exec).header.request;
    assert!(h.target_query(90, 2, 1, "SELECT 1").is_empty());
    assert!(h.target_query(90, 2, 2, "SELECT 3").is_empty());
    assert!(text(one(&h.done(latest), Ui, Kind::Execution)).contains("succeeded"));
    h.target_draft(90, 2, 5, "newer text", false);
    assert!(h.target_query(90, 2, 4, "SELECT 4").is_empty());
}

#[test]
fn adoption_before_translation_does_not_announce_an_empty_candidate() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let id = one(&h.target_draft(90, 1, 1, "average wind", false), Inference, Kind::Infer).header.request;
    h.target_draft(90, 1, 2, "average wind extra", false);
    let out = h.target_draft(90, 1, 3, "average wind", false);
    assert!(!kinds(&out).contains(&(Ui, Kind::Candidate)));
    let out = h.sql(id, "SELECT 1");
    assert_eq!(one(&out, Ui, Kind::Candidate).header.revision, 3);
}

impl H {
    fn target_control(&mut self, kind: Kind, slot: u32, generation: u32) -> Out {
        let mut payload = slot.to_le_bytes().to_vec(); payload.extend_from_slice(&generation.to_le_bytes());
        let mut f = Frame::new(Header::new(kind), payload); f.header.context = CTX; f.header.epoch = self.epoch();
        self.send(Ui, f)
    }
    fn target_draft(&mut self, slot: u32, generation: u32, revision: u32, text: &str, commit: bool) -> Out {
        let mut f = H::draft_frame(if commit { Kind::Commit } else { Kind::Draft }, revision, "", self.now);
        f.header.epoch = self.epoch(); f.header.request = slot;
        f.payload = generation.to_le_bytes().to_vec(); f.payload.extend_from_slice(text.as_bytes()); self.send(Ui, f)
    }
    fn target_query(&mut self, slot: u32, generation: u32, revision: u32, sql: &str) -> Out {
        let mut f = self.req_frame(Kind::Query, generation, &[]); f.header.context = CTX; f.header.revision = revision;
        f.payload = slot.to_le_bytes().to_vec(); f.payload.extend_from_slice(sql.as_bytes()); self.send(Ui, f)
    }
    fn edit_base(&mut self, slot: u32, generation: u32, sql: &str) -> Out {
        let mut f = frame(Kind::EditContext); f.header.request = slot; f.header.revision = generation; f.header.context = CTX;
        f.payload = format!(r#"{{"mode":"refine","originalQuestion":"original","sql":"{sql}","history":[],"presentation":{{"view":null,"params":{{}}}}}}"#).into_bytes();
        self.send(Ui, f)
    }
    fn edit_ready(&mut self) -> Out {
        self.send(Inference, Frame::new(Header::new(Kind::Ready), br#"{"capabilities":["edit-context-v1"]}"#))
    }
}

#[test]
fn restored_target_executes_sql_without_inference_and_announces_it_before_exec() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let out = h.target_query(90, 1, 1, "SELECT 1");
    assert_eq!(kinds(&out), [(Ui, Kind::Candidate), (Renderer, Kind::Bind), (Ui, Kind::Bind), (Database, Kind::Exec)]);
    assert!(text(one(&out, Ui, Kind::Candidate)).contains(r#""generation":1,"sql":"SELECT 1""#));
    let id = one(&out, Database, Kind::Exec).header.request;
    let done = h.done(id); assert!(text(one(&done, Ui, Kind::Execution)).contains("succeeded"));
    assert!(h.done(id).is_empty());
}

#[test]
fn releasing_one_target_cancels_only_its_execution_and_rejects_late_generations() {
    let mut h = H::new();
    h.target_control(Kind::RegisterTarget, 90, 1); h.target_control(Kind::RegisterTarget, 91, 1);
    let a = one(&h.target_query(90, 1, 1, "SELECT 1"), Database, Kind::Exec).header.request;
    let b = one(&h.target_query(91, 1, 1, "SELECT 2"), Database, Kind::Exec).header.request;
    let out = h.target_control(Kind::ReleaseTarget, 90, 1);
    assert_eq!(one(&out, Database, Kind::Cancel).header.request, a);
    assert!(text(one(&out, Ui, Kind::Execution)).contains("cancelled"));
    assert!(h.done(a).is_empty());
    assert!(text(one(&h.done(b), Ui, Kind::Execution)).contains("succeeded"));
    h.target_control(Kind::RegisterTarget, 90, 2);
    assert!(h.target_control(Kind::RegisterTarget, 90, 1).is_empty());
    assert!(h.target_query(90, 1, 3, "SELECT 3").is_empty());
    one(&h.target_query(90, 2, 1, "SELECT 4"), Database, Kind::Exec);
}

#[test]
fn new_edit_generation_has_its_own_sequence_order() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let a = one(&h.target_draft(90, 1, 40, "original question", false), Inference, Kind::Infer).header.request;
    h.sql(a, "SELECT 1"); h.done(a);
    h.target_control(Kind::RegisterTarget, 90, 2);
    one(&h.target_draft(90, 2, 1, "new question", false), Inference, Kind::Infer);
    assert!(h.target_draft(90, 1, 100, "stale question", false).is_empty());
}

#[test]
fn target_sql_survives_database_failure_and_terminal_outcomes_are_absorbing() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let id = one(&h.target_draft(90, 1, 1, "original", true), Inference, Kind::Infer).header.request;
    let sql = h.sql(id, "SELECT missing"); one(&sql, Ui, Kind::Candidate);
    assert!(text(one(&h.error(Database, id), Ui, Kind::Execution)).contains("failed"));
    assert!(h.done(id).is_empty()); assert!(h.error(Database, id).is_empty());
}

#[test]
fn renderer_failure_does_not_turn_sql_success_into_failure() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let id = one(&h.target_query(90, 1, 1, "SELECT 1"), Database, Kind::Exec).header.request;
    let error = h.error(Renderer, id); assert!(!kinds(&error).contains(&(Ui, Kind::Execution)));
    assert_eq!(kinds(&error), [(Ui, Kind::Error)], "a target keeps its binding");
    assert!(text(one(&h.done(id), Ui, Kind::Execution)).contains("succeeded"));
}

#[test]
fn source_suspension_finishes_running_targets_even_if_next_open_never_succeeds() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let id = one(&h.target_query(90, 1, 1, "SELECT 1"), Database, Kind::Exec).header.request;
    let out = h.context(0);
    assert_eq!(one(&out, Database, Kind::Cancel).header.request, id);
    assert!(text(one(&out, Ui, Kind::Execution)).contains("cancelled"));
    assert!(h.done(id).is_empty());
}

#[test]
fn edit_bases_scope_translation_cache_and_are_replayed_on_reconnect() {
    let mut h = H::new(); h.edit_ready(); h.target_control(Kind::RegisterTarget, 90, 1);
    one(&h.edit_base(90, 1, "SELECT 1"), Inference, Kind::EditContext);
    let a = one(&h.target_draft(90, 1, 1, "same change", false), Inference, Kind::EditInfer).header.request;
    h.sql(a, "SELECT 11"); h.done(a);
    h.target_control(Kind::RegisterTarget, 91, 1); h.edit_base(91, 1, "SELECT 2");
    let b = one(&h.target_draft(91, 1, 1, "same change", false), Inference, Kind::EditInfer).header.request;
    assert!(b > a); h.sql(b, "SELECT 22"); h.done(b);
    h.target_control(Kind::RegisterTarget, 92, 1); h.edit_base(92, 1, "SELECT 1");
    let out = h.target_draft(92, 1, 1, "same change", false);
    assert!(!kinds(&out).contains(&(Inference, Kind::EditInfer)));
    assert_eq!(text(one(&out, Database, Kind::Exec)), "SELECT 11");
    let ready = h.edit_ready(); assert_eq!(ready.iter().filter(|(l, f)| *l == Inference && f.header.kind == Kind::EditContext).count(), 3);
}

#[test]
fn unsupported_inference_never_receives_edit_messages() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    assert!(h.edit_base(90, 1, "SELECT 1").is_empty());
    let out = h.target_draft(90, 1, 1, "weekly instead", true);
    assert!(!out.iter().any(|(l, _)| *l == Inference));
    one(&out, Ui, Kind::Error); one(&out, Ui, Kind::Execution);
}

#[test]
fn completed_and_running_text_adoption_serve_exact_candidate_sequences() {
    for finish_before_adopt in [false, true] {
        let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
        let id = one(&h.target_draft(90, 1, 1, "same text", false), Inference, Kind::Infer).header.request;
        h.sql(id, "SELECT 1"); if finish_before_adopt { h.done(id); }
        let out = h.target_draft(90, 1, 2, "same text", true);
        assert_eq!(one(&out, Ui, Kind::Candidate).header.revision, 2);
        let completed = if finish_before_adopt { out } else { h.done(id) };
        let event = one(&completed, Ui, Kind::Execution); assert_eq!(event.header.revision, 2); assert_eq!(event.header.request, id);
        assert!(h.done(id).is_empty());
    }
}

#[test]
fn several_pending_commits_survive_switching_the_active_editor() {
    let mut h = H::new(); for slot in 90..=92 { h.target_control(Kind::RegisterTarget, slot, 1); }
    let a = one(&h.target_draft(90, 1, 40, "first", true), Inference, Kind::Infer).header.request;
    assert!(h.target_draft(91, 1, 1, "second", true).is_empty());
    assert!(h.target_draft(92, 1, 1, "third", true).is_empty());
    let b = one(&h.sql(a, "SELECT 1"), Inference, Kind::Infer).clone(); assert_eq!(text(&b), "second");
    let c = one(&h.sql(b.header.request, "SELECT 2"), Inference, Kind::Infer).clone(); assert_eq!(text(&c), "third");
    let last = h.sql(c.header.request, "SELECT 3"); one(&last, Database, Kind::Exec);
}

// ───────────────────────── review regressions (2026-10-17) ─────────────────────────

#[test]
fn commit_after_targeted_query_never_reports_the_superseded_translation() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    let a = one(&h.target_draft(90, 1, 1, "average wind", false), Inference, Kind::Infer).header.request;
    h.sql(a, "SELECT 1"); h.done(a);
    let q = one(&h.target_query(90, 1, 2, "SELECT 2"), Database, Kind::Exec).header.request;
    h.done(q);
    // The screen shows SELECT 2. Committing the old text must execute its SQL again,
    // never announce SELECT 1 as succeeded without BIND/EXEC.
    let out = h.target_draft(90, 1, 3, "average wind", true);
    assert!(!kinds(&out).contains(&(Ui, Kind::Execution)), "{:?}", kinds(&out));
    let exec = one(&out, Database, Kind::Exec).clone();
    assert_eq!(text(&exec), "SELECT 1");
    assert_eq!(exec.header.revision, 3);
    one(&out, Renderer, Kind::Bind);
    let done = h.done(exec.header.request);
    let event = one(&done, Ui, Kind::Execution);
    assert!(text(event).contains("succeeded")); assert_eq!(event.header.revision, 3);
}

#[test]
fn commit_after_targeted_query_reexecutes_when_head_moved_to_another_target() {
    // Head moved to another target; the bound QUERY result has no text, so the commit re-executes.
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1); h.target_control(Kind::RegisterTarget, 91, 1);
    let a = one(&h.target_draft(90, 1, 1, "average wind", false), Inference, Kind::Infer).header.request;
    h.sql(a, "SELECT 1"); h.done(a);
    let q = one(&h.target_query(90, 1, 2, "SELECT 2"), Database, Kind::Exec).header.request;
    h.done(q);
    let b = one(&h.target_draft(91, 1, 1, "maximum wind", false), Inference, Kind::Infer).header.request;
    h.sql(b, "SELECT 9"); h.done(b);
    let out = h.target_draft(90, 1, 3, "average wind", true);
    assert!(!kinds(&out).contains(&(Ui, Kind::Execution)));
    assert_eq!(text(one(&out, Database, Kind::Exec)), "SELECT 1");
}

#[test]
fn reregistering_a_target_with_an_inflight_commit_starts_the_next_queued_commit() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1); h.target_control(Kind::RegisterTarget, 91, 1);
    let a = one(&h.target_draft(90, 1, 1, "average wind", true), Inference, Kind::Infer).header.request;
    assert!(h.target_draft(91, 1, 1, "maximum wind", true).is_empty());
    let out = h.target_control(Kind::RegisterTarget, 90, 2);
    assert_eq!(one(&out, Inference, Kind::Cancel).header.request, a);
    assert_eq!(text(one(&out, Inference, Kind::Infer)), "maximum wind");
}

#[test]
fn requests_of_released_or_replaced_targets_are_collected() {
    let mut h = H::new();
    for s in 100..300u32 {
        h.target_control(Kind::RegisterTarget, s, 1);
        h.target_query(s, 1, 1, "SELECT 1");
        h.target_control(Kind::ReleaseTarget, s, 1);
    }
    assert!(h.c.tracked_requests() <= 1, "released: {}", h.c.tracked_requests());
    let mut h = H::new();
    for g in 1..=200u32 {
        h.target_control(Kind::RegisterTarget, 90, g);
        h.target_query(90, g, 1, "SELECT 1");
    }
    assert!(h.c.tracked_requests() <= 2, "replaced: {}", h.c.tracked_requests());
}

#[test]
fn full_cancel_reports_target_outcomes_under_the_new_epoch() {
    let mut h = H::new(); h.target_control(Kind::RegisterTarget, 90, 1);
    one(&h.target_draft(90, 1, 1, "average wind", true), Inference, Kind::Infer);
    let before = h.epoch();
    let out = h.cancel();
    let event = one(&out, Ui, Kind::Execution);
    assert!(text(event).contains("cancelled"));
    assert_eq!(event.header.epoch, h.epoch()); assert!(h.epoch() > before);
}

#[test]
fn released_placeholders_are_bounded_and_evicted_slots_stay_fenced() {
    let cap = crate::targets::TARGET_CAPACITY as u32;
    let mut h = H::new();
    h.target_control(Kind::RegisterTarget, 10, 1); // an old slot that stays open
    for s in 11..11 + cap + 500 {
        h.target_control(Kind::RegisterTarget, s, 1);
        h.target_control(Kind::ReleaseTarget, s, 1);
    }
    assert!(h.c.targets.len() <= cap as usize);
    // A new slot still registers; an evicted released slot can never come back.
    one(&h.target_control(Kind::RegisterTarget, 11 + cap + 500, 1), Ui, Kind::RegisterTarget);
    assert!(h.target_control(Kind::RegisterTarget, 11, 2).is_empty());
    assert!(h.target_query(11, 2, 1, "SELECT 1").is_empty());
    assert!(h.target_control(Kind::ReleaseTarget, 12, 1).is_empty());
    // The open old target is untouched.
    one(&h.target_query(10, 1, 1, "SELECT 1"), Database, Kind::Exec);
}
