import { describe, expect, it } from 'vitest';
import {
  airportKind,
  boardButtonCode,
  boardButtonRoundTrip,
  boardButtonJob,
  cardButtonJob,
  landingResult,
  parseMoney,
  snapshotFromSave,
  standingsFromReply,
} from '../src/lib/game';

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
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(JSON.stringify(s)).not.toContain('secret');
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
