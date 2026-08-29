import { db } from '../db/store.js';
import { log } from '../lib/logger.js';
import type { Agent, CreatorProject } from '../types.js';
import type { KultSocialStats } from './kultTypes.js';
import {
  fetchActivities, fetchAllGames, fetchGame, fetchGames, fetchPoints, fetchProfile,
  fetchSocialStats, fetchTopCreators, kultConfigured,
} from './kultClient.js';
import { creatorToAgent, gameToProject } from './mappers.js';
import { getSnapshotGame, getSnapshotGames, kultMongoConfigured } from './kultMongo.js';

/**
 * KULT context source, in priority order:
 *
 *   1. poc database  - a snapshot of real KULT games in the POC's OWN database.
 *                      Standalone: no KULT backend, no localhost, no prod creds.
 *   2. KULT API      - live Creator Studio, when KULT_API_BASE is set.
 *   3. fixtures      - bundled real game packages, so it always runs.
 *
 * All three produce identical shapes through the same mappers, so nothing
 * downstream is aware of which one served the request.
 */

/** True when a seeded snapshot is actually available (not merely configured). */
async function snapshotReady(): Promise<boolean> {
  if (!kultMongoConfigured()) return false;
  try {
    return (await getSnapshotGames()).length > 0;
  } catch (err) {
    log.warn('poc_db_unreadable_falling_back', { error: (err as Error).message });
    return false;
  }
}

export async function getProject(projectId: string): Promise<CreatorProject | null> {
  if (await snapshotReady()) {
    const game = await getSnapshotGame(projectId);
    if (game) return gameToProject(game);
  }
  if (kultConfigured()) {
    const game = await fetchGame(projectId);
    if (game) {
      const social = await fetchSocialStats(projectId);
      log.info('kult_project_loaded_live', { projectId, title: game.title });
      return gameToProject(game, social);
    }
    log.warn('kult_project_miss_falling_back', { projectId });
  }
  return db.read().projects.find((p) => p.id === projectId) ?? null;
}

export async function getAgent(agentId: string): Promise<Agent | null> {
  if (await snapshotReady()) {
    const games = (await getSnapshotGames()).filter((g) => g.creatorId === agentId);
    if (games.length > 0) return creatorToAgent(agentId, games);
  }
  if (kultConfigured()) {
    const games = await fetchGames({ creatorId: agentId, limit: 50 });
    if (games.length > 0) {
      const [profile, activities, points] = await Promise.all([
        fetchProfile(agentId),
        fetchActivities(agentId, 25),
        fetchPoints(agentId),
      ]);

      // Social stats are per-game; fetch only for published titles.
      const published = games.filter((g) => g.publish?.published === true).slice(0, 12);
      const social: Record<string, KultSocialStats | null> = {};
      await Promise.all(published.map(async (g) => { social[g.id] = await fetchSocialStats(g.id); }));

      log.info('kult_agent_loaded_live', { agentId, games: games.length, published: published.length });
      return creatorToAgent(agentId, games, { profile, activities, points, social });
    }
    log.warn('kult_agent_miss_falling_back', { agentId });
  }
  return db.read().agents.find((a) => a.id === agentId) ?? null;
}

/**
 * Live KULT creators ranked by published portfolio, so the POC picker offers real
 * Agents. Social stats are skipped here - listing must stay fast.
 */
export async function listAgents(): Promise<Agent[]> {
  if (await snapshotReady()) {
    const games = await getSnapshotGames();
    const byCreator = new Map<string, typeof games>();
    for (const g of games) {
      if (!g.creatorId) continue;
      byCreator.set(g.creatorId, [...(byCreator.get(g.creatorId) ?? []), g]);
    }
    const ranked = [...byCreator.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8);
    if (ranked.length > 0) return ranked.map(([id, gs]) => creatorToAgent(id, gs));
  }
  if (kultConfigured()) {
    const [top, catalog] = await Promise.all([fetchTopCreators(8), fetchAllGames(600)]);
    if (top.length > 0) {
      return top.map((c) =>
        creatorToAgent(c.creatorId, catalog.filter((g) => g.creatorId === c.creatorId)),
      );
    }
  }
  return db.read().agents;
}

/** Published KULT experiences owned by one creator. */
export async function getProjectsForAgent(agentId: string): Promise<CreatorProject[]> {
  if (await snapshotReady()) {
    const owned = (await getSnapshotGames())
      .filter((g) => g.creatorId === agentId && g.publish?.published === true);
    if (owned.length > 0) return owned.map((g) => gameToProject(g));
  }
  if (kultConfigured()) {
    const games = await fetchGames({ creatorId: agentId });
    const published = games.filter((g) => g.publish?.published === true);
    if (published.length > 0) return published.map((g) => gameToProject(g));
  }
  return db.read().projects.filter((p) => p.ownerAgentId === agentId);
}

export async function listProjects(): Promise<CreatorProject[]> {
  if (await snapshotReady()) {
    const games = await getSnapshotGames();
    if (games.length > 0) return games.slice(0, 60).map((g) => gameToProject(g));
  }
  if (kultConfigured()) {
    const games = await fetchAllGames(60);
    if (games.length > 0) return games.map((g) => gameToProject(g));
  }
  return db.read().projects;
}

export async function contextSource(): Promise<'poc_db' | 'kult_api' | 'poc_fixtures'> {
  if (await snapshotReady()) return 'poc_db';
  return kultConfigured() ? 'kult_api' : 'poc_fixtures';
}
