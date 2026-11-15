## Kneeboard

A Manifest V3 Chrome extension that acts as a companion to the Nimblebit's game Pocket Pilots.

### The dev browser

The devcontainer runs Chromium on a virtual display. `bin/browser` controls it, and
`postStartCommand` starts it.

- The user sees the screen at http://127.0.0.1:4090/ on the host (noVNC). The user plays the game
  there, so do not close the game tab or move its window without a reason.
- Claude drives the browser through the `chrome-devtools` MCP server (`.mcp.json`). It connects to
  CDP at http://127.0.0.1:9222. Use it to read the console, take screenshots and run scripts in the
  page.
- `bin/browser reload` reloads the unpacked extension and the game tab. Run it after each build.
- `bin/browser restart` is necessary after the extension folder changes, because Chromium reads
  `--load-extension` only when it starts. `bin/browser` loads the first of `extension/`, `dist/`,
  `.output/chrome-mv3-dev` and `.output/chrome-mv3` that has a `manifest.json`. Set
  `KNEEBOARD_EXT_DIR` to use a different folder.
- Chromium renders on the host GPU (AMD RX 9070) through `/dev/dri/renderD128` and Vulkan.
  `KNEEBOARD_GPU=0 bin/browser restart` uses the software renderer.
- `bin/browser status` and `bin/browser logs` help when something does not start.
- The Chromium profile is in `~/.config/kneeboard-chromium`, on the persisted home volume. It holds
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
