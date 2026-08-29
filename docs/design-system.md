# Design system

The visual and interaction language of the POC client. Written so a designer or a new
frontend engineer can extend the product without it drifting, and so the rules that
protect the *credibility* of the demo are written down rather than folklore.

Reference implementation: `frontend/src/styles.css` (378 lines, no framework, no
runtime CSS dependency).

---

## 1. Design principles

**1. Intelligence must look earned, not generated.** Every claim on screen is traceable
to a number: how many signals, how many knowledge items, which prior research. A card
that just asserts a recommendation is indistinguishable from a chatbot.

**2. Two brands, two colours, never merged.** KULT is violet, ChainGPT is teal. Where
ChainGPT supplied something — signals, evidence, the primary scan action — it is teal
and it says so. Where KULT decided something — memory, targets, knowledge — it is
violet. The user should be able to see the division of labour without reading a word.

**3. Absence is information.** No evidence, no opportunities, no memory influence: all
are rendered explicitly. The product never fills a gap with plausible text.

**4. Dark, dense, technical.** This is an operator surface inside a creator platform,
not a marketing page. Small type, tight rhythm, tabular numbers, no illustration.

**5. Waiting is narrated.** Reasoning takes 30–75 seconds. Silence reads as breakage.

---

## 2. Tokens

All tokens are CSS custom properties on `:root`. There is no theme switch — the product
is dark-only by design.

### Colour

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#08090d` | Page ground |
| `--bg-raised` | `#0e1017` | Metrics tiles, insets |
| `--bg-card` | `#12141d` | Every card |
| `--bg-hover` | `#171a25` | Hover fill, skeletons |
| `--border` | `#232736` | Default 1px border |
| `--border-strong` | `#313649` | Emphasis, hover, research panel |

| Token | Value | Meaning |
|---|---|---|
| `--text` | `#eef0f6` | Primary |
| `--text-dim` | `#9aa1b4` | Body, field values |
| `--text-faint` | `#646b7f` | Labels, timestamps, meta |

### Semantic colour — the load-bearing part

| Token | Value | Means |
|---|---|---|
| `--kult` | `#7c5cff` | KULT. Relevance scores, actions, knowledge, active tab. |
| `--chaingpt` | `#35d6c0` | ChainGPT. Signals, live evidence, the scan button. |
| `--memory` | `#ffb340` | **Memory influence.** Reserved. Nothing else may use amber. |
| `--danger` | `#ff6b6b` | Errors |
| `--ok` | `#4ade80` | Completed step |

Each has a `-soft` variant at ~12% alpha for backgrounds
(`--kult-soft`, `--chaingpt-soft`, `--memory-soft`, `--danger-soft`).

> **Amber is the memory colour and nothing else.** The compounding-intelligence moment
> is the entire thesis of the demo. If amber also means "warning about something
> unrelated", the moment stops being legible. The one shared use — `.banner-warn` — is
> deliberate: both the degraded-provider banner and the "no memory influence" banner are
> statements about the integrity of the intelligence, which is the same semantic family.

### Type

`--font`: system stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto`).
`--mono`: `ui-monospace, SFMono-Regular, 'SF Mono', Menlo` — event log only.

Base is `14px / 1.55`. The scale is deliberately non-round; these are measured values,
not a ratio.

| Role | Size | Weight | Notes |
|---|---|---|---|
| Relevance number | 25px | 680 | `tabular-nums` |
| Metric value | 21px | 680 | `tabular-nums` |
| Section title | 19px | 640 | `-0.015em` |
| Opportunity title | 15.5px | 620 | `line-height: 1.35` |
| Body / field value | 13px | 400 | `--text-dim` |
| Section sub, banners | 12.5px | 400 | max-width 620px |
| Field label | ~10.5px | 600 | uppercase, `0.06em`, `--text-faint` |
| Relevance label | 9.5px | — | uppercase, `0.07em` |

**Numbers are always `font-variant-numeric: tabular-nums`.** Relevance scores, metrics
and timestamps sit in columns and must not jitter as they change.

### Space, radius, elevation

Cards `20px` padding. Card-to-card `14px`. Section heads `34px 0 16px`.
Shell max-width `1180px`, `24px` gutters, `80px` bottom.

`--radius: 12px` (cards) · `--radius-sm: 8px` (buttons, chips, banners, tiles) ·
`14px` (avatar) · `50%` (dots).

`--shadow: 0 8px 28px rgba(0,0,0,0.42)`. Used sparingly — depth comes from
background steps and borders, not shadow stacks.

Transitions are `0.14s ease` for interaction, `0.3s ease` for state changes in the
loading component. Nothing is slower.

---

## 3. Components

### Card — `.card`

`--bg-card`, 1px `--border`, `--radius`, 20px padding. The one container primitive.
Variants: `.agent-card` (avatar + content grid), `.research-panel` (`--border-strong`),
`.empty` (centred, 44px vertical).

### Opportunity card — `.opp`

The hero component. Fixed information order, and the order is the argument:

```
[memory badge]          only when memoryInfluence.used
[memory reason]         the model's own explanation
[relevance] [title]     score first — the personalization claim leads
Current signal          what ChainGPT surfaced
Why this Agent          the personalization
Opportunity             the framing
[action box]            the recommended next action, visually lifted
[Research this] [chip]  the next step
```

`data-memory="true"` shifts the border to amber and adds a 90px amber gradient wash
from the top. It should read as a different *kind* of card at a glance across the room —
that is the demo moment.

### Memory badge — `.memory-badge` + `.memory-reason`

Amber, uppercase, `◆` glyph, reading `Builds on previous Agent knowledge`. Directly
below it, the model's stated reason in a soft amber panel.

**Rule: render only when `memoryInfluence.used === true`.** Never derive it from
`usedKnowledgeIds.length` — that is what was sent to the model, not what influenced it.
The badge is a factual claim about the model's output and must stay one.

### Relevance — `.relevance-num[data-tier]`

Three tiers, colour only, no bar or gauge:

| Tier | Range | Colour |
|---|---|---|
| `high` | ≥ 85 | `--kult` |
| `mid` | 70–84 | `#a795ff` |
| `low` | < 70 | `--text-dim` |

A number with a "Fit" label is more honest than a progress bar, which implies a
precision the score does not have.

### Live evidence — `.evidence`

Teal-tinted panel, headed `◈ Live Web3 evidence — powered by ChainGPT`. Each item shows
a type pill (`news` / `on-chain` / `market` / `social`), the evidence line, and the
source label beneath in `--text-faint`.

**Empty state is a first-class render**, not a hidden section: `.evidence-none` in
italic dim text carries the model's own `confidenceNote`. A demo that only ever shows
evidence when it exists teaches the viewer nothing about how the system behaves when it
does not.

### Action box — `.action-box`

Violet-tinted inset holding the recommended next action. This is the one element that
distinguishes the product from a news summary, so it is styled as a distinct object
rather than another field.

### Loading steps — `.loading-step[data-state]`

Three states: `idle` (faint text, grey dot), `active` (full text, pulsing teal dot),
`done` (dim text, green dot). Advances every 2.6s and stops at the last step — it never
loops, and it never implies completion that has not happened.

### Banners — `.banner`

| Class | Colour | Says |
|---|---|---|
| `.banner-live` | teal | "3 opportunities from 6 live ChainGPT signals · 2 knowledge items injected" |
| `.banner-warn` | amber | Demo provider active, or repeat scan with no memory influence |
| `.banner-error` | red | Boot failure, save failure |

`.banner-live` is the provenance line. It is not decoration — it is the evidence that
the personalization is real, expressed in counts.

### Timeline — `.timeline`

Vertical rule with `data-kind`-coloured ring markers: knowledge = violet, action = teal,
outcome = amber. One graph, three record types, colour-coded to the same semantic
system used everywhere else.

### Chips — `.chip`

Neutral by default; `.chip-kult` (violet) for KULT-derived values like targets;
`.chip-cg` (teal) for ChainGPT-derived flags like "Live evidence available".

### Buttons

| Class | Use |
|---|---|
| `.btn-cg` | Teal, solid. The **primary intelligence action** — Discover, Grow. ChainGPT is doing the work, so it is teal. |
| `.btn-primary` | Violet, solid. KULT-side commitments — Save to Agent knowledge. |
| `.btn` | Neutral. Record action, record outcome. |
| `.btn-ghost` | Transparent. Back, reset. |

Disabled is `opacity: 0.55` + `cursor: not-allowed`, never a colour change — the button
must stay recognisable as itself while in flight.

---

## 4. Layout

Single column, `1180px` max, `24px` gutters. `.opp-grid` is a one-column grid with 14px
gaps — opportunity cards are wide, not tiled, because each one is a paragraph of
reasoning, not a tile.

`.meta-grid` and `.research-grid` use `repeat(auto-fit, minmax(250px, 1fr))`.

The topbar is sticky with `backdrop-filter: blur(14px)` over an 88%-opaque ground.

**Responsive** (`max-width: 720px`): the agent card collapses to one column, the grids
to one column, the shell to 16px gutters. There is no mobile-specific navigation — the
POC's audience is desktop.

---

## 5. Motion

| Element | Motion |
|---|---|
| Interactive (buttons, tabs, cards) | `0.14s ease` on colour and border |
| Loading step | `0.3s ease` colour, `pulse 1.15s` on the active dot |
| Spinner | `0.6s linear` rotation |
| Skeleton | `shimmer 1.5s ease-in-out` |

No entrance animations, no layout transitions, no parallax. Content appearing should be
instantaneous once it is available — the wait was already narrated by the loading steps.

---

## 6. Copy rules

**Say what the system did, in numbers.** "3 opportunities from 6 live ChainGPT signals ·
2 saved knowledge items injected into this scan" beats "Here are your opportunities".

**Name the mechanism.** "Next scan will use this" after a save. "Builds on previous
Agent knowledge" on the badge. The user should learn how the loop works by using it.

**Failures are specific and actionable.** "The ChainGPT account is out of credits. Top
up at app.chaingpt.org to resume live intelligence." — not "Something went wrong."

**Never claim what did not happen.** If a save failed, say it failed and keep the
content on screen. If a repeat scan produced no memory influence, say so.

**Attribute continuously.** The footer credits ChainGPT for signals and reasoning, and
KULT for context, memory, actions and outcomes, on every screen.

---

## 7. Accessibility — current state and gaps

Honest assessment, since this is a POC.

**Holds up:** contrast on primary and dim text against the dark ground; native `button`,
`select` and `input` elements throughout, so keyboard and screen-reader semantics come
free; `:focus` on form controls shifts the border to `--kult`; `<article>`, `<header>`,
`<nav>`, `<footer>`, `<ol>`/`<ul>` used semantically.

**Gaps to close before this is a production surface:**

- `--text-faint` (`#646b7f`) on `--bg-card` is roughly **3.4:1** — well under the AA 4.5:1 minimum for small text.
  It is used for labels and timestamps.
- Tabs are `<button>`s without `role="tab"` / `aria-selected`.
- Loading state is visual only — no `aria-live` region announcing progress or completion.
- The memory badge conveys meaning through colour plus an icon glyph, but the glyph is
  decorative text rather than a labelled element.
- No `prefers-reduced-motion` guard on the pulse and shimmer animations.
- Focus rings on `.btn` rely on the browser default, which is low-contrast on this ground.

---

## 8. Extending it

**Adding a state to an existing component:** use a `data-*` attribute and a token, the
way `.opp[data-memory]` and `.relevance-num[data-tier]` do. Do not add a new class per
state.

**Adding a colour:** don't, unless it carries new *semantics*. Five semantic colours is
the budget. If the new thing is KULT-side it is violet; if it is ChainGPT-side it is
teal.

**Adding a card type:** start from `.card` and compose existing primitives (`.field`,
`.chips`, `.action-box`, `.stat-row`). Every existing surface is built this way.

**Changing the memory treatment:** don't do it casually. Amber, the badge, the gradient
wash and the reason line are one composed signal, and it is the moment the whole demo
is built to produce.
