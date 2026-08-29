import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { connectMongo, COLLECTIONS, mongoConfigured } from '../db/mongo.js';
import type { KultGamePackage } from './kultTypes.js';

/**
 * Reads the KULT games snapshot from the POC's OWN database.
 *
 * This is what makes the POC standalone: once `npm run seed:kult` has copied real
 * published games into the poc database, nothing needs the KULT backend running,
 * no localhost port, and no production database credential.
 *
 * Read-only by construction - the POC never writes to this collection at runtime.
 */

let cache: { games: KultGamePackage[]; expiresAt: number } | null = null;
let inFlight: Promise<KultGamePackage[]> | null = null;
const TTL_MS = 5 * 60_000;

export function kultMongoConfigured(): boolean {
  return mongoConfigured();
}

async function load(): Promise<KultGamePackage[]> {
  const db = await connectMongo();
  const games = await db
    .collection<KultGamePackage>(COLLECTIONS.games)
    .find({}, { projection: { _id: 0 } })
    .toArray();

  log.info('kult_games_loaded_from_poc_db', { db: config.mongo.dbName, games: games.length });
  return games;
}

/** Whole snapshot, cached. Small enough that paging would be pointless. */
export async function getSnapshotGames(): Promise<KultGamePackage[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.games;
  if (inFlight) return inFlight;

  inFlight = load()
    .then((games) => {
      // Only cache a non-empty result, so a transient failure is not sticky.
      if (games.length > 0) cache = { games, expiresAt: Date.now() + TTL_MS };
      return games;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

export async function getSnapshotGame(gameId: string): Promise<KultGamePackage | null> {
  return (await getSnapshotGames()).find((g) => g.id === gameId) ?? null;
}

export async function snapshotCount(): Promise<number> {
  try {
    return (await getSnapshotGames()).length;
  } catch {
    return 0;
  }
}
