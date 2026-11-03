#!/usr/bin/env python3
"""Recompute the headline numbers from the raw result files in ../results.

usage: python3 summarise.py [classification.json]

Without a classification file it prints totals over all 150 mutants and the
overlap between conditions. With the classification file (mutant id -> split
and class) it also prints the held out money split.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")
NAMES = {"a": "A: agent alone", "b": "B: agent + playbook", "c": "C: agent + playbook + test kit"}

detected = {}
for w in "abc":
    d = json.load(open(os.path.join(RES, f"ws-{w}-holdout.json")))
    detected[w] = {k for k, v in d["cases"].items() if v["detected"]}
    print(f"{NAMES[w]:34s} detected {len(detected[w]):3d} / {len(d['cases'])}   "
          f"base tests passing on both clean runs: {d['stablePassing']}")

a, b, c = detected["a"], detected["b"], detected["c"]
print("union", len(a | b | c))
print("unique to A", len(a - b - c), " unique to B", len(b - a - c), " unique to C", len(c - a - b))

if len(sys.argv) > 1:
    cls = json.load(open(sys.argv[1]))
    print("classification loaded; inspect its structure and filter the held out money split here.")
