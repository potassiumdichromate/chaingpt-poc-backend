import { config, resolveProvider } from '../config.js';
import { log } from '../lib/logger.js';
import { ChainGPTProvider } from './chaingpt.js';
import { DemoProvider } from './demo.js';
import type { IntelligenceProvider } from './types.js';

let cached: IntelligenceProvider | null = null;

export function getProvider(): IntelligenceProvider {
  if (cached) return cached;

  const resolved = resolveProvider();
  if (resolved.degraded) log.warn('provider_degraded', { reason: resolved.reason });

  cached = resolved.name === 'chaingpt'
    ? new ChainGPTProvider(config.chaingpt.apiKey)
    : new DemoProvider();

  log.info('provider_selected', { provider: cached.name, transport: config.chaingpt.transport });
  return cached;
}

export function providerStatus() {
  const resolved = resolveProvider();
  return {
    configured: config.provider,
    active: resolved.name,
    degraded: resolved.degraded,
    reason: resolved.reason,
    transport: config.chaingpt.transport,
  };
}

export type { IntelligenceProvider } from './types.js';
