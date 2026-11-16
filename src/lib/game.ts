// Readers for the game's save and API replies. Each one picks named fields from untrusted JSON
// and drops everything else, so no account value can pass through.

import type { AirportInfo, AirportKind, AirportStandings, FleetPlane, Held, JobInfo, LandingEvent, Place, Snapshot } from './types';

export const SAVE_KEY = 'flash.save.main';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 200 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function place(v: unknown): Place | undefined {
  if (!isObj(v)) return undefined;
  const code = str(v.code);
  return code ? { code, name: str(v.name) } : undefined;
}

function job(v: unknown): JobInfo | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id);
  const to = str(v.to);
  if (!id || !to) return undefined;
  return {
    id,
    to,
    from: str(v.from),
    toName: str(v.toName),
    kind: str(v.kind),
    pay: num(v.pay),
    pad: str(v.pad),
  };
}

/** Reads one plane of `data.fleet` or `data.company.fleet`. */
function plane(v: unknown, co: boolean): FleetPlane | undefined {
  if (!isObj(v)) return undefined;
  const reg = str(v.reg);
  const type = str(v.type);
  const hours = num(v.hours);
  if (!reg || !type || hours === undefined) return undefined;
  const out: FleetPlane = { reg, type, hours, co };
  const name = str(v.name);
  if (name) out.name = name;
  const at = isObj(v.at) ? str(v.at.code) : undefined;
  if (at) out.at = at;
  const paid = num(v.paid);
  if (paid !== undefined) out.paid = paid;
  const paidH = num(v.paidH);
  if (paidH !== undefined) out.paidH = paidH;
  return out;
}

/** Reads the parts of the save the Pocket Kneeboard needs. Returns null for anything unexpected. */
export function snapshotFromSave(raw: string | null): Snapshot | null {
  if (!raw) return null;
  let save: unknown;
  try {
    save = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(save) || !isObj(save.data)) return null;
  const d = save.data;
  const pid = str(d.pid);
  if (!pid) return null;

  const visited: Snapshot['visited'] = {};
  if (isObj(d.visited)) {
    for (const [code, v] of Object.entries(d.visited)) {
      if (isObj(v) && num(v.n) !== undefined) visited[code] = { n: v.n as number, name: str(v.name) };
    }
  }

  let active: Snapshot['active'] = null;
  if (isObj(d.active)) {
    // `active.ts` is when the game last wrote the flight, not when it took off: `log.t0` is that.
    const t0 = isObj(d.active.log) ? num(d.active.log.t0) : undefined;
    active = { id: str(d.active.id), from: place(d.active.from), dest: place(d.active.dest), job: job(d.active.job), t0 };
  }

  const company = isObj(d.company) ? d.company : undefined;
  // Only the plane fields: `data.company` also holds the invite code, which must not be copied.
  const fleet: FleetPlane[] = [];
  const add = (list: unknown, co: boolean) => {
    if (!Array.isArray(list)) return;
    for (const f of list.slice(0, 200)) {
      const p = plane(f, co);
      if (p && !fleet.some((x) => x.reg === p.reg)) fleet.push(p);
    }
  };
  add(d.fleet, false);
  // As the game does: the company's planes only while the pilot is still its member.
  if (company && str(d.co) && company.id === d.co) add(company.fleet, true);
  return {
    t: num(save.t) ?? 0,
    schema: num(save.v) ?? 0,
    pid,
    callsign: str(d.callsign),
    co: str(d.co),
    coName: company ? str(company.name) : undefined,
    coTag: company ? str(company.tag) : undefined,
    at: place(d.at) ?? null,
    active,
    visited,
    plane: str(d.plane),
    fleet,
  };
}

/** Reads one entry of the game's airport database (`__pilotsAir.byCode`). */
export function airportKind(a: unknown): AirportKind | undefined {
  if (!isObj(a)) return undefined;
  const out: AirportKind = { name: str(a.name) };
  if (isObj(a.pad)) out.pad = str(a.pad.kind) ?? 'helipad';
  const rw = Array.isArray(a.rw) ? a.rw : [];
  if (a.sea && rw.length > 0 && rw.every((r) => isObj(r) && r.water === true)) out.seaOnly = true;
  return out;
}

/** False for a helipad or a seaplane base: a landing there counts for no one. */
export function holdable(kind: AirportKind | undefined): boolean {
  return !kind?.pad && !kind?.seaOnly;
}

/**
 * Whether a selection should replace the one Part II shows: any airport someone can hold, even
 * the one Part I shows (the user asked for Part II to follow every selection). Not a helipad or
 * a seaplane base, which leave the previous selection in place.
 */
export function replacesSelection(a: AirportInfo): boolean {
  return !!a.selected && holdable(a.kind);
}

/**
 * Reads who holds an airport from the game's world data (`__pilotsHere.world.d`). Its `held`
 * table has `{co, v}` for every held airport: the holder and the holder's influence there.
 * Returns null when nobody holds it, and undefined when the world data isn't loaded.
 */
export function heldFromWorld(world: unknown, code: string): Held | null | undefined {
  if (!isObj(world) || !isObj(world.held)) return undefined;
  const h = world.held[code];
  if (!isObj(h)) return null;
  const co = str(h.co);
  const v = num(h.v);
  if (!co || v === undefined) return null;
  const c = isObj(world.cos) && isObj(world.cos[co]) ? world.cos[co] : undefined;
  return { co, v, tag: c ? str(c.tag) : undefined, name: c ? str(c.name) : undefined };
}

/**
 * Recent landings at `code` by company `co`, from the game's map cache
 * (`__pilotsAirParts.cells`: a Map of map cells, each with a `landed` list). Each landing has the
 * callsign and time, but no pay. Newest first, at most `max`.
 */
export function landedAt(cells: unknown, code: string, co: string, pid: string, max = 8) {
  const out: { cs: string; t: number; me: boolean }[] = [];
  if (!(cells instanceof Map)) return out;
  const seen = new Set<string>();
  for (const cell of cells.values()) {
    if (!isObj(cell) || !Array.isArray(cell.landed)) continue;
    for (const l of cell.landed) {
      if (!isObj(l) || !isObj(l.at) || l.at.code !== code || l.co !== co) continue;
      const cs = str(l.cs);
      const t = num(l.t);
      if (!cs || t === undefined || seen.has(`${cs}|${t}`)) continue;
      seen.add(`${cs}|${t}`);
      out.push({ cs, t, me: l.pid === pid });
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, max);
}

/** Reads an `/api/here` or `/api/standings` reply. */
export function standingsFromReply(code: string, reply: unknown, t: number): AirportStandings | null {
  if (!isObj(reply)) return null;
  const rows = Array.isArray(reply.standings) ? reply.standings : Array.isArray(reply.list) ? reply.list : null;
  if (!rows) return null;
  const list: AirportStandings['list'] = [];
  for (const r of rows.slice(0, 20)) {
    const id = isObj(r) ? str(r.id) : undefined;
    const value = isObj(r) ? num(r.value) : undefined;
    if (id && value !== undefined) list.push({ id, value });
  }
  const cos: AirportStandings['cos'] = {};
  if (isObj(reply.cos)) {
    for (const { id } of list) {
      const c = reply.cos[id];
      if (isObj(c)) cos[id] = { name: str(c.name), tag: str(c.tag) };
    }
  }
  return { code, t, holder: str(reply.holder), list, cos };
}

/** Reads the `result` of an `op: "land"` reply from `/api/career`. */
export function landingResult(reply: unknown): LandingEvent['result'] | null {
  if (!isObj(reply) || !isObj(reply.result)) return null;
  const r = reply.result;
  const out: LandingEvent['result'] = { value: num(r.value), total: num(r.total), title: str(r.title) };
  const first = Array.isArray(r.lines) ? r.lines[0] : undefined;
  if (Array.isArray(first) && str(first[0]) !== undefined && str(first[1]) !== undefined) {
    out.line0 = [first[0] as string, first[1] as string];
  }
  return out;
}

// Text the game draws on its canvas, read for the selected job. These follow the game's wording
// (2026-11-15) and stop matching, harmlessly, if that changes.

/**
 * The job board's main button, first line: "Fly to EGNM", or "Fly leg 1 to EGDM" for a leg of a
 * route (since the game's update of 2026-11-15). Returns the airport code.
 */
export function boardButtonCode(text: string): string | undefined {
  return /^Fly (?:leg \d+ )?to ([A-Z0-9]{3,4}|[A-Z]{2}-[A-Z0-9]{2,6})$/.exec(text)?.[1];
}

/**
 * A round trip on the job board's button: "Fly to Supply ship & back", which the game may cut
 * short as "Fly to Supply ship & b…" or "Fly to Supply ship &…". Returns the place it goes to.
 * The delivery lands back at the current airport, so that is where its influence counts.
 */
export function boardButtonRoundTrip(text: string): string | undefined {
  return /^Fly to (.+?) &(?: b(?:a(?:ck?)?)?)?…?$/.exec(text)?.[1];
}

/** The job board's main button, second line: "$11,734 · 45m". */
export function boardButtonJob(text: string): { pay: number; time?: string } | undefined {
  const m = /^\$([\d,]+)(?: · (.+))?$/.exec(text);
  return m ? { pay: Number(m[1]!.replace(/,/g, '')), time: m[2] } : undefined;
}

/** The map card's button: "Fly it · $3,375 · 32m" (or "· 2 legs"). */
export function cardButtonJob(text: string): { pay: number; time?: string } | undefined {
  const m = /^Fly it · \$([\d,]+)(?: · (.+))?$/.exec(text);
  return m ? { pay: Number(m[1]!.replace(/,/g, '')), time: m[2] } : undefined;
}

/** "$27,760" → 27760, "−$500" → -500. The game writes negatives with U+2212. */
export function parseMoney(s: string | undefined): number | undefined {
  const m = s ? /^([−-]?)\$([\d,]+)$/.exec(s.trim()) : null;
  if (!m) return undefined;
  return (m[1] ? -1 : 1) * Number(m[2]!.replace(/,/g, ''));
}
