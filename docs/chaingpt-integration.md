# ChainGPT integration

Everything about the provider layer: the interface, both transports, the findings that
only a live account revealed, and the steps to go live.

Files: `src/providers/{types,index,chaingpt,demo}.ts`.

---

## 1. The interface

```ts
export interface IntelligenceProvider {
  readonly name: string;
  getSignals(query: SignalQuery): Promise<Signal[]>;
  /** Returns the raw provider payload; parsing/validation is the caller's job. */
  reason(prompt: string, options?: ReasonOptions): Promise<unknown>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
```

`reason()` returning `unknown` is deliberate. Parsing belongs to `parser.ts`, which is
where all the defensive knowledge lives; a provider that pre-parsed would duplicate it
and hide failures.

Two products are used:

| ChainGPT product | Package | Role |
|---|---|---|
| AI Crypto News | `@chaingpt/ainews` | Current external Web3 signals |
| Web3 LLM (General Chat) | `@chaingpt/generalchat` | Reasoning over KULT context + signals |

### Provider selection

```ts
resolveProvider()
  INTELLIGENCE_PROVIDER=demo                -> demo,    degraded: false
  INTELLIGENCE_PROVIDER=chaingpt, no key    -> demo,    degraded: TRUE + reason
  INTELLIGENCE_PROVIDER=chaingpt, key set   -> chaingpt
```

A missing key falls back rather than crashing — but **loudly**. The server logs
`SHOWCASE WARNING: running on the demo provider` at boot, `/health` reports
`degraded: true` with the reason, and the client shows a persistent banner. A silent
fallback that looks live is the one thing this must never do.

The provider instance is cached after first construction; `providerStatus()` re-resolves
from config each call, so status reporting is always current.

---

## 2. Transports

`CHAINGPT_TRANSPORT` selects between them. Both are implemented for every call.

| | `sdk` (default) | `rest` |
|---|---|---|
| Client | Official `@chaingpt/*` packages | `fetch` against documented endpoints |
| Cancellation | **None** — no `AbortSignal` exposed | Real `AbortSignal.timeout()` |
| Internal timeout | 60s axios cap, baked in | None beyond the signal |
| `model` param | Not exposed (`CHAINGPT_MODEL` is inert) | Sent |
| Best for | Production use | Verifying raw response shapes |

Because the SDK exposes no `AbortSignal`, `withTimeout()` bounds **our wait**, not the
socket. `REASONING_TIMEOUT_MS` above ~60s therefore buys nothing on the SDK transport —
the SDK will have given up first.

### Structured output uses blob mode

`createChatBlob()` returns the complete answer, which is schema-validated server-side
before the client sees anything. Streaming to the browser would mean shipping unvalidated
model text to the UI. If a stream is used, `accumulateStream()` reassembles it
server-side first.

---

## 3. Verified live API findings

Every item below was observed against a real funded key and contradicted either the
written spec or a reasonable assumption. Each has a regression test.

### Session 1 — 2026-08-25

| Finding | Response |
|---|---|
| **`searchQuery` is a literal phrase match, not multi-keyword.** `"AI gaming"` returns rows; `"AI gaming agents web3 creator"` returns **0**. | Queries capped at 2 words with ordered broader fallbacks. The original design silently emptied the radar on every scan. |
| **Buffered answer path is `data.bot`.** | Confirmed as documented; 8 neighbouring shapes accepted as a fallback. |
| **News rows have no `url` field.** Real fields: `title`, `description`, `pubDate` (publication), `createdAt` (ingest), `author`, `imageUrl`, nullable `category`/`token`. | `url` stays `undefined` rather than invented. `pubDate` preferred over `createdAt`. |
| **`useCustomContext: true` is rejected without a `contextInjection` object** — *"ContextInjectionDto is required when aiTone is PRE_SET_TONES"*. | One is always sent when the flag is on. |
| **With no AI Hub context, ChainGPT states "KULT is a cryptocurrency built on blockchain technology."** | A wrong prior that would poison every recommendation. Prompts carry KULT context explicitly, and the flag should stay off until the Hub is configured. |
| **The model returns a bare object, fenced, with `"relevance": "High"`.** | `normalizeShape()` wraps bare objects and coerces word-grade relevance before validation. |
| **A 7.6k-char prompt (12 signals) drew a 504 HTML page after ~81s.** The SDK also caps internally at 60s. | Signals limited to 6, rendering tightened to ~5k chars. |
| **An exhausted balance returns `400 {"message":"Insufficient credits"}`** — a valid key with no funds. | First-class `insufficient_credits` category: never retried, surfaces HTTP **402**, `retryable: false`, UI says "top up". The smoke test checks credits first and stops early. |

### Session 2 — new key, credits available

| Finding | Response |
|---|---|
| **`sdkUniqueId must be a UUID.`** A readable thread id (`kult:{agent}:research:{opp}`) is rejected outright, which killed Deep Research. | `threadUuid()` derives a deterministic v5-shaped UUID from the readable key, so threads stay stable per Agent + opportunity. |
| **Nested fields come back as sentences** — `"memoryInfluence": "Not applicable"` where an object is required. | `objectify()` promotes a sentence (or a JSON-encoded string) into the object shape before validation. |
| **On a ~5k prompt the model abandons JSON entirely** and answers in markdown prose. | The JSON demand is stated before *and* after the content and pins the first character. The repair pass remains the backstop. |
| **KULT genre names make terrible news queries.** `"Action Arcade"` matched prediction markets and tokenized funds. | Retrieval leads with Web3-gaming vocabulary, ordered by the Agent's genres. Genre informs reasoning, not retrieval. |
| **The SDK hides HTTP status in the message** (`Request failed with status code 401`), so every SDK HTTP error classified as `unknown` and was retried blindly. | `categorize()` parses the status out of the message, behind the explicit-status and credit checks. |
| **Larger prompts appear to cost more credits.** A 2k prompt succeeded and a 5k prompt returned `Insufficient credits` on the same balance. | Prompt size bounded at ~5k. Budget more than 1 credit per reasoning call. |

---

## 4. News normalization

`normalizeNews()` accepts five container shapes (`data.data`, `data.news`, `data`,
`news`, a bare array) and maps each row defensively:

- `publishedAt` prefers `pubDate` (real publication) over `createdAt` (ingest time),
  and falls back to now if unparseable.
- `description` is HTML-stripped, whitespace-collapsed and truncated to 900 chars.
- `source` reads `author`, then `source`, then `sourceName`, then `"ChainGPT AI News"`.
- `url` stays `undefined` — the live payload has no such field. **Never invent missing
  source metadata.**
- Rows without a real title are dropped.

---

## 5. Cost model

1 credit = $0.01. Roughly 10 credits per full showcase run.

Per user-visible action:

| Action | Provider calls |
|---|---|
| Discover | 1 news (cacheable) + 1 reasoning (+1 if degraded, +1 if repair, +1 if enforcement) |
| Research | 1 news + 1 reasoning (+repair) |
| Grow | 1 news + 1 reasoning (+repair) |
| Deep health check | 1 news (1 row) |

Cost controls already in place: the 600s signal cache, the 6-signal cap, the ~5k prompt
bound, the single repair attempt, and no retry on credit or auth failures.

There is **no rate limiting** — every unauthenticated POST spends credits. See
[audit.md](audit.md) finding A-1.

---

## 6. AI Hub context

`CHAINGPT_USE_CUSTOM_CONTEXT` applies the dedicated KULT context configured against the
key. When it is on, a `contextInjection` object is always sent alongside (the API rejects
the flag without one):

```ts
{
  companyName: 'KULT',
  companyDescription: 'KULT is a Web3 creator platform… KULT is a platform, not a token or cryptocurrency.',
  purpose: 'Give persistent KULT Agents real-time Web3 awareness and turn it into personalized actions.',
  aiTone: AI_TONE.PRE_SET_TONE,
  selectedTone: PRE_SET_TONES.PROFESSIONAL,
}
```

**Enable it only after configuring the KULT context in the ChainGPT AI Hub**, then
confirm with check 3 of `npm run smoke`. Without Hub configuration the model holds a
wrong prior about what KULT is.

> **Config defect:** `.env.example` documents this as `false`, but the code default when
> the variable is absent is `true`. On any deployment that does not set it explicitly,
> the flag is on. See [audit.md](audit.md) finding A-3 — set it explicitly everywhere.

Stable KULT product knowledge belongs in the Hub; dynamic Agent/project/memory context
belongs in the prompt. KULT's own store stays canonical — Hub context is product
knowledge, not Agent memory.

---

## 7. Going live

```bash
# 1. Top up at https://app.chaingpt.org  (1 credit = $0.01, ~10 per showcase run)

# 2. Prove the account and the API contract
npm run smoke     # stops early and says "top up" if credits are empty

# 3. Prove the whole flow end to end, live
npm run verify
```

`npm run smoke` verifies, in order: credits, auth, the News response shape, the
documented `data.bot` answer path, `useCustomContext`, and whether the model reliably
obeys a pure-JSON instruction. Credits are checked **first** so an empty balance
produces one clear message instead of a wall of failures.

`npm run verify` runs the exact P0 sequence — scan → research → save → rescan →
**memory badge** → growth → analytics — and asserts every Definition-of-Done line. It
aborts cleanly on credit exhaustion. It passes on the demo provider with real KULT
context; re-run it against ChainGPT and the showcase is proven.

**Checklist**

- [ ] `CHAINGPT_API_KEY` set server-side only
- [ ] `INTELLIGENCE_PROVIDER=chaingpt`
- [ ] `CHAINGPT_TRANSPORT=sdk`
- [ ] `CHAINGPT_USE_CUSTOM_CONTEXT` set **explicitly** (`false` unless the Hub is configured)
- [ ] `REASONING_TIMEOUT_MS=75000`, `NEWS_TIMEOUT_MS=20000`
- [ ] Balance topped up
- [ ] `npm run smoke` passes
- [ ] `npm run verify` passes
- [ ] `/health` reports `degraded: false` and `active: "chaingpt"`

---

## 8. The demo provider

`DemoProvider` implements the same interface with three canned signals and canned
responses per `TASK_ID`, after a 550ms delay so loading states are exercised.

It reads the prompt to decide whether memory reached the model:

```ts
const hasMemory = /RECENT SAVED KNOWLEDGE \(KULT canonical memory\)/.test(prompt)
  && !/\(none yet\)/.test(prompt.split('RECENT SAVED KNOWLEDGE')[1]?.slice(0, 200) ?? '');
const knowledgeId = /KNOWLEDGE_ID:\s*(\S+)/.exec(prompt)?.[1] ?? '';
```

The prompt builder only emits that block when saved knowledge exists, so its presence is
a faithful stand-in for "memory reached the model" — which is what makes the demo
provider a legitimate test double for the memory loop, and why the integration test can
assert the P0 flow without a funded key.

Responses are wrapped as `{ data: { bot: "<json>" } }` — the same envelope ChainGPT
returns — so the full parsing pipeline runs identically on both providers.

Demo signals are labelled `ChainGPT AI News (demo)`. Demo output must never be presented
as live output.
