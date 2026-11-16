import '@fontsource/caveat/latin-500.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/courier-prime/latin-400.css';
import '@fontsource/ibm-plex-sans-condensed/latin-400.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-700.css';
import './style.css';

import { WEEKLY_CAP, emptyTally, tallyAll, unseenLandings, weekStart, type Tally } from '@/lib/ledger';
import { afterJob, holdSummary, type HoldSummary, type JobOutcome } from '@/lib/hold';
import { unlogged } from '@/lib/totals';
import { withLog } from '@/lib/log';
import { FLEET_WINDOW, lifetimeRate, perHour, planeLandings, planeWindow, type PlaneWindow } from '@/lib/fleet';
import { backupJson, describeBackup, makeBackup, parseBackup, type Backup } from '@/lib/backup';
import { netsFromDebug, weekFlights, type FlightRow } from '@/lib/flights';
import {
  KEYS,
  type AirportInfo,
  type AirportStandings,
  type FleetHistory,
  type FleetPlane,
  type Ledger,
  type LogState,
  type PanelMessage,
  type Prefs,
  type Selected,
  type Snapshot,
  type TotalsHistory,
} from '@/lib/types';

const FORM = 'FAA Form 7233-KB';
const EDITION = '(11-26)';
const VERSION = chrome.runtime.getManifest().version;
/**
 * A selection older than this is no longer shown. The page hook resends a selection each minute
 * while it stays open, and says when it closes; this covers a close it couldn't report.
 */
const SELECTED_FOR = 3 * 60_000;
/** More blank lines than any sheet holds: a sheet of a list takes as many as fit. */
const MAX_BLANK_LINES = 60;

interface State {
  live?: Snapshot;
  /** The pilot's ledger with their landings from the landing log merged in. */
  ledger?: Ledger;
  log?: LogState;
  /** Net pay of recent landings by job id, from the debug record, for older ledger entries. */
  nets: Map<string, number>;
  standings: Record<string, AirportStandings>;
  airports: Record<string, AirportInfo>;
  totals: TotalsHistory;
  fleet: FleetHistory;
  selected?: Selected;
  prefs: Prefs;
}

interface Page {
  id: string;
  /** The tab it's filed under. The sheets of the flight log share one tab, and so do the fleet's. */
  tab: string;
  /** The tab's label, and a shorter one for a narrow clipboard, shown as written ("ARPTs"). */
  label: string;
  short?: string;
  /** This page's sheet in its tab, and how many sheets the tab holds. */
  sheet: number;
  sheets: number;
  html: string;
}

// --- Small helpers ----------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number) => Math.round(n).toLocaleString('en-US');
const thousands = (n: number) => (n / 1000).toFixed(1);

/**
 * Pen on paper: a small tilt and shift for each field. The tilt comes from `seed` (the field's
 * identity), not from the text, so a figure that changes keeps its angle. Long text tilts less,
 * so its end doesn't drift out of the box.
 */
function hand(text: string, cls = '', seed: string = cls + text.replace(/[\d,.$%]+/g, '#')) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const tilt = 1.2 * Math.min(1, 12 / Math.max(1, text.length));
  const rot = (((h >>> 0) % 23) / 22) * 2 * tilt - tilt;
  const dy = ((h >>> 5) % 3) - 1;
  return `<span class="hw ${cls}" style="--r:${rot.toFixed(2)}deg;--dy:${dy}px">${esc(text)}</span>`;
}

const typed = (text: string) => `<span class="typed">${esc(text)}</span>`;

function ago(t: number, now: number) {
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const dateUtc = (t: number) =>
  new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();

const box = (n: string | number, label: string, body: string, cls = '') =>
  `<div class="box ${cls}"><div class="lbl"><b>${n}.</b> ${label}</div><div class="val">${body}</div></div>`;

const cb = (on: boolean) => `<i class="cb">${on ? hand('X', 'x') : ''}</i>`;

/**
 * 25 bubbles, one for each $10,000, in five groups of five. `add` is a job on offer: the bubbles
 * it would fill are shaded lightly in pencil, after the filled ones.
 */
function bubbles(value: number, add = 0, cls = '') {
  const per = WEEKLY_CAP / 25;
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  let html = '';
  for (let g = 0; g < 5; g++) {
    html += `<div class="group">`;
    for (let i = 0; i < 5; i++) {
      const k = g * 5 + i;
      const fill = Math.max(0, Math.min(1, (value - k * per) / per));
      const to = Math.max(0, Math.min(1, (value + add - k * per) / per));
      const vars: string[] = [];
      if (fill > 0 && fill < 1) vars.push(`--fill:${pct(fill)}`);
      if (to > fill) vars.push(`--from:${pct(fill)}`, `--to:${pct(to)}`);
      const style = vars.length ? ` style="${vars.join(';')}"` : '';
      const kind = [fill >= 1 ? 'full' : fill > 0 ? 'part' : '', to > fill ? 'add' : ''].filter(Boolean).join(' ');
      html += `<i class="bubble ${kind}"${style}></i>`;
    }
    html += `<small>${(g + 1) * 50}K</small></div>`;
  }
  return `<div class="bubbles ${cls}">${html}</div>`;
}

function line(n: number, text: string, amount: string, cls = '', unit: 'usd' | 'pct' = 'usd') {
  const amt = unit === 'usd' ? `<i>$</i>${amount}` : `${amount}<i>%</i>`;
  return `<div class="line ${cls}"><span class="ln">${n}</span><span class="txt">${text}</span><span class="dots"></span><span class="amt">${amt}</span></div>`;
}

/** Keeps the form's number in `html` from wrapping at its hyphen. */
const whole = (html: string) => html.replace(FORM, `<span class="form-no">${FORM}</span>`);

function formHead(title: string, sub: string, right = 'Form Approved<br>OMB No. 2120-0250') {
  return `<header class="form-head">
    <div class="agency">U.S. Department of Transportation<br><b>Federal Aviation Administration</b></div>
    <div class="form-title"><b>${whole(title)}</b><small>${whole(sub)}</small></div>
    <div class="omb">${right}</div>
  </header>`;
}

/** The footer of sheet `page` of a tab's `of`: "Page 1", or "Page 1 of 3" when the tab has several. */
const footer = (page: number, of: number) =>
  `<footer><span>${FORM} ${EDITION} v${esc(VERSION)} · Previous editions are obsolete</span><span>Page ${page}${of > 1 ? ` of ${of}` : ''}</span></footer>`;

// --- Airport facts ----------------------------------------------------------------------------

function nameOf(s: State, code: string, tally?: Tally) {
  const l = s.live;
  return (
    (l?.at?.code === code && l.at.name) ||
    (l?.active?.dest?.code === code && l.active.dest.name) ||
    (l?.active?.job?.to === code && l.active.job.toName) ||
    l?.visited[code]?.name ||
    s.airports[code]?.name ||
    tally?.name ||
    ''
  );
}

/** The last line of an airport part: our lead, or what it takes to hold or take the airport. */
function holdLine(n: number, us: string, hold: HoldSummary | undefined, nobody: boolean | undefined) {
  if (hold?.weHold) {
    const over = hold.lead?.over ? ` over ${esc(hold.lead.over)}` : '';
    return line(n, `<b>${esc(us)} lead</b>${over}`, hold.lead ? hand(money(hold.lead.by)) : '', 'total');
  }
  if (hold?.holder) {
    const amount = hold.need ? hand(money(hold.need.amount)) : '';
    return line(n, `<b>${esc(us)} needs</b>, to take it from ${esc(hold.holder.tag)}`, amount, 'total');
  }
  if (nobody) {
    return line(n, `<b>${esc(us)} needs</b>, to hold it ($2,000 min.)`, hold?.need ? hand(money(hold.need.amount)) : '', 'total');
  }
  return line(n, `<b>Hold</b> <span class="when">(open the airport on the map)</span>`, '', 'total');
}

// --- Page 1: the worksheet --------------------------------------------------------------------

/** What delivering the selected job would do: the "result" line. */
function jobLine(n: number, us: string, hold: HoldSummary, out: JobOutcome, nobody: boolean) {
  if (out.after === undefined) return line(n, `<b>Result</b> <span class="when">(waiting for the standings)</span>`, '');
  if (out.flips && nobody) return line(n, `<b>Result</b>: ${esc(us)} holds it ✓, total`, hand(money(out.after), '', 'after'), 'total');
  if (out.flips) {
    return line(n, `<b>Result</b>: takes it from ${esc(hold.holder?.tag ?? '?')} ✓, lead`, hand(money(out.lead ?? 0), '', 'after'), 'total');
  }
  if (out.holds) return line(n, `<b>Result</b>: ${esc(us)} lead`, out.lead !== undefined ? hand(money(out.lead), '', 'after') : '', 'total');
  return line(n, `<b>Result</b>: still short by`, hand(money(out.short ?? 0), '', 'after'), 'total');
}

const clock = (t: number, now: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
  return now - t < 18 * 3_600_000 ? time : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
};

/** Ruled lines in each part's remarks. */
const REMARK_LINES = 4;

/**
 * The remarks for one airport, most important first, one per ruled line: the company total's
 * rise this week and how much of it this browser logged, with "This was me" to claim the rest;
 * the last flight here; who from the company landed here; missed landings. A remark too long for
 * its line ends in "…", with the whole text in its tooltip.
 */
function partRemarks(s: State, code: string | undefined, now: number, extra: string[] = []) {
  if (!code) return '';
  const us = s.live?.coTag ?? 'Company';
  const items: string[] = [];
  const note = (t: string, i: number) => hand(t, 'remark', `remark${i}`).replace('<span ', `<span title="${esc(t)}" `);

  const u = unlogged(s.totals, s.ledger, code, now);
  if (u && u.rise > 0) {
    const notMine = u.others > 0 ? `, $${money(u.others)} not` : '';
    items.push(note(`${us} here +$${money(u.rise)} since ${clock(u.from.t, now)}: $${money(u.mine)} logged as mine${notMine}.`, 0));
    if (u.others > 0) {
      items.push(`<button type="button" class="claim" data-claim="${esc(code)}">${cb(false)}This was me ${hand(`$${money(u.others)}`, '', 'claim')} <small>(adds it to my influence)</small></button>`);
    }
    if (u.claimed > 0) {
      items.push(`<button type="button" class="claim" data-unclaim="${esc(code)}">${cb(true)}This was me ${hand(`$${money(u.claimed)}`, '', 'claimed')} <small>(untick to take it back)</small></button>`);
    }
  }
  // Landings from other devices (the landing log) that don't count yet.
  const week = weekStart(now);
  const pending = (s.ledger?.entries ?? []).filter((e) => e.code === code && e.pending && e.t >= week);
  for (const e of pending.filter((e) => e.pending === 'teammate')) {
    const est = e.est ? `≈$${money(e.est)}` : 'pay ?';
    items.push(note(`Other device ${clock(e.t, now)}: shared with ${(e.mates ?? []).join(', ')}, ${est}, not counted.`, 5));
  }
  const unknown = pending.filter((e) => e.pending === 'unknown').length;
  if (unknown) items.push(note(`${unknown} flight${unknown > 1 ? 's' : ''} here from another device, pay not known.`, 6));
  extra.forEach((t, i) => items.push(note(t, 10 + i)));
  // Uncounted landings from the log have their own remark above.
  const last = s.ledger?.entries.filter((e) => e.code === code && e.src !== 'manual' && !e.pending).at(-1);
  const device = last?.src === 'log' ? ' (other device)' : '';
  if (last) items.push(note(`Last flight here${device}: $${money(last.pay)}${last.counted ? '' : ` (${last.why}, no credit)`}, ${ago(last.t, now)}.`, 20));
  const landed = s.airports[code]?.landed ?? [];
  if (landed.length) {
    const list = landed.slice(0, 4).map((l) => `${l.me ? 'me' : l.cs} ${clock(l.t, now)}`).join(', ');
    items.push(note(`${us} landed here: ${list}${landed.length > 4 ? ` +${landed.length - 4}` : ''}.`, 21));
  }
  const unseen = unseenLandings(s.ledger, s.live)[code];
  if (unseen) items.push(note(`${unseen} landing${unseen > 1 ? 's' : ''} here I didn’t see (other device?).`, 22));
  if (!items.length && s.live) items.push(note('No flights logged here yet.', 23));
  return items.slice(0, REMARK_LINES).join('');
}

/** A job to an airport part's airport: one on offer, or the one being flown. */
interface Offer {
  job?: { pay: number; time?: string };
  /** A round trip: the place it goes to before it lands back here. */
  back?: string;
  /** Where it was seen, for the job's line: "job board", "map", "flying it". */
  via: string;
}

function airportPart(s: State, code: string | undefined, num: { n: number }, now: number, compact = false, offer?: Offer) {
  const t = code ? (tallyAll(s.ledger, now).get(code) ?? emptyTally(code)) : emptyTally('');
  const name = code ? nameOf(s, code, t) : '';
  const st = code ? s.standings[code] : undefined;
  const info = code ? s.airports[code] : undefined;
  const hold = code ? holdSummary(s.live?.co, st, info?.held) : undefined;
  const us = s.live?.coTag ?? 'Company';
  const nobody = !hold?.holder && (info?.held === null || (!!st && !st.holder));
  const heldBy = hold?.holder
    ? hand(hold.holder.tag + (hold.weHold ? ' ✓' : ''), 'fit', 'held')
    : nobody
      ? hand('nobody', 'fit', 'held')
      : '';
  const n = () => num.n++;
  const extra: string[] = [];

  let html = `<div class="row r-ident">
      ${box(n(), 'Ident', code ? hand(code, 'big', 'ident') : '')}
      ${box(n(), 'Airport name', name ? hand(name, 'fit', 'name') : '')}
      ${box(n(), 'Held by', heldBy)}
    </div>`;
  // The job on offer here, or the one being flown here, and what it would do.
  const job = compact ? offer?.job : undefined;
  const voidHere = !!(info?.kind?.pad || info?.kind?.seaOnly);
  const out = job && hold && !voidHere ? afterJob(hold, job.pay, t.room) : undefined;
  const adds = out?.counted ?? 0;

  const capped = t.thisWeek >= WEEKLY_CAP;
  const stamp = capped ? `<div class="stamp capped" aria-label="Capped: weekly limit reached">Capped<small>Weekly limit reached</small></div>` : '';
  const label = adds
    ? `Your flights this week, <span class="adds">and this job (shaded)</span> · one bubble per $10,000`
    : 'Your flights this week · one bubble per $10,000 · limit $250,000';
  html += `<div class="row${capped ? ' has-stamp' : ''}">${box(n(), label, bubbles(t.thisWeek, adds))}${stamp}</div>`;

  html += `<div class="lines">`;
  const l1 = n();
  html += line(l1, '<b>Your influence</b> this week', hand(money(t.thisWeek), 'circled', 'this'), 'total');
  if (!compact) html += line(n(), `Room left ($250,000 − ${l1})`, hand(money(t.room), '', 'room'));
  const ours = hold?.ours;
  const share = !compact && ours ? `you ${Math.min(999, Math.round((t.thisWeek / ours) * 100))}%, ` : '';
  const when = st ? ` <span class="when">(${share}${esc(ago(st.t, now))})</span>` : '';
  html += line(n(), `${esc(us)} total here${when}`, ours !== undefined ? hand(money(ours), '', 'ours') : '');
  html += holdLine(n(), us, hold, nobody);

  // The job's line, and whether it would win the airport.
  if (job && hold) {
    const trip = offer?.back ? `to ${esc(offer.back)} &amp; back` : 'here';
    html += line(n(), `Job ${trip} <span class="when">(${esc(job.time ?? offer?.via ?? '')})</span>`, hand(money(job.pay), '', 'job'));
    if (!out) {
      html += line(n(), `<b>Result</b>: no change, ${info?.kind?.pad ? 'helipads' : 'seaplane bases'} count for no one`, '', 'total');
    } else {
      html += jobLine(n(), us, hold, out, !!nobody);
      if (out.counted < job.pay) extra.push(`Only $${money(out.counted)} of this job counts: your weekly limit here.`);
    }
  } else if (compact && code) {
    html += line(n(), `Job here <span class="when">(none offered)</span>`, '');
  }
  html += `</div>`;
  if (t.facility) html += `<div class="void">VOID · ${t.facility === 'helipad' ? 'helipad' : 'seaplane base'} · counts for no one</div>`;
  else if (t.noCredit) extra.push(`Plus $${money(t.noCredit)} in ${t.why ?? 'pad'} jobs here, which count for no one.`);

  const r = n();
  html += `<div class="row notes">${box(r, 'Remarks', partRemarks(s, code, now, extra), 'remarks ruled')}</div>`;
  return html;
}

function worksheet(s: State, now: number): string {
  const l = s.live;
  const enRoute = !l?.at && !!l?.active?.dest;
  const dest = l?.active?.dest;
  // Part II follows the airport selected on the map or job board, even when it's the one Part I
  // shows. With nothing selected it shows the destination in flight, and nothing on the ground.
  const sel = s.selected && now - s.selected.t < SELECTED_FOR ? s.selected : undefined;
  const selVia = sel?.back ? 'round trip on the job board' : sel?.via === 'board' ? 'on the job board' : 'on the map';
  const flown = l?.active?.job;
  const partI = enRoute
    ? `Part I — Origin <span class="sub">(en route to ${esc(dest?.code ?? '…')})</span>`
    : 'Part I — Current location';
  let partII: string;
  let other: string | undefined;
  let offer: Offer | undefined;
  if (sel) {
    partII = `Part II — Selected airport <span class="sub">(${selVia})</span>`;
    other = sel.code;
    offer = { job: sel.job, back: sel.back, via: sel.via === 'board' ? 'job board' : 'map' };
  } else if (enRoute) {
    partII = `Part II — Destination <span class="sub">(from ${esc(l?.active?.from?.code ?? '…')})</span>`;
    other = dest?.code;
    // The job being flown lands here: its pay is on the save's active job.
    const pay = flown?.to === other ? flown?.pay : undefined;
    offer = { job: pay ? { pay } : undefined, via: 'flying it' };
  } else {
    partII = 'Part II — Selected airport <span class="sub">(pick one on the map or job board)</span>';
  }
  return `
    ${formHead('Pilot’s Airport Influence Worksheet', 'Pocket Pilots · Holding airports')}
    <div class="row r-pilot">
      ${box(1, 'Pilot', l?.callsign ? hand(l.callsign, 'big', 'pilot') : '')}
      ${box(2, 'Company', l?.coTag ? hand(l.coTag, 'big', 'co') : l ? hand('none') : '')}
      ${box(3, 'Week beginning', `${typed(dateUtc(weekStart(now)))} <span class="zulu">${typed('0000Z')}</span>`)}
    </div>
    ${
      l
        ? ''
        : `<div class="not-started"><span>Form not started</span>${hand('Open Pocket Pilots in this tab and sign in. I’ll fill this in as you fly.', 'remark')}</div>`
    }
    <h2 class="bar">${partI}</h2>
    ${airportPart(s, enRoute ? l?.active?.from?.code : l?.at?.code, { n: 4 }, now)}
    <h2 class="bar">${partII}</h2>
    ${airportPart(s, other, { n: 30 }, now, true, offer)}
    <div class="grow"></div>
    <p class="see">${logNote(s, now)}</p>
    ${footer(1, 1)}`;
}

/** The worksheet's footnote: the landing log's state, or the usual one. */
function logNote(s: State, now: number) {
  const l = s.log;
  if (l && !l.url) return 'No landing log for your company: flights on other devices aren’t counted. See the instructions.';
  if (l?.error) return `Landing log unreachable (${esc(l.error)})${l.log ? `; last copy ${esc(ago(l.log.updated, now))}` : ''}. See the instructions.`;
  return 'Figures are estimates worked out in this browser, not read from the server. See the instructions.';
}

// --- Airports: every airport flown to this week ------------------------------------------------

/** A row with nothing that counts: only pad jobs, or a place that can't be held. */
const noCredit = (t: Tally) => !!t.facility || (t.thisRaw === 0 && !t.pending && !t.capped);

function airportSheets(s: State, now: number): string[] {
  // Only airports flown to this week: last week's landings don't count toward this week's limit.
  const week = weekStart(now);
  const flown = new Set(s.ledger?.entries.filter((e) => e.t >= week).map((e) => e.code));
  const rows = [...tallyAll(s.ledger, now).values()]
    .filter((t) => flown.has(t.code))
    .sort((a, b) => (noCredit(a) ? 1 : 0) - (noCredit(b) ? 1 : 0) || b.thisWeek - a.thisWeek);
  const total = rows.reduce((a, t) => a + t.thisWeek, 0);
  const unseen = Object.entries(unseenLandings(s.ledger, s.live)).sort(([, a], [, b]) => b - a);
  const listed = unseen.slice(0, 4).map(([c, n]) => `${c} ×${n}`).join(', ');
  const more = unseen.length > 4 ? ` and ${unseen.length - 4} more` : '';
  const remarks: string[] = [];
  if (unseen.length) remarks.push(`${listed}${more}: landings in your logbook this Pocket Kneeboard didn’t see (other device?). Not counted.`);
  if (s.log?.log) remarks.push(`Landing log updated ${ago(s.log.log.updated, now)}.`);
  const remark = remarks.map((r, i) => hand(r, 'remark', `sched${i}`)).join('');

  return listSheets(rows, (chunk, i, last, lines) => {
    let body = '';
    for (const t of chunk) {
      const nc = noCredit(t);
      body += `<tr${nc ? ' class="nc"' : ''}>
        <td>${hand(t.code, 'fit')}</td>
        <td>${hand(nameOf(s, t.code, t), 'fit')}</td>
        <td class="num">${nc ? hand('N/C') : hand(thousands(t.thisWeek))}${!nc && t.pending && !t.capped ? '<sup class="q" title="Flights from another device with no pay known yet">+?</sup>' : ''}</td>
        <td class="num">${nc ? '' : hand(thousands(t.room))}</td>
        <td>${nc ? '' : `<span class="meter" style="--fill:${(t.thisWeek / WEEKLY_CAP) * 100}%"></span>`}</td>
      </tr>`;
    }
    body += blankRows(lines - chunk.length, 5);
    return `
      ${formHead('Airports', `Influence by airport · attach to ${FORM}`, `OMB No. 2120-0250<br><b>Attachment<br>Sequence No. 0${i + 1}</b>`)}
      <table class="ledger">
        <caption>This week · amounts in thousands of dollars</caption>
        <thead><tr><th>Ident</th><th>Airport name</th><th>This wk</th><th>Room left</th><th>Of $250K</th></tr></thead>
        <tbody>${body}</tbody>
        ${last ? `<tfoot><tr><td colspan="2">Total, all airports</td><td class="num">${hand(thousands(total))}</td><td></td><td></td></tr></tfoot>` : ''}
      </table>
      ${remarksBox(remark)}`;
  });
}

// --- The log: every flight this week ------------------------------------------------------------

/** The weekday and time ("Mon", "14:29"), in the browser's time zone. */
const weekday = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short' });
const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** A plane's painted name, or its type, for a reg. */
function planeName(s: State, reg: string | undefined) {
  if (!reg) return '';
  const p = s.live?.fleet?.find((x) => x.reg === reg);
  if (!p) return reg;
  return p.name ? p.name.charAt(0) + p.name.slice(1).toLowerCase() : typeName(p.type);
}

function logRowHtml(s: State, f: FlightRow): string {
  const other = f.other ? '<sup class="q" title="Flown on another device: from the landing log">*</sup>' : '';
  const when = `<td class="sub"><small>${esc(weekday(f.t))}</small>${hand(hhmm(f.t), '', 'when')}${other}</td>`;
  if (f.status === 'claim') {
    return `<tr>${when}<td colspan="3" class="sub"><small>This was me</small>${hand(`Rise at ${f.to}`, 'fit')}</td><td class="num">${hand(thousands(f.influence))}</td></tr>`;
  }
  const from = f.pad && f.from === f.to ? `round trip, ${f.pad}` : f.from ? `from ${f.from}` : '';
  const where = [f.name, f.pad ? `round trip to a ${f.pad} pad` : ''].filter(Boolean).join(' · ');
  let infl: string;
  if (f.status === 'nc') infl = `<span class="nc" title="${esc(f.why ?? 'counts for no one')}">${hand('N/C')}</span>`;
  else if (f.status === 'unknown') infl = `<span title="The landing log couldn’t measure it">${hand('?', 'dash')}</span>`;
  else if (f.status === 'teammate') {
    infl = `${hand(thousands(f.influence))}<sup class="q" title="Shared a rise with a teammate: the log’s even split, a guess">≈</sup>`;
  } else {
    const cap = f.influence < f.pay ? `<sup class="q" title="Only $${money(f.influence)} of $${money(f.pay)} counted: your weekly limit here">cap</sup>` : '';
    infl = hand(thousands(f.influence)) + cap;
  }
  return `<tr title="${esc(where)}">
    ${when}
    <td class="sub"><small>${esc(from)}</small>${hand(f.to, 'fit', 'to')}</td>
    <td>${hand(planeName(s, f.reg), 'fit', `plane${f.reg}`)}</td>
    <td class="num">${f.net !== undefined ? hand(thousands(f.net)) : hand('—', 'dash')}</td>
    <td class="num">${infl}</td>
  </tr>`;
}

function logSheets(s: State, now: number): string[] {
  const rows = weekFlights(s.ledger, now, s.nets);
  const flights = rows.filter((f) => f.status !== 'claim');
  const net = flights.reduce((a, f) => a + (f.net ?? 0), 0);
  const infl = rows.reduce((a, f) => a + (f.status === 'counted' || f.status === 'claim' ? f.influence : 0), 0);
  const remarks: string[] = [];
  if (!rows.length) remarks.push(s.live ? 'No flights logged this week yet.' : 'Open Pocket Pilots in this tab and sign in. I’ll log your flights.');
  if (s.log?.log) remarks.push(`Landing log updated ${ago(s.log.log.updated, now)}.`);
  const remark = remarks.map((r, i) => hand(r, 'remark', `log${i}`)).join('');

  return listSheets(rows, (chunk, i, last, lines) => {
    let body = chunk.map((f) => logRowHtml(s, f)).join('') + blankRows(lines - chunk.length, 5);
    const n = flights.length;
    const foot = `<tfoot><tr><td colspan="3">Total, ${n} flight${n === 1 ? '' : 's'}</td><td class="num">${hand(thousands(net))}</td><td class="num">${hand(thousands(infl))}</td></tr></tfoot>`;
    return `
      ${formHead('Pilot’s Log', `Flights this week · attach to ${FORM}`, `OMB No. 2120-0250<br><b>Attachment<br>Sequence No. 0${i + 1}</b>`)}
      <table class="ledger flights">
        <caption>This week, newest first · amounts in thousands of dollars</caption>
        <thead><tr><th>When</th><th>To</th><th>Plane</th><th>Net</th><th>Infl.</th></tr></thead>
        <tbody>${body}</tbody>
        ${last ? foot : ''}
      </table>
      ${remarksBox(remark)}`;
  });
}

// --- The fleet: earnings and influence per plane ------------------------------------------------

/** "kite" → "Kite", "skyliner" → "Skyliner": the game's type ids are its names in lower case. */
const typeName = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);
/** Dollars per hour in thousands, or a dash when there are too few hours to say. */
const rate = (v: number | null, est = false) =>
  v === null ? hand('—', 'dash') : hand(thousands(v)) + (est ? '<sup class="q" title="Part of it is the landing log’s even split of a shared rise">≈</sup>' : '');

type FleetRow =
  | { kind: 'head'; label: string }
  | { kind: 'plane'; p: FleetPlane; w: PlaneWindow; mine: boolean }
  | { kind: 'total'; label: string; rows: { p: FleetPlane; w: PlaneWindow }[] };

function fleetRowHtml(r: FleetRow): string {
  if (r.kind === 'head') return `<tr class="sect"><th colspan="5">${esc(r.label)}</th></tr>`;
  if (r.kind === 'plane') {
    const { p, w } = r;
    const what = [typeName(p.type), p.reg, r.mine ? 'flying it' : p.at ? `at ${p.at}` : 'aloft'].join(' · ');
    const name = p.name ? p.name.charAt(0) + p.name.slice(1).toLowerCase() : typeName(p.type);
    const tot = w.totals;
    const net = tot ? perHour(tot.paid, tot.rateHours) : null;
    const infl = perHour(w.influence, w.inflHours);
    const flights = w.landings ? ` · ${w.landings} landing${w.landings > 1 ? 's' : ''} in 7 days` : '';
    const unknown = w.unknown ? `<sup class="q" title="${w.unknown} landing${w.unknown > 1 ? 's' : ''} left out: influence or flight time not known">+?</sup>` : '';
    return `<tr title="${esc(`${what} · ${p.hours.toFixed(1)} h in all${flights}`)}">
      <td class="ac"><small>${esc(what)}</small>${hand(name, 'fit', `ac${p.reg}`)}</td>
      <td class="num">${tot ? hand(tot.hours.toFixed(1)) : ''}</td>
      <td class="num">${tot ? rate(net) : ''}</td>
      <td class="num">${rate(infl, w.est)}${unknown}</td>
      <td class="num">${rate(lifetimeRate(p))}</td>
    </tr>`;
  }
  // Each total is the sum of the pay over the sum of the hours, so a busy plane weighs more.
  const sum = (f: (x: { p: FleetPlane; w: PlaneWindow }) => number | undefined) => r.rows.reduce((a, x) => a + (f(x) ?? 0), 0);
  const withPay = r.rows.filter((x) => x.w.totals?.paid !== undefined);
  const net = perHour(sum((x) => x.w.totals?.paid), withPay.reduce((a, x) => a + x.w.totals!.rateHours, 0));
  const infl = perHour(sum((x) => x.w.influence), sum((x) => x.w.inflHours));
  const life = r.rows.filter((x) => lifetimeRate(x.p) !== null);
  const lifeRate = perHour(
    life.reduce((a, x) => a + x.p.paid!, 0),
    life.reduce((a, x) => a + (x.p.co ? x.p.paidH! : x.p.hours), 0),
  );
  const t = (v: number | null) => (v === null ? '' : hand(thousands(v)));
  return `<tr class="sum"><td>${esc(r.label)}</td><td class="num">${hand(sum((x) => x.w.totals?.hours).toFixed(1))}</td>
    <td class="num">${t(net)}</td><td class="num">${t(infl)}</td><td class="num">${t(lifeRate)}</td></tr>`;
}

function fleetSheets(s: State, now: number): string[] {
  const l = s.live;
  const planes = l?.fleet ?? [];
  const landings = planeLandings(s.ledger, s.log?.log);
  const windows = new Map(planes.map((p) => [p.reg, planeWindow(p, s.fleet[p.reg], landings, now)]));
  const win = (p: FleetPlane) => windows.get(p.reg)!;
  // Busiest first: the recent net rate, then the game's own.
  const score = (p: FleetPlane) => {
    const t = win(p).totals;
    return [(t && perHour(t.paid, t.rateHours)) ?? -1, lifetimeRate(p) ?? -1] as const;
  };
  const order = (a: FleetPlane, b: FleetPlane) => {
    const [x1, x2] = score(a);
    const [y1, y2] = score(b);
    return y1 - x1 || y2 - x2;
  };
  const rows: FleetRow[] = [];
  const section = (label: string, list: FleetPlane[], total: string) => {
    if (!list.length) return;
    rows.push({ kind: 'head', label });
    for (const p of [...list].sort(order)) rows.push({ kind: 'plane', p, w: win(p), mine: p.reg === l?.plane });
    rows.push({ kind: 'total', label: total, rows: list.map((p) => ({ p, w: win(p) })) });
  };
  section('Section 1 — Your aircraft', planes.filter((p) => !p.co), 'Total, your aircraft');
  section(`Section 2 — ${l?.coTag ?? 'Company'} aircraft`, planes.filter((p) => p.co), 'Total, company aircraft');

  // Hours and pay start a week ago, or when sampling began, whichever is later.
  const from = Math.max(now - FLEET_WINDOW, Math.min(...[...windows.values()].map((w) => w.totals?.from ?? now)));
  const remarks: string[] = [];
  if (!l) remarks.push('Open Pocket Pilots in this tab and sign in. I’ll list your planes.');
  else if (!planes.length) remarks.push('No planes in your save yet.');
  else {
    if (from > now - FLEET_WINDOW + 60 * 60_000) remarks.push(`Hours, net/h: since ${clock(from, now)}, when I began to note your fleet.`);
    if (!s.log?.log) remarks.push('Infl./h counts only your landings: set a landing log in Settings for your teammates’ and other devices.');
  }
  const remark = remarks.map((r, i) => hand(r, 'remark', `fleet${i}`)).join('');

  return listSheets(rows, (chunk, i, last, lines) => {
    // Blank lines go above the company total that ends the list, never after it.
    const end = last && chunk.at(-1)?.kind === 'total' ? chunk.length - 1 : chunk.length;
    const body =
      chunk.slice(0, end).map(fleetRowHtml).join('') + blankRows(lines - chunk.length, 5) + chunk.slice(end).map(fleetRowHtml).join('');
  return `
      ${formHead('Fleet Report', `Earnings by aircraft · attach to ${FORM}`, `OMB No. 2120-0250<br><b>Attachment<br>Sequence No. ${String(i + 1).padStart(2, '0')}</b>`)}
      <table class="ledger fleet">
        <caption>Amounts in thousands of dollars per hour</caption>
        <thead>
          <tr><th rowspan="2">Aircraft</th><th colspan="3">Last 7 days</th><th rowspan="2">Life<br>net/h</th></tr>
          <tr><th>Hours</th><th>Net/h</th><th>Infl./h</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      ${remarksBox(remark)}`;
  }, (a, b) => a.kind !== 'head' && b.kind !== 'total'); // a heading stays with its first plane, a total with its last
}

// --- Instructions -----------------------------------------------------------------------------

/** The landing log's status and URL setting, on the settings page. */
function logForm(s: State) {
  const co = s.live?.co;
  const now = Date.now();
  const l = s.log;
  const status = !co
    ? 'Join a company to use a landing log.'
    : l?.error
      ? `Can’t read it: ${esc(l.error)}.`
      : l?.log
        ? `Working: updated ${esc(ago(l.log.updated, now))}, ${l.log.landings.length} landings.`
        : l?.url
          ? 'Not read yet.'
          : 'None set: flights on other devices aren’t counted.';
  return `<form class="log-form" data-log-form>
      <input type="url" name="url" placeholder="https://example.org/kneeboard/{id}.json"
        value="${esc(kept.get('logUrl') ?? s.prefs.logUrl ?? '')}" data-keep="logUrl" aria-label="Landing log URL" ${co ? '' : 'disabled'}>
      <button type="submit" ${co ? '' : 'disabled'}>Save</button>
    </form>
    <p class="small">${status}${co ? ` Your company: ${esc(s.live?.coTag ?? '?')}, id ${typed(co)}.` : ''}</p>`;
}

function instructions(s: State): string[] {
  const since = s.ledger ? typed(dateUtc(s.ledger.since)) : 'the day you installed it';
  // The same heading on every sheet, so a sheet's contents start at the same place on each.
  const head = () => formHead(`Instructions for ${FORM}`, 'Read before you rely on this form', 'Keep with<br>the form');
  return flow(head, 'instr', [
    `<h3>Purpose of this form</h3>
      <p>Pocket Pilots shows influence by <em>company</em>, never by pilot. This form shows how much
      is <em>yours</em>, and how close you are to the $250,000 a pilot can add at one airport in a
      week.</p>`,
    `<h3>How the figures are worked out</h3>
      <p>At each landing, the Pocket Kneeboard reads the report. A flight adds the job’s
      <b>base pay</b> (the report’s first line) at the airport where it lands. Bonuses, fees and
      fuel don’t count. Helipads and seaplane bases count for no one. Weeks start Monday 00:00 UTC,
      and each week you can add up to $250,000 at each airport. This form tracks this week only:
      half of last week also counts, but it’s already in the company totals the game shows.</p>`,
    `<h3>These are estimates</h3>
      <p>Only company totals and holders come from the game; the rest is worked out here. A game
      update can change the rules.</p>`,
    `<h3>What is missing</h3>
      <ul>
        <li><b>Flights before ${since}.</b> The game keeps no history by pilot. After two full weeks
        the figures are complete.</li>
        <li><b>Flights on another device</b>, without a landing log (below). <em>Remarks</em> show
        a rise your flights don’t explain; tick <b>This was me</b> to count it.</li>
      </ul>`,
    `<h3>Flights from other devices</h3>
      <p class="ragged">A script on a server can log every landing by your company, with the
      influence it added. A flight counts when it was yours alone. Run
      <span class="typed">server/kneeboard_poll.py</span> under cron, or ask whoever runs one for
      its URL, and enter it in <b>Settings</b> (the gear).</p>`,
    `<h3>Log, Airports and Fleet</h3>
      <p><b>Log</b> lists each flight this week with its net pay and the influence it added.
      <b>Airports</b> adds them up by airport. <b>Fleet</b> gives net pay and influence per hour
      for each plane, over the last 7 days and, for pay, its whole life as the game counts it.</p>`,
    `<h3>Marks and columns</h3>
      <dl class="marks">
        <dt><span class="mark">+?</span></dt><dd><b>Airports:</b> flights from another device whose
        influence isn’t known yet. <b>Fleet:</b> some landings are left out because their influence
        or flight time is unknown.</dd>
        <dt><span class="mark">*</span></dt><dd><b>Log:</b> flown on another device. Its net pay
        isn’t known.</dd>
        <dt><span class="mark">≈</span></dt><dd><b>Log:</b> landed alongside a teammate, so the
        landing log split the rise between you evenly, a guess. It isn’t in the total.
        <b>Fleet:</b> part of the influence is such a split.</dd>
        <dt><span class="mark">cap</span></dt><dd>Only part of the pay counted, since you hit the
        weekly cap.</dd>
        <dt>?</dt><dd>Influence not measured.</dd>
        <dt>N/C</dt><dd>Not counted: a helipad or seaplane base.</dd>
        <dt>—</dt><dd>Not known, or too few hours to say.</dd>
        <dt>Net</dt><dd>Your personal net income from the flight: the report’s total. It includes
        bonuses and awards, and takes off the company’s share, fees, and in your own plane fuel and
        maintenance.</dd>
        <dt>Infl.</dt><dd>Base pay before adjustments, which counts for influence at an airport up to
        your weekly limit there.</dd>
        <dt>Hours</dt><dd>Hours flown in the last 7 days, or since the Pocket Kneeboard was
        installed.</dd>
        <dt>Net/h</dt><dd>Net pay over those hours. For a company plane, what it earned for every
        pilot who flew it.</dd>
        <dt>Infl./h</dt><dd>Influence of a plane’s landings in the last 7 days, over those flights’
        hours. With a landing log set up, it includes your teammates’ landings in that plane.</dd>
        <dt>Life</dt><dd>Net pay per hour over the plane’s life, or for a company plane per hour
        of flights that delivered a job. The game shows the same rate per minute.</dd>
      </dl>`,
    `<h3>Paperwork Reduction Act notice</h3>
      <p class="small">This form is kept only in your browser. It reads your callsign, company,
      position, active job, landing counts, planes and company from the game’s save, never your
      sign-in. It asks the game for airport standings, and reads your company’s landing log.
      Estimated time to fill in: 0 minutes; it fills in itself.</p>`,
  ]);
}

// --- Settings ---------------------------------------------------------------------------------

/** Form values typed but not saved, kept across redraws: `data-keep` name → value. */
const kept = new Map<string, string>();

/** Backup and restore: a backup read and waiting to be confirmed, and the last outcome. */
const backupUi: { pending?: { text: string; backup: Backup }; status?: string; error?: boolean } = {};

function backupForm(): string {
  const p = backupUi.pending;
  let confirm = '';
  if (p) {
    const d = describeBackup(p.backup);
    const what = [`${d.records} record${d.records === 1 ? '' : 's'}`, `${d.flights} flight${d.flights === 1 ? '' : 's'}`];
    const of = d.pilot ? ` of ${esc(d.pilot)}` : '';
    const when = p.backup.exported ? `, made ${typed(dateUtc(p.backup.exported))}` : '';
    confirm = `<div class="confirm" role="alert">
        <p>Backup${of}${when} (v${esc(p.backup.version)}): ${what.join(', ')}. Restoring replaces every
        record in this browser with it.</p>
        <div class="buttons"><button type="button" class="btn primary" data-backup="restore">Restore it</button>
        <button type="button" class="btn" data-backup="cancel">Cancel</button></div>
      </div>`;
  }
  const status = backupUi.status ? `<p class="small status${backupUi.error ? ' bad' : ''}" role="status">${esc(backupUi.status)}</p>` : '';
  return `
    <div class="buttons">
      <button type="button" class="btn" data-backup="download">Download backup</button>
      <button type="button" class="btn" data-backup="copy">Copy to clipboard</button>
    </div>
    <p class="ragged">To restore, choose a backup file, or paste one below.</p>
    <div class="buttons">
      <label class="btn">Choose file…<input type="file" accept=".json,application/json" data-restore-file hidden></label>
    </div>
    <textarea data-keep="paste" rows="3" spellcheck="false" placeholder="Paste a backup here" aria-label="Pasted backup">${esc(kept.get('paste') ?? '')}</textarea>
    <div class="buttons"><button type="button" class="btn" data-backup="paste">Read pasted backup</button></div>
    ${confirm}${status}`;
}

function settings(s: State): string[] {
  const zoom = zoomOf(s);
  const head = () => formHead('Settings', `Preferences for ${FORM}`, 'Keep with<br>the form');
  return flow(head, 'instr settings', [
    `<h3>Print size</h3>
      <div class="size">
        <button type="button" data-zoom="-1" aria-label="Smaller print" ${zoom <= ZOOM_MIN ? 'disabled' : ''}>A−</button>
        ${typed(`${Math.round(zoom * 100)}%`)}
        <button type="button" data-zoom="1" aria-label="Larger print" ${zoom >= ZOOM_MAX ? 'disabled' : ''}>A+</button>
        <span class="small">Makes the whole form larger or smaller, from 50% to 150%.</span>
      </div>`,
    `<h3>Landing log</h3>
      <p class="ragged">Its URL, with <span class="typed">{id}</span> for your company’s id. See the instructions.</p>
      ${logForm(s)}`,
    `<h3>Backup and restore</h3>
      <p class="ragged">Your records are kept only in this browser. A backup holds all of them, to keep or to
      move to another browser. It holds no sign-in data.</p>
      ${backupForm()}`,
  ]);
}

// --- Sheets -----------------------------------------------------------------------------------

/** A hidden clipboard the size of the real one, for measuring what fits on a sheet. */
let probe: HTMLElement | undefined;

/**
 * Lays sections of a page out on as many sheets as they need: each sheet takes as many whole
 * sections as fit under its heading, measured on a hidden sheet of the same size and print size.
 * `head(i)` is sheet i's heading; `cls` the class of the box around the sections.
 */
function flow(head: (i: number) => string, cls: string, sections: string[]): string[] {
  const page = (i: number, parts: string[]) => `${head(i)}<div class="${cls}">${parts.join('')}</div><div class="grow"></div>`;
  const sheets: string[][] = [[]];
  for (const part of sections) {
    const cur = sheets.at(-1)!;
    if (cur.length && !fits(page(sheets.length - 1, [...cur, part]))) sheets.push([part]);
    else cur.push(part);
  }
  return sheets.map((parts, i) => page(i, parts));
}

/**
 * Whether `html` fits on a sheet, with room for the footer, measured on
 * a hidden sheet of the same size and print size.
 */
function fits(html: string): boolean {
  probe ??= Object.assign(document.body.appendChild(document.createElement('div')), {
    className: 'board probe',
    innerHTML: '<div class="stack"><section class="sheet"></section></div><nav class="tabs"></nav>',
  });
  probe.setAttribute('aria-hidden', 'true');
  const sheet = probe.querySelector<HTMLElement>('.sheet')!;
  sheet.innerHTML = html + footer(9, 9);
  const ok = sheet.scrollHeight <= sheet.clientHeight;
  sheet.innerHTML = '';
  return ok;
}

/**
 * Lays a list out on as many sheets as it needs. `sheet(chunk, i, last, lines)` draws sheet i: a
 * table of its rows and blank lines up to `lines`, and under it the remarks, which every sheet
 * repeats. Each sheet takes as many rows as fit (at least one), and fills the rest with blank
 * lines. Only the last sheet has the totals, so it's measured as the last.
 * `apart(a, b)` says whether a sheet may end between rows a and b, such as a heading and its
 * first row: when not, the sheet ends sooner.
 */
function listSheets<T>(
  rows: T[],
  sheet: (chunk: T[], i: number, last: boolean, lines: number) => string,
  apart: (a: T, b: T) => boolean = () => true,
): string[] {
  const out: string[] = [];
  let rest = rows;
  do {
    const i = out.length;
    const take = (n: number) => rest.slice(0, n);
    let n = most(1, rest.length, (k) => fits(sheet(take(k), i, k === rest.length, k)));
    for (let k = n; k > 1 && k < rest.length; k--) {
      if (apart(rest[k - 1]!, rest[k]!)) {
        n = k;
        break;
      }
    }
    const chunk = take(n);
    rest = rest.slice(n);
    const last = !rest.length;
    const lines = most(chunk.length, chunk.length + MAX_BLANK_LINES, (k) => fits(sheet(chunk, i, last, k)));
    out.push(sheet(chunk, i, last, lines));
  } while (rest.length);
  return out;
}

/** The largest n from lo to hi for which ok(n) holds, given that it holds up to some point; lo if none. */
function most(lo: number, hi: number, ok: (n: number) => boolean): number {
  if (hi <= lo) return Math.max(lo, hi);
  if (ok(hi)) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** `n` blank ruled lines of a table `cols` wide. */
const blankRows = (n: number, cols: number) => `<tr class="blank">${'<td></td>'.repeat(cols)}</tr>`.repeat(Math.max(0, n));

/**
 * A list's remarks, under its table on each of its sheets, with as many ruled lines as they fill.
 * The table stretches to take the sliver its whole lines leave, so they end above the footer.
 */
const remarksBox = (remark: string) => `<div class="row remarks-row">${box('R', 'Remarks', remark, 'remarks ruled')}</div>`;

// --- The clipboard ----------------------------------------------------------------------------

/** A tab's first sheet has the tab's id as its page id; each later sheet's is `${tab}-${n}`. */
const sheetId = (tab: string, k: number) => (k === 0 ? tab : `${tab}-${k + 1}`);

function pages(s: State, now: number): Page[] {
  const list: Page[] = [];
  // Each tab files one or more sheets, numbered within the tab. With several, a strip above the
  // footer turns to the next or previous one.
  const tab = (id: string, label: string, short: string | undefined, sheets: string[]) =>
    sheets.forEach((html, i) =>
      list.push({
        id: sheetId(id, i),
        tab: id,
        label,
        short,
        sheet: i + 1,
        sheets: sheets.length,
        html: html + leaf(id, label, i, sheets.length) + footer(i + 1, sheets.length),
      }),
    );
  // The Flight page is always one sheet, with its footer built in.
  list.push({ id: 'worksheet', tab: 'worksheet', label: 'Flight', sheet: 1, sheets: 1, html: worksheet(s, now) });
  tab('log', 'Log', undefined, logSheets(s, now));
  tab('airports', 'Airports', 'ARPTs', airportSheets(s, now));
  tab('fleet', 'Fleet', undefined, fleetSheets(s, now));
  tab('instructions', 'Instructions', 'HELP', instructions(s));
  tab('settings', 'Settings', undefined, settings(s));
  return list;
}

/**
 * Turning a tab's sheets: "prev" or "next" scribbled in pen near the bottom corner, with an arrow
 * that runs out and arcs down onto the sheet's curled corner. Word, arrow and curl are one link, so hovering
 * any of them lifts the corner. None on a single sheet. They're drawn over the sheet just above
 * the footer, mostly in its blank margin, and take no room.
 */
function leaf(tab: string, label: string, i: number, n: number) {
  if (n < 2) return '';
  const turn = (dir: 'prev' | 'next', k: number, what: string) =>
    `<button type="button" class="turn ${dir}" data-page="${sheetId(tab, k)}" aria-label="${what}">${SCRIBBLE[dir]}<span class="curl">${CURL}</span></button>`;
  const prev = i > 0 ? turn('prev', i - 1, `Previous ${esc(label)} sheet (${i} of ${n})`) : '';
  const next = i < n - 1 ? turn('next', i + 1, `Next ${esc(label)} sheet (${i + 2} of ${n})`) : '';
  return `<div class="leaf">${prev}${next}</div>`;
}

/**
 * "next" and "prev" in pen, each with an arrow that runs out level and arcs down onto the
 * curled corner below it. Drawn for a 74 × 22 box whose bottom corner sits just above the curl. The
 * #scrawl filter (index.html) gives the strokes a ballpoint's wobble.
 */
const SCRIBBLE = {
  next: `<svg class="scribble" viewBox="0 0 74 22" aria-hidden="true">
    <g filter="url(#scrawl)">
      <text x="1" y="15" transform="rotate(-4 14 12)">next</text>
      <path d="M30.5 10.5 C 50 9.5, 65.5 9, 67 21"/>
      <path d="M62.2 16.8 L 67 21.5 L 70.6 15.6"/>
    </g>
  </svg>`,
  prev: `<svg class="scribble" viewBox="0 0 74 22" aria-hidden="true">
    <g filter="url(#scrawl)">
      <text x="44" y="15" transform="rotate(3 58 12)">prev</text>
      <path d="M43.5 10.5 C 24 9.5, 8.5 9, 7 21"/>
      <path d="M11.8 16.8 L 7 21.5 L 3.4 15.6"/>
    </g>
  </svg>`,
};

/**
 * A sheet's corner lifted on a curve, drawn for the bottom-right corner (the bottom-left one is
 * its mirror image). The fold bows across the corner; past it, the sheet underneath shows, and
 * the back of the paper rolls over as a shaded crescent, lit along its edge.
 */
const CURL = `<svg viewBox="0 0 20 44" preserveAspectRatio="none" aria-hidden="true">
  <path class="under" d="M20 0 C17 14 11 30 0 44 L20 44 Z"/>
  <path class="back" d="M20 0 C17 14 11 30 0 44 C9 40 14.5 33 17 24 C18.6 17 19.6 9 20 0 Z" fill="url(#curl-back)"/>
  <path class="edge" d="M0 44 C9 40 14.5 33 17 24 C18.6 17 19.6 9 20 0" fill="none"/>
</svg>`;

/** A gear, for the settings tab. */
const GEAR = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54a7.4 7.4 0 0 0-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2"/></svg>`;

/** Page ids from before 0.3.0, when the airports list was "Schedule A". */
const OLD_PAGE = /^schedule-a(-\d+)?$/;

function render(s: State) {
  const now = Date.now();
  fitBoard(zoomOf(s));
  const all = pages(s, now);
  const want = s.prefs.page?.replace(OLD_PAGE, 'airports$1');
  // A sheet that's gone (fewer airports or planes now) falls back to its tab's last sheet.
  const wantTab = want?.replace(/-\d+$/, '');
  const current = all.find((p) => p.id === want) ?? all.filter((p) => p.tab === wantTab).at(-1) ?? all[0]!;
  // One tab per kind of page. A tab with several sheets opens on the one it showed last (or, if
  // that sheet is gone, its last), else its first.
  const left = (tab: string) => {
    const id = s.prefs.sheets?.[tab];
    return id ? (all.find((p) => p.id === id) ?? all.filter((p) => p.tab === tab).at(-1)) : undefined;
  };
  const tabs = all.filter((p) => p.sheet === 1).map((p) => (current.tab === p.tab ? current : (left(p.tab) ?? p)));
  const app = document.getElementById('app')!;
  // Keep focus on the tab, corner or field that had it (a tab and a corner can point to the same page).
  const active = document.activeElement as HTMLElement | null;
  const focused = active?.dataset.page;
  const kind = active?.classList.contains('turn') ? `.turn.${active.classList.contains('next') ? 'next' : 'prev'}` : '[role="tab"]';
  const field = active?.dataset.keep;
  const caret = field && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? [active.selectionStart, active.selectionEnd] : undefined;

  app.innerHTML = `
  <div class="board">
    <div class="clip" aria-hidden="true"><i></i></div>
    <div class="stack">
      <section class="sheet" id="sheet" role="tabpanel" aria-labelledby="tab-${current.tab}">${current.html}</section>
    </div>
    <nav class="tabs" role="tablist" aria-label="Pages">
      ${tabs
        .map((p, i) => {
          const on = p === current;
          const attrs = `role="tab" id="tab-${p.tab}" data-page="${p.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}"`;
          if (p.tab === 'settings') return `<button type="button" ${attrs} class="tab gear" aria-label="${esc(p.label)}" title="${esc(p.label)}">${GEAR}</button>`;
          const label = p.short ? `<span class="long">${esc(p.label)}</span><span class="short">${esc(p.short)}</span>` : esc(p.label);
          return `<button type="button" ${attrs} class="tab t${i % 4}">${label}</button>`;
        })
        .join('')}
    </nav>
  </div>`;
  if (field) {
    const el = app.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${field}"]`);
    el?.focus();
    try {
      if (el && caret) el.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
    } catch {
      // A URL field has no selection to restore.
    }
  } else if (focused) app.querySelector<HTMLElement>(`${kind}[data-page="${focused}"]`)?.focus();
}

// --- Wiring -----------------------------------------------------------------------------------

async function load(): Promise<State> {
  const got = await chrome.storage.local.get([KEYS.live, KEYS.standings, KEYS.airports, KEYS.totals, KEYS.selected, KEYS.prefs, KEYS.log, KEYS.fleet, KEYS.debug]);
  const live = got[KEYS.live] as Snapshot | undefined;
  const ledgerKey = live ? KEYS.ledger(live.pid) : undefined;
  const saved = ledgerKey ? ((await chrome.storage.local.get(ledgerKey))[ledgerKey] as Ledger | undefined) : undefined;
  const log = got[KEYS.log] as LogState | undefined;
  const ledger = saved && log?.co === live?.co ? withLog(saved, log?.log, weekStart) : saved;
  const prefs = (got[KEYS.prefs] as Prefs | undefined) ?? {};
  return {
    live,
    ledger,
    standings: (got[KEYS.standings] as Record<string, AirportStandings> | undefined) ?? {},
    airports: (got[KEYS.airports] as Record<string, AirportInfo> | undefined) ?? {},
    totals: (got[KEYS.totals] as TotalsHistory | undefined) ?? {},
    fleet: (got[KEYS.fleet] as FleetHistory | undefined) ?? {},
    nets: netsFromDebug(got[KEYS.debug]),
    selected: got[KEYS.selected] as State['selected'],
    prefs,
    log: log?.co === live?.co ? log : undefined,
  };
}

let state: State | undefined;
const refresh = async () => {
  render((state = await load()));
  // The background downloads the landing log when it's a minute old.
  chrome.runtime.sendMessage({ kb: true, type: 'log' } satisfies { kb: true } & PanelMessage).catch(() => {});
};

/** Print size: CSS zoom on the whole clipboard, from 50% to 150% in steps of 10%. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const zoomOf = (s: State) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.prefs.zoom ?? 1));

/**
 * Sizes the clipboard: at most 840px tall and at least 800px (what the pages need), before
 * zoom. Inside a zoomed element CSS pixels are zoomed too, so the panel's height is divided by
 * the zoom to find the room there is. Below the minimum, the panel scrolls.
 */
function fitBoard(zoom: number) {
  const root = document.documentElement;
  root.style.setProperty('--zoom', String(zoom));
  root.style.setProperty('--board-h', `${Math.min(840, Math.max(800, (innerHeight - 16) / zoom))}px`);
  // Width the same way, measured after the height is set (it decides whether a scrollbar shows).
  root.style.setProperty('--board-w', `${Math.min(600, (root.clientWidth - 16) / zoom)}px`);
}
// A new size can move where long pages break onto another sheet, so lay them out again.
addEventListener('resize', () => state && render(state));
// Sheets are measured with the form's own fonts: once they load, measure again.
document.fonts.ready.then(() => state && render(state));

/** Opens page `id`, and notes it as the page its tab shows next time. */
function showPage(id: string | undefined) {
  if (!id || !state) return;
  const tab = id.replace(/-\d+$/, '');
  setPrefs({ page: id, sheets: { ...state.prefs.sheets, [tab]: id } });
}

function setPrefs(p: Partial<Prefs>) {
  if (!state) return;
  state.prefs = { ...state.prefs, ...p };
  render(state); // at once, without waiting for storage
  chrome.storage.local.set({ [KEYS.prefs]: state.prefs });
}

document.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const size = el.closest<HTMLButtonElement>('[data-zoom]');
  if (size && state) {
    const next = Math.round((zoomOf(state) + Number(size.dataset.zoom) / 10) * 10) / 10;
    return setPrefs({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) });
  }
  const backup = el.closest<HTMLElement>('[data-backup]');
  if (backup) return backupAction(backup.dataset.backup!);
  const claimBox = el.closest<HTMLElement>('[data-claim], [data-unclaim]');
  if (claimBox && state?.live) return toggleClaim(state, claimBox);
  const tab = el.closest<HTMLElement>('[data-page]');
  if (tab) showPage(tab.dataset.page);
});

/** "This was me": claims (or gives back) the rise in the company total this browser didn't log. */
function toggleClaim(s: State, el: HTMLElement) {
  const pid = s.live!.pid;
  const now = Date.now();
  if (el.dataset.unclaim) {
    const msg: PanelMessage = { type: 'unclaim', payload: { pid, code: el.dataset.unclaim, since: weekStart(now) } };
    return chrome.runtime.sendMessage({ kb: true, ...msg });
  }
  const code = el.dataset.claim!;
  const u = unlogged(s.totals, s.ledger, code, now);
  if (!u || u.others <= 0) return;
  const name = s.airports[code]?.name ?? nameOf(s, code);
  const msg: PanelMessage = { type: 'claim', payload: { pid, code, name, pay: u.others, t: u.to.t } };
  return chrome.runtime.sendMessage({ kb: true, ...msg });
}

document.addEventListener('submit', async (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-log-form]');
  if (!form || !state) return;
  e.preventDefault();
  const raw = (new FormData(form).get('url') as string | null)?.trim() ?? '';
  if (raw) {
    let origin: string;
    try {
      origin = new URL(raw.replaceAll('{id}', 'x')).origin;
    } catch {
      return form.querySelector('input')?.setCustomValidity('Not a URL'), form.reportValidity();
    }
    const ok = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    if (!ok) return;
  }
  kept.delete('logUrl');
  setPrefs({ logUrl: raw || undefined });
  chrome.runtime.sendMessage({ kb: true, type: 'log' }).catch(() => {});
});

// Typed values survive the redraws that storage changes cause.
document.addEventListener('input', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement | HTMLTextAreaElement>('[data-keep]');
  if (el) kept.set(el.dataset.keep!, el.value);
});

// --- Backup and restore -----------------------------------------------------------------------

const redraw = (status?: string, error = false) => {
  backupUi.status = status;
  backupUi.error = error;
  if (state) render(state);
};

async function backupText() {
  const all = await chrome.storage.local.get(null);
  const b = makeBackup(all, VERSION, Date.now());
  return { text: backupJson(b), records: Object.keys(b.data).length };
}

/** Reads a backup to restore, and asks to confirm it. */
function stage(text: string) {
  try {
    backupUi.pending = { text, backup: parseBackup(text) };
    redraw();
  } catch (e) {
    backupUi.pending = undefined;
    redraw(e instanceof Error ? e.message : String(e), true);
  }
}

async function backupAction(what: string) {
  try {
    if (what === 'download') {
      const { text, records } = await backupText();
      const name = `pocket-kneeboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return redraw(`Saved ${records} records as ${name}.`);
    }
    if (what === 'copy') {
      const { text, records } = await backupText();
      await navigator.clipboard.writeText(text);
      return redraw(`Copied ${records} records to the clipboard. Paste them somewhere safe.`);
    }
    if (what === 'paste') {
      const text = (kept.get('paste') ?? '').trim();
      return text ? stage(text) : redraw('Paste a backup in the box first.', true);
    }
    if (what === 'cancel') {
      backupUi.pending = undefined;
      return redraw();
    }
    if (what === 'restore' && backupUi.pending) {
      const { text, backup } = backupUi.pending;
      const res = (await chrome.runtime.sendMessage({ kb: true, type: 'restore', payload: { text } } satisfies { kb: true } & PanelMessage)) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (!res?.ok) return redraw(`Not restored: ${res?.error ?? 'no reply from the extension'}.`, true);
      backupUi.pending = undefined;
      kept.delete('paste');
      kept.delete('logUrl');
      const { records } = describeBackup(backup);
      // The log's site needs this browser's permission, which a backup can't bring along.
      const url = (backup.data[KEYS.prefs] as Prefs | undefined)?.logUrl;
      let origin: string | undefined;
      try {
        origin = url ? new URL(url.replaceAll('{id}', 'x')).origin : undefined;
      } catch {
        origin = undefined;
      }
      const allowed = origin ? await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false) : true;
      const more = allowed ? '' : ' Press Save next to the landing log’s URL to let this browser read it.';
      return redraw(`Restored ${records} records.${more}`);
    }
  } catch (e) {
    redraw(e instanceof Error ? e.message : String(e), true);
  }
}

document.addEventListener('change', async (e) => {
  const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-restore-file]');
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 20_000_000) return redraw('That file is too big to be a backup.', true);
  stage(await file.text());
});

document.addEventListener('keydown', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.indexOf(tab);
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  showPage(tabs[next]!.dataset.page);
  document.querySelector<HTMLElement>(`[role="tab"][data-page="${tabs[next]!.dataset.page}"]`)?.focus();
});

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && refresh());
setInterval(refresh, 30_000);
refresh();
