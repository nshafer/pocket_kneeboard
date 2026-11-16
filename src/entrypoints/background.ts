// The background worker. It owns the Pocket Kneeboard's storage, and opens the side panel from the
// toolbar button on the game's tabs only.

import { claim, newLedger, recordLanding, unclaim } from '@/lib/ledger';
import { addTotal } from '@/lib/totals';
import { logUrl, parseLog } from '@/lib/log';
import { replacesSelection } from '@/lib/game';
import {
  KEYS,
  type AirportInfo,
  type AirportStandings,
  type HookMessage,
  type LogState,
  type Prefs,
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
  chrome.runtime.onMessage.addListener((msg: { kb?: boolean } & (HookMessage | PanelMessage), sender) => {
    if (!msg?.kb || sender.id !== chrome.runtime.id || !sender.url) return;
    const fromGame = GAME.test(sender.url) && ['snapshot', 'landing', 'standings', 'airport'].includes(msg.type);
    const fromPanel = sender.url.startsWith(PANEL) && ['claim', 'unclaim', 'log'].includes(msg.type);
    if (!fromGame && !fromPanel) return;
    queue = queue.then(() => handle(msg)).catch((e) => console.error('[PocketKneeboard]', e));
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
      if (!(await get<Ledger>(key))) update[key] = newLedger(snap, now);
      await chrome.storage.local.set(update);
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
    case 'standings': {
      const s = msg.payload;
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
      break;
    }
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
      break;
    }
    case 'log':
      await fetchLog(now);
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
