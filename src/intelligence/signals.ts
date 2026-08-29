import type { Agent, CreatorProject, Signal } from '../types.js';
import type { SignalQuery } from '../providers/types.js';

/**
 * Context-aware AI News retrieval - spec 11.8. The query is derived from the
 * Agent or project rather than one fixed phrase for every user, and a freshness
 * cutoff keeps "current signal" honest.
 */

const FRESHNESS_DAYS = 14;

/**
 * VERIFIED AGAINST THE LIVE API: `searchQuery` is a literal phrase match, not a
 * multi-keyword OR. Short phrases return results ("AI gaming" -> hits) while a
 * bag of terms returns ZERO ("AI gaming agents web3 creator" -> 0 rows).
 *
 * So queries are built as a short primary phrase plus ordered broader fallbacks,
 * and the provider walks them until signals come back. Sending one long query
 * silently emptied the radar - the failure mode this exists to prevent.
 */
const MAX_QUERY_WORDS = 2;

/**
 * VERIFIED LIVE: a 7.6k-char prompt (12 rendered signals) made ChainGPT's own
 * gateway return a 504 HTML page after ~81s - past the SDK's 60s axios cap too.
 * Six signals keeps the prompt near 5k chars and inside their budget. Raising
 * this trades reliability for breadth; measure before you do.
 */
const SIGNAL_LIMIT = 6;

function phrase(terms: string[]): string {
  return dedupeTerms(terms, MAX_QUERY_WORDS).join(' ');
}

/**
 * VERIFIED LIVE: KULT genre names make terrible news queries. "Action Arcade"
 * matched prediction markets and tokenized funds - the corpus is Web3/finance
 * news, which has no notion of arcade genres. Genre belongs in the reasoning
 * prompt, not the retrieval query.
 *
 * So retrieval leads with Web3-gaming domain vocabulary; the Agent's own genres
 * are used to *order* these, not to query directly.
 */
const DOMAIN_PHRASES = [
  'AI gaming',
  'web3 gaming',
  'blockchain gaming',
  'GameFi',
  'game studio',
  'AI agents',
  'creator economy',
];

/** Ordered broad fallbacks, only used when a narrower phrase yields nothing. */
const FALLBACK_PHRASES = ['web3 gaming', 'gaming', 'AI agents', 'web3'];

/** Genre hints that make a domain phrase more likely to suit this Agent. */
function preferredDomainOrder(hints: string[]): string[] {
  const blob = hints.join(' ').toLowerCase();
  const scored = DOMAIN_PHRASES.map((phrase) => {
    const words = phrase.toLowerCase().split(' ');
    return { phrase, score: words.filter((w) => blob.includes(w)).length };
  });
  return scored.sort((a, b) => b.score - a.score).map((x) => x.phrase);
}

function dedupeTerms(terms: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
    if (out.length >= max) break;
  }
  return out;
}

export function buildAgentSignalQuery(agent: Agent, override?: string, useCategoryFilter = false): SignalQuery {
  // An explicit override is honoured verbatim; otherwise retrieval uses domain
  // vocabulary ordered by how well it matches this Agent's genres.
  const ordered = override?.trim()
    ? [phrase(override.split(/[\s,]+/).filter(Boolean))]
    : preferredDomainOrder([...agent.interests, ...agent.goals]);

  return {
    searchQuery: ordered[0] ?? 'web3 gaming',
    fallbackQueries: [...ordered.slice(1), ...FALLBACK_PHRASES],
    limit: SIGNAL_LIMIT,
    fetchAfter: new Date(Date.now() - FRESHNESS_DAYS * 86_400_000),
    sortBy: 'createdAt',
    ...categoryFilter(useCategoryFilter),
  };
}

/**
 * ChainGPT AI News category ids (spec 11.8). The API exposes categoryId /
 * subCategoryId / tokenId filters; these are the ids relevant to KULT's surface.
 * Confirm against the live account with `npm run smoke` before relying on them -
 * ids are account/catalog specific, so an unknown id must not silently narrow a
 * scan to nothing.
 */
export const NEWS_CATEGORY = {
  GAMING: 8,
  AI: 4,
} as const;

/** Only applied when explicitly enabled, so a wrong id cannot empty the radar. */
function categoryFilter(enabled: boolean): Pick<SignalQuery, 'categoryId'> {
  return enabled ? { categoryId: [NEWS_CATEGORY.GAMING, NEWS_CATEGORY.AI] } : {};
}

export function buildProjectSignalQuery(
  project: CreatorProject,
  agent: Agent,
  useCategoryFilter = false,
): SignalQuery {
  const ordered = preferredDomainOrder([project.category, ...project.tags, ...project.goals]);

  return {
    searchQuery: ordered[0] ?? 'web3 gaming',
    fallbackQueries: [...ordered.slice(1), 'creator economy', ...FALLBACK_PHRASES],
    limit: SIGNAL_LIMIT,
    fetchAfter: new Date(Date.now() - FRESHNESS_DAYS * 86_400_000),
    sortBy: 'createdAt',
    ...categoryFilter(useCategoryFilter),
  };
}

/** Compact rendering so signal payloads do not crowd out KULT context in the prompt. */
export function renderSignals(signals: Signal[], limit = 6): string {
  if (signals.length === 0) return '(no current signals retrieved)';
  return signals
    .slice(0, limit)
    .map(
      (s, i) =>
        `${i + 1}. [${s.publishedAt.slice(0, 10)}] ${s.title}\n   ${s.description.slice(0, 200)}`,
    )
    .join('\n');
}
