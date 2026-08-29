import fs from 'node:fs';
import path from 'node:path';
import { config, storeDriver } from '../config.js';
import { log } from '../lib/logger.js';
import { connectMongo, COLLECTIONS } from './mongo.js';
import { seedAgents, seedProjects } from './seed.js';
import type { StoreShape } from '../types.js';

/**
 * POC memory store, with two interchangeable drivers:
 *
 *   file  - a JSON file. Zero infrastructure; the default.
 *   mongo - the POC's own database, used whenever MONGODB_URI is set.
 *
 * Both keep the whole store hydrated in memory so `db.read()` stays synchronous
 * (19 call sites depend on that), and every mutation writes through before it
 * resolves. Spec 17 forbids reporting a save that did not happen, so a failed
 * write must reject rather than silently diverge from what the UI claims.
 */

const FILE = path.join(config.dataDir, 'store.json');
/** One document holds the whole store - simple, and atomic on a single write. */
const STATE_ID = 'poc_state_v1';

const EMPTY: StoreShape = {
  agents: [], projects: [], knowledge: [], runs: [], actions: [], outcomes: [], events: [],
};

let state: StoreShape = { ...EMPTY };
let driver: 'mongo' | 'file' = 'file';
let writeQueue: Promise<void> = Promise.resolve();

export async function initStore(): Promise<void> {
  driver = storeDriver();

  if (driver === 'mongo') {
    const db = await connectMongo();
    const doc = await db.collection(COLLECTIONS.state).findOne({ _id: STATE_ID as never });
    if (doc) {
      const { _id, ...rest } = doc as Record<string, unknown>;
      state = { ...EMPTY, ...(rest as Partial<StoreShape>) };
      log.info('store_loaded', { driver, knowledge: state.knowledge.length });
    } else {
      state = { ...EMPTY };
      log.info('store_empty_initialising', { driver });
    }
  } else {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(FILE)) {
      try {
        state = { ...EMPTY, ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<StoreShape>) };
        log.info('store_loaded', { driver, file: FILE, knowledge: state.knowledge.length });
      } catch (err) {
        log.error('store_corrupt_reseeding', { error: (err as Error).message });
        state = { ...EMPTY };
      }
    }
  }

  // Fixtures are idempotent: re-seeding never clobbers accumulated intelligence.
  if (state.agents.length === 0) state.agents = seedAgents();
  if (state.projects.length === 0) state.projects = seedProjects();
  await persist();
}

function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    if (driver === 'mongo') {
      const db = await connectMongo();
      await db.collection(COLLECTIONS.state).replaceOne(
        { _id: STATE_ID as never },
        { _id: STATE_ID as never, ...state },
        { upsert: true },
      );
      return;
    }
    // Atomic on the file driver: a half-written file would look like data loss.
    const tmp = `${FILE}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tmp, FILE);
  }).catch((err) => {
    log.error('store_write_failed', { driver, error: (err as Error).message });
    throw err;
  });
  return writeQueue;
}

export const db = {
  read(): Readonly<StoreShape> {
    return state;
  },

  /** Mutations await the write, so a failed persist propagates to the caller. */
  async mutate<T>(fn: (s: StoreShape) => T): Promise<T> {
    const result = fn(state);
    await persist();
    return result;
  },

  /** Wipes accumulated intelligence but keeps fixtures - for a clean showcase run. */
  async resetIntelligence(): Promise<void> {
    await this.mutate((s) => {
      s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.events = [];
    });
    log.info('store_intelligence_reset', { driver });
  },

  driver(): 'mongo' | 'file' {
    return driver;
  },
};

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
