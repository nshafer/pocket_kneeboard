#!/usr/bin/env bash
# Runs once per container creation (devcontainer postCreateCommand).
#
# The home directory is a named volume, so anything under ~ survives a rebuild, including the
# Chromium profile in ~/.config/pocket_kneeboard-chromium.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> tool versions"
node --version
chromium --version
chrome-devtools-mcp --version || true
