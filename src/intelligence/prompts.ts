import type { Signal } from '../types.js';
import type { KultContext } from './memory.js';
import { renderSignals } from './signals.js';

/**
 * Prompt contracts - spec 12.
 *
 * Stable KULT product knowledge lives in the ChainGPT AI Hub context attached to
 * the dedicated API key (spec 11.5), so these prompts carry only the dynamic
 * Agent / project / memory / query layer.
 */

/**
 * Live-verified: the model returns fenced JSON, omits the top-level wrapper key,
 * and writes `"relevance": "High"` instead of a number unless told otherwise.
 * These rules target exactly those observed failures.
 */
/**
 * VERIFIED LIVE: on a ~5k-char prompt the model ignored the JSON instruction
 * entirely and answered in markdown prose. The repair pass rescued it, but
 * salvaged fragments produced junk opportunities. So the demand is now stated
 * BOTH before and after the content, and pins the very first character.
 */
const JSON_PREAMBLE = `RESPONSE FORMAT: raw JSON only.
Your entire response must be a single JSON object. The first character you output
must be "{" and the last must be "}". Do not write an introduction, a markdown
list, or any prose outside the JSON.
`;

const JSON_DISCIPLINE = `
OUTPUT RULES (strict - violations make the response unusable):
- Return ONE JSON object and nothing else.
- No markdown fences, no \`\`\`json, no preamble, no trailing commentary.
- The TOP-LEVEL object MUST use the exact wrapper key shown in the shape below.
  Do NOT return a bare single object; the array must be nested under that key.
- Return the exact number of array items requested - no more, no fewer.
- Every "relevance" value MUST be an integer between 0 and 100 (e.g. 87).
  NEVER a word such as "High", "Medium" or "Low", and never a string.
- All string values must be plain prose on a single line, without newlines.
- Never invent sources, metrics or evidence. If there is no live evidence, say so and set used=false.
- Nested fields such as memoryInfluence and liveEvidence must be JSON OBJECTS, never sentences.

Output the JSON object now, starting with "{". No preamble.`;

function renderContext(ctx: KultContext): string {
  const { agent, recentKnowledge, recentActions, recentOutcomes } = ctx;

  const knowledge = recentKnowledge.length
    ? recentKnowledge
        .map((k) => `- KNOWLEDGE_ID: ${k.id} | ${k.type} | "${k.title}"\n  ${k.summary.slice(0, 400)}`)
        .join('\n')
    : '(none yet)';

  const actions = recentActions.length
    ? recentActions.map((a) => `- ${a.actionType} on "${a.opportunityTitle}" [${a.status}]`).join('\n')
    : '(none yet)';

  const outcomes = recentOutcomes.length
    ? recentOutcomes.map((o) => `- ${o.outcomeType}${o.notes ? `: ${o.notes.slice(0, 160)}` : ''}`).join('\n')
    : '(none yet)';

  return `KULT AGENT
- id: ${agent.id}
- name: ${agent.name}
- role: ${agent.role}
- interests: ${agent.interests.join(', ')}
- capabilities: ${agent.capabilities.join(', ')}

KULT ACTIVITY
${agent.activity.map((a) => `- ${a}`).join('\n')}

CURRENT GOALS
${agent.goals.map((g) => `- ${g}`).join('\n')}

RECENT SAVED KNOWLEDGE (KULT canonical memory)
${knowledge}

RECENT ACTIONS
${actions}

RECENT OUTCOMES
${outcomes}`;
}

// --------------------------------------------------------------- opportunities

export function buildOpportunityPrompt(ctx: KultContext, signals: Signal[], query: string): string {
  const hasMemory = ctx.recentKnowledge.length > 0;

  // Spec 8.2: if memory exists, one recommendation must state how it changes the
  // next step. Without this the compounding-intelligence moment is left to chance.
  const memoryDirective = hasMemory
    ? `MEMORY REQUIREMENT (mandatory):
This Agent has saved prior intelligence, listed above. At least ONE opportunity MUST set
memoryInfluence.used = true, cite the relevant KNOWLEDGE_ID values in memoryInfluence.knowledgeIds,
and explain in memoryInfluence.reason how that prior knowledge changes the recommended next step.
It must advance beyond the earlier research, not restate it.`
    : `MEMORY REQUIREMENT:
This Agent has no saved intelligence yet. Set memoryInfluence.used = false on every opportunity.`;

  return `${JSON_PREAMBLE}
TASK_ID: opportunity_radar

SYSTEM INTENT: You are the Web3 intelligence engine inside a persistent KULT Agent
experience. Combine current ChainGPT Web3 signals with the KULT Agent context and prior
saved knowledge below. Do not summarise news generically.

TASK: Identify exactly 3 opportunities relevant to THIS Agent now. Every opportunity must
answer "why does this matter to this Agent now?". Recommend what the Agent should DO next,
not what happened. Use live Web3 / on-chain / off-chain evidence only where it materially
supports the recommendation.

${renderContext(ctx)}

FOCUS QUERY: ${query}

CURRENT WEB3 SIGNALS (ChainGPT AI Crypto News)
${renderSignals(signals)}

${memoryDirective}

SCORING: relevance is an integer 0-100 expressing fit to THIS Agent, not general importance.
${JSON_DISCIPLINE}

OUTPUT JSON SHAPE:
{
  "opportunities": [
    {
      "title": "string",
      "relevance": 0,
      "signal": "the current external signal in one line",
      "why": "why this matters to this Agent specifically",
      "opportunity": "the concrete opportunity",
      "action": "the concrete next action",
      "memoryInfluence": { "used": false, "knowledgeIds": [], "reason": "" },
      "liveEvidence": { "used": false, "summary": "", "evidenceTypes": [] }
    }
  ]
}`;
}

// -------------------------------------------------------------- deep research

export function buildResearchPrompt(
  ctx: KultContext,
  opportunity: { title: string; signal: string; why: string; opportunity: string; action: string },
  signals: Signal[],
): string {
  return `${JSON_PREAMBLE}
TASK_ID: deep_research

SYSTEM INTENT: You are the Web3 intelligence engine inside a persistent KULT Agent
experience. Turn the selected opportunity into an actionable plan for THIS Agent.

SELECTED OPPORTUNITY
- title: ${opportunity.title}
- current signal: ${opportunity.signal}
- why it matters: ${opportunity.why}
- opportunity: ${opportunity.opportunity}
- proposed action: ${opportunity.action}

${renderContext(ctx)}

FRESH WEB3 SIGNALS (ChainGPT AI Crypto News)
${renderSignals(signals, 5)}

LIVE EVIDENCE RULES:
Use your live Web3 capabilities (market, on-chain, token, wallet, narrative, news and social
data) ONLY where they materially support this specific opportunity. Grant and programme
opportunities usually need news evidence, not token metrics. If no meaningful live evidence
exists, return an empty items array and say so plainly in confidenceNote. Never manufacture
a signal or a source label.

Provide exactly 3 recommendedActions, concrete enough to start today.
${JSON_DISCIPLINE}

OUTPUT JSON SHAPE:
{
  "summary": "string",
  "whyNow": "string",
  "fitForAgent": "string",
  "liveEvidence": {
    "summary": "string",
    "items": [{ "type": "news|on-chain|market|social", "evidence": "string", "sourceLabel": "string" }],
    "confidenceNote": "string"
  },
  "recommendedActions": ["string", "string", "string"],
  "targets": ["string"],
  "growthAngle": "string",
  "risks": ["string"]
}`;
}

// ------------------------------------------------------------- creator growth

export function buildGrowthPrompt(ctx: KultContext, signals: Signal[]): string {
  const p = ctx.project!;
  const priorGrowth = ctx.recentKnowledge.filter((k) => k.type === 'creator_growth_plan');

  return `${JSON_PREAMBLE}
TASK_ID: creator_growth

SYSTEM INTENT: You are the Web3 intelligence engine inside KULT Create. A creator has built
and published an experience. Determine where the real opportunity is now, who should be
targeted, how the project should be positioned, and what to do next.

KULT CREATE PROJECT
- id: ${p.id}
- title: ${p.title}
- category: ${p.category}
- description: ${p.description}
- tags: ${p.tags.join(', ')}
- audience: ${p.audience.join(', ')}
- creator goals: ${p.goals.join(', ')}
- published: ${p.publishedAt.slice(0, 10)}${
    p.stats
      ? `\n- real KULT traction: ${p.stats.plays} plays${
          p.stats.likes ? `, ${p.stats.likes} likes` : ''
        }${p.stats.shares ? `, ${p.stats.shares} shares` : ''}${
          p.stats.comments ? `, ${p.stats.comments} comments` : ''
        }${p.stats.featured ? ', featured in the KULT browser' : ''}`
      : ''
  }

${renderContext(ctx)}

${priorGrowth.length ? `PRIOR GROWTH KNOWLEDGE: ${priorGrowth.length} saved plan(s) above - build past them rather than repeating them.` : ''}

CURRENT WEB3 SIGNALS (ChainGPT AI Crypto News)
${renderSignals(signals)}

TASK: Return exactly 3 ranked growth opportunities. Each must name concrete targets
(ecosystems, communities, programmes or partner types) and one concrete next action.
Then give a campaign brief with positioning and a single first action.
${JSON_DISCIPLINE}

OUTPUT JSON SHAPE:
{
  "opportunities": [
    {
      "title": "string",
      "relevance": 0,
      "why": "why this specific project fits",
      "targets": ["string"],
      "growthAngle": "string",
      "action": "string"
    }
  ],
  "campaignBrief": { "positioning": "string", "firstAction": "string" }
}`;
}

// --------------------------------------------------------- memory enforcement

/**
 * Spec 8.2 is a P0: once an Agent has saved intelligence, the next scan must
 * visibly build on it. The live model does not always comply with the in-prompt
 * directive, and that single moment is the whole point of the showcase.
 *
 * This is a targeted, cheap revision rather than a full re-scan: the model keeps
 * the opportunities it already produced and only fills in memoryInfluence on the
 * one that genuinely follows from prior knowledge. Regenerating instead would
 * cost more and change cards the user is already looking at.
 */
export function buildMemoryEnforcementPrompt(
  opportunities: { title: string; why: string; action: string }[],
  knowledge: { id: string; title: string; summary: string }[],
): string {
  return `TASK_ID: memory_enforcement

The Agent has prior saved intelligence, but none of the opportunities below stated
how it changes the next step. Decide which ONE opportunity most genuinely follows
from that prior knowledge, and explain the progression.

PRIOR SAVED KNOWLEDGE
${knowledge.map((k) => `- KNOWLEDGE_ID: ${k.id} | "${k.title}"\n  ${k.summary.slice(0, 300)}`).join('\n')}

OPPORTUNITIES (index from 0)
${opportunities.map((o, i) => `[${i}] ${o.title}\n    why: ${o.why}\n    action: ${o.action}`).join('\n')}

RULES:
- Pick exactly one index.
- reason must say what the prior research established and what the next step now is.
- It must ADVANCE beyond the earlier research, not restate it.
- Cite the KNOWLEDGE_ID values you actually used.
- One line of plain prose, no newlines.
- Return ONE JSON object, no markdown fences, no commentary.

OUTPUT JSON SHAPE:
{ "index": 0, "knowledgeIds": ["..."], "reason": "Builds on prior research into ..." }`;
}

// -------------------------------------------------------------------- repair

/** One-shot repair prompt used by the parser when validation fails (spec 12.4). */
export function buildRepairPrompt(badText: string, reason: string, shape: string): string {
  return `TASK_ID: repair

The previous response could not be parsed. Reason: ${reason}

Rewrite the content below as ONE valid JSON object matching this exact shape:
${shape}

Return only the JSON object. No fences, no commentary. Preserve the original meaning;
do not invent new facts.

PREVIOUS RESPONSE:
${badText.slice(0, 6000)}`;
}
