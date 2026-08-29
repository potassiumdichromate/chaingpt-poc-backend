/**
 * Appendix A - live ChainGPT API verification.
 *
 *   npm run smoke
 *
 * Confirms auth, the News response shape, the buffered chat answer path
 * (data.bot) and whether the model reliably obeys a pure-JSON instruction.
 * Run this with the real key before recording the showcase.
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { ChainGPTProvider, normalizeNews } from '../src/providers/chaingpt.js';
import { extractText, parseStructured } from '../src/intelligence/parser.js';
import { opportunitySetSchema } from '../src/intelligence/schemas.js';

const line = (s = '') => console.log(s);
const ok = (s: string) => console.log(`  \x1b[32mPASS\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${s}`);
const info = (s: string) => console.log(`  \x1b[36m·\x1b[0m ${s}`);

async function main() {
  line('\nChainGPT live API verification (spec Appendix A)');
  line(`transport=${config.chaingpt.transport}  baseUrl=${config.chaingpt.baseUrl}`);
  line('='.repeat(70));

  if (!config.chaingpt.apiKey) {
    bad('CHAINGPT_API_KEY is not set in backend/.env - cannot run the live smoke test.');
    process.exit(1);
  }

  const provider = new ChainGPTProvider(config.chaingpt.apiKey);
  let failures = 0;

  // Credits first: an exhausted balance fails every later check for one reason,
  // and reporting four mysterious failures instead of "top up" wastes time.
  line('\n[0] credit balance');
  try {
    await provider.reason('Say pong', { chatHistory: 'off', useCustomContext: false, timeoutMs: 60_000, label: 'smoke.credits' });
    ok('account has credits');
  } catch (err) {
    const e = err as { category?: string };
    if (e.category === 'insufficient_credits') {
      bad('ACCOUNT IS OUT OF CREDITS - every reasoning check below will fail.');
      info('Top up at https://app.chaingpt.org  (1 credit = $0.01; +1 per request when chatHistory is on)');
      info('Then re-run: npm run smoke');
      line(`\n${'='.repeat(70)}`);
      line('\x1b[31mStopping early - resolve credits first.\x1b[0m\n');
      process.exit(1);
    }
    bad(`unexpected: ${(err as Error).message}`);
    failures += 1;
  }

  // --- 1. AI Crypto News ---
  line('\n[1] GET /news');
  try {
    // Short phrase + fallbacks: the live API matches searchQuery literally, so a
    // long multi-term query returns zero rows.
    const signals = await provider.getSignals({
      searchQuery: 'AI gaming',
      fallbackQueries: ['web3 gaming', 'gaming', 'web3'],
      limit: 5,
      fetchAfter: new Date(Date.now() - 14 * 86_400_000),
    });
    if (signals.length === 0) {
      bad('authenticated but returned 0 articles - widen searchQuery or fetchAfter');
      failures += 1;
    } else {
      ok(`${signals.length} signal(s) normalized`);
      const s = signals[0]!;
      info(`title:       ${s.title.slice(0, 70)}`);
      info(`description: ${s.description ? `${s.description.slice(0, 60)}...` : '(EMPTY - check field name)'}`);
      info(`source:      ${s.source}`);
      info(`publishedAt: ${s.publishedAt}`);
      info(`url:         ${s.url ?? '(none)'}`);
      if (!s.description) { bad('description empty - inspect raw shape and extend normalizeNews()'); failures += 1; }
    }
  } catch (err) {
    bad(`news failed: ${(err as Error).message}`);
    failures += 1;
  }

  // --- 2. Buffered chat + answer path ---
  line('\n[2] POST /chat/stream (buffered blob)');
  let rawBlob: unknown;
  try {
    rawBlob = await provider.reason('Reply with exactly the word: pong', {
      chatHistory: 'off',
      useCustomContext: false,
      timeoutMs: 60_000,
      label: 'smoke.ping',
    });
    const text = extractText(rawBlob);
    if (!text.trim()) {
      bad('no answer text found - the documented data.bot path may have changed');
      info(`raw keys: ${JSON.stringify(Object.keys((rawBlob as object) ?? {}))}`);
      failures += 1;
    } else {
      ok(`answer extracted (${text.length} chars): "${text.slice(0, 60).replace(/\n/g, ' ')}"`);
      const direct = (rawBlob as any)?.data?.bot;
      info(direct ? 'documented data.bot path confirmed' : 'data.bot NOT present - extractText used a fallback path');
    }
  } catch (err) {
    bad(`chat failed: ${(err as Error).message}`);
    failures += 1;
  }

  // --- 3. Custom AI Hub context (spec 11.5) ---
  line('\n[3] useCustomContext: true');
  try {
    const res = await provider.reason('In one sentence, what is KULT?', {
      chatHistory: 'off',
      useCustomContext: true,
      timeoutMs: 60_000,
      label: 'smoke.context',
    });
    const text = extractText(res);
    ok(`accepted (${text.length} chars)`);
    info(`answer: ${text.slice(0, 200).replace(/\n/g, ' ')}`);

    // A key with no AI Hub context answers "KULT is a cryptocurrency" - a wrong
    // prior that would poison every recommendation. Treat it as a real failure.
    if (/crypto ?currency|token|coin|blockchain project/i.test(text) && !/creator|platform|game/i.test(text)) {
      bad('AI Hub context is NOT configured - ChainGPT thinks KULT is a cryptocurrency.');
      info('Configure the KULT context in the AI Hub for this key, or keep CHAINGPT_USE_CUSTOM_CONTEXT=false.');
      failures += 1;
    }
  } catch (err) {
    bad(`useCustomContext rejected: ${(err as Error).message}`);
    failures += 1;
  }

  // --- 4. JSON obedience ---
  line('\n[4] structured JSON obedience');
  try {
    const res = await provider.reason(
      `TASK_ID: opportunity_radar
Return ONE JSON object, no markdown fences, no commentary:
{"opportunities":[{"title":"string","relevance":80,"signal":"string","why":"string","opportunity":"string","action":"string","memoryInfluence":{"used":false,"knowledgeIds":[],"reason":""},"liveEvidence":{"used":false,"summary":"","evidenceTypes":[]}}]}
Invent one plausible opportunity about AI gaming for the test.`,
      { chatHistory: 'off', useCustomContext: false, timeoutMs: 90_000, label: 'smoke.json' },
    );
    const parsed = parseStructured(res, opportunitySetSchema, 'opportunities');
    if (parsed.ok) {
      ok(`parsed and schema-validated (${parsed.data.opportunities.length} opportunity)`);
      const clean = extractText(res).trim().startsWith('{');
      info(clean ? 'model returned bare JSON' : 'model wrapped JSON in prose/fences - defensive parser required');
      info(`relevance parsed as: ${parsed.data.opportunities[0]!.relevance} (numeric)`);
    } else {
      bad(`parse/validate failed: ${parsed.reason}`);
      info(`raw: ${parsed.rawText.slice(0, 200).replace(/\n/g, ' ')}`);
      info('The repair pass covers this at runtime, but expect an extra call per request.');
      failures += 1;
    }
  } catch (err) {
    bad(`json probe failed: ${(err as Error).message}`);
    failures += 1;
  }

  line(`\n${'='.repeat(70)}`);
  if (failures === 0) {
    line('\x1b[32mAll checks passed - safe to record the showcase live.\x1b[0m\n');
  } else {
    line(`\x1b[31m${failures} check(s) failed - resolve before recording.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
