import { config } from '../config.js';
import { log } from '../lib/logger.js';
import type {
  KultActivity, KultGamePackage, KultPointSummary, KultProfile, KultSocialStats,
} from './kultTypes.js';

/**
 * Read-only client for the real KULT Creator Studio API.
 *
 * Every call here is a GET against an endpoint that only reads. That is deliberate:
 *
 *   - GET /social/creator-stats/:creatorId is NOT used, even though it returns the
 *     richest aggregate. socialService.getCreatorStats() fires a putJsonOnZeroG()
 *     profile snapshot as a side effect, so "reading" a creator's stats writes to
 *     0G storage. The POC composes the same numbers from /games/list instead.
 *   - POST /social/views/:gameId would inflate a real creator's play count.
 *
 * An intelligence POC must never mutate production creator data as a side effect
 * of generating a recommendation.
 */

/** Point reads are fast; /games/list pages 100 packages at a time and is slow. */
const TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 45_000;

/**
 * Paged catalog cache. Without a bearer token, resolving one creator means paging
 * the whole published catalog, which takes seconds against the live API. Caching
 * the paged result keeps a repeat Agent load from re-paging every time.
 */
let catalogCache: { games: KultGamePackage[]; expiresAt: number } | null = null;
/** Dedupes concurrent loads - several requests land together on a page load. */
let catalogInFlight: Promise<KultGamePackage[]> | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

function base(): string | null {
  return config.kult.apiBase || null;
}

async function get<T>(path: string, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  const apiBase = base();
  if (!apiBase) return null;

  const url = new URL(path.replace(/^\//, ''), apiBase.endsWith('/') ? apiBase : `${apiBase}/`);
  try {
    const res = await fetch(url, {
      headers: config.kult.authSecret ? { Authorization: `Bearer ${config.kult.authSecret}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn('kult_api_non_ok', { path, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn('kult_api_unreachable', { path, error: (err as Error).message });
    return null;
  }
}

/** GET /games/:gameId - published games only (controllers/gameController.showPublicGame). */
export async function fetchGame(gameId: string): Promise<KultGamePackage | null> {
  const res = await get<{ game?: KultGamePackage }>(`games/${gameId}`);
  return res?.game ?? null;
}

/**
 * GET /games/list - published games. Passing creatorId requires the caller to own
 * that identity (the API 403s otherwise), so unauthenticated use lists published
 * games and filters client-side.
 */
export async function fetchGames(opts: { creatorId?: string; limit?: number } = {}): Promise<KultGamePackage[]> {
  // With a bearer token the API can filter server-side. Without one,
  // /games/list?creatorId= returns 403, so we page the public published list and
  // filter locally - hence the pagination below rather than a single request.
  if (opts.creatorId && config.kult.authSecret) {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50), creatorId: opts.creatorId });
    const res = await get<{ games?: KultGamePackage[] }>(`games/list?${params.toString()}`, LIST_TIMEOUT_MS);
    return res?.games ?? [];
  }

  const all = await loadCatalog();
  if (!opts.creatorId) return all.slice(0, opts.limit ?? 50);
  return all.filter((g) => g.creatorId === opts.creatorId);
}

/** Pages the published catalog once per TTL and reuses it. */
async function loadCatalog(): Promise<KultGamePackage[]> {
  if (catalogCache && Date.now() < catalogCache.expiresAt) return catalogCache.games;
  if (catalogInFlight) return catalogInFlight;

  catalogInFlight = pageCatalog().finally(() => { catalogInFlight = null; });
  return catalogInFlight;
}

async function pageCatalog(): Promise<KultGamePackage[]> {
  const pageSize = 100; // the API caps limit at 100
  const maxPages = 6;
  const collected = new Map<string, KultGamePackage>();

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    const res = await get<{ games?: KultGamePackage[] }>(`games/list?${params.toString()}`, LIST_TIMEOUT_MS);
    const batch = res?.games ?? [];
    for (const g of batch) if (g?.id) collected.set(g.id, g);
    if (batch.length < pageSize) break;
  }

  const games = [...collected.values()];
  // Only cache a non-empty catalog so a transient failure is not sticky.
  if (games.length > 0) catalogCache = { games, expiresAt: Date.now() + CATALOG_TTL_MS };
  log.info('kult_catalog_loaded', { games: games.length });
  return games;
}

/** Published games across all creators - used to populate the POC pickers. */
export async function fetchAllGames(limit = 200): Promise<KultGamePackage[]> {
  return (await loadCatalog()).slice(0, limit);
}

/** Creators ranked by published portfolio - drives the POC Agent picker. */
export async function fetchTopCreators(limit = 10): Promise<{ creatorId: string; games: number; plays: number }[]> {
  const byCreator = new Map<string, { games: number; plays: number }>();
  for (const g of await loadCatalog()) {
    const id = g.creatorId;
    if (!id) continue;
    const cur = byCreator.get(id) ?? { games: 0, plays: 0 };
    cur.games += 1;
    cur.plays += g.views ?? g.points?.plays ?? 0;
    byCreator.set(id, cur);
  }
  return [...byCreator.entries()]
    .map(([creatorId, v]) => ({ creatorId, ...v }))
    .sort((a, b) => b.games - a.games || b.plays - a.plays)
    .slice(0, limit);
}

/** GET /social/stats/:gameId */
export async function fetchSocialStats(gameId: string): Promise<KultSocialStats | null> {
  return get<KultSocialStats>(`social/stats/${gameId}`);
}

/** GET /social/profile/:userId */
export async function fetchProfile(userId: string): Promise<KultProfile | null> {
  return get<KultProfile>(`social/profile/${userId}`);
}

/** GET /social/activity/user/:userId */
export async function fetchActivities(userId: string, limit = 25): Promise<KultActivity[]> {
  const res = await get<KultActivity[] | { activities?: KultActivity[] }>(
    `social/activity/user/${userId}?limit=${limit}`,
  );
  if (!res) return [];
  return Array.isArray(res) ? res : (res.activities ?? []);
}

/** GET /social/points/:userId */
export async function fetchPoints(userId: string): Promise<KultPointSummary | null> {
  return get<KultPointSummary>(`social/points/${userId}`);
}

export function kultConfigured(): boolean {
  return Boolean(base());
}
