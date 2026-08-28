#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js 22 or newer is required."
  echo "Opening https://nodejs.org — install it, then double-click this file again."
  echo
  open "https://nodejs.org" 2>/dev/null || xdg-open "https://nodejs.org" 2>/dev/null || true
  read -r -p "Press Return to close…"
  exit 1
fi

echo "Building Font Manager installers..."
echo "Leave this window open. First build can take a long time."
echo
node scripts/deploy.mjs
echo
read -r -p "Press Return to close…"
