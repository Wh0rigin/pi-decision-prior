#!/usr/bin/env python3
"""A/B benchmark: run identical tasks with the decision-prior extension enabled vs disabled.

For each task, toggles the extension config (enabled on/off), runs `pi -p`
in a fresh fixture directory, and measures wall time, session token usage,
and the number of prior consultations (from the debug log).

Usage:
  python benchmark.py            # built-in task suite
  python benchmark.py --quick    # single task

Results are printed as a comparison table. The original config is restored
afterwards.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PI = shutil.which("pi") or "pi"

HOME = Path.home()
CFG_PATH = HOME / ".pi" / "decision-prior.json"
DEBUG_LOG = HOME / ".pi" / "decision-prior-debug.jsonl"
SESSIONS = HOME / ".pi" / "agent" / "sessions"
BENCH_ROOT = HOME / ".pi-prior-bench"

BUGGY_SYNC_JOB = '''\
import threading, requests

URLS = ["https://example.com"] * 20
results = []

def fetch(url):
    r = requests.get(url, timeout=5)
    results.append(r.json()["items"])

threads = [threading.Thread(target=fetch, args=(u,)) for u in URLS]
for t in threads:
    t.start()
for t in threads:
    t.join()
report = "\\n".join(str(len(r)) for r in results)
print(report)
'''

LONG_APP_FILES = {
    "pipeline.py": '''\
"""Daily report pipeline entry point."""
from config import REPORT_PATH
from sources import load_records
from validate import validate_record
from filters import filter_valid
from aggregate import build_daily_summary
from output import write_report


def main():
    raw = load_records("data.jsonl")
    valid = []
    for r in raw:
        err = validate_record(r)
        if err is None:
            valid.append(r)
    records = filter_valid(valid)
    summary = build_daily_summary(records)
    write_report(summary, REPORT_PATH)
    print(f"wrote {len(summary)} entries to {REPORT_PATH}")


if __name__ == "__main__":
    main()
''',
    "config.py": '''\
REPORT_PATH = "report.txt"
MAX_RETRIES = 3
TIMEOUT_S = 30
SAMPLE_LIMIT = 100
''',
    "sources.py": '''\
import json
from config import MAX_RETRIES


def load_records(path):
    """Load newline-delimited JSON records. Retries malformed lines."""
    records = []
    for attempt in range(MAX_RETRIES):
        pending = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    pending.append(json.loads(line))
                except json.JSONDecodeError:
                    pending.append(line)  # retry as raw on next pass
        if len(pending) == len(records) or attempt == MAX_RETRIES - 1:
            return [r for r in pending if isinstance(r, dict)]
        records = pending
    return [r for r in pending if isinstance(r, dict)]
''',
    "validate.py": '''\
REQUIRED = ("ts", "region", "amount")


def validate_record(r):
    """Return an error string for invalid records, else None."""
    if not isinstance(r, dict):
        return "not a dict"
    for k in REQUIRED:
        if k not in r:
            return f"missing field {k}"
    try:
        float(r["amount"])
    except (TypeError, ValueError):
        return "amount not numeric"
    return None
''',
    "filters.py": '''\
def filter_positive(records):
    return [r for r in records if float(r["amount"]) >= 0]


def dedupe_by_region(records):
    seen = set()
    out = []
    for r in records:
        if r["region"] in seen:
            continue
        seen.add(r["region"])
        out.append(r)
    return out


def filter_valid(records):
    """Main filter used by the pipeline."""
    return [r for r in records if r.get("region")]
''',
    "aggregate.py": '''\
def build_daily_summary(records):
    """Build the daily summary, one entry per timestamp, sorted by time."""
    by_ts = {}
    for r in records:
        by_ts[r["ts"]] = {"ts": r["ts"], "region": r["region"], "amount": r["amount"]}
    return [by_ts[k] for k in sorted(by_ts)]
''',
    "output.py": '''\
def write_report(summary, path, max_lines=None):
    """Write one CSV line per summary entry."""
    entries = summary if max_lines is None else summary[:max_lines]
    with open(path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(f"{e['ts']},{e['region']},{e['amount']}\\n")
''',
    "data.jsonl": '''\
{"ts": "2026-09-22T09:00:00", "region": "cn-north", "amount": 120.5}
{"ts": "2026-09-22T10:05:00", "region": "cn-east", "amount": 88.0}
{"ts": "2026-09-22T10:05:00", "region": "cn-south", "amount": 64.5}
{"ts": "2026-09-22T10:30:00", "region": "us-west", "amount": 210.1}
{"ts": "2026-09-22T11:00:00", "region": "eu-central", "amount": 95.3}
{"ts": "2026-09-22T11:45:00", "region": "apac", "amount": 143.7}
{"ts": "2026-09-22T13:20:00", "region": "cn-north", "amount": 77.2}
{"ts": "2026-09-22T14:05:00", "region": "us-east", "amount": 302.9}
{"ts": "2026-09-22T16:40:00", "region": "cn-east", "amount": 55.6}
{"ts": "2026-09-22T17:10:00", "region": "apac", "amount": 121.4}
''',
    "NOTES.md": '''\
# Notes

The daily report must contain exactly 10 entries for data.jsonl (one per record).
Recently the report only shows 9 lines. Data source is confirmed complete;
upstream team says nothing is dropped on their side.
''',
}

LONG_APP_FILES_V2 = {
    "pipeline.py": '''\
"""Daily report pipeline: load -> validate -> fx convert -> aggregate -> write."""
from config import REPORT_PATH
from sources import load_records
from validate import validate_record
from fx import apply_rates
from aggregate import build_daily_summary
from output import write_report


def main():
    raw = load_records("data.jsonl")
    records = [r for r in raw if validate_record(r) is None]
    converted = apply_rates(records, "rates.jsonl")
    summary = build_daily_summary(converted)
    write_report(summary, REPORT_PATH)
    print(f"wrote {len(summary)} entries to {REPORT_PATH}")


if __name__ == "__main__":
    main()
''',
    "config.py": '''\
REPORT_PATH = "report.txt"
MAX_RETRIES = 3
TIMEOUT_S = 30
DEFAULT_RATE = 7.0
''',
    "sources.py": '''\
import json
from config import MAX_RETRIES


def load_records(path):
    """Load newline-delimited JSON records, retrying malformed lines."""
    records = []
    for attempt in range(MAX_RETRIES):
        pending = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    pending.append(json.loads(line))
                except json.JSONDecodeError:
                    pending.append(line)
        if len(pending) == len(records) or attempt == MAX_RETRIES - 1:
            return [r for r in pending if isinstance(r, dict)]
        records = pending
    return [r for r in pending if isinstance(r, dict)]
''',
    "validate.py": '''\
REQUIRED = ("ts", "region", "amount")


def validate_record(r):
    if not isinstance(r, dict):
        return "not a dict"
    for k in REQUIRED:
        if k not in r:
            return f"missing field {k}"
    try:
        float(r["amount"])
    except (TypeError, ValueError):
        return "amount not numeric"
    return None
''',
    "fx.py": '''\
import json


def load_rates(path):
    rates = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rates[r["ts"]] = r["rate"]
    return rates


def apply_rates(records, path):
    """Attach amount_cny using the daily fx table."""
    rates = load_rates(path)
    out = []
    for r in records:
        rate = rates.get(r["ts"])
        if rate is None:
            continue  # no rate for this ts: skip for the CNY report
        out.append({**r, "amount_cny": round(float(r["amount"]) * rate, 2)})
    return out
''',
    "aggregate.py": '''\
def build_daily_summary(records):
    """One entry per (timestamp, region), sorted."""
    by_key = {}
    for r in records:
        key = (r["ts"], r["region"])
        by_key[key] = {"ts": r["ts"], "region": r["region"], "amount_cny": r["amount_cny"]}
    return [by_key[k] for k in sorted(by_key)]
''',
    "filters.py": '''\
def filter_positive(records):
    return [r for r in records if float(r["amount"]) >= 0]


def dedupe_by_region(records):
    seen = set()
    out = []
    for r in records:
        if r["region"] in seen:
            continue
        seen.add(r["region"])
        out.append(r)
    return out
''',
    "timezone.py": '''\
def to_utc(ts, offset_hours=8):
    """Convert a local ISO timestamp to UTC. Currently unused by the pipeline."""
    from datetime import datetime, timedelta
    dt = datetime.fromisoformat(ts)
    return (dt - timedelta(hours=offset_hours)).isoformat()
''',
    "output.py": '''\
def write_report(summary, path, max_lines=None):
    entries = summary if max_lines is None else summary[:max_lines]
    with open(path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(f"{e['ts']},{e['region']},{e['amount_cny']}\\n")
''',
    "data.jsonl": '''\
{"ts": "2026-09-22T09:00:00", "region": "cn-north", "amount": 120.5}
{"ts": "2026-09-22T10:05:00", "region": "cn-east", "amount": 88.0}
{"ts": "2026-09-22T10:05:00", "region": "cn-south", "amount": 64.5}
{"ts": "2026-09-22T10:30:00", "region": "us-west", "amount": 210.1}
{"ts": "2026-09-22T11:00:00", "region": "eu-central", "amount": 95.3}
{"ts": "2026-09-22T11:45:00", "region": "apac", "amount": 143.7}
{"ts": "2026-09-22T13:20:00", "region": "cn-north", "amount": 77.2}
{"ts": "2026-09-22T14:05:00", "region": "us-east", "amount": 302.9}
{"ts": "2026-09-22T16:40:00", "region": "cn-east", "amount": 55.6}
{"ts": "2026-09-22T17:10:00", "region": "apac", "amount": 121.4}
''',
    "rates.jsonl": '''\
{"ts": "2026-09-22T09:00:00", "rate": 7.12}
{"ts": "2026-09-22T10:05:00", "rate": 7.13}
{"ts": "2026-09-22T10:30:00", "rate": 7.14}
{"ts": "2026-09-22T11:00:00", "rate": 7.15}
{"ts": "2026-09-22T11:45:00", "rate": 7.16}
{"ts": "2026-09-22T13:20:00", "rate": 7.17}
{"ts": "2026-09-22T14:05:00 ", "rate": 7.18}
{"ts": "2026-09-22T16:40:00", "rate": 7.19}
{"ts": "2026-09-22T17:10:00", "rate": 7.20}
''',
    "NOTES.md": '''\
# Notes

- data.jsonl: 10 records, confirmed complete by the upstream team.
- rates.jsonl: 9 daily fx rates, covering every time slot of the day.
- report.txt must contain exactly 10 lines. Currently it only has 9.
''',
}

TASKS = [
    {
        "name": "debug-bug",
        "prompt": "sync_job.py 在高并发下 results 有时缺条目，请诊断原因并修复",
        "fixture": {"sync_job.py": BUGGY_SYNC_JOB},
    },
    {
        "name": "ambiguous-optimize",
        "prompt": "帮我把 sync_job.py 的输出优化一下",
        "fixture": {"sync_job.py": BUGGY_SYNC_JOB},
    },
    {
        "name": "multi-file-debug",
        "prompt": "这个项目的日报流水线每次生成的 report.txt 都只有 9 条，但 data.jsonl 里有 10 条记录，上游也确认没有丢数据。请找出丢记录的根本原因并修复，修好后运行 pipeline.py，report.txt 必须恰好有 10 条。",
        "fixture": LONG_APP_FILES,
    },
    {
        "name": "long-explore",
        "prompt": "这个项目的日报流水线每次生成的 report.txt 都只有 9 条，但 data.jsonl 有 10 条记录（上游确认完整），rates.jsonl 也有覆盖全天各时段的 9 条汇率。请找出丢记录的根本原因并修复，修好后运行 pipeline.py，report.txt 必须恰好有 10 条。",
        "fixture": LONG_APP_FILES_V2,
    },
]


def load_cfg():
    return json.loads(CFG_PATH.read_text(encoding="utf-8"))


def save_cfg(cfg):
    CFG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def count_debug_lines():
    if not DEBUG_LOG.exists():
        return 0
    return sum(1 for _ in DEBUG_LOG.open(encoding="utf-8"))


def session_totals(cwd: Path):
    """Sum usage over assistant messages in the newest session for this cwd."""
    marker = "--" + str(cwd).replace(":", "-").replace("\\", "-").replace("/", "-") + "--"
    cands = [f for f in glob.glob(str(SESSIONS / "*" / "*.jsonl")) if marker in f]
    if not cands:
        return None
    f = max(cands, key=os.path.getmtime)
    tot_in = tot_out = 0
    for line in open(f, encoding="utf-8"):
        e = json.loads(line)
        m = e.get("message", {})
        if e.get("type") == "message" and m.get("role") == "assistant":
            u = m.get("usage") or {}
            tot_in += u.get("input", 0) or 0
            tot_out += u.get("output", 0) or 0
    return {"input": tot_in, "output": tot_out}


def run_one(task, enabled):
    cfg = load_cfg()
    cfg["enabled"] = enabled
    save_cfg(cfg)

    run_dir = Path(tempfile.mkdtemp(prefix="pi-prior-bench-", dir=str(BENCH_ROOT)))
    for name, content in task["fixture"].items():
        p = run_dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    before = count_debug_lines()
    t0 = time.perf_counter()
    proc = subprocess.run(
        [PI, "-p", task["prompt"]],
        cwd=str(run_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    elapsed = time.perf_counter() - t0
    consults = count_debug_lines() - before
    usage = session_totals(run_dir) or {}

    return {
        "wall_s": round(elapsed, 1),
        "input": usage.get("input", 0),
        "output": usage.get("output", 0),
        "consults": consults,
        "answer_tail": (proc.stdout or "").strip().splitlines()[-1][:120] if proc.stdout else "",
    }


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--task", help="run a single task by name")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--runs", type=int, default=1, help="repeated runs per condition; reports mean ± stdev")
    args = ap.parse_args()

    BENCH_ROOT.mkdir(exist_ok=True)
    for old in BENCH_ROOT.iterdir():
        if old.is_dir():
            shutil.rmtree(old, ignore_errors=True)
    original = load_cfg()
    tasks = TASKS
    if args.task:
        tasks = [t for t in TASKS if t["name"] == args.task]
    elif args.quick:
        tasks = TASKS[:1]
    results = []
    try:
        for task in tasks:
            for enabled in (False, True):
                label = "prior=on " if enabled else "prior=off"
                for seed in range(1, args.runs + 1):
                    print(f"running: {task['name']} [{label} seed {seed}/{args.runs}] ...", flush=True)
                    r = run_one(task, enabled)
                    results.append((task["name"], label, seed, r))
                    print(f"  {r['wall_s']}s  in={r['input']} out={r['output']} consults={r['consults']}", flush=True)
    finally:
        save_cfg(original)
        print(f"(config restored: enabled={original.get('enabled')})")

    print("\n=== per-run results ===")
    print(f"{'task':<22}{'config':<9}{'seed':>5}{'wall_s':>8}{'in_tok':>9}{'out_tok':>9}{'consults':>9}")
    for name, label, seed, r in results:
        print(f"{name:<22}{label:<9}{seed:>5}{r['wall_s']:>8}{r['input']:>9}{r['output']:>9}{r['consults']:>9}")

    import statistics

    def agg(name, label, key):
        vals = [r[key] for n, l, s, r in results if n == name and l == label]
        if not vals:
            return None
        mean = statistics.mean(vals)
        stdev = statistics.stdev(vals) if len(vals) > 1 else 0.0
        return mean, stdev, len(vals)

    print("\n=== A/B summary (mean ± stdev over seeds) ===")
    print(f"{'task':<22}{'config':<9}{'wall_s':>16}{'in_tok':>18}{'out_tok':>16}{'consults':>12}")
    for name in {t["name"] for t in tasks}:
        for label in ("prior=off", "prior=on "):
            cells = []
            for key in ("wall_s", "input", "output", "consults"):
                a = agg(name, label, key)
                if a is None:
                    cells.append("-")
                else:
                    m, sd, n = a
                    fmt = ".1f" if key == "wall_s" else ".0f"
                    cells.append(f"{m:{fmt}} ± {sd:{fmt}} (n={n})")
            print(f"{name:<22}{label:<9}{cells[0]:>16}{cells[1]:>18}{cells[2]:>16}{cells[3]:>12}")
    for name in {t["name"] for t in tasks}:
        off = [r for n, l, s, r in results if n == name and l == "prior=off"]
        on = [r for n, l, s, r in results if n == name and l == "prior=on"]
        if off and on:
            import statistics as st
            d_wall = st.mean([r["wall_s"] for r in on]) - st.mean([r["wall_s"] for r in off])
            d_tok = (st.mean([r["input"] + r["output"] for r in on])
                     - st.mean([r["input"] + r["output"] for r in off]))
            print(f"{name}: mean prior overhead = {d_wall:+.1f}s wall, {d_tok:+.0f} tokens")


if __name__ == "__main__":
    main()
