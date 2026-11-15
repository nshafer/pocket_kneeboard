# Pocket Pilots – Personal Airport Influence Tracker (Chrome extension)

Development plan, written 2026-11-15 from a live inspection of https://pilots.nimblebit.com/
(player callsign N1C0, pilot id `d0uv16x6bl`, company Non-Stop Airlines `NSA` / `bmsx3mly`).

## 1. Goal

The game shows influence per *company* per airport, never per *pilot*. Build an unpacked
Manifest V3 extension that:

1. Records how much influence **I personally** add to each airport, week by week.
2. Shows it in a reliable floating panel (Option 1).
3. Optionally draws it onto the game's own airport card / leaderboard (Option 2, best-effort).

Strictly read-only toward the game: never write to the game's localStorage keys, never alter
requests or responses.

## 2. Game rules that matter (from in-game help, "Holding airports")

- Every job a pilot delivers counts as influence for their company **at the airport it lands
  at**, equal to the **job's pay**.
- Only airports count. Deliveries to **helipads and seaplane bases count for no one**.
- Weeks run from **Monday 00:00 UTC**. Score = **this week + half of last week**. Older weeks
  drop off.
- **One pilot counts for at most $250,000 at an airport per week.**
- A company needs at least $2,000 to hold an airport. The holder takes a 5% fee on other pilots'
  jobs from or to it.
- The landing report says when a delivery wins an airport for the company.

## 3. What was found on the page

### 3.1 Rendering
- `body` holds `canvas#world`, `canvas#game`, one `<script>` and three **empty** `<div>`s.
- **All UI is drawn on the canvas**, including side panels, leaderboard, map cards and help.
  There is no DOM to inject into, and `get_page_text` returns nothing useful.
- Text looks like a pixel font. It may be drawn with `fillText` (custom font) **or** blitted
  from a glyph atlas with `drawImage`. **Check this first** (see 6.2).

### 3.2 localStorage keys (game-related)
| Key | Notes |
|---|---|
| `flash.save.main.bak` | ~120 KB JSON backup of the save. Readable. |
| *(main save key)* | ~121 KB, name hidden from the inspection tool. Almost certainly `flash.save.main`. **Confirm by listing keys yourself.** |
| `flash.auth`, `flash.installId`, `flash.install` | Auth/install data. **Don't touch or log.** |
| `pilots:*` | UI settings (`pilots:ui`, `pilots:eta`, `pilots:plates:*`, etc.) |

Save envelope: `{ v: number, t: epochMs, data: {...} }`.

### 3.3 Relevant fields in `data`
- `pid` (`d0uv16x6bl`), `callsign` (`N1C0`), `money`.
- `at`: `{ code, name, lat, lon }`, the airport you're currently at (e.g. `EIDW`, Dublin).
- `visited[ICAO]`: `{ c: country, h, hh, n: landings, name, t: lastVisitMs }`.
  EIDW had `n: 2`. `h` / `hh` are unknown (`hh` ≈ 249.9). Could be hours or heading; investigate.
- `stats`: `flights, landings, jobs (176), earned (3,922,431), earnedBy{plane}, byKind{pax,cargo,vip,…},
  byPad{remote,hospital,ship,rig,city}, …`. Note `stats.landings` read as 0, so it's
  unreliable. Use `visited[*].n` instead.
- `flown`: ring buffer of the last 40 job ids, format `ORIGIN-<halfHourSlot>-<jobKey>[-<plane>]`,
  e.g. `EIDW-997087-h20`. `halfHourSlot` = `floor(epochMs / 1_800_000)`. Prefix is the job
  **origin** board, not the destination. No pay.
- `company.members[pid]`: `{ jobs: 94, earned: 3,495,450, brought: 961,910, gave, rank, at, seen }`.
  These are company-scope totals and differ from `stats.*` (176 jobs / $3.92M). Probably
  counted since joining the company. Work out which counter moves by exactly the job pay.
- `company.book`: ~406 entries covering the last 24 h in hourly buckets (`h` = `floor(ms/3_600_000)`).
  `k: "fly"` entries have `{amt, cost, n, of: callsign}` (no airport). `k: "fee"` has `of: ICAO`
  (fees earned at held airports). `k: "net"` is network bonuses.
- `company.taken`: won/lost airport events. `company.held`: `{t, pids, groups}`.

### 3.4 Server API
- `GET /api/standings?code=<ICAO>&co=<companyId>` is called when the airport leaderboard opens.
  Response: `{ code, list: [{id, value}], cos: {id: {name, tag, paint, livery}} }`.
  Company totals only, with no per-pilot split. Useful for showing **"my share of NSA's
  total"** and for knowing which airport's leaderboard is open.

## 4. Architecture

```
manifest.json (MV3)
├─ content/main-world.js   world: "MAIN", run_at: "document_start", matches pilots.nimblebit.com/*
│    • wraps Storage.prototype.setItem → sees every save write
│    • wraps window.fetch → sees /api/standings responses (read-only clone)
│    • (Option 2) wraps CanvasRenderingContext2D.prototype.fillText / drawImage
│    • posts events via window.postMessage({source:"ppit", ...})
├─ content/bridge.js       isolated world, run_at: "document_start"
│    • relays messages ⇄ chrome.storage.local (persistent ledger)
│    • renders the floating panel (Shadow DOM, fixed position, draggable, collapsible)
└─ options/ or popup/      ledger table, CSV export/import, reset, settings
```

Why two scripts: only the MAIN world can patch the page's `localStorage`, `fetch` and canvas.
Only the isolated world has `chrome.storage`. Keep the ledger out of the page's localStorage
so it never collides with or bloats the game's storage.

Permissions: `"storage"` and host permission `https://pilots.nimblebit.com/*`. Nothing else.

## 5. Tracking algorithm

### 5.1 Capture
In `setItem` wrapper: call the original first, then if `key === MAIN_SAVE_KEY` (and optionally
`.bak`), `JSON.parse` in a `try` block and pass a **snapshot**, not the whole save:
`{ t, atCode, visitedN: {code: n}, statsEarned, statsJobs, memberEarned, memberBrought, money, byPad }`.
Debounce identical consecutive snapshots. Also take an initial snapshot from `getItem` at startup.

### 5.2 Detect a delivery
Compare the new snapshot with the previous one:
- `delta = statsEarned_new − statsEarned_old` (or whichever counter proves exact; see 7).
- `landedAt` = the code whose `visitedN` went up, else `atCode` if it changed, else `atCode`.
- If `delta > 0` and a landing was detected, append a ledger entry:
  `{ ts: save.t, code: landedAt, pay: delta, jobsDelta, padType? }`.
- If `delta > 0` with no landing, log as `unattributed` (bonuses, gifts, network). Keep these
  for debugging but don't count them.
- Several jobs delivered in one landing show up as one entry. That's fine, since they all
  land at the same airport.

### 5.3 Exclude non-airports
Helipads and seaplane bases give no influence. Options, in order of preference:
1. If `byPad` (remote/hospital/ship/rig/city) went up on this landing, mark as pad and exclude.
2. Code heuristics: oil rigs, ships and hospitals likely have special codes. Check `flown`
   prefixes like `GB-0615`.
3. Allow a manual "doesn't count" toggle per code in the options page.

### 5.4 Weekly math
- `weekStart(ts)` = most recent Monday 00:00 **UTC**.
- Per code: `thisWeek = min(250_000, Σ pay this week)`, `lastWeek = min(250_000, Σ pay last week)`.
- `influence = thisWeek + 0.5 × lastWeek`.
- Keep raw entries for ~3 weeks. Optionally roll older ones into per-week totals for history.

### 5.5 Storage shape (`chrome.storage.local`)
```json
{
  "ppit:v1": {
    "pilot": "d0uv16x6bl",
    "lastSnapshot": { ... },
    "entries": [ { "ts": 0, "code": "EIDW", "pay": 0, "pad": false } ],
    "weekly": { "2026-11-09": { "EIDW": 12345 } },
    "excluded": ["GB-0615"]
  }
}
```
Key entries by `pid`, so switching accounts or guest saves doesn't mix data.

## 6. Display

### 6.1 Option 1: floating panel (build first)
- Shadow-DOM box at the top-left under the HUD. Draggable, with position remembered.
- Shows: current airport (`atCode`), **my influence** (this week / last week / scored),
  remaining room under the $250k cap, and **% of company total** if a standings response for
  that code has been seen recently.
- Expand to see a sortable table of all airports with influence > 0.
- When a `/api/standings` response arrives (leaderboard opened), switch the panel to that code
  and show "You: $X of NSA's $Y (Z%)".

### 6.2 Option 2: draw onto the game's own UI (best-effort)
**Spike first (about 30 min):** wrap `fillText`, `strokeText` and `drawImage` on
`CanvasRenderingContext2D.prototype` and log call counts and arguments while opening an airport
card.
- If headers like `"EIDW"` go through `fillText`: record the text, x, y, font and transform
  for the card's header text. Once the card is drawn, draw one extra line (`Me: $X`) at a fixed
  offset with the same font. Hook `requestAnimationFrame` or the end of the frame so it's drawn
  last.
- If text is a glyph atlas through `drawImage`: text recognition isn't practical. Fall back to
  positioning the HTML panel over the known card area, using the standings fetch as the
  "card is open" signal.
- Expect breakage on game updates. Keep it behind a settings toggle that's off by default.

## 7. Validation checklist (do before trusting numbers)
1. Confirm the main save key name and how often it's written (each landing? every N seconds?).
2. Fly 3–5 jobs and compare each ledger `pay` against the **landing report** pay:
   - Which counter moves by exactly the job pay: `stats.earned`, `members[pid].earned` or
     `members[pid].brought`? (The 5% fee and company share may make them differ.)
   - Does influence equal gross job pay or your net share? The help says "the job's pay".
3. Deliver to a helipad/rig and confirm the exclusion logic.
4. Check behaviour across a Monday 00:00 UTC rollover.
5. Cross-check: for an airport only you deliver to, your scored influence should match the
   company leaderboard value.
6. Reload, then confirm the ledger persists and the startup snapshot doesn't double-count.

## 8. Edge cases
- Multiple tabs open: dedupe by `save.t` and code.
- Playing on another device with the same account: those landings are invisible. Document
  that the tracker only covers this browser.
- Restoring or importing a save (`backup`, sync code): earnings drop or jump. Ignore negative
  deltas and large unattributed jumps; reset `lastSnapshot`.
- Game changes the save schema (`v`): guard every field access, and show a "schema changed"
  badge instead of crashing.
- Never read, log or send `flash.auth` or any token-like value.

## 9. Milestones
1. **Spike** (MAIN-world hook logs snapshots + diffs to console). Run the validation in §7.
2. **Ledger** in chrome.storage plus weekly math. Unit-test `weekStart` and influence math with
   fixed timestamps.
3. **Floating panel** (current airport + table).
4. **Standings integration** (share of company total).
5. **Options page**: CSV export/import, exclusions, reset, toggles.
6. **Option 2 canvas overlay**, only if the §6.2 spike shows `fillText`.

## 10. Open questions
- Main save key name, and write frequency.
- Meaning of `visited[*].h` / `hh`.
- Exact counter that equals job pay (see §7.2).
- Whether team jobs (`byKind.team`) split pay between pilots, and whether influence follows
  the split.
- How to tell pads from airports with no manual input.
