import type { Agent, CreatorProject } from '../types.js';
import type {
  KultActivity, KultGamePackage, KultPointSummary, KultProfile, KultSocialStats,
} from './kultTypes.js';

/**
 * Real KULT Creator Studio documents -> POC intelligence context.
 *
 * IMPORTANT - what is real and what is derived:
 *
 *   REAL (read straight from KULT): title, category, templateId, mechanic, controls,
 *   theme, difficulty, creator prompt, publish date, play counts, likes, shares,
 *   comments, activity log, points.
 *
 *   DERIVED (KULT has no such field): Agent.goals, CreatorProject.audience and
 *   CreatorProject.goals. Confirmed by grepping the production source - there is no
 *   goals/audience/bio anywhere in the schema. Rather than invent them per request
 *   and pass them off as KULT data, they are computed from real signals (which
 *   categories the creator actually ships, how their games actually perform) and
 *   are overridable per deployment. Anything derived is labelled at the call site.
 */

// --------------------------------------------------------------- helpers

/** Audience inference by real KULT template category (data/templates.js). */
const AUDIENCE_BY_CATEGORY: Record<string, string[]> = {
  Racing: ['Arcade and racing players', 'Leaderboard and time-trial communities'],
  Arcade: ['Casual arcade players', 'Short-session mobile players'],
  Puzzle: ['Puzzle and brain-training players', 'Daily-habit players'],
  Action: ['Action and reflex players', 'Speedrun communities'],
  Board: ['Strategy and board-game players'],
  Card: ['Card-game players'],
  Idle: ['Idle and progression players', 'Long-tail retention audiences'],
  Automation: ['Automation and optimisation players'],
  Trivia: ['Trivia and quiz communities'],
  Creative: ['Creative and social players'],
  Casual: ['Casual and social players'],
  Shooter: ['Shooter and arcade players'],
  Sports: ['Sports-game players'],
  Simulation: ['Simulation players'],
  Strategy: ['Strategy players'],
  Retro: ['Retro and pixel-art enthusiasts'],
  Combat: ['Fighting-game players'],
  Adventure: ['Adventure and exploration players'],
  Collection: ['Collection and completionist players'],
  Runner: ['Endless-runner players', 'Score-chasing and speedrun communities'],
  'Endless Runner': ['Endless-runner players', 'Score-chasing communities'],
  Platformer: ['Platformer players', 'Precision-jump communities'],
  Fighting: ['Fighting-game players'],
  Roguelike: ['Roguelike and run-based players'],
};

/** Default creator goals. KULT stores no goals field; override per deployment. */
const DEFAULT_PROJECT_GOALS = [
  'Distribution beyond the KULT native audience',
  'Qualified players who return',
  'Ecosystem partners for co-marketing',
];

const DEFAULT_AGENT_GOALS = [
  'Find distribution for published KULT Create experiences',
  'Reach qualified players rather than raw impressions',
  'Identify ecosystems and partners aligned with AI-native gameplay',
];

/**
 * Flattens the shapes live KULT data actually uses for free-text gameplay fields.
 * `controls` appears as a string, a string[], or a keyed map ({ move: "WASD" });
 * `mechanic` appears as a string or a string[] of bullets. Anything else degrades
 * to an empty string rather than throwing.
 */
export function toText(value: unknown, joiner = ', '): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => toText(v, joiner)).filter(Boolean).join(joiner);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const text = toText(v, '/');
        return text ? `${k.replace(/_/g, ' ')}: ${text}` : '';
      })
      .filter(Boolean)
      .join(joiner);
  }
  return '';
}

function unique(values: unknown[], max = 12, maxLen = Infinity): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = toText(v);
    if (!s || s.length > maxLen) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function isPublished(game: KultGamePackage): boolean {
  return game.publish?.published === true;
}

/**
 * Generated games store a full markdown design doc in customization.prompt,
 * shaped `## Title\n**Name**\n\n<prose>`. The prose is the best description
 * KULT holds, so it is extracted rather than dumped verbatim with its heading.
 */
export function parseCreatorPrompt(raw?: string): { title?: string; prose: string } {
  const text = (raw ?? '').trim();
  if (!text) return { prose: '' };

  const title = /^##\s*Title\s*\n\s*\*\*([^*\n]+)\*\*/i.exec(text)?.[1]?.trim();

  const prose = text
    .replace(/^##\s*Title\s*\n\s*\*\*[^*\n]+\*\*/i, '')
    .replace(/^#{1,6}\s.*$/gm, ' ')   // drop remaining headings
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, prose };
}

/** Usernames are frequently null in live KULT data; build something readable. */
export function creatorDisplayName(creatorId: string, username?: string | null): string {
  if (username) return username;
  if (creatorId.startsWith('0x') && creatorId.length > 12) {
    return `${creatorId.slice(0, 6)}…${creatorId.slice(-4)}`;
  }
  if (creatorId.startsWith('did:privy:')) {
    return `privy:${creatorId.slice(10, 18)}…`;
  }
  return creatorId.length > 16 ? `${creatorId.slice(0, 14)}…` : creatorId;
}

/** Engagement, preferring live social counters and falling back to game.points. */
function engagement(game: KultGamePackage, social?: KultSocialStats | null) {
  const pick = (a?: number, b?: number) => (a && a > 0 ? a : (b && b > 0 ? b : undefined));
  return {
    plays: social?.views?.count ?? game.views ?? game.points?.plays ?? 0,
    likes: pick(social?.likes?.count, game.points?.likes),
    shares: pick(social?.shares?.count, game.points?.shares),
    comments: pick(social?.comments?.count, undefined),
    favorites: pick(social?.favorites?.count, undefined),
  };
}

// ------------------------------------------------------------- project map

/**
 * A published KULT game package becomes the "KULT Create experience" the growth
 * workflow reasons about.
 */
export function gameToProject(
  game: KultGamePackage,
  social?: KultSocialStats | null,
  overrides?: { audience?: string[]; goals?: string[] },
): CreatorProject {
  const mechanic = toText(game.gameplay?.mechanic);
  const controls = toText(game.gameplay?.controls);
  const theme = toText(game.customization?.theme);
  const difficulty = toText(game.customization?.difficulty);
  const category = toText(game.category) || 'Game';

  // Generated games carry a full design doc; template games carry a short brief.
  const parsed = parseCreatorPrompt(game.customization?.prompt ?? game.generation?.prompt);

  // KULT game packages have no description column, so one is composed from the
  // richest real fields available. The creator's own brief leads when present.
  const description = parsed.prose
    ? parsed.prose.slice(0, 700)
    : unique([
        mechanic,
        controls ? `Controls: ${controls}.` : '',
        theme || difficulty ? `${theme} theme${difficulty ? `, ${difficulty} difficulty` : ''}.` : '',
        game.visuals?.mood ? `Visual mood: ${toText(game.visuals.mood)}.` : '',
      ], 5).join(' ');

  const eng = engagement(game, social);

  return {
    id: game.id,
    ownerAgentId: game.creatorId ?? 'unknown_creator',
    title: toText(game.title) || parsed.title || toText(game.templateName) || 'Untitled KULT experience',
    description: description || `${category} experience built in KULT Create.`,
    category,
    tags: unique([
      category,
      game.templateName,
      game.templateId,
      mechanic,
      theme,
      difficulty,
      game.tier === 'template' ? 'template-built' : 'AI-generated',
      game.generation?.mode,
      game.browserFeature?.featured ? 'browser-featured' : '',
      'KULT Create',
      // Generated games put a full mood sentence in customization.theme, so tags
      // are length-capped rather than rendering a paragraph as a chip.
    ], 10, 30),
    // DERIVED - KULT has no audience field.
    audience: overrides?.audience ?? audienceFor(category),
    // DERIVED - KULT has no goals field.
    goals: overrides?.goals ?? DEFAULT_PROJECT_GOALS,
    publishedAt: game.publish?.publishedAt ?? game.createdAt ?? new Date().toISOString(),
    thumbnailUrl: game.thumbnailUrl ?? undefined,
    playPath: game.publish?.playPath ?? undefined,
    // Only counters KULT actually stores. Session length is deliberately absent -
    // KULT records plays, not durations, and a synthesised figure would be a lie
    // sitting next to real numbers.
    stats: {
      plays: eng.plays,
      likes: eng.likes,
      shares: eng.shares,
      comments: eng.comments,
      favorites: eng.favorites,
      featured: game.browserFeature?.featured === true,
    },
    build: {
      tier: game.tier,
      templateId: game.templateId,
      generatedIn: game.createdIn,
      reliability: game.reliability,
    },
  };
}

/** Category strings are free-text in live KULT data ("Runner", "endless-arcade",
 *  "action"), so match case- and separator-insensitively before falling back. */
function audienceFor(category: string): string[] {
  const key = category.trim().toLowerCase().replace(/[-_]+/g, ' ');
  for (const [cat, audience] of Object.entries(AUDIENCE_BY_CATEGORY)) {
    const c = cat.toLowerCase();
    if (key === c || key.includes(c) || c.includes(key)) return audience;
  }
  return ['Web3-native players', 'Short-session browser-game players'];
}

// --------------------------------------------------------------- agent map

/**
 * The creator's own KULT footprint becomes the persistent Agent context. Interests
 * and capabilities are inferred from what they have actually shipped, which is a
 * far stronger personalization signal than a self-declared profile.
 */
export function creatorToAgent(
  creatorId: string,
  games: KultGamePackage[],
  opts: {
    profile?: KultProfile | null;
    activities?: KultActivity[];
    points?: KultPointSummary | null;
    social?: Record<string, KultSocialStats | null>;
    goals?: string[];
  } = {},
): Agent {
  const published = games.filter(isPublished);

  // Live KULT categories are free text with inconsistent casing ("Action"/"action",
  // "Runner"/"endless-runner"); unique() folds case so they collapse correctly.
  const categories = unique(published.map((g) => g.category), 8);
  const templates = unique(published.map((g) => g.templateName ?? g.templateId), 6);
  const mechanics = unique(published.map((g) => toText(g.gameplay?.mechanic)), 5);

  const totals = published.reduce(
    (acc, g) => {
      const e = engagement(g, opts.social?.[g.id]);
      acc.plays += e.plays;
      acc.likes += e.likes ?? 0;
      acc.shares += e.shares ?? 0;
      return acc;
    },
    { plays: 0, likes: 0, shares: 0 },
  );

  const featured = published.filter((g) => g.browserFeature?.featured).length;
  const generated = published.filter((g) => g.tier && g.tier !== 'template').length;
  const templateBuilt = published.length - generated;

  const mostPlayed = [...published].sort(
    (a, b) => engagement(b, opts.social?.[b.id]).plays - engagement(a, opts.social?.[a.id]).plays,
  )[0];

  const latest = [...published].sort(
    (a, b) => Date.parse(b.publish?.publishedAt ?? b.createdAt ?? '') -
              Date.parse(a.publish?.publishedAt ?? a.createdAt ?? ''),
  )[0];

  // The activity collection is frequently empty in live KULT data, so the real
  // build history is reconstructed from the game records themselves. Every line
  // below is a fact read from KULT, not an assumption.
  // The live activity log repeats entries (create/publish are logged more than
  // once per game), so identical lines are collapsed.
  const activityLines = unique(
    (opts.activities ?? []).map((a) => {
      const what = (a.activityType ?? 'activity').replace(/_/g, ' ');
      return a.gameTitle ? `${what}: "${a.gameTitle}"` : (a.details || what);
    }),
    4,
    90,
  );

  const derived = unique([
    published.length
      ? `Published ${published.length} experience${published.length === 1 ? '' : 's'} through KULT Create`
      : 'No published KULT Create experiences yet',
    latest?.title
      ? `Most recent: "${latest.title}"${latest.publish?.publishedAt ? ` (${latest.publish.publishedAt.slice(0, 10)})` : ''}`
      : '',
    mostPlayed?.title && totals.plays > 0
      ? `Best performing: "${mostPlayed.title}" (${engagement(mostPlayed, opts.social?.[mostPlayed.id]).plays} plays)`
      : '',
    totals.plays > 0 ? `${totals.plays.toLocaleString()} total plays across published games` : '',
    totals.likes > 0 ? `${totals.likes} likes received` : '',
    totals.shares > 0 ? `${totals.shares} shares` : '',
    featured > 0 ? `${featured} game${featured === 1 ? '' : 's'} featured in the KULT browser` : '',
    generated > 0 ? `${generated} AI-generated build${generated === 1 ? '' : 's'}` : '',
    templateBuilt > 0 ? `${templateBuilt} template-built game${templateBuilt === 1 ? '' : 's'}` : '',
    opts.points?.lifetimePoints ? `${opts.points.lifetimePoints} lifetime KULT points` : '',
  ], 8);

  return {
    id: creatorId,
    name: creatorDisplayName(creatorId, opts.profile?.username),
    role: published.length
      ? `KULT Create creator - ships ${categories.slice(0, 3).join(', ')} experiences`
      : 'KULT Create creator',
    // DERIVED from what this creator actually ships.
    interests: unique([...categories, ...templates, ...mechanics, 'AI gaming', 'creator distribution'], 9, 34),
    // DERIVED from real build history.
    capabilities: unique([
      'creation',
      published.length > 3 ? 'prolific multi-title creator' : published.length > 1 ? 'multi-title creator' : '',
      generated > 0 ? 'AI-native game generation' : '',
      templateBuilt > 0 ? 'template-based creation' : '',
      featured > 0 ? 'browser-featured creator' : '',
      totals.plays > 500 ? 'proven audience reach' : '',
      categories.length > 3 ? 'multi-genre range' : '',
    ], 6),
    activity: [...activityLines, ...derived].slice(0, 8),
    // DERIVED - KULT stores no goals.
    goals: opts.goals ?? DEFAULT_AGENT_GOALS,
    avatarSeed: creatorId,
  };
}

export const __derivationNotes = {
  real: ['title', 'category', 'templateId', 'mechanic', 'controls', 'theme', 'difficulty',
    'creator prompt', 'publishedAt', 'plays', 'likes', 'shares', 'comments', 'activity log', 'points'],
  derived: ['Agent.goals', 'Agent.interests', 'Agent.capabilities', 'Agent.role',
    'CreatorProject.audience', 'CreatorProject.goals', 'CreatorProject.description'],
};
