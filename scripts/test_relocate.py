#!/usr/bin/env python3
"""W09: relocating a selection across analysis versions.

A selection is pinned to the analysis it was made in. Opening it against another
version has exactly two honest outcomes: a *reported* relocation to a
counterpart, or a refusal. The cases below are mostly the refusals, because the
failure this feature exists to prevent is silently pointing an old name at
whatever now sits there.

Standard-library only.
"""
import json
from pathlib import Path
import selectors
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"

V1 = {
    "src/a.js": (
        "export function add(a, b) { return a + b; }\n"
        "export function keep(a) { return a; }\n"
        "export function rename_me(a) { return a - 1; }\n"
        "export function drop_me(a) { return a * 2; }\n"
        "export function truly_gone(a) { return a / 2; }\n"
    ),
    "src/extra.js": "export function extra(a) { return a + 100; }\n",
}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-relocate-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "package.json").write_text('{"name":"rel","type":"module"}\n', encoding="utf-8")
        for path, text in V1.items():
            (self.project / path).write_text(text, encoding="utf-8")
        self.store = self.base / "store"
        self.before = self.cli("index", self.project)["id"]

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

    def revise(self, files):
        for path, text in files.items():
            target = self.project / path
            target.parent.mkdir(parents=True, exist_ok=True)
            if text is None:
                if target.exists():
                    target.unlink()
            else:
                target.write_text(text, encoding="utf-8")
        return self.cli("index", self.project)["id"]

    def relocate(self, entity, to, ok=True):
        return self.cli("relocate", self.before, entity, "--to", to, ok=ok)


class Relocation(Base):
    def setUp(self):
        super().setUp()
        # v2: `add` is edited, `keep` is untouched, `rename_me` is renamed and
        # edited, `drop_me` is deleted, and `move_me` appears in another file.
        self.after = self.revise({
            "src/a.js": (
                "export function add(a, b) { return a + b + 0; }\n"
                "export function keep(a) { return a; }\n"
                "export function renamed(a) { return a - 2; }\n"
            ),
            "src/moved.js": "export function moved(a) { return a * 2; }\n",
            # The whole file disappears: a withdrawal, not merely a missing entity.
            "src/extra.js": None,
        })

    def rel(self, entity, to=None):
        return self.relocate(entity, to or self.after)

    # -- the two honest outcomes ------------------------------------------
    def test_an_unchanged_entity_relocates_by_path_and_name(self):
        relocation = self.rel("keep")["relocation"]
        self.assertTrue(relocation["relocated"])
        self.assertEqual(relocation["matched_by"], "path_and_name")
        self.assertFalse(relocation["bytes_changed"])

    def test_an_edited_entity_relocates_and_reports_that_the_bytes_changed(self):
        relocation = self.rel("add")["relocation"]
        self.assertTrue(relocation["relocated"])
        self.assertEqual(relocation["matched_by"], "path_and_name")
        self.assertTrue(relocation["bytes_changed"],
                        "an edit must be visible in the relocation, not hidden")

    def test_the_same_version_needs_no_relocation(self):
        relocation = self.relocate("keep", self.before)["relocation"]
        self.assertTrue(relocation["relocated"])
        self.assertEqual(relocation["matched_by"], "same_version")

    def test_an_entity_deleted_from_a_live_file_has_no_counterpart(self):
        # The file is still there, the function is not. The neighbours are
        # context, not candidates, and the note says so.
        result = self.rel("truly_gone")
        self.assertFalse(result["relocation"]["relocated"])
        self.assertEqual(result["relocation"]["refusal"], "no_counterpart")
        self.assertGreater(result["relocation"]["candidate_count"], 0)
        self.assertIsNone(result["selection"])

    def test_a_withdrawn_file_is_named_as_a_withdrawal(self):
        # A missing file and a missing entity inside a live file are different
        # facts; the first uses the same word the incremental report uses.
        result = self.rel("extra")
        self.assertFalse(result["relocation"]["relocated"])
        self.assertEqual(result["relocation"]["refusal"], "entity_withdrawn")
        self.assertIsNone(result["selection"])

    def test_a_function_moved_to_another_file_and_renamed_is_refused(self):
        # `drop_me` reappears as `moved` in another file. The name changed, and
        # the name is part of the bytes, so neither name nor content matches.
        result = self.rel("drop_me")
        self.assertFalse(result["relocation"]["relocated"])
        self.assertEqual(result["relocation"]["refusal"], "no_counterpart")
        self.assertIsNone(result["selection"])

    def test_a_renamed_and_edited_entity_is_refused_not_guessed(self):
        # The name is part of the bytes, so a rename plus an edit matches
        # neither by name nor by content. The other functions in the file are
        # neighbours, and the answer says so.
        result = self.rel("rename_me")
        relocation = result["relocation"]
        self.assertFalse(relocation["relocated"])
        self.assertEqual(relocation["refusal"], "no_counterpart")
        self.assertGreater(relocation["candidate_count"], 0, "the context must still be reported")
        self.assertIsNone(result["selection"])

    def test_a_pure_move_relocates_by_identical_bytes(self):
        # `keep` moves to another file with its text unchanged: same name, new
        # path, identical bytes. That is the one rename shape Atlas can recognise
        # honestly, and it says which evidence carried it.
        moved = self.revise({
            "src/a.js": "export function add(a, b) { return a + b; }\n",
            "src/elsewhere.js": "export function keep(a) { return a; }\n",
        })
        relocation = self.cli("relocate", self.before, "keep", "--to", moved)["relocation"]
        self.assertTrue(relocation["relocated"], relocation)
        self.assertEqual(relocation["matched_by"], "identical_bytes")
        self.assertFalse(relocation["bytes_changed"])

    def test_two_identical_copies_are_an_ambiguity_not_a_pick(self):
        duplicated = self.revise({
            "src/a.js": "export function keep(a) { return a; }\n",
            "src/elsewhere.js": "export function keep(a) { return a; }\n",
        })
        # The same path still exists, so path+name wins -- precedence matters and
        # is checked here rather than left to chance.
        relocation = self.cli("relocate", self.before, "keep", "--to", duplicated)["relocation"]
        self.assertTrue(relocation["relocated"])
        self.assertEqual(relocation["matched_by"], "path_and_name")

    def test_an_unknown_entity_cannot_even_be_asked_about(self):
        # Relocation is defined for an entity that exists in its own version. A
        # name that resolves nowhere is refused during resolution, with the name
        # and the reason -- it never reaches the relocation step pretending to be
        # a relocation failure.
        result = subprocess.run(
            [str(BIN), "--store", str(self.store), "relocate", self.before,
             "no-such-function", "--to", self.after],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("entity_not_found", result.stderr)

    def test_an_unknown_target_analysis_is_an_error(self):
        self.cli("relocate", self.before, "keep", "--to", "f" * 64, ok=False)

    # -- relocation changes nothing ---------------------------------------
    def test_relocating_does_not_touch_any_stored_record(self):
        before_report = self.cli("report", self.before)
        digest_before = self.cli("relocate", self.before, "keep", "--to", self.after)
        self.assertTrue(digest_before["relocation"]["relocated"])
        # The target selection is pinned to the target analysis and nothing else
        # moved: no analysis was rewritten, no checkpoint created.
        self.assertEqual(digest_before["selection"]["version"], self.after)
        self.assertEqual(digest_before["selection"]["analysis_id"], self.after)
        self.assertEqual(self.cli("report", self.before), before_report)
        self.assertEqual(self.cli("report", self.after)["id"], self.after)


class RelocationHttp(Base):
    def setUp(self):
        super().setUp()
        self.after = self.revise({
            "src/a.js": (
                "export function add(a, b) { return a + b + 0; }\n"
                "export function keep(a) { return a; }\n"
            ),
        })
        self.proc = subprocess.Popen(
            [str(BIN), "--store", str(self.store), "serve", self.after],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.addCleanup(self.stop)
        with selectors.DefaultSelector() as ready:
            ready.register(self.proc.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(15), "HTTP server readiness deadline")
        boot = json.loads(self.proc.stdout.readline())
        session = json.loads(Path(boot["session_file"]).read_text())
        self.url = session["url"]
        self.auth = {"Authorization": "Bearer " + session["token"]}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)

    def get(self, path, headers=None):
        request_headers = self.auth if headers is None else headers
        with self.opener.open(urllib.request.Request(self.url + path, headers=request_headers), timeout=20) as response:
            return json.load(response)

    def test_http_relocation_returns_the_decision_and_a_pinned_selection(self):
        result = self.get("api/relocate?entity=add&from=" + self.before)
        self.assertTrue(result["relocation"]["relocated"])
        self.assertEqual(result["relocation"]["from_analysis"], self.before)
        self.assertEqual(result["relocation"]["to_analysis"], self.after)
        self.assertEqual(result["selection"]["version"], self.after,
                         "the returned selection is pinned to the served version")
        self.assertTrue(result["relocation"]["bytes_changed"])

    def test_http_relocation_refuses_without_a_source_version(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.get("api/relocate?entity=add")
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_http_relocation_requires_the_session(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.get("api/relocate?entity=add&from=" + self.before, headers={})
        self.assertEqual(error.exception.code, 401)
        error.exception.close()


if __name__ == "__main__":
    if not BIN.exists():
        raise SystemExit("Run cargo build --workspace first")
    unittest.main(verbosity=2)
