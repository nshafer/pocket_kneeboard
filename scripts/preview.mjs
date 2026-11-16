// Renders the built side panel with made-up data, in a headless Chromium of its own, and saves
// screenshots. It does not touch the dev browser or the game.
//
//   npm run build && node scripts/preview.mjs [outDir]   checks every page at several sizes
//   npm run screenshots                                   the README's pictures, in docs/screenshots
//
// With --docs it renders one picture of each page at 2x, at a fixed time on a Wednesday in UTC, so
// the week is half flown whatever day it runs. The data is made up: no real pilot, company or plane.
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const root = resolve('_output/chrome-mv3');
const docs = process.argv.includes('--docs');
const out = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (docs ? 'docs/screenshots' : 'preview'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(out, { recursive: true });
// Chromium's profile goes in a fresh temp folder: on the workspace mount, a profile costs each
// run about 4 seconds.
const home = await mkdtemp(join(tmpdir(), 'pocket_kneeboard-preview-'));

const day = 86_400_000;
// For the README: Wednesday 14:20 UTC of this week. The page's clock is set to it too.
const wednesday = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * day + 2 * day + (14 * 60 + 20) * 60_000;
})();
const now = docs ? wednesday : Date.now();
const pid = 'demo';
const entry = (code, name, daysAgo, pay, extra = {}) => ({
  t: now - daysAgo * day,
  code,
  name,
  pay,
  counted: true,
  src: 'report',
  job: `${code}-${daysAgo}-${pay}`,
  reg: 'N205KB',
  t0: now - daysAgo * day - 40 * 60_000,
  from: 'EIDW',
  net: Math.round(pay * 1.03),
  ...extra,
});
const data = {
  'kb:live': {
    t: now,
    schema: 27,
    pid,
    callsign: 'N8KB',
    co: 'c1',
    coName: 'Skyline Air',
    coTag: 'SKY',
    at: { code: 'EIDW', name: 'Dublin' },
    active: null,
    visited: { EIDW: { n: 9, name: 'Dublin' }, EGNH: { n: 3, name: 'Blackpool' }, EGOW: { n: 1, name: 'Woodvale' } },
    plane: 'N205KB',
    fleet: [
      { reg: 'N205KB', type: 'kite', name: 'BLUEBIRD', at: 'EIDW', hours: 22.1, paid: 609_960, co: false },
      { reg: 'N318PK', type: 'petrel', name: 'SEA BISCUIT', at: 'EGBT', hours: 18.9, paid: 324_360, co: false },
      { reg: 'N442TR', type: 'puffin', at: 'LFXU', hours: 18.5, paid: 251_640, co: false },
      { reg: 'N517LM', type: 'skylark', at: 'EGNS', hours: 4.05, paid: 0, co: false },
      { reg: 'N731WQ', type: 'sparrow', at: 'EGOE', hours: 0.04, paid: 0, co: false },
      { reg: 'N104CL', type: 'shire', name: 'Clover', at: 'EGSS', hours: 113.7, paid: 161_130, paidH: 7.19, co: true },
      { reg: 'N116BR', type: 'shire', name: 'Bramble', at: 'EGCC', hours: 72.8, co: true },
      { reg: 'N250NO', type: 'zephyr', hours: 117.0, paid: 3_252_810, paidH: 74.8, co: true },
      { reg: 'N262AT', type: 'zephyr', name: 'NIGHT OWL', at: 'HESX', hours: 116.3, paid: 3_823_300, paidH: 80.36, co: true },
      { reg: 'N377NW', type: 'stratus', name: 'Northwind', hours: 73.8, paid: 2_365_070, paidH: 71.36, co: true },
      { reg: 'N480PL', type: 'pelican', hours: 39.5, paid: 2_600_870, paidH: 39.5, co: true },
      { reg: 'N590AS', type: 'skyliner', name: 'ATLAS', hours: 0, co: true },
    ],
  },
  [`kb:ledger:${pid}`]: {
    pid,
    since: now - 12 * day,
    seen: { EIDW: 5, EGNH: 2 },
    base: { EIDW: 2, EGNH: 1 },
    entries: [
      entry('EIDW', 'Dublin', 0.1, 27_760),
      entry('EIDW', 'Dublin', 0.5, 61_200),
      entry('EIDW', 'Dublin', 1, 44_150),
      entry('EIDW', 'Dublin', 8, 180_000),
      entry('EGNH', 'Blackpool', 0.3, 18_400),
      entry('EGNH', 'Blackpool', 9, 52_000),
      entry('EGLL', 'London Heathrow', 2, 250_000),
      entry('EGLL', 'London Heathrow', 2.1, 30_000),
      entry('EIDW', 'Dublin', 0.2, 22_575),
      entry('IE-H012', 'Beaumont Hospital', 0.25, 9_800, { counted: false, why: 'helipad (hospital)', facility: 'helipad' }),
    ],
  },
  'kb:standings': {
    EIDW: { code: 'EIDW', t: now - 4 * 60_000, holder: 'c1', list: [{ id: 'c1', value: 277_100 }, { id: 'c2', value: 197_740 }], cos: { c1: { tag: 'SKY' }, c2: { tag: 'ORCA' } } },
    EGNH: { code: 'EGNH', t: now - 2 * 60_000, holder: 'c2', list: [{ id: 'c2', value: 90_000 }, { id: 'c1', value: 44_000 }], cos: { c1: { tag: 'SKY' }, c2: { tag: 'VTX' } } },
  },
  // The landing log: a phone flight into EIDW shared with a teammate, and one into EGNH whose pay
  // the log couldn't measure.
  'kb:log': {
    co: 'c1',
    url: 'https://example.org/kneeboard/c1.json',
    t: now,
    log: {
      co: 'c1',
      updated: now - 60_000,
      landings: [
        { key: 'demo:1', pid, cs: 'N8KB', to: 'EIDW', t0: now - 90 * 60_000, t: now - 50 * 60_000, how: 'shared', pay: 8_000, with: [{ pid: 'm8', cs: 'MATE' }], reg: 'N318PK' },
        { key: 'demo:2', pid, cs: 'N8KB', to: 'EGNH', t0: now - 30 * 60_000, t: now - 10 * 60_000, how: 'unknown', pay: null, reg: 'N318PK' },
        { key: 'm8:1', pid: 'm8', cs: 'MATE', to: 'EGLL', t0: now - 3 * day, t: now - 3 * day + 2 * 3_600_000, how: 'measured', pay: 96_000, reg: 'N262AT' },
        { key: 'm8:2', pid: 'm8', cs: 'MATE', to: 'EHAM', t0: now - 2 * day, t: now - 2 * day + 3 * 3_600_000, how: 'measured', pay: 141_000, reg: 'N262AT' },
        { key: 'm9:1', pid: 'm9', cs: 'ACE', to: 'LFPG', t0: now - day, t: now - day + 4 * 3_600_000, how: 'measured', pay: 188_500, reg: 'N250NO' },
        { key: 'm9:2', pid: 'm9', cs: 'ACE', to: 'EGCC', t0: now - 4 * day, t: now - 4 * day + 3_600_000, how: 'measured', pay: 42_300, reg: 'N104CL' },
      ],
    },
  },
  'kb:selected': { code: 'EGNH', t: now - 2 * 60_000, via: 'board', job: { pay: 50_000, time: '45m' } },
  'kb:airports': {
    EIDW: { code: 'EIDW', t: now, name: 'Dublin', held: { co: 'c1', v: 277_100, tag: 'SKY' }, selected: false },
    EGNH: {
      code: 'EGNH',
      t: now,
      name: 'Blackpool',
      held: { co: 'c2', v: 90_000, tag: 'VTX' },
      selected: true,
      via: 'board',
      job: { pay: 50_000, time: '45m' },
      landed: [
        { cs: 'MATE', t: now - 40 * 60_000, me: false },
        { cs: 'N8KB', t: now - 3 * 3_600_000, me: true },
      ],
    },
  },
  // SKY's total at EGNH rose $26,000 today; the ledger logged $18,400 of it. At EIDW (Part I) it
  // rose $17,010 in the last hour with nothing logged: a flight on another device. That remark
  // wraps and adds a "This was me" line, the most Part I's remarks usually hold.
  'kb:totals': {
    EIDW: [
      { t: now - 60 * 60_000, v: 260_090 },
      { t: now - 4 * 60_000, v: 277_100 },
    ],
    EGNH: [
      { t: now - 5 * 3_600_000, v: 18_000 },
      { t: now - 2 * 60_000, v: 44_000 },
    ],
  },
  // Each plane's hours and pay eight days ago: the start of the Fleet page's last 7 days.
  'kb:fleet': {
    N205KB: [{ t: now - 8 * day, hours: 15.6, paid: 380_000 }],
    N318PK: [{ t: now - 8 * day, hours: 16.4, paid: 270_000 }],
    N442TR: [{ t: now - 8 * day, hours: 18.5, paid: 251_640 }],
    N517LM: [{ t: now - 8 * day, hours: 4.05, paid: 0 }],
    N731WQ: [{ t: now - 8 * day, hours: 0.04, paid: 0 }],
    N104CL: [{ t: now - 8 * day, hours: 110.2, paid: 120_000, paidH: 5.1 }],
    N116BR: [{ t: now - 8 * day, hours: 70.1 }],
    N250NO: [{ t: now - 8 * day, hours: 101.0, paid: 2_800_000, paidH: 63.3 }],
    N262AT: [{ t: now - 8 * day, hours: 104.9, paid: 3_400_000, paidH: 70.0 }],
    N377NW: [{ t: now - 8 * day, hours: 73.8, paid: 2_365_070, paidH: 71.36 }],
    N480PL: [{ t: now - 8 * day, hours: 30.0, paid: 1_900_000, paidH: 30.0 }],
    N590AS: [{ t: now - 2 * day, hours: 0 }],
  },
};

// ?long=1 adds 60 airports flown this week: three Airports sheets and four Log sheets, and 40 company planes: two
// fleet sheets. The flight log lists this week only, so their times fall between Monday 00:00 UTC and now, whatever day the preview runs.
const monday = (() => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * day;
})();
for (let i = 0; i < 60; i++) {
  const code = `E${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`;
  (data.long ??= []).push(entry(code, `Sample Field ${i + 1}`, (now - monday) * (i + 1) / 61 / day, 5_000 + i * 3_100));
}

const stub = (q) => {
  const store = { ...data, 'kb:prefs': { zoom: Number(q.get('zoom') ?? 1), page: q.get('page') ?? 'worksheet' } };
  const ledger = store[`kb:ledger:${pid}`];
  store[`kb:ledger:${pid}`] = { ...ledger, entries: [...ledger.entries, ...(q.get('long') ? data.long : [])] };
  // ?flying=1: in flight from EIDW to EGLL. ?nosel=1: nothing selected on the map or job board.
  if (q.get('flying')) {
    store['kb:live'] = {
      ...store['kb:live'],
      at: null,
      active: { id: 'f1', from: { code: 'EIDW', name: 'Dublin' }, dest: { code: 'EGLL', name: 'London Heathrow' }, job: { id: 'J9', to: 'EGLL', pay: 21_400 }, t0: now - 20 * 60_000 },
    };
  }
  if (q.get('nosel')) delete store['kb:selected'];
  if (q.get('long')) {
    const extra = Array.from({ length: 40 }, (_, i) => ({ reg: `N${100 + i}XX`, type: ['shire', 'zephyr', 'kite', 'puffin'][i % 4], at: 'EGLL', hours: 10 + i, paid: 50_000 * (i + 1), paidH: 5 + i, co: true }));
    store['kb:live'] = { ...store['kb:live'], fleet: [...store['kb:live'].fleet, ...extra] };
  }
  delete store.long;
  return `<script>
  Date.now = () => ${now};
  const data = ${JSON.stringify(store)};
  window.chrome = {
    runtime: { getManifest: () => ({ version: ${JSON.stringify(version)} }), sendMessage: async () => {} },
    storage: {
      local: {
        get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, data[x]])),
        set: async () => {},
      },
      onChanged: { addListener() {} },
    },
  };
  // Report, to the frame page around this one, how far the sheet's content runs past its bottom
  // and how far the clipboard runs past the panel's right edge.
  // Reported once the panel has drawn its sheet and its fonts have loaded. Reading the sizes
  // forces layout. (Headless --dump-dom runs no animation frames, so don't wait for one.)
  const report = () => {
    const s = document.querySelector('.sheet');
    if (!s || document.fonts.status !== 'loaded') return setTimeout(report, 50);
    const r = document.querySelector('.board')?.getBoundingClientRect();
    const out = parent.document.body.dataset;
    out.overflow = String(s.scrollHeight - s.clientHeight);
    out.wide = r ? String(Math.round(r.right - document.documentElement.clientWidth)) : 'none';
  };
  addEventListener('load', report);
</script>`;
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Headless Chromium won't make a window narrower than 500px, so the panel is shown in an
    // iframe of the exact size instead.
    if (url.pathname === '/frame') {
      const w = Number(url.searchParams.get('w'));
      const h = Number(url.searchParams.get('h'));
      url.searchParams.delete('w');
      url.searchParams.delete('h');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><body style="margin:0;background:#fff"><iframe src="/?${url.searchParams}" style="border:0;display:block;width:${w}px;height:${h}px"></iframe></body>`);
    }
    let body = await readFile(join(root, url.pathname === '/' ? 'sidepanel.html' : url.pathname));
    if (url.pathname === '/') body = body.toString().replace('<head>', `<head>${stub(url.searchParams)}`);
    res.writeHead(200, { 'content-type': types[extname(url.pathname) || '.html'] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chromium = (args) =>
  new Promise((ok, fail) =>
    execFile(
      'chromium',
      ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server', '--virtual-time-budget=1000', ...args],
      // UTC, so the README's times don't depend on where it was made.
      { env: { ...process.env, HOME: home, ...(docs ? { TZ: 'UTC' } : {}) }, maxBuffer: 1 << 24 },
      (err, stdout) => (err ? fail(err) : ok(stdout)),
    ),
  );

const views = [
  ['worksheet', 'page=worksheet'],
  ['flying', 'page=worksheet&flying=1&nosel=1'],
  ['flying-selected', 'page=worksheet&flying=1'],
  ['parked', 'page=worksheet&nosel=1'],
  ['log', 'page=log'],
  ['log-long-2', 'page=log-2&long=1'],
  ['airports', 'page=airports'],
  ['airports-long-2', 'page=airports-2&long=1'],
  ['airports-long-3', 'page=airports-3&long=1'],
  ['fleet', 'page=fleet'],
  ['fleet-long-2', 'page=fleet-2&long=1'],
  ['instructions', 'page=instructions'],
  ['instructions-2', 'page=instructions-2'],
  ['settings', 'page=settings'],
];
// Each Chromium run is mostly waiting, so several run at once. Results print in order.
const jobs = [];
// The extremes: the narrowest panel, the widest, and the largest print sizes. 420px at 130% lays
// out like 323px at 100%. Views in between add nothing once these fit, since the panel scrolls.
const sizes = [
  [320, 808, '1'],
  [420, 860, '1.3'],
  [560, 808, '1'],
  [560, 808, '1.5'],
];
for (const [width, height, zoom] of sizes) {
  for (const [name, q] of views) {
    jobs.push(async () => {
      const url = `http://127.0.0.1:${port}/frame?w=${width}&h=${height}&${q}&zoom=${zoom}`;
      const win = `--window-size=${Math.max(500, width)},${height}`;
      const dom = await chromium([win, '--dump-dom', url]);
      // No report (the page wasn't ready in time) counts as a failure, never as a fit.
      const over = /data-overflow="(-?\d+)"/.exec(dom)?.[1] ?? 'no report';
      const wide = Number(/data-wide="(-?\d+)"/.exec(dom)?.[1] ?? 0);
      const ok = over !== 'no report' && Number(over) <= 0 && wide <= 0;
      if (!ok || ['worksheet', 'flying', 'flying-selected', 'parked', 'log', 'airports-long-2', 'fleet', 'instructions', 'instructions-2', 'settings'].includes(name)) {
        await chromium([win, `--screenshot=${join(out, `${name}-${width}${zoom !== '1' ? `-${zoom}x` : ''}.png`)}`, url]);
      }
      const wideNote = wide > 0 ? `, ${wide}px too wide` : '';
      return { ok, line: `${ok ? 'fits    ' : 'OVERFLOW'} ${width}px ${name}${zoom !== '1' ? ` ${zoom}x` : ''} (${over}${wideNote})` };
    });
  }
}
// The panel's usual size, and a short one.
jobs.push(async () => {
  await chromium(['--window-size=500,860', `--screenshot=${join(out, 'worksheet-420.png')}`, `http://127.0.0.1:${port}/frame?w=420&h=860&page=worksheet`]);
  return { ok: true };
});
jobs.push(async () => {
  await chromium(['--window-size=500,640', `--screenshot=${join(out, 'short-viewport.png')}`, `http://127.0.0.1:${port}/frame?w=420&h=640&page=worksheet`]);
  return { ok: true };
});
// The README's pictures replace the checks: one of each page, at 2x, in a 500px panel. WebP: the
// paper's grain makes a PNG of each about 2.5 MB, a WebP about 250 KB.
if (docs) {
  jobs.length = 0;
  const shots = [
    ['flight', 'page=worksheet'],
    ['flight-in-the-air', 'page=worksheet&flying=1&nosel=1'],
    ['log', 'page=log'],
    ['airports', 'page=airports'],
    ['fleet', 'page=fleet'],
    ['help', 'page=instructions'],
    ['settings', 'page=settings'],
  ];
  for (const [name, q] of shots) {
    jobs.push(async () => {
      const url = `http://127.0.0.1:${port}/frame?w=500&h=860&${q}&zoom=1`;
      await chromium(['--window-size=500,860', '--force-device-scale-factor=2', `--screenshot=${join(out, `${name}.webp`)}`, url]);
      return { ok: true, line: `saved   ${name}.webp` };
    });
  }
}
const results = new Array(jobs.length);
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const i = next++;
    results[i] = await jobs[i]();
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
let bad = 0;
for (const r of results) {
  if (r.line) console.log(r.line);
  if (!r.ok) bad++;
}
server.close();
await rm(home, { recursive: true, force: true });
console.log(`screenshots in ${out}${bad ? ` · ${bad} views overflow` : ''}`);
process.exitCode = bad ? 1 : 0;
