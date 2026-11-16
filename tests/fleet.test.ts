import { describe, expect, it } from 'vitest';
import { addFleetSamples, lifetimeRate, perHour, planeLandings, planeWindow } from '../src/lib/fleet';
import type { FleetPlane, Ledger, LedgerEntry } from '../src/lib/types';
import type { CompanyLog, LogLanding } from '../src/lib/log';

const at = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;
const NOW = at('2026-11-18T15:00:00Z');

const kite = (over: Partial<FleetPlane> = {}): FleetPlane => ({ reg: 'N1', type: 'kite', hours: 20, paid: 500_000, co: false, ...over });
const zephyr = (over: Partial<FleetPlane> = {}): FleetPlane => ({ reg: 'N2', type: 'zephyr', hours: 100, paid: 3_000_000, paidH: 60, co: true, ...over });
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ t: NOW - DAY, code: 'EGLL', pay: 10_000, counted: true, src: 'value', reg: 'N1', ...over });
const ledger = (entries: LedgerEntry[]): Ledger => ({ pid: 'me', since: 0, entries, seen: {}, base: {} });
const landing = (over: Partial<LogLanding>): LogLanding => ({ key: 'k', pid: 'mate', to: 'EGLL', t0: NOW - DAY - 3_600_000, t: NOW - DAY, how: 'measured', pay: 20_000, reg: 'N2', ...over });

describe('addFleetSamples', () => {
  it('adds a sample only when a plane’s hours or pay change', () => {
    const one = addFleetSamples({}, [kite()], NOW - 2 * DAY);
    expect(one.N1).toEqual([{ t: NOW - 2 * DAY, hours: 20, paid: 500_000 }]);
    expect(addFleetSamples(one, [kite()], NOW)).toBe(one);
    const two = addFleetSamples(one, [kite({ hours: 21, paid: 520_000 })], NOW);
    expect(two.N1).toHaveLength(2);
  });

  it('keeps one sample older than 15 days, and forgets planes gone that long', () => {
    let h = addFleetSamples({}, [kite(), zephyr()], NOW - 30 * DAY);
    h = addFleetSamples(h, [kite({ hours: 21 })], NOW - 20 * DAY);
    h = addFleetSamples(h, [kite({ hours: 22 })], NOW);
    expect(h.N1!.map((s) => s.hours)).toEqual([21, 22]);
    expect(h.N2).toBeUndefined();
  });
});

describe('lifetimeRate', () => {
  it('follows the game: paid per hour, per paid hour for a company plane', () => {
    expect(lifetimeRate(kite())).toBe(25_000);
    expect(lifetimeRate(zephyr())).toBe(50_000);
    expect(lifetimeRate(kite({ hours: 0.05 }))).toBeNull();
    expect(lifetimeRate(zephyr({ paid: undefined }))).toBeNull();
  });
});

describe('planeLandings', () => {
  it('counts a ledger landing only up to the weekly limit at its airport', () => {
    const l = planeLandings(ledger([entry({ pay: 240_000, t: NOW - 2 * DAY }), entry({ pay: 30_000 })]), undefined);
    expect(l.map((x) => x.influence)).toEqual([240_000, 10_000]);
  });

  it('adds teammates’ landings from the log, with their flight time, but not the pilot’s own twice', () => {
    const log: CompanyLog = { co: 'c1', updated: NOW, landings: [landing({}), landing({ pid: 'me', reg: 'N1' }), landing({ how: 'shared', pay: 5_000 })] };
    const l = planeLandings(ledger([]), log);
    expect(l).toEqual([
      { t: NOW - DAY, reg: 'N2', influence: 20_000, hours: 1, est: false, unknown: false },
      { t: NOW - DAY, reg: 'N2', influence: 5_000, hours: 1, est: true, unknown: false },
    ]);
  });

  it('skips landings with no plane, and claims', () => {
    expect(planeLandings(ledger([entry({ reg: undefined }), entry({ src: 'manual' })]), undefined)).toEqual([]);
  });
});

describe('planeWindow', () => {
  const samples = [
    { t: NOW - 10 * DAY, hours: 10, paid: 200_000 },
    { t: NOW - 8 * DAY, hours: 15, paid: 300_000 },
    { t: NOW - 3 * DAY, hours: 18, paid: 400_000 },
  ];

  it('takes hours and pay from the plane’s totals now and a week ago', () => {
    const w = planeWindow(kite(), samples, [], NOW);
    expect(w.totals).toEqual({ from: NOW - 8 * DAY, hours: 5, rateHours: 5, paid: 200_000 });
    expect(perHour(w.totals!.paid, w.totals!.rateHours)).toBe(40_000);
  });

  it('divides influence by the hours of the flights that added it', () => {
    const h = 3_600_000;
    const landings = planeLandings(
      ledger([
        entry({ t: NOW - 9 * DAY, t0: NOW - 9 * DAY - h }), // before the window
        entry({ code: 'EIDW', t0: NOW - DAY - 2 * h }),
        entry({ code: 'EGNH', pay: 4_000, t0: NOW - DAY - h / 2 }),
        entry({ code: 'EGNS' }), // no takeoff time: left out
        entry({ reg: 'N9', t0: NOW - DAY - h }), // another plane
      ]),
      undefined,
    );
    const w = planeWindow(kite(), undefined, landings, NOW);
    expect(w).toMatchObject({ influence: 14_000, inflHours: 2.5, landings: 3, unknown: 1 });
    expect(w.totals).toBeUndefined();
    expect(perHour(w.influence, w.inflHours)).toBe(5_600);
  });

  it('divides a company plane’s pay by its paid hours', () => {
    const w = planeWindow(zephyr(), [{ t: NOW - 2 * DAY, hours: 90, paid: 2_500_000, paidH: 55 }], [], NOW);
    expect(w.totals).toEqual({ from: NOW - 2 * DAY, hours: 10, rateHours: 5, paid: 500_000 });
    expect(perHour(100, 0.05)).toBeNull();
  });
});
