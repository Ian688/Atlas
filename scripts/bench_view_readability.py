#!/usr/bin/env python3
"""Readability of the column scale, as a number instead of an opinion.

Why this exists
---------------
The 3D view used to size a column linearly in the declared function count. On
the real rxjs@7.8.1 analysis that drew 92.1% of the files *that have any
function at all* under 1% of the tallest column's height: invisible, while one
1056-function bundle flattened the picture. A reader looking at it concludes
"that file is the project". The analysis never said that.

"Does it look better" cannot be gated. "Can a column that carries functions be
seen at all, and is the median column a meaningful fraction of the tallest" can.
That is what this measures, from the facts, using the same scale function the
two projections use -- read out of `web/hierarchy.js` through
`scripts/scale_report.mjs`, never re-implemented here. A second implementation
would drift from the first the way the two hierarchies did, and the drift would
be invisible because both would look reasonable on their own.

Exit codes: 0 when every criterion holds, 1 on a violated criterion, 2 on a
usage or environment error. `--self-check` needs no store and no network.

Usage
-----
    python3 scripts/bench_view_readability.py --self-check
    python3 scripts/bench_view_readability.py --store local-state --analysis <id> --out report.json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRIVER = ROOT / "scripts" / "scale_report.mjs"

# The criteria. Each is a claim about readability that a reader can check:
#   * a column that carries functions is never drawn under 1% of the tallest;
#   * the median column stays above a floor of the tallest (the floor is low
#     because real packages really are dominated by small files -- lowering it
#     further would weaken the check rather than describe reality);
#   * compression compresses, and says so;
#   * the scale is monotone and linear exactly where the work order says.
REAL_FIXTURE_FLOOR = 0.05
SYNTHETIC_FIXTURE_FLOOR = 0.25


def fail(message: str) -> None:
    sys.stderr.write(f"readability criterion failed: {message}\n")


def drive(counts: list[int] | None = None, fixture: str | None = None) -> dict:
    argv = ["node", str(DRIVER)]
    payload = None
    if fixture:
        argv += ["--fixture", fixture]
    else:
        payload = json.dumps(counts or [])
    proc = subprocess.run(
        argv, cwd=ROOT, input=payload, capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-500:])
        raise SystemExit(2)
    return json.loads(proc.stdout)


def counts_from_store(store: Path, analysis: str) -> list[int]:
    database = store / "atlas.db"
    if not database.is_file():
        sys.stderr.write(f"no store at {database}\n")
        raise SystemExit(2)
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "select body from nodes where analysis = ? and kind = 'file'", (analysis,),
        ).fetchall()
    finally:
        connection.close()
    if not rows:
        sys.stderr.write(f"no file nodes for analysis {analysis}\n")
        raise SystemExit(2)
    counts = []
    for (body,) in rows:
        node = json.loads(body)
        counts.append(int(node.get("function_count") or 0))
    return counts


def check(report: dict, probes: list[dict], ruler: dict, floor: float) -> list[str]:
    """Return the list of violated criteria, each named."""
    bad: list[str] = []
    scale = report["scale"]

    if not report["monotone"]:
        bad.append("the scale is not monotone: a file with more functions can draw shorter")
    if not report["linearFirstEight"]:
        bad.append(f"the first {scale['free']} layers are not linear")

    heights = {probe["n"]: probe["height"] for probe in probes}
    if not heights[0] < heights[1]:
        bad.append("N=0 is not shorter than N=1, so a file's role is not distinguishable")
    if not heights[1056] < 1056:
        bad.append("a compressed column is not actually compressed")
    if heights[1000000] > scale["cap"] + 1e-9:
        bad.append("the height is not capped")

    expected = {0: "flat", 1: "linear", 8: "linear", 9: "thin", 20: "thin",
                21: "group", 50: "group", 51: "compressed", 1056: "compressed"}
    for probe in probes:
        want = expected.get(probe["n"])
        if want and probe["tier"] != want:
            bad.append(f"N={probe['n']} is tier {probe['tier']}, not {want}")

    radii = [probe["radius"] for probe in sorted(probes, key=lambda p: p["n"])]
    if any(b < a - 1e-9 for a, b in zip(radii, radii[1:])):
        bad.append("the radius is not weakly monotone")
    if max(radii) > 1.5:
        bad.append("the radius channel is strong enough to compete with the height")

    if report["under"]["onePct"] != 0:
        bad.append(
            f"{report['under']['onePct']}/{report['under']['of']} columns that carry functions "
            "are drawn under 1% of the tallest one"
        )
    if report["ratios"]["medianOverMax"] < floor:
        bad.append(
            f"the median column is only {report['ratios']['medianOverMax']:.3f} of the tallest "
            f"(floor {floor})"
        )

    # The criterion has to be able to fail: if the scale this replaced also
    # passed it, the check would be decoration.
    if report["linear"]["onePct"] == 0:
        bad.append("the linear scale this replaced also passes the 1% criterion: the check is vacuous")

    ticks = ruler["ticks"]
    heights_in_order = [tick["height"] for tick in ticks]
    if any(b < a - 1e-9 for a, b in zip(heights_in_order, heights_in_order[1:])):
        bad.append("the ruler ticks are not monotone in height")
    if ruler["maxCount"] > 50 and not any("封顶" in tick["label"] for tick in ticks):
        bad.append("the ruler does not show the compression cap it applied")
    return bad


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true",
                        help="check the criteria against the built-in realistic fixture")
    parser.add_argument("--store", type=Path, default=None)
    parser.add_argument("--analysis", default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    if not args.self_check and not (args.store and args.analysis):
        parser.error("pass --self-check, or --store and --analysis")

    if args.self_check:
        driven = drive(fixture="realistic")
        report, probes, ruler = driven["report"], driven["probes"], driven["ruler"]
        bad = check(report, probes, ruler, SYNTHETIC_FIXTURE_FLOOR)
        print(f"fixture realistic: {report['withFunctions']} columns carry functions, "
              f"median/max {report['ratios']['medianOverMax']:.3f}, "
              f"under 1% {report['under']['onePct']} (linear scale: {report['linear']['onePct']}), "
              f"tiers {report['tiers']}")
        if bad:
            for line in bad:
                fail(line)
            return 1
        print("all readability criteria hold")

    if args.store and args.analysis:
        counts = counts_from_store(args.store, args.analysis)
        driven = drive(counts)
        report, probes, ruler = driven["report"], driven["probes"], driven["ruler"]
        bad = check(report, probes, ruler, REAL_FIXTURE_FLOOR)
        print(f"{args.store}: {report['files']} file objects, {report['withFunctions']} carry functions "
              f"(N=0: {report['empty']}), median/max {report['ratios']['medianOverMax']:.3f}, "
              f"under 1% {report['under']['onePct']} (linear scale: {report['linear']['onePct']}/{report['linear']['onePct'] and report['under']['of']})")
        print(f"tiers {report['tiers']}")
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps({
                "schema": "atlas.view-readability.v1",
                "store": str(args.store),
                "analysis": args.analysis,
                "report": report,
                "ruler": ruler,
                "criteria": {
                    "floor_median_over_max": REAL_FIXTURE_FLOOR,
                    "violated": bad,
                },
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"wrote {args.out}")
        if bad:
            for line in bad:
                fail(line)
            return 1
        print("all readability criteria hold on the real analysis")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
