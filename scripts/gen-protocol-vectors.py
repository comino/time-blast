#!/usr/bin/env python3
"""Generate golden tb1 frame vectors independently of the Rust and TS codecs.

Output: crates/tb-protocol/vectors/frames.json. Both codecs test against it.
"""
import json, struct, pathlib

def frame(kind, flags=0, epoch=0, request=0, revision=0, context=0, stamps=(), payload=b''):
    out = struct.pack('<BBBBIIIII', 1, kind, flags, len(stamps), len(payload), epoch, request, revision, context)
    for stage, node, at in stamps:
        out += struct.pack('<HHId', stage, node, 0, at)
    return out + payload

valid = [
    dict(name='draft', kind=0x10, revision=42, context=7, stamps=[(1, 1, 1760000000123.25), (2, 1, 1760000000123.5)],
         payload='average speed by hour'.encode()),
    dict(name='draft-composing-unicode', kind=0x10, flags=0x01, revision=43, context=7, payload='Wellenhöhe 🌊'.encode()),
    dict(name='commit', kind=0x11, revision=44, context=7, payload=b'max wind by vessel'),
    dict(name='cancel-all', kind=0x12, epoch=3),
    dict(name='infer', kind=0x18, epoch=3, request=9, revision=44, context=7, payload=b'max wind by vessel'),
    dict(name='sql-cached', kind=0x1A, flags=0x01, epoch=3, request=9, stamps=[(9, 3, 1760000000600.0)],
         payload=b'SELECT vessel, max(wind) FROM telemetry GROUP BY 1'),
    dict(name='exec-speculative', kind=0x20, flags=0x01, epoch=3, request=9, context=7, payload=b'SELECT 1'),
    dict(name='batch-header-only', kind=0x22, flags=0x80, epoch=3, request=9, stamps=[(13, 4, 1760000000650.125)]),
    dict(name='done', kind=0x23, epoch=3, request=9, payload=struct.pack('<QQ', 8640, 207360)),
    dict(name='bind', kind=0x30, epoch=3, request=9, revision=44, payload=struct.pack('<I', 2)),
    dict(name='drawn', kind=0x32, epoch=3, request=9, stamps=[(16, 5, 1760000000660.0)], payload=struct.pack('<II', 2, 8640)),
    dict(name='config', kind=0x06, payload=json.dumps({"live": True, "minChars": 3}, separators=(',', ':')).encode()),
    dict(name='prime', kind=0x1C, context=7,
         payload=json.dumps({"question": "max speed per vessel", "sql": "SELECT vessel, max(speed) AS speed FROM telemetry GROUP BY 1"}, separators=(',', ':')).encode()),
    dict(name='exec-warm', kind=0x20, flags=0x02, epoch=3, request=0x80000001, context=7, payload=b'SELECT 1'),
    dict(name='done-warm-cache', kind=0x23, flags=0x06, epoch=3, request=0x80000001, payload=struct.pack('<QQ', 1, 64)),
    dict(name='max-ids', kind=0x34, epoch=0xFFFFFFFF, request=0xFFFFFFFF, revision=0xFFFFFFFF, context=0xFFFFFFFF),
]
out = {'valid': [], 'invalid': []}
for v in valid:
    data = frame(v['kind'], v.get('flags', 0), v.get('epoch', 0), v.get('request', 0), v.get('revision', 0),
                 v.get('context', 0), v.get('stamps', ()), v.get('payload', b''))
    out['valid'].append({
        'name': v['name'], 'hex': data.hex(), 'kind': v['kind'], 'flags': v.get('flags', 0),
        'epoch': v.get('epoch', 0), 'request': v.get('request', 0), 'revision': v.get('revision', 0),
        'context': v.get('context', 0),
        'stamps': [{'stage': s, 'node': n, 'at': a} for s, n, a in v.get('stamps', ())],
        'payload_hex': v.get('payload', b'').hex(),
    })
good = frame(0x10, revision=1, payload=b'hi')
bad = [
    ('truncated-header', good[:23], 'Truncated'),
    ('truncated-payload', good[:-1], 'Truncated'),
    ('trailing-bytes', good + b'\x00', 'TrailingBytes'),
    ('bad-version', b'\x02' + good[1:], 'Version'),
    ('unknown-kind', good[:1] + b'\x7f' + good[2:], 'Kind'),
    ('reserved-stamp', frame(0x10, stamps=[(1, 1, 0.0)])[:28] + b'\x01\x00\x00\x00' + frame(0x10, stamps=[(1, 1, 0.0)])[32:], 'ReservedStamp'),
    ('header-only-with-payload', frame(0x22, flags=0x80, payload=b'x'), 'HeaderOnlyPayload'),
    ('payload-too-large', struct.pack('<BBBBIIIII', 1, 0x10, 0, 0, (16 << 20) + 1, 0, 0, 0, 0), 'PayloadTooLarge'),
]
for name, data, error in bad:
    out['invalid'].append({'name': name, 'hex': data.hex(), 'error': error})
path = pathlib.Path(__file__).resolve().parent.parent / 'crates/tb-protocol/vectors/frames.json'
# One compact object per line keeps the file diffable and trivially parseable without deps.
lines = ['{"valid": [']
lines += [json.dumps(v, separators=(',', ':')) + ',' for v in out['valid']]
lines[-1] = lines[-1][:-1]
lines += ['], "invalid": [']
lines += [json.dumps(v, separators=(',', ':')) + ',' for v in out['invalid']]
lines[-1] = lines[-1][:-1]
lines += [']}']
path.write_text('\n'.join(lines) + '\n')
print(f'wrote {path}')
