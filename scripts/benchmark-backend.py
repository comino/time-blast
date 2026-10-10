"""Small real-provider plan/latency check through the Rust HTTP compatibility API.

This measures request-to-validated-plan on this host, not browser drawing or a
model/socket ranking. It deliberately bypasses the WebSocket session plan cache.
Provider credentials remain in the server. No API key is needed by this script.
"""
import argparse
import json
import statistics
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

CONTEXT = {"id": "backend-live-evaluation-v1", "label": "Synthetic fleet", "rowCount": 1209600,
           "start": 1788220800000, "end": 1789430400000,
           "vessels": ["Aurora", "Meridian", "Kestrel", "Solstice", "Atlas", "Nomad"],
           "description": "Synthetic vessel telemetry"}
CASES = [
    ("Compare vessel wave height by minute over the last 7 days", "wave_height", 1, 168, "line"),
    ("Compare vessel speeds by minute over the last 24 hours", "speed", 1, 24, "line"),
    ("Compare vessel wave height by hour over the last 1days as a 3D surface", "wave_height", 60, 24, "surface"),
    ("Show a heatmap of vessel wind by hour over the last 7 days", "wind", 60, 168, "heatmap"),
]


def run(endpoint, rounds):
    rows = []
    for turn in range(rounds):
        for question, metric, bucket, hours, view in CASES:
            expected = {"metric": metric, "aggregate": "avg", "bucketMinutes": bucket,
                        "windowHours": hours, "splitByVessel": True, "vessel": None, "view": view}
            revision = len(rows) + 1
            body = {"text": question, "revision": revision, "cachePlans": False,
                    "draft": {"revision": revision, "text": question, "contextId": CONTEXT["id"], "sentAt": 0},
                    "context": CONTEXT, "schema": {}}
            started = time.perf_counter()
            try:
                with urlopen(Request(endpoint, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}), timeout=35) as response:
                    status = response.status
                    result = json.load(response)
            except HTTPError as error:
                status = error.code
                result = json.loads(error.read())
            elapsed = (time.perf_counter() - started) * 1000
            rows.append({"round": turn + 1, "question": question, "httpStatus": status,
                         "wallMs": round(elapsed, 3), "expected": expected,
                         "exact": status == 200 and result.get("plan") == expected, "response": result})
    return {"kind": "real-provider-rust-http", "endpoint": endpoint, "rounds": rounds,
            "dateUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "context": CONTEXT, "exact": sum(row["exact"] for row in rows), "total": len(rows),
            "medianWallMs": statistics.median(row["wallMs"] for row in rows),
            "limits": "Small development check; known questions, not held-out accuracy or latency distributions. "
                      "HTTP connections to Rust are new per request; provider connection pool is reused. "
                      "No application plan-cache hits. Provider cache/cold state uncontrolled. No browser or photons.",
            "requests": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8787/infer")
    parser.add_argument("--rounds", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 5:
        parser.error("rounds must be 1..5")
    print(json.dumps(run(args.endpoint, args.rounds), indent=2))
