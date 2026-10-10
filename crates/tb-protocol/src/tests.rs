use super::*;

const VECTORS: &str = include_str!("../vectors/frames.json");

// The generator writes one compact JSON object per line; parse just enough of it
// so the crate keeps zero dependencies.
fn field<'a>(object: &'a str, key: &str) -> &'a str {
    let start = object.find(&format!("\"{key}\":")).unwrap_or_else(|| panic!("missing {key}")) + key.len() + 3;
    let rest = &object[start..];
    let end = if rest.starts_with('"') {
        rest[1..].find('"').unwrap() + 2
    } else if rest.starts_with('[') {
        rest.find(']').unwrap() + 1
    } else {
        rest.find([',', '}']).unwrap()
    };
    rest[..end].trim_matches('"')
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn objects(section: &str) -> Vec<&str> {
    let lines = VECTORS.lines().filter(|line| line.starts_with("{\"name\""));
    lines.filter(|line| line.contains("\"error\"") == (section == "invalid")).collect()
}

fn stamps_of(object: &str) -> Vec<Stamp> {
    let raw = field(object, "stamps");
    raw.split('{').skip(1).map(|s| Stamp {
        stage: field(s, "stage").parse().unwrap(),
        node: field(s, "node").parse().unwrap(),
        at: field(s, "at").parse().unwrap(),
    }).collect()
}

#[test]
fn golden_valid_vectors_round_trip() {
    let valid = objects("valid");
    assert!(valid.len() >= 10);
    for object in valid {
        let name = field(object, "name");
        let bytes = hex(field(object, "hex"));
        let frame = decode(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        let header = Header {
            kind: Kind::from_u8(field(object, "kind").parse().unwrap()).unwrap(),
            flags: field(object, "flags").parse().unwrap(),
            epoch: field(object, "epoch").parse().unwrap(),
            request: field(object, "request").parse().unwrap(),
            revision: field(object, "revision").parse().unwrap(),
            context: field(object, "context").parse().unwrap(),
        };
        assert_eq!(frame.header, header, "{name}");
        let stamps = stamps_of(object);
        assert_eq!(frame.stamps().collect::<Vec<_>>(), stamps, "{name}");
        let payload = hex(field(object, "payload_hex"));
        assert_eq!(frame.payload, &payload[..], "{name}");
        let mut out = Vec::new();
        encode_into(&header, &stamps, &payload, &mut out);
        assert_eq!(out, bytes, "{name}: encode");
        assert_eq!(frame.to_owned().encode(), bytes, "{name}: owned encode");
    }
}

#[test]
fn golden_invalid_vectors_fail_with_expected_error() {
    for object in objects("invalid") {
        let name = field(object, "name");
        let error = decode(&hex(field(object, "hex"))).expect_err(name);
        let label = format!("{error:?}");
        assert!(label.starts_with(field(object, "error")), "{name}: got {label}");
    }
}

#[test]
fn payload_starts_eight_byte_aligned() {
    for stamps in 0..4 {
        assert_eq!(encoded_len(stamps, 0) % 8, 0);
    }
}

#[test]
fn decode_prefix_reads_concatenated_frames() {
    let mut out = Vec::new();
    encode_into(&Header::new(Kind::Draft), &[], b"one", &mut out);
    encode_into(&Header::new(Kind::Commit), &[], b"two", &mut out);
    let (first, used) = decode_prefix(&out).unwrap();
    assert_eq!(first.text().unwrap(), "one");
    let (second, rest) = decode_prefix(&out[used..]).unwrap();
    assert_eq!(second.header.kind, Kind::Commit);
    assert_eq!(used + rest, out.len());
}

#[test]
fn every_kind_round_trips_its_byte() {
    for kind in Kind::ALL {
        assert_eq!(Kind::from_u8(kind as u8), Some(kind));
    }
    assert_eq!(Kind::from_u8(0x00), None);
}
