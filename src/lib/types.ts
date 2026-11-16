// Shapes shared by the page hook, the background worker and the side panel.
// Each one holds only fields picked from the game's save or API replies. None holds an account
// value (acct, auth, install ids, the `pt` query parameter).

export interface Place {
  code: string;
  name?: string;
}

/** The job the pilot is flying, from `data.active.job` in the save. */
export interface JobInfo {
  id: string;
  from?: string;
  to: string;
  toName?: string;
  kind?: string;
  /** Pay shown on the job board. The landing report's first line is the real base pay. */
  pay?: number;
  /** Set when the job goes to a helipad, ship, rig and so on: "remote", "hospital", "ship", … */
  pad?: string;
}

/** The parts of `flash.save.main` that the Pocket Kneeboard reads. */
export interface Snapshot {
  /** The save's own write time (`save.t`). */
  t: number;
  schema: number;
  pid: string;
  callsign?: string;
  co?: string;
  coName?: string;
  coTag?: string;
  at: Place | null;
  /** `t0`: when the flight took off, from `data.active.log.t0`. */
  active: { id?: string; from?: Place; dest?: Place; job?: JobInfo; t0?: number } | null;
  /** Landings per airport, from `data.visited[code].n`. */
  visited: Record<string, { n: number; name?: string }>;
  /** The registration of the plane the pilot flies now (`data.plane`). */
  plane?: string;
  /** The pilot's planes (`data.fleet`) and, for a member, the company's (`data.company.fleet`). */
  fleet?: FleetPlane[];
}

/**
 * One plane, from `data.fleet` or `data.company.fleet` in the save. The game's hangar shows
 * `paid` per hour as the plane's earning rate (see src/lib/fleet.ts).
 */
export interface FleetPlane {
  reg: string;
  /** The game's type id, such as "kite" or "zephyr". */
  type: string;
  /** The name the owner painted on it. */
  name?: string;
  /** The airport it's parked at. Unset while it flies. */
  at?: string;
  /** Hours flown, by every pilot. */
  hours: number;
  /** Net pay earned in it. A personal plane's counts this pilot's jobs since the game kept it. */
  paid?: number;
  /** A company plane's hours on paid jobs: the game divides `paid` by these. */
  paidH?: number;
  /** A company plane, rather than the pilot's own. */
  co: boolean;
}

/** What the game's airport database says about a code, from `__pilotsAir.byCode`. */
export interface AirportKind {
  name?: string;
  /** Helipad kind, such as "hospital" or "city". */
  pad?: string;
  /** Every runway is water: a seaplane base. */
  seaOnly?: boolean;
}

/** One landing, seen as the game's `op: "land"` request and the server's reply. */
export interface LandingEvent {
  t: number;
  pid: string;
  code: string;
  /** The job that was active before the landing, if any. */
  job?: JobInfo;
  airport?: AirportKind;
  result: {
    value?: number;
    total?: number;
    title?: string;
    /** First line of the landing report: [label, "$12,345"]. */
    line0?: [string, string];
  };
  tripId?: string;
  /** The plane flown: `data.plane` and its type, from the last save before the landing. */
  reg?: string;
  /** When the flight took off (`data.active.log.t0`). */
  t0?: number;
  planeType?: string;
}

/** The holder of an airport and its influence there, from the game's world data. */
export interface Held {
  co: string;
  v: number;
  tag?: string;
  name?: string;
}

/** What the game knows about one airport, sent when it is selected or is the current one. */
export interface AirportInfo {
  code: string;
  t: number;
  name?: string;
  kind?: AirportKind;
  /** Null: nobody holds it. Undefined: the world data wasn't loaded. */
  held?: Held | null;
  /** Selected (on the map or the job board), rather than the current airport or destination. */
  selected: boolean;
  /** Where it was selected. */
  via?: 'map' | 'board';
  /** The job to it that the game offers, read from the button the game draws. */
  job?: { pay: number; time?: string };
  /** A round trip: the place the job goes to before it returns here. */
  back?: string;
  /** Recent landings here by our company's pilots, newest first (no pay: the game has none). */
  landed?: { cs: string; t: number; me: boolean }[];
}

/** Company standings at one airport, from `/api/here` or `/api/standings`. */
export interface AirportStandings {
  code: string;
  t: number;
  holder?: string;
  list: { id: string; value: number }[];
  cos: Record<string, { name?: string; tag?: string }>;
}

/** One delivery in the Pocket Kneeboard's own record. */
export interface LedgerEntry {
  t: number;
  code: string;
  name?: string;
  /** Base pay of the job: the influence it adds when `counted`. */
  pay: number;
  counted: boolean;
  /** Why the delivery does not count, such as "helipad (hospital)". */
  why?: string;
  /** What the game's airport database says the place is, when it can't be held. */
  facility?: 'helipad' | 'seaplane';
  job?: string;
  kind?: string;
  /**
   * Where `pay` came from: the server's `value`, the report's first line, the board, `manual`:
   * the pilot ticked "This was me" for a rise in the company total it didn't log, or `log`: the
   * landing log (a flight from another device).
   */
  src: 'value' | 'report' | 'board' | 'manual' | 'log';
  /** From the log, not counted: no pay known, or the rise was shared with a teammate. */
  pending?: 'unknown' | 'teammate';
  /** For `pending`: the log's even share of the rise, a guess. */
  est?: number;
  /** For `teammate`: who shared the rise. */
  mates?: string[];
  /** The log saw the pilot reach the weekly limit here with this landing. */
  capped?: boolean;
  /** The plane flown, when known. */
  reg?: string;
  /** When the flight took off, when known. */
  t0?: number;
  /** Where the flight came from, when known. */
  from?: string;
  /** For a job to a helipad, ship or rig and back: its kind ("remote", "ship", …). */
  pad?: string;
  /** Net pay: the landing report's total, after bonuses and fees. Only for landings seen here. */
  net?: number;
}

export interface Ledger {
  pid: string;
  /** When this browser started to record. Nothing before it is known. */
  since: number;
  entries: LedgerEntry[];
  /** Landings (with or without a job) this browser saw, per airport. */
  seen: Record<string, number>;
  /** `visited[code].n` when recording started, per airport. */
  base: Record<string, number>;
}

/** Messages from the page hook, relayed by the bridge to the background worker. */
export type HookMessage =
  | { type: 'snapshot'; payload: Snapshot }
  | { type: 'landing'; payload: LandingEvent }
  | { type: 'standings'; payload: AirportStandings }
  | { type: 'airport'; payload: AirportInfo }
  /** The map card or job board that selected an airport closed. */
  | { type: 'unselected'; payload: { t: number } };

/** Messages from the side panel to the background worker. */
export type PanelMessage =
  | { type: 'claim'; payload: { pid: string; code: string; name?: string; pay: number; t: number } }
  | { type: 'unclaim'; payload: { pid: string; code: string; since: number } }
  | { type: 'log' }
  /** Replaces every `kb:*` record with a backup's (see src/lib/backup.ts). */
  | { type: 'restore'; payload: { text: string } };

/** The landing log for the pilot's company, as last downloaded. */
export interface LogState {
  co: string;
  /** Where it came from. Unset when the company has no log. */
  url?: string;
  /** When it was last asked for. */
  t: number;
  /** The log, from the last download that worked. */
  log?: import('./log').CompanyLog;
  /** Why the last download failed. */
  error?: string;
}

/** The airport selected on the map or the job board, and the job to it. */
export interface Selected {
  code: string;
  t: number;
  via?: 'map' | 'board';
  job?: { pay: number; time?: string };
  back?: string;
}

/** Our company's total at one airport, each time the Pocket Kneeboard saw it. Newest last. */
export type TotalsHistory = Record<string, { t: number; v: number }[]>;

export const KEYS = {
  live: 'kb:live',
  standings: 'kb:standings',
  airports: 'kb:airports',
  selected: 'kb:selected',
  prefs: 'kb:prefs',
  debug: 'kb:debug',
  totals: 'kb:totals',
  ledger: (pid: string) => `kb:ledger:${pid}`,
  log: 'kb:log',
  fleet: 'kb:fleet',
  /** When a landing at each airport was last seen (see src/lib/origin.ts). */
  landed: 'kb:landed',
} as const;

/** Each plane's hours and pay, each time they changed. Oldest first. */
export type FleetHistory = Record<string, FleetSample[]>;
export interface FleetSample {
  t: number;
  hours: number;
  paid?: number;
  paidH?: number;
}

export interface Prefs {
  /** Print size, from 0.5 to 1.5. Unset: 1. */
  zoom?: number;
  /** The side panel page that was open last. */
  page?: string;
  /** The landing log's URL, with `{id}` for the company id. Unset: no log. */
  logUrl?: string;
}
