import { describe, expect, it } from 'vitest';
import { buildNewsParams, newsQueryString, normalizeNews } from '../providers/chaingpt.js';

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

// VERIFIED LIVE 2026-09-18: real rows carry category {id,name}, subCategory {id,name}
// (the chain) and token {id,name}. The old mapper folded the token into `category`.
describe('normalizeNews - category, chain and token', () => {
  const live = {
    statusCode: 200,
    data: [{
      id: 50681, title: 'Ethereum validator set grows', description: 'x', pubDate: '2026-09-18T06:02:51.000Z',
      categoryId: 71, category: { id: 71, name: 'Consensus Mechanisms' },
      subCategoryId: 5, subCategory: { id: 5, name: 'Ethereum' },
      tokenId: 3388, token: { id: 3388, name: 'Ethereum' },
    }, {
      id: 50600, title: 'Uncategorised story', description: 'y', pubDate: '2026-09-17T00:00:00.000Z',
      category: null, subCategory: null, token: null,
    }],
  };

  it('keeps category, chain and token as separate fields', () => {
    const [s] = normalizeNews(live);
    expect(s).toMatchObject({ category: 'Consensus Mechanisms', categoryId: 71, chain: 'Ethereum', token: 'Ethereum' });
  });

  it('leaves them undefined on the (common) uncategorised row instead of inventing one', () => {
    const [, s] = normalizeNews(live);
    expect(s!.category).toBeUndefined();
    expect(s!.categoryId).toBeUndefined();
    expect(s!.chain).toBeUndefined();
  });
});

/**
 * SDK/REST parity. The SDK sends params through axios GET; the REST transport must
 * send a byte-identical query string. Expected strings are axios 1.19 getUri()
 * output, captured live.
 */
describe('news request params - identical on both transports', () => {
  it('drops empty filters and fills defaults', () => {
    expect(buildNewsParams({ searchQuery: '  ', categoryId: [] })).toEqual({ limit: 12, offset: 0, sortBy: 'createdAt' });
  });

  it('serializes exactly like axios, arrays and dates included', () => {
    const p = buildNewsParams({
      searchQuery: 'AI gaming', limit: 6, fetchAfter: new Date('2026-09-04T00:00:00Z'), categoryId: [8, 4], tokenId: [1],
    });
    expect(newsQueryString(p)).toBe(
      'searchQuery=AI+gaming&limit=6&offset=0&sortBy=createdAt&fetchAfter=2026-09-04T00:00:00.000Z&categoryId%5B%5D=8&categoryId%5B%5D=4&tokenId%5B%5D=1',
    );
  });

  it('matches axios on the characters it treats specially', () => {
    expect(newsQueryString(buildNewsParams({ searchQuery: "AI $gaming, (x)!~'*" })).split('&')[0])
      .toBe("searchQuery=AI+$gaming,+(x)!~'*");
    expect(newsQueryString(buildNewsParams({ searchQuery: 'a:b/c?d&e=f#g' })).split('&')[0])
      .toBe('searchQuery=a:b%2Fc%3Fd%26e%3Df%23g');
  });
});
