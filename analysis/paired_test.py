#!/usr/bin/env python3
"""Paired comparison of the three conditions on the same 150 mutants.

For each pair of conditions it counts the mutants that exactly one of the two
detected, then runs an exact two sided sign test (exact McNemar test) on those
discordant counts. This answers one narrow question: given these three suites,
is the gap larger than the choice of mutants alone would explain? It says
nothing about how much a second run of the same agent would differ, because
each condition was run once.

usage: python3 paired_test.py
"""
import json, os
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")


def load(w):
    d = json.load(open(os.path.join(RES, f"ws-{w}-holdout.json")))
    return {k for k, v in d["cases"].items() if v["detected"]}


def sign_test(n1, n2):
    n, k = n1 + n2, min(n1, n2)
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


det = {w: load(w) for w in "abc"}
for x, y in (("a", "b"), ("a", "c"), ("b", "c")):
    only_x, only_y = len(det[x] - det[y]), len(det[y] - det[x])
    print(f"{x.upper()} vs {y.upper()}: only {x.upper()} {only_x:2d}, only {y.upper()} {only_y:2d}, "
          f"both {len(det[x] & det[y]):2d}, exact two sided p = {sign_test(only_x, only_y):.3f}")
