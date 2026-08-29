# Architecture

## The idea in one diagram

```
                          CHAINGPT
        +----------------------+----------------------+
        |                                             |
  [AI Crypto News]                            [Web3 LLM - blob]
   current signals                          reasoning + evidence
        |                                             |
        +----------------------+----------------------+
                               v
                    +---------------------+
                    | KULT Context Engine |  agent state - memory
                    |  src/intelligence/  |  actions - outcomes
                    +----------+----------+
                               v
              recommendation -> action -> outcome
                               |
                               +---- feeds the next request
```

ChainGPT supplies *what is happening in Web3 right now*. KULT supplies *who this Agent
is and what it has already learned*. The service is the join between them, and the join
is stateful: every save makes the next scan different.

## Layer map

| Layer | Path | Responsibility |
|---|---|---|
| HTTP | `src/index.ts`, `src/routes/` | Express wiring, validation, error funnel |
| Orchestration | `src/intelligence/engine.ts` | The three workflows, end to end |
| Context | `src/intelligence/memory.ts` | Selects which memory reaches the model |
| Retrieval | `src/intelligence/signals.ts` | Builds AI News queries and renders signals |
| Contracts | `src/intelligence/prompts.ts`, `schemas.ts` | Prompt text and Zod output contracts |
| Parsing | `src/intelligence/parser.ts` | Model text to validated object, defensively |
| Provider | `src/providers/` | `chaingpt.ts` / `demo.ts` behind one interface |
| KULT adapter | `src/kult/` | Real KULT records to intelligence context |
| Persistence | `src/db/` | File or Mongo store, plus the KULT games snapshot |
| Cross-cutting | `src/lib/`, `src/analytics.ts` | Errors, retries, timeouts, logging, events |

Nothing above the provider layer knows which provider is live. Nothing above the KULT
adapter knows whether context came from the POC database, the live KULT API, or bundled
fixtures — all three pass through the same mappers.

## Request lifecycle — opportunity discovery

`POST /api/agents/:agentId/opportunities` is the workflow worth understanding; the
other two are simpler variants of it.

```
 1. Resolve Agent            kult/context.getAgent()
                             poc_db -> kult_api -> poc_fixtures, first hit wins
 2. Validate body            zod (query?, forceFreshSignals?)
 3. Repeat-scan check        memory.hasPriorIntelligence(agentId)
                             -> tracks repeat_intelligence_scan
 4. Build KULT context       memory.buildKultContext()
                             top-5 knowledge by (keyword x 2 + recency x 3)
                             + last 5 actions + last 5 outcomes
 5. Build signal query       signals.buildAgentSignalQuery()
                             short domain phrase + ordered fallbacks
 6. Fetch signals            provider.getSignals()
                             TTL cache -> retry -> timeout -> phrase fallback walk
                             failure here is NON-FATAL; reasoning continues
 7. Reason                   engine.reasonWithDegradation()
                             on timeout/5xx: one retry with half the signals
 8. Parse                    parser.parseWithRepair()
                             fences -> balanced-brace extract -> flaw repair
                             -> shape normalize -> zod -> ONE model repair pass
 9. Anti-hallucination       drop any knowledgeId the service did not inject
10. Memory enforcement       if memory existed but no card claimed it,
                             one cheap targeted revision (non-fatal)
11. Persist + track          runs[] += run; opportunity_scan_completed
12. Respond                  3 opportunities, or { empty: true }
```

Steps 6, 7, 8 and 10 all degrade rather than fail. That is deliberate: a scan that
returns something honest beats a scan that 500s.

## Key design decisions

**Provider abstraction with one real provider.** `IntelligenceProvider` has three
methods (`getSignals`, `reason`, `health`). `DemoProvider` implements it for offline
development and CI. ChainGPT stays the active provider and stays visibly attributed in
the UI — the abstraction exists for testability, not to hedge on the partner.

**The store stays synchronous to read.** `db.read()` is sync (19 call sites depend on
it) and the entire store is held in memory; `db.mutate()` awaits the write-through
before resolving. A failed write therefore rejects to the caller, so the UI can never
claim a save that did not happen.

**Memory retrieval is keyword + recency, not embeddings.** A vector database is not
justified for a POC. Relevance scoring is a single function in `memory.ts` — swap it for
KULT's embeddings if they already exist.

**The POC database is separate from KULT's, by construction.** The service writes
knowledge, actions, outcomes and analytics, and exposes a reset endpoint that deletes
them. `src/db/mongo.ts` refuses to start against a known KULT production database name
(`prompt_creator_studio`, `creator_studio`, `kult`). Same Atlas cluster is fine; the
database must differ.

**Reads of KULT are read-only, aggressively so.** `GET /social/creator-stats/:id` is
deliberately never called even though it returns the richest aggregate — it fires a
`putJsonOnZeroG()` profile snapshot as a side effect, so "reading" writes. The same
numbers are composed from `/games/list` instead. An intelligence layer must not mutate
production creator data as a side effect of generating a recommendation.

**Every model response is validated server-side before the UI sees it.** Blob mode, not
streaming-to-client. Raw provider text is logged at debug and never crosses the HTTP
boundary.

## Context resolution

Three sources, tried in order, all producing identical shapes:

| Source | Active when | Requires |
|---|---|---|
| `poc_db` | The POC database has a seeded games snapshot | `MONGODB_URI` + `npm run seed:kult` |
| `kult_api` | `KULT_API_BASE` is set and the snapshot is empty | KULT Creator Studio reachable |
| `poc_fixtures` | Neither | nothing |

`GET /api/internal/intelligence/health` reports which one is live as `contextSource`.

Fixtures are real KULT game *packages* — real field names, real nesting, including the
`themePresets.neon` title convention that produces "Neon 2D Racing". They run through
the same mappers as live data, so both paths exercise identical code.

## Storage

Two interchangeable drivers, selected by the presence of `MONGODB_URI`:

- **file** — `${DATA_DIR}/store.json`, written atomically (tmp file + rename). Zero
  infrastructure. The default.
- **mongo** — one document (`_id: poc_state_v1`) in the `poc_state` collection of the
  POC's own database, replaced wholesale on each mutation.

Both hydrate the whole store into memory at boot. Writes are serialized through a
promise queue so concurrent mutations cannot interleave a half-written state.

> **Consequence worth knowing:** on an ephemeral filesystem (Render, Fly, containers
> without a volume) the file driver loses all accumulated intelligence on every restart
> and deploy — which deletes the memory loop, the whole point of the demo. See
> [operations.md](operations.md).

## Failure taxonomy

`src/lib/errors.ts` maps every thrown value onto one of eight categories, and the
category decides the HTTP status, the user-facing message, and whether a retry is even
offered.

| Category | HTTP | Retried internally | Retry offered to user |
|---|---|---|---|
| `timeout` | 504 | yes (1x, backoff) | yes |
| `rate_limit` | 429 | yes (1x, backoff) | yes |
| `upstream_5xx` | 502 | yes (1x, backoff) | yes |
| `auth` | 502 | **no** | **no** |
| `insufficient_credits` | **402** | **no** | **no** — "top up" |
| `malformed_output` | 502 | one model repair pass | yes |
| `no_signals` | 502 | walks broader phrases | yes |
| `unknown` | 502 | no | yes |

Order matters inside `categorize()`:

1. **Credits first.** An exhausted balance arrives as HTTP **400** with
   `{"message":"Insufficient credits"}`. The generic branch would swallow it.
2. **Explicit HTTP status next.** Provider bodies lie — ChainGPT's 504 gateway page
   contains the word "timeout", which would otherwise mask an upstream failure as a
   client-side deadline.
3. **Message heuristics last.** The official SDK wraps axios and exposes no status
   field, only the text `Request failed with status code 401`, so the status is parsed
   back out of the message. Without this, every SDK HTTP error classified as `unknown`
   and was retried blindly.

## Analytics

Twelve event names (`src/analytics.ts`), written into the same store and surfaced at
`/api/internal/intelligence/metrics`. Analytics writes are wrapped in try/catch and
logged on failure — instrumentation must never break an intelligence request.

The KPI that matters is not call volume. `recommendationToActionRate` (actions taken
divided by opportunities surfaced) and `memoryInfluencedRecommendations` are the two
numbers that say whether the loop is working.
