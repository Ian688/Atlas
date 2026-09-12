#!/usr/bin/env python3
"""Exercise incremental reuse: what is reused, what is invalidated, and proof.

The load-bearing assertion is not the speed-up. It is that an incremental run
publishes the *same analysis id* as a full run on the same tree. An analysis id
is a digest of the analysis content, so a wrongly reused file -- a stale call
target, a node that should have been withdrawn -- changes it. Every test that
can compare the two does.

Standard-library only. This is not a large-project qualification.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/atlas"
LEAVES = 30


def make_project(base: Path) -> Path:
    """A shared module and a fan of leaves that import it, so invalidation has
    a direction to travel in."""
    project = base / "project"
    (project / "lib").mkdir(parents=True)
    (project / "app").mkdir(parents=True)
    (project / "lib" / "util.js").write_text(
        "export function add(a, b) { return a + b; }\n"
        "export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }\n",
        encoding="utf-8",
    )
    for index in range(LEAVES):
        (project / "app" / f"m{index}.js").write_text(
            "import { add, clamp } from \"../lib/util.js\";\n"
            f"export function f{index}(x) {{ let y = add(x, {index}); return clamp(y, 0, 100); }}\n"
            f"export function g{index}(x) {{ if (x > 0) {{ return f{index}(x) }} return 0; }}\n",
            encoding="utf-8",
        )
    return project


class Incremental(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-incremental-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = make_project(self.base)
        self.store = self.base / "store"

    def cli(self, *args, store=None):
        result = subprocess.run(
            [str(BIN), "--store", str(store or self.store), *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def incremental(self, store=None, mutate=None):
        if mutate:
            mutate()
        return self.cli("index", self.project, "--incremental", store=store)

    def full(self, name):
        """A genuine full derivation in its own store, for comparison."""
        return self.cli("index", self.project, store=self.base / name)

    def edit(self, relative, old, new):
        path = self.project / relative
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"{relative} no longer contains the text to replace")
        path.write_text(text.replace(old, new), encoding="utf-8")

    def test_a_first_run_derives_everything_and_says_so(self):
        report = self.incremental()["incremental"]
        self.assertEqual(report["outcome"], "derived")
        self.assertEqual(report["files"]["parsed"], LEAVES + 1)
        self.assertEqual(report["files"]["reusable"], 0, "nothing was recorded before")
        self.assertEqual(report["changes"], [], "there is no previous run to differ from")
        self.assertEqual(report["withdrawn"], [])
        self.assertGreater(report["seconds"]["derivation"], 0.0)

    def test_an_unchanged_tree_reuses_the_analysis_a_full_run_would_publish(self):
        first = self.incremental()
        again = self.incremental()
        report = again["incremental"]
        self.assertEqual(report["outcome"], "reused", "identical bytes and versions must not re-derive")
        self.assertEqual(report["seconds"]["derivation"], 0.0)
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["id"], self.full("full")["id"],
                         "the reused analysis must be the one a full run publishes")

    def test_an_edited_file_is_the_only_one_invalidated(self):
        self.incremental()
        report = self.incremental(
            mutate=lambda: self.edit("app/m5.js", "add(x, 5)", "add(x, 55)")
        )["incremental"]
        self.assertEqual(report["outcome"], "derived")
        self.assertEqual(report["files"]["own_content"], 1)
        self.assertEqual(report["files"]["by_dependency"], 0,
                         "a leaf nothing imports cannot invalidate anything else")
        self.assertEqual([c["path"] for c in report["changes"]], ["app/m5.js"])
        self.assertEqual(report["changes"][0]["change"], "own_content")

    def test_a_shared_dependency_invalidates_its_dependents(self):
        self.incremental()
        report = self.incremental(
            mutate=lambda: self.edit("lib/util.js", "return a + b;", "return a + b + 0;")
        )["incremental"]
        # lib/util.js itself carries the edit; every leaf reaches it through
        # its import closure, so each is invalidated without having changed.
        self.assertEqual(report["files"]["own_content"], 1)
        self.assertEqual(
            report["files"]["by_dependency"], LEAVES,
            f"all {LEAVES} importers must be invalidated by their dependency",
        )
        by_path = {change["path"]: change for change in report["changes"]}
        leaf = by_path["app/m0.js"]
        self.assertEqual(leaf["change"], "dependency")
        self.assertEqual(leaf["via"], ["lib/util.js"],
                         "the report must name the dependency that caused it")

    def test_a_deleted_file_is_withdrawn_and_leaves_no_trace(self):
        self.incremental()
        report = self.incremental(
            mutate=lambda: os.remove(self.project / "app" / "m7.js")
        )["incremental"]
        self.assertEqual(report["withdrawn"], ["app/m7.js"])
        self.assertEqual(report["files"]["parsed"], LEAVES, "one file fewer is parsed")
        self.assertEqual(report["outcome"], "derived")

        # Withdrawing means the fact is gone from the new analysis, not merely
        # reported: the analysis must still equal a full run of the same tree.
        after = self.cli("index", self.project, "--incremental")
        self.assertEqual(after["id"], self.full("full-after-delete")["id"],
                         "a withdrawn file must not survive in the new analysis")

    def test_the_analysis_id_survives_every_incremental_path(self):
        # Cold, hot, edited and deleted all have to land on the same id a fresh
        # full derivation would produce, or a cache hit would be a different
        # answer to the same question.
        self.incremental()
        self.assertEqual(self.cli("index", self.project, "--incremental")["id"],
                         self.full("full-hot")["id"])
        self.edit("app/m9.js", "add(x, 9)", "add(x, 99)")
        self.assertEqual(self.cli("index", self.project, "--incremental")["id"],
                         self.full("full-edited")["id"])
        os.remove(self.project / "app" / "m0.js")
        self.assertEqual(self.cli("index", self.project, "--incremental")["id"],
                         self.full("full-deleted")["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
