#!/usr/bin/env python3
"""Ask a real browser whether the pinned layout engine actually works there.

Why this probe exists
---------------------
While wiring the 2D call view, the same graph through the same engine API
returned positions in one host and **no positions at all** inside `node:vm`.
That is not a detail: a layout that silently answers without coordinates, if it
is accepted, draws every box stacked at the origin -- a picture that looks
deliberate and says nothing. The adapter now refuses that result
(`elk_returned_no_coordinates`), and the benchmarks run in plain node. Neither
of those answers the question that actually matters, which is whether the engine
works in the environment the product runs in.

So this probe runs the real, vendored bytes in a real browser: it serves
`web/hierarchy.js`, `web/layout.js` and `web/vendor/elk.bundled.js` from a
throwaway local server, loads a page that calls the same `planFocusLayoutAsync`
the workbench calls, and reads the answer out of the DOM.

It is deliberately **not** a gate check: it needs a browser and a local server,
and a gate that silently skips itself when either is missing is worse than no
gate. The hermetic parts (refusal, folding, determinism) are gate checks; this
is the environment check, run on purpose.

Usage:
    python3 scripts/probe_browser_engine.py            # prints the probe output
    python3 scripts/probe_browser_engine.py --out FILE # also writes it
Exit codes: 0 when the engine laid the graph out in the browser, 1 otherwise.
"""

from __future__ import annotations

import argparse
import http.server
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

# A focus neighbourhood shaped like a real one: one target, callers above it,
# callees below it, and an unresolved target that must stay visible as a stub.
PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<pre id="out">running</pre>
<script src="/hierarchy.js"></script>
<script src="/layout.js"></script>
<script src="/vendor/elk.bundled.js"></script>
<script>
(async () => {
  const lines = [];
  try {
    lines.push('ELK global: ' + (typeof ELK));
    const nodes = [{ id: 'symbol:target.ts:0:1', kind: 'function', name: 'redeemCoupon', path: 'src/coupon.ts' }];
    const edges = [];
    for (let i = 0; i < 5; i++) { const id = 'symbol:c' + i + '.ts:0:1'; nodes.push({ id, kind: 'function', name: 'caller' + i, path: 'src/c' + i + '.ts' }); edges.push({ id: 'c' + i, source: id, target: nodes[0].id, label: 'call' }); }
    for (let i = 0; i < 14; i++) { const id = 'symbol:d' + i + '.ts:0:1'; nodes.push({ id, kind: 'function', name: 'callee' + i, path: 'src/d' + i + '.ts' }); edges.push({ id: 'd' + i, source: nodes[0].id, target: id, label: 'call' }); }
    const focus = { edges, unresolved: [{ label: 'dyn()' }] };
    const started = performance.now();
    const plan = await planFocusLayoutAsync(focus, nodes, { rootId: nodes[0].id, maxNodes: 120, elk: new ELK() });
    lines.push('engine: ' + plan.engine + ' (' + (plan.engineError || 'no error') + ')');
    lines.push('boxes: ' + plan.boxes.length + ' edges: ' + plan.edges.length + ' ports: ' + [...plan.ports.values()].reduce((t, e) => t + e.slots.length, 0));
    lines.push('ms: ' + (performance.now() - started).toFixed(1) + ' crossings: ' + plan.metrics.crossings + ' labelCollisions: ' + plan.metrics.labelCollisions);
    lines.push('atOrigin: ' + plan.boxes.filter((b) => b.x === 0 && b.y === 0).length);
    lines.push('distinct x: ' + new Set(plan.boxes.map((b) => Math.round(b.x))).size + ' bounds: ' + JSON.stringify(plan.bounds));
    const ok = plan.engine === 'elk_pinned' && plan.boxes.filter((b) => b.x === 0 && b.y === 0).length === 0;
    lines.push('RESULT ' + (ok ? 'PASS' : 'FAIL'));
  } catch (error) {
    lines.push('RESULT FAIL ' + String((error && error.message) || error));
  }
  document.getElementById('out').textContent = lines.join('\\n');
})();
</script></body></html>
"""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    chrome = next((path for path in CHROME_CANDIDATES if path and Path(path).is_file()), None)
    if chrome is None:
        sys.stderr.write("no chrome/chromium found; this probe needs a real browser\n")
        return 2

    with tempfile.TemporaryDirectory(prefix="atlas-browser-probe-") as tmp:
        root = Path(tmp)
        (root / "vendor").mkdir()
        shutil.copy(ROOT / "web" / "hierarchy.js", root / "hierarchy.js")
        shutil.copy(ROOT / "web" / "layout.js", root / "layout.js")
        # The vendored bytes exactly as they are served, not a rebuilt copy.
        shutil.copy(ROOT / "web" / "vendor" / "elk.bundled.js", root / "vendor" / "elk.bundled.js")
        (root / "probe.html").write_text(PAGE, encoding="utf-8")

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):  # a probe that chats is noise in the evidence
                return

        port = free_port()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), lambda *a, **k: Quiet(*a, directory=str(root), **k))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            done = subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--virtual-time-budget=20000",
                 "--dump-dom", f"http://127.0.0.1:{port}/probe.html"],
                capture_output=True, text=True, timeout=180,
            )
        finally:
            server.shutdown()
            server.server_close()

        match = re.search(r'<pre id="out">(.*?)</pre>', done.stdout, re.S)
        if not match:
            sys.stderr.write("the probe page produced no output\n")
            return 1
        output = match.group(1).strip()
        print(output)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(output + "\n", encoding="utf-8")
        return 0 if output.endswith("RESULT PASS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
