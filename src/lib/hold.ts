// Who holds an airport, and what it would take to hold or take it.
//
// In-game help: the company with the most influence at an airport holds it, and a company needs
// at least $2,000 there to hold it.

import type { AirportStandings, Held } from './types';

export const MIN_TO_HOLD = 2_000;

export interface HoldSummary {
  holder?: { id: string; tag: string; value?: number };
  weHold: boolean;
  /** Our company's influence here. Undefined when no standings say. */
  ours?: number;
  /** When we hold it: how far ahead of the next company we are. */
  lead?: { over?: string; by: number };
  /** When we don't: how much more we need to hold it, and from whom we would take it. */
  need?: { from?: string; amount: number };
}

const tagOf = (id: string, st?: AirportStandings, held?: Held | null) =>
  st?.cos[id]?.tag ?? (held?.co === id ? held.tag : undefined) ?? id.slice(0, 4).toUpperCase();

export interface JobOutcome {
  /** The part of the job's pay that counts: no more than the room left under the weekly limit. */
  counted: number;
  /** Our company's total after the job. Undefined when our total isn't known. */
  after?: number;
  /** We hold the airport after the job (whether or not we held it before). */
  holds?: boolean;
  /** The job takes the airport from someone, or wins an airport nobody held. */
  flips?: boolean;
  /** When we hold it after the job: the lead over the next company. */
  lead?: number;
  /** When we don't: how much more we would still need. */
  short?: number;
}

/** What delivering a job of `pay` to the airport would do, given what we know of it. */
export function afterJob(hold: HoldSummary, pay: number, room: number): JobOutcome {
  const counted = Math.max(0, Math.min(pay, room));
  if (hold.ours === undefined) return { counted };
  const after = hold.ours + counted;
  if (hold.weHold) {
    return { counted, after, holds: true, flips: false, lead: hold.lead ? hold.lead.by + counted : undefined };
  }
  const need = hold.need?.amount ?? 0;
  if (counted >= need) {
    const rival = hold.holder?.value ?? 0;
    return { counted, after, holds: true, flips: true, lead: after - rival };
  }
  return { counted, after, holds: false, flips: false, short: need - counted };
}

/**
 * Combines the airport's standings (complete, when we have them) with the world data's holder
 * (always there once the game has loaded it).
 */
export function holdSummary(co: string | undefined, st?: AirportStandings, held?: Held | null): HoldSummary {
  const list = [...(st?.list ?? [])].sort((a, b) => b.value - a.value);
  // `/api/standings` replies carry no holder (only `/api/here` does), so fall back to the
  // company with the most, if it has enough to hold the airport.
  const top = list[0] && list[0].value >= MIN_TO_HOLD ? list[0].id : undefined;
  const holderId = held?.co ?? st?.holder ?? top;
  const holderValue = holderId ? (list.find((r) => r.id === holderId)?.value ?? (held?.co === holderId ? held.v : undefined)) : undefined;
  const weHold = !!co && holderId === co;

  let ours: number | undefined;
  if (st && co) ours = list.find((r) => r.id === co)?.value ?? 0;
  else if (weHold) ours = holderValue;

  const out: HoldSummary = { weHold, ours };
  if (holderId) out.holder = { id: holderId, tag: tagOf(holderId, st, held), value: holderValue };

  if (weHold) {
    if (st) {
      const next = list.find((r) => r.id !== co);
      out.lead = { over: next ? tagOf(next.id, st, held) : undefined, by: (ours ?? 0) - (next?.value ?? 0) };
    }
  } else if (ours !== undefined) {
    const target = Math.max(MIN_TO_HOLD, (holderValue ?? list[0]?.value ?? 0) + 1);
    out.need = { from: out.holder?.tag, amount: Math.max(0, target - ours) };
  }
  return out;
}
