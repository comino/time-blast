#!/usr/bin/env python3
"""Benchmark NL->SQL through the real release-built Rust inference server over tb1.

Standard library only. Starts an isolated server process on a loopback port, connects one
tb1 WebSocket session (HELLO -> READY, CONTEXT), then sends a fixed set of questions about
the synthetic vessel fixture one at a time and records, per request:

  client:  INFER sent -> first SQL_DELTA, -> SQL, -> INFER_STATS (client clock, ms)
  server:  the inference ledger stamped into the SQL frame (same host, so same clock)
  stats:   prompt/completion/cached tokens, cost (as reported by the provider), attempts
  sql:     the final SQL text

  # live (spends provider tokens; OPENROUTER_API_KEY stays in the environment, never argv)
  python3 scripts/benchmark-sql.py --binary path/to/release/time-blast-inference \
      [--model google/gemini-2.5-flash-lite] --rounds 2 --output report.json
  # no provider: a local fake OpenAI-compatible SSE provider, checks protocol behaviour
  python3 scripts/benchmark-sql.py --binary path/to/release/time-blast-inference --self-test

The server's process-wide SQL cache is disabled (TIME_BLAST_CACHE_ENTRIES=0) so every
request reaches the provider; repeated rounds measure provider-side prompt caching only.
"""
from __future__ import annotations

import argparse
import base64
import datetime
import http.server
import json
import os
from pathlib import Path
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "crates/inference-server/tests/fixtures/vessels-context.json"

QUESTIONS = [
    "average speed per vessel",
    "hourly average wind speed over the last 2 days",
    "max wave height per vessel per day",
    "water temperature trend for Aurora in the last week",
    "compare speed of Kestrel and Nomad by hour",
    "where was Meridian yesterday",
    "show all vessel tracks on a map",
    "scatter of wind vs wave height",
    "how many readings per vessel",
    "daily minimum and maximum water temperature",
    "which vessel was fastest on average in the last 24 hours",
    "wave height as a heatmap by vessel and day",
    "average speed by hour of day",
    "storm: when did wind exceed 35 knots",
    "latest position of every vessel",
    "speed of Atlas every 10 minutes today",
    "bar chart of average wave height per vessel",
    "wind speed distribution in 2 knot bins",
    "correlation between wind and speed per vessel",
    "table of the 20 highest wave readings",
]

# ───────────── tb1 codec (docs/protocol-v1.md) ─────────────

KIND = {"HELLO": 0x01, "READY": 0x02, "CONTEXT": 0x03, "STATUS": 0x04, "ERROR": 0x05,
        "CANCEL": 0x12, "INFER": 0x18, "SQL_DELTA": 0x19, "SQL": 0x1A, "INFER_STATS": 0x1B}
NAME = {v: k for k, v in KIND.items()}
STAGE = {5: "INFER_RECEIVED", 6: "PROVIDER_REQUEST", 7: "FIRST_TOKEN", 8: "SQL_FIRST_DELTA",
         9: "SQL_COMPLETE"}


def encode(kind, payload=b"", *, epoch=0, request=0, revision=0, context=0, flags=0):
    return struct.pack("<BBBBIIIII", 1, KIND[kind], flags, 0, len(payload), epoch, request,
                       revision, context) + payload


def decode(data):
    version, kind, flags, count, length, epoch, request, revision, context = struct.unpack_from(
        "<BBBBIIIII", data)
    if version != 1:
        raise ValueError(f"tb1 version {version}")
    stamps = []
    at = 24
    for _ in range(count):
        stage, node, reserved, when = struct.unpack_from("<HHId", data, at)
        if reserved:
            raise ValueError("reserved stamp field")
        stamps.append((stage, node, when))
        at += 16
    payload = data[at:at + length]
    if len(payload) != length or at + length != len(data):
        raise ValueError("bad frame length")
    return {"kind": NAME.get(kind, hex(kind)), "flags": flags, "epoch": epoch, "request": request,
            "revision": revision, "context": context, "stamps": stamps, "payload": payload}


# ───────────── minimal WebSocket client (RFC 6455, binary frames) ─────────────

class WebSocket:
    def __init__(self, host, port, path="/session"):
        self.sock = socket.create_connection((host, port), timeout=60)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tb1\r\n\r\n").encode())
        head = b""
        while not head.endswith(b"\r\n\r\n"):
            byte = self.sock.recv(1)
            if not byte:
                raise ConnectionError("handshake closed")
            head += byte
        lines = head.decode().lower()
        if not lines.startswith("http/1.1 101") or "sec-websocket-protocol: tb1" not in lines:
            raise ConnectionError(head.decode().splitlines()[0])
        self.buffer = b""

    def send(self, data):
        mask = os.urandom(4)
        n = len(data)
        header = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else
                                  bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else
                                  bytes([0x80 | 127]) + struct.pack(">Q", n))
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def recv(self):
        """Next binary message (unfragmented, as the server sends them)."""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            opcode = b0 & 0x0F
            if opcode == 0x2:
                return payload
            if opcode == 0x9:  # ping -> pong
                mask = os.urandom(4)
                self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask +
                                  bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
            elif opcode == 0x8:
                raise ConnectionError("server closed the session")

    def frame(self):
        return decode(self.recv())


# ───────────── fake provider (self-test) ─────────────

class FakeProvider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FakeHandler)
        self.requests = []


class FakeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(body)
        question = body["messages"][-1]["content"]
        slow = "slow" in question
        sql = f"SELECT count(*) AS n -- {len(question)}\nFROM telemetry"
        pieces = ["```sql\n", "SELECT count(*) AS n", f" -- {len(question)}\n", "FROM telemetry", ";\n```"]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for piece in pieces * (50 if slow else 1):
                event = {"model": "fake/sql", "choices": [{"index": 0, "delta": {"content": piece}}]}
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.05 if slow else 0.002)
            usage = {"prompt_tokens": 800, "completion_tokens": 12,
                     "prompt_tokens_details": {"cached_tokens": 512}, "cost": 0.0000848}
            for event in ({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                          {"choices": [], "usage": usage}):
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.server.requests[-1]["_aborted"] = True
        self.server.requests[-1].setdefault("_expected_sql", sql)


# ───────────── server process ─────────────

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(binary, env_overrides):
    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith("TIME_BLAST_")}
    env.update({"TIME_BLAST_BIND": f"127.0.0.1:{port}", "TIME_BLAST_CACHE_ENTRIES": "0",
                "TIME_BLAST_REQUESTS_PER_MINUTE": "1000", "TIME_BLAST_REQUESTS_PER_DAY": "10000"})
    env.update(env_overrides)
    process = subprocess.Popen([str(binary)], env=env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, text=True)
    for _ in range(200):
        try:
            with urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                health = json.load(response)
                return process, port, health
        except OSError:
            if process.poll() is not None:
                raise RuntimeError(f"server exited: {process.stderr.read()[-500:]}")
            time.sleep(0.05)
    process.kill()
    raise RuntimeError("server did not become healthy")


def session(port, context_bytes):
    ws = WebSocket("127.0.0.1", port)
    ws.send(encode("HELLO", json.dumps({"node": "coordinator", "name": "benchmark-sql",
                                        "version": 1}).encode()))
    ready = ws.frame()
    assert ready["kind"] == "READY", ready
    context_id = json.loads(context_bytes)["id"]
    ws.send(encode("CONTEXT", context_bytes, context=context_id))
    return ws, json.loads(ready["payload"]), context_id


def ask(ws, request, question, context_id, epoch=0):
    """One INFER; returns the per-request record."""
    sent = time.time() * 1000
    ws.send(encode("INFER", question.encode(), request=request, revision=request,
                   context=context_id, epoch=epoch))
    record = {"request": request, "question": question, "deltas": 0, "deltaText": ""}
    while True:
        frame = ws.frame()
        now = time.time() * 1000
        if frame["request"] != request:
            raise AssertionError(f"frame for request {frame['request']} while waiting for {request}")
        kind = frame["kind"]
        if kind == "SQL_DELTA":
            record["deltas"] += 1
            record["deltaText"] += frame["payload"].decode()
            record.setdefault("firstDeltaMs", now - sent)
        elif kind == "SQL":
            record["sqlMs"] = now - sent
            record["sql"] = frame["payload"].decode()
            record["cached"] = bool(frame["flags"] & 1)
            ledger = {STAGE.get(stage, str(stage)): at for stage, _node, at in frame["stamps"]}
            base = ledger.get("INFER_RECEIVED")
            record["server"] = {name: round(at - base, 3) for name, at in ledger.items()} if base else {}
            record["clientToServerMs"] = round(base - sent, 3) if base else None
        elif kind == "ERROR":
            record["error"] = json.loads(frame["payload"])
        elif kind == "INFER_STATS":
            record["statsMs"] = now - sent
            record["stats"] = json.loads(frame["payload"])
            return record
        else:
            raise AssertionError(f"unexpected {kind}")


def percentile(values, p):
    values = sorted(values)
    if not values:
        return None
    index = min(len(values) - 1, max(0, round(p / 100 * (len(values) - 1))))
    return round(values[index], 1)


def summarize(records):
    out = {}
    for key in ("firstDeltaMs", "sqlMs"):
        values = [r[key] for r in records if key in r]
        out[key] = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95),
                    "max": round(max(values), 1) if values else None}
    stats = [r["stats"] for r in records if "stats" in r]
    out["promptTokens"] = sum(s.get("promptTokens", 0) for s in stats)
    out["completionTokens"] = sum(s.get("completionTokens", 0) for s in stats)
    out["cachedTokens"] = sum(s.get("cachedTokens", 0) for s in stats)
    costs = [s["costUsd"] for s in stats if "costUsd" in s]
    out["costUsd"] = round(sum(costs), 8) if costs else None
    out["costReported"] = f"{len(costs)}/{len(stats)}"
    out["errors"] = sum(1 for r in records if "error" in r)
    out["repairs"] = sum(1 for s in stats if s.get("attempts", 1) > 1)
    return out


def run_benchmark(args):
    if not os.environ.get("OPENROUTER_API_KEY") and not os.environ.get("TIME_BLAST_API_KEY"):
        sys.exit("Set OPENROUTER_API_KEY (or TIME_BLAST_API_KEY) in the environment")
    overrides = {"TIME_BLAST_DAILY_BUDGET_USD": str(args.budget)}
    if args.model != "default":  # "default": the server's default profile (model, reasoning, routing)
        overrides["TIME_BLAST_MODEL"] = args.model
    if args.request_extra:
        overrides["TIME_BLAST_REQUEST_EXTRA"] = args.request_extra
    if args.reasoning:
        overrides["TIME_BLAST_REASONING_EFFORT"] = args.reasoning
    if args.temperature:
        overrides["TIME_BLAST_TEMPERATURE"] = args.temperature
    process, port, health = start_server(args.binary, overrides)
    try:
        ws, ready, context_id = session(port, FIXTURE.read_bytes())
        questions = QUESTIONS[: args.limit] if args.limit else QUESTIONS
        records = []
        request = 0
        for round_index in range(args.rounds):
            for question in questions:
                request += 1
                record = ask(ws, request, question, context_id)
                record["round"] = round_index + 1
                records.append(record)
                print(f"r{round_index + 1} #{request:>3} delta {record.get('firstDeltaMs', 0):7.1f} ms"
                      f"  sql {record.get('sqlMs', 0):7.1f} ms  cached {record.get('stats', {}).get('cachedTokens', '-')}"
                      f"  {question}", file=sys.stderr)
        report = {
            "createdAt": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
            "host": os.uname().nodename, "machine": os.uname().machine,
            "binary": str(args.binary), "model": args.model, "ready": ready,
            "reasoning": args.reasoning or "omitted", "temperature": args.temperature or "0",
            "method": "sequential requests on one warm tb1 session; client and server on the same host;"
                      " server SQL cache disabled; provider prompt caching uncontrolled",
            "rounds": {str(n): summarize([r for r in records if r["round"] == n])
                       for n in range(1, args.rounds + 1)},
            "all": summarize(records),
            "health": json.load(urlopen(f"http://127.0.0.1:{port}/health")),
            "records": records,
        }
        if args.output:
            args.output.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
        print(json.dumps({k: report[k] for k in ("model", "rounds", "all")}, indent=1))
    finally:
        process.terminate()
        process.wait(timeout=5)


def self_test(args):
    provider = FakeProvider()
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{provider.server_address[1]}/v1/chat/completions"
    process, port, health = start_server(args.binary, {
        "TIME_BLAST_PROVIDER_URL": endpoint, "TIME_BLAST_OPENROUTER": "false",
        "TIME_BLAST_MODEL": "fake/sql", "TIME_BLAST_API_KEY": ""})
    try:
        assert health["protocol"] == "tb1" and health["model"] == "fake/sql", health
        ws, ready, context_id = session(port, FIXTURE.read_bytes())
        assert ready == {"node": "inference", "name": "time-blast-inference", "version": 1,
                         "model": "fake/sql"}, ready
        records = [ask(ws, i + 1, q, context_id) for i, q in enumerate(QUESTIONS)]
        for record, body in zip(records, provider.requests):
            assert "error" not in record, record
            assert record["sql"] == body["_expected_sql"], (record["sql"], body["_expected_sql"])
            assert record["deltaText"] == record["sql"], record
            assert list(record["server"]) == ["INFER_RECEIVED", "PROVIDER_REQUEST", "FIRST_TOKEN",
                                              "SQL_FIRST_DELTA", "SQL_COMPLETE"], record["server"]
            assert record["stats"] == {"model": "fake/sql", "promptTokens": 800, "completionTokens": 12,
                                       "cachedTokens": 512, "costUsd": 0.0000848, "attempts": 1}
            assert body["messages"][0]["content"] == (FIXTURE.parent / "vessels-prompt.txt").read_text()
            assert body["messages"][1]["content"] == record["question"]
            assert body["temperature"] == 0 and body["stream"] is True
        # CANCEL aborts the upstream stream and silences the request.
        before = len(provider.requests)
        ws.send(encode("INFER", b"slow question", request=100, context=context_id))
        first = ws.frame()
        assert first["kind"] == "SQL_DELTA" and first["request"] == 100, first
        ws.send(encode("CANCEL", request=100))  # targeted: epoch unchanged
        deadline = time.time() + 3
        while not provider.requests[before].get("_aborted") and time.time() < deadline:
            time.sleep(0.02)
        assert provider.requests[before].get("_aborted"), "upstream stream was not aborted"
        stats = ws.frame()  # the cancelled request still reports its spend
        assert stats["kind"] == "INFER_STATS" and stats["request"] == 100, stats
        assert json.loads(stats["payload"])["cancelled"] is True, stats
        record = ask(ws, 101, "after cancel", context_id)  # asserts no further request-100 frames
        assert record["sql"].startswith("SELECT"), record
        summary = summarize(records)
        print(json.dumps({"selfTest": "ok", "requests": len(records) + 2, **summary}, indent=1))
    finally:
        process.terminate()
        process.wait(timeout=5)
        provider.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default="default", help="OpenRouter model id, or 'default' for the server's default profile")
    parser.add_argument("--request-extra", help="JSON object merged into provider requests (TIME_BLAST_REQUEST_EXTRA)")
    parser.add_argument("--reasoning", choices=["none", "minimal", "low", "medium", "high"])
    parser.add_argument("--temperature", help="number or 'provider' (default 0)")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="only the first N questions")
    parser.add_argument("--budget", type=float, default=0.5, help="server spend ceiling, USD")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.binary.is_file():
        parser.error(f"no binary at {args.binary}")
    self_test(args) if args.self_test else run_benchmark(args)


if __name__ == "__main__":
    main()
