# Does a domain test kit help a coding agent find payment bugs?

Raw data for an experiment run in October 2026 and repeated in November 2026, as part of MoneyInvariant, a research project on financial correctness testing. Ryan Sethi designed and directed the experiment and the repeat. AI agents implemented the tooling, wrote the test suites, ran the scoring and drafted this file under his direction.

The write up is at https://ryansethi.com/record/moneyinvariant/

## The setup

A coding agent was asked, in separate workspaces, to write a test suite for two small marketplace apps that take payments and refunds through Stripe and Razorpay. It was never told about any specific bug.

| Setup | What the agent was given |
|---|---|
| A | The brief only |
| B | The brief plus a 33 KB testing playbook |
| C | The brief, the playbook, and the MoneyInvariant test kit (a provider simulator and financial assertion library) |

Each finished suite was run against 150 automatically generated code changes to the apps. A change counts as detected when at least one test that passed twice on the clean apps fails on the changed app. The main measure is the 31 held out money bugs among the 150.

## October: one run per setup, Gemini 3.8 Flash

| | A: alone | B: playbook | C: playbook and kit |
|---|---|---|---|
| Held out money bugs detected, of 31 | 13 | 7 | 7 |
| Changes detected, all 150 | 24 | 17 | 15 |
| Detected only by this setup | 11 | 3 | 0 |
| Tokens used to write the suite | 384,005 | 449,749 | 1,166,243 |

## November: three runs per setup, Claude Sonnet 5.5, plan fixed in advance

The plan, with the rules for reading the result, was committed before the first run: `repeat-2026-11/PREREGISTRATION.md`. Its amendments are dated.

| | A1 | A2 | A3 | B1 | B2 | B3 | C1 | C2 | C3 |
|---|---|---|---|---|---|---|---|---|---|
| Held out money bugs detected, of 31 | 14 | 14 | 12 | 18 | 11 | 13 | 13 | 7 | 12 |
| All money bugs detected, of 41 | 20 | 19 | 16 | 22 | 14 | 16 | 20 | 12 | 20 |
| Detected, of the 98 changes not labelled equivalent | 28 | 34 | 26 | 35 | 22 | 28 | 37 | 21 | 40 |
| Alarms on the 52 changes labelled equivalent | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| Tests passing on the clean apps | 99 | 240 | 104 | 84 | 152 | 149 | 175 | 140 | 288 |

Means on the main measure: A 13.3, B 14.0, C 10.7. By the rules fixed in advance, the kit did not help and the playbook did not help. One setup moved more between runs (B: 11 to 18) than the setups differ from each other, so the single October comparison could not have supported a conclusion about which setup is best.

Recompute with `python3 repeat-2026-11/scores/stats.py` after pointing its paths at this repository.

## Limits

* The apps, the code changes, the playbook and the kit were all built inside the same project.
* The brief for setup C describes the kit's interface wrongly. It names functions the kit does not have. This was found during the repeat and the brief was left unchanged so that all runs stay comparable. Every result for setup C is about the kit as it was handed to the agent.
* Isolation was by instruction, not by a sandbox. Six of the nine repeat agents planted bugs of their own in a scratch copy of the apps to check their tests. None had access to the 150 changes.
* Token counts and times come from the agents' session logs, which are not in this repository.
* The test kit's source code is not published.

## What is here

* `suites/condition-a|b|c/`: the three October suites exactly as the agent wrote them, with the brief, the playbook and the agent's notes.
* `results/`: raw October scoring output. `rescore-2026-11-14/`: the same suites scored again on a different machine in November (449 of 450 results identical).
* `repeat-2026-11/suites/A1` to `C3`: the nine November suites exactly as written, and `runs.log`, the log kept while they ran.
* `repeat-2026-11/scores/`: raw scoring output for all nine, the baselines, and the scripts that summarise them.
* `repeat-2026-11/PREREGISTRATION.md`: the plan and its amendments.
* `apps/`: the two reference apps.
* `mutations/`: the 150 code changes as patches, `corpus.json`, the labels in `classification.json`, and the generator.
* `scoring/eval_suite.py`: the scoring harness. `analysis/paired_test.py`: the paired test on the October results.

File paths inside result files refer to the machines the runs were made on.

## Licence

Apache 2.0, see `LICENSE`.
