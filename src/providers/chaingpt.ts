import { AINews } from '@chaingpt/ainews';
import { GeneralChat } from '@chaingpt/generalchat';
import { AI_TONE, PRE_SET_TONES } from '@chaingpt/generalchat/dist/enum/context.enum.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { ProviderError, categorize } from '../lib/errors.js';
import { withRetry, withTimeout } from '../lib/resilience.js';
import { accumulateStream } from '../intelligence/parser.js';
import { recordProviderCall } from '../analytics.js';
import type { Signal } from '../types.js';
import type { IntelligenceProvider, NewsQuery, ReasonOptions } from './types.js';

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

  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('ChainGPTProvider requires an API key');
    if (config.chaingpt.transport === 'sdk') {
      this.news = new AINews({ apiKey });
      this.chat = new GeneralChat({ apiKey });
    }
  }

  // ---------------------------------------------------------------- signals

  /** One AI News request on the configured transport. Walking and caching live upstream. */
  async fetchNews(query: NewsQuery, label = 'chaingpt.news'): Promise<Signal[]> {
    const params = buildNewsParams(query);
    return withRetry(
      () =>
        withTimeout(
          config.chaingpt.transport === 'sdk' ? this.fetchNewsSdk(params) : this.fetchNewsRest(params),
          config.timeouts.news,
          label,
        ),
      {
        label,
        // VERIFIED LIVE: the SDK wraps transport failures in an AINewsError with no
        // message, so they categorize as `unknown`. A news GET is idempotent - retry it.
        alsoRetry: ['unknown'],
        onAttempt: (a) => recordProviderCall({
          provider: this.name, kind: 'news', label, ok: a.ok, category: a.category, latencyMs: a.latencyMs,
          estimatedCredits: a.ok ? config.credits.perNews : 0,
        }),
      },
    );
  }

  private async fetchNewsSdk(params: NewsParams): Promise<Signal[]> {
    // The SDK sends `params` through axios as a GET query string - the exact
    // encoding `newsQueryString` reproduces for the REST transport.
    return normalizeNews(await this.news!.getNews({ ...params }));
  }

  private async fetchNewsRest(params: NewsParams): Promise<Signal[]> {
    const url = new URL('/news', config.chaingpt.baseUrl);
    url.search = newsQueryString(params);

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
    const chatHistory = (options.chatHistory ?? 'off') === 'on';
    return withRetry(
      () =>
        withTimeout(
          config.chaingpt.transport === 'sdk' ? this.reasonSdk(prompt, options) : this.reasonRest(prompt, options),
          options.timeoutMs ?? config.timeouts.reasoning,
          label,
        ),
      {
        label,
        onAttempt: (a) => recordProviderCall({
          provider: this.name, kind: 'chat', label, ok: a.ok, category: a.category, latencyMs: a.latencyMs,
          chatHistory,
          estimatedCredits: a.ok ? config.credits.perChat + (chatHistory ? config.credits.perChatHistory : 0) : 0,
        }),
      },
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
      const signals = await this.fetchNews({ limit: 1 }, 'chaingpt.health');
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
 * (ingest time), `author`, `imageUrl`, and nullable `category` {id,name},
 * `subCategory` {id,name} (the chain) and `token` {id,name}.
 * There is NO url/link field, so `url` stays undefined rather than invented.
 *
 * Both transports return the same body, and both pass it through here, so SDK and
 * REST output is normalized identically by construction.
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
        category: row?.category?.name ?? row?.categoryName ?? undefined,
        categoryId: numberOrUndefined(row?.category?.id ?? row?.categoryId),
        // VERIFIED LIVE: subCategory is the chain ("Ethereum", "Bitcoin"), token the asset.
        chain: row?.subCategory?.name ?? undefined,
        token: row?.token?.name ?? undefined,
      };
    })
    .filter((s) => s.title && s.title !== 'Untitled signal');
}

function numberOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isInteger(n) ? n : undefined;
}

// ------------------------------------------------------------ request params

/** The one request shape both transports send. Mirrors the SDK's FindNewsDto. */
export interface NewsParams {
  searchQuery?: string;
  limit: number;
  offset: number;
  sortBy: string;
  fetchAfter?: Date;
  categoryId?: number[];
  subCategoryId?: number[];
  tokenId?: number[];
}

/**
 * Normalizes a NewsQuery into request params. Empty filters are dropped rather
 * than sent as `[]`, because the SDK deletes undefined keys and an empty array
 * would otherwise reach the API on one transport but not the other.
 */
export function buildNewsParams(q: NewsQuery): NewsParams {
  const ids = (xs?: number[]) => (xs && xs.length ? [...xs] : undefined);
  const params: NewsParams = {
    ...(q.searchQuery?.trim() ? { searchQuery: q.searchQuery.trim() } : {}),
    limit: q.limit ?? 12,
    offset: q.offset ?? 0,
    sortBy: q.sortBy ?? 'createdAt',
    ...(q.fetchAfter ? { fetchAfter: q.fetchAfter } : {}),
    ...(ids(q.categoryId) ? { categoryId: ids(q.categoryId) } : {}),
    ...(ids(q.subCategoryId) ? { subCategoryId: ids(q.subCategoryId) } : {}),
    ...(ids(q.tokenId) ? { tokenId: ids(q.tokenId) } : {}),
  };
  return params;
}

/** axios's query encoding: encodeURIComponent, then `:` `$` `,` restored and space as `+`. */
function axiosEncode(v: string): string {
  return encodeURIComponent(v)
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+');
}

/**
 * Serializes params exactly as the SDK's axios GET does (arrays as `key[]=v`,
 * dates as ISO strings), so the REST transport sends a byte-identical query.
 * VERIFIED against axios 1.19 getUri() output - see normalizeNews.test.ts.
 */
export function newsQueryString(p: NewsParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${axiosEncode(`${key}[]`)}=${axiosEncode(String(v))}`);
    } else {
      parts.push(`${axiosEncode(key)}=${axiosEncode(value instanceof Date ? value.toISOString() : String(value))}`);
    }
  }
  return parts.join('&');
}

export { accumulateStream };
