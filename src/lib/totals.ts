// Our company's total at each airport, as the Pocket Kneeboard sees it over time, and how much of its
// rise this browser's logged deliveries explain.
//
// Within a week a company's total only rises: each delivery adds its pay (last week's half stays
// fixed until Monday). So a rise the pilot's logged deliveries don't explain came from other
// pilots, or from this pilot on another device. The pilot can claim it ("This was me").

import { weekStart } from './ledger';
import type { Ledger, TotalsHistory } from './types';

const PER_AIRPORT = 30;
const AIRPORTS = 80;

/** Adds one sighting of our total at `code`. Repeats of the same value are skipped. */
export function addTotal(hist: TotalsHistory, code: string, t: number, v: number): TotalsHistory {
  const list = hist[code] ?? [];
  const last = list.at(-1);
  if (last && last.v === v && weekStart(last.t) === weekStart(t)) return hist;
  const next = { ...hist, [code]: [...list, { t, v }].slice(-PER_AIRPORT) };
  const codes = Object.keys(next);
  if (codes.length <= AIRPORTS) return next;
  const newest = codes.sort((a, b) => (next[b]!.at(-1)?.t ?? 0) - (next[a]!.at(-1)?.t ?? 0)).slice(0, AIRPORTS);
  return Object.fromEntries(newest.map((c) => [c, next[c]!]));
}

export interface Unlogged {
  /** The first and last sightings this week. */
  from: { t: number; v: number };
  to: { t: number; v: number };
  /** How much the total rose between them. */
  rise: number;
  /** The part of the rise this browser logged as the pilot's own deliveries. */
  mine: number;
  /** The part of `mine` the pilot claimed with "This was me". */
  claimed: number;
  /** The rest: other pilots, or the pilot on another device. */
  others: number;
}

/** How this week's rise in our total at `code` splits between logged deliveries and the rest. */
export function unlogged(hist: TotalsHistory, ledger: Ledger | undefined, code: string, now: number): Unlogged | undefined {
  const week = weekStart(now);
  const seen = (hist[code] ?? []).filter((r) => r.t >= week);
  if (seen.length < 2) return undefined;
  const from = seen[0]!;
  const to = seen.at(-1)!;
  const rise = Math.max(0, to.v - from.v);
  let mine = 0;
  let claimed = 0;
  for (const e of ledger?.entries ?? []) {
    if (e.code !== code || !e.counted || e.t <= from.t || e.t > to.t) continue;
    mine += e.pay;
    if (e.src === 'manual') claimed += e.pay;
  }
  return { from, to, rise, mine, claimed, others: Math.max(0, rise - mine) };
}
