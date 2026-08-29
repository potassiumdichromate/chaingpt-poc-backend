# KULT × ChainGPT — Opportunity Intelligence Backend

The intelligence service behind the KULT × ChainGPT Opportunity Intelligence POC.

It turns **current Web3 signals** (ChainGPT AI Crypto News) plus **persistent KULT Agent
context** (goals, build history, saved knowledge, actions, outcomes) into **personalized,
actionable opportunities** — and it remembers. Saved research is injected into the next
request and visibly changes the next recommendation.

```
Agent Context → ChainGPT Intelligence → Personalized Opportunity
     → Research → Saved Knowledge → Better Next Recommendation
```

This is not a chatbot proxy and not a news feed. The value is the loop.

---

## Quick start

```bash
npm install
cp .env.example .env      # then set CHAINGPT_API_KEY
npm run dev               # http://localhost:8787
```

With no `CHAINGPT_API_KEY` the service starts on the local `DemoProvider`, logs a loud
warning, and reports `provider.degraded = true` on `/health`. Demo output is never
presented as live ChainGPT output.

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/api/agents/agent_kult_nova/opportunities -d '{}' -H 'content-type: application/json'
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch-mode dev server (`tsx`). |
| `npm run build` | Compiles `src/` to `dist/` via `tsconfig.build.json`. |
| `npm start` | Runs the compiled server (`dist/index.js`). |
| `npm run typecheck` | Type-checks `src/` **and** `scripts/` with no emit. |
| `npm test` | 128 vitest tests across 7 files. |
| `npm run smoke` | Live ChainGPT API verification. Checks credits first. |
| `npm run verify` | Full P0 showcase flow end to end — the readiness gate. |
| `npm run seed:kult` | Copies real published KULT games into the POC's own database. |

## Documentation

| Doc | Read it when |
|---|---|
| [Architecture](docs/architecture.md) | You want the system model and request lifecycle. |
| [API reference](docs/api-reference.md) | You are calling this service. |
| [Frontend integration](docs/frontend-integration.md) | You are building or maintaining a client. |
| [Design system](docs/design-system.md) | You are building UI against this data. |
| [Intelligence pipeline](docs/intelligence-pipeline.md) | You are changing prompts, parsing or the memory loop. |
| [ChainGPT integration](docs/chaingpt-integration.md) | You are debugging the provider or going live. |
| [KULT data model](docs/kult-data-model.md) | You need to know what is real KULT data and what is derived. |
| [Configuration](docs/configuration.md) | You are setting environment variables. |
| [Operations](docs/operations.md) | You are deploying, monitoring or running the showcase. |
| [Testing](docs/testing.md) | You are adding tests or reading the suite. |
| [Audit](docs/audit.md) | You want the known defects, risks and their severity. |

## Stack

TypeScript (ESM, NodeNext-style `.js` specifiers) · Express 4 · Zod · MongoDB driver
(optional) · Vitest · `@chaingpt/ainews` + `@chaingpt/generalchat`.

Node 20+ (uses top-level `await` and `AbortSignal.timeout`).
