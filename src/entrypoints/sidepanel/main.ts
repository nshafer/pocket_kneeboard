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
import {
  KEYS,
  type AirportInfo,
  type AirportStandings,
  type Ledger,
  type PanelMessage,
  type Prefs,
  type Selected,
  type Snapshot,
  type TotalsHistory,
} from '@/lib/types';

const FORM = 'FAA Form 7233-KB';
const EDITION = '(11-26)';
const VERSION = chrome.runtime.getManifest().version;
/** A map selection older than this is no longer shown. */
const SELECTED_FOR = 30 * 60_000;
/** Ruled lines on one page of Schedule A. Longer lists continue on another page. */
const ROWS_PER_PAGE = 20;

interface State {
  live?: Snapshot;
  ledger?: Ledger;
  standings: Record<string, AirportStandings>;
  airports: Record<string, AirportInfo>;
  totals: TotalsHistory;
  selected?: Selected;
  prefs: Prefs;
}

interface Page {
  id: string;
  tab: string;
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

/** 25 bubbles, one for each $10,000, in five groups of five. */
function bubbles(value: number, cls = '') {
  const per = WEEKLY_CAP / 25;
  let html = '';
  for (let g = 0; g < 5; g++) {
    html += `<div class="group">`;
    for (let i = 0; i < 5; i++) {
      const k = g * 5 + i;
      const fill = Math.max(0, Math.min(1, (value - k * per) / per));
      const style = fill > 0 && fill < 1 ? ` style="--fill:${Math.round(fill * 100)}%"` : '';
      html += `<i class="bubble ${fill >= 1 ? 'full' : fill > 0 ? 'part' : ''}"${style}></i>`;
    }
    html += `<small>${(g + 1) * 50}K</small></div>`;
  }
  return `<div class="bubbles ${cls}">${html}</div>`;
}

function line(n: number, text: string, amount: string, cls = '', unit: 'usd' | 'pct' = 'usd') {
  const amt = unit === 'usd' ? `<i>$</i>${amount}` : `${amount}<i>%</i>`;
  return `<div class="line ${cls}"><span class="ln">${n}</span><span class="txt">${text}</span><span class="dots"></span><span class="amt">${amt}</span></div>`;
}

function formHead(title: string, sub: string, right = 'Form Approved<br>OMB No. 2120-0250') {
  return `<header class="form-head">
    <div class="agency">U.S. Department of Transportation<br><b>Federal Aviation Administration</b></div>
    <div class="form-title"><b>${title}</b><small>${sub}</small></div>
    <div class="omb">${right}</div>
  </header>`;
}

const footer = (page: number, of: number) =>
  `<footer><span>${FORM} ${EDITION} v${esc(VERSION)} · Previous editions are obsolete</span><span>Page ${page} of ${of}</span></footer>`;

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

/**
 * The remarks for one airport, most important first: the company total's rise this week and how
 * much of it this browser logged, with "This was me" to claim the rest; the last flight here; who
 * from the company landed here; missed landings. `brief` is for Part I, which has room for two
 * ruled lines. There, when there's a rise both to claim and to give back, the two check boxes
 * take both lines and the rise goes in small print.
 */
function partRemarks(s: State, code: string | undefined, now: number, extra: string[] = [], brief = false) {
  if (!code) return '';
  const us = s.live?.coTag ?? 'Company';
  const items: string[] = [];
  const note = (t: string, i: number) => hand(t, 'remark', `remark${i}`);

  const u = unlogged(s.totals, s.ledger, code, now);
  if (u && u.rise > 0) {
    const both = brief && u.others > 0 && u.claimed > 0;
    const notMine = u.others > 0 ? `, $${money(u.others)} not` : '';
    if (!both) items.push(note(`${us} here +$${money(u.rise)} since ${clock(u.from.t, now)}: $${money(u.mine)} logged as mine${notMine}.`, 0));
    const why = both ? `(${esc(us)} +$${money(u.rise)} here since ${clock(u.from.t, now)}, $${money(u.mine)} logged)` : '(adds it to my influence)';
    if (u.others > 0) {
      items.push(`<button type="button" class="claim" data-claim="${esc(code)}">${cb(false)}This was me ${hand(`$${money(u.others)}`, '', 'claim')} <small>${why}</small></button>`);
    }
    if (u.claimed > 0) {
      items.push(`<button type="button" class="claim" data-unclaim="${esc(code)}">${cb(true)}This was me ${hand(`$${money(u.claimed)}`, '', 'claimed')} <small>(untick to take it back)</small></button>`);
    }
  }
  extra.forEach((t, i) => items.push(note(t, 10 + i)));
  const last = s.ledger?.entries.filter((e) => e.code === code && e.src !== 'manual').at(-1);
  if (last) items.push(note(`Last flight here: $${money(last.pay)}${last.counted ? '' : ` (${last.why}, no credit)`}, ${ago(last.t, now)}.`, 20));
  const landed = s.airports[code]?.landed ?? [];
  if (landed.length) {
    const list = landed.slice(0, 4).map((l) => `${l.me ? 'me' : l.cs} ${clock(l.t, now)}`).join(', ');
    items.push(note(`${us} landed here: ${list}${landed.length > 4 ? ` +${landed.length - 4}` : ''}.`, 21));
  }
  const unseen = unseenLandings(s.ledger, s.live)[code];
  if (unseen) items.push(note(`${unseen} landing${unseen > 1 ? 's' : ''} here I didn’t see (other device?).`, 22));
  if (!items.length && s.live) items.push(note('No flights logged here yet.', 23));
  return (brief ? items.slice(0, 2) : items).join('');
}

function airportPart(s: State, code: string | undefined, num: { n: number }, now: number, compact = false, sel?: Selected) {
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
  const capped = t.thisWeek >= WEEKLY_CAP;
  const stamp = capped ? `<div class="stamp capped" aria-label="Capped: weekly limit reached">Capped<small>Weekly limit reached</small></div>` : '';
  html += `<div class="row${capped ? ' has-stamp' : ''}">${box(n(), 'Your flights this week · one bubble per $10,000 · limit $250,000', bubbles(t.thisWeek))}${stamp}</div>`;

  html += `<div class="lines">`;
  const l1 = n();
  html += line(l1, '<b>Your influence</b> this week', hand(money(t.thisWeek), 'circled', 'this'), 'total');
  if (!compact) html += line(n(), `Room left ($250,000 − ${l1})`, hand(money(t.room), '', 'room'));
  const ours = hold?.ours;
  const share = !compact && ours ? `you ${Math.min(999, Math.round((t.thisWeek / ours) * 100))}%, ` : '';
  const when = st ? ` <span class="when">(${share}${esc(ago(st.t, now))})</span>` : '';
  html += line(n(), `${esc(us)} total here${when}`, ours !== undefined ? hand(money(ours), '', 'ours') : '');
  html += holdLine(n(), us, hold, nobody);

  // The job the game offers to the selected airport, and whether it would win it.
  const job = compact && sel && sel.code === code ? sel.job : undefined;
  if (job && hold) {
    const trip = sel?.back ? `to ${esc(sel.back)} &amp; back` : 'here';
    html += line(n(), `Job ${trip} <span class="when">(${job.time ? esc(job.time) : sel?.via === 'board' ? 'job board' : 'map'})</span>`, hand(money(job.pay), '', 'job'));
    if (info?.kind?.pad || info?.kind?.seaOnly) {
      html += line(n(), `<b>Result</b>: no change, ${info.kind.pad ? 'helipads' : 'seaplane bases'} count for no one`, '', 'total');
    } else {
      const out = afterJob(hold, job.pay, t.room);
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
  html += `<div class="row ${compact ? 'grow' : 'notes'}">${box(r, 'Remarks', partRemarks(s, code, now, extra, !compact), 'remarks ruled')}</div>`;
  return html;
}

function worksheet(s: State, now: number, pageNo: number, pages: number): string {
  const l = s.live;
  const enRoute = !l?.at && !!l?.active?.dest;
  const primary = l?.at?.code ?? l?.active?.dest?.code;
  // Part II follows the latest selection, even when it's the airport Part I shows.
  const sel = s.selected && now - s.selected.t < SELECTED_FOR ? s.selected : undefined;
  const selVia = sel?.back ? 'round trip on the job board' : sel?.via === 'board' ? 'on the job board' : 'on the map';
  const partI = enRoute
    ? `Part I — Destination <span class="sub">(en route from ${esc(l?.active?.from?.code ?? '…')})</span>`
    : 'Part I — Present position';
  const zoom = zoomOf(s);

  return `
    ${formHead('Pilot’s Airport Influence Worksheet', 'Pocket Pilots · Holding airports')}
    <div class="row r-pilot">
      ${box(1, 'Pilot', l?.callsign ? hand(l.callsign, 'big', 'pilot') : '')}
      ${box(2, 'Company', l?.coTag ? hand(l.coTag, 'big', 'co') : l ? hand('none') : '')}
      ${box(3, 'Week beginning', `${typed(dateUtc(weekStart(now)))} <span class="zulu">${typed('0000Z')}</span>`)}
      <div class="box size"><div class="lbl"><b>4.</b> Print size</div><div class="val">
        <button type="button" data-zoom="-1" aria-label="Smaller print" ${zoom <= ZOOM_MIN ? 'disabled' : ''}>A−</button>
        ${typed(`${Math.round(zoom * 100)}%`)}
        <button type="button" data-zoom="1" aria-label="Larger print" ${zoom >= ZOOM_MAX ? 'disabled' : ''}>A+</button>
      </div></div>
    </div>
    ${
      l
        ? ''
        : `<div class="not-started"><span>Form not started</span>${hand('Open Pocket Pilots in this tab and sign in. I’ll fill this in as you fly.', 'remark')}</div>`
    }
    <h2 class="bar">${partI}</h2>
    ${airportPart(s, primary, { n: 5 }, now)}
    <h2 class="bar">Part II — Other airport <span class="sub">${sel ? `(selected ${selVia} ${esc(ago(sel.t, now))})` : '(pick one on the map or job board)'}</span></h2>
    ${airportPart(s, sel?.code, { n: 30 }, now, true, sel)}
    <p class="see">Figures are estimates worked out in this browser, not read from the server. See the instructions.</p>
    ${footer(pageNo, pages)}`;
}

// --- Schedule A: every airport ----------------------------------------------------------------

/** A row with nothing that counts: only pad jobs, or a place that can't be held. */
const noCredit = (t: Tally) => !!t.facility || t.thisRaw === 0;

function scheduleA(s: State, now: number): string[] {
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
  const remark = unseen.length
    ? hand(`${listed}${more}: landings in your logbook this Pocket Kneeboard didn’t see (other device?). Not counted.`, 'remark')
    : '';

  const chunks: Tally[][] = [];
  for (let i = 0; i < Math.max(1, rows.length); i += ROWS_PER_PAGE) chunks.push(rows.slice(i, i + ROWS_PER_PAGE));

  return chunks.map((chunk, i) => {
    const last = i === chunks.length - 1;
    let body = '';
    for (const t of chunk) {
      const nc = noCredit(t);
      body += `<tr${nc ? ' class="nc"' : ''}>
        <td>${hand(t.code, 'fit')}</td>
        <td>${hand(nameOf(s, t.code, t), 'fit')}</td>
        <td class="num">${nc ? hand('N/C') : hand(thousands(t.thisWeek))}</td>
        <td class="num">${nc ? '' : hand(thousands(t.room))}</td>
        <td>${nc ? '' : `<span class="meter" style="--fill:${(t.thisWeek / WEEKLY_CAP) * 100}%"></span>`}</td>
      </tr>`;
    }
    for (let r = chunk.length; r < ROWS_PER_PAGE; r++) body += `<tr class="blank">${'<td></td>'.repeat(5)}</tr>`;
    const cont = i > 0 ? ' (continued)' : '';
    return `
      ${formHead(`Schedule A${cont}`, `Influence by airport · attach to ${FORM}`, `OMB No. 2120-0250<br><b>Attachment<br>Sequence No. 0${i + 1}</b>`)}
      <table class="ledger">
        <caption>This week · amounts in thousands of dollars</caption>
        <thead><tr><th>Ident</th><th>Airport name</th><th>This wk</th><th>Room left</th><th>Of $250K</th></tr></thead>
        <tbody>${body}</tbody>
        ${last ? `<tfoot><tr><td colspan="2">Total, all airports</td><td class="num">${hand(thousands(total))}</td><td></td><td></td></tr></tfoot>` : ''}
      </table>
      ${
        last
          ? `<div class="row remarks-row grow">${box('R', 'Remarks', remark, 'remarks ruled')}</div>`
          : `<p class="see">Continued on the next page.</p><div class="grow"></div>`
      }`;
  });
}

// --- Instructions -----------------------------------------------------------------------------

function instructions(s: State): string {
  const since = s.ledger ? typed(dateUtc(s.ledger.since)) : 'the day you installed it';
  return `
    ${formHead(`Instructions for ${FORM}`, 'Read before you rely on this form', 'Keep with<br>the form')}
    <div class="instr">
      <h3>Purpose of this form</h3>
      <p>Pocket Pilots shows influence by <em>company</em>, never by pilot. This form shows how much
      is <em>yours</em>, and how close you are to the $250,000 a pilot can add at one airport in a
      week.</p>

      <h3>How the figures are worked out</h3>
      <p>At each landing, the Pocket Kneeboard reads the report. A flight adds the job’s
      <b>base pay</b> (the report’s first line) at the airport where it lands. Bonuses, fees and
      fuel don’t count. Helipads and seaplane bases count for no one. Weeks start Monday 00:00 UTC,
      and each week you can add up to $250,000 at each airport. This form tracks this week only. The
      game’s standings also carry half of last week’s influence, but that is already in the company
      totals it shows, and nothing you fly now can change it.</p>

      <h3>These are estimates</h3>
      <p>Only company totals and holders come from the game; the rest is worked out here, as you
      fly. Keep the Pocket Kneeboard open while you play. A game update can change the rules.</p>

      <h3>What is missing</h3>
      <ul>
        <li><b>Flights before ${since}.</b> The game keeps no history by pilot. After two full weeks
        the figures are complete.</li>
        <li><b>Flights on another device</b>, such as your phone. When your company’s total at an
        airport rose more than your logged flights explain, its <em>Remarks</em> say how much,
        and who landed there. Tick <b>This was me</b> to count it as yours; untick to take it
        back.</li>
      </ul>

      <h3>Paperwork Reduction Act notice</h3>
      <p class="small">This form is kept only in your browser. It reads your callsign, company,
      position, active job and landing counts from the game’s save, never your sign-in, and asks
      the game for airport standings. Estimated time to fill in: 0 minutes; it fills in itself. A
      pilot need not respond to a collection of information unless it displays a currently valid
      OMB control number.</p>
    </div>
    <div class="grow"></div>`;
}

// --- The clipboard ----------------------------------------------------------------------------

function pages(s: State, now: number): Page[] {
  const sched = scheduleA(s, now);
  const list: { id: string; tab: string; body: (n: number, of: number) => string }[] = [];
  list.push({ id: 'worksheet', tab: 'Worksheet', body: (n, of) => worksheet(s, now, n, of) });
  sched.forEach((html, i) =>
    list.push({
      id: i === 0 ? 'schedule-a' : `schedule-a-${i + 1}`,
      tab: i === 0 ? 'Sched. A' : `A (${i + 1})`,
      body: (n, of) => html + footer(n, of),
    }),
  );
  list.push({ id: 'instructions', tab: 'Instructions', body: (n, of) => instructions(s) + footer(n, of) });
  return list.map((p, i) => ({ id: p.id, tab: p.tab, html: p.body(i + 1, list.length) }));
}

function render(s: State) {
  const now = Date.now();
  fitBoard(zoomOf(s));
  const all = pages(s, now);
  const current = all.find((p) => p.id === s.prefs.page) ?? all[0]!;
  const app = document.getElementById('app')!;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.page;

  app.innerHTML = `
  <div class="board">
    <div class="clip" aria-hidden="true"><i></i></div>
    <div class="stack">
      <section class="sheet" id="sheet" role="tabpanel" aria-labelledby="tab-${current.id}">${current.html}</section>
    </div>
    <nav class="tabs" role="tablist" aria-label="Pages">
      ${all
        .map(
          (p, i) => `<button type="button" role="tab" id="tab-${p.id}" data-page="${p.id}"
            aria-selected="${p === current}" tabindex="${p === current ? 0 : -1}"
            class="tab t${i % 4}"><b>${i + 1}</b> ${esc(p.tab)}</button>`,
        )
        .join('')}
    </nav>
  </div>`;
  if (focused) app.querySelector<HTMLElement>(`[data-page="${focused}"]`)?.focus();
}

// --- Wiring -----------------------------------------------------------------------------------

async function load(): Promise<State> {
  const got = await chrome.storage.local.get([KEYS.live, KEYS.standings, KEYS.airports, KEYS.totals, KEYS.selected, KEYS.prefs]);
  const live = got[KEYS.live] as Snapshot | undefined;
  const ledgerKey = live ? KEYS.ledger(live.pid) : undefined;
  const ledger = ledgerKey ? ((await chrome.storage.local.get(ledgerKey))[ledgerKey] as Ledger | undefined) : undefined;
  const prefs = (got[KEYS.prefs] as Prefs | undefined) ?? {};
  return {
    live,
    ledger,
    standings: (got[KEYS.standings] as Record<string, AirportStandings> | undefined) ?? {},
    airports: (got[KEYS.airports] as Record<string, AirportInfo> | undefined) ?? {},
    totals: (got[KEYS.totals] as TotalsHistory | undefined) ?? {},
    selected: got[KEYS.selected] as State['selected'],
    prefs,
  };
}

let state: State | undefined;
const refresh = async () => render((state = await load()));

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
addEventListener('resize', () => state && fitBoard(zoomOf(state)));

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
  const claimBox = el.closest<HTMLElement>('[data-claim], [data-unclaim]');
  if (claimBox && state?.live) return toggleClaim(state, claimBox);
  const tab = el.closest<HTMLElement>('[data-page]');
  if (tab) setPrefs({ page: tab.dataset.page });
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

document.addEventListener('keydown', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.indexOf(tab);
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  setPrefs({ page: tabs[next]!.dataset.page });
  document.querySelector<HTMLElement>(`[data-page="${tabs[next]!.dataset.page}"]`)?.focus();
});

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && refresh());
setInterval(refresh, 30_000);
refresh();
