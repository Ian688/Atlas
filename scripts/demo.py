#!/usr/bin/env python3
"""Convenience launcher only. The Atlas service itself is a Rust binary."""
import argparse
import json
from pathlib import Path
import selectors
import signal
import subprocess
import urllib.parse
import webbrowser

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--open", action="store_true", help="open the authenticated local workbench in the default browser")
args = parser.parse_args()
binary = root / "target/debug/atlas"
if not binary.exists(): raise SystemExit("Run cargo build --workspace first")
store = root / "local-state/calculator"
indexed = subprocess.run([str(binary),"--store",str(store),"index",str(root/"examples/calculator")],cwd=root,capture_output=True,text=True,timeout=90)
if indexed.returncode:raise SystemExit(indexed.stderr)
report = json.loads(indexed.stdout)
print(f"Local analysis: {report['file_count']} files, {report['function_count']} functions, {report['call_count']} call sites. Static candidates only.",flush=True)
server = subprocess.Popen([str(binary),"--store",str(store),"serve",report["id"]],cwd=root,stdout=subprocess.PIPE,text=True)
try:
    with selectors.DefaultSelector() as ready:
        ready.register(server.stdout,selectors.EVENT_READ)
        if not ready.select(10): raise RuntimeError("server readiness timeout")
    boot=json.loads(server.stdout.readline())
    print(json.dumps(boot,ensure_ascii=False),flush=True)
    if args.open:
        session=json.loads(Path(boot["session_file"]).read_text())
        webbrowser.open(session["url"]+"#"+urllib.parse.urlencode({"token":session["token"]}))
    print("Ctrl-C to stop. No model invocation or target-code execution.",flush=True)
    server.wait()
except KeyboardInterrupt:
    server.send_signal(signal.SIGINT)
finally:
    if server.poll() is None:
        server.send_signal(signal.SIGINT)
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
    server.stdout.close()
