// Renders the built side panel with made-up data, in a headless Chromium of its own, and saves
// screenshots. It does not touch the dev browser or the game.
//
//   npm run build && node scripts/preview.mjs [outDir]
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const root = resolve('_output/chrome-mv3');
const out = resolve(process.argv[2] ?? 'preview');
await mkdir(out, { recursive: true });
// Chromium's profile goes in a fresh temp folder: on the workspace mount, a profile costs each
// run about 4 seconds.
const home = await mkdtemp(join(tmpdir(), 'pocket_kneeboard-preview-'));

const now = Date.now();
const day = 86_400_000;
const pid = 'demo';
const entry = (code, name, daysAgo, pay, extra = {}) => ({
  t: now - daysAgo * day,
  code,
  name,
  pay,
  counted: true,
  src: 'report',
  job: `${code}-${daysAgo}-${pay}`,
  ...extra,
});
const data = {
  'kb:live': {
    t: now,
    schema: 27,
    pid,
    callsign: 'N1C0',
    co: 'c1',
    coName: 'Non-Stop Airlines',
    coTag: 'NSA',
    at: { code: 'EIDW', name: 'Dublin' },
    active: null,
    visited: { EIDW: { n: 9, name: 'Dublin' }, EGNH: { n: 3, name: 'Blackpool' }, EGOW: { n: 1, name: 'Woodvale' } },
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
    EIDW: { code: 'EIDW', t: now - 4 * 60_000, holder: 'c1', list: [{ id: 'c1', value: 277_100 }, { id: 'c2', value: 197_740 }], cos: { c1: { tag: 'NSA' }, c2: { tag: 'SRAK' } } },
    EGNH: { code: 'EGNH', t: now - 2 * 60_000, holder: 'c2', list: [{ id: 'c2', value: 90_000 }, { id: 'c1', value: 44_000 }], cos: { c1: { tag: 'NSA' }, c2: { tag: 'VANG' } } },
  },
  'kb:selected': { code: 'EGNH', t: now - 2 * 60_000, via: 'board', job: { pay: 50_000, time: '45m' } },
  'kb:airports': {
    EIDW: { code: 'EIDW', t: now, name: 'Dublin', held: { co: 'c1', v: 277_100, tag: 'NSA' }, selected: false },
    EGNH: {
      code: 'EGNH',
      t: now,
      name: 'Blackpool',
      held: { co: 'c2', v: 90_000, tag: 'VANG' },
      selected: true,
      via: 'board',
      job: { pay: 50_000, time: '45m' },
      landed: [
        { cs: 'MATE', t: now - 40 * 60_000, me: false },
        { cs: 'N1C0', t: now - 3 * 3_600_000, me: true },
      ],
    },
  },
  // NSA's total at EGNH rose $26,000 today; the ledger logged $18,400 of it.
  'kb:totals': {
    EGNH: [
      { t: now - 5 * 3_600_000, v: 18_000 },
      { t: now - 2 * 60_000, v: 44_000 },
    ],
  },
};

// ?long=1 adds enough airports to need a second Schedule A page.
for (let i = 0; i < 26; i++) {
  const code = `EG${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`;
  (data.long ??= []).push(entry(code, `Sample Field ${i + 1}`, (i % 9) + 0.5, 5_000 + i * 3_100));
}

const stub = (q) => {
  const store = { ...data, 'kb:prefs': { zoom: Number(q.get('zoom') ?? 1), page: q.get('page') ?? 'worksheet' } };
  const ledger = store[`kb:ledger:${pid}`];
  store[`kb:ledger:${pid}`] = { ...ledger, entries: [...ledger.entries, ...(q.get('long') ? data.long : [])] };
  delete store.long;
  return `<script>
  const data = ${JSON.stringify(store)};
  window.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.0' }), sendMessage: async () => {} },
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
      { env: { ...process.env, HOME: home }, maxBuffer: 1 << 24 },
      (err, stdout) => (err ? fail(err) : ok(stdout)),
    ),
  );

const views = [
  ['worksheet', 'page=worksheet'],
  ['schedule', 'page=schedule-a'],
  ['schedule-long-2', 'page=schedule-a-2&long=1'],
  ['instructions', 'page=instructions'],
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
      if (!ok || name === 'worksheet') {
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
