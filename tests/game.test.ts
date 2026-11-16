import { describe, expect, it } from 'vitest';
import { lastLanding, noteLandings, originStale } from '../src/lib/origin';
import type { Snapshot } from '../src/lib/types';
import {
  airportKind,
  boardButtonCode,
  boardButtonRoundTrip,
  boardButtonJob,
  cardButtonJob,
  landingResult,
  parseMoney,
  replacesSelection,
  snapshotFromSave,
  standingsFromReply,
} from '../src/lib/game';
import type { AirportInfo } from '../src/lib/types';

describe('snapshotFromSave', () => {
  const save = {
    v: 27,
    t: 123,
    data: {
      pid: 'p1',
      callsign: 'N1C0',
      acct: 'SECRET-SYNC-CODE',
      co: 'c1',
      company: { name: 'Non-Stop Airlines', tag: 'NSA', members: { big: 1 } },
      at: { code: 'EIDW', name: 'Dublin', lat: 1, lon: 2 },
      active: {
        id: 'a1',
        ts: 999,
        log: { t0: 100, seen: [] },
        from: { code: 'EIDW' },
        dest: { code: 'EGLL' },
        job: { id: 'J', to: 'EGLL', pay: 5, pad: 'ship', secret: 1 },
      },
      visited: { EIDW: { n: 2, name: 'Dublin', h: 3 } },
    },
  };

  it('keeps only the named fields', () => {
    const s = snapshotFromSave(JSON.stringify(save))!;
    expect(s).toMatchObject({
      pid: 'p1',
      coTag: 'NSA',
      at: { code: 'EIDW', name: 'Dublin' },
      visited: { EIDW: { n: 2 } },
    });
    expect(s.active?.job).toMatchObject({ id: 'J', to: 'EGLL', pay: 5, pad: 'ship' });
    expect(s.active?.t0).toBe(100);
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('reads both fleets, and the company’s only for a member', () => {
    const fleetSave = {
      ...save,
      data: {
        ...save.data,
        plane: 'N1',
        fleet: [{ reg: 'N1', type: 'kite', hours: 2, paid: 100, at: { code: 'EIDW', lat: 1 }, paint: { body: 1 } }, { reg: 'bad' }],
        company: {
          ...save.data.company,
          id: 'c1',
          code: 'INVITE-CODE',
          fleet: [{ reg: 'N2', type: 'zephyr', hours: 5, paid: 900, paidH: 3, by: 'p9', name: 'Herugrim', co: 'c1' }],
        },
      },
    };
    const s = snapshotFromSave(JSON.stringify(fleetSave))!;
    expect(s.plane).toBe('N1');
    expect(s.fleet).toEqual([
      { reg: 'N1', type: 'kite', hours: 2, paid: 100, at: 'EIDW', co: false },
      { reg: 'N2', type: 'zephyr', hours: 5, paid: 900, paidH: 3, name: 'Herugrim', co: true },
    ]);
    expect(JSON.stringify(s)).not.toContain('INVITE');
    // A pilot who left the company: its planes aren't theirs to list.
    const left = snapshotFromSave(JSON.stringify({ ...fleetSave, data: { ...fleetSave.data, co: 'c2' } }))!;
    expect(left.fleet?.map((p) => p.reg)).toEqual(['N1']);
  });

  it('rejects junk', () => {
    expect(snapshotFromSave('nope')).toBeNull();
    expect(snapshotFromSave('{"data":{}}')).toBeNull();
    expect(snapshotFromSave(null)).toBeNull();
  });
});

describe('replies', () => {
  it('reads standings from /api/here and /api/standings', () => {
    const here = {
      holder: 'c1',
      standings: [{ id: 'c1', value: 277_100 }],
      cos: { c1: { name: 'NSA Air', tag: 'NSA', paint: {} } },
    };
    expect(standingsFromReply('EIDW', here, 1)).toEqual({
      code: 'EIDW',
      t: 1,
      holder: 'c1',
      list: [{ id: 'c1', value: 277_100 }],
      cos: { c1: { name: 'NSA Air', tag: 'NSA' } },
    });
    expect(standingsFromReply('EIDW', { list: [{ id: 'c1', value: 5 }], cos: {} }, 1)?.list).toHaveLength(1);
  });

  it('reads the landing result and nothing else', () => {
    const r = landingResult({ acct: 'x', result: { total: 9, lines: [['Cargo', '$27,760'], ['Fuel', '−$5']] } });
    expect(r).toMatchObject({ total: 9, line0: ['Cargo', '$27,760'] });
    expect(JSON.stringify(r)).not.toContain('acct');
    expect(landingResult({ error: 'early' })).toBeNull();
  });

  it('reads the job buttons the game draws', () => {
    expect(boardButtonCode('Fly to EGNM')).toBe('EGNM');
    expect(boardButtonCode('Fly to GB-0625')).toBe('GB-0625');
    expect(boardButtonCode('Fly leg 1 to EGDM')).toBe('EGDM');
    expect(boardButtonCode('Fly leg 12 to EGNM')).toBe('EGNM');
    expect(boardButtonCode('Fly 3 legs · 2h 10m')).toBeUndefined();
    expect(boardButtonCode('Fly to Supply ship & back')).toBeUndefined();
    expect(boardButtonRoundTrip('Fly to Supply ship & back')).toBe('Supply ship');
    expect(boardButtonRoundTrip('Fly to Midland & b…')).toBe('Midland');
    expect(boardButtonRoundTrip('Fly to Arran south &…')).toBe('Arran south');
    expect(boardButtonRoundTrip('Fly to EGNM')).toBeUndefined();
    expect(boardButtonRoundTrip('Fly to Supply sh…')).toBeUndefined();
    expect(boardButtonJob('$11,734 · 45m')).toEqual({ pay: 11_734, time: '45m' });
    expect(boardButtonJob('+')).toBeUndefined();
    expect(cardButtonJob('Fly it · $3,375 · 32m')).toEqual({ pay: 3_375, time: '32m' });
    expect(cardButtonJob('Fly it · $3,375 · 2 legs')).toEqual({ pay: 3_375, time: '2 legs' });
    expect(cardButtonJob('Free flight to here · 23m · -$1,799')).toBeUndefined();
  });

  it('parses money', () => {
    expect(parseMoney('$27,760')).toBe(27_760);
    expect(parseMoney('−$500')).toBe(-500);
    expect(parseMoney('free')).toBeUndefined();
  });

  it('classifies airports', () => {
    expect(airportKind({ name: 'H', rw: [], pad: { kind: 'hospital' } })).toEqual({ name: 'H', pad: 'hospital' });
    expect(airportKind({ name: 'S', rw: [{ water: true }], sea: { dock: {} } })).toEqual({ name: 'S', seaOnly: true });
    expect(airportKind({ name: 'A', rw: [{ water: true }, { water: false }], sea: { dock: {} } })).toEqual({ name: 'A' });
  });
});

describe('replacesSelection', () => {
  const sel = (code: string, more: Partial<AirportInfo> = {}): AirportInfo => ({ code, t: 1, selected: true, via: 'map', ...more });

  it('takes any airport someone can hold, even the one Part I shows', () => {
    expect(replacesSelection(sel('EGLL'))).toBe(true);
    expect(replacesSelection(sel('EIDW', { via: 'board', back: 'Supply ship' }))).toBe(true);
  });
  it('skips helipads and seaplane bases', () => {
    expect(replacesSelection(sel('XH01', { kind: { pad: 'hospital' } }))).toBe(false);
    expect(replacesSelection(sel('XS01', { kind: { seaOnly: true } }))).toBe(false);
  });
  it('skips the current airport, which is not a selection', () => {
    expect(replacesSelection({ code: 'EGLL', t: 1, selected: false })).toBe(false);
  });
});

describe('origin standings', () => {
  const snap = (visited: Record<string, number>, pid = 'p1') =>
    ({ t: 0, schema: 1, pid, at: null, active: null, visited: Object.fromEntries(Object.entries(visited).map(([c, n]) => [c, { n }])) }) as Snapshot;

  it('notes a landing when the save’s count for an airport rises', () => {
    const landed = { EGLL: 5 };
    expect(noteLandings(landed, undefined, snap({ EIDW: 3 }), 10)).toBe(landed);
    expect(noteLandings(landed, snap({ EIDW: 3 }), snap({ EIDW: 3 }), 10)).toBe(landed);
    expect(noteLandings(landed, snap({ EIDW: 3 }), snap({ EIDW: 4, EGNH: 1 }), 10)).toEqual({ EGLL: 5, EIDW: 10, EGNH: 10 });
    expect(noteLandings(landed, snap({ EIDW: 3 }, 'other'), snap({ EIDW: 4 }), 10)).toBe(landed);
  });

  it('finds the last landing from the noted counts, the ledger and the log', () => {
    const ledger = { pid: 'p1', since: 0, seen: {}, base: {}, entries: [{ t: 30, code: 'EIDW', pay: 1, counted: true, src: 'value' as const }] };
    const log = { co: 'c1', updated: 0, landings: [{ key: 'k', pid: 'p1', to: 'EIDW', t0: 0, t: 40, how: 'measured' as const, pay: 1 }] };
    expect(lastLanding('EIDW', 'p1', { EIDW: 20 }, ledger, log)).toBe(40);
    expect(lastLanding('EIDW', 'p1', { EIDW: 50 }, ledger, undefined)).toBe(50);
    expect(lastLanding('EGNH', 'p1', { EIDW: 50 }, ledger, log)).toBeUndefined();
  });

  it('asks again only for standings older than the last landing (or the takeoff)', () => {
    // Read each minute while parked here, then took off: still good.
    expect(originStale(100, 40, 160)).toBe(false);
    // Landed there on another device after they were read.
    expect(originStale(100, 120, 160)).toBe(true);
    expect(originStale(100, undefined, 160)).toBe(true);
    expect(originStale(undefined, 40, 160)).toBe(true);
  });
});
