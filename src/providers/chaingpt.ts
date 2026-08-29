import { AINews } from '@chaingpt/ainews';
import { GeneralChat } from '@chaingpt/generalchat';
import { AI_TONE, PRE_SET_TONES } from '@chaingpt/generalchat/dist/enum/context.enum.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { ProviderError, categorize } from '../lib/errors.js';
import { withRetry, withTimeout, TtlCache } from '../lib/resilience.js';
import { accumulateStream } from '../intelligence/parser.js';
import type { Signal } from '../types.js';
import type { IntelligenceProvider, ReasonOptions, SignalQuery } from './types.js';

/**
 * ChainGPT provider.
 *  - AI Crypto News  -> current external Web3 signals
 *  - Web3 LLM (blob) -> reasoning over KULT context + signals
 *
 * Transport is switchable: the official SDKs (recommended for Node/TS, spec 11.4)
 * or the documented REST endpoints, which are useful for verifying raw response
 * shapes during the Appendix A smoke test.
 */
export class ChainGPTProvider implements IntelligenceProvider {
  readonly name = 'chaingpt';

  private news?: AINews;
  private chat?: GeneralChat;
  private signalCache = new TtlCache<Signal[]>(config.signalCacheTtlMs);

  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('ChainGPTProvider requires an API key');
    if (config.chaingpt.transport === 'sdk') {
      this.news = new AINews({ apiKey });
      this.chat = new GeneralChat({ apiKey });
    }
  }

  // ---------------------------------------------------------------- signals

  async getSignals(query: SignalQuery): Promise<Signal[]> {
    const key = JSON.stringify({
      q: query.searchQuery,
      l: query.limit ?? 12,
      // Bucket the freshness cutoff so near-identical scans share a cache entry.
      a: query.fetchAfter ? Math.floor(query.fetchAfter.getTime() / 3_600_000) : null,
    });

    const cached = this.signalCache.get(key);
    if (cached) {
      log.info('signal_cache_hit', { searchQuery: query.searchQuery, count: cached.length });
      return cached;
    }

    // The live News API matches searchQuery as a literal phrase, so a specific
    // query can legitimately return zero rows. Walk to broader phrases rather
    // than handing the reasoning step an empty signal set.
    const attempts = [query.searchQuery, ...(query.fallbackQueries ?? [])].filter(Boolean);
    let signals: Signal[] = [];

    for (const searchQuery of attempts) {
      signals = await withRetry(
        () =>
          withTimeout(
            config.chaingpt.transport === 'sdk'
              ? this.getSignalsSdk({ ...query, searchQuery })
              : this.getSignalsRest({ ...query, searchQuery }),
            config.timeouts.news,
            'chaingpt.news',
          ),
        { label: 'chaingpt.news' },
      );
      if (signals.length > 0) {
        if (searchQuery !== query.searchQuery) {
          log.info('signal_query_fallback', { requested: query.searchQuery, used: searchQuery, count: signals.length });
        }
        break;
      }
      log.debug('signal_query_empty', { searchQuery });
    }

    this.signalCache.set(key, signals);
    return signals;
  }

  private async getSignalsSdk(query: SignalQuery): Promise<Signal[]> {
    const res = await this.news!.getNews({
      searchQuery: query.searchQuery,
      limit: query.limit ?? 12,
      offset: 0,
      sortBy: query.sortBy ?? 'createdAt',
      ...(query.fetchAfter ? { fetchAfter: query.fetchAfter } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.subCategoryId ? { subCategoryId: query.subCategoryId } : {}),
      ...(query.tokenId ? { tokenId: query.tokenId } : {}),
    });
    return normalizeNews(res);
  }

  private async getSignalsRest(query: SignalQuery): Promise<Signal[]> {
    const url = new URL('/news', config.chaingpt.baseUrl);
    url.searchParams.set('searchQuery', query.searchQuery);
    url.searchParams.set('limit', String(query.limit ?? 12));
    url.searchParams.set('offset', '0');
    url.searchParams.set('sortBy', query.sortBy ?? 'createdAt');
    if (query.fetchAfter) url.searchParams.set('fetchAfter', query.fetchAfter.toISOString());

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(config.timeouts.news),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (/insufficient credits/i.test(detail)) {
        throw new ProviderError('insufficient_credits', 'Insufficient credits', detail.slice(0, 200));
      }
      throw new ProviderError(
        res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'upstream_5xx' : res.status === 401 || res.status === 403 ? 'auth' : 'unknown',
        `News ${res.status}: ${detail.slice(0, 120)}`,
      );
    }
    return normalizeNews(await res.json());
  }

  // ------------------------------------------------------------- reasoning

  async reason(prompt: string, options: ReasonOptions = {}): Promise<unknown> {
    const label = options.label ?? 'chaingpt.chat';
    return withRetry(
      () =>
        withTimeout(
          config.chaingpt.transport === 'sdk' ? this.reasonSdk(prompt, options) : this.reasonRest(prompt, options),
          options.timeoutMs ?? config.timeouts.reasoning,
          label,
        ),
      { label },
    );
  }

  private async reasonSdk(prompt: string, options: ReasonOptions): Promise<unknown> {
    const useCustomContext = options.useCustomContext ?? config.chaingpt.useCustomContext;

    // Blob mode: the full answer is validated server-side before the UI sees it (spec 17).
    return this.chat!.createChatBlob({
      question: prompt,
      chatHistory: options.chatHistory ?? 'off',
      useCustomContext,
      // VERIFIED LIVE: useCustomContext:true is rejected outright unless a
      // contextInjection object is present ("ContextInjectionDto is required
      // when aiTone is PRE_SET_TONES"). Always send one when the flag is on.
      ...(useCustomContext ? { contextInjection: KULT_CONTEXT_INJECTION } : {}),
      ...(options.sdkUniqueId ? { sdkUniqueId: options.sdkUniqueId } : {}),
    });
  }

  private async reasonRest(prompt: string, options: ReasonOptions): Promise<unknown> {
    const res = await fetch(new URL('/chat/stream', config.chaingpt.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.chaingpt.model,
        question: prompt,
        chatHistory: options.chatHistory ?? 'off',
        useCustomContext: options.useCustomContext ?? config.chaingpt.useCustomContext,
        ...((options.useCustomContext ?? config.chaingpt.useCustomContext)
          ? { contextInjection: KULT_CONTEXT_INJECTION }
          : {}),
        ...(options.sdkUniqueId ? { sdkUniqueId: options.sdkUniqueId } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? config.timeouts.reasoning),
    });

    if (!res.ok) {
      // Read the body: a 400 carries {"message":"Insufficient credits"}, which is
      // the difference between "top up" and "the service is down".
      const detail = await res.text().catch(() => '');
      if (/insufficient credits/i.test(detail)) {
        throw new ProviderError('insufficient_credits', 'Insufficient credits', detail.slice(0, 200));
      }
      throw new ProviderError(
        res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'upstream_5xx' : res.status === 401 || res.status === 403 ? 'auth' : 'unknown',
        `Chat ${res.status}: ${detail.slice(0, 120)}`,
      );
    }

    // The same endpoint serves buffered JSON or a stream depending on the client;
    // accumulate either into one validated result before returning.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) return res.json();
    return res.text();
  }

  // ---------------------------------------------------------------- health

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const signals = await this.getSignals({ searchQuery: 'web3', limit: 1 });
      return { ok: true, detail: `news reachable (${signals.length} signal(s))` };
    } catch (err) {
      const e = categorize(err);
      return { ok: false, detail: `${e.category}: ${e.message}` };
    }
  }
}

/**
 * Stable KULT product knowledge sent alongside useCustomContext.
 *
 * NOTE: with the AI Hub context unconfigured for a key, ChainGPT answers "KULT is
 * a cryptocurrency built on blockchain technology" - a wrong prior that would
 * poison recommendations. Configure the Hub, then enable
 * CHAINGPT_USE_CUSTOM_CONTEXT=true.
 */
const KULT_CONTEXT_INJECTION = {
  companyName: 'KULT',
  companyDescription:
    'KULT is a Web3 creator platform. Creators build playable browser experiences with KULT Create, '
    + 'compete in AI Arena, trade through Agent Commerce, and operate persistent AI Agents that accumulate '
    + 'knowledge over time. KULT is a platform, not a token or cryptocurrency.',
  purpose: 'Give persistent KULT Agents real-time Web3 awareness and turn it into personalized actions.',
  aiTone: AI_TONE.PRE_SET_TONE,
  selectedTone: PRE_SET_TONES.PROFESSIONAL,
};

/**
 * News normalization, corrected against the LIVE API response.
 *
 * Verified shape: { statusCode, message, data: [ ... ] } where each row carries
 * `title`, `description`, `pubDate` (true publication time), `createdAt`
 * (ingest time), `author`, `imageUrl`, and a nullable `category`/`token`.
 * There is NO url/link field, so `url` stays undefined rather than invented.
 */
export function normalizeNews(res: unknown): Signal[] {
  const r = res as Record<string, any>;
  const rows: any[] =
    (Array.isArray(r?.data?.data) && r.data.data) ||
    (Array.isArray(r?.data?.news) && r.data.news) ||
    (Array.isArray(r?.data) && r.data) ||
    (Array.isArray(r?.news) && r.news) ||
    (Array.isArray(r) && r) ||
    [];

  return rows
    .map((row, i): Signal => {
      // pubDate is the real publication time; createdAt is ingest time.
      const publishedRaw = row?.pubDate ?? row?.publishedAt ?? row?.createdAt ?? row?.published_at ?? row?.date;
      const published = publishedRaw ? new Date(publishedRaw) : new Date();
      return {
        id: String(row?.id ?? row?._id ?? `sig_${i}`),
        title: String(row?.title ?? row?.heading ?? 'Untitled signal').trim(),
        description: String(row?.description ?? row?.summary ?? row?.content ?? row?.body ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 900),
        source: String(row?.author ?? row?.source ?? row?.sourceName ?? 'ChainGPT AI News'),
        // The live payload has no url/link field - leave it undefined (spec 17:
        // never invent missing source metadata).
        url: row?.url ?? row?.link ?? row?.sourceUrl ?? undefined,
        publishedAt: Number.isNaN(published.getTime()) ? new Date().toISOString() : published.toISOString(),
        category: row?.category?.name ?? row?.categoryName ?? row?.token?.name ?? undefined,
      };
    })
    .filter((s) => s.title && s.title !== 'Untitled signal');
}

export { accumulateStream };
