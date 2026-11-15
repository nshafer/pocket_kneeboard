import { describe, expect, it } from 'vitest';
import { WEEKLY_CAP, newLedger, recordLanding, settle, tallyAll, unseenLandings, weekStart } from '../src/lib/ledger';
import type { LandingEvent, Snapshot } from '../src/lib/types';

const at = (iso: string) => Date.parse(iso);

describe('weekStart', () => {
  it('is Monday 00:00 UTC', () => {
    expect(weekStart(at('2026-11-15T23:59:00Z'))).toBe(at('2026-11-09T00:00:00Z')); // Sunday
    expect(weekStart(at('2026-11-16T00:00:00Z'))).toBe(at('2026-11-16T00:00:00Z')); // Monday
    expect(weekStart(at('2026-11-16T00:00:00-07:00'))).toBe(at('2026-11-16T00:00:00Z'));
    expect(weekStart(at('2026-11-15T23:59:59.999Z'))).toBe(at('2026-11-09T00:00:00Z'));
    expect(weekStart(at('2027-01-01T12:00:00Z'))).toBe(at('2026-12-28T00:00:00Z'));
  });
});

const snap: Snapshot = { t: 0, schema: 27, pid: 'p1', at: null, active: null, visited: { EIDW: { n: 2 } } };

const landing = (over: Partial<LandingEvent> & { pay?: number; t: number; id?: string }): LandingEvent => ({
  pid: 'p1',
  code: 'EIDW',
  job: { id: over.id ?? `J${over.t}`, to: over.code ?? 'EIDW', pay: 999 },
  result: { line0: ['Cargo to Dublin', `$${(over.pay ?? 10_000).toLocaleString('en-US')}`] },
  ...over,
});

describe('settle', () => {
  it('uses the report’s first line as base pay', () => {
    expect(settle(landing({ t: 1, pay: 27_760 }))).toMatchObject({ pay: 27_760, counted: true, src: 'report' });
  });
  it('prefers the server’s value', () => {
    const e = settle(landing({ t: 1, result: { value: 5_000, line0: ['x', '$7,000'] } }));
    expect(e).toMatchObject({ pay: 5_000, src: 'value' });
  });
  it('falls back to the board pay', () => {
    expect(settle(landing({ t: 1, result: {} }))).toMatchObject({ pay: 999, src: 'board' });
  });
  it('ignores landings that deliver nothing', () => {
    expect(settle(landing({ t: 1, job: undefined }))).toBeNull();
    expect(settle(landing({ t: 1, job: { id: 'j', to: 'KLAS' } }))).toBeNull();
  });
  it('does not count helipads and seaplane bases', () => {
    expect(settle(landing({ t: 1, airport: { pad: 'hospital' } }))).toMatchObject({ counted: false, facility: 'helipad' });
    expect(settle(landing({ t: 1, airport: { seaOnly: true } }))).toMatchObject({ counted: false, facility: 'seaplane' });
  });
  it('counts a pad job that returns to an airport, at that airport', () => {
    const e = settle(landing({ t: 1, pay: 27_760, job: { id: 'j', to: 'EIDW', pad: 'ship' } }));
    expect(e).toMatchObject({ counted: true, pay: 27_760 });
    expect(e?.facility).toBeUndefined();
  });
});

describe('tally', () => {
  const now = at('2026-11-15T12:00:00Z');
  const thisWeek = at('2026-11-10T12:00:00Z');
  const lastWeek = at('2026-11-03T12:00:00Z');
  const older = at('2026-10-27T12:00:00Z');

  it('adds this week and half of last week, each capped', () => {
    let l = newLedger(snap, older);
    const flights: [number, number][] = [
      [older, 100_000],
      [lastWeek, 300_000],
      [thisWeek, 120_000],
      [thisWeek + 1, 40_000],
    ];
    for (const [t, pay] of flights) l = recordLanding(l, landing({ t, pay }), now);
    const t = tallyAll(l, now).get('EIDW')!;
    expect(t.thisWeek).toBe(160_000);
    expect(t.lastWeek).toBe(WEEKLY_CAP);
    expect(t.lastRaw).toBe(300_000);
    expect(t.influence).toBe(160_000 + 125_000);
    expect(t.room).toBe(90_000);
  });

  it('keeps helipad pay out of the influence', () => {
    let l = newLedger(snap, now);
    l = recordLanding(l, landing({ t: thisWeek, code: 'H1', id: 'A', pay: 9_000, airport: { pad: 'hospital' } }), now);
    const t = tallyAll(l, now).get('H1')!;
    expect(t).toMatchObject({ thisWeek: 0, influence: 0, noCredit: 9_000, facility: 'helipad' });
  });

  it('skips repeats of the same delivery', () => {
    let l = newLedger(snap, now);
    l = recordLanding(l, landing({ t: thisWeek, id: 'A', pay: 1_000 }), now);
    l = recordLanding(l, landing({ t: thisWeek + 5, id: 'A', pay: 1_000 }), now);
    expect(l.entries).toHaveLength(1);
  });

  it('finds landings made on another device', () => {
    let l = newLedger(snap, now);
    l = recordLanding(l, landing({ t: thisWeek }), now);
    const later: Snapshot = { ...snap, visited: { EIDW: { n: 5 }, KLAS: { n: 1 } } };
    expect(unseenLandings(l, later)).toEqual({ EIDW: 2, KLAS: 1 });
  });
});
