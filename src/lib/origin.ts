// When the pilot last landed at each airport, as far as this browser can tell. In flight, Part I
// shows the origin, and its kept standings are out of date when they were read before the pilot
// last landed there: the landing (and maybe the stay) happened on another device.
//
// The save's `visited[code]` has a count of landings but no time of the last one, so a rise in the
// count between two saves is noted with the time it was seen. A landing synced from another
// device is seen late, which errs toward asking for the standings again.

import type { CompanyLog } from './log';
import type { Ledger, Snapshot } from './types';

/** Airport code → when a landing there was last seen. */
export type LandedAt = Record<string, number>;

const MAX_AIRPORTS = 100;

/** Notes the airports whose landing count rose since the previous save. */
export function noteLandings(landed: LandedAt, prev: Snapshot | undefined, snap: Snapshot, now: number): LandedAt {
  if (!prev || prev.pid !== snap.pid) return landed;
  const rose = Object.entries(snap.visited).filter(([code, v]) => v.n > (prev.visited[code]?.n ?? 0));
  if (!rose.length) return landed;
  const next = { ...landed };
  for (const [code] of rose) next[code] = now;
  const codes = Object.keys(next);
  if (codes.length <= MAX_AIRPORTS) return next;
  return Object.fromEntries(codes.sort((a, b) => next[b]! - next[a]!).slice(0, MAX_AIRPORTS).map((c) => [c, next[c]!]));
}

/** The last time the pilot landed at `code` that anything here knows of, or undefined. */
export function lastLanding(code: string, pid: string, landed: LandedAt | undefined, ledger: Ledger | undefined, log: CompanyLog | undefined) {
  const times = [
    landed?.[code],
    ...(ledger?.entries ?? []).filter((e) => e.code === code && e.src !== 'manual').map((e) => e.t),
    ...(log?.landings ?? []).filter((l) => l.pid === pid && l.to === code).map((l) => l.t),
  ].filter((t): t is number => typeof t === 'number');
  return times.length ? Math.max(...times) : undefined;
}

/**
 * Whether the origin's standings, read at `read`, need reading again: they're older than the
 * last landing there, or, with no landing known, older than the takeoff.
 */
export function originStale(read: number | undefined, lastLandingAt: number | undefined, takeoff: number) {
  if (read === undefined) return true;
  return read < (lastLandingAt ?? takeoff);
}
