import { config } from '../config.js';
import type { EvidenceNeed, EvidenceRef } from '../types.js';
import type { PreviousRecommendation } from './decisions.js';
import type { KultContext } from './memory.js';

/**
 * Prompt contracts - spec 12.
 *
 * Stable KULT product knowledge lives in the ChainGPT AI Hub context attached to
 * the dedicated API key (spec 11.5), so these prompts carry only the dynamic
 * Agent / project / memory / query layer.
 *
 * VERIFIED LIVE 2026-09-18 (canary test): ChainGPT's chat reads a question of up to
 * ~5.1k chars in full, but at ~6k chars it saw NONE of five marker words and
 * answered from "the provided information" - long questions are handled in a
 * different mode. Every prompt is therefore compacted to PROMPT_CHAR_BUDGET (4600
 * by default) and the instructions are kept terse: every character of instruction
 * is a character of evidence or memory the model cannot see.
 *
 * VERIFIED LIVE, same session: for "find opportunities" tasks the model usually
 * answers in markdown prose whatever the format instructions say, while the short
 * repair prompt reliably yields JSON. The repair pass is therefore the normal path,
 * and it is given the citable ids so provenance survives the rewrite.
 */

const JSON_PREAMBLE = 'Reply with ONE JSON object and nothing else - no introduction, no markdown. The first character must be "{".\n';

const JSON_DISCIPLINE = `
FORMAT: exactly the shape below, wrapper key included, with exactly the number of items asked for.
relevance is an integer 0-100, never a word. Strings are single-line plain prose. Nested fields are
JSON objects, never sentences. Never invent sources or ids. Start with "{".`;

/**
 * How much of each part of the prompt to render. The engine walks these levels
 * from most to least detailed until the prompt fits PROMPT_CHAR_BUDGET, and only
 * then starts dropping evidence. Memory counts shrink too, so the engine slices
 * the context to the same level and validates citations against what was shown.
 */
export interface PromptDetail {
  evidenceSummary: number;
  titleChars: number;
  /** Free-text fields such as a selected opportunity's why/action or a project description. */
  fieldChars: number;
  knowledgeCount: number;
  knowledgeSummary: number;
  outcomeCount: number;
  noteChars: number;
  actionCount: number;
  /** A previous recommendation's next action; 0 omits it. */
  actionChars: number;
  activityCount: number;
  profileItems: number;
  /** The plan's questions. Its "why" lines are for people and never sent. */
  plan: boolean;
}

export const DETAIL_LEVELS: PromptDetail[] = [
  { evidenceSummary: 150, titleChars: 110, fieldChars: 260, knowledgeCount: 4, knowledgeSummary: 220, outcomeCount: 4, noteChars: 120, actionCount: 3, actionChars: 100, activityCount: 4, profileItems: 8, plan: true },
  { evidenceSummary: 90, titleChars: 90, fieldChars: 180, knowledgeCount: 3, knowledgeSummary: 140, outcomeCount: 3, noteChars: 70, actionCount: 2, actionChars: 70, activityCount: 3, profileItems: 6, plan: true },
  { evidenceSummary: 40, titleChars: 80, fieldChars: 120, knowledgeCount: 3, knowledgeSummary: 70, outcomeCount: 3, noteChars: 40, actionCount: 0, actionChars: 40, activityCount: 2, profileItems: 5, plan: false },
  { evidenceSummary: 0, titleChars: 70, fieldChars: 80, knowledgeCount: 2, knowledgeSummary: 0, outcomeCount: 2, noteChars: 0, actionCount: 0, actionChars: 0, activityCount: 1, profileItems: 4, plan: false },
];

const FULL = DETAIL_LEVELS[0]!;

/** The context actually rendered at a detail level - what citations are validated against. */
export function contextAtDetail(ctx: KultContext, d: PromptDetail): KultContext {
  return {
    ...ctx,
    recentKnowledge: ctx.recentKnowledge.slice(0, d.knowledgeCount),
    recentActions: ctx.recentActions.slice(0, d.actionCount),
    recentOutcomes: ctx.recentOutcomes.slice(0, d.outcomeCount),
  };
}

const OUTCOME_TEXT: Record<string, string> = {
  no_response: 'no response', not_relevant: 'not relevant', conversation_started: 'conversation started',
  partnership_opportunity: 'partnership opportunity', campaign_launched: 'campaign launched',
  players_acquired: 'players acquired', other: 'other',
};

function cut(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function renderContext(full: KultContext, d: PromptDetail = FULL): string {
  const { agent, recentKnowledge, recentActions, recentOutcomes } = contextAtDetail(full, d);

  const knowledge = recentKnowledge.length
    ? recentKnowledge
        .map((k) => `- KNOWLEDGE_ID: ${k.id} | "${cut(k.title, d.titleChars)}"${
          d.knowledgeSummary ? `\n  ${cut(k.summary, d.knowledgeSummary)}` : ''
        }`)
        .join('\n')
    : '(none yet)';

  const actions = recentActions.length
    ? recentActions.map((a) => `- ${a.actionType} on "${cut(a.opportunityTitle, d.titleChars)}"`).join('\n')
    : full.recentActions.length ? '(see outcomes)' : '(none yet)';

  // Outcomes carry an id and the recommendation they resulted from, so the model
  // can cite exactly which result changed its thinking.
  const outcomes = recentOutcomes.length
    ? recentOutcomes
        .map((o) => `- OUTCOME_ID: ${o.id} | ${OUTCOME_TEXT[o.outcomeType] ?? o.outcomeType}${
          o.opportunityTitle ? ` on "${cut(o.opportunityTitle, d.titleChars)}"` : ''
        }${o.notes && d.noteChars ? ` | ${cut(o.notes, d.noteChars)}` : ''}`)
        .join('\n')
    : '(none yet)';

  return `KULT AGENT ${agent.id} (${agent.name}): ${agent.role}
- interests: ${agent.interests.slice(0, d.profileItems).join(', ')}
- capabilities: ${agent.capabilities.slice(0, d.profileItems).join(', ')}
- activity: ${agent.activity.slice(0, d.activityCount).join('; ')}
- goals: ${agent.goals.join('; ')}

RECENT SAVED KNOWLEDGE (KULT canonical memory)
${knowledge}

RECENT ACTIONS
${actions}

RECENT OUTCOMES
${outcomes}`;
}

function ageText(days: number): string {
  return days === 0 ? 'today' : `${days}d old`;
}

/** Evidence with a stable id, its age and freshness. */
export function renderEvidence(evidence: EvidenceRef[], summaryChars = 150, titleChars = 110): string {
  if (evidence.length === 0) return '(no ChainGPT news retrieved - reason from KULT context and say so)';
  return evidence
    .map((e) => `- EVIDENCE_ID: ${e.id} | ${e.publishedAt.slice(0, 10)} (${ageText(e.ageDays)}, ${e.freshness}) | ${cut(e.title, titleChars)}${
      summaryChars && e.summary ? `\n  ${cut(e.summary, summaryChars)}` : ''
    }`)
    .join('\n');
}

function renderPrevious(previous: PreviousRecommendation[], when: string, d: PromptDetail): string {
  const lines = previous.map((p) => {
    const acted = p.actions.map((a) => a.actionType).join(', ');
    const results = p.outcomes.map((o) => `${OUTCOME_TEXT[o.outcomeType] ?? o.outcomeType} (${o.id})`).join(', ');
    const since = acted ? ` | then: ${acted}${results ? ` -> ${results}` : ', no outcome yet'}` : ' | not acted on';
    const action = d.actionChars ? ` | action: ${cut(p.action, d.actionChars)}` : '';
    return `- PREVIOUS_ID: ${p.label} | "${cut(p.title, d.titleChars)}"${action}${since}`;
  });
  return `PREVIOUS RECOMMENDATIONS (last scan, ${when})\n${lines.join('\n')}`;
}

// --------------------------------------------------------------- opportunities

export interface OpportunityPromptInput {
  ctx: KultContext;
  needs: EvidenceNeed[];
  evidence: EvidenceRef[];
  /** Only an explicit user focus; the Agent's own interests are already in the context. */
  focus?: string;
  windowDays: number;
  previous: PreviousRecommendation[];
  previousWhen: string;
  detail?: PromptDetail;
}

export function buildOpportunityPrompt(input: OpportunityPromptInput): string {
  const { ctx, needs, evidence, focus, windowDays, previous, previousWhen } = input;
  const d = input.detail ?? FULL;
  const hasMemory = ctx.recentKnowledge.length > 0 || ctx.recentOutcomes.length > 0;
  const hasPrevious = previous.length > 0;

  // Memory must be cited where it genuinely applies - but a claim of influence that
  // is not there is worse than none: the Decision Delta carries "what changed" honestly.
  const memoryRule = hasMemory
    ? '- memory: where saved knowledge (kn_ ids) or outcomes (out_ ids) change a recommendation, set memoryInfluence.used=true, cite them in memoryInfluence.knowledgeIds / outcomeIds, and say how in memoryInfluence.reason. Never claim influence that is not there.'
    : '- memory: none saved yet, so memoryInfluence.used=false everywhere.';

  // Previous recommendations are context here - build on them or move past them.
  // Kept/changed/new and why are asked separately (buildDecisionReviewPrompt).
  const decisionRule = hasPrevious
    ? '\n- previous recommendations: continue, revise or replace them in light of what the Agent has learned since.'
    : '';

  return `${JSON_PREAMBLE}TASK_ID: opportunity_radar
You are the Web3 intelligence engine for a persistent KULT Agent; KULT holds its memory. Give
exactly 3 opportunities for THIS Agent now, each saying why it matters now and what to do next.
Ground them in the evidence and memory below; do not summarise news.

${renderContext(ctx, d)}
${focus ? `\nFOCUS (from the user): ${focus}\n` : ''}${d.plan && needs.length ? `\nWHAT THE AGENT LOOKED UP\n${needs.map((n) => `- ${n.id}: ${n.question}`).join('\n')}\n` : ''}
EVIDENCE (ChainGPT AI News; stale = older than ${windowDays} days, never present it as current)
${renderEvidence(evidence, d.evidenceSummary, d.titleChars)}
${hasPrevious ? `\n${renderPrevious(previous, previousWhen, d)}\n` : ''}
RULES
- evidenceIds: the E ids each opportunity relies on ([] if none); cite only ids shown above.
${memoryRule}${decisionRule}
${JSON_DISCIPLINE}

SHAPE: {"opportunities":[{"title":"","relevance":0,"signal":"one-line current signal","why":"","opportunity":"","action":"","evidenceIds":[],"outcomeIds":[],"memoryInfluence":{"used":false,"knowledgeIds":[],"reason":""},"liveEvidence":{"used":false,"summary":"","evidenceTypes":[]}}]}`;
}

// ------------------------------------------------------------ decision review

export interface DecisionReviewInput {
  previous: PreviousRecommendation[];
  current: { label: string; title: string; action: string; why: string }[];
  learned: {
    outcomes: { id: string; outcomeType: string; opportunityTitle?: string; notes?: string }[];
    knowledge: { id: string; title: string }[];
    actions: { actionType: string; opportunityTitle: string }[];
    newEvidence: { id: string; title: string; ageDays: number }[];
  };
}

/**
 * The Decision Delta's "why", as its own short call on repeat scans.
 *
 * VERIFIED LIVE 2026-09-18: asked inside the main scan prompt, the model ignored
 * the P labels and returned every recommendation as unrelated, with no reason -
 * the hero moment went blank. A short, single-purpose prompt is the kind this
 * model follows (same finding as the repair pass), so the comparison is asked
 * separately, after the new recommendations exist.
 */
export function buildDecisionReviewPrompt(input: DecisionReviewInput): string {
  const { previous, current, learned } = input;
  const lines = [
    ...learned.outcomes.map((o) => `- outcome ${o.id}: ${OUTCOME_TEXT[o.outcomeType] ?? o.outcomeType}${o.opportunityTitle ? ` on "${cut(o.opportunityTitle, 80)}"` : ''}${o.notes ? ` (${cut(o.notes, 80)})` : ''}`),
    ...learned.knowledge.map((k) => `- saved research ${k.id}: "${cut(k.title, 80)}"`),
    ...learned.actions.map((a) => `- action: ${a.actionType.replace(/_/g, ' ')} on "${cut(a.opportunityTitle, 80)}"`),
    ...learned.newEvidence.map((e) => `- new article ${e.id} (${ageText(e.ageDays)}): "${cut(e.title, 90)}"`),
  ];
  return `${JSON_PREAMBLE}TASK_ID: decision_review
A KULT Agent made recommendations in its last scan (P items) and makes new ones now (N items).
For each N item decide: "kept" = it continues a P item, "changed" = it revises or replaces a P item,
"new" = it relates to no P item. Give one reason per N item naming what the Agent learned that caused
it (by id), or saying plainly that nothing new changed it. Then list every P item that no N item
continues, with why it was dropped.

LEARNED SINCE THE LAST SCAN
${lines.length ? lines.join('\n') : '- nothing new'}

LAST SCAN
${previous.map((p) => {
    const acted = p.actions.map((a) => a.actionType.replace(/_/g, ' ')).join(', ');
    const results = p.outcomes.map((o) => OUTCOME_TEXT[o.outcomeType] ?? o.outcomeType).join(', ');
    return `- ${p.label}: "${cut(p.title, 90)}"${acted ? ` | then: ${acted}${results ? ` -> ${results}` : ''}` : ' | not acted on'}`;
  }).join('\n')}

NOW
${current.map((c) => `- ${c.label}: "${cut(c.title, 90)}" | action: ${cut(c.action, 120)} | why: ${cut(c.why, 120)}`).join('\n')}

SHAPE: {"decisions":[{"item":"N1","status":"kept|changed|new","previousId":"P1 or empty","reason":""}],"dropped":[{"previousId":"P2","reason":""}]}`;
}

// -------------------------------------------------------------- deep research

export function buildResearchPrompt(
  ctx: KultContext,
  opportunity: { title: string; signal: string; why: string; opportunity: string; action: string },
  evidence: EvidenceRef[],
  d: PromptDetail = FULL,
): string {
  const f = d.fieldChars;
  return `${JSON_PREAMBLE}TASK_ID: deep_research
You are the Web3 intelligence engine for a persistent KULT Agent. Turn the selected opportunity
into an actionable plan for THIS Agent.

SELECTED OPPORTUNITY: ${cut(opportunity.title, d.titleChars)}
- signal: ${cut(opportunity.signal, f)}
- why: ${cut(opportunity.why, f)}
- opportunity: ${cut(opportunity.opportunity, f)}
- proposed action: ${cut(opportunity.action, f)}

${renderContext(ctx, d)}

EVIDENCE (ChainGPT AI News; stale = older than the freshness window, never present it as current)
${renderEvidence(evidence, d.evidenceSummary ? d.evidenceSummary + 40 : 0, d.titleChars)}

RULES
- Use live Web3 data (news, market, on-chain, social) only where it materially supports this opportunity.
- An item resting on a retrieved article sets evidenceId to that R id; otherwise "".
- No meaningful live evidence: empty items, and say so in confidenceNote. Never invent a source.
- Exactly 3 recommendedActions, concrete enough to start today.
${JSON_DISCIPLINE}

SHAPE: {"summary":"","whyNow":"","fitForAgent":"","liveEvidence":{"summary":"","items":[{"type":"news|on-chain|market|social","evidence":"","sourceLabel":"","evidenceId":""}],"confidenceNote":""},"recommendedActions":["","",""],"targets":[""],"growthAngle":"","risks":[""]}`;
}

// ------------------------------------------------------------- creator growth

export function buildGrowthPrompt(ctx: KultContext, evidence: EvidenceRef[], d: PromptDetail = FULL): string {
  const p = ctx.project!;
  const priorGrowth = ctx.recentKnowledge.filter((k) => k.type === 'creator_growth_plan');
  const traction = p.stats
    ? `${p.stats.plays} plays${p.stats.likes ? `, ${p.stats.likes} likes` : ''}${p.stats.shares ? `, ${p.stats.shares} shares` : ''}${
        p.stats.comments ? `, ${p.stats.comments} comments` : ''}${p.stats.featured ? ', featured in the KULT browser' : ''}`
    : '';

  return `${JSON_PREAMBLE}TASK_ID: creator_growth
You are the Web3 intelligence engine inside KULT Create. A creator has published an experience.
Decide where the real opportunity is now, who to target, how to position it, and what to do next.

KULT CREATE PROJECT ${p.id}: ${cut(p.title, d.titleChars)} (${p.category}, published ${p.publishedAt.slice(0, 10)})
- description: ${cut(p.description, d.fieldChars * 2)}
- tags: ${p.tags.slice(0, d.profileItems).join(', ')} | audience: ${p.audience.join(', ')} | creator goals: ${p.goals.join(', ')}${
    traction ? `\n- real KULT traction: ${traction}` : ''
  }

${renderContext(ctx, d)}
${priorGrowth.length ? `\nPRIOR GROWTH KNOWLEDGE: ${priorGrowth.length} saved plan(s) above - build past them, do not repeat them.\n` : ''}
EVIDENCE (ChainGPT AI News; stale items must not be presented as current)
${renderEvidence(evidence, d.evidenceSummary, d.titleChars)}

TASK: exactly 3 ranked growth opportunities, each naming concrete targets (ecosystems, communities,
programmes or partner types) and one concrete next action; then a campaign brief with positioning
and a single first action.
${JSON_DISCIPLINE}

SHAPE: {"opportunities":[{"title":"","relevance":0,"why":"why this project fits","targets":[""],"growthAngle":"","action":""}],"campaignBrief":{"positioning":"","firstAction":""}}`;
}

// -------------------------------------------------------------------- repair

/** Ids the repair pass may use, one per line: "E1: Immutable opens a grants track". */
export function renderCitableIds(items: { id: string; label: string }[]): string {
  return items.map((i) => `- ${i.id}: ${cut(i.label, 70)}`).join('\n');
}

/**
 * One-shot repair prompt used by the parser when validation fails (spec 12.4).
 * Kept short on purpose - see the header note - and, when `citable` is given, it
 * lists the ids the first answer could have cited so the rewrite can recover
 * provenance from prose that names an article or a previous recommendation.
 * The response gets whatever room the budget leaves, so the whole prompt stays
 * inside what ChainGPT reads in full.
 */
export function buildRepairPrompt(badText: string, reason: string, shape: string, citable?: string): string {
  const head = `TASK_ID: repair
Rewrite the response below as ONE valid JSON object with exactly this shape. Output only the object - no fences, no commentary:
${shape}

RULES
- Every string field must be filled from the response. An empty string is NOT acceptable: the shape shows structure, not values to copy.
- Reorganising prose into the right field is not inventing. Typical mapping: a title or heading -> "title"; relevance, importance or "why it matters" -> "why"; the opening or trend -> "opportunity" and "signal"; next steps or recommended actions -> "action".
- relevance is an integer 0-100 judged from the response: a strong fit is 80-95, never 8 or 9.
- Add no facts the response does not support.${
    citable
      ? `
- Ids: compare each item with CITABLE IDS. If it discusses the same event, programme or topic as an E item, add that E id to evidenceIds. Add the out_ and kn_ ids it builds on. Use only listed ids, and only where the response clearly refers to that item.

CITABLE IDS
${citable}`
      : ''
  }

(Parse failure: ${reason.slice(0, 160)})

RESPONSE:
`;
  const room = Math.max(1500, config.promptCharBudget - head.length);
  return head + badText.slice(0, room);
}
