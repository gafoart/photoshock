#!/usr/bin/env bash
# Start Photoshock dev server (http://localhost:5173 by default)
set -e
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Install Node.js from https://nodejs.org/"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run)..."
  npm install
fi

echo "Starting Photoshock — open http://localhost:5173 in your browser"
echo "Press Ctrl+C to stop."
npm run dev
