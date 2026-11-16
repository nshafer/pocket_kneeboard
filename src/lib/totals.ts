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

/**
 * A landing is timed when the game's reply to it arrives, which can be many minutes after the
 * touchdown that raised the total (the game sends it late from a tab in the background). The
 * touchdown lies between takeoff (`t0`) and that reply. Without a takeoff time, it's taken to lie
 * within SKEW before the reply.
 */
export const SKEW = 5 * 60_000;
const DAY = 86_400_000;

/**
 * How this week's rise in our total at `code` splits between logged deliveries and the rest.
 *
 * The rise runs from the first sighting this week to the highest. Within a week the total only
 * rises, so a lower figure after a higher one is a stale reply, and is passed over. A landing whose
 * touchdown certainly lies between the two counts as mine. One whose takeoff-to-reply span reaches
 * across either sighting may or may not be in it, and counts only while the rise still has room
 * for it.
 */
export function unlogged(hist: TotalsHistory, ledger: Ledger | undefined, code: string, now: number): Unlogged | undefined {
  const week = weekStart(now);
  const seen = (hist[code] ?? []).filter((r) => r.t >= week);
  if (seen.length < 2) return undefined;
  const from = seen[0]!;
  const to = seen.reduce((top, r) => (r.v >= top.v ? r : top), from);
  const rise = Math.max(0, to.v - from.v);
  let mine = 0;
  let claimed = 0;
  const maybe: number[] = [];
  for (const e of ledger?.entries ?? []) {
    if (e.code !== code || !e.counted || e.t < week) continue;
    if (e.src === 'manual') {
      // A claim is timed at the sighting it was made against.
      if (e.t > from.t && e.t <= to.t) {
        mine += e.pay;
        claimed += e.pay;
      }
      continue;
    }
    // The earliest the touchdown could have been.
    const lo = e.t0 !== undefined && e.t0 < e.t && e.t - e.t0 < DAY ? e.t0 : e.t - SKEW;
    if (e.t <= from.t || lo >= to.t) continue; // before the first sighting, or after the highest
    if (lo >= from.t && e.t <= to.t) mine += e.pay;
    else maybe.push(e.pay);
  }
  for (const pay of maybe) if (mine + pay <= rise) mine += pay;
  return { from, to, rise, mine, claimed, others: Math.max(0, rise - mine) };
}
