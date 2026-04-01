# Photoshock — feature reference

Desktop web app for painting, selecting, grading, and composing **3D Gaussian splat** scenes. Built with **PlayCanvas** and **SplatTransform**. This document lists user-facing capabilities as implemented in the UI and `src/main.js`.

---

## Platform and deployment

- **Desktop only** — A full-screen gate blocks use on small / non-desktop viewports.
- **Progressive Web App (PWA)** — Installable from a production HTTPS build; service worker precaches the app shell (large loaded `.ply` / `.sog` files are not precached).
- **Branding** — Favicons and manifest icons use `public/brand/` (SVG + PNG sizes).

---

## File I/O

| Action | Details |
|--------|---------|
| **Load Splat** | Replace the scene with a `.ply`, `.compressed.ply`, or `.sog` file (base model). |
| **Import as layer** | Add another splat file as a new layer on top of the existing base and layers. |
| **Export PLY** | Merge visible base + layers (with paint, erase, opacity, and color grade baked where applicable) and download `painted.ply`. |
| **Viewport snapshot** | Menu: **Snapshot…** — render the current view to PNG or JPEG at chosen pixel size; optional **transparent background** (PNG). |

---

## Layers

- **Stack** — Base model at bottom; user layers above (paint / import / shape splats).
- **Add layer** — New empty layer with auto-generated name.
- **Visibility** — Per-layer eye toggle; base visibility toggles the imported model entity.
- **Opacity** — Per-layer (and base) **0–100%** numeric control; drives display opacity on splats.
- **Duplicate** — Clone a user layer.
- **Delete** — Remove a user layer; **Remove base** clears the base import (layers can remain).
- **Reorder** — Drag handle to reorder user layers (draw order).
- **Rename** — **Double-click the layer name** when that row is **already selected** (second click within ~350 ms on the name) to edit inline; Enter confirms, Escape cancels.
- **Merge** — Merge other layers into the selected layer.
- **Separate selection** — Move the current selection into a new layer (active user layer context).

---

## Tools (left toolbar) and options (top bar)

Keyboard shortcuts are shown in tooltips where applicable (e.g. **V** cursor, **B** brush).

### Navigation and view

- **Cursor (V)** — Orbit (left drag), pan (right drag), scroll zoom; **double-click** refocuses orbit target (cursor tool). **WASD** / **Q**/**E** in orbit or fly modes.
- **Camera modes** — **Orbit** vs **Fly** (` backtick toggles); floating bar controls.
- **Reset camera** / **Frame active layer** — Floating gizmo bar.
- **Viewport grid** — Optional XZ reference grid (toggle on floating bar).

### Painting

- **Brush (B)** — Color (picker + hex), size, hardness, intensity, **blend** (Normal / Multiply / Lighten / Darken), spacing.
- **Eraser (X)** — Same-style brush for opacity; optional **depth** along view for non-spherical erase.
- **Reset brush (Z)** — Restore original splat colors in the brushed region (clears paint & erase on GPU path for affected splats).
- **Paint bucket (K)** — Fill **all selected** splats using brush color, blend, and intensity (options shared with brush panel).
- **Bake to model** — Commit accumulated GPU paint/erase (and related state) into splat data for brush / paint bucket workflows.

### Selection

Shared strip (when relevant): **selection highlight** on/off, **paint only in selection** vs protect selection, **depth** for how deep along the ray selection reaches, highlight **color** and **mix**.

- **Box select (O)** — Rectangle drag; **Select all** / **Invert**; **Sharpen selected** (scale shrink). In splat + ring mode, can target ring hits.
- **Lasso (L)** — Freehand loop; **Alt** temporarily swaps add/subtract.
- **Polygon select (Y)** — Click vertices; **Enter** closes (≥3 points); **Backspace** removes last point.
- **Brush select (R)** — Paint selection with a brush (size / hardness / spacing).
- **Color select (C)** — Pick a splat; select similar colors with **tolerance**; loupe under cursor; sharpen selected.
- **Splat select (S)** — Click / drag for individual splats; **Shift** additive; **TAB** hint ties to **Splat mode** overlay.

Floating bar when in selection tools: modes **New / Add / Subtract** (and keys **8 / 9 / 0**), select all, invert, clear (**Delete**).

### Splat overlay (M)

- **Splat mode** — Overlay on true colors: **Centers** (dots) or **Rings** (ellipse strokes); affects picking behavior for some tools.

### Generate splats (G)

- Paint new splats into gaps on the base (or suitable target); **Alt+click** samples color from the scene; size and density controls.

### Shape layer (N)

- **Parametric shapes**: Cube, Sphere, Cylinder, Plane, Cone, **Pyramid**, Torus.
- **Size** (X/Y/Z) and **rotation** (degrees X/Y/Z) in the top bar; values sync with the **translate / rotate / scale** gizmo when the preview is active.
- **Density** (k splats, up to 1000k), **color**, **Hollow** (edge-only splats vs solid + wire preview).
- **Add** — Place a **preview** at orbit target (preview can follow target while panning in orbit mode).
- **Drag on canvas** — Place preview at picked depth; drag to **uniform scale** (updates size fields).
- **Splat it** — Build splat layer from preview **world transform**; then removes preview.
- Switching to **Cursor (V)** keeps the wire preview in the scene so you can orbit and return to Shape layer; other tools clear the preview.
- Preferences for shape UI persist in `localStorage`.

---

## Transform gizmo and numeric transforms

- **Translate / Rotate / Scale** gizmo on the floating bar (**1 / 2 / 3** keys); visibility toggle.
- Attaches to **base** or **selected user layer** entity, or to the **shape preview** when Shape layer + preview exist.
- **Layer transform** panel (Scene tab): position, rotation (degrees), scale for the active layer/base — stays in sync with the gizmo.

---

## Color tab (right panel)

Per-layer **color grade** (and optional **grade selection only**):

- **Exposure (EV)**, **contrast**, **black / white** points.
- **Saturation**, **temperature**, **tint**.
- **Split tone** — Shadow / mid / highlight tint colors and amounts.
- **Hue zones** — Eight hue bins (red … magenta) with per-zone hue shift, saturation multiplier offset, luminance offset.
- **Reset** grade / **Bake to model** — Bake grade into splat colors (and related GPU paint on base), then reset controls.

---

## Scene tab extras

- **Saved selections** — Name and save selection masks; **export/import** JSON.
- **Swatches** — Save paint colors; pick color from a splat on canvas.

---

## Undo / redo

- **Ctrl+Z** / **Ctrl+Y** (or **Shift+Ctrl+Z**) for paint/erase/reset and supported operations; UI buttons in the menu bar.

---

## Math in numeric fields

- On **blur** (e.g. Tab or click away), any **`type="number"`** field can evaluate a **simple arithmetic expression** (e.g. `0.5*2`, `360/4`, `1+0.25`). The field briefly becomes a text input while focused so symbols can be typed; result is clamped to min/max. Plain numbers are unchanged.

---

## Menu bar misc

- **Background color** — Clear color behind the scene (also used for opaque snapshots).
- **Undo / Redo** — See above.

---

## Technical notes (for power users)

- **Rendering** — PlayCanvas with GSplat component; WebGPU preferred, WebGL2 fallback.
- **Export pipeline** — Merges base + visible layers; respects color grades and layer opacities; uses CPU/GPU bake paths consistent with the editor where implemented.
- **Formats** — Load: `.ply`, `.compressed.ply`, `.sog`. Export button: **PLY** download as above.

---

*Last updated to match the repository layout and UI structure. For setup and install, see [README.md](README.md).*
