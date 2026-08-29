import { describe, expect, it } from 'vitest';
import { extractFirstJsonObject, extractText, parseStructured, stripMarkdown } from '../intelligence/parser.js';
import { deepResearchSchema, opportunitySetSchema } from '../intelligence/schemas.js';

describe('extractText', () => {
  it('reads the documented ChainGPT buffered path data.bot', () => {
    expect(extractText({ data: { bot: 'hello' } })).toBe('hello');
  });

  it('falls back to neighbouring answer fields', () => {
    expect(extractText({ bot: 'a' })).toBe('a');
    expect(extractText({ data: { message: 'b' } })).toBe('b');
    expect(extractText({ answer: 'c' })).toBe('c');
  });

  it('passes strings and buffers through', () => {
    expect(extractText('raw')).toBe('raw');
    expect(extractText(Buffer.from('buf'))).toBe('buf');
  });

  it('returns empty string for nullish input', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });
});

describe('stripMarkdown', () => {
  it('removes json fences', () => {
    expect(stripMarkdown('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripMarkdown('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves bare json untouched', () => {
    expect(stripMarkdown('{"a":1}')).toBe('{"a":1}');
  });
});

describe('extractFirstJsonObject', () => {
  it('strips conversational preamble and trailing prose', () => {
    expect(extractFirstJsonObject('Sure! Here you go: {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    expect(extractFirstJsonObject('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it('does not terminate early on braces inside strings', () => {
    const input = '{"note":"a } brace and a { brace","x":1}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{"note":"he said \\"hi\\" }","x":1}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('returns null when there is no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});

describe('parseStructured', () => {
  const valid = {
    opportunities: [{
      title: 'Apply to the grant track',
      relevance: 91,
      signal: 'Grant track opened',
      why: 'Matches this Agent',
      opportunity: 'Distribution attached',
      action: 'Submit this week',
      memoryInfluence: { used: false, reason: '' },
    }],
  };

  it('parses a clean buffered response', () => {
    const res = parseStructured({ data: { bot: JSON.stringify(valid) } }, opportunitySetSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.relevance).toBe(91);
  });

  it('parses fenced output wrapped in prose', () => {
    const raw = { data: { bot: 'Here is the result:\n```json\n' + JSON.stringify(valid) + '\n```\nLet me know!' } };
    expect(parseStructured(raw, opportunitySetSchema).ok).toBe(true);
  });

  it('repairs trailing commas', () => {
    const raw = { data: { bot: '{"opportunities":[{"title":"Apply now","relevance":80,"signal":"Grant opened","why":"Fits this Agent","opportunity":"Distribution attached","action":"Submit this week",}],}' } };
    expect(parseStructured(raw, opportunitySetSchema).ok).toBe(true);
  });

  it('coerces a stringified relevance score', () => {
    const withString = JSON.parse(JSON.stringify(valid));
    withString.opportunities[0].relevance = '77';
    const res = parseStructured({ data: { bot: JSON.stringify(withString) } }, opportunitySetSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.relevance).toBe(77);
  });

  it('defaults memoryInfluence when the model omits it', () => {
    const noMem = { opportunities: [{ ...valid.opportunities[0] }] };
    delete (noMem.opportunities[0] as Record<string, unknown>).memoryInfluence;
    const res = parseStructured({ data: { bot: JSON.stringify(noMem) } }, opportunitySetSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.memoryInfluence.used).toBe(false);
  });

  it('rejects a schema-invalid payload', () => {
    const res = parseStructured({ data: { bot: '{"opportunities":[{"title":"x"}]}' } }, opportunitySetSchema);
    expect(res.ok).toBe(false);
  });

  it('rejects an empty response', () => {
    expect(parseStructured({ data: { bot: '' } }, opportunitySetSchema).ok).toBe(false);
  });

  it('rejects prose with no JSON at all', () => {
    expect(parseStructured({ data: { bot: 'I cannot help with that.' } }, opportunitySetSchema).ok).toBe(false);
  });

  it('defaults an omitted liveEvidence block on deep research', () => {
    const research = {
      summary: 'The grant track funds AI-native studios.',
      whyNow: 'Applications are open now.',
      fitForAgent: 'This Agent ships agent-driven experiences.',
      recommendedActions: ['Draft a one-page submission.'],
    };
    const res = parseStructured({ data: { bot: JSON.stringify(research) } }, deepResearchSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.liveEvidence.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shape deviations the LIVE model actually produced during smoke testing.
// ---------------------------------------------------------------------------

describe('normalizeShape - live model deviations', () => {
  it('wraps a bare single opportunity in the required top-level key', () => {
    const bare = {
      title: 'AI-Powered Procedural Generation in Gaming', relevance: 82,
      signal: 'Strong demand for unique experiences', why: 'Fits this creator',
      opportunity: 'Lead on procedural generation', action: 'Publish a breakdown',
    };
    const res = parseStructured({ data: { bot: JSON.stringify(bare) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities).toHaveLength(1);
  });

  it('coerces word-grade relevance ("High") into a number', () => {
    const bare = {
      title: 'AI procedural generation', relevance: 'High',
      signal: 'Demand is rising', why: 'Fits this creator',
      opportunity: 'Lead the narrative', action: 'Publish a breakdown',
    };
    const res = parseStructured({ data: { bot: JSON.stringify(bare) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.relevance).toBe(88);
  });

  it('accepts a top-level array where an object was required', () => {
    const arr = [{
      title: 'Grant track', relevance: 90, signal: 'Open now', why: 'Fits',
      opportunity: 'Distribution attached', action: 'Submit this week',
    }];
    const res = parseStructured({ data: { bot: JSON.stringify(arr) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
  });

  it('leaves an already-correct payload untouched', () => {
    const good = { opportunities: [{
      title: 'Grant track', relevance: 90, signal: 'Open now', why: 'Fits',
      opportunity: 'Distribution attached', action: 'Submit this week',
    }] };
    const res = parseStructured({ data: { bot: JSON.stringify(good) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.relevance).toBe(90);
  });
});

describe('normalizeShape - stringified nested objects (observed live)', () => {
  const base = {
    title: 'Procedural content generation in AI gaming', relevance: 84,
    signal: 'Emerging technique in game development', why: 'Matches this creator',
    opportunity: 'Lead the narrative', action: 'Publish a technical breakdown',
  };

  it('promotes a sentence-valued memoryInfluence into the object shape', () => {
    const raw = { ...base, memoryInfluence: 'Not applicable' };
    const res = parseStructured({ data: { bot: JSON.stringify(raw) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) {
      const mi = res.data.opportunities[0]!.memoryInfluence;
      expect(mi.used).toBe(false);
      expect(mi.reason).toBe('Not applicable');
    }
  });

  it('promotes a sentence-valued liveEvidence into the object shape', () => {
    const raw = { ...base, liveEvidence: 'Recent coverage supports this.' };
    const res = parseStructured({ data: { bot: JSON.stringify(raw) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.liveEvidence?.summary).toBe('Recent coverage supports this.');
  });

  it('parses a JSON-encoded string back into a real object', () => {
    const raw = {
      ...base,
      memoryInfluence: '{"used":true,"knowledgeIds":["kn_1"],"reason":"Builds on prior research"}',
    };
    const res = parseStructured({ data: { bot: JSON.stringify(raw) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.opportunities[0]!.memoryInfluence.used).toBe(true);
      expect(res.data.opportunities[0]!.memoryInfluence.knowledgeIds).toEqual(['kn_1']);
    }
  });

  it('leaves a correctly-shaped object untouched', () => {
    const raw = { ...base, memoryInfluence: { used: true, knowledgeIds: ['kn_2'], reason: 'Follows on' } };
    const res = parseStructured({ data: { bot: JSON.stringify(raw) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.opportunities[0]!.memoryInfluence.reason).toBe('Follows on');
  });

  it('handles both nested fields stringified at once', () => {
    const raw = { ...base, memoryInfluence: 'None', liveEvidence: 'No live data found.' };
    const res = parseStructured({ data: { bot: JSON.stringify(raw) } }, opportunitySetSchema, 'opportunities');
    expect(res.ok).toBe(true);
  });
});
