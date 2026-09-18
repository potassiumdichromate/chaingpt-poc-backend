import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request identity, available anywhere below the route handler without
 * threading it through every call. Analytics and provider-call accounting read it
 * so metrics can count distinct users and attribute ChainGPT spend to an Agent.
 */
export interface RequestContext {
  /** Anonymous, browser-generated id from the x-kult-client-id header. */
  clientId?: string;
  /** Authenticated user id (a Privy DID) when AUTH_MODE=privy. */
  userId?: string;
  /** Set by the engine once it knows which Agent the request is for. */
  agentId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setContextAgent(agentId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.agentId = agentId;
}

/** Accepts only short opaque ids, so a header cannot smuggle arbitrary text into metrics. */
export function sanitizeClientId(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : undefined;
}
