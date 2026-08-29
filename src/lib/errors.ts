/**
 * Provider failure taxonomy (spec 17). Raw provider errors are never returned to
 * the consumer UI - only `userMessage` crosses the boundary.
 */
export type FailureCategory =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'insufficient_credits'
  | 'upstream_5xx'
  | 'malformed_output'
  | 'no_signals'
  | 'unknown';

export class ProviderError extends Error {
  readonly category: FailureCategory;
  readonly userMessage: string;
  readonly detail?: unknown;

  constructor(category: FailureCategory, message: string, detail?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.category = category;
    this.detail = detail;
    this.userMessage = USER_MESSAGES[category];
  }
}

const USER_MESSAGES: Record<FailureCategory, string> = {
  timeout: 'Intelligence is taking longer than expected. Try again.',
  rate_limit: 'Intelligence is busy right now. Try again in a moment.',
  auth: 'Intelligence is temporarily unavailable. Try again.',
  // Distinct from an outage: nothing will improve until credits are topped up,
  // so the message says so instead of inviting a pointless retry.
  insufficient_credits: 'The ChainGPT account is out of credits. Top up at app.chaingpt.org to resume live intelligence.',
  upstream_5xx: 'Intelligence is temporarily unavailable. Try again.',
  malformed_output: 'We could not build a clean result. Try again.',
  no_signals: 'No strong opportunities found right now.',
  unknown: 'Intelligence is temporarily unavailable. Try again.',
};

/**
 * Maps an unknown thrown value onto the failure taxonomy.
 *
 * Order matters. An explicit HTTP status is authoritative and is consulted before
 * message-text heuristics, because provider bodies lie: ChainGPT's gateway 504
 * page contains the word "timeout", which would otherwise mask a real upstream
 * failure as a client-side deadline.
 */
export function categorize(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const e = err as { name?: string; message?: string; status?: number; response?: { status?: number } };
  // The official SDK wraps axios and exposes no status field - it only embeds the
  // code in the message ("Request failed with status code 401"). Without this,
  // every SDK HTTP error was classified as "unknown" and retried blindly.
  const msgStatus = /status code (\d{3})/i.exec(String(e?.message ?? ''));
  const status = e?.status ?? e?.response?.status
    ?? (msgStatus ? Number(msgStatus[1]) : undefined);
  const name = e?.name ?? '';
  const msg = String(e?.message ?? err ?? '');

  // Checked first: an exhausted balance arrives as a 400, which would otherwise
  // be swallowed by the generic branch.
  if (/insufficient credits|not enough credits|credit balance/i.test(msg)) {
    return new ProviderError('insufficient_credits', msg || 'Insufficient credits', err);
  }

  // Explicit status beats message text.
  if (typeof status === 'number') {
    if (status === 429) return new ProviderError('rate_limit', msg || 'Rate limited', err);
    if (status === 401 || status === 403) return new ProviderError('auth', msg || 'Auth rejected', err);
    if (status >= 500) return new ProviderError('upstream_5xx', msg || `Upstream ${status}`, err);
  }

  // No usable status - fall back to error class names and message shape.
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|ETIMEDOUT|aborted/i.test(msg)) {
    return new ProviderError('timeout', msg || 'Request timed out', err);
  }
  if (name === 'RateLimitExceededError' || /rate.?limit/i.test(msg)) {
    return new ProviderError('rate_limit', msg || 'Rate limited', err);
  }
  if (name === 'InvalidApiKeyError' || /api key|unauthor/i.test(msg)) {
    return new ProviderError('auth', msg || 'Auth rejected', err);
  }
  return new ProviderError('unknown', msg || 'Unknown provider error', err);
}

export function isRetryable(err: ProviderError): boolean {
  // insufficient_credits and auth are deliberately excluded: retrying burns time
  // and, for credits, cannot succeed until the operator tops up.
  return err.category === 'rate_limit' || err.category === 'upstream_5xx' || err.category === 'timeout';
}
