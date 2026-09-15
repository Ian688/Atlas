#!/usr/bin/env python3
"""M5: on-demand model explanations are a real path, or an honest refusal.

Nothing here needs a public model. A local HTTP server speaks the same
OpenAI-compatible shape the bundled adapter speaks, which makes every claim
below checkable:

* No configuration means no request and no placeholder text. The refusal is
  named, and the algorithm summary and the reader's own interpretation are
  untouched by it.
* The connection is per project and the key never travels back: `GET
  /api/llm/config` reports `has_api_key` and nothing else.
* The scope is visible before it is sent, and it is the real bytes: the
  preview names each fragment, its file and its size.
* A generation is a process with a real lifecycle: done, failed and cancelled
  are three different recorded outcomes, not one spinner.
* A generated answer is filed under the node and version it was asked about and
  never overwrites what a person saved.

Standard-library only.
"""
import json
import selectors
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"


class FakeModel:
    """A local stand-in for a chat/completions endpoint.

    It exists because the interesting behaviours -- a named HTTP failure, an
    answer that arrives late enough to be cancelled -- cannot be provoked
    against a real provider without spending someone's money, and should not
    be asserted against a mock the server itself returns.
    """

    def __init__(self):
        self.mode = "answer"
        self.delay = 0.0
        self.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def handler(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.seen.append({
                    "path": self.path,
                    "model": body.get("model"),
                    "auth": self.headers.get("Authorization"),
                    "prompt": (body.get("messages") or [{}])[0].get("content", ""),
                })
                if outer.delay:
                    time.sleep(outer.delay)
                if outer.mode == "http_error":
                    payload = json.dumps({"error": {"message": "model overloaded"}}).encode()
                    self.send_response(429)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if outer.mode == "garbage":
                    payload = b"<html>not json at all</html>"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                content = "这个函数把金额乘以 (1 - 折扣率) 并四舍五入。"
                payload = json.dumps({
                    "model": body.get("model", "?"),
                    "choices": [{"message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        return Handler

    @property
    def url(self):
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-llm-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text('{"name":"llm-lab","type":"module"}\n', encoding="utf-8")
        (self.project / "src" / "money.js").write_text(
            "// 金额计算：以整数分值运算。\n"
            "export function charge(amount, rate) {\n"
            "  return Math.round(amount * (1 - rate));\n"
            "}\n",
            encoding="utf-8",
        )
        self.store = self.base / "store"
        self.analysis = self.cli("index", self.project)["id"]

    def cli(self, *args, ok=True):
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=180,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return json.loads(result.stdout) if result.stdout.strip() else {}


class Http(Harness):
    def setUp(self):
        super().setUp()
        self.model = FakeModel()
        self.addCleanup(self.model.stop)
        self.proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "serve", self.analysis,
             "--project", str(self.project)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.addCleanup(self.stop)
        with selectors.DefaultSelector() as ready:
            ready.register(self.proc.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(20), "HTTP server readiness deadline")
        boot = json.loads(self.proc.stdout.readline())
        session = json.loads(Path(boot["session_file"]).read_text())
        self.url = session["url"]
        self.auth = {"Authorization": "Bearer " + session["token"], "Content-Type": "application/json"}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)

    def get(self, path):
        with self.opener.open(urllib.request.Request(self.url + path, headers=self.auth), timeout=30) as r:
            return json.load(r)

    def request(self, path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, headers=self.auth, data=data,
                                     method=method or ("POST" if body is not None else "GET"))
        return self.opener.open(req, timeout=60)

    def configure(self, **overrides):
        body = {
            "base_url": self.model.url,
            "model": "local-test-model",
            "api_key": "sk-local-test",
            "adapter": "adapters/llm/openai-compatible.mjs",
        }
        body.update(overrides)
        return json.load(self.request("api/llm/config", body, "PUT"))

    def wait_for(self, job_id, timeout=40):
        deadline = time.time() + timeout
        state = None
        while time.time() < deadline:
            job = self.get(f"api/llm/explain/status?id={job_id}")["job"]
            state = job["state"]
            if state != "running":
                return job
            time.sleep(0.4)
        self.fail(f"generation stayed running past {timeout}s (state={state})")

    # -- no configuration, no request -----------------------------------
    def test_without_a_connection_the_page_is_told_and_nothing_is_generated(self):
        config = self.get("api/llm/config")
        self.assertFalse(config["configured"])
        self.assertFalse(config["has_api_key"])
        self.assertIn("还没有配置", config["note"])
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request("api/llm/explain", {"entity": "src/money.js:charge"})
        self.assertEqual(raised.exception.code, 409)
        detail = json.load(raised.exception)
        self.assertEqual(detail["error"], "llm_not_configured")

    def test_the_key_is_never_returned_but_its_presence_is(self):
        saved = self.configure()
        self.assertTrue(saved["configured"])
        self.assertTrue(saved["has_api_key"])
        self.assertNotIn("api_key", saved)
        self.assertNotIn("sk-local-test", json.dumps(saved))

    def test_a_bad_configuration_is_refused_and_the_previous_one_kept(self):
        self.configure()
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request("api/llm/config", {"base_url": "ftp://example.com"}, "PUT")
        self.assertEqual(raised.exception.code, 400)
        self.assertIn("base_url_must_be_http", json.load(raised.exception)["error"])
        self.assertEqual(self.get("api/llm/config")["base_url"], self.model.url,
                         "a rejected configuration must not half-apply")
        with self.assertRaises(urllib.error.HTTPError):
            self.request("api/llm/config", {"timeout_ms": 5}, "PUT")
        with self.assertRaises(urllib.error.HTTPError):
            self.request("api/llm/config", {"adapter": "adapters/llm/does-not-exist.mjs"}, "PUT")

    # -- the scope is visible and real ----------------------------------
    def test_the_preview_names_the_real_fragments_that_would_be_sent(self):
        self.configure()
        preview = self.get("api/llm/context?entity=src/money.js:charge")
        labels = [piece["label"] for piece in preview["pieces"]]
        self.assertIn("节点源码", labels)
        self.assertIn("源码注释", labels)
        source = next(p for p in preview["pieces"] if p["label"] == "节点源码")
        self.assertTrue(source["path"].endswith("src/money.js"))
        self.assertGreater(source["bytes"], 40)
        self.assertEqual(preview["total_bytes"], sum(p["bytes"] for p in preview["pieces"]))
        self.assertIn("Math.round", preview["prompt_preview"])
        self.assertFalse(preview["truncated"])

    def test_the_scope_shrinks_when_the_reader_turns_a_source_off(self):
        self.configure()
        full = self.get("api/llm/context?entity=src/money.js:charge")
        self.configure(comments=False)
        lean = self.get("api/llm/context?entity=src/money.js:charge")
        self.assertLess(lean["total_bytes"], full["total_bytes"])
        self.assertNotIn("源码注释", [p["label"] for p in lean["pieces"]])

    # -- one generation, three honest outcomes --------------------------
    def test_a_generation_returns_a_real_answer_filed_under_the_node(self):
        self.configure()
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        job = self.wait_for(started["id"])
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["model"], "local-test-model")
        self.assertIn("四舍五入", job["body"])
        self.assertEqual(job["analysis_id"], self.analysis)
        listed = self.get("api/llm/explanations?entity=src/money.js:charge")["explanations"]
        self.assertEqual(listed[0]["id"], job["id"])
        # The prompt really went out, with the source the preview promised.
        self.assertEqual(len(self.model.seen), 1)
        self.assertIn("Math.round", self.model.seen[0]["prompt"])
        self.assertEqual(self.model.seen[0]["auth"], "Bearer sk-local-test")

    def test_an_http_failure_is_a_named_failure_not_an_empty_success(self):
        self.configure()
        self.model.mode = "http_error"
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        job = self.wait_for(started["id"])
        self.assertEqual(job["state"], "failed")
        self.assertTrue(job["error"].startswith("http_429"), job["error"])
        self.assertEqual(job["body"], "")

    def test_an_answer_that_is_not_json_is_reported_as_such(self):
        self.configure()
        self.model.mode = "garbage"
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        job = self.wait_for(started["id"])
        self.assertEqual(job["state"], "failed")
        self.assertIn("adapter_output_not_json", job["error"])

    def test_a_cancelled_generation_is_cancelled_and_not_silently_empty(self):
        self.configure()
        self.model.delay = 6
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        time.sleep(1.0)
        self.assertEqual(self.get(f"api/llm/explain/status?id={started['id']}")["job"]["state"], "running")
        cancelled = json.load(self.request("api/llm/explain/cancel", {"id": started["id"]}))
        self.assertTrue(cancelled["cancelled"])
        job = self.wait_for(started["id"])
        self.assertEqual(job["state"], "cancelled", job)
        self.assertEqual(job["body"], "")

    # -- a generation never writes over what a person wrote -------------
    def test_generating_does_not_touch_the_readers_own_interpretation(self):
        mine = json.load(self.request("api/interpretation", {
            "entity": "src/money.js:charge",
            "body": "我自己的解析：rate 必须先被 clamp。",
            "source_refs": ["manual"],
        }))["interpretation"]
        self.configure()
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        self.wait_for(started["id"])
        again = self.get("api/interpretations?entity=src/money.js:charge")["interpretations"]
        self.assertEqual(len(again), 1)
        self.assertEqual(again[0]["id"], mine["id"])
        self.assertEqual(again[0]["body"], "我自己的解析：rate 必须先被 clamp。")

    def test_explanations_are_scoped_to_their_own_project(self):
        self.configure()
        started = json.load(self.request("api/llm/explain", {"entity": "src/money.js:charge"}))
        self.wait_for(started["id"])
        # A second project on the same store must not inherit the first one's
        # connection or its generated text.
        other = self.base / "other"
        (other / "src").mkdir(parents=True)
        (other / "package.json").write_text('{"name":"other","type":"module"}\n', encoding="utf-8")
        (other / "src" / "money.js").write_text(
            "export function charge(amount, rate) { return amount; }\n", encoding="utf-8")
        other_analysis = self.cli("index", other)["id"]
        self.assertNotEqual(other_analysis, self.analysis)
        opened = json.load(self.request("api/project/open", {"analysis": other_analysis}))
        self.assertTrue(opened.get("ok", True), opened)
        deadline = time.time() + 30
        while time.time() < deadline:
            report = self.get("api/report")
            if report["id"] == other_analysis:
                break
            time.sleep(0.4)
        self.assertEqual(self.get("api/report")["id"], other_analysis)
        self.assertFalse(self.get("api/llm/config")["configured"],
                         "the connection belongs to the project, not the store")
        with self.assertRaises(urllib.error.HTTPError):
            self.request("api/llm/explain", {"entity": "src/money.js:charge"})

    def test_clearing_the_connection_removes_the_key(self):
        self.configure()
        cleared = json.load(self.request("api/llm/config", None, "DELETE"))
        self.assertFalse(cleared["configured"])
        self.assertFalse(cleared["has_api_key"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
