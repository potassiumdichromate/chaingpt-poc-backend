import type { Signal } from '../types.js';

export interface SignalQuery {
  searchQuery: string;
  /**
   * Broader phrases tried in order when `searchQuery` returns nothing. The live
   * News API matches phrases literally, so a specific query legitimately returns
   * zero and must degrade to a broader one rather than to an empty radar.
   */
  fallbackQueries?: string[];
  limit?: number;
  /** Freshness cutoff for AI News retrieval (spec 11.8). */
  fetchAfter?: Date;
  sortBy?: string;
  categoryId?: number[];
  subCategoryId?: number[];
  tokenId?: number[];
}

export interface ReasonOptions {
  /** Spec 11.6 - history stays off unless multi-turn continuity adds value. */
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
  getSignals(query: SignalQuery): Promise<Signal[]>;
  /** Returns the raw provider payload; parsing/validation is the caller's job. */
  reason(prompt: string, options?: ReasonOptions): Promise<unknown>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
