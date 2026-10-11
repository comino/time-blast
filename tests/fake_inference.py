#!/usr/bin/env python3
"""A fake `tb1` inference node: Python standard library only (RFC 6455 handshake and framing).

HELLO → READY, stores CONTEXT, answers INFER with canned SQL chosen by keywords in the question,
streamed as two SQL_DELTA frames then SQL then INFER_STATS (cost 0). Every reply echoes the
INFER's epoch/request/revision/context and carries INFER_RECEIVED / SQL_FIRST_DELTA /
SQL_COMPLETE stamps (node 3). With no model in the loop, end-to-end numbers isolate our own
pipeline (keystroke → coordinator → database → renderer).

Standalone: python3 tests/fake_inference.py --port 8787 [--delay-ms 0]
Or import `FakeInference` and run it in a thread (tests/e2e_fake_inference.py).
"""
import argparse
import base64
import hashlib
import json
import socket
import struct
import threading
import time

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HELLO, READY, CONTEXT, ERROR, CANCEL = 0x01, 0x02, 0x03, 0x05, 0x12
INFER, SQL_DELTA, SQL, INFER_STATS = 0x18, 0x19, 0x1A, 0x1B
INFER_RECEIVED, SQL_FIRST_DELTA, SQL_COMPLETE = 5, 8, 9
NODE_INFERENCE = 3

# Canned answers: first keyword match wins. Columns follow the protocol-v1 result shape.
CANNED = [
    (("season", "wheel"), "-- view: seasons\nSELECT time_bucket(INTERVAL 1 MINUTE, ts) AS minute, avg(speed) AS speed\n"
     "FROM telemetry GROUP BY 1 ORDER BY 1"),
    (("wind",), "SELECT time_bucket(INTERVAL 10 MINUTE, ts) AS t, avg(wind) AS wind FROM telemetry GROUP BY 1 ORDER BY 1"),
    (("per vessel", "max"), "SELECT vessel, max(speed) AS max_speed FROM telemetry GROUP BY 1 ORDER BY 1"),
    ((), "SELECT date_trunc('hour', ts) AS hour, vessel, avg(speed) AS speed FROM telemetry GROUP BY 1, 2 ORDER BY 1"),
]


def sql_for(question):
    q = question.lower()
    for keys, sql in CANNED:
        if not keys or any(k in q for k in keys):
            return sql
    return CANNED[-1][1]


KEYWORDS = r"\b(SELECT|FROM|GROUP BY|ORDER BY|AS|ALL|INTERVAL|MINUTE)\b"


def variant(sql, k):
    """An alias/case/layout variant of `sql` with the same result data (what a model does between
    near-identical prefixes, docs/batch-2/inference.md "prefix replay"): different bytes, so the
    coordinator cannot dedup, but identical values for the renderer."""
    import re
    k %= 5
    if k == 1:
        return re.sub(KEYWORDS, lambda m: m.group(0).lower(), sql)
    if k == 2:  # rename the last alias (the value column)
        head, sep, tail = sql.rpartition(" AS ")
        name, _, rest = tail.partition(" ")
        return f"{head}{sep}{name}_v {rest}" if sep else sql
    if k == 3:
        return sql.replace(", ", ",\n       ").replace(" FROM ", "\nFROM ").replace(" GROUP BY ", "\nGROUP BY ")
    if k == 4:
        return re.sub(r"GROUP BY \d+(, \d+)*", "GROUP BY ALL", sql)
    return sql


def now_ms():
    return time.time() * 1000.0


def encode(kind, payload=b"", epoch=0, request=0, revision=0, context=0, flags=0, stamps=()):
    head = struct.pack("<BBBBIIIII", 1, kind, flags, len(stamps), len(payload), epoch, request, revision, context)
    body = b"".join(struct.pack("<HHId", s, n, 0, at) for s, n, at in stamps)
    return head + body + payload


def decode(data):
    version, kind, flags, n, length, epoch, request, revision, context = struct.unpack_from("<BBBBIIIII", data)
    if version != 1:
        raise ValueError(f"version {version}")
    stamps = [struct.unpack_from("<HHId", data, 24 + 16 * i) for i in range(n)]
    start = 24 + 16 * n
    payload = data[start:start + length]
    return {"kind": kind, "flags": flags, "epoch": epoch, "request": request, "revision": revision,
            "context": context, "stamps": [(s, nd, at) for s, nd, _, at in stamps], "payload": payload}


class Conn:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()

    def handshake(self):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                return False
            data += chunk
        headers = {}
        for line in data.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.strip().lower()] = v.strip()
        key = headers.get(b"sec-websocket-key")
        if not key:
            self.sock.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            return False
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
        protocols = [p.strip() for p in headers.get(b"sec-websocket-protocol", b"").split(b",")]
        proto = b"Sec-WebSocket-Protocol: tb1\r\n" if b"tb1" in protocols else b""
        self.sock.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          b"Sec-WebSocket-Accept: " + accept + b"\r\n" + proto + b"\r\n")
        return True

    def recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def recv_message(self):
        """One complete message: (opcode, payload). Handles fragmentation and masking."""
        parts, opcode = [], None
        while True:
            b0, b1 = self.recv_exact(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self.recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self.recv_exact(8))[0]
            mask = self.recv_exact(4) if b1 & 0x80 else None
            data = self.recv_exact(length)
            if mask:
                data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
            if op >= 0x8:  # control frames may interleave
                if op == 0x9:
                    self.send_raw(0xA, data)
                    continue
                if op == 0xA:
                    continue
                return op, data
            if op != 0:
                opcode = op
            parts.append(data)
            if fin:
                return opcode, b"".join(parts)

    def send_raw(self, opcode, data):
        n = len(data)
        if n < 126:
            head = struct.pack(">BB", 0x80 | opcode, n)
        elif n < 65536:
            head = struct.pack(">BBH", 0x80 | opcode, 126, n)
        else:
            head = struct.pack(">BBQ", 0x80 | opcode, 127, n)
        with self.lock:
            self.sock.sendall(head + data)

    def send(self, frame_bytes):
        self.send_raw(0x2, frame_bytes)


class FakeInference:
    def __init__(self, host="127.0.0.1", port=0, delay_ms=0.0):
        self.server = socket.create_server((host, port))
        self.port = self.server.getsockname()[1]
        self.delay = delay_ms / 1000.0
        self.contexts = {}
        self.infers = []  # (request, revision, epoch, question, sql)
        self.hellos = 0
        self.errors = []
        # True: append the question as a trailing SQL comment, so every keystroke yields new
        # SQL (no coordinator dedup) and runs the whole pipeline.
        self.echo = False
        # True: answer each INFER with the next alias/case/layout variant of the canned SQL
        # (identical result data, different SQL bytes): steady-chart measurements.
        self.variants = False
        self._stop = False

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}"

    def serve_forever(self):
        self.server.settimeout(0.5)
        while not self._stop:
            try:
                sock, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            threading.Thread(target=self.session, args=(sock,), daemon=True).start()

    def start(self):
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self._stop = True
        self.server.close()

    def session(self, sock):
        conn = Conn(sock)
        try:
            if not conn.handshake():
                return
            greeted = False
            while True:
                op, data = conn.recv_message()
                if op == 0x8:
                    conn.send_raw(0x8, data[:2])
                    return
                if op != 0x2:
                    self.errors.append("text message")
                    return
                f = decode(data)
                if not greeted:
                    if f["kind"] != HELLO:
                        self.errors.append(f"first frame kind {f['kind']}")
                        return
                    greeted = True
                    self.hellos += 1
                    conn.send(encode(READY, json.dumps({"node": "inference", "name": "fake-inference", "version": 1, "model": "fake"}).encode()))
                elif f["kind"] == CONTEXT:
                    ctx = json.loads(f["payload"])
                    self.contexts[ctx["id"]] = ctx
                elif f["kind"] == INFER:
                    self.infer(conn, f, now_ms())
        except (ConnectionError, OSError):
            pass
        finally:
            sock.close()

    def infer(self, conn, f, received):
        question = f["payload"].decode("utf-8", "replace")
        sql = sql_for(question)
        if self.variants:
            sql = variant(sql, len(self.infers))
        if self.echo:
            sql += "\n-- " + " ".join(question.split())
        self.infers.append((f["request"], f["revision"], f["epoch"], question, sql))
        ids = dict(epoch=f["epoch"], request=f["request"], revision=f["revision"], context=f["context"])
        if self.delay:
            time.sleep(self.delay)
        half = len(sql) // 2
        first = now_ms()
        ledger = [(INFER_RECEIVED, NODE_INFERENCE, received), (SQL_FIRST_DELTA, NODE_INFERENCE, first)]
        conn.send(encode(SQL_DELTA, sql[:half].encode(), stamps=ledger, **ids))
        conn.send(encode(SQL_DELTA, sql[half:].encode(), **ids))
        conn.send(encode(SQL, sql.encode(), stamps=ledger + [(SQL_COMPLETE, NODE_INFERENCE, now_ms())], **ids))
        stats = {"model": "fake", "promptTokens": 0, "completionTokens": 0, "costUsd": 0.0, "attempts": 1}
        conn.send(encode(INFER_STATS, json.dumps(stats).encode(), **ids))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--delay-ms", type=float, default=0.0)
    args = p.parse_args()
    fake = FakeInference(port=args.port, delay_ms=args.delay_ms)
    print(f"fake inference on {fake.url}", flush=True)
    fake.serve_forever()


if __name__ == "__main__":
    main()
