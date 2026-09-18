import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { TtlCache } from '../lib/resilience.js';
import { getProvider } from '../providers/index.js';
import type { Signal } from '../types.js';

/**
 * Signal retrieval strategy - one place, identical for every provider and transport.
 *
 * VERIFIED LIVE: `searchQuery` is a literal phrase match, and the searchable corpus
 * lags the unfiltered feed - on 2026-09-18 "gaming" returned nothing newer than 17
 * days while "AI" and the unfiltered feed had same-day news. So a phrase can return
 * zero rows, or only old rows, while a broader one has current coverage.
 *
 * Each phrase is requested ONCE, newest first, with no date cutoff; freshness is
 * judged here from each row's publication date. The walk stops at the first phrase
 * with in-window articles. If none has any, the freshest stale result is used and
 * flagged `relaxedFreshness` - the previous two-pass approach (cutoff, then no
 * cutoff) cost up to twice the calls to learn the same thing.
 */

export interface SignalQuery {
  /** Tried in order. An empty string means the unfiltered latest feed. */
  phrases: string[];
  limit: number;
  categoryId?: number[];
  freshnessDays?: number;
  /** forceFreshSignals: skip the cache read (the fresh result is still cached). */
  bypassCache?: boolean;
  label?: string;
}

export interface SignalResult {
  signals: Signal[];
  usedPhrase: string | null;
  relaxedFreshness: boolean;
  newestAgeDays: number | null;
  fromCache: boolean;
}

const DAY_MS = 86_400_000;

export function ageDays(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

const cache = new TtlCache<Omit<SignalResult, 'fromCache'>>(config.signalCacheTtlMs);

export function clearSignalCache(): void {
  cache.clear();
}

function cacheKey(q: SignalQuery, freshnessDays: number): string {
  return JSON.stringify({ p: q.phrases, l: q.limit, c: q.categoryId ?? null, f: freshnessDays });
}

/**
 * Shares identical news requests between the needs of ONE plan, even when the
 * cache is bypassed. VERIFIED LIVE: with only stale news available, two needs
 * both walked "web3 gaming" - 17 billable news calls for two scans and a research.
 */
export type FetchMemo = Map<string, Promise<Signal[]>>;

export async function retrieveSignals(q: SignalQuery, memo?: FetchMemo): Promise<SignalResult> {
  const freshnessDays = q.freshnessDays ?? config.news.freshnessDays;
  const key = cacheKey(q, freshnessDays);

  if (!q.bypassCache) {
    const hit = cache.get(key);
    if (hit) {
      log.info('signal_cache_hit', { phrase: hit.usedPhrase, count: hit.signals.length });
      return { ...hit, fromCache: true };
    }
  }

  const provider = getProvider();
  const now = Date.now();
  let bestStale: { signals: Signal[]; phrase: string; newest: number } | null = null;
  let result: Omit<SignalResult, 'fromCache'> | null = null;

  const fetchOnce = (phrase: string): Promise<Signal[]> => {
    const key = JSON.stringify({ phrase, l: q.limit, c: q.categoryId ?? null });
    const hit = memo?.get(key);
    if (hit) return hit;
    const request = provider.fetchNews(
      { searchQuery: phrase || undefined, limit: q.limit, sortBy: 'createdAt', categoryId: q.categoryId },
      q.label,
    );
    memo?.set(key, request);
    return request;
  };

  for (const phrase of q.phrases.length ? q.phrases : ['']) {
    const rows = await fetchOnce(phrase);
    if (rows.length === 0) {
      log.debug('signal_phrase_empty', { phrase });
      continue;
    }

    const fresh = rows.filter((r) => ageDays(r.publishedAt, now) <= freshnessDays);
    if (fresh.length > 0) {
      result = {
        signals: fresh,
        usedPhrase: phrase,
        relaxedFreshness: false,
        newestAgeDays: Math.min(...fresh.map((r) => ageDays(r.publishedAt, now))),
      };
      break;
    }

    const newest = Math.min(...rows.map((r) => ageDays(r.publishedAt, now)));
    if (!bestStale || newest < bestStale.newest) bestStale = { signals: rows, phrase, newest };
  }

  if (!result && bestStale) {
    log.info('signal_freshness_relaxed', { phrase: bestStale.phrase, newestAgeDays: bestStale.newest, freshnessDays });
    result = { signals: bestStale.signals, usedPhrase: bestStale.phrase, relaxedFreshness: true, newestAgeDays: bestStale.newest };
  }
  result ??= { signals: [], usedPhrase: null, relaxedFreshness: false, newestAgeDays: null };

  if (result.usedPhrase !== null && result.usedPhrase !== q.phrases[0]) {
    log.info('signal_query_fallback', { requested: q.phrases[0], used: result.usedPhrase, count: result.signals.length });
  }

  cache.set(key, result);
  return { ...result, fromCache: false };
}
