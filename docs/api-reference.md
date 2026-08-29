# API reference

Base URL: `http://localhost:8787` in development.
All request and response bodies are JSON. Request bodies are capped at 1 MB.
There is **no authentication** — see [audit.md](audit.md) before exposing this publicly.

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
| `402` | ChainGPT account out of credits. Never retry. |
| `404` | Unknown agent, project, or route |
| `429` | Provider rate limited. Retry after a moment. |
| `500` | Unhandled server error (generic message only) |
| `502` | Upstream provider failure, malformed model output, auth failure, or unknown |
| `504` | Provider deadline exceeded |

> **Known defect:** invalid request bodies currently return `502` with the generic
> "Intelligence is temporarily unavailable" message instead of `400` with the Zod
> issues. See [audit.md](audit.md) finding A-2.

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

**The core workflow.** Retrieves current ChainGPT signals, injects KULT context and
saved memory, and returns exactly 3 ranked opportunities.

Request (all fields optional):

```json
{ "query": "AI gaming grants", "forceFreshSignals": true }
```

`query` overrides the derived search phrase and is honoured verbatim — capped at 2 words
before it reaches the News API, because `searchQuery` is a literal phrase match.

Response:

```json
{
  "runId": "run_...",
  "provider": "chaingpt",
  "generatedAt": "2026-08-29T12:00:00.000Z",
  "query": "AI gaming",
  "signalsUsed": 6,
  "usedKnowledgeIds": ["kn_abc", "kn_def"],
  "isRepeatScan": true,
  "opportunities": [
    {
      "id": "opp_...",
      "title": "Apply to the Immutable AI-native games grant track",
      "relevance": 92,
      "signal": "Immutable opened a grants track aimed at AI-driven game studios.",
      "why": "This Agent already ships agent-driven experiences and needs distribution more than capital.",
      "opportunity": "The track bundles distribution support with funding.",
      "action": "Draft a one-page submission leading with retention numbers.",
      "memoryInfluence": {
        "used": true,
        "knowledgeIds": ["kn_abc"],
        "reason": "Builds on prior research into ecosystem programmes — the next step moves from scanning to submitting."
      },
      "liveEvidence": { "used": true, "summary": "...", "evidenceTypes": ["news"] }
    }
  ]
}
```

When the model finds nothing usable, the response is still `200`:

```json
{ "...": "...", "opportunities": [], "empty": true, "message": "No strong opportunities found right now." }
```

Never render invented filler in that case.

**Contract guarantees**

- `opportunities.length` is 0 or 3 (capped at 3, schema requires at least 1 from the model).
- `relevance` is always an integer 0–100, even when the model answers `"High"`.
- `memoryInfluence.knowledgeIds` only ever contains ids this service actually injected.
  A hallucinated id can never become a memory badge.
- `usedKnowledgeIds` is what was injected; `memoryInfluence.knowledgeIds` is what the
  model claimed and the service verified. They can legitimately differ.
- `isRepeatScan` is true whenever the Agent already had any saved knowledge.

### `POST /api/agents/:agentId/research`

Deep research on one selected opportunity. Runs in an isolated multi-turn thread keyed
per Agent + opportunity, so follow-ups have continuity without leaking across
opportunities. Emits `opportunity_opened` then `deep_research_completed`.

Request:

```json
{ "opportunity": { "id": "opp_...", "title": "...", "signal": "", "why": "", "opportunity": "", "action": "" } }
```

Only `id` and `title` are required; the rest default to `""`.

Response:

```json
{
  "provider": "chaingpt",
  "generatedAt": "2026-08-29T12:00:00.000Z",
  "research": {
    "summary": "...",
    "whyNow": "...",
    "fitForAgent": "...",
    "liveEvidence": {
      "summary": "...",
      "items": [ { "type": "news", "evidence": "...", "sourceLabel": "ChainGPT AI News" } ],
      "confidenceNote": "..."
    },
    "recommendedActions": ["...", "...", "..."],
    "targets": ["Immutable ecosystem team"],
    "growthAngle": "...",
    "risks": ["..."]
  }
}
```

`liveEvidence.items` is frequently empty and that is a valid result — the prompt
instructs the model to return an empty array and explain in `confidenceNote` rather than
manufacture a source. Render the note, not a placeholder.

`type` is constrained to `news | on-chain | market | social`; anything else is coerced
to `news`.

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
`title` and `summary` are required and non-empty. `payload` is opaque and stored as-is.

If the write fails the request fails. Never report a save the service did not make.

### `POST /api/agents/:agentId/actions`

Records that a recommended action was taken. Emits `recommended_action_taken`. `201`.

```json
{ "opportunityId": "opp_...", "opportunityTitle": "...", "actionType": "applied_to_program", "status": "taken", "metadata": {} }
```

`actionType`: `contacted_ecosystem` · `applied_to_program` · `created_campaign` ·
`researched_partner` · `added_to_pipeline` · `dismissed`.
`status`: `taken` (default) · `pending` · `dismissed`.

Note: unlike the other agent routes, this one does **not** verify the Agent exists.

### `POST /api/agents/:agentId/outcomes`

Records what actually happened. Emits `outcome_recorded`. `201`.

```json
{ "actionId": "act_...", "outcomeType": "conversation_started", "value": "", "notes": "Replied within a day" }
```

`outcomeType`: `no_response` · `conversation_started` · `partnership_opportunity` ·
`campaign_launched` · `players_acquired` · `not_relevant` · `other`.

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

Creator growth intelligence for a published experience. Empty body. Emits
`creator_growth_plan_generated`.

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

The combined knowledge graph: knowledge, actions and outcomes on one timeline, newest
first, across both Agent discovery and KULT Create growth.

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

POC instrumentation. Returns all twelve KPIs plus the last 60 events.

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

**Destructive.** Clears knowledge, runs, actions, outcomes and events. Agents and
projects are kept. Used to get a clean state before recording the showcase.

```json
{ "ok": true, "message": "Accumulated intelligence cleared. Agents and projects kept." }
```

> Unauthenticated, and reachable at both `/api/intelligence/reset` and
> `/api/internal/intelligence/reset`. See [audit.md](audit.md) finding A-1.

---

## Event vocabulary

Every event written by the service, in the order a full showcase run emits them:

| Event | Emitted by |
|---|---|
| `intelligence_exposed` | `GET /api/agents/:id` |
| `opportunity_scan_started` | discovery, before retrieval |
| `repeat_intelligence_scan` | discovery, when prior knowledge exists |
| `opportunity_scan_completed` | discovery, after persistence |
| `memory_influenced_result` | discovery, when a card declares memory influence |
| `opportunity_opened` | research request received |
| `deep_research_completed` | research parsed successfully |
| `knowledge_saved` | knowledge persisted |
| `recommended_action_taken` | action recorded |
| `outcome_recorded` | outcome recorded |
| `creator_growth_plan_generated` | growth plan parsed successfully |
| `intelligence_error` | any intelligence failure, with its category |
