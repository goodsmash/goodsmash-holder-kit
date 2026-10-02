#!/bin/bash
# Double-click to start the holder-kit UI on macOS.
# First time: if macOS says it "cannot be opened", right-click this file -> Open.
cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -n 1 -s -p "Press any key to close this window..."; echo; }

if ! command -v node >/dev/null 2>&1; then
  # Finder-launched shells often miss Homebrew / nvm paths; try the usual ones.
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do [ -x "$p/node" ] && PATH="$p:$PATH"; done
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "holder-kit needs Node.js 20 or newer. Opening https://nodejs.org ..."
  open "https://nodejs.org/en/download" 2>/dev/null
  pause; exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"; then
  echo "holder-kit needs Node.js 20 or newer (you have $(node -v)). Update from https://nodejs.org"
  pause; exit 1
fi
if [ ! -d node_modules/viem ]; then
  echo "First run: installing dependencies (one time)..."
  npm install --no-audit --no-fund || { echo "npm install failed."; pause; exit 1; }
fi

echo "Starting holder-kit. Your browser will open. Close this window (or press Ctrl+C) to stop."
node src/server.mjs --open
pause
