import type { Agent, CreatorProject } from '../types.js';
import type { KultGamePackage } from '../kult/kultTypes.js';
import { creatorToAgent, gameToProject } from '../kult/mappers.js';
import { KULT_ACTIVITY } from '../kult/kultTypes.js';

/**
 * POC fixtures.
 *
 * These are real KULT game *packages*, not an invented POC shape: field names,
 * nesting and values follow services/gameFactoryService.js createGamePackage()
 * and the "racing" entry in data/templates.js, including the themePresets.neon
 * title convention ("Neon " + template name).
 *
 * They are run through the same mappers as live KULT data, so the fixture path
 * and the KULT_API_BASE path exercise identical code. Point KULT_API_BASE at the
 * Creator Studio API and real records flow through unchanged.
 */

const CREATOR_ID = 'agent_kult_nova';

const FIXTURE_GAMES: KultGamePackage[] = [
  {
    id: 'proj_neon_drift',
    tier: 'template',
    title: 'Neon 2D Racing',
    templateId: 'racing',
    templateName: '2D Racing',
    category: 'Racing',
    creatorId: CREATOR_ID,
    views: 2412,
    createdAt: '2026-07-16T11:20:00.000Z',
    thumbnailUrl: null,
    customization: {
      prompt: 'A fast neon night race where the track rebuilds itself every lap and the AI opponent learns my racing line.',
      theme: 'Neon',
      difficulty: 'normal',
      level: 'medium',
      extra: 'leaderboard',
    },
    gameplay: {
      mechanic: 'Drift through checkpoints and beat lap targets.',
      controls: 'Arrow keys, WASD, touch steering',
      tuning: { laps: 3, grip: 0.8, traffic: 5, target: 82 },
      states: ['BOOT', 'COUNTDOWN', 'RACE', 'FINISH'],
      scoring: 'lap time and checkpoint accuracy',
      collision: ['car vs wall', 'car vs checkpoint', 'car vs traffic'],
    },
    visuals: {
      mood: 'bright arcade glow',
      colors: ['#35e8ff', '#ff3df2', '#ffd166'],
      assets: 'Cars, track lanes, checkpoints, tire trails',
    },
    build: { runtime: 'browser', renderer: 'canvas', targetFps: 60, publishReady: true },
    publish: {
      published: true,
      status: 'published',
      publishedAt: '2026-07-18T09:00:00.000Z',
      playPath: '/play?gameId=proj_neon_drift',
    },
    browserFeature: { featured: true, featuredAt: '2026-07-22T12:00:00.000Z' },
  },
  {
    id: 'proj_pulse_blocks',
    tier: 'pure-agent',
    title: 'Pulse Blocks',
    templateId: 'pure-agent',
    templateName: 'Match-3 Puzzle',
    category: 'Puzzle',
    creatorId: CREATOR_ID,
    views: 731,
    createdAt: '2026-08-02T15:05:00.000Z',
    customization: {
      prompt: 'A rhythm-driven match-3 where cascades resolve on the beat.',
      theme: 'Retro',
      difficulty: 'hard',
      level: 'heavy',
      extra: 'powerups',
    },
    gameplay: {
      mechanic: 'Swap adjacent gems and trigger chain reactions.',
      controls: 'Mouse drag, touch swipe',
      states: ['BOOT', 'PLAY', 'RESOLVE', 'GAME_OVER'],
      scoring: 'cascade depth and combo streaks',
    },
    visuals: { mood: 'pixel cabinet energy', colors: ['#ff8bd6', '#ffd166', '#67ffb4'] },
    build: { runtime: 'browser', renderer: 'canvas', targetFps: 60, publishReady: true },
    publish: {
      published: true,
      status: 'published',
      publishedAt: '2026-08-04T10:30:00.000Z',
      playPath: '/play?gameId=proj_pulse_blocks',
    },
    refinement: { generatedCode: '<<generated>>' },
  },
];

const FIXTURE_SOCIAL = {
  proj_neon_drift: {
    likes: { count: 184 }, comments: { count: 27 }, favorites: { count: 63 },
    shares: { count: 41 }, views: { count: 2412 },
  },
  proj_pulse_blocks: {
    likes: { count: 52 }, comments: { count: 8 }, favorites: { count: 19 },
    shares: { count: 11 }, views: { count: 731 },
  },
};

const FIXTURE_ACTIVITIES = [
  { userId: CREATOR_ID, gameId: 'proj_pulse_blocks', gameTitle: 'Pulse Blocks', activityType: KULT_ACTIVITY.GAME_PUBLISHED, details: 'Published game "Pulse Blocks"', timestamp: '2026-08-04T10:30:00.000Z' },
  { userId: CREATOR_ID, gameId: 'proj_pulse_blocks', gameTitle: 'Pulse Blocks', activityType: KULT_ACTIVITY.GAME_GENERATED, details: 'Generated with pure-agent strategy', timestamp: '2026-08-02T15:05:00.000Z' },
  { userId: CREATOR_ID, gameId: 'proj_neon_drift', gameTitle: 'Neon 2D Racing', activityType: KULT_ACTIVITY.GAME_EDITED, details: 'Refined handling and traffic density', timestamp: '2026-07-27T18:40:00.000Z' },
  { userId: CREATOR_ID, gameId: 'proj_neon_drift', gameTitle: 'Neon 2D Racing', activityType: KULT_ACTIVITY.GAME_PUBLISHED, details: 'Published game "Neon 2D Racing"', timestamp: '2026-07-18T09:00:00.000Z' },
  { userId: CREATOR_ID, gameId: null, gameTitle: null, activityType: KULT_ACTIVITY.POINTS_AWARDED, details: 'First game publish bonus', timestamp: '2026-07-18T09:00:05.000Z' },
];

/** Built through the live mappers so fixtures and real KULT data share one code path. */
export function seedAgents(): Agent[] {
  const nova = creatorToAgent(CREATOR_ID, FIXTURE_GAMES, {
    profile: { userId: CREATOR_ID, username: 'Nova' },
    activities: FIXTURE_ACTIVITIES,
    points: { lifetimePoints: 4820 },
    social: FIXTURE_SOCIAL,
  });

  const atlas: Agent = {
    id: 'agent_kult_atlas',
    name: 'Atlas',
    role: 'Strategy Agent - tracks ecosystem programmes and partnership surfaces',
    interests: ['ecosystem programmes', 'grants', 'infrastructure', 'agent payments'],
    capabilities: ['research', 'analysis', 'partner mapping'],
    activity: ['Maintains a partner pipeline across four ecosystems', 'Advises two KULT creator teams'],
    goals: ['Map credible ecosystem programmes', 'Prioritise partners by conversion likelihood'],
    avatarSeed: 'atlas',
  };

  return [nova, atlas];
}

export function seedProjects(): CreatorProject[] {
  return FIXTURE_GAMES.map((game) =>
    gameToProject(game, FIXTURE_SOCIAL[game.id as keyof typeof FIXTURE_SOCIAL] ?? null),
  );
}
