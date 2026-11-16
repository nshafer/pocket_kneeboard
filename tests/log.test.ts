import { describe, expect, it } from 'vitest';
import { logUrl, parseLog, withLog, type LogLanding } from '../src/lib/log';
import { tallyAll, weekStart } from '../src/lib/ledger';
import type { Ledger } from '../src/lib/types';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-18T15:00:00Z');

const ledger = (entries: Ledger['entries'] = []): Ledger => ({ pid: 'me', since: at('2026-11-01T00:00:00Z'), entries, seen: {}, base: {} });
const landing = (over: Partial<LogLanding>): LogLanding => ({
  key: `${over.pid ?? 'me'}:${over.t}`,
  pid: 'me',
  to: 'EGNH',
  t0: (over.t ?? 0) - 30 * 60_000,
  t: at('2026-11-18T10:00:00Z'),
  how: 'measured',
  pay: 10_000,
  ...over,
});
const log = (landings: LogLanding[]) => ({ co: 'c1', updated: NOW, landings });

describe('logUrl', () => {
  it('fills in the company id, and is unset without a setting', () => {
    expect(logUrl('zzz')).toBeUndefined();
    expect(logUrl('zzz', '  ')).toBeUndefined();
    expect(logUrl('zzz', 'https://example.org/logs/{id}.json')).toBe('https://example.org/logs/zzz.json');
    expect(logUrl('bmsx3mly', ' https://mine.example/{id}.json ')).toBe('https://mine.example/bmsx3mly.json');
  });
});

describe('parseLog', () => {
  it('keeps well-formed landings and rejects another company’s log', () => {
    const got = parseLog({ co: 'c1', updated: 5, landings: [landing({}), { key: 'x' }] }, 'c1');
    expect(got.landings).toHaveLength(1);
    expect(() => parseLog({ co: 'c2', landings: [] }, 'c1')).toThrow(/c2/);
    expect(() => parseLog({ flights: [] }, 'c1')).toThrow();
  });
});

describe('withLog', () => {
  const week = weekStart;

  it('counts measured landings and ones shared only with the pilot’s own', () => {
    const l = withLog(
      ledger(),
      log([
        landing({ t: at('2026-11-18T09:00:00Z') }),
        landing({ t: at('2026-11-18T11:00:00Z'), how: 'shared', pay: 4_000, with: [{ pid: 'me' }] }),
        landing({ pid: 'mate', t: at('2026-11-18T12:00:00Z') }),
      ]),
      week,
    );
    expect(l.entries.map((e) => [e.pay, e.counted])).toEqual([
      [10_000, true],
      [4_000, true],
    ]);
    expect(l.seen.EGNH).toBe(2);
    expect(tallyAll(l, NOW).get('EGNH')?.thisWeek).toBe(14_000);
  });

  it('lists landings shared with a teammate, or with no pay, without counting them', () => {
    const l = withLog(
      ledger(),
      log([
        landing({ t: at('2026-11-18T09:00:00Z'), how: 'shared', pay: 6_000, with: [{ pid: 'mate', cs: 'MATE' }] }),
        landing({ t: at('2026-11-18T11:00:00Z'), how: 'unknown', pay: null }),
      ]),
      week,
    );
    expect(l.entries.map((e) => [e.pending, e.est, e.mates])).toEqual([
      ['teammate', 6_000, ['MATE']],
      ['unknown', undefined, undefined],
    ]);
    const t = tallyAll(l, NOW).get('EGNH')!;
    expect([t.thisWeek, t.pending, t.pendingEst]).toEqual([0, 2, 6_000]);
  });

  it('skips landings this browser saw itself', () => {
    const seen = { t: at('2026-11-18T10:07:00Z'), code: 'EGNH', pay: 10_000, counted: true, src: 'report' as const };
    const l = withLog(ledger([seen]), log([landing({})]), week);
    expect(l.entries).toEqual([seen]);
  });

  it('drops a "This was me" claim the log explains', () => {
    const claim = { t: at('2026-11-18T14:00:00Z'), code: 'EGNH', pay: 10_000, counted: true, src: 'manual' as const };
    const l = withLog(ledger([claim]), log([landing({})]), week);
    expect(l.entries.map((e) => e.src)).toEqual(['log']);
  });

  it('caps the airport when the log saw the limit reached', () => {
    const l = withLog(ledger(), log([landing({ how: 'unknown', pay: null, capped: true })]), week);
    expect(tallyAll(l, NOW).get('EGNH')?.thisWeek).toBe(250_000);
  });
});
