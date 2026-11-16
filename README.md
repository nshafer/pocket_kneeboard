# Pocket Kneeboard

A pilot’s kneeboard for [Pocket Pilots](https://pilots.nimblebit.com/). It is a Chrome extension that
opens a side panel next to the game and fills in a paper form as you fly. The form shows the
airport influence that **you** add, which the game itself shows only per company.

The extension doesn’t change the game’s screen. It reads the game’s save, the game’s server replies
and the text the game draws. It never writes to the save and never changes the game’s requests.

## What it shows

The **Flight** page has two parts:

- **Part I: current location**, or your **origin** while you fly:
  - your flights this week as filled bubbles toward the $250,000 weekly limit;
  - your influence this week and the room left;
  - your company’s total there, your share of it, and who holds the airport. If your company
    holds it, by how much; if not, how much your company needs to take it.
- **Part II: selected airport**, the one open on the map or picked on the job board, with the
  same figures, plus the job on offer and its result: whether it would take the airport, or how
  far short it falls. The bubbles the job would fill are shaded in light pencil. A round trip
  (“& back”) lands back at your airport, so it shows that one. With nothing selected, Part II
  shows your **destination** and the job you’re flying while in the air, and is blank on the
  ground.
- **Remarks** for each airport: your last flight there, who in your company landed there
  recently, and how much your company’s total rose beyond your own logged flights. Tick
  **This was me** to count that rise as yours, for example after flying on your phone.
- **Log.** Each flight this week: when, where to, the plane, its net pay (the landing report's
  total) and the influence it added. Flights on another device come from the landing log, without
  net pay.
- **Airports.** Every airport you flew a job to this week, with your influence and the room left
  at each.
- **Fleet.** Each of your planes and your company’s, with its net pay per hour and the influence
  it adds per hour over the last 7 days, and its net pay per hour over its whole life (the
  game’s own figure, as the hangar shows it).
- **Settings** (the gear): **Print size**, from 50% to 150%; the landing log’s URL; and
  **Backup and restore**, which saves all your records as a file (or to the clipboard) and loads
  them back, for example into another browser.

### The figures are estimates

Pocket Kneeboard works out your influence itself, from the landings it sees in this browser. Only
the company totals and holders come from the game’s server.

- **Flights on another device are missing.** The extension never sees them. It notices when your
  company’s total at an airport rose more than your logged flights explain, and when your
  logbook shows landings it didn’t see. You can claim the rise with **This was me**.
- **It starts at zero.** The game keeps no per-pilot history, so only flights after you install it
  count. After two full weeks (Monday 00:00 UTC to Monday 00:00 UTC) the figures are complete.
- **The sum follows the in-game help.** A flight adds the job’s base pay (the first line of the
  landing report). Bonuses, fees and fuel don’t count. Helipads and seaplane bases count for no
  one. If the game changes its rules, the figures will be wrong until the extension is updated.

## Install

Pocket Kneeboard isn’t in the Chrome Web Store. You load it as an unpacked extension. This works in
Chrome, Edge, Brave and other Chromium browsers.

1. Download `pocket_kneeboard-<version>-chrome.zip` from the
   [latest release](../../releases/latest).
2. Unzip it into a folder that will stay put, for example `Documents/Pocket Kneeboard`. Chrome
   loads the extension from that folder every time it starts, so don’t delete it.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and choose the folder (the one with `manifest.json` in it).
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to Pocket Kneeboard.

To use it, open Pocket Pilots and click the clipboard icon, or press **Alt+K**. Click it again to
close it. The panel opens only on the game’s tab.

If you play the game as an installed app (a PWA), its window has no side panel. Press
**Ctrl+Shift+K** (**⌘⇧K** on a Mac) in the app window instead: the panel opens in a small window of
its own, or comes to the front if it’s already open. It works in any Chrome window, and shows the
same records as the side panel. To change the key, go to `chrome://extensions/shortcuts`.

### Update

1. Download the new zip and unzip it **over the same folder**, replacing the old files.
2. On `chrome://extensions`, click the reload arrow on the Pocket Kneeboard card.
3. Reload the game tab. Until you do, the open tab is still connected to the old version.

Your records are kept. The extension has a fixed ID, so its saved data stays with it even if you
move the folder.

### Notes

- Chrome may show a *Disable developer mode extensions* warning when it starts. Click away from it
  (don’t click **Disable**).
- Unpacked extensions don’t update themselves. Watch the repository’s releases for new versions.
- Records are kept per browser profile. Two browsers, or two profiles, keep separate records. To
  move them, use **Backup and restore** in Settings.
- When selecting a job in the job board, the extension detects the destination via the text in the
  big yellow button. It detects return trips if it ends in "& back" but that can be truncated in
  some cases, and not update Part II of the worksheet.

## Privacy

The extension runs only on `pilots.nimblebit.com`, and keeps its records in the browser’s extension
storage. It sends nothing to anyone else. To fill in the hold figures, it asks the game’s server
for an airport’s standings (the same request the game’s leaderboard makes, at most once a minute
per airport). It reads only the parts of the game’s save it needs: callsign, company, current
airport, the active job, the landing counts and the planes’ hours and earnings. It never reads the
sign-in or account data. A backup holds only the extension’s own records.

## Develop

### Quick start

With Node 24 on your machine:

```sh
npm install
npm run build      # build into _output/chrome-mv3
npm test           # unit tests for the save reader and influence maths
npm run check      # type check
npm run preview    # screenshots of the panel with sample data, into preview/ (needs `chromium`)
npm run zip        # the release zip
```

Load `_output/chrome-mv3` with **Load unpacked** (see [Install](#install)). After each build, click
the reload arrow on the extension’s card, then reload the game tab.

Releases: push a tag such as `v0.2.0`. GitHub Actions builds the zip, sets the version from the tag
and publishes the release.

### The dev container

The repository comes with a dev container: a Linux container with Node, a Chromium that loads the
extension, and a virtual screen you watch in your own browser. Coding agents can drive that
Chromium to test changes while you play.

**1. Install a container engine.** One of:

- [Docker Desktop](https://docs.docker.com/desktop/) (macOS, Windows) or
  [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin (Linux).
- [Podman](https://podman.io/docs/installation) with `podman-compose`. In VS Code, set
  **Dev › Containers: Docker Path** to `podman` and **Docker Compose Path** to `podman-compose`.

**2. Install [VS Code](https://code.visualstudio.com/)** and its
[Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
extension.

**3. Prepare the host.** The container mounts two folders from your home folder. Create them if
they don’t exist:

```sh
mkdir -p ~/.config/git ~/.config/egress-filter
```

The container also passes through the GPU render node `/dev/dri/renderD128` (Linux with an AMD or
Intel GPU). On other hosts, delete the `devices:` lines in `.devcontainer/docker-compose.yaml`; the
browser then uses its software renderer.

**4. Open the folder in the container.** Open the repository in VS Code and run
**Dev Containers: Reopen in Container**. The first build takes a few minutes. When it is done, the
container starts a Chromium on a virtual display.

**5. Sign in to the game.** Open <http://127.0.0.1:4090/> in your own browser. That is the
container’s screen. Sign in to Pocket Pilots there. The login is kept in the container’s home
volume, so you do it once.

**6. Build and load.** In the VS Code terminal:

```sh
npm install
npm run build
bin/browser restart   # the first time: Chromium loads the extension only when it starts
bin/browser reload    # after later builds: reloads the extension and the game tab
```

`bin/browser status` and `bin/browser logs` help when something doesn’t start.

**Network.** The container blocks every host that isn’t on its allowlist: the presets in
`.devcontainer/devcontainer.json` (npm, GitHub, Claude, Copilot) and the hosts in
`.devcontainer/egress-allow.txt`. Run `egress-denied` to see what was blocked. A change to the
list takes effect when the container restarts.

### Coding agents (optional)

`CLAUDE.md` describes the project, the dev browser and the rules for working on it: never read the
game’s sign-in data, never write to the game. Point any agent at it.

- **[Claude Code](https://claude.com/claude-code)** is installed in the container. Run `claude` in
  the terminal, or use the Claude Code extension in VS Code. `.mcp.json` connects it to the
  container’s Chromium through the `chrome-devtools` MCP server, so it can read the console, run
  scripts in the game page and take screenshots.
- **[Codex](https://github.com/openai/codex)** or another agent: install it in the container (for
  example `npm install -g @openai/codex`). Add its API hosts to `.devcontainer/egress-allow.txt`
  (for Codex: `api.openai.com`, `auth.openai.com` and `chatgpt.com`) and restart the container.
  To let it drive the browser, give it the same MCP server: the command `chrome-devtools-mcp` with
  the arguments `--browserUrl=http://127.0.0.1:9222 --no-usage-statistics`. For Codex, that goes in
  `~/.codex/config.toml` under `[mcp_servers.chrome-devtools]`. Agents that read `AGENTS.md`
  instead of `CLAUDE.md` can be pointed at it with a symlink: `ln -s CLAUDE.md AGENTS.md`.

Chromium’s debugging port (9222) stays inside the container. Don’t publish it: it gives full
control of the browser and the signed-in game.
