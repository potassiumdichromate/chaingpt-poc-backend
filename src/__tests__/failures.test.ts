import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderError, categorize, isRetryable } from '../lib/errors.js';
import { asyncRoute } from '../routes/helpers.js';
import { initStore } from '../db/store.js';
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
  it('treats the SDK\'s bare "Internal server error" as a retryable 5xx', () => {
    const e = categorize(new Error('Internal server error'));
    expect(e.category).toBe('upstream_5xx');
    expect(isRetryable(e)).toBe(true);
  });

  it('retries a TLS reset once instead of failing the scan as unknown', () => {
    const e = categorize(new Error('80E1:error:0A0003FC:SSL routines:ssl3_read_bytes:ssl/tls alert bad record mac'));
    expect(e.category).toBe('upstream_5xx');
    expect(isRetryable(e)).toBe(true);
  });

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

describe('asyncRoute body validation', () => {
  /**
   * Regression: asyncRoute catches every throw, so a ZodError from `.parse()`
   * used to reach sendIntelligenceError and come back as 502 "Intelligence is
   * temporarily unavailable" with retryable:true - telling the client to retry
   * a malformed request forever. The ZodError -> 400 handler in index.ts is
   * unreachable for these routes because asyncRoute answers instead of
   * delegating to next(err).
   */
  const stubRes = () => {
    const res: any = { headersSent: false, statusCode: 0, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; res.headersSent = true; return res; };
    return res;
  };

  const bodySchema = z.object({ opportunityId: z.string() });

  // sendIntelligenceError writes an analytics event, so the store must be live
  // before any test here reaches it - otherwise the first failed write rejects
  // the shared persist() queue and every later write inherits that rejection.
  beforeEach(async () => { await initStore(); });

  it('answers 400 with the offending issues when the body fails validation', async () => {
    const handler = asyncRoute(async (req: any) => { bodySchema.parse(req.body); }, 'test_route');
    const res = stubRes();
    await handler({ body: { opportunityId: 123 }, params: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
    expect(res.body.error.issues[0].path).toEqual(['opportunityId']);
  });

  it('does not label a validation failure as a retryable provider outage', async () => {
    const handler = asyncRoute(async (req: any) => { bodySchema.parse(req.body); }, 'test_route');
    const res = stubRes();
    await handler({ body: {}, params: {} }, res);

    expect(res.statusCode).not.toBe(502);
    expect(res.body.error.retryable).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('temporarily unavailable');
  });

  it('still funnels a genuine provider failure to 502', async () => {
    const handler = asyncRoute(async () => { throw new ProviderError('upstream_5xx', 'boom'); }, 'test_route');
    const res = stubRes();
    await handler({ body: {}, params: {} }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error.retryable).toBe(true);
  });

  it('leaves an already-sent response untouched', async () => {
    const handler = asyncRoute(async () => { throw new Error('late'); }, 'test_route');
    const res = stubRes();
    res.headersSent = true;
    await handler({ body: {}, params: {} }, res);

    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();
  });
});

describe('opportunity schema with no signals', () => {
  /**
   * Regression: engine.ts deliberately reasons on KULT context alone when AI
   * News returns nothing, but the schema used to require signal.min(3). A model
   * with nothing to cite returns "", so that supported path 502'd as
   * malformed_output on a provider call that had actually succeeded.
   */
  const one = (over: Record<string, unknown> = {}) => ({
    opportunities: [{
      title: 'Partner with an AI gaming studio',
      relevance: 80,
      signal: '',
      why: 'Fits the creator profile',
      opportunity: 'Co-marketing slot',
      action: 'Draft an intro message',
      ...over,
    }],
  });

  it('accepts an empty signal instead of rejecting the whole set', () => {
    const r = opportunitySetSchema.safeParse(one());
    expect(r.success).toBe(true);
    expect(r.success && r.data.opportunities[0]!.signal).toBe('');
  });

  it('defaults a missing signal field rather than failing validation', () => {
    const body = one();
    delete (body.opportunities[0] as Record<string, unknown>).signal;
    const r = opportunitySetSchema.safeParse(body);
    expect(r.success).toBe(true);
    expect(r.success && r.data.opportunities[0]!.signal).toBe('');
  });

  it('still enforces the fields that carry the actual recommendation', () => {
    expect(opportunitySetSchema.safeParse(one({ why: '' })).success).toBe(false);
    expect(opportunitySetSchema.safeParse(one({ action: '' })).success).toBe(false);
    expect(opportunitySetSchema.safeParse(one({ title: '' })).success).toBe(false);
  });
});

describe('store write queue', () => {
  /**
   * Regression: persist() assigned the rejected promise back to writeQueue, so
   * one failed write left every later write chaining off a rejected promise -
   * never attempted, each logging the original error, while the API kept
   * answering 201. Spec 15.4 forbids claiming a save that did not happen.
   */
  it('recovers after a failed write instead of rejecting every later one', async () => {
    let queue: Promise<void> = Promise.resolve();
    let shouldFail = true;
    const attempts: number[] = [];

    // Mirrors persist(): sequential, caller sees the real failure, queue settles.
    const persistLike = (): Promise<void> => {
      const attempt = queue.then(async () => {
        attempts.push(1);
        if (shouldFail) throw new Error('disk full');
      });
      queue = attempt.catch(() => {});
      return attempt;
    };

    await expect(persistLike()).rejects.toThrow('disk full');
    shouldFail = false;
    await expect(persistLike()).resolves.toBeUndefined();
    await expect(persistLike()).resolves.toBeUndefined();

    // Every call must actually run; the old code skipped 2 and 3 entirely.
    expect(attempts.length).toBe(3);
  });
});
