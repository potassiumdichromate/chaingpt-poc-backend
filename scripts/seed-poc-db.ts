/**
 * Copies real published KULT games into the POC's OWN database.
 *
 *   npm run seed:kult
 *
 * Run this once. Afterwards the POC is standalone: no KULT backend, no
 * localhost:3001, no production database credential, no network at demo time.
 *
 * Source of truth is the KULT HTTP API, deliberately - reading through the
 * public published-games endpoint avoids opening a connection to the production
 * database and cannot trigger the 0G write side effects some KULT read paths have.
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { connectMongo, closeMongo, COLLECTIONS } from '../src/db/mongo.js';
import type { KultGamePackage } from '../src/kult/kultTypes.js';

const ok = (s: string) => console.log(`  \x1b[32m+\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31mx\x1b[0m ${s}`);
const info = (s: string) => console.log(`  \x1b[36m.\x1b[0m ${s}`);

const SOURCE = process.env.KULT_API_BASE || 'http://localhost:3001/api';
const PAGE = 100;
const MAX_PAGES = 10;

async function fetchPage(offset: number): Promise<KultGamePackage[]> {
  const url = new URL('games/list', SOURCE.endsWith('/') ? SOURCE : `${SOURCE}/`);
  url.searchParams.set('limit', String(PAGE));
  url.searchParams.set('offset', String(offset));

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`KULT API ${res.status} at offset ${offset}`);
  const body = (await res.json()) as { games?: KultGamePackage[] };
  return body.games ?? [];
}

async function main() {
  console.log('\nSeeding the POC database with real KULT games');
  console.log('='.repeat(64));
  info(`source: ${SOURCE}`);
  info(`target: ${config.mongo.dbName}.${COLLECTIONS.games}`);

  if (!config.mongo.uri) {
    bad('MONGODB_URI is not set in backend/.env');
    process.exit(1);
  }

  // --- pull ---
  const collected = new Map<string, KultGamePackage>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let batch: KultGamePackage[];
    try {
      batch = await fetchPage(page * PAGE);
    } catch (err) {
      bad(`fetch failed: ${(err as Error).message}`);
      if (collected.size === 0) {
        info('Is the KULT backend running?  cd prompt/backend && npm run dev');
        process.exit(1);
      }
      break;
    }
    for (const g of batch) if (g?.id) collected.set(g.id, g);
    if (batch.length < PAGE) break;
  }

  const games = [...collected.values()];
  if (games.length === 0) {
    bad('KULT returned no games - nothing to seed');
    process.exit(1);
  }
  ok(`fetched ${games.length} published game(s)`);

  // --- write ---
  const db = await connectMongo();          // refuses a KULT production db name
  const col = db.collection<KultGamePackage>(COLLECTIONS.games);

  // Replace wholesale: the snapshot should mirror the source, not accumulate
  // stale rows from an earlier run.
  await col.deleteMany({});
  await col.insertMany(games as never[], { ordered: false });
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ creatorId: 1 });

  ok(`wrote ${await col.countDocuments({})} game(s) to ${config.mongo.dbName}.${COLLECTIONS.games}`);

  // --- summary ---
  const creators = new Map<string, number>();
  for (const g of games) {
    if (g.creatorId) creators.set(g.creatorId, (creators.get(g.creatorId) ?? 0) + 1);
  }
  const top = [...creators.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  console.log('\n  Top creators in the snapshot:');
  for (const [id, n] of top) console.log(`    ${String(n).padStart(3)} games  ${id}`);

  const withThumbs = games.filter((g) => g.thumbnailUrl).length;
  info(`${withThumbs}/${games.length} have thumbnails`);

  console.log(`\n${'='.repeat(64)}`);
  console.log('\x1b[32mDone. The POC no longer needs the KULT backend.\x1b[0m');
  console.log('  Unset KULT_API_BASE in backend/.env to prove it, then: npm run verify\n');

  await closeMongo();
}

main().catch(async (err) => {
  console.error('\nseed failed:', (err as Error).message, '\n');
  await closeMongo().catch(() => {});
  process.exit(1);
});
