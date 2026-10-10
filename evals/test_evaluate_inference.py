"""Exercise the evaluator's actual CLI against controlled HTTP completions."""
import http.server
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = json.loads((ROOT / "evals/inference-corpus.json").read_text())


def plan(metric="wave_height", hours=168):
    return dict(metric=metric, aggregate="avg", bucketMinutes=1, windowHours=hours,
                splitByVessel=True, vessel=None, view="line")


def semantic(count=7, metrics=None):
    return dict(metrics=metrics or ["wave_height"], aggregate="avg",
                bucket={"count": 1, "unit": "minute"}, window={"count": count, "unit": "day"},
                grouping="vessel", vessel=None, view=None, unsupported=[])


class EvaluationHTTPTest(unittest.TestCase):
    def test_final_blind_audit_changes_only_harness_field_names_and_refusal_shape(self):
        original = (ROOT / 'evals/final-blind-audit-2026-10-09.source.json').read_bytes()
        prepared = json.loads((ROOT / 'evals/final-blind-audit-2026-10-09.json').read_text())
        authored = json.loads(original)['cases']
        self.assertEqual(hashlib.sha256(original).hexdigest(), 'f5265208c28208a66323b79dfd90fc2fe189d47636d5448a2ba1d383c91c5607')
        self.assertEqual(prepared['sourceArtifact']['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(prepared['context'], CORPUS['context'])
        self.assertEqual(len(authored), 20)
        self.assertEqual(len(prepared['cases']), 20)
        self.assertEqual(sum(case['supported'] for case in authored), 12)
        for source, case in zip(authored, prepared['cases']):
            self.assertEqual(case['id'], source['id'])
            self.assertEqual(case['question'], source['prompt'])
            self.assertEqual(case['expected'], source['expected'] if source['supported'] else {'error': 'unsupported_request'})

    def test_v6_temporal_and_literal_unit_failures_cannot_hide_correction_false_accepts(self):
        extraction = {**semantic(), 'timeScope': 'trailing'}
        cases = [
            dict(id='quarter', question='Quarter-hour historical buckets', expected={**plan(), 'bucketMinutes': 15}),
            dict(id='dates', question='An absolute date range', expected={'error': 'unsupported_request'}),
            dict(id='months', question='A trailing month', expected={'error': 'unsupported_request'}),
        ]
        replies = {
            'Quarter-hour historical buckets': [{**extraction, 'bucket': {'count': 0.25, 'unit': 'hour'}}],
            'An absolute date range': [{**extraction, 'timeScope': 'absolute'}, extraction],
            'A trailing month': [{**extraction, 'window': {'count': 1, 'unit': 'month'}}, {'error': 'unsupported_request'}],
        }
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(payload)
                answer = replies[payload['messages'][1]['content']].pop(0)
                body = json.dumps({'choices': [{'message': {'content': json.dumps(answer)}, 'finish_reason': 'stop'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                directory = pathlib.Path(tmp)
                artifact = {'systemPrompt': 'Controlled V6 fixture', 'schema': {'type': 'object'}, 'encoding': 'semantic-v4'}
                for case in cases:
                    case.update(split='regression', tags=['fixture'])
                (directory / 'artifact.json').write_text(json.dumps(artifact))
                (directory / 'corpus.json').write_text(json.dumps({'context': CORPUS['context'], 'cases': cases}))
                command = [sys.executable, str(ROOT / 'scripts/evaluate-inference.py'), '--artifact', str(directory / 'artifact.json'), '--corpus', str(directory / 'corpus.json'), '--endpoint', f'http://127.0.0.1:{server.server_port}/v1/chat/completions', '--model', 'fixture', '--source', 'fixture', '--runtime', 'Controlled temporal fixture; no model', '--repair', '--output', str(directory / 'report.json')]
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads((directory / 'report.json').read_text())
                self.assertEqual([r['outcome'] for r in report['results']], ['correct_plan', 'false_accept', 'correct_refusal'])
                self.assertIn('do not replace absolute dates or future predictions with historical data', calls[2]['messages'][-1]['content'])
                self.assertIn('invalid time window quantity or unit', calls[4]['messages'][-1]['content'])
                self.assertEqual(report['summary']['repair_introduced_false_accepts'], 1)
                self.assertEqual(report['summary']['first_attempt_outcomes']['rejected_unsupported'], 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_independent_audit_keeps_every_original_case_unchanged(self):
        original = (ROOT / 'evals/independent-audit-2026-10-09.source.json').read_bytes()
        prepared = json.loads((ROOT / 'evals/independent-audit-2026-10-09.json').read_text())
        self.assertEqual(hashlib.sha256(original).hexdigest(), 'bc5f51c737226432fdd05459dc2e9d5c36cdf16cfb9e261d34a23fb11e1359d6')
        self.assertEqual(prepared['sourceArtifact']['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(prepared['cases'], json.loads(original)['cases'])
        self.assertEqual(prepared['context'], CORPUS['context'])
        self.assertEqual(len(prepared['cases']), 24)
        self.assertEqual(sum(case['expected'] == {'error': 'unsupported_request'} for case in prepared['cases']), 8)

    def test_candidate_feedback_reconsiders_model_claim_without_repairing_valid_wrong_meaning(self):
        # Captured v4.1 behavior: correct surface fields plus a false unsupported
        # label. Exercise the actual CLI repair conversation with the v5 decoder.
        surface = {**semantic(count=1), "bucket": {"count": 1, "unit": "hour"}, "view": "surface"}
        questions = [
            ("surface", "Compare vessel wave height by hour over the last 1days as a 3D surface", {**plan(hours=24), "bucketMinutes": 60, "view": "surface"}),
            ("median", "Median vessel wave height by minute for seven days", {"error": "unsupported_request"}),
            ("multiplier", "Compare vessel wave height every fifteen minutes for seven days", {**plan(), "bucketMinutes": 15}),
        ]
        replies = {
            questions[0][1]: [{**surface, "unsupported": ["3D surface"]}, surface],
            questions[1][1]: [{**semantic(), "aggregate": "median"}, {"error": "unsupported_request"}],
            questions[2][1]: [semantic()],
        }
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(payload)
                answer = replies[payload["messages"][1]["content"]].pop(0)
                body = json.dumps({"choices": [{"message": {"content": json.dumps(answer)}, "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                directory = pathlib.Path(tmp)
                artifact = {"systemPrompt": "Controlled semantic v5 fixture", "schema": {"type": "object"}, "encoding": "semantic-v3"}
                cases = [dict(id=id, question=question, expected=expected, split="regression", tags=["fixture"]) for id, question, expected in questions]
                (directory / "artifact.json").write_text(json.dumps(artifact))
                (directory / "corpus.json").write_text(json.dumps({"context": CORPUS["context"], "cases": cases}))
                command = [sys.executable, str(ROOT / "scripts/evaluate-inference.py"), "--artifact", str(directory / "artifact.json"), "--corpus", str(directory / "corpus.json"), "--endpoint", f"http://127.0.0.1:{server.server_port}/v1/chat/completions", "--model", "fixture", "--source", "fixture", "--runtime", "Controlled candidate repair fixture; no model", "--repair", "--output", str(directory / "report.json")]
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads((directory / "report.json").read_text())
                self.assertEqual([r["outcome"] for r in report["results"]], ["correct_plan", "correct_refusal", "wrong_plan"])
                self.assertEqual(len(calls), 5)
                feedback = calls[1]["messages"][-1]["content"]
                self.assertIn("The model marked these requirements as unsupported: 3D surface", feedback)
                self.assertIn("Remove an item only if the complete plan represents it", feedback)
                self.assertIn("Do not discard any requested meaning", feedback)
                self.assertNotIn("This request includes unsupported requirements", feedback)
                self.assertIn("Unsupported aggregation", calls[3]["messages"][-1]["content"])
                self.assertEqual(len(report["results"][2]["attempts"]), 1)
                self.assertEqual(report["summary"]["repair_fixed_supported_plans"], 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_invalid_auth_header_is_rejected_without_persisting_its_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            artifact = {"systemPrompt": "Fixture prompt", "schema": {"type": "object"}, "encoding": "semantic-v2"}
            (directory / "artifact.json").write_text(json.dumps(artifact))
            secret = "fixture-secret-with-a-trailing-newline\n"
            command = [sys.executable, str(ROOT / "scripts/evaluate-inference.py"), "--artifact", str(directory / "artifact.json"), "--endpoint", "http://127.0.0.1:1/v1/chat/completions", "--model", "fixture", "--source", "fixture", "--runtime", "Fixture with invalid header; no requests", "--output", str(directory / "report.json")]
            result = subprocess.run(command, env=dict(os.environ, TIME_BLAST_EVAL_API_KEY=secret), capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 2)
            self.assertIn("printable ASCII", result.stderr)
            self.assertNotIn(secret.strip(), result.stderr + result.stdout)
            self.assertFalse((directory / "report.json").exists())

    def test_nonthinking_template_flag_is_sent_and_reasoning_is_not_scored_as_a_valid_trial(self):
        calls = []
        reasoning = "Fixture reasoning must not be persisted."
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(payload)
                message = {"content": json.dumps(semantic())}
                if payload["messages"][1]["content"] == "thinking enabled accidentally":
                    message["reasoning_content"] = reasoning
                body = json.dumps({"model": "fixture-qwen3", "choices": [{"message": message, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 75}}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                directory = pathlib.Path(tmp)
                artifact = {"systemPrompt": "Fixture prompt", "schema": {"type": "object"}, "encoding": "semantic-v2"}
                cases = [{"id": str(i), "split": "heldout", "question": question, "expected": plan(), "tags": []}
                         for i, question in enumerate(["thinking disabled correctly", "thinking enabled accidentally"])]
                (directory / "artifact.json").write_text(json.dumps(artifact))
                (directory / "corpus.json").write_text(json.dumps({"context": CORPUS["context"], "cases": cases}))
                command = [sys.executable, str(ROOT / "scripts/evaluate-inference.py"), "--artifact", str(directory / "artifact.json"), "--corpus", str(directory / "corpus.json"), "--endpoint", f"http://127.0.0.1:{server.server_port}/v1/chat/completions", "--model", "fixture-qwen3", "--source", "fixture", "--runtime", "Controlled template fixture; no real model", "--repair", "--disable-thinking", "--prefix-cache", "--output", str(directory / "report.json")]
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                text = (directory / "report.json").read_text()
                report = json.loads(text)
                self.assertNotIn(reasoning, text + result.stdout + result.stderr)
                self.assertEqual(len(calls), 2, "A template-mode mismatch must not trigger a correction")
                self.assertTrue(all(p["chat_template_kwargs"] == {"enable_thinking": False} for p in calls))
                self.assertTrue(all(p["cache_prompt"] is True for p in calls))
                self.assertEqual(report["settings"]["chat_template_kwargs"], {"enable_thinking": False})
                self.assertTrue(report["settings"]["native_cache_prompt"])
                self.assertEqual(report["summary"]["reported_cached_prompt_tokens"], 150)
                self.assertEqual(report["summary"]["attempts_reporting_cached_prompt_tokens"], 2)
                self.assertEqual(report["results"][0]["outcome"], "correct_plan")
                self.assertEqual(report["results"][1]["outcome"], "generation_mode_error")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_full_http_run_reports_semantics_repairs_and_safe_rejections(self):
        refusal = {"error": "unsupported_request"}
        cases = [
            {"id": "repair_refusal", "question": "question one", "expected": plan()},
            {"id": "wrong_but_valid", "question": "question two", "expected": plan()},
            {"id": "false_accept", "question": "question three", "expected": refusal},
            {"id": "captured_multi_metric", "question": "question four", "expected": refusal},
            {"id": "truncated_then_valid", "question": "question five", "expected": plan()},
            {"id": "endpoint_fault", "question": "question six", "expected": plan()},
            {"id": "unknown_finish", "question": "question seven", "expected": plan()},
            {"id": "bounded_output", "question": "question eight", "expected": refusal},
            {"id": "real_refusal", "question": "question nine", "expected": refusal},
            {"id": "repair_dropped_requirement", "question": "question ten", "expected": refusal},
            {"id": "equivalent_single_vessel_grouping", "question": "question eleven", "expected": {**plan(), "vessel": 1, "splitByVessel": False}},
            {"id": "malformed_message", "question": "question twelve", "expected": plan()},
            {"id": "after_malformed_message", "question": "question thirteen", "expected": plan()},
        ]
        for case in cases:
            case.update(split="heldout", tags=["fixture"])
        replies = {
            "question one": [(refusal, "stop"), (semantic(), "stop")],
            "question two": [(semantic(count=1), "stop")],
            "question three": [(semantic(), "stop")],
            "question four": [(semantic(metrics=["wave_height", "wind"]), "stop")] * 2,
            "question five": [('{"metrics":', "length"), (semantic(), "stop")],
            "question six": [None],
            "question seven": [(semantic(), "content_filter")],
            "question eight": [("x" * 20_000, "stop")] * 2,
            "question nine": [(refusal, "stop")] * 2,
            "question ten": [(refusal, "stop"), (semantic(), "stop")],
            "question eleven": [({**semantic(), "vessel": "Meridian"}, "stop")],
            "question twelve": [("__malformed_message__", "stop")],
            "question thirteen": [(semantic(), "stop")],
        }
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((payload, self.headers.get("Authorization")))
                question = payload["messages"][1]["content"]
                response = replies[question].pop(0)
                if response is None:
                    self.send_error(503, "Temporary fixture failure")
                    return
                value, reason = response
                content = value if isinstance(value, str) else json.dumps(value)
                message = None if value == "__malformed_message__" else {"content": content}
                body = json.dumps({"model": "fixture-model", "choices": [{"message": message, "finish_reason": reason}], "usage": {"prompt_tokens": 123, "completion_tokens": 35}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                directory = pathlib.Path(tmp)
                artifact = {"systemPrompt": "Controlled fixture prompt", "schema": {"type": "object"}, "encoding": "semantic-v2", "context": CORPUS["context"]}
                (directory / "artifact.json").write_text(json.dumps(artifact))
                (directory / "corpus.json").write_text(json.dumps({"version": 1, "context": CORPUS["context"], "cases": cases}))
                env = dict(os.environ, TIME_BLAST_EVAL_API_KEY="fixture-secret-do-not-persist")
                command = [sys.executable, str(ROOT / "scripts/evaluate-inference.py"), "--artifact", str(directory / "artifact.json"), "--corpus", str(directory / "corpus.json"), "--endpoint", f"http://127.0.0.1:{server.server_port}/v1/chat/completions", "--model", "fixture-model", "--source", "fixture", "--runtime", "Controlled HTTP fixture, no model", "--repair", "--seed", "17", "--output", str(directory / "report.json")]
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                report_text = (directory / "report.json").read_text()
                report = json.loads(report_text)
                self.assertEqual(report["status"], "complete")
                self.assertNotIn(env["TIME_BLAST_EVAL_API_KEY"], report_text + result.stdout + result.stderr)
                results = {r["id"]: r for r in report["results"]}
                self.assertEqual(results["repair_refusal"]["outcome"], "correct_plan")
                self.assertEqual(results["repair_refusal"]["actual"]["windowHours"], 168)
                self.assertEqual(results["wrong_but_valid"]["outcome"], "wrong_plan")
                self.assertEqual(len(results["wrong_but_valid"]["attempts"]), 1, "Semantic oracle must not leak into correction")
                self.assertEqual(results["false_accept"]["outcome"], "false_accept")
                self.assertEqual(results["captured_multi_metric"]["outcome"], "rejected_unsupported")
                self.assertEqual(results["truncated_then_valid"]["outcome"], "correct_plan")
                self.assertEqual(results["endpoint_fault"]["outcome"], "endpoint_error")
                self.assertEqual(len(results["endpoint_fault"]["attempts"]), 1)
                self.assertEqual(results["unknown_finish"]["outcome"], "invalid_output")
                self.assertEqual(len(results["unknown_finish"]["attempts"]), 1)
                self.assertTrue(results["bounded_output"]["attempts"][0]["output"]["truncated"])
                self.assertEqual(len(results["bounded_output"]["attempts"][0]["output"]["text"]), 16_384)
                self.assertEqual(results["real_refusal"]["outcome"], "correct_refusal")
                self.assertEqual(results["repair_dropped_requirement"]["outcome"], "false_accept")
                self.assertEqual(results["repair_dropped_requirement"]["attempts"][0]["outcome"], "correct_refusal")
                self.assertEqual(results["equivalent_single_vessel_grouping"]["outcome"], "wrong_plan")
                self.assertEqual(results["malformed_message"]["outcome"], "endpoint_error")
                self.assertEqual(len(results["malformed_message"]["attempts"]), 1)
                self.assertEqual(results["after_malformed_message"]["outcome"], "correct_plan")
                self.assertEqual(report["summary"]["outcomes"], {"correct_plan": 3, "correct_refusal": 1, "endpoint_error": 2, "false_accept": 2, "invalid_output": 1, "rejected_unsupported": 2, "wrong_plan": 2})
                self.assertEqual(report["summary"]["field_mismatches"], {"splitByVessel": 1, "windowHours": 1})
                self.assertEqual(report["summary"]["supported_exact_plan_accuracy"], 0.375)
                self.assertEqual(report["summary"]["equivalent_named_grouping_only"], 1)
                self.assertEqual(report["summary"]["supported_exact_or_equivalent_accuracy"], 0.5)
                self.assertEqual(report["summary"]["scorable_model_cases"], 11)
                self.assertEqual(report["summary"]["availability_or_mode_error_cases"], 2)
                self.assertEqual(report["summary"]["scorable_supported_exact_plan_accuracy"], 0.5)
                self.assertEqual(report["summary"]["false_accept_rate"], 0.4)
                self.assertEqual(report["summary"]["unsupported_non_executable_rate"], 0.6)
                self.assertEqual(report["summary"]["repairs"], 6)
                self.assertEqual(report["summary"]["repair_introduced_false_accepts"], 1)
                self.assertEqual(report["summary"]["repair_fixed_supported_plans"], 2)
                self.assertEqual(report["summary"]["repair_transitions"]["correct_refusal -> false_accept"], 1)
                for payload, authorization in calls:
                    self.assertEqual(payload["temperature"], 0)
                    self.assertEqual(payload["seed"], 17)
                    self.assertEqual(payload["response_format"]["json_schema"]["schema"], artifact["schema"])
                    self.assertEqual(authorization, "Bearer " + env["TIME_BLAST_EVAL_API_KEY"])
                repair = next(payload for payload, _ in calls if len(payload["messages"]) > 2)
                self.assertIn("unsupported", repair["messages"][3]["content"])
                self.assertNotIn('"windowHours": 168', repair["messages"][3]["content"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_corpus_covers_contract_and_public_regressions(self):
        cases = CORPUS["cases"]
        self.assertEqual(len(cases), len({c["id"] for c in cases}))
        plans = [c["expected"] for c in cases if "error" not in c["expected"]]
        self.assertEqual({p["metric"] for p in plans}, {"speed", "wind", "wave_height", "water_temp"})
        self.assertEqual({p["view"] for p in plans}, {"line", "bar", "scatter", "table", "heatmap", "surface", "map", "density", "tracks", "seasons"})
        self.assertEqual({p["vessel"] for p in plans}, {None, 0, 1, 2, 3, 4, 5})
        self.assertEqual({p["bucketMinutes"] for p in plans}, {1, 5, 15, 60, 360, 1440})
        self.assertEqual({p["aggregate"] for p in plans}, {"avg", "min", "max"})
        regression = next(c for c in cases if c["id"] == "user_week_minute_waves")
        self.assertEqual(regression["question"], "Compare vessel wave height by minute over the last 7 days")
        self.assertEqual(regression["expected"], plan())


if __name__ == "__main__":
    unittest.main()
