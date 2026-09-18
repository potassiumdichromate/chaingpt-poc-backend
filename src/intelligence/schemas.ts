import { z } from 'zod';

/**
 * Structured output contracts - spec 12. Every model response is validated
 * against these before it is allowed anywhere near the UI.
 */

const memoryInfluenceSchema = z
  .object({
    used: z.boolean().default(false),
    reason: z.string().default(''),
    knowledgeIds: z.array(z.string()).optional(),
  })
  .default({ used: false, reason: '' });

/**
 * Id lists the model cites. Lenient on shape - live output has used both arrays
 * and "E1, E2" strings - because the engine validates every id against what was
 * actually in the prompt anyway. Garbage becomes an empty list, never a 502.
 */
const idList = z
  .preprocess(
    (v) => (typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v ?? []),
    z.array(z.coerce.string()),
  )
  .catch([]);

/** How a recommendation relates to the previous scan. Validated against P-labels by the engine. */
const decisionSchema = z
  .object({
    status: z.enum(['kept', 'changed', 'new']).catch('new'),
    previousId: z.coerce.string().default(''),
    reason: z.coerce.string().default(''),
  })
  .optional()
  .catch(undefined);

const liveEvidenceSummarySchema = z
  .object({
    used: z.boolean().default(false),
    summary: z.string().default(''),
    evidenceTypes: z.array(z.string()).default([]),
  })
  .optional();

export const opportunitySchema = z.object({
  title: z.string().min(3),
  relevance: z.coerce.number().min(0).max(100),
  /**
   * Deliberately NOT min(3): the engine proceeds on KULT context alone when AI
   * News returns nothing (engine.ts "signals_unavailable_continuing"), and a
   * model with no signals to cite correctly returns "". Requiring a non-empty
   * string here turned that supported path into a 502. The engine substitutes an
   * explicit "no signal" line so the absence is stated, never invented.
   */
  signal: z.string().default(''),
  why: z.string().min(3),
  opportunity: z.string().min(3),
  action: z.string().min(3),
  memoryInfluence: memoryInfluenceSchema,
  liveEvidence: liveEvidenceSummarySchema,
  evidenceIds: idList,
  outcomeIds: idList,
  decision: decisionSchema,
});

export const opportunitySetSchema = z.object({
  opportunities: z.array(opportunitySchema).min(1).max(5),
  /** Previous recommendations the model chose not to continue, with its reason. */
  dropped: z
    .array(z.object({ previousId: z.coerce.string().default(''), reason: z.coerce.string().default('') }))
    .catch([])
    .default([]),
});

export const deepResearchSchema = z.object({
  summary: z.string().min(3),
  whyNow: z.string().min(3),
  fitForAgent: z.string().min(3),
  liveEvidence: z
    .object({
      summary: z.string().default(''),
      items: z
        .array(
          z.object({
            type: z.enum(['news', 'on-chain', 'market', 'social']).catch('news'),
            evidence: z.string(),
            sourceLabel: z.string().default('ChainGPT'),
            evidenceId: z.coerce.string().default(''),
          }),
        )
        .default([]),
      confidenceNote: z.string().default(''),
    })
    .default({ summary: '', items: [], confidenceNote: '' }),
  recommendedActions: z.array(z.string()).min(1),
  targets: z.array(z.string()).default([]),
  growthAngle: z.string().default(''),
  risks: z.array(z.string()).default([]),
});

export const growthPlanSchema = z.object({
  opportunities: z
    .array(
      z.object({
        title: z.string().min(3),
        relevance: z.coerce.number().min(0).max(100),
        why: z.string().min(3),
        targets: z.array(z.string()).default([]),
        growthAngle: z.string().default(''),
        action: z.string().min(3),
      }),
    )
    .min(1)
    .max(5),
  campaignBrief: z
    .object({
      positioning: z.string().default(''),
      firstAction: z.string().default(''),
    })
    .default({ positioning: '', firstAction: '' }),
});

/** Decision review (see buildDecisionReviewPrompt). Labels are validated by the engine. */
export const decisionReviewSchema = z.object({
  decisions: z
    .array(z.object({
      item: z.coerce.string(),
      status: z.enum(['kept', 'changed', 'new']).catch('new'),
      previousId: z.coerce.string().default(''),
      reason: z.coerce.string().default(''),
    }))
    .min(1),
  dropped: z
    .array(z.object({ previousId: z.coerce.string().default(''), reason: z.coerce.string().default('') }))
    .catch([])
    .default([]),
});

export type OpportunitySetOut = z.infer<typeof opportunitySetSchema>;
export type DeepResearchOut = z.infer<typeof deepResearchSchema>;
export type GrowthPlanOut = z.infer<typeof growthPlanSchema>;
