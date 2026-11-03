#!/usr/bin/env python3
"""E0 evaluation harness: generalisation of plan-b/eval_suite.py (detection logic unchanged).
Runs an AI-written test suite (workspace/tests/) against the base apps (twice) and against each mutant (patch applied
with `patch -p1` inside the app dir of a fresh copy). A case is DETECTED when at least one test that passed in both
base runs fails on the variant; the variant run is repeated once to report reproducibility.
The case list comes from a JSON corpus file ({"mutants": [{"id","app","patch",...}]}, patch relative to the corpus file).
usage: eval_suite.py <workspace> <corpus.json> <out.json> [--only id,id,...] [--base-only]
Resumable: cases already present in <out.json> are skipped (the base stable set is stored in the report).
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, time

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
WS, CORPUS, OUT = ARGS[0], ARGS[1], ARGS[2]
ONLY = None
for i, a in enumerate(sys.argv):
    if a == "--only":
        ONLY = set(sys.argv[i + 1].split(","))
BASE_ONLY = "--base-only" in sys.argv
NODE = "/home/ryan-sethi/.nvm/versions/node/v22.22.0/bin/node"
ENV = dict(os.environ, MI_PG_ADMIN_URL="postgres://postgres@127.0.0.1:5432/postgres")
APPDIR = {"inline": "inline-marketplace", "worker": "worker-marketplace"}


def cases():
    d = os.path.dirname(os.path.abspath(CORPUS))
    c = json.load(open(CORPUS))["mutants"]
    return [(m["id"], APPDIR[m["app"]], os.path.join(d, m["patch"])) for m in c if ONLY is None or m["id"] in ONLY]


def node_test_files(root):
    fs = []
    for f in glob.glob(os.path.join(root, "tests", "**", "*.ts"), recursive=True) + glob.glob(
            os.path.join(root, "tests", "**", "*.mjs"), recursive=True):
        src = open(f, errors="ignore").read()
        if (".nodetest." in f) or ("node:test" in src and "vitest" not in src):
            fs.append(os.path.relpath(f, root))
    return fs


class _P:  # minimal CompletedProcess stand-in
    def __init__(self, rc, out, err):
        self.returncode, self.stdout, self.stderr = rc, out, err


def sh(cmd, cwd, timeout):
    """subprocess.run(capture_output, text) in its own process group; on timeout kill the group (hung mutant)."""
    p = subprocess.Popen(cmd, cwd=cwd, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return _P(p.returncode, out, err), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, 9)
        except Exception:
            pass
        out, err = p.communicate()
        return _P(-9, out or "", err or ""), True


def run_suite(root):
    """Return (dict test->status, seconds, raw-tail)."""
    t0 = time.time(); res = {}; tail = ""
    rj = os.path.join(root, "vitest-result.json")
    p, to1 = sh([NODE, "node_modules/vitest/vitest.mjs", "run", "--configLoader", "native", "tests/",
                 "--reporter=json", f"--outputFile={rj}"], root, 900)
    if to1:
        tail += "TIMEOUT(vitest) "
    tail += p.stdout[-1500:] + p.stderr[-1500:]
    if os.path.exists(rj):
        d = json.load(open(rj))
        for tr in d.get("testResults", []):
            fn = os.path.relpath(tr["name"], root)
            for a in tr.get("assertionResults", []):
                res[f"{fn} :: {a['fullName']}"] = a["status"]
            if not tr.get("assertionResults"):
                res[f"{fn} :: <file>"] = "failed" if tr.get("status") == "failed" else tr.get("status", "unknown")
    for f in node_test_files(root):
        q, to2 = sh([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", f], root, 900)
        if to2:
            tail += "TIMEOUT(node-test) "
        tail += q.stdout[-800:]
        for line in q.stdout.splitlines():
            m = re.match(r"\s*(not ok|ok) \d+ - (.*)", line)
            if m and "# SKIP" not in line:
                res[f"{f} :: {m.group(2).strip()}"] = "passed" if m.group(1) == "ok" else "failed"
        if q.returncode != 0 and not any(k.startswith(f) and v == "failed" for k, v in res.items()):
            res[f"{f} :: <file>"] = "failed"
    return res, round(time.time() - t0, 1), tail


def fresh_copy(patch=None, app=None):
    d = tempfile.mkdtemp(prefix="pb-", dir=os.path.dirname(os.path.abspath(OUT)))
    dst = os.path.join(d, "ws")
    shutil.copytree(WS, dst, symlinks=True, ignore=shutil.ignore_patterns("vitest-result.json"))
    if patch:
        r = subprocess.run(["patch", "-p1", "--silent", "--forward", "-i", patch], cwd=os.path.join(dst, app))
        if r.returncode != 0:
            raise RuntimeError(f"patch failed: {patch}")
    return d, dst


if os.path.exists(OUT):
    report = json.load(open(OUT))
else:
    report = {"workspace": WS, "corpus": CORPUS, "base": [], "cases": {}}
if "stable" not in report:
    base_runs = []
    report["base"] = []
    for i in range(2):
        d, w = fresh_copy(); r, s, tail = run_suite(w); shutil.rmtree(d)
        base_runs.append(r)
        report["base"].append({"seconds": s, "tests": len(r), "failed": sorted(k for k, v in r.items() if v != "passed")[:20]})
    stable = {k for k in base_runs[0] if base_runs[0].get(k) == "passed" and base_runs[1].get(k) == "passed"}
    report["stable"] = sorted(stable)
    report["stablePassing"] = len(stable)
    report["baseFlaky"] = sorted(k for k in set(base_runs[0]) | set(base_runs[1]) if k not in stable)[:30]
    json.dump(report, open(OUT, "w"), indent=1)
stable = set(report["stable"])
print("base: stable", len(stable), "flaky", len(report["baseFlaky"]), flush=True)
for cid, app, patch in ([] if BASE_ONLY else cases()):
    if cid in report["cases"]:
        continue
    runs = []
    for rep in range(2):
        d, w = fresh_copy(patch, app); r, s, tail = run_suite(w); shutil.rmtree(d)
        failing = sorted(k for k in stable if r.get(k) != "passed")
        runs.append({"seconds": s, "failingStable": failing, "timedOut": "TIMEOUT(" in tail})
        if rep == 0 and not failing:
            break
    det = bool(runs[0]["failingStable"])
    report["cases"][cid] = {"app": app, "detected": det,
                            "reproduced": sum(1 for x in runs if x["failingStable"]) if det else 0,
                            "runs": runs}
    print(cid, app, "DETECTED" if det else "missed", [len(x["failingStable"]) for x in runs], flush=True)
    json.dump(report, open(OUT, "w"), indent=1)
report["detectedCases"] = sum(1 for v in report["cases"].values() if v["detected"])
json.dump(report, open(OUT, "w"), indent=1)
print("DONE detected", report["detectedCases"], "of", len(report["cases"]), "| stable tests", len(stable))
