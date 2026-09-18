import { db } from '../db/store.js';
import type {
  ActionRecord, Agent, CreatorProject, KnowledgeItem, KnowledgeRef, OpportunityRun, OutcomeRecord, OutcomeRef,
} from '../types.js';

/**
 * KULT Agent memory - the Agent's canonical, persistent memory.
 *
 * KULT owns memory; ChainGPT is used statelessly as the live Web3 intelligence and
 * reasoning layer (chatHistory stays off, and every prompt carries the memory it
 * needs). This module is the ONLY code that reads or writes Agent memory -
 * knowledge, runs, actions and outcomes. Today it is backed by the POC's own
 * database; when KULT exposes an Agent memory API, swap the store calls here and
 * nothing else in the service changes.
 *
 * Selection - spec 8.1 / 14.2: deliberately not "send the whole history", but
 * recency plus keyword overlap against the Agent's current goals and interests.
 */

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','into','your','their','have','has','are','was','were',
  'a','an','of','to','in','on','it','is','be','as','by','or','at','we','you','our','they','them','not',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  return hits;
}

/** Recency decays over roughly a fortnight so fresh intelligence outranks stale. */
function recencyScore(iso: string): number {
  const ageDays = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return Math.max(0, 1 - ageDays / 14);
}

// -------------------------------------------------------------------- reads

export function selectRelevantKnowledge(
  agentId: string,
  focusText: string,
  limit = 5,
): KnowledgeItem[] {
  const focus = tokenize(focusText);
  return db
    .read()
    .knowledge.filter((k) => k.agentId === agentId)
    .map((k) => {
      const tokens = tokenize(`${k.title} ${k.summary}`);
      return { item: k, score: overlap(focus, tokens) * 2 + recencyScore(k.createdAt) * 3 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

export function selectRecentActions(agentId: string, limit = 5): ActionRecord[] {
  return db.read().actions.filter((a) => a.agentId === agentId).slice(-limit).reverse();
}

export function selectRecentOutcomes(agentId: string, limit = 5): OutcomeRecord[] {
  return db.read().outcomes.filter((o) => o.agentId === agentId).slice(-limit).reverse();
}

export function findAction(agentId: string, actionId: string): ActionRecord | undefined {
  return db.read().actions.find((a) => a.id === actionId && a.agentId === agentId);
}

/** An outcome with the recommendation it was the result of, for prompts and provenance. */
export function outcomeRef(o: OutcomeRecord): OutcomeRef {
  const action = db.read().actions.find((a) => a.id === o.actionId);
  return {
    id: o.id,
    outcomeType: o.outcomeType,
    ...(o.notes ? { notes: o.notes } : {}),
    ...(action ? { opportunityTitle: action.opportunityTitle } : {}),
    createdAt: o.createdAt,
  };
}

export function knowledgeRef(k: KnowledgeItem): KnowledgeRef {
  return { id: k.id, title: k.title, type: k.type, createdAt: k.createdAt };
}

export function listKnowledge(agentId: string): KnowledgeItem[] {
  return db.read().knowledge.filter((k) => k.agentId === agentId).slice().reverse();
}

export function listActionsWithOutcomes(agentId: string) {
  const s = db.read();
  return s.actions
    .filter((a) => a.agentId === agentId)
    .slice()
    .reverse()
    .map((a) => ({ ...a, outcomes: s.outcomes.filter((o) => o.actionId === a.id) }));
}

export function listRuns(agentId: string): OpportunityRun[] {
  return db.read().runs.filter((r) => r.agentId === agentId);
}

export function latestRun(agentId: string): OpportunityRun | undefined {
  const runs = listRuns(agentId);
  return runs[runs.length - 1];
}

export function countGrowthPlans(projectId: string): number {
  return db.read().knowledge.filter((k) => k.projectId === projectId && k.type === 'creator_growth_plan').length;
}

export function agentStats(agentId: string) {
  const s = db.read();
  return {
    knowledgeItems: s.knowledge.filter((k) => k.agentId === agentId).length,
    actions: s.actions.filter((a) => a.agentId === agentId).length,
    outcomes: s.outcomes.filter((o) => o.agentId === agentId).length,
    scans: s.runs.filter((r) => r.agentId === agentId).length,
  };
}

/** Everything the Agent learned after a point in time - the raw input to a Decision Delta. */
export function memorySince(agentId: string, sinceIso: string) {
  const s = db.read();
  const after = (iso: string) => iso > sinceIso;
  return {
    knowledge: s.knowledge.filter((k) => k.agentId === agentId && after(k.createdAt)),
    actions: s.actions.filter((a) => a.agentId === agentId && after(a.createdAt)),
    outcomes: s.outcomes.filter((o) => o.agentId === agentId && after(o.createdAt)),
  };
}

export function hasPriorIntelligence(agentId: string): boolean {
  return db.read().knowledge.some((k) => k.agentId === agentId);
}

// ------------------------------------------------------------------- writes

export async function saveKnowledge(item: KnowledgeItem): Promise<void> {
  await db.append('knowledge', item);
}

export async function recordAction(action: ActionRecord): Promise<void> {
  await db.append('actions', action);
}

export async function recordOutcome(outcome: OutcomeRecord): Promise<void> {
  await db.append('outcomes', outcome);
}

export async function saveRun(run: OpportunityRun): Promise<void> {
  await db.append('runs', run);
}

// ------------------------------------------------------------------ context

export interface KultContext {
  agent: Agent;
  project?: CreatorProject;
  recentKnowledge: KnowledgeItem[];
  recentActions: ActionRecord[];
  /** Outcomes joined to the recommendation they came from. */
  recentOutcomes: OutcomeRef[];
}

/** Combines Agent state, saved memory and outcomes - the KULT Context Engine (spec 5.1). */
export function buildKultContext(
  agent: Agent,
  focusText: string,
  project?: CreatorProject,
): KultContext {
  return {
    agent,
    project,
    recentKnowledge: selectRelevantKnowledge(agent.id, focusText, 5),
    recentActions: selectRecentActions(agent.id, 5),
    recentOutcomes: selectRecentOutcomes(agent.id, 5).map(outcomeRef),
  };
}
