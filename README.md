# Does a domain test kit help a coding agent find payment bugs?

Raw data for a small experiment run in October 2026 as part of MoneyInvariant, a research project on financial correctness testing. Ryan Sethi designed and directed the experiment. AI agents implemented the tooling, wrote the test suites and ran the scoring.

## The setup

One coding agent (Gemini 3.8 Flash, high reasoning) was asked three times, in three separate workspaces, to write a test suite for two small marketplace apps that take payments and refunds through Stripe and Razorpay. It was never told about any specific bug.

| Condition | What the agent was given |
|---|---|
| A | The brief only |
| B | The brief plus a 33 KB testing playbook (scenario families, money laws, documented provider behaviour) |
| C | The brief, the playbook, and the MoneyInvariant test kit (a provider simulator and financial assertion library) |

Each finished suite was then run against 150 automatically generated code mutations of the apps. A mutation counts as detected when at least one test that passed twice on the clean apps fails on the mutated app.

## The result

| | A: alone | B: playbook | C: playbook + kit |
|---|---|---|---|
| Mutations detected, all 150 | 24 | 17 | 15 |
| Detected only by this condition | 11 | 3 | 0 |
| Held out money bugs detected, of 31 | 13 | 7 | 7 |
| Tokens used to write the suite | 384,005 | 449,749 | 1,166,243 |

The first two rows can be recomputed from `results/` with `python3 scoring/summarise.py`. The held out split and the token counts come from the project's private records; see "What you cannot check yet".

The agent working alone did best. In the project's own analysis, the playbook steered the agent toward end to end scenarios with round amounts, while the unguided agent wrote randomised amount tests (see `suites/condition-a/tests/cross-cutting-money-invariants.test.ts`) and caught five rounding mutations that B and C missed. The test kit added no detections and roughly tripled the cost, because the agent spent its budget learning the kit's API.

## Limits

* One run per condition, one model. Differences of a few bugs could be noise.
* The apps, the mutations and the playbook were all built inside the same project.
* An earlier run with a different model and a different protocol (the kit was swapped into an existing suite rather than written from scratch) found the kit level with the playbook at 19 of 31. These are not comparable designs.

## What is here

* `results/`: raw scoring output for each condition, unedited. File paths inside refer to the original machine.
* `suites/condition-a|b|c/`: the three test suites exactly as the agent wrote them, with the brief, the playbook given to B and C, and the agent's own notes.
* `scoring/eval_suite.py`: the scoring harness. `scoring/summarise.py`: recomputes the table rows above.

## What you cannot check yet

To rerun from scratch you also need the two reference apps, the 150 mutation patches with their classification file, and the test kit package. These are not in this repository yet.

## Licence

Apache 2.0, see `LICENSE`.
