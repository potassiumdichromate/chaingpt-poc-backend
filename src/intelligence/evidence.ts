import { tokenize } from './memory.js';
import { ageDays } from './retrieval.js';
import type { Confidence, EvidenceQuality, EvidenceRef, Freshness, Provenance, Signal } from '../types.js';

/**
 * Evidence bookkeeping: stable ids, age, freshness, provenance and confidence.
 *
 * Everything here is deterministic. The model is asked to cite evidence ids, but
 * freshness, attribution and confidence are computed from what was actually
 * retrieved, so the model cannot make stale news look current or inflate how sure
 * a recommendation is.
 */

/** Within a week is fresh; inside the retrieval window is aging; beyond it is stale. */
export const FRESH_DAYS = 7;

export function freshnessOf(days: number, windowDays: number): Freshness {
  if (days <= FRESH_DAYS) return 'fresh';
  if (days <= windowDays) return 'aging';
  return 'stale';
}

export function toEvidenceRef(
  signal: Signal,
  id: string,
  windowDays: number,
  opts: { needId?: string; seenBefore?: boolean; now?: number } = {},
): EvidenceRef {
  const days = ageDays(signal.publishedAt, opts.now);
  return {
    id,
    signalId: signal.id,
    ...(opts.needId ? { needId: opts.needId } : {}),
    title: signal.title,
    summary: signal.description.slice(0, 240),
    source: signal.source,
    publishedAt: signal.publishedAt,
    ageDays: days,
    freshness: freshnessOf(days, windowDays),
    ...(signal.category ? { category: signal.category } : {}),
    ...(signal.chain ? { chain: signal.chain } : {}),
    ...(signal.token ? { token: signal.token } : {}),
    ...(opts.seenBefore !== undefined ? { seenBefore: opts.seenBefore } : {}),
  };
}

function ago(days: number): string {
  return days === 0 ? 'today' : days === 1 ? '1 day old' : `${days} days old`;
}

export function summarizeQuality(
  evidence: EvidenceRef[],
  windowDays: number,
  relaxedNeeds = 0,
): EvidenceQuality {
  const fresh = evidence.filter((e) => e.freshness === 'fresh').length;
  const aging = evidence.filter((e) => e.freshness === 'aging').length;
  const stale = evidence.filter((e) => e.freshness === 'stale').length;
  const ages = evidence.map((e) => e.ageDays);
  const newest = ages.length ? Math.min(...ages) : null;
  const oldest = ages.length ? Math.max(...ages) : null;
  const base = {
    total: evidence.length, fresh, aging, stale,
    newestAgeDays: newest, oldestAgeDays: oldest, windowDays,
    relaxedFreshness: relaxedNeeds > 0,
  };

  if (evidence.length === 0) {
    return {
      ...base, level: 'none',
      note: 'ChainGPT returned no news for this plan, so recommendations rest on KULT context alone.',
    };
  }
  if (stale === evidence.length) {
    return {
      ...base, level: 'stale',
      note: `No ChainGPT news inside the ${windowDays}-day window matched, so older articles were used (newest is ${ago(newest!)}). Treat time-sensitive claims with caution.`,
    };
  }
  if (stale > 0) {
    return {
      ...base, level: 'mixed',
      note: `${stale} of ${evidence.length} articles are older than ${windowDays} days (fallback used for ${relaxedNeeds} evidence need${relaxedNeeds === 1 ? '' : 's'}); they carry less weight.`,
    };
  }
  return {
    ...base, level: 'good',
    note: `All ${evidence.length} articles are within ${windowDays} days; the newest is ${ago(newest!)}.`,
  };
}

/** Crude suffix stemming, so "approved"/"approves" and "stocks"/"stock" compare equal. */
function stems(text: string): Set<string> {
  return new Set([...tokenize(text)].map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 2));
}

/**
 * Links a recommendation to the evidence it rests on. Ids the model cited are kept
 * only if they were actually retrieved (a hallucinated id never becomes a source).
 * When the model cited nothing, the single best title match is attributed as
 * `matched`, so the UI can say it was inferred rather than stated.
 *
 * VERIFIED LIVE: the model's first answer is usually prose, and the JSON rewrite
 * often drops ids even for an idea plainly taken from an article (a tokenized-stock
 * pilot recommendation built on the SEC pilot story, citing nothing).
 */
export function attributeEvidence(
  citedIds: string[],
  evidence: EvidenceRef[],
  recommendationText: string,
): Provenance['evidence'] {
  const cited = evidence
    .filter((e) => citedIds.includes(e.id))
    .map((e) => ({ ...e, attribution: 'cited' as const }));
  if (cited.length > 0) return cited;

  const text = stems(recommendationText);
  let best: { ref: EvidenceRef; hits: number } | null = null;
  for (const ref of evidence) {
    const title = stems(ref.title);
    let hits = 0;
    for (const t of title) if (text.has(t)) hits += 1;
    const needed = Math.max(2, Math.ceil(title.size * 0.3));
    if (hits >= needed && (!best || hits > best.hits)) best = { ref, hits };
  }
  return best ? [{ ...best.ref, attribution: 'matched' as const }] : [];
}

const FRESHNESS_POINTS: Record<Freshness, number> = { fresh: 15, aging: 9, stale: 3 };

/**
 * How well-supported a recommendation is - distinct from `relevance`, which is fit.
 * Additive and explained: every adjustment adds a human-readable reason, so the
 * number is never a black box.
 */
export function scoreConfidence(p: Provenance): Confidence {
  const reasons: string[] = [];
  let score = 35;

  const ev = p.evidence;
  if (ev.length === 0) {
    score -= 10;
    reasons.push('No ChainGPT evidence cited: rests on KULT context alone');
  } else {
    const points = ev.reduce((acc, e) => acc + FRESHNESS_POINTS[e.freshness] * (e.attribution === 'cited' ? 1 : 0.6), 0);
    score += Math.min(30, points);

    const fresh = ev.filter((e) => e.freshness === 'fresh').length;
    const stale = ev.filter((e) => e.freshness === 'stale');
    if (fresh > 0) reasons.push(`${fresh} fresh ChainGPT article${fresh === 1 ? '' : 's'} (${FRESH_DAYS} days or newer)`);
    if (stale.length === ev.length) {
      score -= 8;
      reasons.push(`Only stale evidence: newest article is ${Math.min(...stale.map((e) => e.ageDays))} days old`);
    } else if (stale.length > 0) {
      reasons.push(`${stale.length} supporting article${stale.length === 1 ? ' is' : 's are'} older than the freshness window`);
    }
    if (ev.every((e) => e.attribution === 'matched')) {
      reasons.push('Evidence linked by text match; the model did not cite it');
    }
  }

  if (p.knowledge.length > 0) {
    score += 12;
    reasons.push(`Builds on ${p.knowledge.length} saved research item${p.knowledge.length === 1 ? '' : 's'}`);
  }
  if (p.outcomes.length > 0) {
    score += 12;
    reasons.push(`Informed by ${p.outcomes.length} recorded outcome${p.outcomes.length === 1 ? '' : 's'}`);
  }

  score = Math.max(5, Math.min(95, Math.round(score)));
  return { level: score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low', score, reasons };
}
