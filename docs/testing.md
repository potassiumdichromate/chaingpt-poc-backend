# Testing

Three layers, each proving something different:

| Layer | Command | Needs a key | Proves |
|---|---|---|---|
| Unit + integration | `npm test` | no | Logic, parsing, mappers, failure handling, the memory loop |
| Live API contract | `npm run smoke` | **yes** | ChainGPT auth, response shapes, credits, JSON obedience |
| End-to-end readiness | `npm run verify` | optional | The full P0 flow, every Definition-of-Done line |

Plus `npm run typecheck`, which covers `src/` **and** `scripts/` (the build config
compiles only `src/`, so scripts would otherwise go unchecked).

---

## 1. `npm test` — 128 tests, 7 files

Vitest, node environment. Configured in `vitest.config.ts`:

```ts
env: { DATA_DIR: './data-test', INTELLIGENCE_PROVIDER: 'demo' },
fileParallelism: false,
```

`DATA_DIR` is redirected so tests never touch showcase data. `fileParallelism` is off
because the store is a single shared file and parallel files would race on it. Keep both
if you add tests.

Current state: **128 passing, 7 files, ~9s**.

### `parser.test.ts` — 29 tests

The defensive parsing pipeline. `extractText` across all nine response shapes,
`stripMarkdown`, `extractFirstJsonObject` (including braces inside string literals and
escapes), `parseStructured` end to end, and two dedicated blocks for observed live model
deviations: bare objects where a wrapper was required, word-grade relevance, and nested
objects returned as sentences.

### `failures.test.ts` — 30 tests

The failure matrix. Categorization of every error shape, `withRetry` behaviour (retries
`429`/`5xx`/timeout once, never retries `auth`/`insufficient_credits`), `withTimeout`,
malformed output handling, the `TtlCache`, and two blocks that exist purely as
regressions: **live ChainGPT regressions** and **SDK error classification (status hidden
in the message)**.

### `kultMappers.test.ts` — 40 tests

The largest file, because live KULT data is the messiest input. `gameToProject` and
`creatorToAgent` on both fixture-shaped and live-shaped records, `toText` across every
observed field shape (string, array, keyed map), `parseCreatorPrompt` on markdown design
docs, `creatorDisplayName` on null usernames and DIDs, and `threadUuid` determinism.

### `memory.test.ts` — 6 tests

`selectRelevantKnowledge` — keyword overlap, recency decay, the top-5 limit, and
per-agent isolation.

### `memoryLoop.integration.test.ts` — 5 tests

**The P0 test.** The full loop against the demo provider: scan with no memory → save →
rescan → assert exactly one memory-badged card, assert the cited ids were genuinely
injected, assert `repeat_intelligence_scan` and `memory_influenced_result` were emitted.

This is the test to run first if you change anything in `engine.ts`, `memory.ts` or
`prompts.ts`.

### `normalizeNews.test.ts` — 7 tests

All five container shapes, `pubDate` preferred over `createdAt`, HTML stripping,
`url` staying `undefined` (never invented), and rows without a real title being dropped.

### `analytics.security.test.ts` — 12 tests

The event logger, plus an explicit security block asserting that **secrets never leave
the server**: no API key in any response body, no raw provider error text crossing the
HTTP boundary.

---

## 2. `npm run smoke` — live API verification

Requires `CHAINGPT_API_KEY`. Exits `1` immediately if it is missing.

Checks, in order:

1. **Credits first.** An empty balance stops the run with one clear "top up" message
   instead of a wall of downstream failures.
2. **Auth** and the News response shape, run through the real `normalizeNews`.
3. **The buffered `data.bot` answer path**, run through the real `extractText`.
4. **`useCustomContext`** — whether the AI Hub context is configured and took effect.
5. **JSON obedience** — whether the model reliably honours a pure-JSON instruction,
   validated against `opportunitySetSchema`.

Run it with the real key before any showcase. Field names and credits are only
observable against a live account — every finding in
[chaingpt-integration.md](chaingpt-integration.md) came from this script.

## 3. `npm run verify` — showcase readiness

Runs the exact P0 sequence against whatever provider is configured:

```
scan -> research -> save -> rescan -> memory influence -> growth -> history
```

Every assertion maps to a Definition-of-Done line. It aborts with a clear message on
credit exhaustion rather than cascading failures.

It passes on the demo provider with real KULT context. Point it at ChainGPT with credits
and a green run means the showcase is proven end to end.

## 4. `npm run seed:kult`

Not a test, but a prerequisite for the `poc_db` context path. Copies real published KULT
games into the POC's own database through the **public HTTP API** — deliberately, so it
never opens a connection to the production database and cannot trigger the 0G write side
effects some KULT read paths have. Run once; afterwards the POC is standalone.

---

## 5. Writing new tests

**Use the demo provider.** It returns the same `{ data: { bot: "<json>" } }` envelope as
ChainGPT, so the full parsing pipeline runs identically. It also reads the prompt to
detect whether memory reached the model, which is what makes it a legitimate double for
the memory loop.

**Reset the store between suites** that assert on counts — the store is shared and
`fileParallelism` is off, so state carries across files in a run.

**Every live-API finding gets a regression test.** If you discover new behaviour against
the real API, add the test in the same commit as the fix and mark the constant with a
`VERIFIED LIVE` comment saying what was observed.

**Do not test against the network.** Unit tests must stay runnable with no key and no
KULT backend. Live verification belongs in `smoke` and `verify`.

---

## 6. Gaps

Honest list of what is not covered:

- **No HTTP-layer tests.** Routes, status-code mapping, the error envelope and CORS are
  exercised only by hand. This is how the validation-error defect
  ([audit.md](audit.md) A-2) survived — a single supertest asserting `400` on an invalid
  body would have caught it.
- **No frontend tests at all.** No component tests, no integration tests, no type test
  asserting the client types match the server envelopes.
- **No store-driver tests for the mongo path.** Only the file driver is exercised.
- **No concurrency tests** on `db.mutate` under parallel writes.
- **No load or cost tests** — credit spend per flow is estimated, not measured.
