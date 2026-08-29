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
  signal: z.string().min(3),
  why: z.string().min(3),
  opportunity: z.string().min(3),
  action: z.string().min(3),
  memoryInfluence: memoryInfluenceSchema,
  liveEvidence: liveEvidenceSummarySchema,
});

export const opportunitySetSchema = z.object({
  opportunities: z.array(opportunitySchema).min(1).max(5),
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

/** Spec 8.2 memory-enforcement revision (see buildMemoryEnforcementPrompt). */
export const memoryEnforcementSchema = z.object({
  index: z.coerce.number().int().min(0).max(4),
  knowledgeIds: z.array(z.string()).default([]),
  reason: z.string().min(10),
});

export type OpportunitySetOut = z.infer<typeof opportunitySetSchema>;
export type DeepResearchOut = z.infer<typeof deepResearchSchema>;
export type GrowthPlanOut = z.infer<typeof growthPlanSchema>;
