import { describe, expect, it } from 'vitest';
import { db, diffCollection, initStore } from '../db/store.js';

/**
 * The per-record persistence rules. `diffCollection` decides exactly which
 * documents a Mongo write touches, so it is tested directly; the file driver
 * exercises the same public API end to end.
 */

const snap = (rows: { id: string }[]) => new Map(rows.map((r) => [r.id, JSON.stringify(r)]));

describe('diffCollection', () => {
  it('writes nothing when nothing changed', () => {
    const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    expect(diffCollection(snap(rows), rows)).toEqual({ upserts: [], deletes: [], cleared: false });
  });

  it('upserts only new and changed records', () => {
    const before = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    const after = [{ id: 'a', v: 1 }, { id: 'b', v: 3 }, { id: 'c', v: 4 }];
    const d = diffCollection(snap(before), after);
    expect(d.upserts.map((r) => r.id)).toEqual(['b', 'c']);
    expect(d.deletes).toEqual([]);
  });

  it('deletes records that disappeared', () => {
    const d = diffCollection(snap([{ id: 'a' }, { id: 'b' }]), [{ id: 'b' }]);
    expect(d.deletes).toEqual(['a']);
    expect(d.cleared).toBe(false);
  });

  it('marks a fully emptied collection as cleared so it becomes one deleteMany', () => {
    expect(diffCollection(snap([{ id: 'a' }]), []).cleared).toBe(true);
    expect(diffCollection(new Map(), []).cleared).toBe(false);
  });
});

describe('store persistence (file driver)', () => {
  it('survives a reload: appended records are written through', async () => {
    await initStore();
    await db.mutate((s) => { s.events = []; });
    await db.append('events', { id: 'evt_persist', name: 'knowledge_saved', timestamp: new Date().toISOString() });

    await initStore();
    expect(db.read().events.map((e) => e.id)).toContain('evt_persist');
  });

  it('reset clears intelligence, including provider-call accounting, but keeps fixtures', async () => {
    await initStore();
    await db.append('providerCalls', {
      id: 'call_1', provider: 'demo', kind: 'news', label: 'x', ok: true, latencyMs: 1, estimatedCredits: 0, at: new Date().toISOString(),
    });
    await db.resetIntelligence();
    expect(db.read().providerCalls).toEqual([]);
    expect(db.read().agents.length).toBeGreaterThan(0);
  });
});
