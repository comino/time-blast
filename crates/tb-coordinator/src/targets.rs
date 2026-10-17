//! Registered document targets share the existing inference pump and EXEC path.
//! Generation denotes one immutable edit/refresh incarnation, never a durable ID.
use super::*;

pub(super) const PRESERVE_VIEW: u32 = 256;
/// Target entries kept (active targets plus released-generation tombstones).
pub(crate) const TARGET_CAPACITY: usize = 10000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TargetKey { pub slot: u32, pub generation: u32 }
pub(super) struct Target {
    pub generation: u32,
    pub context: u32,
    pub active: bool,
    pub base: Option<Rc<[u8]>>,
    pub bound: Option<u32>,
    pub shown_revision: u32,
    pub draft: Option<Draft>,
}
fn key(bytes: &[u8]) -> Result<TargetKey, InputError> {
    if bytes.len() != 8 { return Err(InputError::InvalidPayload); }
    let slot = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    let generation = u32::from_le_bytes(bytes[4..].try_into().unwrap());
    if slot == 0 || generation == 0 { return Err(InputError::InvalidPayload); }
    Ok(TargetKey { slot, generation })
}

impl Coordinator {
    pub(super) fn target_valid(&self, key: TargetKey, context: u32) -> bool {
        self.targets.get(&key.slot).is_some_and(|t| t.active && t.generation == key.generation && t.context == context)
    }
    pub(super) fn register_target(&mut self, frame: FrameRef<'_>, now: f64) -> Result<(), InputError> {
        let key = key(frame.payload)?;
        if frame.header.epoch < self.epoch { self.stats.dropped_epoch += 1; return Ok(()); }
        if let Some(old) = self.targets.get(&key.slot) {
            if old.generation >= key.generation { self.stats.dropped_request += 1; return Ok(()); }
            let previous = TargetKey { slot: key.slot, generation: old.generation };
            self.cancel_target(previous, false);
        } else if !self.make_room(key.slot)? { return Ok(()); }
        // Document slots are never available to the ordinary live-preview pool.
        self.pool.retain(|&slot| slot != key.slot);
        self.targets.insert(key.slot, Target { generation: key.generation, context: frame.header.context,
            active: true, base: None, bound: None, shown_revision: 0, draft: None });
        self.emit(LinkId::Renderer, self.header(Kind::RegisterTarget, key.slot, key.generation, frame.header.context), Vec::new(), frame.payload.to_vec());
        self.emit(LinkId::Ui, self.header(Kind::RegisterTarget, key.slot, key.generation, frame.header.context), Vec::new(), frame.payload.to_vec());
        // The replaced generation may have held the one committed translation.
        self.pump(now);
        Ok(())
    }
    /// Room for a new slot entry. Released placeholders are evicted lowest slot first and
    /// leave `released_floor` behind: UI slot numbers only grow, so an absent slot below the
    /// floor is a released one and stays fenced. `Ok(false)` drops a frame for such a slot.
    fn make_room(&mut self, slot: u32) -> Result<bool, InputError> {
        if slot < self.released_floor { self.stats.dropped_request += 1; return Ok(false); }
        if self.targets.len() < TARGET_CAPACITY { return Ok(true); }
        let Some(evict) = self.targets.iter().find(|(_, t)| !t.active).map(|(&s, _)| s) else { return Err(InputError::InvalidPayload) };
        self.targets.remove(&evict);
        self.released_floor = self.released_floor.max(evict + 1);
        Ok(slot >= self.released_floor || { self.stats.dropped_request += 1; false })
    }
    pub(super) fn release_target(&mut self, frame: FrameRef<'_>, now: f64) -> Result<(), InputError> {
        let key = key(frame.payload)?;
        if let Some(old) = self.targets.get(&key.slot) {
            if old.generation > key.generation || (old.generation == key.generation && !old.active) { return Ok(()); }
            let old = TargetKey { slot: key.slot, generation: old.generation };
            self.cancel_target(old, true);
        } else if !self.make_room(key.slot)? { return Ok(()); }
        self.targets.insert(key.slot, Target { generation: key.generation, context: frame.header.context,
            active: false, base: None, bound: None, shown_revision: 0, draft: None });
        self.pool.retain(|&slot| slot != key.slot);
        let h = self.header(Kind::ReleaseTarget, key.slot, key.generation, frame.header.context);
        self.emit(LinkId::Renderer, h, Vec::new(), frame.payload.to_vec());
        self.emit(LinkId::Ui, h, Vec::new(), frame.payload.to_vec());
        self.pump(now);
        Ok(())
    }
    fn cancel_target(&mut self, key: TargetKey, clear: bool) {
        for i in 0..self.requests.len() {
            if self.requests[i].target == Some(key) { self.cancel_request(i); }
        }
        if self.head.and_then(|id| self.find(id)).is_some_and(|i| self.requests[i].target == Some(key)) { self.head = None; }
        if self.draft.as_ref().is_some_and(|d| d.target == Some(key)) {
            self.draft.as_mut().unwrap().cancelled = true;
            self.head = None;
        }
        if clear {
            let request = self.targets.get(&key.slot).and_then(|t| t.bound).unwrap_or(0);
            let mut payload = key.slot.to_le_bytes().to_vec();
            payload.extend_from_slice(&PRESERVE_VIEW.to_le_bytes()); payload.extend_from_slice(&key.generation.to_le_bytes());
            let h = self.header(Kind::Unbind, request, 0, 0);
            self.emit(LinkId::Renderer, h, Vec::new(), payload.clone());
            self.emit(LinkId::Ui, h, Vec::new(), payload);
        }
    }
    pub(super) fn cancel_request(&mut self, i: usize) {
        let id = self.requests[i].id;
        if matches!(self.requests[i].phase, Phase::Translating | Phase::Delayed) { self.cancel_translation(i); }
        if self.requests[i].exec == Exec::Running {
            self.requests[i].exec = Exec::Cancelled;
            self.emit_cancel(LinkId::Database, id);
        }
        if self.requests[i].exec == Exec::Idle && self.requests[i].phase == Phase::Translated { self.requests[i].exec = Exec::Cancelled; }
        self.emit_outcome(i);
    }
    pub(super) fn prepare_edit(&mut self, frame: FrameRef<'_>) -> Result<(), InputError> {
        let key = TargetKey { slot: frame.header.request, generation: frame.header.revision };
        if !self.target_valid(key, frame.header.context) { self.stats.dropped_request += 1; return Ok(()); }
        if frame.payload.len() > 128 * 1024 || std::str::from_utf8(frame.payload).is_err() || !json::valid_object(frame.payload) {
            return Err(InputError::InvalidPayload);
        }
        let target = self.targets.get_mut(&key.slot).unwrap();
        if let Some(base) = &target.base { if &**base != frame.payload { return Err(InputError::InvalidPayload); } }
        target.base = Some(Rc::from(frame.payload));
        self.forward_edit(key);
        Ok(())
    }
    pub(super) fn forward_edit(&mut self, key: TargetKey) {
        let Some(t) = self.targets.get(&key.slot) else { return };
        if !self.edit_supported || !t.active || t.generation != key.generation || t.context != self.context { return; }
        if let Some(base) = &t.base {
            let h = self.header(Kind::EditContext, key.slot, key.generation, t.context);
            self.emit(LinkId::Inference, h, Vec::new(), base.to_vec());
        }
    }
    pub(super) fn emit_candidate(&mut self, i: usize) {
        let r = &self.requests[i];
        let Some(key) = r.target else { return };
        if r.sql.is_empty() { return; }
        let payload = json::candidate_payload(key.slot, key.generation, &r.sql);
        let h = self.header(Kind::Candidate, r.id, r.revision, r.context);
        self.emit(LinkId::Ui, h, Vec::new(), payload);
    }
    pub(super) fn emit_outcome(&mut self, i: usize) {
        let r = &mut self.requests[i];
        let Some(key) = r.target else { return };
        let status: &[u8] = match r.exec {
            Exec::Done => b"succeeded", Exec::Failed => b"failed", Exec::Cancelled => b"cancelled",
            Exec::Idle if r.phase == Phase::Failed => b"failed",
            Exec::Idle if r.phase == Phase::Cancelled => b"cancelled",
            _ => return,
        };
        if r.notified_revision == Some(r.revision) { return; }
        r.notified_revision = Some(r.revision);
        let h = Header { kind: Kind::Execution, flags: 0, epoch: self.epoch, request: r.id, revision: r.revision, context: r.context };
        let payload = json::execution_payload(key.slot, key.generation, status);
        self.emit(LinkId::Ui, h, Vec::new(), payload);
    }
    pub(super) fn show_target(&mut self, i: usize, now: f64) {
        let r = &self.requests[i];
        let Some(key) = r.target else { return };
        if !self.target_valid(key, r.context) || r.context != self.context { self.cancel_request(i); return; }
        let target = &self.targets[&key.slot];
        if r.revision < target.shown_revision { self.cancel_request(i); return; }
        let id = r.id;
        if let Some(old) = target.bound.filter(|&old| old != id).and_then(|old| self.find(old)) { self.supersede(old); }
        let r = &mut self.requests[i];
        r.slot = Some(key.slot); r.exec = Exec::Running;
        add_stamp(&mut r.ledger, coord(stage::EXEC_SENT, now));
        let (revision, context, committed, sql) = (r.revision, r.context, r.committed, r.sql.clone());
        let target = self.targets.get_mut(&key.slot).unwrap(); target.bound = Some(id); target.shown_revision = revision;
        self.emit_bind(LinkId::Renderer, i, key.slot);
        self.emit_bind(LinkId::Ui, i, key.slot);
        let mut h = self.header(Kind::Exec, id, revision, context);
        if !committed { h.flags = flags::SPECULATIVE; }
        self.stats.exec_sent += 1;
        self.emit(LinkId::Database, h, vec![coord(stage::EXEC_SENT, now)], sql);
    }
}
