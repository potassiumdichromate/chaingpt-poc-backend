import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, categorize, isRetryable } from '../lib/errors.js';
import { TtlCache, withRetry, withTimeout } from '../lib/resilience.js';
import { parseWithRepair } from '../intelligence/parser.js';
import { opportunitySetSchema } from '../intelligence/schemas.js';

/** Spec 19 failure matrix: 429, 5xx, timeout, malformed JSON, empty signals. */

describe('failure categorization', () => {
  it('classifies a 429 as a retryable rate limit', () => {
    const e = categorize({ status: 429, message: 'Too many requests' });
    expect(e.category).toBe('rate_limit');
    expect(isRetryable(e)).toBe(true);
  });

  it('classifies a 500 as a retryable upstream failure', () => {
    const e = categorize({ status: 503 });
    expect(e.category).toBe('upstream_5xx');
    expect(isRetryable(e)).toBe(true);
  });

  it('classifies an abort as a retryable timeout', () => {
    const e = categorize(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(e.category).toBe('timeout');
    expect(isRetryable(e)).toBe(true);
  });

  it('classifies a 401 as auth and does NOT retry it', () => {
    const e = categorize({ status: 401 });
    expect(e.category).toBe('auth');
    expect(isRetryable(e)).toBe(false);
  });

  it('recognises the SDK rate-limit error class by name', () => {
    expect(categorize({ name: 'RateLimitExceededError' }).category).toBe('rate_limit');
  });

  it('recognises the SDK invalid-key error class by name', () => {
    expect(categorize({ name: 'InvalidApiKeyError' }).category).toBe('auth');
  });

  it('never leaks raw provider text into the user-facing message', () => {
    const e = categorize({ status: 500, message: 'ECONNREFUSED 10.0.0.4:443 apiKey=sk-secret' });
    expect(e.userMessage).not.toContain('sk-secret');
    expect(e.userMessage).not.toContain('10.0.0.4');
    expect(e.userMessage).toBe('Intelligence is temporarily unavailable. Try again.');
  });
});

describe('withRetry', () => {
  it('retries a 429 exactly once and then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new ProviderError('rate_limit', '429');
      return 'ok';
    }, { label: 't', baseDelayMs: 1 });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries a 5xx once then surfaces the error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new ProviderError('upstream_5xx', '500');
    }, { label: 't', baseDelayMs: 1 })).rejects.toMatchObject({ category: 'upstream_5xx' });
    expect(calls).toBe(2);
  });

  it('does NOT retry an auth failure', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new ProviderError('auth', '401');
    }, { label: 't', baseDelayMs: 1 })).rejects.toMatchObject({ category: 'auth' });
    expect(calls).toBe(1);
  });
});

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects with a timeout when the deadline passes', async () => {
    const pending = withTimeout(new Promise(() => {}), 1000, 'slow');
    const assertion = expect(pending).rejects.toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });

  it('resolves normally when the call finishes in time', async () => {
    const p = withTimeout(Promise.resolve('fast'), 1000, 'quick');
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('fast');
  });
});

describe('malformed model output', () => {
  const valid = JSON.stringify({
    opportunities: [{
      title: 'Apply to the grant track', relevance: 90, signal: 'Track opened',
      why: 'Fits this Agent', opportunity: 'Distribution attached', action: 'Submit this week',
    }],
  });

  it('recovers via a single repair pass', async () => {
    let repairs = 0;
    const out = await parseWithRepair(
      { data: { bot: 'I cannot produce JSON.' } },
      opportunitySetSchema,
      async () => { repairs += 1; return { data: { bot: valid } }; },
      'test',
    );
    expect(repairs).toBe(1);
    expect(out.opportunities).toHaveLength(1);
  });

  it('throws malformed_output when the repair also fails', async () => {
    await expect(parseWithRepair(
      { data: { bot: 'nope' } },
      opportunitySetSchema,
      async () => ({ data: { bot: 'still nope' } }),
      'test',
    )).rejects.toMatchObject({ category: 'malformed_output' });
  });

  it('does not call the repair pass when the first response is valid', async () => {
    let repairs = 0;
    await parseWithRepair({ data: { bot: valid } }, opportunitySetSchema, async () => { repairs += 1; return {}; }, 'test');
    expect(repairs).toBe(0);
  });

  it('surfaces a user-safe message for malformed output', () => {
    expect(new ProviderError('malformed_output', 'raw model garbage').userMessage)
      .toBe('We could not build a clean result. Try again.');
  });
});

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a cached value inside the TTL', () => {
    const c = new TtlCache<string>(1000);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
  });

  it('expires a value after the TTL', () => {
    const c = new TtlCache<string>(1000);
    c.set('k', 'v');
    vi.advanceTimersByTime(1500);
    expect(c.get('k')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regressions from the LIVE ChainGPT integration. Each of these was an actual
// observed failure against the real API, not a hypothetical.
// ---------------------------------------------------------------------------

describe('live ChainGPT regressions', () => {
  it('classifies an exhausted balance as insufficient_credits, not auth', () => {
    const e = categorize({ status: 400, message: '{"statusCode":400,"message":"Insufficient credits"}' });
    expect(e.category).toBe('insufficient_credits');
  });

  it('never retries an insufficient_credits failure', () => {
    expect(isRetryable(new ProviderError('insufficient_credits', 'no funds'))).toBe(false);
  });

  it('tells the operator to top up rather than to try again', () => {
    const msg = new ProviderError('insufficient_credits', 'x').userMessage;
    expect(msg).toMatch(/out of credits/i);
    expect(msg).toMatch(/app\.chaingpt\.org/);
  });

  it('classifies the gateway 504 HTML page as a retryable upstream failure', () => {
    const e = categorize({ status: 504, message: '<!DOCTYPE html> gateway timeout' });
    expect(e.category).toBe('upstream_5xx');
    expect(isRetryable(e)).toBe(true);
  });

  it('classifies the SDK 60s axios cap as a timeout', () => {
    expect(categorize({ name: 'AxiosError', message: 'timeout of 60000ms exceeded' }).category).toBe('timeout');
  });
});

describe('prompt degradation policy', () => {
  it('treats a gateway 504 as worth retrying with a smaller prompt', () => {
    const e = categorize({ status: 504, message: '<!DOCTYPE html>' });
    expect(['timeout', 'upstream_5xx']).toContain(e.category);
    expect(isRetryable(e)).toBe(true);
  });

  it('does not treat a credit failure as size-related', () => {
    const e = categorize({ status: 400, message: 'Insufficient credits' });
    expect(e.category).toBe('insufficient_credits');
    expect(['timeout', 'upstream_5xx']).not.toContain(e.category);
  });
});

describe('SDK error classification (status hidden in the message)', () => {
  it('extracts a 401 from the SDK message and calls it auth, not unknown', () => {
    const e = categorize({ name: 'GeneralChatError', message: 'Request failed with status code 401' });
    expect(e.category).toBe('auth');
    expect(isRetryable(e)).toBe(false);
  });

  it('extracts a 429 from the SDK message and retries it', () => {
    const e = categorize({ message: 'Request failed with status code 429' });
    expect(e.category).toBe('rate_limit');
    expect(isRetryable(e)).toBe(true);
  });

  it('extracts a 500 from the SDK message', () => {
    expect(categorize({ message: 'Request failed with status code 500' }).category).toBe('upstream_5xx');
  });

  it('still prefers an explicit status field when present', () => {
    expect(categorize({ status: 429, message: 'Request failed with status code 500' }).category)
      .toBe('rate_limit');
  });

  it('keeps insufficient_credits ahead of any status parsing', () => {
    const e = categorize({ message: 'Request failed with status code 400: Insufficient credits' });
    expect(e.category).toBe('insufficient_credits');
  });
});
