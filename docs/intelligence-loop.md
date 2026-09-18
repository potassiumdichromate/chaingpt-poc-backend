# The intelligence loop

How a scan decides what to look up, what it rests on, and how it explains a change of
mind. Read this before changing the planner, the prompts or the Decision Delta.

```
Agent scans -> researches -> remembers -> acts -> gets an outcome
            -> scans again -> sees new evidence -> keeps or changes its decision, and says why
```

**Division of labour.** KULT holds the Agent's canonical memory: knowledge, runs,
actions and outcomes. ChainGPT is used statelessly for two things: live Web3 evidence
(AI News) and reasoning (the Web3 LLM). `chatHistory` stays off everywhere, so ChainGPT
holds no conversation state. Every prompt carries the memory it needs, which also
avoids the extra credit that chat history costs. All memory reads and writes go through
`src/intelligence/memory.ts`. When KULT exposes an Agent memory API, swap the store
calls there; nothing else changes.

## One scan, step by step

`generateOpportunities` in `src/intelligence/engine.ts`:

1. **Plan** (`planner.ts`, `planAgentEvidence`). Up to three evidence needs, in priority
   order: the user's focus, the latest outcome since the previous scan, a re-check of
   the previous recommendation, the Agent's goal, and a broad coverage fallback. Each
   need is a question, a reason, what triggered it (with the outcome or opportunity id),
   and 1-3 short search phrases.
2. **Retrieve** (`retrieval.ts`). Each need walks its phrases once, newest first, and
   stops at the first phrase with in-window news. If only old news exists, the freshest
   stale set is used and flagged. Articles are de-duplicated across needs and get prompt
   ids `E1..En` (research uses `R`, growth uses `G`).
3. **Reason**. The prompt shows the plan's questions, the evidence with age and
   freshness, memory with `KNOWLEDGE_ID` / `OUTCOME_ID` labels, and on a repeat scan
   the previous recommendations as `P1..P3` with what happened to each. It is
   compacted to `PROMPT_CHAR_BUDGET` before sending (see below).
4. **Repair and validate**. The first answer is usually prose (see "What the live
   model actually does"), so the short repair prompt rewrites it as JSON. The
   repair prompt lists the citable ids, so it can recover which articles and
   memory the prose referred to. Every cited id is then checked against what the
   model was shown, and invalid ids are dropped.
5. **Provenance + confidence** (`evidence.ts`). Each recommendation lists the evidence,
   knowledge and outcomes it rests on. Confidence is computed from that list and always
   comes with reasons.
6. **Decision Delta** (`decisions.ts`). See below.
7. **Persist**. The run stores the plan, evidence, quality and delta, so history and the
   next scan can use them.

## Why the planner is rules, not an LLM call

A reasoning call takes 20-80 seconds and costs credits. The News API only matches short
literal phrases: "AI gaming" returns rows, "AI gaming agents web3" returns zero. A
model-written query would usually find nothing. The rules read KULT memory directly,
and every need carries its reason, so the Agent's thinking about what to look up is
still visible in the UI ("What the Agent looked up").

Outcome rules (`outcomeNeed`):

| Outcome | The Agent looks for |
|---|---|
| `no_response`, `not_relevant` | Alternatives: domain phrases, excluding the entity that did not work |
| `conversation_started`, `partnership_opportunity` | The named partner first (for example "Immutable"), to support the follow-up |
| `campaign_launched`, `players_acquired` | Distribution channels to amplify the result |
| `other` | A re-check of the entity |

Search phrases come from `salientPhrases`, which prefers proper nouns and then known
Web3 terms. It replaced the old research query, which searched the title's first two
words (for example "Apply to").

## Freshness

`VERIFIED LIVE 2026-09-18`: the unfiltered feed and "AI" had same-day news, but "gaming"
had nothing newer than 17 days. Stale evidence is therefore normal, not an edge case.

- `fresh`: 7 days or newer. `aging`: up to `NEWS_FRESHNESS_DAYS` (14). `stale`: older.
- Ages come from each article's `pubDate`, not from the model.
- `evidenceQuality.level` is `good`, `mixed`, `stale` or `none`, and its `note` is shown
  to the user as written. The prompt forbids presenting stale items as current news.

## Categories

`VERIFIED LIVE 2026-09-18`: `category` 2 is "Blockchain Gaming". The previously
hard-coded ids were wrong: 8 is "NFT" and 4 is "DApps". Most gaming articles have no
category at all, so category filtering is opt-in (`NEWS_CATEGORY_IDS`) and applies only
to the goal need. Rows now keep `category`, `chain` (ChainGPT's `subCategory`) and
`token` as separate fields.

Both transports send the same request. `buildNewsParams` builds it, `newsQueryString`
reproduces the SDK's axios encoding byte for byte (a test pins this), and both
responses go through `normalizeNews`.

## Decision Delta

On a repeat scan, the delta answers: previous recommendation -> what was learned -> what
changed -> why.

The kept/changed/new call and its reason come from a **separate short decision-review
call** (`buildDecisionReviewPrompt`) made after the new recommendations exist.
`VERIFIED LIVE`: asked inside the main scan prompt, the model ignored the P labels and
returned every recommendation as new, with no reason. The short single-purpose prompt
worked (3 of 3 reviewed). It costs one extra reasoning call, on repeat scans only. If
it fails, the scan still returns and the fallbacks below apply.

- **Learned**: computed from stored data, never from the model. It lists knowledge,
  actions and outcomes recorded after the previous run, plus evidence whose ChainGPT id
  was not in the previous run.
- **Decisions**: the review labels each new recommendation (`N1..N3`) `kept`,
  `changed` or `new` against a `P` label, with a reason. Unknown labels are
  discarded. Without a usable review, a near-identical title (Jaccard >= 0.6) is
  linked as `kept` with `attribution: "matched"`, and the UI says the model gave
  no reason.
- **Dropped**: previous recommendations with no successor. The model's reason is used
  when given; otherwise the reason is derived from what happened ("Outcome recorded:
  no response.", "Dismissed by the Agent.", or "Not carried forward in this scan.").

The engine no longer forces a memory-influence claim with an extra LLM call. That
call was replaced by the decision review. The delta's summary comes from stored data,
so a repeat scan explains itself honestly even when memory did not change a
recommendation.

**Demo caveat.** ChainGPT news rarely changes within minutes, so in a live demo the
"new evidence" usually comes from the outcome. The outcome changes the plan, the plan
retrieves different articles, and those appear as new in the delta. If the same
articles come back, the delta reports them as repeated. That is correct; do not fake it.

## What the live model actually does

Measured against ChainGPT on 2026-09-18. Re-check these before changing the prompts.

| Finding | Evidence | Consequence in the code |
|---|---|---|
| Questions over about 5-6k characters are not read in full | Canary test: five marker words were all found at 1.9k, 3.7k, 4.1k, 4.5k and 5.1k characters, and **none** at 6.0k ("No CANARY words are listed in the provided information") | `PROMPT_CHAR_BUDGET` defaults to 4600. Instructions are terse. The repair prompt sizes the response it includes to the room left. |
| "Find opportunities" prompts are answered in prose whatever the format rules say | 0 of 6 JSON first answers, with the persona on or off and at 5.7k or 4.5k characters. A labelled-line format was ignored too. | The short repair pass (which does return JSON) is the normal path, and it gets the citable ids. |
| Short, single-purpose prompts are followed | Repair and decision-review calls returned valid JSON | Decisions use a separate review call |
| Prose often uses an article without naming its id | The "SEC approves tokenized stock pilot" story became a recommendation citing nothing | Stemmed title matching links it as `matched`, labelled as inferred |
| 500s and TLS resets arrive without a status | "Internal server error", "bad record mac" | Both are classified as retryable `upstream_5xx`. News GETs also retry `unknown`. |

When the model's recommendations do not come from the retrieved evidence, the service
says so: provenance is empty and confidence is low, with a reason. Do not "fix" this by
loosening validation.

## Prompt budget

`fitToBudget` picks the most detailed of four `DETAIL_LEVELS` that fits
`PROMPT_CHAR_BUDGET` (default 4600). The levels shorten titles, memory summaries,
notes, article summaries and profile lists, and drop the plan's questions. Only then
are articles dropped, never below two. Memory is sliced to the same level, so only
what the model saw can be cited. `prompts.test.ts` fails if a worst-case prompt stops
fitting.

## Cost per action

Each news request and each reasoning call is one billable call. Identical searches
within one scan are shared, even when the cache is bypassed.

| Action | Calls |
|---|---|
| Scan | 1-9 news (up to 3 needs x up to 3 phrases; usually 3-5) + 1 reasoning + usually 1 repair + 1 decision review on repeat scans |
| Research | 1-4 news + 1 reasoning (+ repair) |
| Grow | 1-5 news + 1 reasoning (+ repair) |

A live run of scan, research and a repeat scan made 23 calls (17 news, 6 reasoning)
before identical searches were shared.
