#!/usr/bin/env python3
"""Replay the foundation checks and record exit codes and actual source hashes."""
import datetime
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"evidence/foundation"
OUT.mkdir(parents=True,exist_ok=True)
checks=[
    ("rust-format",["cargo","fmt","--all","--check"]),
    ("rust-clippy",["cargo","clippy","--workspace","--all-targets","--locked","--","-D","warnings"]),
    ("rust-tests",["cargo","test","--workspace","--locked"]),
    ("rust-build",["cargo","build","--workspace","--locked"]),
    ("worker-tests",["npm","test","--prefix","workers/typescript"]),
    ("integration",[sys.executable,"scripts/test_integration.py"]),
    ("calculator",["node","examples/calculator/demo.mjs"]),
    ("web-syntax",["node","--check","web/app.js"]),
    ("whitespace",["git","diff","--check"]),
]
record={"schema":"atlas.foundation-verification.v1","time_utc":datetime.datetime.now(datetime.timezone.utc).isoformat(),"platform":platform.platform(),"commands":[],"qualification":"foundation only; not full AL/ET/GE/MT/HI/DV or mature Atlas acceptance"}
for name,cmd in [("rustc",["rustc","--version"]),("cargo",["cargo","--version"]),("node",["node","--version"]),("npm",["npm","--version"]),("python",[sys.executable,"--version"])]:
    r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,timeout=15)
    record[name]=r.stdout.strip()

(OUT/"verification.json").write_text(json.dumps(record,indent=2)+"\n")
for name,cmd in checks:
    start=time.monotonic()
    try:
        r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True,timeout=180)
        code=r.returncode;log=r.stdout+r.stderr
    except subprocess.TimeoutExpired as error:
        code=124;log=f"TIMEOUT: {error}\n"
    (OUT/f"{name}.log").write_text(log)
    record["commands"].append({"name":name,"argv":cmd,"exit_code":code,"seconds":round(time.monotonic()-start,3),"log":f"{name}.log"})
    print(f"{'PASS' if code==0 else 'FAIL'} {name}: exit {code}",flush=True)
    if code:break

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
protected=json.loads((OUT/"modus-before.json").read_text())
modus=ROOT.parent/"Modus"
record["modus_protected_files"]={"checked":len(protected),"changed_or_missing":[p for p,h in protected.items() if not (modus/p).is_file() or digest(modus/p)!=h],"meaning":"observed baseline drift; do not overwrite concurrent work"}
record["source_hashes"]={str(p.relative_to(ROOT)):digest(p) for base in [ROOT/"crates",ROOT/"workers/typescript",ROOT/"web",ROOT/"examples",ROOT/"scripts"] for p in sorted(base.rglob("*")) if p.is_file() and "node_modules" not in p.parts and "__pycache__" not in p.parts}
for name in ["Cargo.toml","Cargo.lock","AGENTS.md","README.md"]:record["source_hashes"][name]=digest(ROOT/name)
errors=[]
for p in [ROOT/"README.md",*sorted((ROOT/"docs").glob("*.md")),ROOT/"docs/specs/README.md"]:
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)",p.read_text()):
        if "://" in target or target.startswith("#"):continue
        if not (p.parent/target.split("#")[0]).exists():errors.append(f"{p.relative_to(ROOT)} -> {target}")
record["current_document_links"]={"errors":errors,"scope":"new current entry docs only; original imported requirement links retain Modus context"}
record["status"]="PASS" if len(record["commands"])==len(checks) and all(c["exit_code"]==0 for c in record["commands"]) and not errors else "FAIL"
(OUT/"verification.json").write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"status":record["status"],"protected_files":record["modus_protected_files"],"document_errors":errors},ensure_ascii=False),flush=True)
raise SystemExit(0 if record["status"]=="PASS" else 1)
