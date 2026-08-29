# Intelligence pipeline

How a request becomes a validated, personalized recommendation — and every place that
pipeline is hardened against a live model behaving badly.

Files: `src/intelligence/{engine,memory,signals,prompts,schemas,parser}.ts`.

---

## 1. Memory selection

`memory.ts` decides which of an Agent's accumulated knowledge reaches the model. Sending
everything is not an option — prompt size is the binding constraint (see §3).

```
score = keywordOverlap(focus, title + summary) × 2  +  recency(createdAt) × 3
```

- **Tokenize:** lowercase, strip punctuation, drop tokens ≤ 3 chars and a 40-word
  stopword list.
- **Recency:** linear decay to zero over 14 days. Fresh intelligence outranks stale.
- **Weighting:** recency is weighted higher than keyword overlap, deliberately. In a
  compounding-intelligence demo, "what did this Agent just learn" matters more than
  lexical similarity.
- **Limit:** top 5 knowledge items, plus the last 5 actions and last 5 outcomes.

`buildKultContext(agent, focusText, project?)` assembles all of it. `focusText` is the
explicit query, or the Agent's interests + goals joined, or the project's title + tags +
goals for the growth flow.

`hasPriorIntelligence(agentId)` — a boolean, true if the Agent has any saved knowledge —
is what flags a scan as a repeat and arms the memory requirement.

> **Deliberate non-feature:** no embeddings, no vector database. That would be the right
> answer at scale and the wrong answer for a POC. The swap point is a single scoring
> function.

---

## 2. Signal retrieval

`signals.ts` builds the AI News query. Three live-verified constraints shape it, and
each one caused a real failure before it was handled.

### Queries are literal phrases, capped at two words

`searchQuery` is a literal phrase match, **not** a multi-keyword OR.

```
"AI gaming"                        -> rows
"AI gaming agents web3 creator"    -> 0 rows
```

The original design sent one long descriptive query and silently emptied the radar on
every scan. Queries are now `MAX_QUERY_WORDS = 2`, with **ordered broader fallbacks**
that the provider walks until something returns.

### Genre names are terrible news queries

KULT genres matched nothing useful — `"Action Arcade"` returned prediction markets and
tokenized funds, because the corpus is Web3/finance news with no notion of arcade
genres.

Retrieval therefore leads with domain vocabulary:

```ts
const DOMAIN_PHRASES = ['AI gaming', 'web3 gaming', 'blockchain gaming', 'GameFi',
                        'game studio', 'AI agents', 'creator economy'];
const FALLBACK_PHRASES = ['web3 gaming', 'gaming', 'AI agents', 'web3'];
```

The Agent's genres **order** these phrases; they are never queried directly. Genre
informs reasoning, not retrieval.

### Six signals, not twelve

A 7.6k-char prompt (12 rendered signals) drew a **504 HTML page from ChainGPT's own
gateway after ~81 seconds** — past the SDK's internal 60s axios cap. `SIGNAL_LIMIT = 6`
keeps the prompt near 5k chars. Raising it trades reliability for breadth; measure
before you do.

`renderSignals()` emits `N. [YYYY-MM-DD] title` + a 200-char description, so signals
cannot crowd out KULT context.

### Freshness and caching

14-day `fetchAfter` cutoff keeps "current signal" honest. Results are cached in a
`TtlCache` for `SIGNAL_CACHE_TTL` (default 600s), keyed on query + limit + the
freshness cutoff **bucketed to the hour**, so near-identical scans share an entry.

Category filters (`categoryId: [8 gaming, 4 AI]`) exist but are **off by default** —
ids are account/catalog specific, and a wrong id would silently narrow a scan to
nothing.

**Signal failure is non-fatal.** If retrieval throws, the engine logs
`signals_unavailable_continuing` and reasons on KULT context alone.

---

## 3. Prompt construction

`prompts.ts`. Every prompt is: JSON preamble → task → KULT context → signals → task
rules → JSON discipline → explicit output shape.

### The JSON demand is stated twice

On a ~5k prompt the model abandoned JSON entirely and answered in markdown prose. The
repair pass rescued it, but salvaged fragments produced junk opportunities. So:

- `JSON_PREAMBLE` leads: *"Your entire response must be a single JSON object. The first
  character you output must be `{` and the last must be `}`."*
- `JSON_DISCIPLINE` closes, restating the rules and ending with *"Output the JSON object
  now, starting with `{`."*

Every rule in `JSON_DISCIPLINE` targets an observed failure, not a hypothetical one:
the missing wrapper key, word-grade relevance, nested objects returned as sentences,
invented sources, multi-line strings.

### The memory directive is the P0

When the Agent has saved knowledge, the prompt carries a **mandatory** requirement:

> At least ONE opportunity MUST set `memoryInfluence.used = true`, cite the relevant
> `KNOWLEDGE_ID` values, and explain how that prior knowledge changes the recommended
> next step. **It must advance beyond the earlier research, not restate it.**

When there is no saved knowledge, the inverse is stated explicitly — set
`memoryInfluence.used = false` everywhere — so the model does not invent a memory it
does not have.

Knowledge is rendered with an explicit id per line, which is what makes citation
verifiable:

```
- KNOWLEDGE_ID: kn_abc123 | opportunity_research | "Immutable grant track"
  Grant track bundles distribution with funding...
```

### Per-workflow ChainGPT settings

| Workflow | `chatHistory` | `sdkUniqueId` | Why |
|---|---|---|---|
| Opportunity discovery | `off` | — | KULT injects canonical memory itself; keeps discovery deterministic |
| Deep research | `on` | `threadUuid('kult:{agentId}:research:{oppId}')` | Multi-turn continuity, isolated per opportunity |
| Creator growth | `off` | — | Generated from current project + KULT memory |
| Repair / enforcement | `off` | — | Cheap, stateless, `useCustomContext: false` |

`sdkUniqueId` **must be a UUID** — a readable thread id is rejected outright, which
killed Deep Research on the first live run. `threadUuid()` derives a deterministic
v5-shaped UUID from the readable key via SHA-1, so threads stay stable per
Agent + opportunity across restarts.

---

## 4. Parsing

`parser.ts`. Seven stages, each one earned by a real failure:

```
extractText        data.bot, plus 8 neighbouring shapes, then JSON.stringify fallback
stripMarkdown      strip BOM, unwrap ```json fences
extractFirstJson   balanced-brace scan honouring string literals and escapes
repairCommonFlaws  trailing commas, smart quotes, NaN, undefined
normalizeShape     wrapper key + per-item coercions (see below)
zod safeParse      the contract
model repair       exactly ONE targeted retry, then a friendly failure
```

**`extractText`** reads `data.bot` first — the confirmed buffered answer path — then
`data.data.bot`, `bot`, `data.message`, `message`, `data.answer`, `answer`,
`data.response`, `response`. A provider-side field rename degrades into a parse attempt
rather than a hard failure.

**`extractFirstJsonObject`** is a real scanner, not a regex: it tracks depth, string
literals and escapes, so a `}` inside prose cannot terminate the object early.

**`normalizeShape`** handles the two deviations the live model actually produces,
*before* validation, so the expensive repair round-trip is not spent on them:

1. **Bare object where a wrapper was required.** `{title, action, ...}` is promoted to
   `{opportunities: [...]}`; a bare array is wrapped too.
2. **Word-grade relevance.** `"High"` maps to `88` via a lookup table
   (`very high: 95 … very low: 30`), falling back to any digits in the string, then 70.
3. **`objectify`** promotes a nested field returned as a sentence into the object shape
   — `"memoryInfluence": "Not applicable"` becomes
   `{used: false, knowledgeIds: [], reason: "Not applicable"}`, keeping the sentence as
   the human-readable field. It also handles a JSON-encoded string, and leaves genuine
   objects untouched.

**`parseWithRepair`** makes exactly one model repair attempt on failure, using
`buildRepairPrompt` with the bad text (truncated to 6k) and the specific validation
reason. Two failures throw `ProviderError('malformed_output')` → HTTP 502 → a friendly
retry state. Raw text is logged at `debug` only and never crosses the HTTP boundary.

### Schema contracts

`schemas.ts` uses Zod defaults and `.catch()` generously — a missing optional field
should not fail a whole response.

- `relevance` is `z.coerce.number().min(0).max(100)`
- `opportunities` is `.min(1).max(5)`, then the engine slices to 3
- `liveEvidence.items[].type` is `.catch('news')` — an unknown type degrades, not fails
- `memoryInfluence` has a whole-object default, so its absence is legal
- `memoryEnforcementSchema.index` is an int 0–4

---

## 5. Prompt degradation

`reasonWithDegradation()` in `engine.ts`. If a reasoning call fails with `timeout` or
`upstream_5xx` and more than 2 signals were sent, it retries **once** with roughly half
the signals:

```ts
const reduced = Math.max(2, Math.floor(signalCount / 2));
```

`insufficient_credits` and `auth` propagate untouched — sending less cannot fix them,
and retrying burns time or money.

This sits *outside* the provider's own `withRetry`, so a size-related failure gets one
same-size retry (from `withRetry`) and then one smaller retry.

---

## 6. The memory loop — the P0

The single behaviour the demo exists to prove.

```
Scan 1   ->  no saved knowledge  ->  every card memoryInfluence.used = false
Research ->  Save                ->  knowledge[] += item
Scan 2   ->  hasPriorIntelligence = true
             top-5 knowledge injected with KNOWLEDGE_IDs
             prompt carries the MANDATORY memory directive
         ->  at least one card: BUILDS ON PREVIOUS AGENT KNOWLEDGE
```

### Anti-hallucination

The model's claimed `knowledgeIds` are filtered against the ids actually injected:

```ts
const claimed = (o.memoryInfluence?.knowledgeIds ?? []).filter((id) => contextKnowledgeIds.includes(id));
const used = Boolean(o.memoryInfluence?.used) && contextKnowledgeIds.length > 0;
```

`used` additionally requires that knowledge was genuinely injected — the model cannot
declare memory influence for an Agent that has none. When the model cites memory without
naming ids, the first two injected ids are substituted, so the badge still links to real
records.

**A hallucinated id can never become a memory badge.** This is the invariant that makes
the badge trustworthy.

### Enforcement pass

The live model does not always honour the in-prompt directive, and that moment is the
whole showcase. So if memory existed and no card claimed it, `enforceMemoryInfluence()`
runs one cheap targeted revision:

- The model is shown the prior knowledge and the opportunities it already produced.
- It picks **one index** and explains the progression.
- The same anti-hallucination filter applies to the ids it cites.
- Only that one opportunity is mutated in place.

Regenerating instead would cost more and would change cards the user is already looking
at. Failure is non-fatal and logged as `memory_enforcement_failed` /
`memory_enforcement_unparsable`.

**When it still does not fire**, the backend logs
`repeat_scan_without_memory_influence` and the client says so plainly. A broken loop
that looks broken is far better than one that looks fine.

> Note: `memoryEnforcementSchema` accepts an index up to 4 while the engine only ever
> presents 3 opportunities. An out-of-range index is caught, logged as
> `memory_enforcement_bad_index`, and skipped.

---

## 7. Where to change what

| You want to change… | Edit |
|---|---|
| Which memory is selected, or how it is scored | `memory.ts` |
| How many signals, which phrases, freshness window | `signals.ts` |
| What the model is asked, and how strictly | `prompts.ts` |
| The output contract | `schemas.ts` — then update the `*_SHAPE` strings in `engine.ts` |
| How malformed output is salvaged | `parser.ts` |
| Workflow orchestration, degradation, enforcement | `engine.ts` |

Every constant that encodes a live-API finding carries a `VERIFIED LIVE` comment
explaining what was observed. If you change one of those numbers, re-run
`npm run smoke` against a funded key first — those values are measurements, not
preferences.
