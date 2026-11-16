# Preregistration: repeat of the agent test kit experiment with a second model

Written on 14 November 2026, before any of the runs below were started. Ryan Sethi decided to run this repeat and chose its size (nine runs). AI agents wrote this plan under his direction and will carry it out. After the first run starts this file is append only: any change is a dated amendment with a reason.

## Why

The October 2026 experiment ran each setup once, on one model (Gemini 3.8 Flash, high reasoning). One run per setup cannot show how much a result moves between runs. This repeat uses a second model and three runs per setup.

## Questions

1. Does the test kit (setup C) catch more bugs than the playbook alone (setup B)?
2. Does the playbook (setup B) catch more bugs than no help (setup A)?
3. How much does the score of one setup move between runs?
4. What does each setup cost in tokens, tool calls and time?

## Design

* **Model:** Claude Sonnet 5.5, run as a Claude Code subagent. The model identifier that the harness reports for each run is recorded with the run.
* **Setups:** the same three as October, with the same three brief files, byte for byte (`suites/condition-a|b|c/TESTER_BRIEF.md`), the same playbook, and the same two apps.
  * A: brief only.
  * B: brief plus `PLAYBOOK.md`.
  * C: brief plus `PLAYBOOK.md` plus the MoneyInvariant test kit installed in `node_modules`.
* **Runs:** three per setup, nine in total, labelled A1 to A3, B1 to B3, C1 to C3. They run in three rounds. Each round runs one A, one B and one C at the same time, as in October.
* **Prompt:** every run gets the same short instruction: read `TESTER_BRIEF.md` in the workspace and do what it says. Nothing else differs between runs except the workspace path.
* **Budget:** as stated in the brief (about 90 minutes of work, at most about 70 tool calls). It is an instruction to the agent and is not enforced by the harness, as in October.
* **Workspace at start:** the two apps with their own tests, `TESTER_BRIEF.md`, `RUN.md`, `package.json`, `vitest.config.mjs`, installed dependencies, and for B and C the playbook. No `tests/` folder.

## Scoring

The October harness, unchanged (`scoring/eval_suite.py`), against the same 150 mutants (`corpus.json`, SHA 256 `6a180da3...9672`) with the same labels (`classification.json`, SHA 256 `c98a047f...032a`). A mutant is detected when at least one test that passed twice on the unmodified apps fails on the mutated app.

* **Primary measure:** detections among the 31 held out money mutants.
* **Secondary measures:** detections among all 41 money mutants, among all 98 mutants that are not labelled equivalent, false alarms on the 52 equivalent mutants, tests passing on the unmodified apps, tokens, tool calls and wall time as reported by the harness.

For each setup the report gives all three scores, their mean and their range. No run is dropped and no best of three is reported.

## How the result will be read

These rules are fixed now so the reading cannot be bent to fit the numbers.

* **"The kit helped"** if the mean of C on the primary measure is at least 3 higher than the mean of B, and at least two of the three C runs score above the best B run.
* **"The kit did not help"** if the mean of C is no more than 1 above the mean of B.
* **Anything between is "unclear"** and will be reported as unclear.
* The same three rules apply to the playbook, comparing B with A.
* If the three runs of one setup differ from each other by more than the gap between setups, the report will say that the October single run comparison could not have supported its conclusion, whatever the means are.

## Rules for reruns

A run is repeated only if the harness itself fails before the agent finishes (for example the session is cut off or the database is down), and the failure is logged. A suite with failing or flaky tests is scored as it stands; the harness already ignores tests that do not pass twice on the unmodified apps. A weak suite is a result, not a failure.

## Differences from October that a reader should know

* The agent harness is different (Claude Code subagent, not Google Antigravity), so token and tool call counts are not directly comparable across the two models.
* The 31 held out mutants were secret in October. They have since been disclosed to the people and agents running this project. The agents that write the tests are not shown them, and each finished suite is searched for mutant identifiers and for copied October test names.
* Isolation is by instruction. The brief tells the agent to stay inside its workspace, as in October, but the agent is not sandboxed away from the rest of the machine. Each agent's final report and suite are checked for signs it left the workspace.
* The agent that starts the runs and scores them has seen the mutants. It writes no tests and sends every run the same instruction.
* The test kit is built from the project's main branch at commit `8a03251e3` (14 October 2026). The exact October kit build was not preserved.
* The scoring machine is different. The October suites are being rescored on this machine first, to confirm the harness gives the same answers here.
* The apps, mutants, playbook and kit were all built inside the same project. This repeat does not change that.

## What will be published

This file, the nine suites exactly as written, the agents' own notes, the raw scoring output for all nine, and a summary table, whether or not the result favours the kit.

## Amendment 1, 14 November 2026, 12:20 UTC

Written after the three round 1 suites (A1, B1, C1) were finished and before any of them was scored.

**What was found.** The agent in run C1 reported that the brief for setup C describes the test kit's interface wrongly. This was checked against the kit's source and it is correct. The brief says `createProviderTwin({ provider })`, `twin.url`, `twin.signStripeWebhook`, `twin.signRazorpayWebhook`, `twin.gate.next(...)` and `assertFinancialCorrectness({ pgUrl, twin, appId })`. The kit actually takes `createProviderTwin({ dialect, secrets })`, offers `injectFault` in place of `gate.next`, has no `url` or signing members under those names, and `assertFinancialCorrectness` requires `bindings` and `invariants`. The kit itself is installed and exported correctly in the workspace; the October suite for setup C runs against it and passes.

**Why it matters.** The brief is byte for byte the October brief, so the October agent was given the same wrong description. Setup C has therefore always been "playbook plus kit plus an inaccurate description of the kit". Any result for setup C, in October or here, is a result about the kit as it was handed over, not about the kit with correct instructions.

**What changes.** Nothing in the design. Rounds 2 and 3 use the same briefs, unchanged, so that all nine runs and the October run stay comparable and so that the brief is not altered after seeing a run. C1 is not a harness failure under the rerun rule and is scored as it stands.

**What is added to the report.** For each C run: whether the suite calls the kit's `createProviderTwin` and `assertFinancialCorrectness`, or builds on lower level parts of the kit, or uses none of it. The write up will state this flaw as a limit on every claim about the kit.

**Other observations from round 1, recorded before scoring.**

* All three suites passed the checks promised above: no mutant identifiers, no October test names, no paths outside the workspace, app source and existing tests unchanged.
* The agent in run A1 reported that it made its own mutated copies of the app source in a temporary directory outside the workspace to check its suite, then deleted them. It had no access to the experiment's mutants, but this breaks the brief's rule to work only inside the workspace, and the other two agents did not do it (C1 said it declined because of the rules). A1 is kept and scored, and this is reported next to its score.
* Suite C1 takes about 6.5 minutes per run, against about 38 seconds for A1 and 6 seconds for B1. Scoring it against 150 mutants one at a time would take over 16 hours. The mutants will be split across parallel scoring processes that share one pair of baseline runs. The detection rule is unchanged.
* Scoring of all nine suites starts only after all nine are written, so that every round is written on an otherwise idle machine.

*Correction, 12:21 UTC: the heading of this amendment first gave its time as 12:25 UTC, which was an estimate. The commit that recorded it is stamped 12:20:37 UTC, and the heading now says so. Nothing else was changed.*

## Amendment 2, 14 November 2026, 15:17 UTC

Written before any suite from the repeat was scored.

**Round 2 was cut off by the harness and is started again from fresh.** The three round 2 agents (A2, B2, C2) were started at 12:20 UTC and stopped within minutes when the account reached its usage limit (HTTP 429, limit reset at 15:10 UTC). The machine was also restarted. The three workspaces were compared with the template and are identical to it: no file was written. Under the rerun rule above this is a harness failure before the agent finished. The same workspaces are reused and the runs keep the labels A2, B2 and C2. The cut off agents are not resumed, so that each scored suite comes from one uninterrupted run with one token count.

**Timing of the remaining rounds.** Rounds 2 and 3 are started right after a usage limit reset, at night in India, so that a run is less likely to be cut off part way and so that the runs do not block other work on the account. If a run is cut off after it has written anything, that will be logged and reported, and its workspace reset from the template before it is run again.

**Scoring logistics, replacing the last bullet of amendment 1.** Scoring is machine time only and no longer waits for all nine suites. It runs only while no agent is writing a suite, and is paused before each round starts, so every suite is still written on an otherwise idle machine. The harness resumes where it stopped. At most two scoring processes run at once, for every suite, which is the load under which the October suites were rescored on this machine.

**One added secondary measure.** Some tests depend on timing and can fail by chance when the machine is busy, which the harness would count as a detection. The harness already retries each detection once. The report will give, next to each detection count, how many were reproduced on that retry. The primary measure and the reading rules are unchanged and use the harness's own detection count.

## Amendment 3, 14 November 2026, 20:47 UTC

Written after the three round 2 suites (A2, B2, C2) were finished and before any of them was scored. Nothing in the design changes.

**Round 2 ran clean.** It was started at 20:30 UTC on an idle machine and each agent finished in one uninterrupted run. Tests written: A2 242, B2 153, C2 140. All three passed the leak checks: no mutant identifiers and app source identical to the template.

**All three round 2 agents checked their suites against bugs they planted themselves.** Each reported making its own broken copies of the app source in a scratch directory outside the workspace (A2 16, B2 33, C2 9) and adding tests where a planted bug survived. None had access to the experiment's mutants. In round 1 only A1 did this. It breaks the brief's rule to work only inside the workspace, and it may raise a run's score, so the report will state for every run whether the agent did it. No run is dropped.

**The kit was used differently in C2 than in C1.** The C2 suite calls the kit's `createProviderTwin` and `assertFinancialCorrectness` with their real interface, which the agent found by reading the kit after noticing that the brief's description was wrong. C1 built on lower level parts of the kit. This is the per run kit usage that amendment 1 said would be reported.

## Amendment 4, 15 November 2026, 15:50 UTC

Written after the three round 3 suites (A3, B3, C3) were finished and before any of them was scored. Nothing in the design changes.

**Round 3 ran earlier than planned.** It was set for 20:30 UTC on 15 November. Ryan Sethi asked for it to start at once, and it started at 15:12 UTC on an idle machine with no scoring running. Each agent finished in one uninterrupted run. Tests written: A3 104, B3 149, C3 288. All three passed the leak checks: no mutant identifiers, app source identical to the template, only a tests folder added.

**Self made bugs.** A3 and B3 reported checking their suites against bugs they planted in scratch copies of the app source outside the workspace (B3 27; A3 gave no count). C3 reported that it did not. This is reported per run as amendment 3 said.

**Kit usage in C3.** Like C1, the C3 suite builds on lower level parts of the kit (the simulator server and world) and writes its own money checks. It does not call `createProviderTwin` or `assertFinancialCorrectness`. Its notes say the kit did not match the brief's description.

**Scores for rounds 1 and 2 were known when this was written.** Held out money mutants caught, of 31: A1 14, A2 14, B1 18, B2 11, C1 13, C2 7. The reading rules fixed before the first run are unchanged.
