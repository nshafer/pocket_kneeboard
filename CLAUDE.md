## Pocket Kneeboard

A Manifest V3 Chrome extension that acts as a companion to the Nimblebit's game Pocket Pilots.

### Code

WXT + TypeScript, no UI framework. `npm run build` writes `.output/chrome-mv3`, then run
`bin/browser reload`. `npm test` runs Vitest on `src/lib`. `npm run preview` screenshots the side
panel with sample data in its own headless Chromium, which is safe while the user plays. It also
checks every page at 320-560px wide and at 130%/150% print, and fails on any overflow. Headless
Chromium won't make a window narrower than 500px, so the preview shows the panel in an iframe of
the exact size. Don't trust `--window-size` alone for narrow layouts.

- `src/entrypoints/game.content.ts`: MAIN world, `document_start`. Wraps `Storage.prototype.setItem`
  and `fetch`, calls the originals first, and posts sanitized events with `window.postMessage`.
- `src/entrypoints/bridge.content.ts`: isolated world. Relays those events to the background.
- `src/entrypoints/background.ts`: the only writer of `chrome.storage.local` (`kb:*` keys). It
  also enables the side panel on game tabs only.
- `src/entrypoints/sidepanel/`: the UI, a paper FAA-style form. The user removed night mode. A
  "Print size" box zooms the clipboard from 50% to 150%.
- `src/lib/game.ts` picks fields out of the save and the API replies. `src/lib/ledger.ts` holds
  the weekly influence maths.

The user decided that the extension must not draw on or change the game's UI, not even with an
overlay. Everything goes in the side panel. An opt-in, off-by-default toggle might come later.

### What the game exposes (client bundle, 2026-11-15)

- Save: `flash.save.main`, `{v, t, data}`. `data.active.job` = `{id, from, to, toName, kind, pay,
  pad}`. `pad` is set for helipad/ship/rig jobs. `data.acct` is the account sync code: a secret.
- Ops go through `POST /api/career` with body `{op, ..., acct}`. A landing is `op: "land"` with
  `code`. The reply's `result.value` is the job's base pay, which is the influence (confirmed on a
  live landing, 2026-11-15). `result.lines[0]` is `[jobName, "$base pay"]` as well.
- A job with `pad` set ("to Supply ship, back to EIDW") counts in full at the airport it returns
  to: NSA's EIDW total rose by exactly that job's pay. Only landing at a helipad or seaplane base
  counts for no one.
- `GET /api/here?code=X&...&pt=...` runs when an airport is opened. It returns `holder`,
  `standings: [{id, value}]` and `cos`. `pt` may be a token: read only `code` from that URL.
- `globalThis.__pilotsAir.byCode` (a Map) is the airport database. `pad: {kind}` marks a helipad,
  and `sea` plus only water runways marks a seaplane base.
- The job board is in module scope and can't be read. Only the top two jobs are copied to
  `__pilotsPrefile.board`. Picking a job on the board leaves no trace that names its
  destination (`__pilotsPrefile.picked.key` has only the job id). Don't read `__pilotsAcct` or
  `__pilotsAuth`.
- The map's airport card is the only reader of `globalThis.__pilotsFirsts` (a Map), and it reads
  it on every redraw. The hook watches those `get` calls to know which airport is open.
- The game draws text with `CanvasRenderingContext2D.fillText`. The job board's main button is
  drawn as "Fly to EGNM" then "$11,734 · 45m". The map card's button is drawn as
  "Fly it · $3,375 · 32m". The hook reads these for the selected job. A leg of a route is drawn
  as "Fly leg 1 to EGDM" (added in a game update on 2026-11-15). A round trip is drawn as
  "Fly to Supply ship & back", maybe cut to "& b…", and counts at the current airport. A whole
  route is drawn as "Fly 3 legs · …" and is skipped. To see every form in a new build, search
  the bundle for the template strings that begin "Fly ".
- The job list itself is regenerated on every draw from the seed (`K5`). It is never stored, so
  the drawn buttons are the only way to see a job.
- `__pilotsHere.world.d.held` has `{co, v}` (holder, holder's influence) for every held airport,
  and `world.d.cos` has company names and tags.
- `/api/standings?code=X&co=Y` replies `{code, list, cos}` with no `holder`. `/api/here` has it.
- The user allowed the extension to send that `/api/standings` GET itself, for the airport open on
  the map and the current airport, at most once a minute per airport. Any other request needs the
  user's approval first.

### The dev browser

The devcontainer runs Chromium on a virtual display. `bin/browser` controls it, and
`postStartCommand` starts it.

- The user sees the screen at http://127.0.0.1:4090/ on the host (noVNC). The user plays the game
  there, so do not close the game tab or move its window without a reason.
- Pocket Pilots is an idle game: flights continue without anyone at the controls. A flight on
  screen does not mean the user is flying, so `bin/browser restart` and reloads are fine at any
  time. Don't wait for a landing.
- Claude drives the browser through the `chrome-devtools` MCP server (`.mcp.json`). It connects to
  CDP at http://127.0.0.1:9222. Use it to read the console, take screenshots and run scripts in the
  page.
- `bin/browser reload` reloads the unpacked extension and the game tab. Run it after each build.
- Developer mode must stay on in the dev profile. If it's off, Chromium disables the unpacked
  extension ("unsupported developer extension"), and `bin/browser reload` still prints "reloaded".
  `chrome.developerPrivate.getExtensionInfo` on a `chrome://extensions` CDP target shows its state.
- x11vnc drops Shift to type a plain keysym. To send Ctrl+Shift+K or Ctrl+Shift+1 over VNC, send
  the shifted keysym (`K`, `!`), not `k` or `1`.
- `bin/browser restart` is necessary after the extension folder changes, because Chromium reads
  `--load-extension` only when it starts. `bin/browser` loads the first of `extension/`, `dist/`,
  `.output/chrome-mv3-dev` and `.output/chrome-mv3` that has a `manifest.json`. Set
  `POCKET_KNEEBOARD_EXT_DIR` to use a different folder.
- Chromium renders on the host GPU (AMD RX 9070) through `/dev/dri/renderD128` and Vulkan.
  `POCKET_KNEEBOARD_GPU=0 bin/browser restart` uses the software renderer.
- `bin/browser status` and `bin/browser logs` help when something does not start.
- `POCKET_KNEEBOARD_FLAGS=--force-dark-mode bin/browser restart` shows Chrome in dark mode.
- The MCP server can't see extension pages or browser UI. The side panel is a CDP target
  (`chrome-extension://niglcngodhkbapfekmdadiakbbdpeeai/sidepanel.html`) that a raw CDP client can
  evaluate in. To see the real screen, frame included, read it from the VNC server on
  127.0.0.1:5900 (no password, shared). Reloading the extension closes the side panel. The
  toolbar icon toggles it.
- The Chromium profile is in `~/.config/pocket_kneeboard-chromium`, on the persisted home volume. It holds
  the game login.

### Network

The egress filter blocks every host that is not on the allowlist. The project list is
`.devcontainer/egress-allow.txt`. Run `egress-denied` to see what was refused. A change to the list
takes effect when the container restarts. Ask the user before you add a host.

### Rules

- Never read, print, log or send `flash.auth`, `flash.installId`, `flash.install`, or any value
  that looks like a token. This applies to MCP scripts and console output too. Read only the save
  keys that the plan names.
- The extension is read-only toward the game. Never write to the game's localStorage, and never
  change its requests or responses.
- Do not publish the CDP port or add `--remote-debugging-address`. CDP gives full control of the
  browser and the logged-in profile.
