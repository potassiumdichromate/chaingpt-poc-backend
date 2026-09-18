/** Data model - spec 14. */

export interface Agent {
  id: string;
  name: string;
  role: string;
  interests: string[];
  capabilities: string[];
  activity: string[];
  goals: string[];
  avatarSeed?: string;
}

export interface CreatorProject {
  id: string;
  ownerAgentId: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  audience: string[];
  goals: string[];
  publishedAt: string;
  /** Real KULT CDN thumbnail. */
  thumbnailUrl?: string;
  /** Real KULT play path, e.g. /play?gameId=xxx */
  playPath?: string;
  /** Real KULT build provenance. */
  build?: { tier?: string; templateId?: string; generatedIn?: string; reliability?: string };
  /** Real KULT engagement counters. avgSessionMin is absent because KULT tracks
   *  plays, not session length - never synthesise it. */
  stats?: {
    plays: number;
    likes?: number;
    shares?: number;
    comments?: number;
    favorites?: number;
    featured?: boolean;
  };
}

export type KnowledgeType =
  | 'opportunity_research'
  | 'creator_growth_plan'
  | 'partner_research'
  | 'ecosystem_research'
  | 'action_summary'
  | 'outcome_summary';

export interface KnowledgeItem {
  id: string;
  agentId: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  payload: unknown;
  sourceProvider: string;
  sourceRefs: string[];
  projectId?: string;
  createdAt: string;
}

export interface OpportunityRun {
  id: string;
  agentId: string;
  query: string;
  provider: string;
  signalIds: string[];
  usedKnowledgeIds: string[];
  /** Outcome ids that were in the prompt, so a later delta can say what was new. */
  usedOutcomeIds?: string[];
  result: unknown;
  /** What the Agent decided to look up before reasoning, and what came back. */
  plan?: EvidencePlan;
  evidence?: EvidenceRef[];
  evidenceQuality?: EvidenceQuality;
  previousRunId?: string | null;
  decisionDelta?: DecisionDelta | null;
  createdAt: string;
}

export type ActionType =
  | 'contacted_ecosystem'
  | 'applied_to_program'
  | 'created_campaign'
  | 'researched_partner'
  | 'added_to_pipeline'
  | 'dismissed';

export interface ActionRecord {
  id: string;
  agentId: string;
  opportunityId: string;
  opportunityTitle: string;
  /** The scan that surfaced the opportunity - links outcome -> action -> recommendation. */
  runId?: string;
  actionType: ActionType;
  status: 'taken' | 'pending' | 'dismissed';
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type OutcomeType =
  | 'no_response'
  | 'conversation_started'
  | 'partnership_opportunity'
  | 'campaign_launched'
  | 'players_acquired'
  | 'not_relevant'
  | 'other';

export interface OutcomeRecord {
  id: string;
  agentId: string;
  actionId: string;
  outcomeType: OutcomeType;
  value?: string;
  notes?: string;
  createdAt: string;
}

export interface AnalyticsEvent {
  id: string;
  name: string;
  agentId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  /** Anonymous browser id, so metrics can count distinct users without auth. */
  clientId?: string;
  /** Authenticated user (Privy DID) when AUTH_MODE=privy. */
  userId?: string;
  timestamp: string;
}

/** One billable provider call, recorded per attempt so retries are counted too. */
export interface ProviderCallRecord {
  id: string;
  provider: string;
  kind: 'news' | 'chat';
  label: string;
  ok: boolean;
  category?: string;
  latencyMs: number;
  chatHistory?: boolean;
  /** Estimated from configured per-call rates - ChainGPT does not report usage per call. */
  estimatedCredits: number;
  agentId?: string;
  clientId?: string;
  at: string;
}

/** A current external Web3 signal from ChainGPT AI Crypto News. */
export interface Signal {
  id: string;
  title: string;
  description: string;
  source: string;
  url?: string;
  publishedAt: string;
  /** ChainGPT news category, e.g. "Blockchain Gaming". Null on most rows. */
  category?: string;
  categoryId?: number;
  /** ChainGPT's subCategory is the blockchain, e.g. "Ethereum". */
  chain?: string;
  token?: string;
}

export type Freshness = 'fresh' | 'aging' | 'stale';

export type EvidenceTrigger =
  | 'user_focus'
  | 'outcome'
  | 'previous_recommendation'
  | 'goal'
  | 'coverage'
  | 'opportunity';

/** One thing the Agent decided it needs to know before reasoning. */
export interface EvidenceNeed {
  id: string;
  question: string;
  reason: string;
  trigger: EvidenceTrigger;
  triggerRef?: { kind: 'outcome' | 'opportunity' | 'goal' | 'query'; id?: string; label: string };
  /** News search phrases, most specific first. The News API matches literally. */
  phrases: string[];
  categoryIds?: number[];
  /** Maximum signals this need may contribute to the prompt. */
  quota: number;
}

export interface EvidenceNeedResult extends EvidenceNeed {
  usedPhrase: string | null;
  evidenceIds: string[];
  status: 'fresh' | 'stale_only' | 'none' | 'failed';
  newestAgeDays: number | null;
}

export interface EvidencePlan {
  strategy: 'rules';
  windowDays: number;
  needs: EvidenceNeedResult[];
}

/** A retrieved signal as the prompt and the UI see it: stable id plus age. */
export interface EvidenceRef {
  id: string;
  signalId: string;
  needId?: string;
  title: string;
  summary: string;
  source: string;
  publishedAt: string;
  ageDays: number;
  freshness: Freshness;
  category?: string;
  chain?: string;
  token?: string;
  /** True when the same article was already in the previous scan. */
  seenBefore?: boolean;
}

export interface EvidenceQuality {
  total: number;
  fresh: number;
  aging: number;
  stale: number;
  newestAgeDays: number | null;
  oldestAgeDays: number | null;
  windowDays: number;
  /** True when no in-window news matched and older articles were used instead. */
  relaxedFreshness: boolean;
  level: 'good' | 'mixed' | 'stale' | 'none';
  note: string;
}

export interface Confidence {
  level: 'high' | 'medium' | 'low';
  score: number;
  reasons: string[];
}

export interface KnowledgeRef { id: string; title: string; type: KnowledgeType; createdAt: string }
export interface OutcomeRef {
  id: string;
  outcomeType: OutcomeType;
  notes?: string;
  opportunityTitle?: string;
  createdAt: string;
}

/** Exactly which ChainGPT evidence and which KULT memory a recommendation rests on. */
export interface Provenance {
  /** `cited` = the model named the id; `matched` = attributed by text overlap. */
  evidence: (EvidenceRef & { attribution: 'cited' | 'matched' })[];
  knowledge: KnowledgeRef[];
  outcomes: OutcomeRef[];
}

export type DecisionStatus = 'kept' | 'changed' | 'new';

export interface OpportunityDecision {
  status: DecisionStatus;
  previousLabel?: string;
  previousOpportunityId?: string;
  previousTitle?: string;
  reason: string;
  /** `model` = explained by the model; `matched` = linked by title only; `none` = no link. */
  attribution: 'model' | 'matched' | 'none';
}

/** Previous recommendation -> what was learned -> what changed -> why. */
export interface DecisionDelta {
  previousRunId: string;
  previousRunAt: string;
  learned: {
    newEvidence: EvidenceRef[];
    repeatedEvidence: number;
    knowledge: KnowledgeRef[];
    actions: { id: string; opportunityTitle: string; actionType: ActionType; createdAt: string }[];
    outcomes: OutcomeRef[];
  };
  decisions: (OpportunityDecision & { opportunityId: string; title: string })[];
  dropped: {
    previousLabel: string;
    opportunityId: string;
    title: string;
    reason: string;
    attribution: 'model' | 'derived';
  }[];
  counts: { kept: number; changed: number; new: number; dropped: number };
  summary: string;
}

export interface MemoryInfluence {
  used: boolean;
  knowledgeIds: string[];
  reason: string;
}

export interface LiveEvidenceItem {
  type: 'news' | 'on-chain' | 'market' | 'social';
  evidence: string;
  sourceLabel: string;
  /** Set when the item cites a retrieved ChainGPT article (R1..). */
  evidenceId?: string;
  publishedAt?: string;
  ageDays?: number;
  freshness?: Freshness;
}

export interface Opportunity {
  id: string;
  title: string;
  relevance: number;
  signal: string;
  why: string;
  opportunity: string;
  action: string;
  memoryInfluence: MemoryInfluence;
  liveEvidence?: { used: boolean; summary: string; evidenceTypes: string[] };
  provenance: Provenance;
  confidence: Confidence;
  /** Present on repeat scans: how this relates to the previous recommendation. */
  decision?: OpportunityDecision;
}

export interface DeepResearch {
  summary: string;
  whyNow: string;
  fitForAgent: string;
  liveEvidence: { summary: string; items: LiveEvidenceItem[]; confidenceNote: string };
  recommendedActions: string[];
  targets: string[];
  growthAngle: string;
  risks: string[];
}

export interface GrowthOpportunity {
  id: string;
  title: string;
  relevance: number;
  why: string;
  targets: string[];
  growthAngle: string;
  action: string;
}

export interface GrowthPlan {
  opportunities: GrowthOpportunity[];
  campaignBrief: { positioning: string; firstAction: string };
}

export interface StoreShape {
  agents: Agent[];
  projects: CreatorProject[];
  knowledge: KnowledgeItem[];
  runs: OpportunityRun[];
  actions: ActionRecord[];
  outcomes: OutcomeRecord[];
  events: AnalyticsEvent[];
  providerCalls: ProviderCallRecord[];
}
