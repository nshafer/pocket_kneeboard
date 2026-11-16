import { describe, expect, it } from 'vitest';
import { claim, newLedger, recordLanding, tallyAll, unclaim } from '../src/lib/ledger';
import { addTotal, unlogged } from '../src/lib/totals';
import type { Snapshot, TotalsHistory } from '../src/lib/types';

const at = (iso: string) => Date.parse(iso);
const now = at('2026-11-15T20:00:00Z');
const snap: Snapshot = { t: 0, schema: 27, pid: 'p1', at: null, active: null, visited: {} };

describe('addTotal', () => {
  it('records changes and skips repeats', () => {
    let h: TotalsHistory = {};
    h = addTotal(h, 'EIDW', 1, 100);
    h = addTotal(h, 'EIDW', 2, 100);
    h = addTotal(h, 'EIDW', 3, 150);
    expect(h.EIDW).toEqual([
      { t: 1, v: 100 },
      { t: 3, v: 150 },
    ]);
  });
});

describe('unlogged', () => {
  // From a host backup (2026-11-16): the new total at EGAC was seen 1.7 s before the landing's
  // reply arrived, with a stale read of the old total in between.
  it('counts a landing whose reply came just after the total it raised', () => {
    const egac: TotalsHistory = {
      EGAC: [
        { t: at('2026-11-15T14:34:10Z'), v: 93_170 },
        { t: at('2026-11-15T19:00:30Z'), v: 95_140 },
        { t: at('2026-11-15T19:01:30Z'), v: 93_170 }, // stale
        { t: at('2026-11-15T19:01:31Z'), v: 95_140 },
      ],
    };
    let l = newLedger(snap, 0);
    l = recordLanding(l, { t: at('2026-11-15T19:01:33Z'), pid: 'p1', code: 'EGAC', job: { id: 'J', to: 'EGAC' }, result: { value: 1_970 } }, now);
    expect(unlogged(egac, l, 'EGAC', now)).toMatchObject({ rise: 1_970, mine: 1_970, others: 0 });
  });

  it('leaves out a landing near the window that the rise has no room for', () => {
    // The first sighting already included it (EGOQ, same backup), and a later one isn't in yet.
    const h2: TotalsHistory = {
      EGOQ: [
        { t: at('2026-11-15T14:00:00Z'), v: 10_630 },
        { t: at('2026-11-15T16:00:00Z'), v: 15_630 },
      ],
    };
    let l = newLedger(snap, 0);
    l = recordLanding(l, { t: at('2026-11-15T14:01:06Z'), pid: 'p1', code: 'EGOQ', job: { id: 'A', to: 'EGOQ' }, result: { value: 10_630 } }, now);
    l = recordLanding(l, { t: at('2026-11-15T16:02:00Z'), pid: 'p1', code: 'EGOQ', job: { id: 'B', to: 'EGOQ' }, result: { value: 9_000 } }, now);
    expect(unlogged(h2, l, 'EGOQ', now)).toMatchObject({ rise: 5_000, mine: 0, others: 5_000 });
  });

  const h: TotalsHistory = {
    EIDW: [
      { t: at('2026-11-08T10:00:00Z'), v: 999 }, // last week: ignored
      { t: at('2026-11-15T18:00:00Z'), v: 277_100 },
      { t: at('2026-11-15T19:30:00Z'), v: 350_000 },
    ],
  };

  it('splits a rise into my logged deliveries and the rest', () => {
    let l = newLedger(snap, 0);
    l = recordLanding(l, { t: at('2026-11-15T18:30:00Z'), pid: 'p1', code: 'EIDW', job: { id: 'J', to: 'EIDW' }, result: { value: 27_760 } }, now);
    expect(unlogged(h, l, 'EIDW', now)).toMatchObject({ rise: 72_900, mine: 27_760, claimed: 0, others: 45_140 });
  });

  it('counts a claim as mine, and can take it back', () => {
    let l = newLedger(snap, 0);
    l = claim(l, { code: 'EIDW', pay: 72_900, t: at('2026-11-15T19:30:00Z') });
    expect(unlogged(h, l, 'EIDW', now)).toMatchObject({ mine: 72_900, claimed: 72_900, others: 0 });
    expect(tallyAll(l, now).get('EIDW')?.thisWeek).toBe(72_900);
    l = unclaim(l, 'EIDW', at('2026-11-09T00:00:00Z'));
    expect(unlogged(h, l, 'EIDW', now)).toMatchObject({ mine: 0, others: 72_900 });
  });

  it('needs two sightings this week', () => {
    expect(unlogged({ EIDW: [{ t: now, v: 1 }] }, undefined, 'EIDW', now)).toBeUndefined();
  });
});
