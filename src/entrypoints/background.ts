// The background worker. It owns the Pocket Kneeboard's storage, and opens the side panel from the
// toolbar button on the game's tabs only.

import { claim, newLedger, recordLanding, unclaim } from '@/lib/ledger';
import { addTotal } from '@/lib/totals';
import { addFleetSamples } from '@/lib/fleet';
import { parseBackup } from '@/lib/backup';
import { lastLanding, noteLandings, originStale, type LandedAt } from '@/lib/origin';
import { logUrl, parseLog } from '@/lib/log';
import { holdable, replacesSelection, standingsFromReply } from '@/lib/game';
import {
  KEYS,
  type AirportInfo,
  type AirportStandings,
  type FleetHistory,
  type HookMessage,
  type LogState,
  type Prefs,
  type Selected,
  type Ledger,
  type PanelMessage,
  type Snapshot,
  type TotalsHistory,
} from '@/lib/types';

const GAME = /^https:\/\/pilots\.nimblebit\.com\//;
const MAX_STANDINGS = 40;
const MAX_DEBUG = 20;
/** The landing log is downloaded at most this often. The server rewrites it once a minute. */
const LOG_EVERY = 55_000;

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  // The panel is off everywhere except on game tabs.
  const scope = (tabId: number, url: string | undefined) =>
    chrome.sidePanel
      .setOptions({ tabId, path: 'sidepanel.html', enabled: !!url && GAME.test(url) })
      .catch(() => {});
  chrome.tabs.onUpdated.addListener((tabId, _info, tab) => scope(tabId, tab.url));
  chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then((t) => scope(tabId, t.url), () => {}));
  chrome.runtime.onInstalled.addListener(async () => {
    await chrome.sidePanel.setOptions({ enabled: false });
    for (const t of await chrome.tabs.query({})) if (t.id !== undefined) await scope(t.id, t.url);
  });

  // The panel in its own window, for the installed app (PWA), which has no side panel.
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-window') openWindow().catch(console.error);
  });

  // Messages run one at a time, so two read-modify-write cycles never interleave.
  let queue = Promise.resolve();
  // Hook messages come only from the game's tabs; panel messages only from the extension's pages.
  const PANEL = chrome.runtime.getURL('');
  chrome.runtime.onMessage.addListener((msg: { kb?: boolean } & (HookMessage | PanelMessage), sender, reply) => {
    if (!msg?.kb || sender.id !== chrome.runtime.id || !sender.url) return;
    const fromGame = GAME.test(sender.url) && ['snapshot', 'landing', 'standings', 'airport', 'unselected'].includes(msg.type);
    const fromPanel = sender.url.startsWith(PANEL) && ['claim', 'unclaim', 'log', 'restore'].includes(msg.type);
    if (!fromGame && !fromPanel) return;
    const done = queue.then(() => handle(msg));
    queue = done.catch((e) => console.error('[PocketKneeboard]', e));
    // A restore tells the panel how it went.
    if (msg.type !== 'restore') return;
    done.then(
      () => reply({ ok: true }),
      (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });
});

/** Focuses the panel's window if one is open (a side panel doesn't count), or opens one. */
async function openWindow() {
  const url = chrome.runtime.getURL('sidepanel.html');
  const [open] = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });
  if (open && open.windowId >= 0) {
    await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: 'popup', width: 420, height: 900, focused: true });
}

async function get<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.local.get(key))[key] as T | undefined;
}

async function handle(msg: HookMessage | PanelMessage) {
  const now = Date.now();
  switch (msg.type) {
    case 'snapshot': {
      const snap = msg.payload;
      const key = KEYS.ledger(snap.pid);
      const update: Record<string, unknown> = { [KEYS.live]: snap };
      const landed = (await get<LandedAt>(KEYS.landed)) ?? {};
      const noted = noteLandings(landed, await get<Snapshot>(KEYS.live), snap, now);
      if (noted !== landed) update[KEYS.landed] = noted;
      if (!(await get<Ledger>(key))) update[key] = newLedger(snap, now);
      if (snap.fleet?.length) {
        const hist = (await get<FleetHistory>(KEYS.fleet)) ?? {};
        const next = addFleetSamples(hist, snap.fleet, now);
        if (next !== hist) update[KEYS.fleet] = next;
      }
      await chrome.storage.local.set(update);
      await originStandings(snap, now);
      break;
    }
    case 'landing': {
      const ev = msg.payload;
      const key = KEYS.ledger(ev.pid);
      const live = await get<Snapshot>(KEYS.live);
      const ledger = (await get<Ledger>(key)) ?? (live?.pid === ev.pid ? newLedger(live, now) : null);
      if (!ledger) return;
      const debug = (await get<unknown[]>(KEYS.debug)) ?? [];
      await chrome.storage.local.set({
        [key]: recordLanding(ledger, ev, now),
        [KEYS.debug]: [...debug, ev].slice(-MAX_DEBUG),
      });
      break;
    }
    case 'standings':
      await storeStandings(msg.payload);
      break;
    case 'airport': {
      const a = msg.payload;
      const all = (await get<Record<string, AirportInfo>>(KEYS.airports)) ?? {};
      all[a.code] = a;
      const kept = Object.fromEntries(
        Object.entries(all)
          .sort(([, x], [, y]) => y.t - x.t)
          .slice(0, MAX_STANDINGS),
      );
      // The world data's figure is our total whenever we hold the airport.
      const live = await get<Snapshot>(KEYS.live);
      const co = live?.co;
      const ours = co && a.held?.co === co ? a.held.v : undefined;
      const totals = await get<TotalsHistory>(KEYS.totals);
      await chrome.storage.local.set({
        [KEYS.airports]: kept,
        ...(replacesSelection(a) ? { [KEYS.selected]: { code: a.code, t: a.t, via: a.via, job: a.job, back: a.back } } : {}),
        ...(ours !== undefined ? { [KEYS.totals]: addTotal(totals ?? {}, a.code, a.t, ours) } : {}),
      });
      if (live && !live.at && live.active?.from?.code === a.code) await originStandings(live, now);
      break;
    }
    case 'unselected': {
      const sel = await get<Selected>(KEYS.selected);
      if (sel && sel.t <= msg.payload.t) await chrome.storage.local.remove(KEYS.selected);
      break;
    }
    case 'log':
      await fetchLog(now);
      break;
    case 'restore':
      await restore(msg.payload.text);
      break;
    case 'claim':
    case 'unclaim': {
      const key = KEYS.ledger(msg.payload.pid);
      const ledger = await get<Ledger>(key);
      if (!ledger) return;
      const next = msg.type === 'claim' ? claim(ledger, msg.payload) : unclaim(ledger, msg.payload.code, msg.payload.since);
      await chrome.storage.local.set({ [key]: next });
      break;
    }
  }
}

async function storeStandings(s: AirportStandings) {
  const all = (await get<Record<string, AirportStandings>>(KEYS.standings)) ?? {};
  all[s.code] = s;
  const kept = Object.fromEntries(
    Object.entries(all)
      .sort(([, a], [, b]) => b.t - a.t)
      .slice(0, MAX_STANDINGS),
  );
  const co = (await get<Snapshot>(KEYS.live))?.co;
  const ours = co ? s.list.find((r) => r.id === co) : undefined;
  const totals = await get<TotalsHistory>(KEYS.totals);
  await chrome.storage.local.set({
    [KEYS.standings]: kept,
    ...(ours ? { [KEYS.totals]: addTotal(totals ?? {}, s.code, s.t, ours.value) } : {}),
  });
}

/** When each airport's standings were last asked for here, so an airport is asked once a minute. */
const askedOrigin = new Map<string, number>();

/**
 * In flight, Part I shows the origin. When the standings kept for it are older than the pilot's
 * last landing there (or, with none known, than the takeoff), the stop was on another device, so
 * they are asked for: the same read-only GET the page hook sends, without account data, at most
 * once a minute per airport (the user approved it, 2026-11-16). Not for a helipad or seaplane base.
 * While the pilot is parked in this browser, the hook reads them each minute, so they're fresh.
 */
async function originStandings(snap: Snapshot, now: number) {
  const code = snap.at ? undefined : snap.active?.from?.code;
  const takeoff = snap.active?.t0;
  if (!code || !takeoff || !snap.co || now - (askedOrigin.get(code) ?? 0) < 60_000) return;
  const kept = (await get<Record<string, AirportStandings>>(KEYS.standings))?.[code];
  const log = await get<LogState>(KEYS.log);
  const last = lastLanding(
    code,
    snap.pid,
    await get<LandedAt>(KEYS.landed),
    await get<Ledger>(KEYS.ledger(snap.pid)),
    log?.co === snap.co ? log?.log : undefined,
  );
  if (!originStale(kept?.t, last, takeoff)) return;
  // Only once the page hook has looked the airport up (see the 'airport' message).
  const kind = (await get<Record<string, AirportInfo>>(KEYS.airports))?.[code]?.kind;
  if (!kind || !holdable(kind)) return;
  askedOrigin.set(code, now);
  try {
    const q = `code=${encodeURIComponent(code)}&co=${encodeURIComponent(snap.co)}`;
    const res = await fetch(`https://pilots.nimblebit.com/api/standings?${q}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return;
    const s = standingsFromReply(code, await res.json(), Date.now());
    if (s) await storeStandings(s);
  } catch {
    // Offline, or the server is busy: the next save tries again after a minute.
  }
}

/**
 * Replaces every `kb:*` record with a backup's. The panel checked the file already; this checks it
 * again, since storage is written only here. The page that's open stays open.
 */
async function restore(text: string) {
  const { data } = parseBackup(text);
  const all = await chrome.storage.local.get(null);
  const page = (all[KEYS.prefs] as Prefs | undefined)?.page;
  const prefs = { ...((data[KEYS.prefs] as Prefs | undefined) ?? {}), ...(page ? { page } : {}) };
  const gone = Object.keys(all).filter((k) => k.startsWith('kb:') && !(k in data));
  if (gone.length) await chrome.storage.local.remove(gone);
  await chrome.storage.local.set({ ...data, [KEYS.prefs]: prefs });
}

/**
 * Downloads the landing log for the pilot's company (see src/lib/log.ts), when the last try is a
 * minute old. Keeps the last log that worked if a download fails.
 */
async function fetchLog(now: number) {
  const co = (await get<Snapshot>(KEYS.live))?.co;
  if (!co) return;
  const prev = await get<LogState>(KEYS.log);
  const url = logUrl(co, (await get<Prefs>(KEYS.prefs))?.logUrl);
  if (prev && prev.co === co && prev.url === url && now - prev.t < LOG_EVERY) return;
  const keep = prev?.co === co && prev.url === url ? prev.log : undefined;
  if (!url) return chrome.storage.local.set({ [KEYS.log]: { co, t: now } satisfies LogState });
  await chrome.storage.local.set({ [KEYS.log]: { co, url, t: now, log: keep, error: prev?.error } satisfies LogState });
  let next: LogState;
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    next = { co, url, t: now, log: parseLog(await res.json(), co) };
  } catch (e) {
    next = { co, url, t: now, log: keep, error: e instanceof Error ? e.message : String(e) };
  }
  await chrome.storage.local.set({ [KEYS.log]: next });
}
