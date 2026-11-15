// The Pocket Kneeboard's own record of deliveries, and the game's weekly influence rules.
//
// Rules (in-game help, "Holding airports"): a delivery adds the job's pay as influence at the
// airport it lands at. Helipads and seaplane bases count for no one. Weeks start Monday 00:00
// UTC. Influence = this week + half of last week. One pilot counts for at most $250,000 at an
// airport per week.

import { parseMoney } from './game';
import type { LandingEvent, Ledger, LedgerEntry, Snapshot } from './types';

export const WEEKLY_CAP = 250_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Entries older than this are dropped. Two weeks count; a few spare weeks help with checks. */
const KEEP = 5 * WEEK;

/** Monday 00:00 UTC of the week that holds `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

export function newLedger(snap: Snapshot, now: number): Ledger {
  const base: Record<string, number> = {};
  for (const [code, v] of Object.entries(snap.visited)) base[code] = v.n;
  return { pid: snap.pid, since: now, entries: [], seen: {}, base };
}

/** Turns a landing into a ledger entry, or null when no job was delivered. */
export function settle(ev: LandingEvent): LedgerEntry | null {
  const job = ev.job;
  if (!job || job.to !== ev.code) return null;

  let pay: number | undefined;
  let src: LedgerEntry['src'];
  if (ev.result.value !== undefined) {
    pay = ev.result.value;
    src = 'value';
  } else {
    pay = parseMoney(ev.result.line0?.[1]);
    src = 'report';
  }
  if (pay === undefined || pay <= 0) {
    pay = job.pay ?? 0;
    src = 'board';
  }
  if (pay <= 0) return null;

  // Only the place where the job lands matters. A job with `pad` that visits a ship or rig and
  // returns to an airport ("to Supply ship, back to EIDW") counts in full at that airport: seen on
  // 2026-11-15, when NSA's total at EIDW rose by exactly the job's $27,760.
  let why: string | undefined;
  let facility: LedgerEntry['facility'];
  if (ev.airport?.pad) {
    facility = 'helipad';
    why = `helipad (${ev.airport.pad})`;
  } else if (ev.airport?.seaOnly) {
    facility = 'seaplane';
    why = 'seaplane base';
  }

  return {
    t: ev.t,
    code: ev.code,
    name: ev.airport?.name ?? job.toName,
    pay,
    counted: !why,
    why,
    facility,
    job: job.id,
    kind: job.kind,
    src,
  };
}

/** Adds a landing to the ledger. Returns the same ledger when the landing is a repeat. */
export function recordLanding(ledger: Ledger, ev: LandingEvent, now: number): Ledger {
  const entry = settle(ev);
  // The outbox can send a landing again after a failed reply. A job is delivered only once.
  if (entry?.job && ledger.entries.some((e) => e.job === entry.job && e.code === entry.code)) return ledger;
  const entries = entry ? [...ledger.entries, entry] : ledger.entries;
  return {
    ...ledger,
    entries: entries.filter((e) => now - e.t < KEEP),
    seen: { ...ledger.seen, [ev.code]: (ledger.seen[ev.code] ?? 0) + 1 },
  };
}

/**
 * Adds influence the pilot says was theirs ("This was me"): a rise in the company's total that
 * this browser didn't log, such as flights from a phone.
 */
export function claim(ledger: Ledger, c: { code: string; name?: string; pay: number; t: number }): Ledger {
  if (c.pay <= 0) return ledger;
  const entry: LedgerEntry = { t: c.t, code: c.code, name: c.name, pay: c.pay, counted: true, src: 'manual', job: `manual:${c.code}:${c.t}` };
  if (ledger.entries.some((e) => e.job === entry.job)) return ledger;
  return { ...ledger, entries: [...ledger.entries, entry] };
}

/** Removes the pilot's claims at `code` from `since` on. */
export function unclaim(ledger: Ledger, code: string, since: number): Ledger {
  return { ...ledger, entries: ledger.entries.filter((e) => !(e.src === 'manual' && e.code === code && e.t >= since)) };
}

export interface Tally {
  code: string;
  name?: string;
  /** Raw pay delivered this week and last week, before the cap. */
  thisRaw: number;
  lastRaw: number;
  thisWeek: number;
  lastWeek: number;
  /** thisWeek + half of lastWeek. */
  influence: number;
  /** How much more pay counts this week. */
  room: number;
  deliveries: number;
  /** Pay delivered here that counts for no one (pad jobs, helipads, seaplane bases). */
  noCredit: number;
  /** Why the last such delivery did not count. */
  why?: string;
  /** Set when the place itself can't be held. */
  facility?: 'helipad' | 'seaplane';
}

export function tallyFor(ledger: Ledger | undefined, code: string, now: number): Tally {
  return tallyAll(ledger, now).get(code) ?? emptyTally(code);
}

export function emptyTally(code: string): Tally {
  return { code, thisRaw: 0, lastRaw: 0, thisWeek: 0, lastWeek: 0, influence: 0, room: WEEKLY_CAP, deliveries: 0, noCredit: 0 };
}

/** Influence per airport, over this week and last week. */
export function tallyAll(ledger: Ledger | undefined, now: number): Map<string, Tally> {
  const out = new Map<string, Tally>();
  if (!ledger) return out;
  const thisWk = weekStart(now);
  const lastWk = thisWk - WEEK;
  for (const e of ledger.entries) {
    if (e.t < lastWk || e.t > now + DAY) continue;
    const t = out.get(e.code) ?? emptyTally(e.code);
    t.name ??= e.name;
    t.deliveries++;
    t.facility ??= e.facility;
    if (!e.counted) {
      t.noCredit += e.pay;
      t.why = e.why;
    } else if (e.t >= thisWk) {
      t.thisRaw += e.pay;
    } else {
      t.lastRaw += e.pay;
    }
    out.set(e.code, t);
  }
  for (const t of out.values()) {
    t.thisWeek = Math.min(WEEKLY_CAP, t.thisRaw);
    t.lastWeek = Math.min(WEEKLY_CAP, t.lastRaw);
    t.influence = t.thisWeek + t.lastWeek / 2;
    t.room = WEEKLY_CAP - t.thisWeek;
  }
  return out;
}

/**
 * Landings that the save shows but this browser did not see, per airport. They come from
 * another device (or from before the Pocket Kneeboard was installed, when `base` is missing).
 */
export function unseenLandings(ledger: Ledger | undefined, snap: Snapshot | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!ledger || !snap || ledger.pid !== snap.pid) return out;
  for (const [code, v] of Object.entries(snap.visited)) {
    const extra = v.n - (ledger.base[code] ?? 0) - (ledger.seen[code] ?? 0);
    if (extra > 0) out[code] = extra;
  }
  return out;
}
