import { describe, expect, it } from 'vitest';
import { normalizeNews } from '../providers/chaingpt.js';

describe('normalizeNews', () => {
  const row = {
    id: 7,
    title: 'Immutable opens grants track',
    description: '<p>Applications  are   <b>open</b></p>',
    createdAt: '2026-08-20T10:00:00.000Z',
    source: 'ChainGPT',
    url: 'https://example.com/a',
  };

  it('reads the nested data.data array shape', () => {
    const out = normalizeNews({ data: { data: [row] } });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Immutable opens grants track');
  });

  it('accepts alternative array locations', () => {
    expect(normalizeNews({ data: [row] })).toHaveLength(1);
    expect(normalizeNews({ news: [row] })).toHaveLength(1);
    expect(normalizeNews([row])).toHaveLength(1);
  });

  it('strips html and collapses whitespace in descriptions', () => {
    expect(normalizeNews([row])[0]!.description).toBe('Applications are open');
  });

  it('normalises publishedAt to an ISO string', () => {
    expect(normalizeNews([row])[0]!.publishedAt).toBe('2026-08-20T10:00:00.000Z');
  });

  it('falls back to now for an unparseable date', () => {
    const out = normalizeNews([{ ...row, createdAt: 'not-a-date' }]);
    expect(Number.isNaN(new Date(out[0]!.publishedAt).getTime())).toBe(false);
  });

  it('drops rows with no usable title', () => {
    expect(normalizeNews([{ description: 'orphan' }])).toHaveLength(0);
  });

  it('returns an empty array for an unexpected payload', () => {
    expect(normalizeNews({ unexpected: true })).toEqual([]);
    expect(normalizeNews(null)).toEqual([]);
  });
});
