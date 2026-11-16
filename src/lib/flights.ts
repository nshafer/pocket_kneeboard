// The pilot's flights this week, one by one, for the Log page: where each went, in which plane,
// its net pay and the influence it added.

import { credited, weekStart } from './ledger';
import type { LandingEvent, Ledger } from './types';

export interface FlightRow {
  t: number;
  from?: string;
  to: string;
  name?: string;
  reg?: string;
  /** For a round trip to a helipad, ship or rig. */
  pad?: string;
  /** Net pay from the landing report. Unknown for a flight on another device. */
  net?: number;
  /** The influence it added, after the weekly limit. */
  influence: number;
  /** The base pay before the weekly limit, when it counted. */
  pay: number;
  /**
   * `counted`: its influence is known. `nc`: it counts for no one (a helipad or seaplane base).
   * `teammate`: from the log, sharing a rise with a teammate, so `influence` is a guess.
   * `unknown`: from the log, influence not known. `claim`: a "This was me" claim, not a flight.
   */
  status: 'counted' | 'nc' | 'teammate' | 'unknown' | 'claim';
  /** Why it counts for no one. */
  why?: string;
  /** Flown on another device: it came from the landing log. */
  other: boolean;
}

/**
 * Net pay of recent landings by job id, from the debug record of landing events. Entries made
 * before the ledger kept net pay (0.3.0) get it from there.
 */
export function netsFromDebug(debug: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(debug)) return out;
  for (const ev of debug as Partial<LandingEvent>[]) {
    const id = ev?.job?.id;
    const total = ev?.result?.total;
    if (typeof id === 'string' && typeof total === 'number') out.set(id, total);
  }
  return out;
}

/** This week's flights, newest first. */
export function weekFlights(ledger: Ledger | undefined, now: number, nets = new Map<string, number>()): FlightRow[] {
  const week = weekStart(now);
  const rows: FlightRow[] = [];
  for (const [e, influence] of credited(ledger?.entries ?? [])) {
    if (e.t < week || e.t > now + 86_400_000) continue;
    const status: FlightRow['status'] =
      e.src === 'manual' ? 'claim' : e.pending ? e.pending : e.counted ? 'counted' : 'nc';
    const net = e.net ?? (e.job ? nets.get(e.job) : undefined);
    rows.push({
      t: e.t,
      from: e.from,
      to: e.code,
      name: e.name,
      reg: e.reg,
      pad: e.pad,
      net: e.src === 'manual' ? undefined : net,
      influence,
      pay: e.counted ? e.pay : (e.est ?? 0),
      status,
      why: e.why,
      other: e.src === 'log',
    });
  }
  return rows.sort((a, b) => b.t - a.t);
}
