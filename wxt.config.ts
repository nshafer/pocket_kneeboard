import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // WXT drops the underscore from the package name; keep the project's snake_case name.
  zip: { artifactTemplate: 'pocket_kneeboard-{{version}}-{{browser}}.zip' },
  manifest: {
    name: 'Pocket Kneeboard',
    description: 'A pilot’s kneeboard for Pocket Pilots. Shows the airport influence you add, in a side panel.',
    // Public key only. It pins the extension ID (niglcngodhkbapfekmdadiakbbdpeeai) so the unpacked
    // extension keeps its ID, and its saved records, wherever its folder is.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuNBTWeE1w6FEu7xmJFtREnHMV7t9sDt1tPQDy1EiC54GMtNi9xlUeUJWHjNJOSTLNx/J7ltsTrd42RZU9P4jNTQYkLvDytFyXkAYzZgAIU1wnOuK+3l4eaE/5s5uvTGcOsyF0HNa+aoAgxpzNtxtW8ABfYDELT8/17DXQfoneSB4ygG07wuE297hfjxm8LYEUg0e44eURIh13FYIIrxBmaX9cK+0dkhq5+XxZByng96SQdH0FS//lsB3IitPI1UNtGsl/+ufrMtEf4UeLyCE0beaTIfTcn8rbyzRgQhWL0HzvkVw+lq7Jz8ZZcsjCi+67W1YqIuh1AY6dBx1m0Kg+QIDAQAB',
    permissions: ['storage', 'sidePanel'],
    host_permissions: ['https://pilots.nimblebit.com/*'],
    action: { default_title: 'Pocket Kneeboard' },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+K' }, description: 'Show or hide the Pocket Kneeboard' },
      // For the installed app (PWA), whose windows have no side panel. Not global: Chrome allows
      // only Ctrl+Shift+[0-9] for that, so this works while any Chrome window, app ones included,
      // has focus.
      'open-window': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Open the Pocket Kneeboard in its own window',
      },
    },
  },
});
