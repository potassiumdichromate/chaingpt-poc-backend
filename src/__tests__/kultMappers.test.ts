import { describe, expect, it } from 'vitest';
import { creatorDisplayName, creatorToAgent, gameToProject, parseCreatorPrompt, toText } from '../kult/mappers.js';
import type { KultGamePackage } from '../kult/kultTypes.js';

const racing: KultGamePackage = {
  id: 'g1',
  tier: 'template',
  title: 'Neon 2D Racing',
  templateId: 'racing',
  templateName: '2D Racing',
  category: 'Racing',
  creatorId: 'creator_1',
  views: 2412,
  customization: { prompt: 'A fast neon night race.', theme: 'Neon', difficulty: 'normal' },
  gameplay: { mechanic: 'Drift through checkpoints and beat lap targets.', controls: 'Arrow keys, WASD' },
  visuals: { mood: 'bright arcade glow' },
  publish: { published: true, status: 'published', publishedAt: '2026-07-18T09:00:00.000Z' },
  browserFeature: { featured: true },
};

describe('gameToProject', () => {
  it('maps real KULT game package fields', () => {
    const p = gameToProject(racing);
    expect(p.id).toBe('g1');
    expect(p.ownerAgentId).toBe('creator_1');
    expect(p.title).toBe('Neon 2D Racing');
    expect(p.category).toBe('Racing');
    expect(p.publishedAt).toBe('2026-07-18T09:00:00.000Z');
  });

  it("leads the description with the creator's own brief when present", () => {
    expect(gameToProject(racing).description).toContain('A fast neon night race');
  });

  it('falls back to composing from gameplay fields when there is no brief', () => {
    const d = gameToProject({ ...racing, customization: { theme: 'Neon' } }).description;
    expect(d).toContain('Drift through checkpoints');
    expect(d).toContain('Arrow keys');
  });

  it('never synthesises a session length', () => {
    const stats = gameToProject(racing).stats!;
    expect(stats).not.toHaveProperty('avgSessionMin');
    expect(stats.plays).toBe(2412);
  });

  it('prefers live social view count over the denormalised views field', () => {
    const p = gameToProject(racing, { views: { count: 9999 }, likes: { count: 12 } });
    expect(p.stats!.plays).toBe(9999);
    expect(p.stats!.likes).toBe(12);
  });

  it('omits engagement counters that KULT did not return', () => {
    const stats = gameToProject(racing, null).stats!;
    expect(stats.likes).toBeUndefined();
    expect(stats.shares).toBeUndefined();
  });

  it('derives audience from the real template category', () => {
    expect(gameToProject(racing).audience.join(' ')).toMatch(/racing/i);
  });

  it('allows audience and goals to be overridden per deployment', () => {
    const p = gameToProject(racing, null, { audience: ['Custom'], goals: ['Ship'] });
    expect(p.audience).toEqual(['Custom']);
    expect(p.goals).toEqual(['Ship']);
  });

  it('survives a sparse package with only an id', () => {
    const p = gameToProject({ id: 'bare' });
    expect(p.id).toBe('bare');
    expect(p.title).toBe('Untitled KULT experience');
    expect(p.description.length).toBeGreaterThan(0);
  });
});

describe('creatorToAgent', () => {
  const puzzle: KultGamePackage = {
    id: 'g2', tier: 'pure-agent', title: 'Pulse Blocks', templateName: 'Match-3 Puzzle',
    category: 'Puzzle', creatorId: 'creator_1', views: 731,
    publish: { published: true },
  };
  const draft: KultGamePackage = {
    id: 'g3', title: 'Unpublished', category: 'Action', creatorId: 'creator_1',
    publish: { published: false },
  };

  it('derives interests from categories actually shipped', () => {
    const a = creatorToAgent('creator_1', [racing, puzzle]);
    expect(a.interests).toContain('Racing');
    expect(a.interests).toContain('Puzzle');
  });

  it('ignores unpublished drafts when deriving context', () => {
    const a = creatorToAgent('creator_1', [racing, draft]);
    expect(a.interests).not.toContain('Action');
  });

  it('sums plays only across published games', () => {
    const a = creatorToAgent('creator_1', [racing, puzzle, draft]);
    expect(a.activity.join(' ')).toContain('3,143');
  });

  it('flags AI-native generation when a non-template build exists', () => {
    expect(creatorToAgent('creator_1', [puzzle]).capabilities).toContain('AI-native game generation');
  });

  it('uses the real profile username when present', () => {
    const a = creatorToAgent('creator_1', [racing], { profile: { username: 'Nova' } });
    expect(a.name).toBe('Nova');
  });

  it('renders a readable name for a wallet id when username is null', () => {
    const a = creatorToAgent('0xa123ed1f58a71266078a27c013c3f32294dedf4a', [racing], { profile: { username: null } });
    expect(a.name).toBe('0xa123…df4a');
  });

  it('renders a readable name for a Privy DID', () => {
    expect(creatorToAgent('did:privy:cmnditqy301kl0cjrbm20d737', [racing]).name).toBe('privy:cmnditqy…');
  });

  it('collapses duplicate activity-log lines', () => {
    const a = creatorToAgent('creator_1', [racing], {
      activities: [
        { activityType: 'publish', gameTitle: 'Knife Flip Tower' },
        { activityType: 'publish', gameTitle: 'Knife Flip Tower' },
        { activityType: 'create', gameTitle: 'Knife Flip Tower' },
      ],
    });
    const publishes = a.activity.filter((l) => l === 'publish: "Knife Flip Tower"');
    expect(publishes).toHaveLength(1);
  });

  it('renders the real activity log', () => {
    const a = creatorToAgent('creator_1', [racing], {
      activities: [{ activityType: 'game_published', gameTitle: 'Neon 2D Racing' }],
    });
    expect(a.activity[0]).toBe('game published: "Neon 2D Racing"');
  });

  it('handles a creator with no games at all', () => {
    const a = creatorToAgent('creator_x', []);
    expect(a.id).toBe('creator_x');
    expect(a.goals.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Shapes observed in the LIVE KULT database. These are not hypotheticals: 21 of
// 138 published games store `controls` as a keyed map, and one stores both
// `controls` and `mechanic` as arrays. Assuming strings crashed the agent route.
// ---------------------------------------------------------------------------

describe('toText - real KULT field shape variance', () => {
  it('passes strings through', () => {
    expect(toText('Arrow keys, WASD')).toBe('Arrow keys, WASD');
  });

  it('joins a string[] (observed on generated games)', () => {
    expect(toText(['swipe up to jump', 'swipe down to slide'])).toBe('swipe up to jump, swipe down to slide');
  });

  it('flattens a keyed control map (observed on 21 live games)', () => {
    const out = toText({ move: 'WASD or Arrow Keys', dash: 'Shift' });
    expect(out).toContain('move: WASD or Arrow Keys');
    expect(out).toContain('dash: Shift');
  });

  it('flattens nested arrays inside a control map', () => {
    expect(toText({ input_methods: ['tap', 'swipe'] })).toBe('input methods: tap/swipe');
  });

  it('returns empty string for null and undefined', () => {
    expect(toText(null)).toBe('');
    expect(toText(undefined)).toBe('');
  });
});

describe('gameToProject with live-shaped records', () => {
  it('does not throw when mechanic and controls are arrays', () => {
    const p = gameToProject({
      id: 'pxfvypnw32c',
      title: 'Velocity Pursuit',
      category: 'Endless Runner',
      gameplay: {
        mechanic: ['endless running', 'lane switching (3 lanes)'],
        controls: ['swipe up to jump', 'tilt device to collect coins'],
      },
    });
    expect(p.title).toBe('Velocity Pursuit');
    expect(p.description.length).toBeGreaterThan(0);
  });

  it('does not throw when controls is a keyed map', () => {
    const p = gameToProject({
      id: 'ctr41t7q5j',
      title: 'Dungeon Run',
      category: 'Roguelike',
      gameplay: { mechanic: 'Dash and pounce', controls: { move: 'WASD', pause: 'Esc' } },
    });
    expect(p.description).toContain('Dash and pounce');
  });

  it('drops overlong theme strings from tags', () => {
    const p = gameToProject({
      id: 'g',
      category: 'Arcade',
      customization: { theme: 'Tense industrial climbing with neon accents, shifting from warm sunset to stormy night' },
    });
    expect(p.tags.every((t) => t.length <= 30)).toBe(true);
  });

  it('prefers game.points when social counters are absent', () => {
    const p = gameToProject({ id: 'g', views: 10, points: { plays: 5, likes: 4, shares: 2 } });
    expect(p.stats!.plays).toBe(10);
    expect(p.stats!.likes).toBe(4);
    expect(p.stats!.shares).toBe(2);
  });

  it('carries the real CDN thumbnail and play path', () => {
    const p = gameToProject({
      id: 'g',
      thumbnailUrl: 'https://cdn.example/thumb.png',
      publish: { published: true, playPath: '/play?gameId=g' },
    });
    expect(p.thumbnailUrl).toBe('https://cdn.example/thumb.png');
    expect(p.playPath).toBe('/play?gameId=g');
  });

  it('matches audience for free-text categories with odd casing', () => {
    expect(gameToProject({ id: 'a', category: 'endless-runner' }).audience.join(' ')).toMatch(/runner/i);
    expect(gameToProject({ id: 'b', category: 'action' }).audience.join(' ')).toMatch(/action|reflex/i);
  });

  it('falls back to a generic audience for an unknown category', () => {
    expect(gameToProject({ id: 'c', category: 'Zzzz' }).audience.length).toBeGreaterThan(0);
  });
});

describe('parseCreatorPrompt', () => {
  it('extracts the title and prose from a markdown design doc', () => {
    const { title, prose } = parseCreatorPrompt('## Title\n**Knife Flip Tower**\n\nA fast arcade climber where you flip a knife.');
    expect(title).toBe('Knife Flip Tower');
    expect(prose).toBe('A fast arcade climber where you flip a knife.');
    expect(prose).not.toContain('##');
  });

  it('handles a plain non-markdown brief', () => {
    expect(parseCreatorPrompt('Just a short brief.').prose).toBe('Just a short brief.');
  });

  it('handles empty input', () => {
    expect(parseCreatorPrompt(undefined)).toEqual({ prose: '' });
  });
});

describe('creatorDisplayName', () => {
  it('prefers a real username', () => {
    expect(creatorDisplayName('0xabc', 'Nova')).toBe('Nova');
  });

  it('shortens wallet addresses', () => {
    expect(creatorDisplayName('0xa123ed1f58a71266078a27c013c3f32294dedf4a')).toBe('0xa123…df4a');
  });

  it('shortens Privy DIDs', () => {
    expect(creatorDisplayName('did:privy:cmnditqy301kl0cjrbm20d737')).toBe('privy:cmnditqy…');
  });
});

// ChainGPT rejects a readable thread id: "sdkUniqueId must be a UUID".
describe('threadUuid', () => {
  it('produces a valid v5-shaped UUID', async () => {
    const { threadUuid } = await import('../intelligence/engine.js');
    expect(threadUuid('kult:a:research:o'))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is stable for the same key, so a research thread stays continuous', async () => {
    const { threadUuid } = await import('../intelligence/engine.js');
    expect(threadUuid('kult:a:research:o')).toBe(threadUuid('kult:a:research:o'));
  });

  it('differs per opportunity, so threads do not leak into each other', async () => {
    const { threadUuid } = await import('../intelligence/engine.js');
    expect(threadUuid('kult:a:research:o1')).not.toBe(threadUuid('kult:a:research:o2'));
  });
});
