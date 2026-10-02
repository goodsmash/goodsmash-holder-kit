#!/bin/sh
# Linux / WSL / any POSIX shell: start the holder-kit UI and open the browser.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "holder-kit needs Node.js 20+: https://nodejs.org"; exit 1; }
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)" || { echo "holder-kit needs Node.js 20+ (you have $(node -v))"; exit 1; }
[ -d node_modules/viem ] || npm install --no-audit --no-fund || exit 1
exec node src/server.mjs --open
