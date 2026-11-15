// Runs in the extension's isolated world on the game page. It relays the page hook's messages to
// the background worker, which owns chrome.storage. It forwards only the known types.
//
// When the extension is reloaded or updated, this copy stays in the open tab but loses its link
// to the extension: `chrome.runtime.sendMessage` then throws "Extension context invalidated" at
// once (not as a rejected promise). The bridge notices that and stops. The tab picks up the new
// version when it reloads.

import type { HookMessage } from '@/lib/types';

const TYPES = new Set<HookMessage['type']>(['snapshot', 'landing', 'standings', 'airport']);

export default defineContentScript({
  matches: ['https://pilots.nimblebit.com/*'],
  runAt: 'document_start',
  main() {
    const relay = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data as { __PocketKneeboard?: number; type?: HookMessage['type']; payload?: unknown } | null;
      if (d?.__PocketKneeboard !== 1 || !d.type || !TYPES.has(d.type)) return;
      if (!chrome.runtime?.id) return stop();
      try {
        chrome.runtime.sendMessage({ kb: true, type: d.type, payload: d.payload }).catch(() => {});
      } catch {
        stop();
      }
    };
    const stop = () => {
      window.removeEventListener('message', relay);
      console.info('[PocketKneeboard] The extension was reloaded. Reload this tab to reconnect it.');
    };
    window.addEventListener('message', relay);
    window.postMessage({ __PocketKneeboard: 1, type: 'hello' }, location.origin);
  },
});
