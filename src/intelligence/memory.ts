import { db } from '../db/store.js';
import type { ActionRecord, Agent, CreatorProject, KnowledgeItem, OutcomeRecord } from '../types.js';

/**
 * Memory selection - spec 8.1 / 14.2.
 *
 * Deliberately not "send the whole history": recency plus keyword overlap against
 * the Agent's current goals and interests. No vector database is introduced for
 * the POC; swap `scoreRelevance` for KULT's embeddings if they already exist.
 */

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','into','your','their','have','has','are','was','were',
  'a','an','of','to','in','on','it','is','be','as','by','or','at','we','you','our','they','them','not',
]);

function tokenize(text: string): Set<string> {
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

export interface KultContext {
  agent: Agent;
  project?: CreatorProject;
  recentKnowledge: KnowledgeItem[];
  recentActions: ActionRecord[];
  recentOutcomes: OutcomeRecord[];
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
    recentOutcomes: selectRecentOutcomes(agent.id, 5),
  };
}

export function hasPriorIntelligence(agentId: string): boolean {
  return db.read().knowledge.some((k) => k.agentId === agentId);
}
