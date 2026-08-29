# Full-stack audit

A read of the complete backend (`src/`, `scripts/`, ~2,400 lines excluding tests) and
the complete frontend (`frontend/src/`, ~1,980 lines), plus live probing of the running
service.

**Baseline at time of audit:** 128/128 tests pass, `tsc --noEmit` clean across `src/`
and `scripts/`, the server boots and serves `/health` on the compiled output.

Findings are ranked by what they would cost in practice. Each carries a reproduction so
it can be re-checked, and a fix. Nothing here is speculative — every "confirmed" finding
was reproduced against the running service.

---

## Severity summary

| ID | Severity | Finding | Confirmed |
|---|---|---|---|
| [A-1](#a-1) | **High** | No auth or rate limiting; unauthenticated destructive reset and credit-spending endpoints | yes |
| [A-2](#a-2) | **Medium-High** | Invalid request bodies return `502`, not `400` | yes, live |
| [A-3](#a-3) | **Medium-High** | `CHAINGPT_USE_CUSTOM_CONTEXT` code default is `true`; docs say `false` | yes, live |
| [A-4](#a-4) | **Medium** | File store on an ephemeral filesystem silently deletes the memory loop | yes |
| [A-5](#a-5) | **Medium** | `REASONING_TIMEOUT_MS` code default `90000` vs documented `75000` | yes, live |
| [A-6](#a-6) | **Medium** | `.env.example` ships `KULT_API_BASE=http://localhost:3001/api` | yes |
| [A-7](#a-7) | **Low-Medium** | Store design permits exactly one instance; scaling loses data silently | yes |
| [A-8](#a-8) | **Low-Medium** | Unbounded store growth against a 16 MB single-document ceiling | yes |
| [A-9](#a-9) | **Low-Medium** | Frontend swallows action/outcome errors silently | yes |
| [A-10](#a-10) | **Low-Medium** | Frontend accessibility gaps | yes |
| [A-11](#a-11) | **Low** | `POST /actions` and `/outcomes` do not verify the Agent exists | yes |
| [A-12](#a-12) | **Low** | `memoryEnforcementSchema` accepts indices the engine never produces | yes |
| [A-13](#a-13) | **Low** | Router double-mount creates undocumented duplicate paths | yes, live |
| [A-14](#a-14) | **Low** | `LOG_LEVEL=debug` writes raw model output to logs | yes |
| [A-15](#a-15) | **Low** | No HTTP-layer test coverage | yes |

---

## <a id="a-1"></a>A-1 — No authentication or rate limiting · **High**

Every endpoint is open. The service is now deployed, which turns a documented POC
limitation into an active exposure.

**Impact, concretely:**

- `POST /api/intelligence/reset` **deletes all accumulated knowledge, runs, actions,
  outcomes and events** — unauthenticated, from anywhere, at two paths.
- `POST /api/agents/:id/opportunities`, `/research`, and `/api/projects/:id/grow` each
  **spend ChainGPT credits** on every call, with no rate limit. A trivial loop drains the
  balance and takes the showcase offline.
- `GET /api/internal/intelligence/metrics` exposes internal instrumentation.
- `GET /api/agents` and `GET /api/projects` enumerate real KULT creators and published
  games.

**Reproduce**

```bash
curl -X POST https://<host>/api/internal/intelligence/reset
# {"ok":true,"message":"Accumulated intelligence cleared. Agents and projects kept."}
```

**Fix.** Shortest path that closes the real damage:

1. Gate `/api/intelligence/reset` behind a shared secret header, or drop it in
   production and reset from a script.
2. Add `express-rate-limit` to the three provider-spending routes — a low per-IP
   ceiling is enough, since a real showcase makes a handful of calls.
3. Longer term, put the whole service behind KULT's auth and scope Agent routes to the
   authenticated identity.

---

## <a id="a-2"></a>A-2 — Invalid request bodies return `502` · **Medium-High**

`asyncRoute` catches every throw, including the `ZodError` from body validation, and
funnels it into `sendIntelligenceError`. `categorize()` has no `ZodError` branch, so a
caller's malformed body is classified `unknown` → **HTTP 502**, "Intelligence is
temporarily unavailable. Try again.", `retryable: true`.

The `ZodError` handler at `src/index.ts:36` — which does the right thing, returning
`400` with the issues — is unreachable for every async route, which is all of them.

The client is therefore told a *server* failed and invited to retry a request that can
never succeed.

**Reproduce** (confirmed against the running service):

```bash
curl -i -X POST localhost:8787/api/agents/agent_kult_nova/research \
  -H 'content-type: application/json' -d '{}'
# HTTP/1.1 502 Bad Gateway
# {"error":{"category":"unknown","message":"Intelligence is temporarily unavailable. Try again.","retryable":true}}
```

**Fix.** Handle it at the funnel, in `src/routes/helpers.ts`:

```ts
export function asyncRoute(fn, label) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      if (res.headersSent) return;
      if (err instanceof ZodError) {
        return res.status(400).json({ error: { category: 'invalid_request', message: 'Invalid request body', issues: err.issues, retryable: false } });
      }
      await sendIntelligenceError(res, err, { /* ... */ });
    }
  };
}
```

Then add a `400`/`invalid_request` row to the client's error matrix. A single
supertest asserting `400` on an invalid body would have caught this — see [A-15](#a-15).

---

## <a id="a-3"></a>A-3 — `CHAINGPT_USE_CUSTOM_CONTEXT` default mismatch · **Medium-High**

```ts
// src/config.ts:40
useCustomContext: bool('CHAINGPT_USE_CUSTOM_CONTEXT', true),
```

```bash
# .env.example:31
CHAINGPT_USE_CUSTOM_CONTEXT=false
```

The code default is `true`; `.env.example` and the project README both document `false`,
with an explicit warning that enabling it before the AI Hub is configured makes ChainGPT
assert *"KULT is a cryptocurrency built on blockchain technology"* — a wrong prior that
poisons every recommendation.

Local development is safe because `.env` is copied from `.env.example`. Any environment
configured through a dashboard or CI — including the current deployment — runs with the
flag **on** unless someone sets it explicitly.

**Reproduce** (confirmed live, no env var set):

```bash
curl -s localhost:8787/api/internal/intelligence/health | grep useCustomContext
# "useCustomContext":true
```

**Fix.** Flip the code default to `false` so it agrees with the documentation, and set
the variable explicitly in every deployed environment. The safe default should be the
documented one.

---

## <a id="a-4"></a>A-4 — File store on an ephemeral filesystem · **Medium**

With no `MONGODB_URI`, the store is `${DATA_DIR}/store.json`. On a container platform
without a mounted volume, that file is wiped on every restart and every deploy.

What is lost is knowledge, runs, actions, outcomes and events — i.e. **the memory loop**.
The demo's central claim ("intelligence compounds") silently stops being demonstrable,
and the failure looks like a first-ever scan rather than an error.

**Reproduce.** Save research, restart the container, rescan: `isRepeatScan` is `false`
and no memory badge appears.

**Fix.** Set `MONGODB_URI` (plus a POC-only `MONGODB_DB_NAME`) on any deployment that
will be demoed more than once, or mount a persistent volume at `DATA_DIR`. Consider
logging a warning at boot when the driver is `file` and `NODE_ENV=production`.

---

## <a id="a-5"></a>A-5 — `REASONING_TIMEOUT_MS` default mismatch · **Medium**

`src/config.ts` defaults to `90_000`. `.env.example` says `75000`, and the README
explains why: ChainGPT's gateway 504s at ~80s, so a 90s client deadline waits 10s past
the point where the request is already dead.

**Reproduce** (confirmed live, no env var set):

```bash
curl -s localhost:8787/api/internal/intelligence/health | grep timeouts
# "timeouts":{"news":20000,"reasoning":90000}
```

**Fix.** Change the code default to `75_000`, and set it explicitly in deployment.
Note that on the `sdk` transport this is advisory anyway — the SDK's internal 60s axios
cap fires first.

---

## <a id="a-6"></a>A-6 — `.env.example` ships a localhost KULT base · **Medium**

```bash
KULT_API_BASE=http://localhost:3001/api
```

Copied verbatim into a deployed environment, `kultConfigured()` returns true and every
Agent/project read attempts the live KULT path first. Against `localhost` on a remote
host that fails fast with `ECONNREFUSED`, so the cost is log noise and a wasted round
trip per request — but `pageCatalog()` **only caches a non-empty catalog**, so the
attempt repeats on every single request rather than being suppressed for the TTL.

Against a hostname that blackholes rather than refuses, the same path costs up to
6 pages × 45s before falling back.

**Fix.** Ship `KULT_API_BASE=` (blank) in `.env.example` with the localhost value in a
comment, and leave it blank in every environment where KULT is not actually reachable.

---

## <a id="a-7"></a>A-7 — Single instance only · **Low-Medium**

`db.read()` serves the entire store from process memory and `persist()` writes it back
wholesale. Two instances would each hold a divergent copy, and every write would
overwrite the other's — last write wins, silently.

The current deployment is fine (one instance), but nothing in the code or config
*prevents* someone scaling it.

**Fix.** Document it as a hard constraint (done — see
[operations.md](operations.md)), pin `WEB_CONCURRENCY=1`, and treat per-record
persistence as a prerequisite for any horizontal scaling.

---

## <a id="a-8"></a>A-8 — Unbounded store growth · **Low-Medium**

`events`, `runs`, `knowledge`, `actions` and `outcomes` are append-only. On the mongo
driver the whole store is **one document**, subject to MongoDB's 16 MB BSON limit. Each
run stores its full `result` payload, and each knowledge item stores an opaque
`payload` that the client fills with the entire opportunity + research object.

At demo volumes this is a non-issue. At sustained use, writes begin to fail — and every
mutation rewrites the whole document, so write cost grows linearly with history.

**Fix.** Cap `events` at a rolling window (the metrics endpoint only reads 60), and
split the store into per-collection documents or per-record documents before any real
usage.

---

## <a id="a-9"></a>A-9 — Frontend swallows action/outcome errors · **Low-Medium**

`frontend/src/components/ResearchPanel.tsx`:

```ts
try { /* ... */ } catch { setActionState('idle'); }
try { /* ... */ } catch { setOutcomeState('idle'); }
```

A failed "Record action" or "Record outcome" resets the button with **no message**. The
user sees a click that did nothing and cannot tell whether it worked.

This is inconsistent with the save path directly above it, which handles errors properly
— shows the message, keeps the content on screen, invites a retry. The stated principle
is "never claim what did not happen"; a silent no-op is a quieter version of the same
failure.

**Fix.** Mirror the save path: add an `error` state, capture `err.message`, render it
inline.

---

## <a id="a-10"></a>A-10 — Accessibility gaps · **Low-Medium**

The frontend uses native elements throughout, so keyboard and screen-reader basics work.
The gaps:

- `--text-faint` (`#646b7f`) on `--bg-card` (`#12141d`) is roughly **3.4:1** — well under
  WCAG AA for small text, and it is used for every field label and timestamp.
- Tabs are `<button>`s without `role="tab"` / `aria-selected` / `aria-controls`.
- Long-running operations have no `aria-live` region — a screen-reader user gets no
  announcement of progress or completion across a 75-second call.
- No `prefers-reduced-motion` guard on the pulse and shimmer animations.
- `.btn` relies on the browser default focus ring, which is low-contrast on this ground.

**Fix.** Lift `--text-faint` toward `#7b8296`, add `role="tablist"`/`role="tab"`, wrap
the loading component in `aria-live="polite"`, and add a reduced-motion media query.

---

## <a id="a-11"></a>A-11 — Action and outcome routes skip Agent verification · **Low**

`POST /api/agents/:agentId/actions` and `/outcomes` write records straight from
`req.params.agentId` without calling `getAgent()`, unlike every other agent route. Any
string becomes an agent id, producing orphan records that pollute metrics and the
history timeline.

**Fix.** Add the same `getAgent` guard the sibling routes use. The outcome route should
additionally verify that `actionId` refers to an existing action for that Agent.

---

## <a id="a-12"></a>A-12 — Enforcement schema accepts unreachable indices · **Low**

`memoryEnforcementSchema.index` is `min(0).max(4)`, but the engine slices opportunities
to **3** before enforcement. If the model answers `3` or `4`, validation passes, the
lookup misses, and the pass is logged as `memory_enforcement_bad_index` and abandoned —
a wasted provider call at the exact moment the demo needs the badge.

**Fix.** Bound the schema by the actual list length, or clamp the index to
`opportunities.length - 1` rather than discarding the response.

---

## <a id="a-13"></a>A-13 — Router double-mount creates duplicate paths · **Low**

`intelligenceRouter` is mounted at both `/api/intelligence` and
`/api/internal/intelligence`, and its metrics/health handlers register two paths each.
The result is a wider surface than documented:

```
/api/intelligence/health              /api/internal/intelligence/health
/api/intelligence/internal/health     /api/internal/intelligence/internal/health
/api/intelligence/reset               /api/internal/intelligence/reset
/api/intelligence/history/:id         /api/internal/intelligence/history/:id
```

Harmless functionally, but it means "the reset endpoint" is two URLs, which matters for
[A-1](#a-1) — anyone blocking one path leaves the other open.

**Fix.** Split into two routers: public (`history`) and internal (`metrics`, `health`,
`reset`), each mounted once.

---

## <a id="a-14"></a>A-14 — `LOG_LEVEL=debug` writes raw model output · **Low**

`parseWithRepair` logs up to 4,000 characters of raw model text at `debug` on every
parse failure, and the request logger logs every path. Correct for local debugging;
in a hosted environment it puts unvalidated model output into a log aggregator.

**Fix.** Keep `LOG_LEVEL=info` in deployed environments (documented), and consider
truncating the debug payload further or gating it behind an explicit
`LOG_RAW_MODEL_OUTPUT` flag.

---

## <a id="a-15"></a>A-15 — No HTTP-layer test coverage · **Low**

128 tests cover parsing, mappers, memory, failures and the P0 loop — but nothing
exercises Express. No test asserts a status code, an error envelope shape, a 404, or
CORS behaviour.

[A-2](#a-2) is the direct consequence: a single supertest asserting `400` on an invalid
body would have caught it before deploy.

**Fix.** Add a small `supertest` suite covering: `400` on invalid bodies, `404` on
unknown agent/project, `402` on simulated credit exhaustion, the error envelope shape,
and the reset endpoint's effect.

---

## What the codebase gets right

Worth recording, because it is unusual and should survive future refactors.

**The failure taxonomy is genuinely well built.** Eight categories, each mapped to a
status code, a user-safe message, and a retry policy. The ordering inside `categorize()`
— credits before status, status before message text — encodes two real lessons: an
exhausted balance arrives as a `400`, and ChainGPT's 504 gateway page contains the word
"timeout". Both would have caused misclassification.

**Anti-hallucination on memory ids is the right invariant.** Filtering the model's
claimed `knowledgeIds` against the ids actually injected means the memory badge — the
demo's central claim — cannot be faked by the model. That is the single most important
correctness property in the system, and it is enforced in both the main path and the
enforcement pass.

**Honest degradation everywhere.** Signal retrieval failing is non-fatal. A repeat scan
with no memory influence says so instead of hiding it. An empty result set says "no
strong opportunities" instead of inventing filler. A failed save never reports success.
Demo output is banner-flagged as not-live. Each of these is a place where a shortcut
would have made the demo look better and been a lie.

**Read-only discipline toward KULT.** Declining to call
`GET /social/creator-stats/:creatorId` because it writes a 0G snapshot as a side effect
— and composing the same numbers from a genuinely read-only endpoint instead — is the
kind of restraint that usually only appears after an incident.

**Real-vs-derived is documented in code, not just prose.** `__derivationNotes` makes the
distinction programmatically inspectable, and every derived field is labelled at its
call site.

**Live findings are encoded as constants with `VERIFIED LIVE` comments and regression
tests.** `MAX_QUERY_WORDS = 2`, `SIGNAL_LIMIT = 6`, the `threadUuid` derivation, the
`objectify` promotion — each is a measurement with its evidence attached, not a
preference. That is why the next engineer will not "simplify" them back into bugs.

---

## Recommended order of work

1. **A-1** — gate the reset endpoint and rate-limit the three spending routes. *(hours)*
2. **A-3, A-5** — align the two config defaults with their documentation. *(minutes)*
3. **A-2** — return `400` on invalid bodies. *(minutes)*
4. **A-4** — set `MONGODB_URI` on the deployment. *(minutes)*
5. **A-6** — blank `KULT_API_BASE` in `.env.example` and in deployment. *(minutes)*
6. **A-15** — add the supertest suite, which locks in 2 and 11. *(hours)*
7. **A-9, A-10** — frontend error surfacing and accessibility. *(hours)*
8. **A-8, A-7** — store redesign, only when usage justifies it. *(days)*
