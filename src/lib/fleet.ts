// Earnings and influence per plane, for the Fleet page.
//
// The save keeps, for each plane, its hours and the net pay earned in it (`paid`). A company
// plane also has `paidH`, its hours on paid jobs. The game's hangar shows `paid / paidH` for a
// company plane and `paid / hours` for a personal one, as the plane's earning rate (client
// bundle, 2026-11-16). That is the "all time" figure here.
//
// The recent net pay compares those totals now with a sample taken a week ago (or when sampling
// began), so it includes flights by other pilots and on other devices once the game here syncs.
// Influence has no such total. It comes from the landings of the last week: the pilot's, from the
// ledger, and the teammates', from the landing log. Each names the plane and when it took off, so
// influence per hour divides by the hours of the very flights that added it.

import { WEEKLY_CAP, weekStart } from './ledger';
import type { CompanyLog } from './log';
import type { FleetHistory, FleetPlane, FleetSample, Ledger } from './types';

const DAY = 86_400_000;
/** The recent figures cover this long. */
export const FLEET_WINDOW = 7 * DAY;
/** Samples older than this go, except the newest of them, which starts the window. */
const KEEP = 15 * DAY;
const PER_PLANE = 400;
/** Fewer hours than this give no rate, as in the game. */
export const MIN_HOURS = 0.1;

const same = (s: FleetSample, p: FleetPlane) => s.hours === p.hours && s.paid === p.paid && s.paidH === p.paidH;

/**
 * Adds a sample for each plane whose hours or pay changed. Returns the same object when nothing
 * changed, so the caller can skip the write.
 */
export function addFleetSamples(hist: FleetHistory, planes: FleetPlane[], t: number): FleetHistory {
  let changed = false;
  const next: FleetHistory = {};
  const regs = new Set(planes.map((p) => p.reg));
  for (const [reg, list] of Object.entries(hist)) {
    // A plane that left the fleet (sold, or the pilot left the company) is forgotten in time.
    if (!regs.has(reg) && (list.at(-1)?.t ?? 0) < t - KEEP) {
      changed = true;
      continue;
    }
    next[reg] = list;
  }
  for (const p of planes) {
    let list = next[p.reg] ?? [];
    const last = list.at(-1);
    if (!last || !same(last, p)) {
      const s: FleetSample = { t, hours: p.hours };
      if (p.paid !== undefined) s.paid = p.paid;
      if (p.paidH !== undefined) s.paidH = p.paidH;
      list = [...list, s];
      changed = true;
    }
    const old = list.findLastIndex((s) => s.t < t - KEEP);
    if (old > 0 || list.length > PER_PLANE) {
      list = list.slice(Math.max(old, list.length - PER_PLANE, 0));
      changed = true;
    }
    next[p.reg] = list;
  }
  return changed ? next : hist;
}

/** Net pay per hour over the plane's life, as the game's hangar shows it. Null when not known. */
export function lifetimeRate(p: FleetPlane): number | null {
  const h = p.co ? p.paidH : p.hours;
  return p.paid !== undefined && h !== undefined && h >= MIN_HOURS ? p.paid / h : null;
}

/** One landing in a known plane, with the influence it added. */
export interface PlaneLanding {
  t: number;
  reg: string;
  /** The influence it added, after the pilot's weekly limit. 0 when it counts for no one. */
  influence: number;
  /** Hours from takeoff to landing. Unset when the takeoff isn't known. */
  hours?: number;
  /** The landing log split a shared rise evenly: a guess. */
  est: boolean;
  /** The log couldn't measure its influence. */
  unknown: boolean;
}

/** Hours between takeoff and landing, if both are known and make sense. */
const flightHours = (t0: number | undefined, t: number) => (t0 !== undefined && t0 < t && t - t0 < DAY ? (t - t0) / 3_600_000 : undefined);

/**
 * Every landing with a known plane: the pilot's, from the ledger with the landing log merged in
 * (see withLog), and the teammates', from the landing log. A ledger entry's pay counts only up
 * to the room left under the weekly limit at its airport.
 */
export function planeLandings(ledger: Ledger | undefined, log: CompanyLog | undefined): PlaneLanding[] {
  const out: PlaneLanding[] = [];
  const run = new Map<string, number>();
  for (const e of [...(ledger?.entries ?? [])].sort((a, b) => a.t - b.t)) {
    if (e.src === 'manual') continue; // a claim isn't a landing, and names no plane
    const key = `${weekStart(e.t)}|${e.code}`;
    const before = run.get(key) ?? 0;
    let influence = 0;
    if (e.counted) {
      influence = Math.max(0, Math.min(e.pay, WEEKLY_CAP - before));
      run.set(key, before + e.pay);
    } else if (e.pending === 'teammate') {
      influence = e.est ?? 0;
    }
    if (!e.reg) continue;
    const unknown = e.pending === 'unknown' || (e.pending === 'teammate' && e.est === undefined);
    out.push({ t: e.t, reg: e.reg, influence, hours: flightHours(e.t0, e.t), est: e.pending === 'teammate', unknown });
  }
  for (const l of log?.landings ?? []) {
    if (l.pid === ledger?.pid || typeof l.reg !== 'string') continue;
    out.push({ t: l.t, reg: l.reg, influence: l.pay ?? 0, hours: flightHours(l.t0, l.t), est: l.how === 'shared', unknown: l.pay === null });
  }
  return out;
}

/** One plane's recent figures. */
export interface PlaneWindow {
  /**
   * Hours and pay from the plane's own totals: now, less a week ago (or the first sample, if
   * sampling began later). Unset without samples. A save that was out of date when sampling
   * began can put earlier flights in here, but its pay and hours come in together.
   */
  totals?: {
    from: number;
    hours: number;
    /** The hours net pay divides by: paid hours for a company plane that has them. */
    rateHours: number;
    /** Net pay. Unset when the save keeps none for this plane. */
    paid?: number;
  };
  /** Influence of the landings in the window whose influence and flight time are both known. */
  influence: number;
  /** Their hours from takeoff to landing: what influence divides by. */
  inflHours: number;
  landings: number;
  /** Some of `influence` is the log's guess. */
  est: boolean;
  /** Landings left out: their influence or their flight time isn't known. */
  unknown: number;
}

export function planeWindow(
  p: FleetPlane,
  samples: FleetSample[] | undefined,
  landings: PlaneLanding[],
  now: number,
  span = FLEET_WINDOW,
): PlaneWindow {
  const out: PlaneWindow = { influence: 0, inflHours: 0, landings: 0, est: false, unknown: 0 };
  if (samples?.length) {
    const base = samples.findLast((s) => s.t <= now - span) ?? samples[0]!;
    const hours = Math.max(0, p.hours - base.hours);
    const usePaidH = p.co && p.paidH !== undefined;
    out.totals = { from: base.t, hours, rateHours: usePaidH ? Math.max(0, p.paidH! - (base.paidH ?? 0)) : hours };
    if (p.paid !== undefined) out.totals.paid = Math.max(0, p.paid - (base.paid ?? 0));
  }
  // Landings carry their own times, so they use the whole window whenever sampling began.
  for (const l of landings) {
    if (l.reg !== p.reg || l.t <= now - span || l.t > now) continue;
    out.landings++;
    if (l.unknown || l.hours === undefined) {
      out.unknown++;
      continue;
    }
    out.influence += l.influence;
    out.inflHours += l.hours;
    if (l.est && l.influence) out.est = true;
  }
  return out;
}

/** Amount per hour, or null when there are too few hours to say. */
export const perHour = (amount: number | undefined, hours: number | undefined) =>
  amount !== undefined && hours !== undefined && hours >= MIN_HOURS ? amount / hours : null;
