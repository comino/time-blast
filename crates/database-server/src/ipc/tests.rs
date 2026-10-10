use super::*;

const SMALL: &[u8] = include_bytes!("../../tests/fixtures/small.arrows");
const EXCEPTION: &[u8] = include_bytes!("../../tests/fixtures/exception.arrows");
const EMPTY: &[u8] = include_bytes!("../../tests/fixtures/empty.arrows");
const LZ4: &[u8] = include_bytes!("../../tests/fixtures/lz4.arrows");
const LIMIT: usize = 16 << 20;

/// Split `stream`, feeding it in pieces of `step` bytes. Returns the items, the error (if
/// any) and the bytes left unconsumed after it.
fn split(stream: &[u8], step: usize, prefix: usize) -> (Vec<Item>, Option<IpcError>, Vec<u8>) {
    let mut splitter = Splitter::new(LIMIT);
    let mut items = Vec::new();
    for (index, chunk) in stream.chunks(step).enumerate() {
        let mut input = chunk;
        while !input.is_empty() {
            match splitter.feed(&mut input, |_| Some(prefix)) {
                Ok(Some(item)) => items.push(item),
                Ok(None) => {}
                Err(error) => {
                    let mut rest = splitter.take_buffered();
                    rest.extend_from_slice(input);
                    rest.extend_from_slice(&stream[((index + 1) * step).min(stream.len())..]);
                    return (items, Some(error), rest);
                }
            }
        }
    }
    assert!(splitter.finish().is_ok());
    (items, None, Vec::new())
}

fn payloads(items: &[Item]) -> Vec<(&MessageInfo, &[u8])> {
    items
        .iter()
        .filter_map(|item| match item {
            Item::Message { info, buf, prefix } => Some((info, &buf[*prefix..])),
            _ => None,
        })
        .collect()
}

#[test]
fn splits_schema_batches_and_end_marker_identically_for_any_chunking() {
    let whole = split(SMALL, SMALL.len(), 0);
    for step in [1, 3, 7, 8, 64, 333] {
        let pieces = split(SMALL, step, 40);
        assert_eq!(pieces.0.len(), whole.0.len(), "step {step}");
        let a = payloads(&whole.0);
        let b = payloads(&pieces.0);
        assert_eq!(a.len(), b.len());
        for ((ia, pa), (ib, pb)) in a.iter().zip(&b) {
            assert_eq!(ia, ib);
            assert_eq!(pa, pb);
        }
    }
    let messages = payloads(&whole.0);
    assert_eq!(messages[0].0.header, HeaderType::Schema);
    assert_eq!(messages[0].0.fields.len(), 4);
    let rows: Vec<u64> = messages[1..].iter().map(|(info, _)| info.rows).collect();
    assert_eq!(rows, vec![4, 4, 2], "max_block_size=4 over 10 rows");
    assert!(messages[1..].iter().all(|(info, _)| info.header == HeaderType::RecordBatch && !info.compressed));
    assert!(matches!(whole.0.last(), Some(Item::End)));
}

#[test]
fn forwarded_messages_concatenate_back_to_the_original_stream() {
    // protocol-v1: RESULT_SCHEMA + every BATCH + an end marker is a valid IPC stream.
    let (items, error, _) = split(SMALL, 5, 0);
    assert!(error.is_none());
    let mut joined: Vec<u8> = payloads(&items).iter().flat_map(|(_, p)| p.iter().copied()).collect();
    joined.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]);
    assert_eq!(joined, SMALL);
}

#[test]
fn reserves_a_zeroed_prefix_and_keeps_bodies_8_aligned() {
    let (items, _, _) = split(SMALL, 11, 24 + 16);
    for item in &items {
        if let Item::Message { info, buf, prefix } = item {
            assert_eq!(*prefix, 40);
            assert!(buf[..40].iter().all(|b| *b == 0));
            assert_eq!(buf.len(), 40 + info.payload_len);
            assert_eq!(buf.capacity(), buf.len(), "exactly one allocation per message");
            let meta = u32::from_le_bytes(buf[44..48].try_into().unwrap()) as usize;
            assert_eq!((8 + meta) % 8, 0, "body starts 8-aligned within the payload");
            assert_eq!(info.payload_len, 8 + meta + info.body_len);
        }
    }
}

#[test]
fn pads_metadata_whose_length_is_not_a_multiple_of_8() {
    // Rewrite the schema message with one extra metadata byte (7 bytes short of alignment).
    let meta_len = u32::from_le_bytes(SMALL[4..8].try_into().unwrap()) as usize;
    let mut odd = Vec::new();
    odd.extend_from_slice(&SMALL[..4]);
    odd.extend_from_slice(&((meta_len + 1) as u32).to_le_bytes());
    odd.extend_from_slice(&SMALL[8..8 + meta_len]);
    odd.push(0xAB);
    odd.extend_from_slice(&SMALL[8 + meta_len..]);
    let (items, error, _) = split(&odd, 13, 0);
    assert!(error.is_none());
    let messages = payloads(&items);
    let schema = messages[0].1;
    let padded = u32::from_le_bytes(schema[4..8].try_into().unwrap()) as usize;
    assert_eq!(padded, meta_len + 8);
    assert_eq!(schema[8 + meta_len], 0xAB);
    assert!(schema[9 + meta_len..8 + padded].iter().all(|b| *b == 0));
    let whole = split(SMALL, SMALL.len(), 0).0;
    let original = payloads(&whole);
    assert_eq!(messages[1].1, original[1].1, "batches after it are untouched");
}

#[test]
fn stops_at_an_appended_clickhouse_exception() {
    let (items, error, rest) = split(EXCEPTION, 100, 0);
    assert_eq!(error, Some(IpcError::NotIpc));
    let rows: u64 = payloads(&items).iter().map(|(info, _)| info.rows).sum();
    assert_eq!(rows, 1000, "the 1000-row block before the limit fired");
    let text = String::from_utf8_lossy(&rest);
    assert!(text.trim_start().starts_with("__exception__"), "{text}");
    assert!(text.contains("Code: 396."), "{text}");
}

#[test]
fn empty_result_is_schema_then_end() {
    let (items, error, _) = split(EMPTY, 9, 0);
    assert!(error.is_none());
    assert_eq!(items.len(), 2);
    assert!(matches!(&items[0], Item::Message { info, .. } if info.header == HeaderType::Schema));
    assert!(matches!(items[1], Item::End));
}

#[test]
fn reports_body_compression() {
    let (items, _, _) = split(LZ4, LZ4.len(), 0);
    let batches: Vec<_> = payloads(&items).into_iter().filter(|(i, _)| i.header == HeaderType::RecordBatch).collect();
    assert!(!batches.is_empty());
    assert!(batches.iter().all(|(info, _)| info.compressed));
}

#[test]
fn skipped_messages_discard_their_body() {
    let mut splitter = Splitter::new(LIMIT);
    let mut input = SMALL;
    let mut kinds = Vec::new();
    while !input.is_empty() {
        if let Some(item) = splitter.feed(&mut input, |info| (info.header == HeaderType::Schema).then_some(0)).unwrap() {
            kinds.push(match item {
                Item::Message { .. } => "message",
                Item::Skipped(_) => "skipped",
                Item::End => "end",
            });
        }
    }
    assert_eq!(kinds, ["message", "skipped", "skipped", "skipped", "end"]);
}

#[test]
fn truncated_streams_and_oversized_messages_are_errors() {
    let mut splitter = Splitter::new(LIMIT);
    let mut input = &SMALL[..SMALL.len() / 2];
    while !input.is_empty() {
        splitter.feed(&mut input, |_| Some(0)).unwrap();
    }
    assert_eq!(splitter.finish(), Err(IpcError::Truncated));

    let mut tiny = Splitter::new(64);
    let mut input = SMALL;
    assert!(matches!(tiny.feed(&mut input, |_| Some(0)), Err(IpcError::TooLarge(_))));

    let mut garbage = Splitter::new(LIMIT);
    let mut input: &[u8] = &[0xFF, 0xFF, 0xFF, 0xFF, 16, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    assert!(matches!(garbage.feed(&mut input, |_| Some(0)), Err(IpcError::Malformed(_))));
}

#[test]
fn ambiguous_schemas_are_detected_from_arrow_types() {
    let (items, _, _) = split(SMALL, SMALL.len(), 0);
    let schema = &payloads(&items)[0].0.fields;
    // n UInt64, s Utf8, t Timestamp, dt DateTime → UInt32.
    assert_eq!(schema[0].int, Some((64, false)));
    assert_eq!(schema[3].int, Some((32, false)));
    assert!(schema_is_ambiguous(schema));
    assert!(!schema_is_ambiguous(&schema[..3]));
}
