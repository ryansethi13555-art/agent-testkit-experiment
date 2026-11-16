# Mutation benchmark tools (E0/E1, Revised Plan A)

Development evidence only, never blind evidence. These tools measure MoneyInvariant against frozen agent-written test suites on automatically generated defects. A defect is a generic mutation-testing operator applied to a reference app's money code. Only defects that survive the app's own conventional tests are kept.

| Tool | Purpose |
|---|---|
| `generate.mjs` | Enumerate mutants with the TypeScript compiler API. Operators: AOR, ROR, LCR, UOD, LIT, COND, SDL, STR, SQL. |
| `screen.mjs` | Run each app's own test suite on a seeded sample. Keep survivors and split them about 20% dev / 80% holdout by hash. |
| `run.mjs` | Resumable runner. It runs MoneyInvariant (`--profile ci`, both providers) from a **frozen** worktree (`E0_MI`) and the agent suites (via `eval_suite.py`). Results go to `E0_OUT`. |
| `summarize.mjs` | Per-mutant table for the dev split. **Aggregates only** for the holdout split. |

The corpus, patches and raw results live outside git (`~/.codex/revised-plan-a/e0`, `e1`). Keeping them out of the repository keeps the engineer blind to holdout specifics.
