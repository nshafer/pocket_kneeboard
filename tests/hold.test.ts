import { describe, expect, it } from 'vitest';
import { heldFromWorld, landedAt } from '../src/lib/game';
import { afterJob, holdSummary } from '../src/lib/hold';
import type { AirportStandings } from '../src/lib/types';

const st = (holder: string | undefined, rows: [string, number][]): AirportStandings => ({
  code: 'EGNH',
  t: 0,
  holder,
  list: rows.map(([id, value]) => ({ id, value })),
  cos: { us: { tag: 'NSA' }, them: { tag: 'VANG' }, other: { tag: 'DZL' } },
});

describe('holdSummary', () => {
  it('gives our lead when we hold it', () => {
    const s = holdSummary('us', st('us', [['us', 300_000], ['them', 180_000]]));
    expect(s).toMatchObject({ weHold: true, ours: 300_000, lead: { over: 'VANG', by: 120_000 } });
  });

  it('gives what we need, and from whom, when someone else holds it', () => {
    const s = holdSummary('us', st('them', [['them', 90_000], ['us', 44_000]]));
    expect(s).toMatchObject({ weHold: false, ours: 44_000, holder: { tag: 'VANG', value: 90_000 }, need: { from: 'VANG', amount: 46_001 } });
  });

  it('counts us at zero when we are not on the standings', () => {
    expect(holdSummary('us', st('them', [['them', 5_000]])).need).toEqual({ from: 'VANG', amount: 5_001 });
  });

  it('needs $2,000 to hold an airport nobody holds', () => {
    expect(holdSummary('us', st(undefined, [['us', 500]])).need).toEqual({ from: undefined, amount: 1_500 });
  });

  it('takes the holder from the top of /api/standings, which has no holder field', () => {
    const s = holdSummary('us', st(undefined, [['them', 197_740], ['us', 304_860]]));
    expect(s).toMatchObject({ weHold: true, lead: { over: 'VANG', by: 107_120 } });
  });

  it('works from the world data alone', () => {
    const ours = holdSummary('us', undefined, { co: 'us', v: 378_175, tag: 'NSA' });
    expect(ours).toMatchObject({ weHold: true, ours: 378_175, holder: { tag: 'NSA' } });
    expect(ours.lead).toBeUndefined();
    const theirs = holdSummary('us', undefined, { co: 'them', v: 90_000, tag: 'VANG' });
    expect(theirs).toMatchObject({ weHold: false, holder: { tag: 'VANG', value: 90_000 } });
    expect(theirs.need).toBeUndefined();
  });
});

describe('afterJob', () => {
  const theirs = holdSummary('us', st('them', [['them', 90_000], ['us', 44_000]]));

  it('says when a job takes the airport', () => {
    expect(afterJob(theirs, 50_000, 250_000)).toEqual({ counted: 50_000, after: 94_000, holds: true, flips: true, lead: 4_000 });
  });

  it('says how far short a job falls', () => {
    expect(afterJob(theirs, 10_000, 250_000)).toEqual({ counted: 10_000, after: 54_000, holds: false, flips: false, short: 36_001 });
  });

  it('counts only up to the weekly limit', () => {
    expect(afterJob(theirs, 50_000, 30_000)).toMatchObject({ counted: 30_000, flips: false, short: 16_001 });
  });

  it('grows our lead when we hold it', () => {
    const ours = holdSummary('us', st('us', [['us', 300_000], ['them', 180_000]]));
    expect(afterJob(ours, 5_000, 250_000)).toMatchObject({ holds: true, flips: false, lead: 125_000 });
  });

  it('says nothing more when our total is unknown', () => {
    expect(afterJob(holdSummary('us', undefined, { co: 'them', v: 1 }), 5_000, 250_000)).toEqual({ counted: 5_000 });
  });
});

describe('landedAt', () => {
  it('lists our company’s landings at one airport, newest first', () => {
    const cells = new Map([
      ['a', { landed: [
        { pid: 'me', cs: 'N1C0', co: 'us', at: { code: 'EIDW' }, t: 5 },
        { pid: 'x', cs: 'OTHER', co: 'them', at: { code: 'EIDW' }, t: 6 },
      ] }],
      ['b', { landed: [
        { pid: 'y', cs: 'MATE', co: 'us', at: { code: 'EIDW' }, t: 9 },
        { pid: 'y', cs: 'MATE', co: 'us', at: { code: 'EGLL' }, t: 9 },
        { pid: 'me', cs: 'N1C0', co: 'us', at: { code: 'EIDW' }, t: 5 },
      ] }],
    ]);
    expect(landedAt(cells, 'EIDW', 'us', 'me')).toEqual([
      { cs: 'MATE', t: 9, me: false },
      { cs: 'N1C0', t: 5, me: true },
    ]);
    expect(landedAt(undefined, 'EIDW', 'us', 'me')).toEqual([]);
  });
});

describe('heldFromWorld', () => {
  const world = { held: { EIKN: { co: 'us', v: 378_175, lat: 1, lon: 2 } }, cos: { us: { tag: 'NSA', name: 'Non-Stop', paint: {} } } };
  it('reads the holder', () => {
    expect(heldFromWorld(world, 'EIKN')).toEqual({ co: 'us', v: 378_175, tag: 'NSA', name: 'Non-Stop' });
    expect(heldFromWorld(world, 'EGLL')).toBeNull();
    expect(heldFromWorld(undefined, 'EGLL')).toBeUndefined();
  });
});
