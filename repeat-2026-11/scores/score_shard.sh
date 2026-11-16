#!/usr/bin/env bash
# usage: score_shard.sh RUN K N   scores the mutants whose position in corpus.json is K modulo N.
# All shards of one run share the baseline in out/RUN.base.json, so the stable test set is the same.
set -euo pipefail
RUN="$1"; K="$2"; N="$3"; D=/home/claude/rep/score; cd "$D"
BASE="out/$RUN.base.json"; OUT="out/$RUN.s${K}of${N}.json"
if [ ! -f "$BASE" ]; then python3 eval_suite.py "/home/claude/rep/$RUN" corpus/corpus.json "$BASE" --base-only; fi
python3 - "$BASE" <<'P'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("stablePassing",0)>0, "baseline has no passing tests: refusing to score"
print("baseline stable tests:",d["stablePassing"],"flaky:",len(d["baseFlaky"]))
P
[ -f "$OUT" ] || cp "$BASE" "$OUT"
ONLY=$(python3 -c "
import json,sys
m=json.load(open('corpus/corpus.json'))['mutants']
print(','.join(x['id'] for i,x in enumerate(m) if i%int(sys.argv[2])==int(sys.argv[1])))" "$K" "$N")
NODE_BIN=node python3 eval_suite.py "/home/claude/rep/$RUN" corpus/corpus.json "$OUT" --only "$ONLY"
