import fs from 'node:fs';
import path from 'node:path';
import type { AnyBulkWriteOperation, Db } from 'mongodb';
import { config, storeDriver } from '../config.js';
import { log } from '../lib/logger.js';
import { connectMongo, COLLECTIONS, STORE_COLLECTIONS } from './mongo.js';
import { seedAgents, seedProjects } from './seed.js';
import type { StoreShape } from '../types.js';

/**
 * POC memory store, with two interchangeable drivers:
 *
 *   file  - a JSON file. Zero infrastructure; the default.
 *   mongo - the POC's own database, used whenever MONGODB_URI is set.
 *
 * Both keep the whole store hydrated in memory so `db.read()` stays synchronous,
 * and every mutation writes through before it resolves. Spec 17 forbids reporting
 * a save that did not happen, so a failed write must reject rather than silently
 * diverge from what the UI claims.
 *
 * On Mongo every record is its own document in a per-type collection (audit A-7,
 * A-8). The previous layout kept the whole store in ONE document and rewrote it on
 * every event: write cost grew with history, the 16 MB BSON cap was a hard ceiling,
 * and two writers silently overwrote each other. Now a write touches only the
 * records that changed. Reads are still served from memory, so this remains a
 * single-instance service - see docs/operations.md.
 */

export type StoreKey = keyof StoreShape;

const KEYS: StoreKey[] = ['agents', 'projects', 'knowledge', 'runs', 'actions', 'outcomes', 'events', 'providerCalls'];

/** Keys `resetIntelligence()` clears. Agents and projects are fixtures, not intelligence. */
const INTELLIGENCE_KEYS: StoreKey[] = ['knowledge', 'runs', 'actions', 'outcomes', 'events', 'providerCalls'];

/** Mongo returns natural order, which is not guaranteed; restore insertion order on load. */
const TIME_FIELD: Partial<Record<StoreKey, string>> = {
  knowledge: 'createdAt', runs: 'createdAt', actions: 'createdAt', outcomes: 'createdAt',
  events: 'timestamp', providerCalls: 'at',
};

const FILE = path.join(config.dataDir, 'store.json');
/** The legacy single-document layout, read once for migration and never written again. */
const LEGACY_STATE_ID = 'poc_state_v1';
const MIGRATION_MARKER = 'store_v2_per_record';

const EMPTY = (): StoreShape => ({
  agents: [], projects: [], knowledge: [], runs: [], actions: [], outcomes: [], events: [], providerCalls: [],
});

let state: StoreShape = EMPTY();
let driver: 'mongo' | 'file' = 'file';
let writeQueue: Promise<void> = Promise.resolve();

/** Last persisted JSON per record id, per key - what a mutation is diffed against. */
let persisted = new Map<StoreKey, Map<string, string>>();

type Row = { id: string } & Record<string, unknown>;

function rows(key: StoreKey): Row[] {
  return state[key] as unknown as Row[];
}

export interface CollectionDiff {
  upserts: Row[];
  deletes: string[];
  /** Every previously persisted record is gone - cheaper as one deleteMany. */
  cleared: boolean;
}

/**
 * Compares a collection against its last persisted snapshot. Pure, so the one
 * piece of logic that decides what reaches Mongo is unit-testable without Mongo.
 */
export function diffCollection(snapshot: Map<string, string>, current: Row[]): CollectionDiff {
  const seen = new Set<string>();
  const upserts: Row[] = [];
  for (const r of current) {
    seen.add(r.id);
    if (snapshot.get(r.id) !== JSON.stringify(r)) upserts.push(r);
  }
  const deletes = [...snapshot.keys()].filter((id) => !seen.has(id));
  return { upserts, deletes, cleared: current.length === 0 && snapshot.size > 0 };
}

function snapshotOf(records: Row[]): Map<string, string> {
  return new Map(records.map((r) => [r.id, JSON.stringify(r)]));
}

function sortByTime(key: StoreKey, records: Row[]): Row[] {
  const field = TIME_FIELD[key];
  if (!field) return records;
  return records.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')));
}

// ------------------------------------------------------------------ loading

async function loadMongo(): Promise<void> {
  const mdb = await connectMongo();
  await migrateLegacyDocument(mdb);

  const loaded = EMPTY();
  for (const key of KEYS) {
    const docs = await mdb.collection(STORE_COLLECTIONS[key]).find({}).toArray();
    const records = docs.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }) as Row);
    (loaded as unknown as Record<StoreKey, Row[]>)[key] = sortByTime(key, records);
  }
  state = loaded;
  log.info('store_loaded', { driver: 'mongo', knowledge: state.knowledge.length, runs: state.runs.length });
}

/**
 * One-time copy of the legacy single document into per-record collections.
 * Non-destructive: the legacy document is left exactly as it was, so rolling the
 * code back still finds its data. Idempotent: upserts by id, guarded by a marker.
 */
async function migrateLegacyDocument(mdb: Db): Promise<void> {
  const meta = mdb.collection<{ _id: string }>(COLLECTIONS.meta);
  if (await meta.findOne({ _id: MIGRATION_MARKER })) return;

  const legacy = await mdb.collection<{ _id: string }>(COLLECTIONS.state).findOne({ _id: LEGACY_STATE_ID });
  const counts: Record<string, number> = {};
  if (legacy) {
    for (const key of KEYS) {
      const records = ((legacy as Record<string, unknown>)[key] as Row[] | undefined) ?? [];
      counts[key] = records.length;
      if (records.length === 0) continue;
      await mdb.collection<{ _id: string }>(STORE_COLLECTIONS[key]).bulkWrite(
        records.map((r) => ({
          replaceOne: { filter: { _id: r.id }, replacement: { _id: r.id, ...r }, upsert: true },
        })),
        { ordered: false },
      );
    }
  }
  await meta.insertOne({ _id: MIGRATION_MARKER, migratedAt: new Date().toISOString(), counts } as { _id: string });
  log.info('store_migrated_to_per_record', { legacyFound: Boolean(legacy), counts });
}

function loadFile(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(FILE)) return;
  try {
    state = { ...EMPTY(), ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<StoreShape>) };
    log.info('store_loaded', { driver: 'file', file: FILE, knowledge: state.knowledge.length });
  } catch (err) {
    log.error('store_corrupt_reseeding', { error: (err as Error).message });
    state = EMPTY();
  }
}

export async function initStore(): Promise<void> {
  driver = storeDriver();
  state = EMPTY();

  if (driver === 'mongo') await loadMongo();
  else loadFile();

  persisted = new Map(KEYS.map((k) => [k, snapshotOf(rows(k))]));

  // Fixtures are idempotent: re-seeding never clobbers accumulated intelligence.
  if (state.agents.length === 0) state.agents = seedAgents();
  if (state.projects.length === 0) state.projects = seedProjects();
  await persist();
}

// ------------------------------------------------------------------ writing

async function writeMongoDiffs(): Promise<void> {
  const mdb = await connectMongo();
  for (const key of KEYS) {
    const snapshot = persisted.get(key) ?? new Map<string, string>();
    const diff = diffCollection(snapshot, rows(key));
    const coll = mdb.collection<{ _id: string }>(STORE_COLLECTIONS[key]);

    if (diff.cleared) {
      await coll.deleteMany({});
    } else if (diff.upserts.length || diff.deletes.length) {
      const ops: AnyBulkWriteOperation<{ _id: string }>[] = [
        ...diff.upserts.map((r) => ({
          replaceOne: { filter: { _id: r.id }, replacement: { _id: r.id, ...r }, upsert: true },
        })),
        ...diff.deletes.map((id) => ({ deleteOne: { filter: { _id: id } } })),
      ];
      await coll.bulkWrite(ops, { ordered: true });
    } else {
      continue;
    }
    persisted.set(key, snapshotOf(rows(key)));
  }
}

async function writeFile(): Promise<void> {
  // Atomic on the file driver: a half-written file would look like data loss.
  const tmp = `${FILE}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.promises.rename(tmp, FILE);
}

function enqueue(write: () => Promise<void>): Promise<void> {
  const attempt = writeQueue.then(write).catch((err) => {
    log.error('store_write_failed', { driver, error: (err as Error).message });
    throw err;
  });

  // The queue orders writes, so the next write chains off this one - but it must
  // chain off a SETTLED promise, not a rejected one. Chaining off `attempt`
  // directly meant one transient failure rejected every later write without it
  // ever being attempted, while callers kept getting 201s. Swallow the rejection
  // for the queue only; `attempt` still carries the real failure to this caller
  // (spec 15.4: never claim a save that did not happen).
  writeQueue = attempt.catch(() => {});
  return attempt;
}

function persist(): Promise<void> {
  return enqueue(() => (driver === 'mongo' ? writeMongoDiffs() : writeFile()));
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

  /**
   * Appends one record. The hot path - events, runs, knowledge, actions, outcomes -
   * so on Mongo it is a single insert rather than a diff of every collection.
   */
  async append<K extends StoreKey>(key: K, record: StoreShape[K][number]): Promise<void> {
    const row = record as unknown as Row;
    (state[key] as unknown as Row[]).push(row);
    await enqueue(async () => {
      if (driver === 'mongo') {
        const mdb = await connectMongo();
        await mdb.collection<{ _id: string }>(STORE_COLLECTIONS[key]).insertOne({ _id: row.id, ...row });
        persisted.get(key)?.set(row.id, JSON.stringify(row));
      } else {
        await writeFile();
      }
    });
  },

  /** Wipes accumulated intelligence but keeps fixtures - for a clean showcase run. */
  async resetIntelligence(): Promise<void> {
    await this.mutate((s) => {
      for (const key of INTELLIGENCE_KEYS) (s[key] as unknown[]) = [];
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
