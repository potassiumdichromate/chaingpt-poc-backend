# Configuration

Every environment variable, its **actual default in code** (`src/config.ts`), and what
it changes. Where `.env.example` and the code disagree, both are shown — that
disagreement is a real trap.

Configuration is read once at import time via `dotenv/config` and frozen into the
`config` object. Changing a variable requires a restart.

Parsing helpers treat an **empty string as absent**, so `FOO=` in a `.env` file falls
back to the default rather than setting an empty value. `bool()` accepts only `true` or
`1` as true.

---

## Server

| Variable | Code default | Notes |
|---|---|---|
| `PORT` | `8787` | Platforms that inject `PORT` (Render, Heroku, Fly) work unmodified. |
| `NODE_ENV` | `development` | `production` closes the reset endpoint unless `ADMIN_TOKEN` is set, and turns on the `AUTH_MODE=off` warning. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. `debug` logs raw model text — do not use in production. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list, trimmed. `credentials: true`. **Must be set for any deployed frontend.** |

## Provider

| Variable | Code default | Notes |
|---|---|---|
| `INTELLIGENCE_PROVIDER` | `chaingpt` | `chaingpt` \| `demo`. With `chaingpt` and no key, falls back to demo and reports `degraded: true`. |
| `CHAINGPT_API_KEY` | *(empty)* | **Server-side secret.** Never expose to a browser. Empty = degraded demo mode. |
| `CHAINGPT_TRANSPORT` | `sdk` | `sdk` (official packages) \| `rest` (documented endpoints, real `AbortSignal`). |
| `CHAINGPT_BASE_URL` | `https://api.chaingpt.org` | REST transport only. |
| `CHAINGPT_MODEL` | `general_assistant` | REST transport only — **inert** on `sdk`, which exposes no model parameter. |
| `CHAINGPT_USE_CUSTOM_CONTEXT` | **`true`** ⚠️ | `.env.example` documents `false`. See the warning below. |

> ### ⚠️ `CHAINGPT_USE_CUSTOM_CONTEXT` default mismatch
>
> `src/config.ts` defaults this to **`true`** when the variable is absent, while
> `.env.example` and the project README both document `false`.
>
> Any deployment that does not set it explicitly — a container, a PaaS dashboard, CI —
> runs with the AI Hub context **on**. With the Hub unconfigured for the key, ChainGPT
> holds the wrong prior that "KULT is a cryptocurrency built on blockchain technology",
> which poisons recommendations.
>
> **Set it explicitly in every environment.** See [audit.md](audit.md) finding A-3.

## Timeouts

| Variable | Code default | `.env.example` | Notes |
|---|---|---|---|
| `NEWS_TIMEOUT_MS` | `20000` | `20000` | AI News retrieval deadline. |
| `REASONING_TIMEOUT_MS` | **`90000`** | `75000` | ChainGPT's gateway 504s at ~80s and the SDK caps internally at 60s, so values above ~60s are advisory on the `sdk` transport. Set `75000` explicitly. |

On the `sdk` transport these bound *our wait*, not the socket — the SDK exposes no
`AbortSignal`. The `rest` transport gets a real one.

## Caching

| Variable | Code default | Notes |
|---|---|---|
| `SIGNAL_CACHE_TTL` | `600` | **Seconds** (multiplied by 1000 internally). Caches AI News results per phrase list, limit, category filter and freshness window. A request with `forceFreshSignals: true` skips the cache read; the frontend sends it on every Discover click. |

## News retrieval and prompts

| Variable | Code default | Notes |
|---|---|---|
| `NEWS_FRESHNESS_DAYS` | `14` | Articles older than this are `stale`: still usable, but flagged, down-weighted in confidence, and never presented as current. Within 7 days is `fresh`. |
| `NEWS_CATEGORY_IDS` | *(empty)* | Comma-separated ChainGPT category ids for the goal-driven evidence need. VERIFIED LIVE: `2` = Blockchain Gaming. Off by default because most gaming articles have no category. |
| `PROMPT_CHAR_BUDGET` | `4600` | Prompts are compacted to fit before sending. VERIFIED LIVE: ChainGPT stops reading a question in full between ~5.1k and ~6k characters. See [intelligence-loop.md](intelligence-loop.md). |

## Credit accounting

ChainGPT does not report usage per call, so the metrics tab **estimates** spend from these rates (1 credit = $0.01). Every attempt is counted, retries included; failed attempts count as calls but not credits.

| Variable | Code default | Notes |
|---|---|---|
| `CHAINGPT_CREDITS_PER_CHAT` | `1` | Per reasoning call. |
| `CHAINGPT_CREDITS_PER_CHAT_HISTORY` | `1` | Added when `chatHistory` is on. The service keeps it off, so this should stay unused. |
| `CHAINGPT_CREDITS_PER_NEWS` | `1` | Per AI News request. |

## Auth, abuse protection and hardening

| Variable | Code default | Notes |
|---|---|---|
| `AUTH_MODE` | `off` | `off` \| `api_key` \| `privy`. Applies to all `/api` routes; `/health` stays open. A warning is logged when `off` in production. |
| `API_KEYS` | *(empty)* | `api_key` mode: comma-separated keys accepted in `x-api-key`. The frontend sends `VITE_API_KEY`. A key in a browser bundle is public: this stops drive-by use, it is not identity. |
| `PRIVY_APP_ID` | *(empty)* | `privy` mode: the token `aud` must match. |
| `PRIVY_VERIFICATION_KEY` | *(empty)* | `privy` mode: the ES256 public key (PEM) from the Privy dashboard. `\n` sequences are converted to newlines. |
| `AUTH_REQUIRE_AGENT_OWNERSHIP` | `true` | `privy` mode: a user may only spend credits on, or write memory for, the Agent whose id is their DID. Reads stay open. |
| `ADMIN_TOKEN` | *(empty)* | Required in `x-admin-token` for `POST /reset`. When unset, reset is allowed only outside `NODE_ENV=production`. |
| `RATE_LIMIT_WINDOW_MS` | `600000` | Window for the credit-spending limits. |
| `RATE_LIMIT_SPEND_PER_CLIENT` | `20` | Scan/research/grow requests per client (user in privy mode, else IP) per window. |
| `RATE_LIMIT_SPEND_GLOBAL` | `200` | Scan/research/grow requests across all clients per window: a hard cost ceiling. |
| `RATE_LIMIT_API_PER_MINUTE` | `240` | Any `/api` request per client per minute. |
| `TRUST_PROXY` | `0` | Proxy hop count behind a load balancer, so `req.ip` and the per-client limits see the real client. |

Limits are in-memory, like the store's read cache: this is a single-instance service.

## KULT context source

| Variable | Code default | Notes |
|---|---|---|
| `KULT_API_BASE` | *(empty)* | e.g. `http://localhost:3001/api`. Setting it enables the live path. |
| `KULT_AUTH_SECRET` | *(empty)* | Bearer token. Without it, `/games/list?creatorId=` returns 403 and the client pages the public catalog and filters locally. |

> `.env.example` ships `KULT_API_BASE=http://localhost:3001/api`. Copied verbatim to a
> deployed environment, every context read attempts an unreachable host and burns the
> 10s/45s client timeouts before falling back. **Leave it blank unless KULT is actually
> reachable from that environment.** See [audit.md](audit.md) finding A-4.

## Storage

| Variable | Code default | Notes |
|---|---|---|
| `DATA_DIR` | `./data` | Resolved against `process.cwd()`. Used only by the file driver. |
| `MONGODB_URI` | *(empty)* | Presence selects the mongo driver. Empty = file driver. Each record is its own document in a per-type collection (`poc_knowledge`, `poc_runs`, `poc_actions`, `poc_outcomes`, `poc_events`, `poc_provider_calls`, ...). On first start the legacy single-document store (`poc_state`) is copied over once, guarded by a marker in `poc_meta`, and left untouched. |
| `MONGODB_DB_NAME` | `poc` | **Must not** be a KULT production database name — the service refuses to start against `prompt_creator_studio`, `creator_studio`, or `kult`. Same cluster is fine. |

---

## Frontend variables

Separate file (`frontend/.env`), browser-visible, `VITE_` prefix only. **No secrets.**

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8787` | Backend origin. |
| `VITE_API_KEY` | *(empty)* | Sent as `x-api-key` when the backend runs `AUTH_MODE=api_key`. Public by nature. |
| `VITE_DEFAULT_AGENT_ID` | `agent_kult_nova` | Any id from `GET /api/agents`. |
| `VITE_DEFAULT_PROJECT_ID` | `proj_neon_drift` | Any id from `GET /api/projects`. |
| `VITE_SHOW_DEBUG_TAB` | `false` | The client treats anything other than the exact string `'true'` as false. Set `false` for anything customer-facing. |

The `.env.example` defaults point at real live KULT ids
(`did:privy:cmnditqy301kl0cjrbm20d737`, `zmftkbihiws`); the code fallbacks point at
fixture ids. If the configured id does not resolve, the client renders a boot error —
match the id to the active `contextSource`.

---

## Profiles

### Local development, no key

```bash
INTELLIGENCE_PROVIDER=demo
CORS_ORIGIN=http://localhost:5173
```

Zero infrastructure, no credits, full loop. The client shows the demo banner.

### Local, live ChainGPT

```bash
INTELLIGENCE_PROVIDER=chaingpt
CHAINGPT_API_KEY=sk-...
CHAINGPT_TRANSPORT=sdk
CHAINGPT_USE_CUSTOM_CONTEXT=false
REASONING_TIMEOUT_MS=75000
CORS_ORIGIN=http://localhost:5173
```

### Deployed showcase

```bash
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://<frontend-host>

INTELLIGENCE_PROVIDER=chaingpt
CHAINGPT_API_KEY=sk-...
CHAINGPT_TRANSPORT=sdk
CHAINGPT_USE_CUSTOM_CONTEXT=false
NEWS_TIMEOUT_MS=20000
REASONING_TIMEOUT_MS=75000
SIGNAL_CACHE_TTL=600

# Durable storage — the file driver does not survive a container restart
MONGODB_URI=mongodb+srv://...
MONGODB_DB_NAME=poc

# Leave blank unless KULT is reachable from this environment
KULT_API_BASE=
```

Set every one of these explicitly rather than relying on defaults. Two of the defaults
(`CHAINGPT_USE_CUSTOM_CONTEXT`, `REASONING_TIMEOUT_MS`) do not match the documented
values, and `CORS_ORIGIN` will block the frontend if left alone.
