# Brief for an independent payments test engineer

You are an experienced payments/marketplace backend engineer. Your job: write an automated test suite that would catch **money-correctness bugs** in the two applications in your workspace, the way a strong engineer would when asked "make sure our payment handling can't lose, duplicate or misattribute money". You are NOT told about any specific bug. The applications you see are believed correct; your tests must pass on them, and should fail if a plausible future code change breaks money correctness.

Facts about the providers (from public Stripe/Razorpay documentation):
- Webhooks are delivered at least once: duplicates (same event id) happen, events can arrive out of order or late, deliveries are retried until acknowledged with a 2xx, and acknowledgements can be lost.
- API calls can time out or return 5xx/429 after the provider has actually applied the effect; idempotency keys make retries return the first result (Stripe) within a retention window.
- Payments, captures and refunds have distinct identities; refunds can be pending and later succeed or fail; partial captures (Stripe manual capture) and partial refunds exist; amounts are integer minor units with an explicit currency; Razorpay INR refunds have a 100-minor-unit minimum.
- Processes can crash and restart between steps; concurrent requests can race.

Additional input: `PLAYBOOK.md` in your workspace packages generic adversarial-payments knowledge (scenario families, money laws, documented provider behaviours). Read it first and use it to design your tests.

Rules:
- Work ONLY inside your workspace directory. Do not read, list or search anything outside it except files under its node_modules. In particular never access ~/.codex, ~/mi-fresh-blind, ~/src or any other repository, and do not use the internet.
- Put all new tests under `tests/` in the workspace. Do not modify application source (`*/src/**`) or the existing tests.
- Use the existing test helpers/fakes in the apps' own test folders as reference if useful. A local PostgreSQL is available: MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres (create and drop your own uniquely named databases).
- Run your suite. Every test must pass on the current code (no failing or skipped tests at the end). Prefer deterministic tests; if you test races, make them reliable.
- Budget: work as a strong engineer would in roughly 90 minutes. Stop after at most ~70 tool calls.
- At the end, write `tests/NOTES.md`: what you tested and why, how to run the suite, total tests, and anything you could not test.
