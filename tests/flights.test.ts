import { describe, expect, it } from 'vitest';
import { netsFromDebug, weekFlights } from '../src/lib/flights';
import { recordLanding, newLedger } from '../src/lib/ledger';
import type { Ledger, LedgerEntry, Snapshot } from '../src/lib/types';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-18T15:00:00Z'); // a Wednesday
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ t: at('2026-11-17T10:00:00Z'), code: 'EGLL', pay: 10_000, counted: true, src: 'value', ...over });
const ledger = (entries: LedgerEntry[]): Ledger => ({ pid: 'me', since: 0, entries, seen: {}, base: {} });

describe('weekFlights', () => {
  it('lists this week’s flights newest first, with the influence each added after the limit', () => {
    const rows = weekFlights(
      ledger([
        entry({ t: at('2026-11-14T10:00:00Z'), pay: 99_000 }), // last week
        entry({ pay: 240_000, net: 250_000 }),
        entry({ t: at('2026-11-17T12:00:00Z'), pay: 30_000, net: 31_000, from: 'EIDW', reg: 'N1' }),
      ]),
      NOW,
    );
    expect(rows.map((r) => [r.to, r.from, r.reg, r.pay, r.influence, r.net, r.status])).toEqual([
      ['EGLL', 'EIDW', 'N1', 30_000, 10_000, 31_000, 'counted'],
      ['EGLL', undefined, undefined, 240_000, 240_000, 250_000, 'counted'],
    ]);
  });

  it('marks pads, log guesses, unknowns and claims, and takes net pay from the debug record', () => {
    const rows = weekFlights(
      ledger([
        entry({ job: 'J1', counted: false, why: 'helipad (hospital)' }),
        entry({ t: at('2026-11-17T11:00:00Z'), src: 'log', counted: false, pay: 0, pending: 'teammate', est: 4_000 }),
        entry({ t: at('2026-11-17T12:00:00Z'), src: 'log', counted: false, pay: 0, pending: 'unknown' }),
        entry({ t: at('2026-11-17T13:00:00Z'), src: 'manual', pay: 7_000 }),
      ]),
      NOW,
      netsFromDebug([{ job: { id: 'J1' }, result: { total: 9_100 } }, { junk: 1 }]),
    );
    expect(rows.map((r) => [r.status, r.influence, r.other, r.net])).toEqual([
      ['claim', 7_000, false, undefined],
      ['unknown', 0, true, undefined],
      ['teammate', 4_000, true, undefined],
      ['nc', 0, false, 9_100],
    ]);
  });
});

describe('recordLanding', () => {
  it('keeps the report’s total, the origin and the pad kind', () => {
    const snap = { t: 0, schema: 1, pid: 'me', at: null, active: null, visited: {} } as Snapshot;
    const l = recordLanding(
      newLedger(snap, 0),
      {
        t: 100,
        pid: 'me',
        code: 'EIDW',
        job: { id: 'J', from: 'EIDW', to: 'EIDW', pad: 'remote', pay: 22_310 },
        result: { value: 22_310, total: 22_684 },
      },
      100,
    );
    expect(l.entries[0]).toMatchObject({ pay: 22_310, net: 22_684, from: 'EIDW', pad: 'remote' });
  });
});
