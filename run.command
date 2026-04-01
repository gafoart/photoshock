#!/bin/bash
# Double-click this file in Finder to start Photoshock (macOS).
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js from https://nodejs.org/"
  read -r -p "Press Enter to close..."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run)..."
  npm install
fi

echo "Starting Photoshock — open http://localhost:5173 in your browser"
echo "Close this window or press Ctrl+C to stop the server."
npm run dev
