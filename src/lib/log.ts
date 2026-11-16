// The landing log: every landing by a company's pilots, from any device, kept by
// server/kneeboard_poll.py on a server that polls the game once a minute. The Pocket Kneeboard
// reads it to count the pilot's flights from other devices (a phone, while this computer sleeps).

import type { Ledger, LedgerEntry } from './types';

/** One landing in the log. `t` is the landing time by the flight's ETA. */
export interface LogLanding {
  key: string;
  pid: string;
  cs?: string;
  from?: string;
  to: string;
  t0: number;
  t: number;
  /**
   * `measured`: the only company landing there between two totals. `shared`: several, and the
   * rise is split evenly among them (`with` names the others). `unknown`: no total from before.
   */
  how: 'measured' | 'shared' | 'unknown';
  /** The influence it added, up to the weekly limit. Null when unknown. */
  pay: number | null;
  /** The pilot reached the weekly limit there with this landing, or had already. */
  capped?: boolean;
  with?: { pid: string; cs?: string }[];
}

export interface CompanyLog {
  co: string;
  updated: number;
  landings: LogLanding[];
}

/** The log's URL for company `co`, from the pilot's setting (`{id}` stands for the company id). */
export function logUrl(co: string, template?: string): string | undefined {
  const t = template?.trim();
  return t ? t.replaceAll('{id}', encodeURIComponent(co)) : undefined;
}

/** Checks a downloaded log and keeps only well-formed landings. Throws if it isn't a log at all. */
export function parseLog(raw: unknown, co: string): CompanyLog {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { landings?: unknown }).landings)) {
    throw new Error('not a landing log');
  }
  const r = raw as { co?: unknown; updated?: unknown; landings: unknown[] };
  if (typeof r.co === 'string' && r.co !== co) throw new Error(`log is for company ${r.co}`);
  const landings = r.landings.filter((l): l is LogLanding => {
    const x = l as Partial<LogLanding>;
    return (
      typeof x?.key === 'string' &&
      typeof x.pid === 'string' &&
      typeof x.to === 'string' &&
      typeof x.t === 'number' &&
      ['measured', 'shared', 'unknown'].includes(x.how as string)
    );
  });
  return { co, updated: typeof r.updated === 'number' ? r.updated : 0, landings };
}

/** How close a logged landing and one this browser saw must be to be the same landing. */
const SAME_LANDING = 20 * 60_000;

/**
 * The ledger with the pilot's landings from the log that this browser didn't see. A landing
 * counts when its pay is exact: `measured`, or `shared` only with the pilot's own landings. One
 * shared with a teammate, or with no pay, is listed but doesn't count (`pending`).
 *
 * "This was me" claims at an airport are dropped once the log has a counted landing there that
 * week before the claim: the log already explains that rise.
 */
export function withLog(ledger: Ledger, log: CompanyLog | undefined, weekOf: (t: number) => number): Ledger {
  if (!log) return ledger;
  const mine = log.landings.filter((l) => l.pid === ledger.pid && l.t >= ledger.since - SAME_LANDING);
  const own = ledger.entries.filter((e) => e.src !== 'manual' && e.src !== 'log');
  const added: LedgerEntry[] = [];
  const seen = { ...ledger.seen };
  for (const l of mine) {
    if (own.some((e) => e.code === l.to && Math.abs(e.t - l.t) <= SAME_LANDING)) continue;
    const teammate = l.with?.some((w) => w.pid !== ledger.pid) ?? false;
    const exact = l.pay !== null && (l.how === 'measured' || (l.how === 'shared' && !teammate));
    added.push({
      t: l.t,
      code: l.to,
      pay: exact ? l.pay! : 0,
      counted: exact,
      src: 'log',
      job: l.key,
      ...(exact ? {} : { pending: teammate ? 'teammate' : 'unknown', est: l.pay ?? undefined }),
      ...(teammate ? { mates: l.with!.filter((w) => w.pid !== ledger.pid).map((w) => w.cs ?? '?') } : {}),
      ...(l.capped ? { capped: true } : {}),
    });
    seen[l.to] = (seen[l.to] ?? 0) + 1;
  }
  const explained = (claim: LedgerEntry) =>
    added.some((a) => a.counted && a.code === claim.code && a.t <= claim.t && weekOf(a.t) === weekOf(claim.t));
  const entries = [...ledger.entries.filter((e) => e.src !== 'manual' || !explained(e)), ...added].sort((a, b) => a.t - b.t);
  return { ...ledger, entries, seen };
}
