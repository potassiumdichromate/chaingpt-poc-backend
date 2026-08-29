# Operations

Deploying, monitoring, and running the showcase.

---

## 1. Build and run

```bash
npm install
npm run build     # tsc -p tsconfig.build.json  ->  dist/
npm start         # node dist/index.js
```

Two TypeScript configs, on purpose:

| Config | Used by | `rootDir` | Includes | Emits |
|---|---|---|---|---|
| `tsconfig.json` | `npm run typecheck` | `.` | `src/**`, `scripts/**` | nothing (`--noEmit`) |
| `tsconfig.build.json` | `npm run build` | `src` | `src/**`, minus `__tests__` | `dist/*.js`, flat |

The build config exists because compiling `src` and `scripts` together makes tsc
preserve the folder structure and emit `dist/src/index.js`, which `npm start` does not
resolve. `tsconfig.build.json` narrows the root to `src` so output lands flat in `dist/`
and no tests or scripts ship to production.

Requires **Node 20+** — the entrypoint uses top-level `await`, and the REST transport
uses `AbortSignal.timeout()`.

## 2. Deployment

Standard Node web service. Nothing platform-specific in the code.

```yaml
build:  npm install && npm run build
start:  npm run start
health: GET /health
```

The server binds `config.port` on all interfaces, so an injected `PORT` works unmodified.

### Deployment checklist

- [ ] `PORT` provided by the platform, or set explicitly
- [ ] `CORS_ORIGIN` includes the deployed frontend origin exactly
- [ ] `CHAINGPT_API_KEY` set as a secret, not in the image
- [ ] `CHAINGPT_USE_CUSTOM_CONTEXT` set **explicitly** (the code default is `true`)
- [ ] `REASONING_TIMEOUT_MS=75000` set explicitly (the code default is `90000`)
- [ ] `MONGODB_URI` set — otherwise all accumulated intelligence is lost on restart
- [ ] `MONGODB_DB_NAME` is a POC database, never a KULT production name
- [ ] `KULT_API_BASE` blank unless KULT is reachable from this environment
- [ ] `LOG_LEVEL=info` — `debug` logs raw model text
- [ ] Any proxy or CDN in front allows requests to run 75s+ without cutting the connection
- [ ] Reset endpoint is not reachable from the public internet (see §6)

### Storage durability

**The file driver does not survive a container restart.** On Render, Fly, Cloud Run, or
any container without a mounted volume, `${DATA_DIR}/store.json` lives on an ephemeral
filesystem. Every deploy and every restart wipes knowledge, actions, outcomes and events
— which deletes the memory loop, the one thing the demo exists to show.

Set `MONGODB_URI` for any deployment that will be demoed more than once.

### Single instance only

The whole store is held in memory and written back wholesale on every mutation. Two
instances would each hold a divergent copy and last-write-wins would silently discard
the other's data. Run **one instance** (`WEB_CONCURRENCY=1`, no horizontal scaling)
until the store is replaced with a per-record adapter.

---

## 3. Health and monitoring

| Endpoint | Cost | Use for |
|---|---|---|
| `GET /health` | free | Platform liveness/readiness probe |
| `GET /api/internal/intelligence/health` | 1 provider call | Diagnostics, the client footer |
| `GET /api/internal/intelligence/metrics` | free | KPIs and the last 60 events |

**Alert on these two:**

```jsonc
{"level":"warn","msg":"SHOWCASE WARNING: running on the demo provider"}  // key missing
{"level":"error","msg":"store_write_failed"}                             // data at risk
```

**Watch for these:**

| Log | Means |
|---|---|
| `provider_call_failed` with `category: insufficient_credits` | Top up. Nothing will work until you do. |
| `repeat_scan_without_memory_influence` | The P0 moment did not fire, even after enforcement |
| `structured_output_unrecoverable` | Both parse attempts failed; the user saw an error |
| `prompt_degraded_after_failure` | Prompt size is at the edge of ChainGPT's budget |
| `signals_unavailable_continuing` | News retrieval failed; the scan ran on KULT context alone |
| `signal_query_fallback` | The primary phrase returned nothing and a broader one was used |
| `kult_api_unreachable` | KULT context degraded to the next source |
| `store_corrupt_reseeding` | The store file was unparseable and was reset |

Logs are single-line JSON on stdout (`console.log`) and stderr (`warn`/`error`), ready
for any log aggregator. Every provider call logs `provider_call_ok` or
`provider_call_failed` with `label`, `attempt`, `latencyMs` and `category` — that is the
latency and failure feed.

---

## 4. Showcase runbook

**Before recording**

1. `POST /api/intelligence/reset` (or the button on the POC Metrics tab).
2. `VITE_SHOW_DEBUG_TAB=false` in the frontend.
3. `GET /health` → confirm `active: "chaingpt"` and `degraded: false`.
4. `npm run smoke` → confirm credits and the API contract.
5. `npm run verify` → confirm the full P0 flow.
6. Confirm the ChainGPT balance covers ~10 credits per run, with headroom.

**The 90-second script**

| Time | Action | Line |
|---|---|---|
| 0–10s | Agent Intelligence tab | "A persistent KULT Agent with its own activity, goals and accumulated knowledge." |
| 10–25s | Discover opportunities | "ChainGPT brings current Web3 intelligence. KULT decides what matters to *this* Agent." |
| 25–40s | Research one | "The signal becomes a personalized action plan, not a news summary." |
| 40–50s | Save to Agent knowledge | "This becomes part of the Agent's persistent knowledge." |
| 50–65s | **Discover again** | "Builds on previous Agent knowledge — prior research now shapes the next recommendation." |
| 65–82s | KULT Create Growth → Grow | "Same intelligence layer, helping a creator find distribution." |
| 82–90s | Intelligence History | "ChainGPT gives KULT Agents real-time Web3 awareness. KULT turns it into actions and accumulated knowledge." |

**If something goes wrong mid-demo**

| Symptom | Cause | Do |
|---|---|---|
| "Out of credits" banner | Balance exhausted | Top up; nothing else will help |
| Demo-provider banner | Key missing or unset | Set `CHAINGPT_API_KEY`, restart |
| "No strong opportunities" | Signals returned nothing usable | Re-run; the phrase fallback walk usually resolves it |
| No memory badge on rescan | Enforcement also failed | The client says so honestly. Save a second research item and rescan |
| Cards missing after a save | Store write failed | Check `store_write_failed`; verify `MONGODB_URI` or `DATA_DIR` is writable |
| 60s timeouts on a 75s budget | A proxy in front is cutting the connection | Raise the edge timeout |

---

## 5. Cost control

Levers, most effective first:

1. `SIGNAL_CACHE_TTL` — raise it to reuse news across scans.
2. `SIGNAL_LIMIT` in `signals.ts` (6) — smaller prompts appear to cost less.
3. Avoid the deep health endpoint on a timer; it spends a request each call.
4. Prevent unauthenticated access — every POST spends credits (see §6).

Already in place: no retry on credit or auth failures, a single repair attempt, the
~5k prompt bound, and the memory-enforcement pass only running when the main path missed.

---

## 6. Security posture

**There is no authentication on any endpoint.** For a local POC that is fine. For
anything reachable from the internet it is not:

- `POST /api/intelligence/reset` **deletes all accumulated intelligence**, unauthenticated,
  at two paths (`/api/intelligence/reset` and `/api/internal/intelligence/reset`).
- Every `POST` that reaches the provider **spends ChainGPT credits**, with no rate limit.
- `GET /api/internal/intelligence/metrics` exposes internal instrumentation.
- `GET /api/agents` and `GET /api/projects` enumerate real KULT creators and games.

Minimum before public exposure: put the service behind auth or an allowlist, or at
minimum gate `/api/intelligence/reset` and rate-limit the three provider-spending
endpoints per IP. See [audit.md](audit.md) finding A-1.

What the service already gets right: the ChainGPT key never leaves the server; raw
provider errors and raw model text never cross the HTTP boundary; the terminal error
handler returns a generic message; request bodies are capped at 1 MB; and the store
refuses to run against a KULT production database name.

---

## 7. Graceful shutdown

`SIGINT` and `SIGTERM` stop accepting connections, close the Mongo client, and exit 0.
Without the explicit close the process lingers on the open Mongo socket.

In-flight reasoning calls are **not** awaited on shutdown — a deploy during an active
scan drops that request. Given a 75s reasoning budget, drain your platform's traffic
before terminating if that matters.
