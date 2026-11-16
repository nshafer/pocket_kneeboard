// Runs in the game's own JavaScript world, so it can watch the game's save writes, API replies,
// map card and job buttons. It is read-only: each wrapper calls the original unchanged, then
// only reads. It never writes to the game's storage or alters a request or a reply. Its one
// request of its own, `/api/standings`, the user approved (see CLAUDE.md).
//
// What it depends on, from most to least stable:
//   1. The server API and the save's JSON (field names, not minified code).
//   2. Globals the game names itself: `__pilotsAir`, `__pilotsHere`, `__pilotsFirsts`.
//   3. The wording the game draws: "Fly to EGNM", "Fly it · $3,375".
// Nothing here calls or names the bundle's minified functions. When one of these changes, the
// matching part of the form goes blank; the rest keeps working.
//
// It never reads `acct`, auth keys, install ids or the `pt` query parameter. It posts only the
// fields that src/lib/game.ts picks out.

import {
  SAVE_KEY,
  airportKind,
  boardButtonCode,
  boardButtonRoundTrip,
  boardButtonJob,
  cardButtonJob,
  heldFromWorld,
  holdable,
  landedAt,
  landingResult,
  snapshotFromSave,
  standingsFromReply,
} from '@/lib/game';
import type { HookMessage, JobInfo, Snapshot } from '@/lib/types';

export default defineContentScript({
  matches: ['https://pilots.nimblebit.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const post = (msg: HookMessage) => window.postMessage({ __PocketKneeboard: 1, ...msg }, location.origin);
    const quietly = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.debug('[PocketKneeboard]', e);
      }
    };

    // --- Save writes -------------------------------------------------------------------------
    let last: Snapshot | null = null;
    let lastKey = '';
    // Jobs seen in recent saves. The save can drop the job before the landing reply arrives.
    const jobs: JobInfo[] = [];
    // When each of those jobs' flight (or latest leg) took off.
    const takeoff = new Map<string, number>();

    const takeSnapshot = (raw: string | null) => {
      const snap = snapshotFromSave(raw);
      if (!snap) return;
      last = snap;
      const job = snap.active?.job;
      if (job && !jobs.some((j) => j.id === job.id)) {
        jobs.push(job);
        if (jobs.length > 10) takeoff.delete(jobs.shift()!.id);
      }
      if (job && snap.active?.t0) takeoff.set(job.id, snap.active.t0);
      // The save is written often while flying. Send it on only when a field we keep changes.
      const key = JSON.stringify({ ...snap, t: 0 });
      if (key === lastKey) return;
      lastKey = key;
      post({ type: 'snapshot', payload: snap });
    };

    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      const out = setItem.call(this, key, value);
      if (this === window.localStorage && key === SAVE_KEY) setTimeout(() => quietly(() => takeSnapshot(value)), 0);
      return out;
    };

    // The bridge asks for the current snapshot when it starts (scripts load in either order).
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data?.__PocketKneeboard === 1 && e.data.type === 'hello') {
        lastKey = '';
        quietly(() => takeSnapshot(localStorage.getItem(SAVE_KEY)));
      }
    });
    setTimeout(() => quietly(() => takeSnapshot(localStorage.getItem(SAVE_KEY))), 0);

    // --- API replies -------------------------------------------------------------------------
    const lookupAirport = (code: string) => {
      const db = (globalThis as { __pilotsAir?: { byCode?: unknown } }).__pilotsAir?.byCode;
      return db instanceof Map ? airportKind(db.get(code)) : undefined;
    };

    /** Reads only `op` and `code` from a career request body. */
    const careerOp = (body: unknown): { op?: string; code?: string } => {
      if (typeof body !== 'string' || body.length > 100_000) return {};
      try {
        const b = JSON.parse(body) as { op?: unknown; code?: unknown };
        return {
          op: typeof b.op === 'string' ? b.op : undefined,
          code: typeof b.code === 'string' ? b.code : undefined,
        };
      } catch {
        return {};
      }
    };

    const onReply = (path: string, params: URLSearchParams, req: { op?: string; code?: string }, reply: unknown) => {
      const t = Date.now();
      if (path === '/api/here' || path === '/api/standings') {
        const code = params.get('code');
        const s = code ? standingsFromReply(code, reply, t) : null;
        if (s) post({ type: 'standings', payload: s });
      } else if (path === '/api/career' && req.op === 'land' && req.code && last) {
        const result = landingResult(reply);
        if (!result) return;
        const code = req.code;
        const job = [...jobs].reverse().find((j) => j.to === code);
        const tripId = (reply as { trip?: { id?: unknown } }).trip?.id;
        const reg = last.plane;
        post({
          type: 'landing',
          payload: {
            t,
            pid: last.pid,
            code,
            job,
            airport: lookupAirport(code),
            result,
            tripId: typeof tripId === 'string' ? tripId : undefined,
            reg,
            t0: job ? takeoff.get(job.id) : undefined,
            planeType: reg ? last.fleet?.find((p) => p.reg === reg)?.type : undefined,
          },
        });
        if (job) {
          jobs.splice(jobs.indexOf(job), 1);
          takeoff.delete(job.id);
        }
      }
    };

    const watched = new Set(['/api/here', '/api/standings', '/api/career']);
    const fetch0 = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const res = fetch0.call(this, input, init);
      quietly(() => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin !== location.origin || !watched.has(url.pathname)) return;
        const req = url.pathname === '/api/career' ? careerOp(init?.body) : {};
        if (url.pathname === '/api/career' && req.op !== 'land') return;
        const path = url.pathname;
        const params = new URLSearchParams({ code: url.searchParams.get('code') ?? '' });
        res
          .then((r) => (r.ok ? r.clone().json() : null))
          .then((json) => json && quietly(() => onReply(path, params, req, json)))
          .catch(() => {});
      });
      return res;
    } as typeof fetch;

    // --- Airports: the selected one, and the current one -------------------------------------
    type Globals = { __pilotsFirsts?: unknown; __pilotsHere?: { world?: { d?: unknown } }; __pilotsAirParts?: { cells?: unknown } };
    const game = globalThis as Globals;
    type Job = { pay: number; time?: string };
    // `back`: a round trip ("Fly to Supply ship & back"); its influence counts at home.
    type Selection = { via: 'map' | 'board'; job?: Job; back?: string };

    /**
     * Sends what the game knows about an airport: its name, kind and holder, and the job to it
     * when it is selected. Returns false when the game's world data hasn't loaded yet.
     */
    const describe = (code: string, sel?: Selection) => {
      const kind = lookupAirport(code);
      const held = heldFromWorld(game.__pilotsHere?.world?.d, code);
      const landed = last?.co ? landedAt(game.__pilotsAirParts?.cells, code, last.co, last.pid) : undefined;
      post({
        type: 'airport',
        payload: { code, t: Date.now(), name: kind?.name, kind, held, landed, selected: !!sel, via: sel?.via, job: sel?.job, back: sel?.back },
      });
      return held !== undefined;
    };

    // The user chose to let the Pocket Kneeboard ask for an airport's standings itself: the same
    // read-only GET the game sends when its leaderboard opens, without account data, at most
    // once a minute per airport. The reply goes through the fetch hook above like the game's own.
    const asked = new Map<string, number>();
    const askStandings = (code: string) => {
      const co = last?.co;
      const t = Date.now();
      // Helipads and seaplane bases have no standings.
      if (!co || !holdable(lookupAirport(code)) || t - (asked.get(code) ?? 0) < 60_000) return;
      asked.set(code, t);
      const q = `code=${encodeURIComponent(code)}&co=${encodeURIComponent(co)}`;
      window.fetch(`/api/standings?${q}`, { cache: 'no-store', credentials: 'omit' }).catch(() => {});
    };

    // The map's airport card looks up the airport's first landing (`__pilotsFirsts`, a Map) each
    // time it is drawn, and nothing else reads that Map. Watching those lookups tells which
    // airport is open. The wrapper only notes the key, then calls the original `get`.
    const card = { code: '', at: 0 };
    const watchCard = () => {
      const firsts = game.__pilotsFirsts;
      if (!(firsts instanceof Map)) return false;
      const get = firsts.get;
      firsts.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (typeof key === 'string' && key.length <= 12) {
          card.code = key;
          card.at = painted = Date.now();
        }
        return get.call(this, key);
      };
      return true;
    };
    const waitForGame = setInterval(() => quietly(() => watchCard() && clearInterval(waitForGame)), 500);

    // The selected job's button, as the game draws it: "Fly to EGNM" then "$11,734 · 45m" on the
    // job board, "Fly it · $3,375 · 32m" on a map card. The wrapper draws first, unchanged, then
    // looks only at strings that start with "F" (or the one right after "Fly to …").
    // `code` for a one-way job; `back` (the place it goes to) for a round trip.
    const board: { code: string; back?: string; at: number; job?: Job } = { code: '', at: 0 };
    const cardJob: { at: number; job?: Job } = { at: 0 };
    let afterFlyTo = 0;
    const noteText = (text: string) => {
      if (afterFlyTo > 0) {
        afterFlyTo--;
        const job = boardButtonJob(text);
        if (job) {
          board.job = job;
          afterFlyTo = 0;
        }
      }
      if (text.charCodeAt(0) !== 70) return; // "F"
      const code = boardButtonCode(text);
      const back = code ? undefined : boardButtonRoundTrip(text);
      if (code || back) {
        if (code !== board.code || back !== board.back) board.job = undefined;
        board.code = code ?? '';
        board.back = back;
        board.at = Date.now();
        afterFlyTo = 2;
        return;
      }
      const job = cardButtonJob(text);
      if (job) {
        cardJob.job = job;
        cardJob.at = Date.now();
      }
    };
    // The game draws its menus and cards only when something on them changes: a job board left
    // alone draws nothing for minutes. So a selection that isn't drawn for a while is still
    // open. It has closed only when the game draws again without it.
    let painted = 0;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D['fillText']>
    ) {
      fillText.apply(this, args);
      painted = Date.now();
      if (typeof args[0] === 'string' && (afterFlyTo > 0 || args[0].charCodeAt(0) === 70)) quietly(() => noteText(args[0]));
    };

    type Shown = { code: string; sel: Selection };
    /** The selection on screen, as of the game's last drawing. */
    let current: Shown | undefined;
    /** When the game first drew without it, after it was last drawn. */
    let missing: number | undefined;
    let checked = 0;
    let shownKey = '';
    let primary = '';
    let primaryAt = 0;
    let primaryKnown = false;
    let originShown = '';
    let originAt = 0;
    setInterval(
      () =>
        quietly(() => {
          const now = Date.now();
          const since = checked;
          checked = now;
          // What the game drew since the last check: a map card, or the job picked on the board.
          // When it drew both, the one drawn last is on top.
          if (painted > since) {
            const cardDrawn = !!card.code && card.at > since;
            const boardDrawn = board.at > since && (!!board.code || (!!board.back && !!last?.at));
            let seen: Shown | undefined;
            if (cardDrawn && (!boardDrawn || card.at >= board.at)) {
              const job = cardJob.at > since && Math.abs(cardJob.at - card.at) < 500 ? cardJob.job : undefined;
              seen = { code: card.code, sel: { via: 'map', job } };
            } else if (boardDrawn) {
              // A round trip lands back here, so its influence counts at the current airport.
              seen = { code: board.back ? last!.at!.code : board.code, sel: { via: 'board', job: board.job, back: board.back } };
            }
            if (seen) {
              current = seen;
              missing = undefined;
            } else if (current) {
              missing ??= now;
            }
          }
          // Drawn without the selection for most of a second (not just one frame between two
          // screens): the card or board closed, and Part II stops showing it.
          if (current && missing !== undefined && now - missing > 700) {
            current = undefined;
            missing = undefined;
          }
          // Sent when the selection changes, and again each minute while it stays.
          const sel = current?.sel;
          const code = current?.code ?? '';
          const key = sel ? `${code}|${sel.via}|${sel.back ?? ''}|${sel.job?.pay ?? ''}|${Math.floor(now / 60_000)}` : '';
          if (sel && key !== shownKey) {
            describe(code, sel);
            askStandings(code);
          }
          if (sel) shownKey = key;
          else if (shownKey) {
            shownKey = '';
            post({ type: 'unselected', payload: { t: now } });
          }

          // The current airport, or the destination in flight: refreshed each minute, or within
          // seconds while the world data is still loading.
          const here = last?.at?.code ?? last?.active?.dest?.code ?? '';
          if (here && (here !== primary || now - primaryAt > (primaryKnown ? 60_000 : 2_000))) {
            primary = here;
            primaryAt = now;
            primaryKnown = describe(here);
            askStandings(here);
          }
          // The origin, in flight: Part I shows it. Its holder from the world data only; its
          // standings are the ones kept from when the pilot was there.
          const origin = last?.at ? '' : (last?.active?.from?.code ?? '');
          if (origin && (origin !== originShown || now - originAt > 60_000)) {
            originShown = origin;
            originAt = now;
            describe(origin);
          }
        }),
      400,
    );
  },
});
