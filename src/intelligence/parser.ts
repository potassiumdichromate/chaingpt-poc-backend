import type { ZodTypeAny, output as ZodOutput } from 'zod';
import { ProviderError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * Spec 12.4 parsing pipeline:
 *   Receive -> Detect Stream/Buffer -> Extract Text -> Strip Markdown
 *   -> Extract JSON -> Validate Schema -> Retry/Fallback
 */

/**
 * ChainGPT's buffered response exposes the answer at `data.bot`. We also accept
 * a handful of neighbouring shapes so a provider-side field rename degrades into
 * a parse attempt rather than a hard failure.
 */
export function extractText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');

  const r = raw as Record<string, any>;
  const candidates = [
    r?.data?.bot,
    r?.data?.data?.bot,
    r?.bot,
    r?.data?.message,
    r?.message,
    r?.data?.answer,
    r?.answer,
    r?.data?.response,
    r?.response,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  if (typeof r?.data === 'string' && r.data.trim() !== '') return r.data;

  // Last resort: stringify so the JSON extractor still gets a shot.
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** Accumulates a true SSE / chunked stream server-side before validation (spec 17). */
export async function accumulateStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  return chunks.join('');
}

/** Removes ```json fences and common conversational preamble. */
export function stripMarkdown(text: string): string {
  let t = text.trim();
  t = t.replace(/^﻿/, '');
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) t = fence[1];
  return t.trim();
}

/**
 * Scans for the first balanced top-level JSON object, honouring string literals
 * and escapes so braces inside prose values do not terminate the scan early.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Repairs the malformed-JSON tics models produce most often. */
function repairCommonJsonFlaws(json: string): string {
  return json
    .replace(/,\s*([}\]])/g, '$1')          // trailing commas
    .replace(/[“”]/g, '"')         // smart double quotes
    .replace(/[‘’]/g, "'")         // smart single quotes
    .replace(/\bNaN\b/g, '0')
    .replace(/\bUndefined\b|\bundefined\b/g, 'null');
}

/**
 * Reshapes the two deviations the live model actually produces:
 *  1. a bare single opportunity instead of { opportunities: [ ... ] }
 *  2. word-grade relevance ("High") instead of an integer
 * Applied before validation so the repair round-trip is not spent on them.
 */
const RELEVANCE_WORDS: Record<string, number> = {
  'very high': 95, high: 88, 'medium-high': 78, medium: 70, moderate: 65,
  'medium-low': 55, low: 45, 'very low': 30,
};

/**
 * Promotes a stringified nested field into the object shape the schema expects.
 * Handles both a JSON-encoded object and a bare sentence; leaves real objects and
 * genuinely absent fields untouched.
 */
function objectify(
  value: unknown,
  fromText: (text: string) => Record<string, unknown>,
): unknown {
  if (value == null) return value;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;

  const text = value.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to the sentence form */ }
  }
  return fromText(text);
}

export function normalizeShape(value: unknown, wrapperKey: string): unknown {
  if (value == null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;

  let out: Record<string, unknown> = obj;

  // (1) A bare item, or an array of items, where a wrapper object was required.
  if (!(wrapperKey in obj)) {
    if (Array.isArray(value)) out = { [wrapperKey]: value };
    else if ('title' in obj && ('action' in obj || 'why' in obj)) out = { [wrapperKey]: [obj] };
  }

  // (2) Per-item coercions.
  const items = out[wrapperKey];
  if (Array.isArray(items)) {
    out[wrapperKey] = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const rec = { ...(item as Record<string, unknown>) };

      // Word-grade relevance ("High") where an integer is required.
      const rel = rec.relevance;
      if (typeof rel === 'string') {
        const word = RELEVANCE_WORDS[rel.trim().toLowerCase()];
        const numeric = Number(rel.replace(/[^0-9.]/g, ''));
        rec.relevance = word ?? (Number.isFinite(numeric) && numeric > 0 ? numeric : 70);
      }

      // VERIFIED LIVE: the model frequently answers a nested object with a bare
      // sentence - "memoryInfluence": "Not applicable". Promote it to the object
      // shape, keeping the sentence as the human-readable field.
      rec.memoryInfluence = objectify(rec.memoryInfluence, (text) => ({
        used: false, knowledgeIds: [], reason: text,
      }));
      rec.liveEvidence = objectify(rec.liveEvidence, (text) => ({
        used: text.trim().length > 0, summary: text, evidenceTypes: [],
      }));

      return rec;
    });
  }
  return out;
}

export type ParseResult<T> =
  | { ok: true; data: T; rawText: string }
  | { ok: false; reason: string; rawText: string };

/** Full pipeline for one candidate response. Never throws. */
export function parseStructured<S extends ZodTypeAny>(
  raw: unknown,
  schema: S,
  wrapperKey?: string,
): ParseResult<ZodOutput<S>> {
  const rawText = extractText(raw);
  if (!rawText.trim()) return { ok: false, reason: 'empty provider response', rawText };

  const stripped = stripMarkdown(rawText);
  const candidate = extractFirstJsonObject(stripped) ?? stripped;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(repairCommonJsonFlaws(candidate));
    } catch (e) {
      return { ok: false, reason: `JSON.parse failed: ${(e as Error).message}`, rawText };
    }
  }

  if (wrapperKey) parsed = normalizeShape(parsed, wrapperKey);

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: `schema validation failed: ${validated.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, rawText };
  }
  return { ok: true, data: validated.data, rawText };
}

/**
 * Spec 12.4 / 17: validate, and on failure make exactly one model repair attempt
 * before surfacing a friendly retry state. Raw provider text is logged at debug
 * only and never returned to the consumer.
 */
export async function parseWithRepair<S extends ZodTypeAny>(
  raw: unknown,
  schema: S,
  repair: (badText: string, reason: string) => Promise<unknown>,
  label: string,
  wrapperKey?: string,
): Promise<ZodOutput<S>> {
  const first = parseStructured(raw, schema, wrapperKey);
  if (first.ok) return first.data;

  log.warn('structured_output_invalid', { label, reason: first.reason });
  log.debug('structured_output_raw', { label, raw: first.rawText.slice(0, 4000) });

  const repaired = await repair(first.rawText, first.reason);
  const second = parseStructured(repaired, schema, wrapperKey);
  if (second.ok) {
    log.info('structured_output_repaired', { label });
    return second.data;
  }

  log.error('structured_output_unrecoverable', { label, reason: second.reason });
  log.debug('structured_output_raw_repair', { label, raw: second.rawText.slice(0, 4000) });
  throw new ProviderError('malformed_output', `${label}: ${second.reason}`);
}
