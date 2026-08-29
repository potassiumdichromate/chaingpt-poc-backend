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
  result: unknown;
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
  timestamp: string;
}

/** A current external Web3 signal from ChainGPT AI Crypto News. */
export interface Signal {
  id: string;
  title: string;
  description: string;
  source: string;
  url?: string;
  publishedAt: string;
  category?: string;
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
}
