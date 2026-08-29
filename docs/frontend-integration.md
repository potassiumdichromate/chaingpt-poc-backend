# Frontend integration

Everything a client needs to talk to this service correctly. The reference client is the
React + Vite app in `frontend/` of the POC monorepo; this guide is written so any client
(React, Next.js, Vue, a KULT production surface) can be built against the same contract.

---

## 1. Wiring up

### Environment

Only public values belong in a browser bundle. **The ChainGPT key is server-side and
must never appear in frontend env, source, or network calls.**

```bash
VITE_API_BASE_URL=http://localhost:8787
VITE_DEFAULT_AGENT_ID=did:privy:cmnditqy301kl0cjrbm20d737
VITE_DEFAULT_PROJECT_ID=zmftkbihiws
VITE_SHOW_DEBUG_TAB=false     # true only for internal builds
```

Anything the browser needs comes from the API. Anything secret stays behind it.

### CORS

The backend reflects `CORS_ORIGIN` (comma-separated, `credentials: true`), defaulting to
`http://localhost:5173`. A deployed frontend on any other origin will be blocked until
`CORS_ORIGIN` includes it exactly — scheme, host and port, no trailing slash.

```bash
CORS_ORIGIN=https://kult-poc.vercel.app,http://localhost:5173
```

A CORS failure surfaces in the client as a *network* error (the fetch rejects), not as
an HTTP status. Handle it as "cannot reach the service", which is what the reference
client does.

### A minimal client

```ts
const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

export class ApiError extends Error {
  constructor(message: string, readonly category = 'unknown', readonly retryable = true) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // Network, DNS, or CORS. There is no status to read.
    throw new ApiError('Cannot reach the intelligence service. Is the backend running?', 'network');
  }

  if (!res.ok) {
    let message = 'Intelligence is temporarily unavailable. Try again.';
    let category = 'unknown';
    let retryable = true;
    try {
      const body = await res.json();
      message = body?.error?.message ?? message;
      category = body?.error?.category ?? category;
      retryable = body?.error?.retryable ?? true;
    } catch { /* non-JSON error body — keep the generic message */ }
    throw new ApiError(message, category, retryable);
  }
  return res.json() as Promise<T>;
}
```

Two rules this encodes, both load-bearing:

1. **Render `error.message` verbatim.** It is written to be user-safe and
   category-appropriate. Do not substitute your own copy — you will lose the "top up
   credits" distinction, which is the difference between an operator fixing the problem
   in a minute and a user retrying pointlessly for ten.
2. **Respect `retryable`.** `false` means no retry can succeed. Hide the retry button.

### Timeouts

Reasoning calls legitimately take 30–75 seconds. Do not impose a client timeout shorter
than the server's `REASONING_TIMEOUT_MS`, and do not let a proxy or CDN in front of the
API cut the connection earlier — a 60-second edge timeout in front of a 75-second
backend produces a confusing 504 that the client cannot distinguish from a real one.

---

## 2. Boot sequence

On mount, in parallel:

```ts
api.getAgent(agentId)  // context, counters, owned projects  -> renders the shell
api.health()           // provider status                    -> renders the degraded banner
api.listAgents()       // switcher                           -> optional
```

`getAgent` failing is fatal for the screen (show a boot error). `health` failing is not
— degrade to hiding the banner.

**The degraded banner is not optional.** If `health.provider.active === 'demo'`, the UI
must say so:

```tsx
{health?.provider.active === 'demo' && (
  <div className="banner banner-warn">
    Running on the <strong>local demo provider</strong> — this is not live ChainGPT output.
    {health.provider.degraded && ' Set CHAINGPT_API_KEY in backend/.env to run live.'}
  </div>
)}
```

Demo output being mistaken for live intelligence is the one failure mode that would
misrepresent the partner. The backend reports it; the client must show it.

---

## 3. The five flows

### Flow 1 — Discover opportunities

```ts
setScanning(true);
try {
  const run = await api.discover(agentId);      // POST .../opportunities
  setRun(run);
} catch (err) {
  setScanError(err as ApiError);
} finally {
  setScanning(false);
  onIntelligenceChanged();                       // counters moved; refresh the shell
}
```

Handle three distinct render states, not two:

| State | Condition | Render |
|---|---|---|
| Results | `run && !run.empty` | The cards, plus a provenance banner |
| Honest empty | `run.empty === true` | "No strong opportunities found right now" |
| Error | `scanError` | `ErrorState` with the message and retry rules |

The provenance banner is what makes the demo legible — say where the intelligence came
from, in numbers:

```tsx
<strong>{run.opportunities.length} opportunities</strong> from{' '}
<strong>{run.signalsUsed} live ChainGPT signals</strong>
{run.usedKnowledgeIds.length > 0 && <> · <strong>{run.usedKnowledgeIds.length} saved knowledge item(s)</strong> injected</>}
{memoryCount > 0 && <> · <strong>{memoryCount}</strong> built on previous knowledge</>}
```

**And say when the loop did not fire.** If `run.isRepeatScan` is true but no card
declared memory influence, show a warning rather than hiding it:

> This Agent has saved knowledge and it was sent to ChainGPT, but no recommendation
> declared it as an influence on this run.

Silently hiding that would make a broken loop look like a working one.

### Flow 2 — Deep research

```ts
const res = await api.research(agentId, opportunity);
setResearch({ research: res.research, provider: res.provider });
```

Send only the six opportunity fields the endpoint reads (`id`, `title`, `signal`, `why`,
`opportunity`, `action`) — not the whole card object.

Render `liveEvidence` as a **visually distinct, explicitly attributed block**. When
`items` is empty, render `confidenceNote` or a plain "no meaningful live evidence"
line. Never render a placeholder source. The absence of evidence is information.

### Flow 3 — Save to Agent knowledge (the loop)

```ts
await api.saveKnowledge(agentId, {
  type: 'opportunity_research',
  title: opportunity.title,
  summary: research.summary,
  payload: { opportunity, research },
  sourceProvider: provider,
  sourceRefs: research.liveEvidence.items.map((i) => i.sourceLabel),
});
```

Model save state as `idle | saving | saved | error` — never optimistically. If the
request fails, say so **and keep the research on screen** so the user can retry without
losing it:

```tsx
{saveState === 'error' && (
  <div className="banner banner-error">
    {saveError} — the research above is still on screen, so you can retry without losing it.
  </div>
)}
```

After a successful save, tell the user what it bought them: *"Next scan will use this."*
That sentence is the product.

### Flow 4 — Action and outcome

Two dependent steps. `recordAction` returns `action.id`; the outcome form only appears
once you hold that id. Both feed the Agent's memory and the metrics.

### Flow 5 — Creator growth

`api.grow(projectId)` returns the plan. Saving it calls the **same** `saveKnowledge`
endpoint against the **owning Agent** with `type: 'creator_growth_plan'` and
`projectId` set. That shared knowledge layer is what makes the history timeline one
graph instead of two — do not add a separate creator-knowledge store.

---

## 4. State model

The reference app uses one shared `refreshKey` counter:

```ts
const [refreshKey, setRefreshKey] = useState(0);
const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
```

Every mutating call ends with `refresh()`. Tabs that read accumulated state
(`IntelligenceHistory`, `DebugPanel`) take `refreshKey` as a dependency and re-fetch.

Two subtleties worth copying:

```ts
// Switching creator clears the Agent, so the loading state is honest.
useEffect(() => { setEnvelope(null); setBootError(''); }, [agentId]);

// NOT keyed on refreshKey: a post-save refresh must not unmount the active tab,
// or the opportunity cards on screen would be thrown away.
useEffect(() => { api.getAgent(agentId).then(setEnvelope).catch(...); }, [refreshKey, agentId]);
```

Scan results live in component state and are intentionally not persisted client-side.
Re-running a scan costs credits; losing the cards on a tab switch is worse than the
memory footprint of keeping them.

---

## 5. Error handling matrix

| `category` | HTTP | Retry button | Copy to lead with |
|---|---|---|---|
| `network` | — | yes | "Cannot reach the intelligence service. Is the backend running?" |
| `insufficient_credits` | 402 | **no** | "ChainGPT account out of credits" — this is an operator action |
| `auth` | 502 | **no** | The server's generic message |
| `rate_limit` | 429 | yes | "Intelligence is busy right now." |
| `timeout` | 504 | yes | "Taking longer than expected." |
| `upstream_5xx` | 502 | yes | "Temporarily unavailable." |
| `malformed_output` | 502 | yes | "We could not build a clean result." |
| `unknown` | 502 | yes | Generic |

```tsx
const isCredits = category === 'insufficient_credits';
const showRetry = retryable && !isCredits && onRetry;
```

Credits get their own headline because it is the only failure a *user* cannot resolve
and an *operator* can, in about a minute.

---

## 6. Long-running calls

Reasoning takes tens of seconds. A spinner alone reads as a frozen screen. Use stepped
progressive loading — advance a caption every ~2.6s and stop at the last step:

```tsx
const DISCOVER_STEPS = ['Scanning current Web3 signals…', 'Matching against Agent context…', 'Ranking opportunities…'];
const RESEARCH_STEPS = ['Analyzing opportunity…', 'Checking current signals…', 'Building action plan…'];
const GROW_STEPS     = ['Analyzing experience…', 'Matching ecosystem opportunities…', 'Building growth plan…'];
```

The steps should describe what the backend is genuinely doing in that order. Do not
invent stages that do not exist.

---

## 7. Rendering rules that are not cosmetic

These exist because breaking them would misrepresent the data.

**Memory badge.** Render `BUILDS ON PREVIOUS AGENT KNOWLEDGE` **only** when
`memoryInfluence.used === true`, and render `memoryInfluence.reason` next to it. The
backend already guarantees the cited ids were genuinely injected. Never infer the badge
from `usedKnowledgeIds.length > 0` — that is what was *sent*, not what *influenced*.

**Live evidence.** Only render items the backend returned. Empty is a valid, meaningful
result. No placeholder sources, no "source: ChainGPT" on an item that has none.

**Project stats.** Render only the counters present in `stats`. `likes`, `shares`,
`comments` and `favorites` are `undefined` when KULT holds no value — do not coerce
them to `0`, which would assert a real zero. There is no session-length field, by
design; do not add one.

**Thumbnails.** `thumbnailUrl` points at the real KULT CDN and can 404. Fall back to
initials on `onError`; never leave a broken image in a credibility demo.

**Attribution.** ChainGPT stays visibly credited in the footer, and the evidence block
says "powered by ChainGPT". The provider abstraction is an engineering detail, not
permission to genericise the partner out of the UI.

---

## 8. TypeScript contract

Copy these into the client rather than importing from the backend — the boundary is
HTTP, and coupling the two build graphs buys nothing.

```ts
export interface Agent {
  id: string; name: string; role: string;
  interests: string[]; capabilities: string[]; activity: string[]; goals: string[];
}

export interface AgentEnvelope {
  agent: Agent;
  stats: { knowledgeItems: number; actions: number; outcomes: number; scans: number };
  projects: CreatorProject[];
}

export interface MemoryInfluence { used: boolean; knowledgeIds: string[]; reason: string }

export interface Opportunity {
  id: string; title: string; relevance: number;
  signal: string; why: string; opportunity: string; action: string;
  memoryInfluence: MemoryInfluence;
  liveEvidence?: { used: boolean; summary: string; evidenceTypes: string[] };
}

export interface OpportunityRun {
  runId: string; provider: string; generatedAt: string; query: string;
  signalsUsed: number; usedKnowledgeIds: string[]; isRepeatScan: boolean;
  opportunities: Opportunity[];
  empty?: boolean; message?: string;
}

export interface DeepResearch {
  summary: string; whyNow: string; fitForAgent: string;
  liveEvidence: { summary: string; items: LiveEvidenceItem[]; confidenceNote: string };
  recommendedActions: string[]; targets: string[]; growthAngle: string; risks: string[];
}

export interface LiveEvidenceItem {
  type: 'news' | 'on-chain' | 'market' | 'social';
  evidence: string; sourceLabel: string;
}

export interface GrowthPlan {
  opportunities: GrowthOpportunity[];
  campaignBrief: { positioning: string; firstAction: string };
}

export interface HealthEnvelope {
  ok: boolean;
  provider: { configured: string; active: string; degraded: boolean; reason?: string; transport: string };
  providerDetail: string;
  contextSource: string;
}
```

Optionality matters: `liveEvidence` on an `Opportunity` is optional; `stats` counters
other than `plays` are optional; `empty`/`message` only appear on an empty run.

---

## 9. Integration checklist

- [ ] `VITE_API_BASE_URL` points at the backend; no secret is in the bundle
- [ ] `CORS_ORIGIN` on the backend includes the frontend origin exactly
- [ ] Degraded-provider banner renders when `provider.active === 'demo'`
- [ ] `error.message` rendered verbatim; `retryable: false` hides the retry button
- [ ] `insufficient_credits` gets its own headline
- [ ] Empty scan renders the honest empty state, not filler
- [ ] Repeat scan with no memory influence shows the warning
- [ ] Memory badge keyed on `memoryInfluence.used`, with the reason
- [ ] Save failures keep the result on screen and never claim persistence
- [ ] No client timeout shorter than `REASONING_TIMEOUT_MS`
- [ ] Progressive loading steps for every call over ~2s
- [ ] ChainGPT attribution present in the footer and the evidence block
- [ ] `VITE_SHOW_DEBUG_TAB=false` for anything customer-facing
