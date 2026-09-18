# API reference

Base URL: `http://localhost:8787` in development.
All request and response bodies are JSON. Request bodies are capped at 256 KB.

**Authentication** is set by `AUTH_MODE` (see [configuration.md](configuration.md)) and
applies to every `/api` route; `/health` is always open.

| Mode | Client sends | Notes |
|---|---|---|
| `off` | nothing | Local development only. |
| `api_key` | `x-api-key: <key>` | A key in a browser bundle is public: this stops drive-by abuse, it is not identity. |
| `privy` | `Authorization: Bearer <Privy access token>` | The token's DID is the user. With ownership on, a user may only spend credits on, or write memory for, their own Agent (`403` otherwise). Reads stay open. |

Every client may also send `x-kult-client-id` (an opaque 8-64 char id) so metrics can
count distinct browsers without login. `POST /reset` additionally needs `x-admin-token`.

**Rate limits.** Every `/api` route has a per-client flood cap per minute. The three
credit-spending routes (scan, research, grow) add a per-client and a global cap per
window. A limited request gets `429`, `Retry-After`, and `category: "rate_limit"`.

## Conventions

**Success envelopes** are named objects, never bare arrays: `{ "agents": [...] }`,
`{ "knowledge": {...} }`. This leaves room to add metadata without a breaking change.

**Error envelope**, for every intelligence failure:

```json
{ "error": { "category": "insufficient_credits", "message": "The ChainGPT account is out of credits. Top up at app.chaingpt.org to resume live intelligence.", "retryable": false } }
```

`message` is always safe to render verbatim. Raw provider errors and raw model text
never cross this boundary. `retryable: false` means a retry cannot succeed — do not
offer a "Try again" button.

**Not-found errors** carry only a message: `{ "error": { "message": "Agent not found" } }`.

**Status codes**

| Status | Meaning |
|---|---|
| `200` / `201` | Success (`201` on record creation) |
| `400` | Invalid body (with Zod `issues`), malformed JSON, or an id outside `[A-Za-z0-9:_.-]{1,128}` |
| `401` | Missing/invalid credentials (`category: "auth"`), or missing admin token on reset (`"admin_required"`) |
| `402` | ChainGPT account out of credits. Never retry. |
| `403` | Not the Agent's owner in `privy` mode, or reset disabled in production without `ADMIN_TOKEN` |
| `404` | Unknown agent, project, action, or route |
| `413` | Body over 256 KB, or a knowledge `payload` over 64 KB |
| `429` | Rate limited - by this service (see above) or by the provider. Retry after `Retry-After`. |
| `500` | Unhandled server error (generic message only) |
| `502` | Upstream provider failure, malformed model output, auth failure, or unknown |
| `504` | Provider deadline exceeded |

---

## Health

### `GET /health`

Liveness probe. Never touches the provider, so it is safe as a platform health check.

```json
{
  "ok": true,
  "provider": {
    "configured": "chaingpt",
    "active": "demo",
    "degraded": true,
    "reason": "INTELLIGENCE_PROVIDER=chaingpt but CHAINGPT_API_KEY is empty; using DemoProvider.",
    "transport": "sdk"
  }
}
```

`degraded: true` means the operator asked for ChainGPT but the service fell back to the
demo provider. Clients **must** surface this — demo output may never be presented as
live ChainGPT output.

### `GET /api/internal/intelligence/health`

Deep health. Calls the provider (one 1-row news query), so it is slower and costs a
request. Use it for the diagnostics footer, not for a load-balancer probe.

```json
{
  "ok": true,
  "provider": { "configured": "chaingpt", "active": "demo", "degraded": true, "reason": "...", "transport": "sdk" },
  "providerDetail": "news reachable (1 signal(s))",
  "contextSource": "poc_fixtures",
  "storeDriver": "file",
  "signalCacheTtlSeconds": 600,
  "useCustomContext": false,
  "timeouts": { "news": 20000, "reasoning": 90000 }
}
```

`contextSource` is one of `poc_db`, `kult_api`, `poc_fixtures`.
`storeDriver` is `mongo` or `file`.

Also reachable at `/api/intelligence/health` — the router is mounted twice.

---

## Agents

### `GET /api/agents`

Agent switcher list. Live KULT creators ranked by published portfolio when a real
context source is configured; fixtures otherwise. Social stats are deliberately skipped
so listing stays fast.

```json
{ "agents": [ { "id": "did:privy:cmndit...", "name": "privy:cmndit…", "role": "KULT Create creator - ships Racing, Action experiences", "interests": [], "capabilities": [], "activity": [], "goals": [] } ] }
```

### `GET /api/agents/:agentId`

Full persistent Agent context plus accumulated counters and owned projects. Emits
`intelligence_exposed`.

```json
{
  "agent": {
    "id": "agent_kult_nova",
    "name": "Nova",
    "role": "KULT Create creator - ships Racing, Arcade experiences",
    "interests": ["Racing", "2D Racing", "AI gaming"],
    "capabilities": ["creation", "multi-title creator", "browser-featured creator"],
    "activity": ["Published 3 experiences through KULT Create", "2,412 total plays across published games"],
    "goals": ["Find distribution for published KULT Create experiences"],
    "avatarSeed": "agent_kult_nova"
  },
  "stats": { "knowledgeItems": 2, "actions": 1, "outcomes": 0, "scans": 3 },
  "projects": [ /* CreatorProject[] */ ]
}
```

`404` if the id resolves in none of the three context sources.

> `interests`, `capabilities`, `role` and `goals` are **derived** — KULT stores no such
> fields. See [kult-data-model.md](kult-data-model.md).

### `GET /api/agents/:agentId/knowledge`

Saved intelligence for one Agent, newest first.

```json
{ "knowledge": [ { "id": "kn_...", "agentId": "...", "type": "opportunity_research", "title": "...", "summary": "...", "payload": {}, "sourceProvider": "chaingpt", "sourceRefs": ["ChainGPT AI News"], "projectId": "zmftkbihiws", "createdAt": "2026-08-29T12:00:00.000Z" } ] }
```

### `POST /api/agents/:agentId/opportunities`

**The core workflow** - see [intelligence-loop.md](intelligence-loop.md). The Agent first
plans what live evidence it needs (from its latest outcome, its previous recommendation
and its goal), retrieves only that from ChainGPT AI News, reasons over it with its KULT
memory, and - on a repeat scan - explains which previous decisions it kept or changed.
Credit-spending: rate-limited, and owner-only in `privy` mode.

Request (all fields optional):

```json
{ "query": "AI gaming grants", "forceFreshSignals": true }
```

`query` (max 120 chars) becomes the first evidence need, capped at 2 words before it
reaches the News API because `searchQuery` is a literal phrase match.
`forceFreshSignals` skips the signal cache read; the fresh result is still cached.

Response (abridged):

```json
{
  "runId": "run_...",
  "provider": "chaingpt",
  "generatedAt": "2026-09-18T12:00:00.000Z",
  "query": "AI",
  "signalsUsed": 5,
  "usedKnowledgeIds": ["kn_abc"],
  "usedOutcomeIds": ["out_xyz"],
  "isRepeatScan": true,
  "previousRunId": "run_prev",
  "plan": {
    "strategy": "rules",
    "windowDays": 14,
    "needs": [
      {
        "id": "N1", "trigger": "outcome",
        "triggerRef": { "kind": "outcome", "id": "out_xyz", "label": "no response on \"Apply to the Immutable grant\"" },
        "question": "What alternatives to \"Apply to the Immutable grant\" are open right now?",
        "reason": "The last action on it ended in \"no response\", so the Agent looks for other routes instead of repeating it.",
        "phrases": ["AI gaming", "web3 gaming", "GameFi"], "quota": 2,
        "usedPhrase": "AI gaming", "evidenceIds": ["E1", "E2"], "status": "fresh", "newestAgeDays": 1
      }
    ]
  },
  "evidence": [
    {
      "id": "E1", "signalId": "50681", "needId": "N1", "title": "...", "summary": "...", "source": "...",
      "publishedAt": "2026-09-17T06:02:51.000Z", "ageDays": 1, "freshness": "fresh",
      "category": "Blockchain Gaming", "chain": "Ethereum", "seenBefore": false
    }
  ],
  "evidenceQuality": {
    "total": 5, "fresh": 3, "aging": 0, "stale": 2, "newestAgeDays": 0, "oldestAgeDays": 17,
    "windowDays": 14, "relaxedFreshness": true, "level": "mixed",
    "note": "2 of 5 articles are older than 14 days (fallback used for 1 evidence need); they carry less weight."
  },
  "opportunities": [
    {
      "id": "opp_...", "title": "...", "relevance": 88, "signal": "...", "why": "...", "opportunity": "...", "action": "...",
      "memoryInfluence": { "used": true, "knowledgeIds": ["kn_abc"], "reason": "..." },
      "liveEvidence": { "used": true, "summary": "...", "evidenceTypes": ["news"] },
      "provenance": {
        "evidence": [ { "id": "E1", "...": "...", "attribution": "cited" } ],
        "knowledge": [ { "id": "kn_abc", "title": "...", "type": "opportunity_research", "createdAt": "..." } ],
        "outcomes": [ { "id": "out_xyz", "outcomeType": "no_response", "opportunityTitle": "...", "createdAt": "..." } ]
      },
      "confidence": { "level": "high", "score": 77, "reasons": ["1 fresh ChainGPT article (7 days or newer)", "Informed by 1 recorded outcome"] },
      "decision": {
        "status": "changed", "previousLabel": "P1", "previousOpportunityId": "opp_prev1",
        "previousTitle": "Apply to the Immutable grant", "reason": "...", "attribution": "model"
      }
    }
  ],
  "decisionDelta": {
    "previousRunId": "run_prev", "previousRunAt": "...",
    "learned": { "newEvidence": [], "repeatedEvidence": 3, "knowledge": [], "actions": [], "outcomes": [] },
    "decisions": [ { "opportunityId": "opp_...", "title": "...", "status": "changed", "...": "..." } ],
    "dropped": [ { "previousLabel": "P3", "opportunityId": "...", "title": "...", "reason": "Outcome recorded: no response.", "attribution": "derived" } ],
    "counts": { "kept": 1, "changed": 1, "new": 1, "dropped": 1 },
    "summary": "Since the last scan 2 hours ago, the Agent learned 1 outcome, 1 action, 2 new ChainGPT articles. Decisions: kept 1, changed 1, added 1, dropped 1."
  }
}
```

When the model finds nothing usable, the response is still `200` with
`"opportunities": [], "empty": true, "message": "No strong opportunities found right now."`.
Never render invented filler in that case.

**Contract guarantees**

- `opportunities.length` is 0 or 3 (capped at 3, schema requires at least 1 from the model).
- `relevance` (fit) is always an integer 0-100; `confidence` (how well-supported) is
  computed by the service from provenance, never by the model, and always lists reasons.
- Every id in `provenance` and `memoryInfluence.knowledgeIds` was actually shown to the
  model. Hallucinated ids are dropped. `attribution: "matched"` means the model cited
  nothing and the service linked the best title match - the UI says so.
- `ageDays` and `freshness` come from each article's publication date: `fresh` <= 7 days,
  `aging` <= `windowDays`, `stale` beyond. `relaxedFreshness` means no in-window news
  matched some need and older articles were used.
- `decision` and `decisionDelta` exist only on repeat scans. `decisionDelta.learned` is
  computed from stored memory and retrieval - never from the model. Decisions and their
  `reason` come from a separate short decision-review call (one extra reasoning call on
  repeat scans); when it gives none, `reason` is `""` and `attribution` says why.
- `usedKnowledgeIds` / `usedOutcomeIds` are what fit into the prompt (it is compacted to
  `PROMPT_CHAR_BUDGET`), so they can be fewer than the Agent's total memory.
- `isRepeatScan` is true when the Agent has a previous scan or any saved knowledge.

### `POST /api/agents/:agentId/research`

Deep research on one selected opportunity. **Stateless on the ChainGPT side**
(`chatHistory` off): KULT is the canonical memory and the prompt carries it. Evidence is
planned from the opportunity's own names and terms (e.g. "Immutable", "grants") rather
than its first two words. Emits `opportunity_opened` then `deep_research_completed`.
Credit-spending: rate-limited, and owner-only in `privy` mode.

Request:

```json
{ "opportunity": { "id": "opp_...", "title": "...", "signal": "", "why": "", "opportunity": "", "action": "" }, "forceFreshSignals": false }
```

Only `id` and `title` are required; the rest default to `""`.

Response:

```json
{
  "provider": "chaingpt",
  "generatedAt": "...",
  "research": {
    "summary": "...", "whyNow": "...", "fitForAgent": "...",
    "liveEvidence": {
      "summary": "...",
      "items": [ { "type": "news", "evidence": "...", "sourceLabel": "ChainGPT AI News", "evidenceId": "R1", "publishedAt": "...", "ageDays": 2, "freshness": "fresh" } ],
      "confidenceNote": "..."
    },
    "recommendedActions": ["...", "...", "..."], "targets": ["..."], "growthAngle": "...", "risks": ["..."]
  },
  "plan": { "strategy": "rules", "windowDays": 14, "needs": [ { "id": "N1", "trigger": "opportunity", "...": "..." } ] },
  "evidence": [ { "id": "R1", "...": "..." } ],
  "evidenceQuality": { "level": "good", "...": "..." }
}
```

`liveEvidence.items` is frequently empty and that is a valid result. An item's
`evidenceId`/age/freshness are present only when it cites an article actually retrieved.

### `POST /api/agents/:agentId/knowledge`

Persists intelligence into Agent memory. **This is what closes the loop** — the next
scan for this Agent will inject it. Emits `knowledge_saved`. Returns `201`.

```json
{
  "type": "opportunity_research",
  "title": "Immutable AI-native games grant track",
  "summary": "Grant track bundles distribution with funding...",
  "payload": { "opportunity": {}, "research": {} },
  "sourceProvider": "chaingpt",
  "sourceRefs": ["ChainGPT AI News"],
  "projectId": "zmftkbihiws"
}
```

`type` is one of `opportunity_research`, `creator_growth_plan`, `partner_research`,
`ecosystem_research`, `action_summary`, `outcome_summary`.
`title` (max 300) and `summary` (max 4000) are required and non-empty. `payload` is opaque,
stored as-is, and capped at 64 KB (`413` beyond).

If the write fails the request fails. Never report a save the service did not make.

### `POST /api/agents/:agentId/actions`

Records that a recommended action was taken. Emits `recommended_action_taken`. `201`.

```json
{ "opportunityId": "opp_...", "opportunityTitle": "...", "runId": "run_...", "actionType": "applied_to_program", "status": "taken", "metadata": {} }
```

`actionType`: `contacted_ecosystem` · `applied_to_program` · `created_campaign` ·
`researched_partner` · `added_to_pipeline` · `dismissed`.
`status`: `taken` (default) · `pending` · `dismissed`.
`runId` (optional) links the action to the scan that surfaced it. `404` if the Agent does
not exist.

### `POST /api/agents/:agentId/outcomes`

Records what actually happened. Emits `outcome_recorded`. `201`.

```json
{ "actionId": "act_...", "outcomeType": "conversation_started", "value": "", "notes": "Replied within a day" }
```

`outcomeType`: `no_response` · `conversation_started` · `partnership_opportunity` ·
`campaign_launched` · `players_acquired` · `not_relevant` · `other`.
`actionId` must be an action of **this** Agent (`404` otherwise): the outcome -> action ->
recommendation chain is what provenance and the Decision Delta rest on.

### `GET /api/agents/:agentId/actions`

Actions with their recorded outcomes nested, newest first.

```json
{ "actions": [ { "id": "act_...", "opportunityTitle": "...", "actionType": "applied_to_program", "status": "taken", "createdAt": "...", "outcomes": [ { "id": "out_...", "outcomeType": "conversation_started" } ] } ] }
```

---

## Projects

### `GET /api/projects`

Project switcher list — up to 60 published KULT Create experiences.

### `GET /api/projects/:projectId`

```json
{
  "project": {
    "id": "zmftkbihiws",
    "ownerAgentId": "did:privy:...",
    "title": "Neon 2D Racing",
    "description": "Composed from real gameplay fields or the creator's own design doc.",
    "category": "Racing",
    "tags": ["Racing", "2D Racing", "template-built", "KULT Create"],
    "audience": ["Arcade and racing players"],
    "goals": ["Distribution beyond the KULT native audience"],
    "publishedAt": "2026-07-16T11:20:00.000Z",
    "thumbnailUrl": "https://cdn.kult.../thumb.png",
    "playPath": "/play?gameId=zmftkbihiws",
    "build": { "tier": "template", "templateId": "racing", "generatedIn": "15s", "reliability": "90%" },
    "stats": { "plays": 2412, "likes": 88, "shares": 12, "comments": 4, "favorites": 9, "featured": true }
  },
  "owner": { /* Agent */ },
  "savedGrowthPlans": 1
}
```

`stats` carries **only counters KULT actually stores**. There is no `avgSessionMin` —
KULT records plays, not durations, and a synthesised figure sitting next to real numbers
would be a lie. `audience` and `goals` are derived.

### `POST /api/projects/:projectId/grow`

Creator growth intelligence for a published experience. Body: optional
`{ "forceFreshSignals": true }`. Emits `creator_growth_plan_generated`. Credit-spending:
rate-limited, and owner-only (the project's owning Agent) in `privy` mode. The response also
carries `evidence` (G-numbered, with ages) and `evidenceQuality`.

```json
{
  "provider": "chaingpt",
  "projectId": "zmftkbihiws",
  "generatedAt": "2026-08-29T12:00:00.000Z",
  "growth": {
    "opportunities": [ { "id": "gopp_...", "title": "...", "relevance": 84, "why": "...", "targets": ["..."], "growthAngle": "...", "action": "..." } ],
    "campaignBrief": { "positioning": "...", "firstAction": "..." }
  }
}
```

Returns `404` if the project or its owning Agent cannot be resolved. Growth plans are
saved against the **owning Agent**, not a separate creator store — that is what makes
the history tab one knowledge graph.

---

## Intelligence

### `GET /api/intelligence/history/:agentId`

The combined knowledge graph: scans, knowledge, actions and outcomes on one timeline,
newest first, across both Agent discovery and KULT Create growth. A `scan` entry's
`detail` is its Decision Delta summary (or, for a first scan, what it produced), and its
`meta` carries `counts`, `evidenceLevel` and `needs`.

```json
{
  "agentId": "agent_kult_nova",
  "timeline": [
    { "kind": "knowledge", "id": "kn_...", "at": "...", "title": "...", "detail": "...", "meta": { "type": "opportunity_research", "provider": "chaingpt", "projectId": null } },
    { "kind": "action", "id": "act_...", "at": "...", "title": "...", "detail": "Action: applied to program", "meta": { "actionType": "applied_to_program", "status": "taken" } },
    { "kind": "outcome", "id": "out_...", "at": "...", "title": "conversation started", "detail": "", "meta": { "outcomeType": "conversation_started", "actionId": "act_..." } }
  ],
  "summary": { "knowledgeItems": 2, "actions": 1, "outcomes": 1, "scans": 3, "memoryInfluencedScans": 2 }
}
```

`memoryInfluencedScans` counts runs where at least one opportunity declared memory
influence — the single number that proves the loop worked.

### `GET /api/internal/intelligence/metrics`

POC instrumentation. Returns the KPIs below plus the last 60 events. Keys, grouped:

- **Reach:** `uniqueAgentsUsingIntelligence`, `uniqueClients` (from `x-kult-client-id`),
  `uniqueAuthenticatedUsers` (privy mode).
- **ChainGPT usage:** `chaingptCalls`, `chaingptNewsCalls`, `chaingptChatCalls`,
  `chaingptFailedCalls`, `estimatedCreditsSpent` - every attempt is counted, retries
  included; credits are **estimated** from the `CHAINGPT_CREDITS_PER_*` rates.
- **Loop:** `opportunityScans`, `repeatIntelligenceScans`, `deepResearchSessions`,
  `savedKnowledgeItems`, `memoryInfluencedRecommendations`, `memoryInformedScans`,
  `decisionDeltas`, `decisionsKept`, `decisionsChanged`, `decisionsDropped`, `creatorGrowthPlans`.
- **Conversion:** `recommendationsSurfaced`, `recommendationsActedOn` (distinct, dismissals
  excluded), `recommendedActionsTaken`, `recordedOutcomes`, `positiveOutcomes`,
  `recommendationToActionRate`, `recommendationToOutcomeRate`, `actionToOutcomeRate`.
- **Health:** `rateLimitedRequests`, `errors`, `totalEvents`.

```json
{
  "metrics": {
    "uniqueAgentsUsingIntelligence": 2,
    "opportunityScans": 4,
    "deepResearchSessions": 2,
    "savedKnowledgeItems": 3,
    "repeatIntelligenceScans": 3,
    "memoryInfluencedRecommendations": 2,
    "creatorGrowthPlans": 1,
    "recommendedActionsTaken": 1,
    "recordedOutcomes": 1,
    "recommendationToActionRate": 0.083,
    "errors": 0,
    "totalEvents": 21
  },
  "recentEvents": [ { "id": "evt_...", "name": "opportunity_scan_completed", "agentId": "...", "timestamp": "...", "metadata": {} } ]
}
```

### `POST /api/intelligence/reset`

**Destructive.** Clears knowledge, runs, actions, outcomes, events and provider-call
accounting. Agents and projects are kept. Used to get a clean state before recording the
showcase. Requires `x-admin-token` matching `ADMIN_TOKEN`; with no token configured it is
allowed only outside `NODE_ENV=production` (`403` in production).

```json
{ "ok": true, "message": "Accumulated intelligence cleared. Agents and projects kept." }
```

> Reachable at both `/api/intelligence/reset` and `/api/internal/intelligence/reset`;
> the admin gate applies to both.

---

## Event vocabulary

Every event written by the service, in the order a full showcase run emits them:

| Event | Emitted by |
|---|---|
| `intelligence_exposed` | `GET /api/agents/:id` |
| `opportunity_scan_started` | discovery, before retrieval |
| `repeat_intelligence_scan` | discovery, when a previous scan or prior knowledge exists |
| `memory_influenced_result` | discovery, when a card declares memory influence |
| `decision_delta_generated` | discovery on a repeat scan, with kept/changed/new/dropped counts |
| `opportunity_scan_completed` | discovery, after persistence |
| `opportunity_opened` | research request received |
| `deep_research_completed` | research parsed successfully |
| `knowledge_saved` | knowledge persisted |
| `recommended_action_taken` | action recorded |
| `outcome_recorded` | outcome recorded |
| `creator_growth_plan_generated` | growth plan parsed successfully |
| `request_rate_limited` | a request refused by a rate limit, with its scope |
| `intelligence_error` | any intelligence failure, with its category |

Events carry `clientId` (from `x-kult-client-id`) and, in `privy` mode, `userId`.
Provider calls are recorded separately (`poc_provider_calls`), one per attempt.
