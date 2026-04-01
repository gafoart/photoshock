# Photoshock

Paint on 3D Gaussian splats and export them as **PLY** or **SOG** format. Built with [PlayCanvas Engine](https://playcanvas.com/) and [SplatTransform](https://github.com/playcanvas/splat-transform).

Based on the [PlayCanvas Gaussian Splatting Paint Example](https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/paint.example.mjs).

## Features

- **Load** PLY, compressed PLY, or SOG files
- **Paint** with right mouse button - adjustable color, intensity, and brush size
- **Orbit** camera with left mouse (drag) and scroll wheel (zoom)
- **Export** painted splats as `.ply` or `.sog`

## Quick Start

**From Terminal:**

```bash
npm install
npm run dev
```

**Or use the launcher scripts** (same as `npm run dev`; runs `npm install` on first use):

- **macOS (Finder):** double-click **`run.command`**
- **Terminal:** `./run.sh` or `bash run.sh`

Open http://localhost:5173 in your browser (Vite may print a different port if 5173 is busy).

## Install as a PWA (Mac / desktop)

After a production build, serve the app over **HTTP** (not `file://`):

```bash
npm run build
npm run preview
```

Then in **Chrome**: menu → **Save and share** → **Install Photoshock…**  
Or in **Safari** (macOS): **File → Add to Dock** (or the Share menu, depending on version).

You get a standalone window and offline use for cached assets. Large `.ply` / `.sog` files you load are **not** precached (only the app shell is).

To test the service worker during `npm run dev`, set `devOptions.enabled: true` in `vite.config.js` under the PWA plugin.

## Usage

1. **Load a splat** – Use the file input to load a `.ply`, `.compressed.ply`, or `.sog` file
2. **Paint** – Right-click and drag to paint. Adjust color, intensity, and brush size in the toolbar
3. **Export** – Click "Export PLY" or "Export SOG" to download the painted result

## Formats

| Format | Load | Export |
|--------|------|--------|
| `.ply` | ✅ | ✅ |
| `.compressed.ply` | ✅ | ✅ |
| `.sog` | ✅ | ✅ (requires decompression) |

SOG export uses [SplatTransform](https://github.com/playcanvas/splat-transform) and may use WebGPU for compression. PLY export works in all environments.

## Controls

| Action | Control |
|--------|---------|
| Paint | Right mouse button + drag |
| Orbit | Left mouse button + drag |
| Zoom | Mouse wheel |
