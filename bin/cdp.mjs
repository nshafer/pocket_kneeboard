#!/usr/bin/env node
// Small CDP helpers for the dev browser. No dependencies: Node 22+ has fetch and WebSocket.
//
//   node bin/cdp.mjs reload [--no-tab]   Reload each unpacked extension, then the game tabs.
//
// CDP_URL sets the endpoint. Default: http://127.0.0.1:9222

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const GAME_HOST = "pilots.nimblebit.com";

async function connect() {
  const version = await (await fetch(`${CDP_URL}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = msg.id && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return { send, close: () => ws.close() };
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

// chrome://extensions has the developerPrivate API, which is what its own reload button uses.
async function reloadExtensions(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://extensions" });
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (let i = 0; i < 50; i++) {
      const ready = await evaluate(cdp, sessionId, "typeof chrome?.developerPrivate?.reload === 'function'");
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const all = await chrome.developerPrivate.getExtensionsInfo();
        const unpacked = all.filter((e) => e.location === "UNPACKED");
        for (const e of unpacked) await chrome.developerPrivate.reload(e.id, { failQuietly: true });
        return unpacked.map((e) => e.name + " (" + e.id + ")");
      })()`,
    );
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

async function reloadGameTabs(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const tabs = targetInfos.filter((t) => t.type === "page" && t.url.includes(GAME_HOST));
  for (const tab of tabs) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    await cdp.send("Page.reload", {}, sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
  return tabs.map((t) => t.url);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "reload") {
    console.error("usage: node bin/cdp.mjs reload [--no-tab]");
    process.exit(2);
  }
  const cdp = await connect();
  try {
    const extensions = await reloadExtensions(cdp);
    console.log(extensions.length ? `reloaded: ${extensions.join(", ")}` : "no unpacked extension is loaded");
    if (!args.includes("--no-tab")) {
      const tabs = await reloadGameTabs(cdp);
      console.log(tabs.length ? `reloaded tab: ${tabs.join(", ")}` : `no ${GAME_HOST} tab is open`);
    }
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(`cdp: ${err.message}`);
  process.exit(1);
});
