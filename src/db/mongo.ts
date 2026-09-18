import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

/**
 * Mongo connection for the POC's OWN database.
 *
 * This must never point at the KULT production database. The POC writes saved
 * knowledge, actions, outcomes and analytics, and exposes a reset endpoint that
 * clears them - pointed at production, that is a data-loss bug waiting to happen.
 * `assertNotProductionDb()` below refuses to start against a known KULT database
 * name rather than trusting the operator to have read this comment.
 */

const FORBIDDEN_DB_NAMES = ['prompt_creator_studio', 'creator_studio', 'kult'];

let client: MongoClient | null = null;
let database: Db | null = null;

export function mongoConfigured(): boolean {
  return Boolean(config.mongo.uri);
}

function assertNotProductionDb(name: string): void {
  if (FORBIDDEN_DB_NAMES.includes(name.trim().toLowerCase())) {
    throw new Error(
      `Refusing to use database "${name}": that is a KULT production database. `
      + 'Set MONGODB_DB_NAME to a dedicated POC database (e.g. "poc").',
    );
  }
}

export async function connectMongo(): Promise<Db> {
  if (database) return database;
  if (!config.mongo.uri) throw new Error('MONGODB_URI is not configured');

  assertNotProductionDb(config.mongo.dbName);

  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  database = client.db(config.mongo.dbName);

  log.info('mongo_connected', { db: config.mongo.dbName });
  return database;
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
  database = null;
}

/** Collection names inside the POC database. */
export const COLLECTIONS = {
  /** Snapshot of real KULT published games - read-only for the POC. */
  games: 'kult_games',
  /** Legacy single-document store. Read once for migration, never written. */
  state: 'poc_state',
  /** Store bookkeeping, e.g. the per-record migration marker. */
  meta: 'poc_meta',
} as const;

/** One collection per record type; each record is its own document keyed by id. */
export const STORE_COLLECTIONS = {
  agents: 'poc_agents',
  projects: 'poc_projects',
  knowledge: 'poc_knowledge',
  runs: 'poc_runs',
  actions: 'poc_actions',
  outcomes: 'poc_outcomes',
  events: 'poc_events',
  providerCalls: 'poc_provider_calls',
} as const;
