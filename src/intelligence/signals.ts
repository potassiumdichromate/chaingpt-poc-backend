import { config } from '../config.js';
import type { CreatorProject } from '../types.js';
import type { SignalQuery } from './retrieval.js';

/**
 * Retrieval vocabulary for ChainGPT AI News - spec 11.8.
 *
 * VERIFIED AGAINST THE LIVE API: `searchQuery` is a literal phrase match, not a
 * multi-keyword OR. Short phrases return results ("AI gaming" -> hits) while a
 * bag of terms returns ZERO ("AI gaming agents web3 creator" -> 0 rows). So every
 * phrase here is one or two words, and each evidence need carries ordered
 * fallbacks rather than one long query.
 */

/**
 * VERIFIED LIVE: a 7.6k-char prompt (12 rendered signals) made ChainGPT's own
 * gateway return a 504 HTML page after ~81s. Six signals across all evidence
 * needs keeps the prompt inside budget. Raising this trades reliability for
 * breadth; measure before you do.
 */
export const SIGNAL_LIMIT = 6;

/**
 * VERIFIED LIVE: KULT genre names make terrible news queries. "Action Arcade"
 * matched prediction markets and tokenized funds - the corpus is Web3/finance
 * news, which has no notion of arcade genres. Genre belongs in the reasoning
 * prompt; retrieval leads with Web3-gaming vocabulary, ordered by the Agent's genres.
 */
export const DOMAIN_PHRASES = [
  'AI gaming',
  'web3 gaming',
  'blockchain gaming',
  'GameFi',
  'game studio',
  'AI agents',
  'creator economy',
];

/**
 * Broad phrases with genuinely current coverage. VERIFIED LIVE 2026-09-18: "AI"
 * returned same-day articles while "gaming" had nothing newer than 17 days, so the
 * coverage need ends on terms that keep the scan from going blind.
 */
export const COVERAGE_PHRASES = ['AI agents', 'AI', 'web3'];

/** Fallbacks for a specific need - broad enough to return something current. */
export const FALLBACK_PHRASES = ['web3 gaming', 'gaming', 'AI agents', 'web3', 'AI', 'crypto'];

/**
 * ChainGPT AI News category ids. VERIFIED LIVE 2026-09-18 by filtering and reading
 * back `category.name`: 2 is "Blockchain Gaming". The ids previously hardcoded here
 * as GAMING=8 and AI=4 were wrong - 8 is "NFT" and 4 is "DApps" - and no AI
 * category appeared in 80 sampled rows. Category filtering is opt-in via
 * NEWS_CATEGORY_IDS because most gaming articles carry no category at all.
 */
export const NEWS_CATEGORY = {
  BLOCKCHAIN_GAMING: 2,
} as const;

/** Genre hints that make a domain phrase more likely to suit this Agent. */
export function preferredDomainOrder(hints: string[]): string[] {
  const blob = hints.join(' ').toLowerCase();
  const scored = DOMAIN_PHRASES.map((phrase) => {
    const words = phrase.toLowerCase().split(' ');
    return { phrase, score: words.filter((w) => blob.includes(w)).length };
  });
  return scored.sort((a, b) => b.score - a.score).map((x) => x.phrase);
}

/** Specific Web3 terms worth searching when a recommendation mentions them. */
const SEARCHABLE_TERMS = [
  ...DOMAIN_PHRASES,
  'agent commerce', 'esports', 'airdrop', 'grants', 'grant', 'accelerator', 'launchpad',
  'hackathon', 'tournament', 'NFT', 'DePIN', 'stablecoin', 'payments', 'metaverse',
];

/** Capitalized words that are generic here, not names worth searching for. */
const GENERIC_CAPS = new Set([
  'KULT', 'Agent', 'Agents', 'AI', 'Web3', 'ChainGPT', 'Create', 'The', 'A', 'An', 'Apply', 'Position',
  'Target', 'Launch', 'Build', 'Partner', 'Pursue', 'Join', 'Leverage', 'Use', 'Run', 'Expand', 'Explore',
  'Secure', 'Submit', 'Pitch', 'Package', 'Draft', 'Shortlist', 'Request', 'Follow', 'Tap', 'Enter',
  'Engage', 'Capitalize', 'Enhance', 'Implement', 'Ensure', 'Develop', 'Integrate', 'Collaborate', 'Focus',
]);

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The searchable names and phrases in a recommendation, most specific first.
 *
 * The old research query took the first two words of the title ("Apply to"),
 * which the literal-phrase API cannot match to anything useful. Proper nouns
 * ("Immutable", "Ronin") are the most specific literal matches, then known Web3
 * terms. Title-cased text makes every word look like a name, so capitalization
 * is only trusted when most words are lowercase.
 */
export function salientPhrases(text: string, max = 3): string[] {
  // Judge each sentence or heading on its own: a title-cased heading next to a
  // lowercase sentence must not make the heading's verbs look like names.
  // VERIFIED LIVE: "Engage with Corporate Bitcoin Demand" searched for "Engage".
  const names = text.split(/(?<=[.!?])\s+|\n+|\s+\|\s+/).flatMap((segment) => {
    const words = segment.split(/[\s/,.;:()"'!?]+/).filter(Boolean);
    const capitalized = words.filter((w) => /^[A-Z]/.test(w));
    const titleCased = words.length > 1 && capitalized.length / words.length > 0.5;
    return words
      .flatMap((w) => w.split('-'))
      // A capitalized first word is a sentence start, not a name.
      .filter((_, i) => i > 0)
      .filter((w) => (titleCased ? /^[A-Z0-9]{3,6}$/.test(w) : /^[A-Z][A-Za-z0-9]{2,}$/.test(w)))
      .filter((w) => !GENERIC_CAPS.has(w));
  });

  const lower = text.toLowerCase();
  const terms = SEARCHABLE_TERMS.filter((t) => lower.includes(t.toLowerCase()));

  return dedupe([...names, ...terms]).slice(0, max);
}

export function buildProjectSignalQuery(project: CreatorProject, bypassCache = false): SignalQuery {
  const ordered = preferredDomainOrder([project.category, ...project.tags, ...project.goals]);
  return {
    phrases: dedupe([...ordered.slice(0, 2), 'creator economy', ...FALLBACK_PHRASES]).slice(0, 5),
    limit: SIGNAL_LIMIT,
    freshnessDays: config.news.freshnessDays,
    bypassCache,
    label: 'chaingpt.news.growth',
  };
}
