import type { Signal } from '../types.js';

/**
 * Exactly one ChainGPT AI News request. Both transports (SDK and REST) build their
 * request from this through `buildNewsParams`, so they cannot drift apart.
 */
export interface NewsQuery {
  /** Literal phrase match on the live API; omit for the unfiltered latest feed. */
  searchQuery?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  fetchAfter?: Date;
  categoryId?: number[];
  subCategoryId?: number[];
  tokenId?: number[];
}

export interface ReasonOptions {
  /**
   * Stays off: KULT is the Agent's canonical memory and injects it explicitly, so
   * ChainGPT is used statelessly (and history costs an extra credit per request).
   */
  chatHistory?: 'on' | 'off';
  sdkUniqueId?: string;
  /** Applies the dedicated KULT AI Hub context (spec 11.5). */
  useCustomContext?: boolean;
  timeoutMs?: number;
  label?: string;
}

/** Spec 5.2 provider abstraction. */
export interface IntelligenceProvider {
  readonly name: string;
  /** One news request. Query walking, freshness and caching live in intelligence/retrieval.ts. */
  fetchNews(query: NewsQuery, label?: string): Promise<Signal[]>;
  /** Returns the raw provider payload; parsing/validation is the caller's job. */
  reason(prompt: string, options?: ReasonOptions): Promise<unknown>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
