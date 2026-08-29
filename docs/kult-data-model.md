# KULT data model

What is real KULT data, what is derived, and why the mappers look defensive. This
matters more than usual: the POC is a credibility demo, so anything presented as KULT
data must actually be KULT data.

Files: `src/kult/{kultTypes,kultClient,kultMongo,mappers,context}.ts`.

---

## 1. Real vs derived

Verified against the **live KULT database**: 138 published games across 40+ real
creators, with real CDN thumbnails, real play/like/share counts, and the creators' own
design-doc prompts.

| Real — read from KULT | Derived — KULT has no such field |
|---|---|
| `title`, `category`, `templateId`, `templateName`, `tier` | `Agent.goals` |
| `mechanic`, `controls`, `states`, `scoring` | `Agent.interests` — inferred from categories actually shipped |
| `theme`, `difficulty`, creator prompt, visual mood | `Agent.capabilities` — inferred from real build history |
| `publish.publishedAt`, `browserFeature.featured` | `Agent.role` — composed from real shipped categories |
| plays, likes, shares, comments, favorites | `CreatorProject.audience` — mapped from real template category |
| activity log, lifetime points, username | `CreatorProject.goals` |
| `thumbnailUrl`, `publish.playPath` | `CreatorProject.description` — composed from real gameplay fields |

Grepping the production source confirms there is **no** `goals`, `audience` or `bio`
anywhere in KULT's schema. Rather than invent those per request and present them as KULT
data, they are computed from real signals — which categories the creator actually ships,
how their games actually perform — and are overridable per deployment via the `overrides`
argument on `gameToProject()` and `opts.goals` on `creatorToAgent()`.

`mappers.ts` exports `__derivationNotes` listing both sets, so the distinction is
programmatically inspectable rather than a comment.

**Session length is never synthesised.** KULT records plays, not durations. The project
stats carry only counters KULT actually stores; a fabricated `avgSessionMin` sitting next
to real numbers would be a lie, and would be the exact kind of detail that discredits a
demo when someone checks it.

---

## 2. Shapes only real data reveals

Live records are messier than the source suggests, and assuming otherwise crashed the
Agent route.

| Field | Documented | Actually observed |
|---|---|---|
| `gameplay.controls` | string | string, `string[]`, **or a keyed map** (`{ move: "WASD", dash: "Shift" }`) — 21 of 138 games |
| `gameplay.mechanic` | string | string or `string[]` of bullets |
| `gameplay.collision` | `string[]` | `string[]` on template games, a single string on generated games |
| `visuals.assets` | string | string or `string[]` |
| `customization.theme` | short label | sometimes a full mood sentence — unusable as a tag |
| `customization.prompt` | short brief | often a **full markdown design doc** (`## Title\n**Name**\n\n…`) |
| `category` | template category | free text with inconsistent casing (`Action`/`action`, `Runner`/`endless-runner`) |
| `profile.username` | string | **null for every creator checked** |
| activity log / points | populated | **empty / zero** for every creator checked |

Every field in `KultGamePackage` is optional, because these documents are written by
several code paths over time (template games, pure-agent games, refined games) and a
field present on one record is routinely absent on another.

### How each is absorbed

**`toText()`** flattens any of string / number / boolean / array / keyed map into a
readable string, recursing with a `/` joiner for nested maps, and degrading to `''`
rather than throwing:

```ts
toText({ move: 'WASD', dash: 'Shift' })   // "move: WASD, dash: Shift"
toText(['Drift', 'Boost'])                // "Drift, Boost"
```

**`parseCreatorPrompt()`** extracts the design-doc title and prose from a markdown
prompt, stripping headings and bold markers, so a project description is the creator's
own words rather than a dumped heading block.

**`audienceFor()`** matches categories case- and separator-insensitively against a
23-entry table, with substring matching in both directions, before falling back to
`['Web3-native players', 'Short-session browser-game players']`.

**`creatorDisplayName()`** handles null usernames: `0x…` addresses become
`0x1234…abcd`, Privy DIDs become `privy:cmndit…`, anything else is truncated.

**Agent activity is reconstructed from the game records** because the activity
collection is effectively empty. Every reconstructed line is a fact read from KULT:

```
Published 19 experiences through KULT Create
Most recent: "Neon Drift" (2026-07-16)
Best performing: "Pixel Rush" (2,412 plays)
8,930 total plays across published games
3 games featured in the KULT browser
```

Live activity entries, when present, are de-duplicated — create/publish are logged more
than once per game.

**`unique()`** folds case, caps count, and caps length. The length cap is why a
full-sentence `customization.theme` never renders as a chip.

---

## 3. Read-only by construction

Every call in `kultClient.ts` is a GET against an endpoint that only reads.

**`GET /social/creator-stats/:creatorId` is deliberately never called**, even though it
returns the richest aggregate: `socialService.getCreatorStats()` fires a
`putJsonOnZeroG()` profile snapshot as a side effect, so "reading" a creator's stats
**writes to 0G storage**. The POC composes the same numbers from `/games/list` instead.

`POST /social/views/:gameId` is likewise never called — it would inflate a real
creator's play count.

An intelligence layer must not mutate production creator data as a side effect of
generating a recommendation.

Endpoints actually used: `/games/:id`, `/games/list`, `/social/stats/:id`,
`/social/profile/:id`, `/social/activity/user/:id`, `/social/points/:id`.

### The 403 that shapes the client

Without a bearer token, `/games/list?creatorId=` returns **403** — the API requires the
caller to own that identity. So unauthenticated clients page the public published
catalog (100 per page, up to 6 pages) and filter locally.

That is why the catalog is:

- **cached** for 5 minutes (`CATALOG_TTL_MS`), because paging takes seconds against the
  live API;
- **de-duplicated in flight** via a shared promise, because several requests land
  together on a page load;
- **only cached when non-empty**, so a transient failure is not sticky.

`fetchGames()` uses the server-side `creatorId` filter when `KULT_AUTH_SECRET` is set,
and the local-filter path otherwise.

Timeouts are split: `10s` for point reads, `45s` for `/games/list`, which is genuinely
slow. All failures return `null` / `[]` and log rather than throw — a KULT outage
degrades context, it does not break intelligence.

---

## 4. Context resolution

`context.ts` resolves every read through three sources in priority order:

```
1. poc_db        snapshot of real KULT games in the POC's OWN database
                 standalone: no KULT backend, no localhost, no prod credentials
2. kult_api      live Creator Studio, when KULT_API_BASE is set
3. poc_fixtures  bundled real game packages, so it always runs
```

All three produce identical shapes through the same mappers, so nothing downstream knows
which one served the request. `contextSource()` reports the live one on the health
endpoint.

`snapshotReady()` checks whether a snapshot is **actually available**, not merely
configured — an empty or unreadable snapshot falls through to the next source instead of
serving nothing.

### The snapshot

`npm run seed:kult` copies real published games into the POC's own database via the
**public HTTP API**, deliberately — reading through the published-games endpoint avoids
opening a connection to the production database and cannot trigger the 0G write side
effects some KULT read paths have.

`kultMongo.ts` then reads the whole snapshot, cached for 5 minutes with in-flight
de-duplication, and is read-only by construction: the POC never writes to
`kult_games` at runtime.

### Database separation

The POC writes knowledge, actions, outcomes and analytics, and exposes a reset endpoint
that deletes them. Pointed at production, that is a data-loss bug. `db/mongo.ts` refuses
to start against a known KULT database name:

```ts
const FORBIDDEN_DB_NAMES = ['prompt_creator_studio', 'creator_studio', 'kult'];
```

Same Atlas cluster is fine. The database must differ.

---

## 5. Fixtures

`src/db/seed.ts` contains real KULT game *packages* — not an invented POC shape. Field
names, nesting and values follow `services/gameFactoryService.js` `createGamePackage()`
and the `racing` entry in `data/templates.js`, including the `themePresets.neon` title
convention that produces "Neon 2D Racing".

They run through the same mappers as live data, so the fixture path and the
`KULT_API_BASE` path exercise identical code. Point `KULT_API_BASE` at the Creator Studio
API and real records flow through unchanged.

Seeding is idempotent — re-seeding never clobbers accumulated intelligence, because
fixtures are only installed when `agents` / `projects` are empty.

---

## 6. Known limitations of the live data

Stated plainly, because they are the current state of those collections and not
shortcomings of the POC:

- **Creator identity is thin.** Usernames are null, points are zero and the activity log
  is empty for every creator checked. Agent display names fall back to a shortened
  wallet/DID, and context is reconstructed from game records.
- **`Agent.goals` and `CreatorProject.audience`/`goals` are derived**, because KULT
  stores no such fields.
- **`GET /social/creator-stats/:creatorId` is never called**, so the richest aggregate is
  unavailable by choice.
- **Category is free text**, so genre grouping is heuristic.

For production, the derived fields become real inputs: KULT would supply goals and
audience from creator settings, and `overrides` on the mappers is where they plug in.
