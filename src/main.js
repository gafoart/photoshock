import * as pc from 'playcanvas';
import { DataTable, Column, MemoryFileSystem, writePly } from '@playcanvas/splat-transform';
import { registerSW } from 'virtual:pwa-register';
import { hydrateTablerIcons, warmTablerIconCache, tablerIconHtmlSync } from './tabler-icons.js';
import { initCgGradeSliderUi, refreshCgGradeSliderTracks } from './cg-grade-slider-ui.js';
import { initSupportModal, isSupportModalOpen, closeSupportModalSnoozed } from './support-modal.js';
import { initPosthog, getPosthog } from './posthog-client.js';
import { initSupabaseAuth, isSupabaseAuthEnabled, getCachedSession, getSupabase } from './supabase-client.js';
import { initAuthModal, openAuthModal, updateAuthBar } from './auth-modal.js';
import { parseCubeLut, sampleCubeTrilinear, lutFloatRgbToRgba8 } from './cube-lut.js';

registerSW({ immediate: true });
void initPosthog();

await warmTablerIconCache([
    'file-import', 'stack-push', 'arrow-back-up', 'arrow-forward-up', 'color-picker', 'hand-love-you', 'keyboard',
    'location', 'brush', 'eraser', 'restore', 'bucket-droplet', 'grid-3x3', 'selection-rectangle', 'lasso', 'polygon', 'selection-brush', 'color-selection', 'braille',
    'square-rounded', 'square-rounded-plus', 'square-rounded-minus',
    'cube-3d-sphere', 'grid-dots', 'square-off', 'circle-dot', 'circle',
    'eye', 'eye-off', 'layout-grid', 'copy', 'trash', 'stack-2', 'arrows-split',
    'square-plus', 'arrow-merge', 'arrows-move', 'rotate', 'resize', 'gizmo',
    'select-all', 'arrows-left-right', 'blur-off', 'focus-centered', 'grip-vertical',
    'file-export', 'camera', 'plus', 'camera-rotate',
    'cube-plus', 'reload', 'circle-check', 'login', 'logout', 'brand-google',
]);
await warmTablerIconCache(['tilt-shift'], 'filled');
await hydrateTablerIcons(document.getElementById('app'));
initAuthModal();
void initSupabaseAuth((session) => updateAuthBar(session));
initSupportModal();

// ── Constants ────────────────────────────────────────────────────────────────
const SH_C0 = 0.28209479177387814;
const sigmoid    = (v) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v) => -Math.log(1 / Math.max(1e-6, Math.min(1 - 1e-6, v)) - 1);
const smoothstepJS = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/** Plain number or simple arithmetic (+ − * / % ** parentheses). Whitelist only — no identifiers. */
const parseNumericOrExpr = (raw) => {
    const s = String(raw ?? '').trim();
    if (s === '' || s === '-' || s === '.' || s === '-.') return null;
    const compact = s.replace(/\s+/g, '');
    if (/^[\d+\-*/().%]+$/.test(compact)) {
        try {
            const v = new Function(`"use strict"; return (${compact})`)();
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        } catch (_) { /* incomplete or invalid */ }
    }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
};

const numericFieldValueOrNull = (raw) => {
    const ev = parseNumericOrExpr(raw);
    if (ev != null && Number.isFinite(ev)) return ev;
    const pf = parseFloat(String(raw ?? '').trim());
    return Number.isFinite(pf) ? pf : null;
};

/** Let users type expressions (e.g. 0.4+1) in fields that were type="number". */
const enableNumericExprTyping = (el) => {
    if (!(el instanceof HTMLInputElement)) return;
    if (el.type === 'number') {
        el.type = 'text';
        el.setAttribute('inputmode', 'decimal');
        el.setAttribute('spellcheck', 'false');
    }
};

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const ty = (t.type || '').toLowerCase();
    if (ty === 'button' || ty === 'submit' || ty === 'checkbox' || ty === 'radio' || ty === 'file' || ty === 'range' || ty === 'color' || ty === 'hidden' || ty === 'reset') return;
    e.preventDefault();
    t.blur();
}, true);

// Plateau falloff for paint (matches GPU): inner region = full strength so ALPHABLEND
// doesn’t strand splats at low alpha (mottled / lighter random splats).
const paintPlateauFalloff = (dist, radius, hardness) => {
    if (radius <= 0 || dist >= radius) return 0;
    const u = dist / radius;
    const h = Math.max(0, Math.min(1, hardness));
    const feather = (1 - h) * 0.4 + h * 0.05;
    const inner = 1 - feather;
    if (u <= inner) return 1;
    return 1 - smoothstepJS(inner, 1, u);
};

// ── Shader: paint ────────────────────────────────────────────────────────────
// Writes only to customColor. Uses ALPHABLEND accumulation.
const PAINT_GLSL = /* glsl */`
uniform vec4  uPaintSphere;     // xyz=center (model space), w=radius
uniform vec4  uPaintColor;     // rgb=color, a=intensity
uniform float uHardness;       // 0=soft, 1=hard
// 0 = ignore selection · 1 = exclude selected · 2 = only selected
uniform int   uSelectionConstraint;

void process() {
    vec3  center = getCenter();
    float dist   = distance(center, uPaintSphere.xyz);
    if (dist >= uPaintSphere.w) { writeCustomColor(vec4(0.0)); return; }

    float sel = loadCustomSelection().r;
    if (uSelectionConstraint == 1 && sel > 0.5) { writeCustomColor(vec4(0.0)); return; }
    if (uSelectionConstraint == 2 && sel <= 0.5) { writeCustomColor(vec4(0.0)); return; }

    // Plateau: nearly flat fill in the interior, short smooth rim only.
    // Reduces mottling from SRC_ALPHA blending when falloff varies per splat per dab.
    float u = dist / uPaintSphere.w;
    float h = clamp(uHardness, 0.0, 1.0);
    float feather = mix(0.40, 0.05, h);
    float inner = 1.0 - feather;
    float falloff = (u <= inner) ? 1.0 : (1.0 - smoothstep(inner, 1.0, u));
    if (falloff < 0.008) return;
    writeCustomColor(vec4(uPaintColor.rgb, uPaintColor.a * falloff));
}
`;

const PAINT_WGSL = /* wgsl */`
uniform uPaintSphere:    vec4f;
uniform uPaintColor:     vec4f;
uniform uHardness:       f32;
uniform uSelectionConstraint: i32;

fn process() {
    let center = getCenter();
    let dist   = distance(center, uniform.uPaintSphere.xyz);
    if dist >= uniform.uPaintSphere.w { writeCustomColor(vec4f(0.0)); return; }

    let sel = loadCustomSelection().r;
    if uniform.uSelectionConstraint == 1 && sel > 0.5 { writeCustomColor(vec4f(0.0)); return; }
    if uniform.uSelectionConstraint == 2 && sel <= 0.5 { writeCustomColor(vec4f(0.0)); return; }

    let u = dist / uniform.uPaintSphere.w;
    let h = clamp(uniform.uHardness, 0.0, 1.0);
    let feather = mix(0.40, 0.05, h);
    let inner = 1.0 - feather;
    var falloff = 1.0;
    if u > inner {
        falloff = 1.0 - smoothstep(inner, 1.0, u);
    }
    if falloff < 0.008 { return; }
    writeCustomColor(vec4f(
        uniform.uPaintColor.r,
        uniform.uPaintColor.g,
        uniform.uPaintColor.b,
        uniform.uPaintColor.a * falloff
    ));
}
`;

// ── Shader: erase ────────────────────────────────────────────────────────────
// Writes only to customOpacity. Uses ADDITIVE accumulation.
const ERASE_GLSL = /* glsl */`
uniform vec4  uPaintSphere;
uniform vec4  uPaintColor;     // a = erase intensity
uniform float uHardness;
uniform int   uSelectionConstraint;
// View ray in model space (unit). uEraseDepthHalf > 0 → cylinder along this axis
// (radius uPaintSphere.w, half-length uEraseDepthHalf); 0 → sphere.
uniform vec3  uEraseViewDir;
uniform float uEraseDepthHalf;

void process() {
    vec3  center = getCenter();
    vec3  d      = center - uPaintSphere.xyz;

    float inside = 0.0;
    float tEdge  = 0.0;

    if (uEraseDepthHalf < 1e-6) {
        float dist = length(d);
        if (dist >= uPaintSphere.w) { writeCustomOpacity(vec4(0.0)); return; }
        tEdge = dist / uPaintSphere.w;
        inside = 1.0;
    } else {
        vec3  V = uEraseViewDir;
        float longitud = dot(d, V);
        float perpSq   = dot(d, d) - longitud * longitud;
        float perp     = sqrt(max(perpSq, 0.0));
        float R = uPaintSphere.w;
        float D = max(uEraseDepthHalf, 1e-6);
        if (perp >= R || abs(longitud) > D) { writeCustomOpacity(vec4(0.0)); return; }
        tEdge = max(perp / R, abs(longitud) / D);
        inside = 1.0;
    }

    if (inside < 0.5) { writeCustomOpacity(vec4(0.0)); return; }

    float sel = loadCustomSelection().r;
    if (uSelectionConstraint == 1 && sel > 0.5) { writeCustomOpacity(vec4(0.0)); return; }
    if (uSelectionConstraint == 2 && sel <= 0.5) { writeCustomOpacity(vec4(0.0)); return; }

    float t       = 1.0 - tEdge;
    float falloff  = (uHardness >= 1.0) ? 1.0
                   : smoothstep(0.0, max(0.001, 1.0 - uHardness), t);
    writeCustomOpacity(vec4(0.0, 0.0, 0.0, uPaintColor.a * falloff));
}
`;

const ERASE_WGSL = /* wgsl */`
uniform uPaintSphere:    vec4f;
uniform uPaintColor:     vec4f;
uniform uHardness:       f32;
uniform uSelectionConstraint: i32;
uniform uEraseViewDir:   vec3f;
uniform uEraseDepthHalf: f32;

fn process() {
    let center = getCenter();
    let d = center - uniform.uPaintSphere.xyz;

    var inside = 0.0;
    var tEdge = 0.0;

    if uniform.uEraseDepthHalf < 1e-6 {
        let dist = length(d);
        if dist >= uniform.uPaintSphere.w { writeCustomOpacity(vec4f(0.0)); return; }
        tEdge = dist / uniform.uPaintSphere.w;
        inside = 1.0;
    } else {
        let V = uniform.uEraseViewDir;
        let longitud = dot(d, V);
        let perpSq = dot(d, d) - longitud * longitud;
        let perp = sqrt(max(perpSq, 0.0));
        let R = uniform.uPaintSphere.w;
        let D = max(uniform.uEraseDepthHalf, 1e-6);
        if perp >= R || abs(longitud) > D { writeCustomOpacity(vec4f(0.0)); return; }
        tEdge = max(perp / R, abs(longitud) / D);
        inside = 1.0;
    }

    if inside < 0.5 { writeCustomOpacity(vec4f(0.0)); return; }

    let sel = loadCustomSelection().r;
    if uniform.uSelectionConstraint == 1 && sel > 0.5 { writeCustomOpacity(vec4f(0.0)); return; }
    if uniform.uSelectionConstraint == 2 && sel <= 0.5 { writeCustomOpacity(vec4f(0.0)); return; }

    let t = 1.0 - tEdge;
    let falloff = select(
        smoothstep(0.0, max(0.001, 1.0 - uniform.uHardness), t),
        1.0, uniform.uHardness >= 1.0
    );
    writeCustomOpacity(vec4f(0.0, 0.0, 0.0, uniform.uPaintColor.a * falloff));
}
`;

// ── Shader: reset (restore original colors) ────────────────────────────────────
// Write (0,0,0,falloff). Blend dst*(1-src.a) clears when falloff=1, preserves when falloff=0.
// No read needed — can't read/write same stream in one pass.
const RESET_COLOR_GLSL = /* glsl */`
uniform vec4 uPaintSphere;
uniform float uHardness;
uniform int   uSelectionConstraint;

void process() {
    vec3 center = getCenter();
    float dist = distance(center, uPaintSphere.xyz);
    if (dist >= uPaintSphere.w) { writeCustomColor(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    float sel = loadCustomSelection().r;
    if (uSelectionConstraint == 1 && sel > 0.5) { writeCustomColor(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    if (uSelectionConstraint == 2 && sel <= 0.5) { writeCustomColor(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    float t = 1.0 - dist / uPaintSphere.w;
    float falloff = (uHardness >= 1.0) ? 1.0 : smoothstep(0.0, max(0.001, 1.0 - uHardness), t);
    writeCustomColor(vec4(0.0, 0.0, 0.0, falloff));
}
`;
const RESET_COLOR_WGSL = /* wgsl */`
uniform uPaintSphere: vec4f;
uniform uHardness: f32;
uniform uSelectionConstraint: i32;

fn process() {
    let center = getCenter();
    let dist = distance(center, uniform.uPaintSphere.xyz);
    if dist >= uniform.uPaintSphere.w { writeCustomColor(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    let sel = loadCustomSelection().r;
    if uniform.uSelectionConstraint == 1 && sel > 0.5 { writeCustomColor(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    if uniform.uSelectionConstraint == 2 && sel <= 0.5 { writeCustomColor(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    let t = 1.0 - dist / uniform.uPaintSphere.w;
    let falloff = select(smoothstep(0.0, max(0.001, 1.0 - uniform.uHardness), t), 1.0, uniform.uHardness >= 1.0);
    writeCustomColor(vec4f(0.0, 0.0, 0.0, falloff));
}
`;
const RESET_OPACITY_GLSL = /* glsl */`
uniform vec4 uPaintSphere;
uniform float uHardness;
uniform int   uSelectionConstraint;

void process() {
    vec3 center = getCenter();
    float dist = distance(center, uPaintSphere.xyz);
    if (dist >= uPaintSphere.w) { writeCustomOpacity(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    float sel = loadCustomSelection().r;
    if (uSelectionConstraint == 1 && sel > 0.5) { writeCustomOpacity(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    if (uSelectionConstraint == 2 && sel <= 0.5) { writeCustomOpacity(vec4(0.0, 0.0, 0.0, 0.0)); return; }
    float t = 1.0 - dist / uPaintSphere.w;
    float falloff = (uHardness >= 1.0) ? 1.0 : smoothstep(0.0, max(0.001, 1.0 - uHardness), t);
    writeCustomOpacity(vec4(0.0, 0.0, 0.0, falloff));
}
`;
const RESET_OPACITY_WGSL = /* wgsl */`
uniform uPaintSphere: vec4f;
uniform uHardness: f32;
uniform uSelectionConstraint: i32;

fn process() {
    let center = getCenter();
    let dist = distance(center, uniform.uPaintSphere.xyz);
    if dist >= uniform.uPaintSphere.w { writeCustomOpacity(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    let sel = loadCustomSelection().r;
    if uniform.uSelectionConstraint == 1 && sel > 0.5 { writeCustomOpacity(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    if uniform.uSelectionConstraint == 2 && sel <= 0.5 { writeCustomOpacity(vec4f(0.0, 0.0, 0.0, 0.0)); return; }
    let t = 1.0 - dist / uniform.uPaintSphere.w;
    let falloff = select(smoothstep(0.0, max(0.001, 1.0 - uniform.uHardness), t), 1.0, uniform.uHardness >= 1.0);
    writeCustomOpacity(vec4f(0.0, 0.0, 0.0, falloff));
}
`;

// ── Shader: paint bucket (fill selected splats; blend mode applied in modifier) ─
const PAINT_BUCKET_GLSL = /* glsl */`
uniform vec4 uBucketColor;

void process() {
    if (loadCustomSelection().r <= 0.5) { writeCustomColor(vec4(0.0)); return; }
    writeCustomColor(vec4(uBucketColor.rgb, uBucketColor.a));
}
`;
const PAINT_BUCKET_WGSL = /* wgsl */`
uniform uBucketColor: vec4f;

fn process() {
    if loadCustomSelection().r <= 0.5 { writeCustomColor(vec4f(0.0)); return; }
    writeCustomColor(vec4f(
        uniform.uBucketColor.r,
        uniform.uBucketColor.g,
        uniform.uBucketColor.b,
        uniform.uBucketColor.a
    ));
}
`;

// ── Shader: work-buffer modifier ─────────────────────────────────────────────
// Blends paint color and erase opacity into every rendered splat each frame.
// Also overlays a tint on selected splats (see selection highlight).
const MODIFIER_GLSL = /* glsl */`
uniform int  uBlendMode;        // 0=Normal 1=Multiply 2=Lighten 3=Darken
uniform int  uShowSelection;
uniform vec4 uSelectionColor;  // rgb = highlight color, a = intensity (0-1)
uniform int  uSplatMode;        // 0=off 1=centers (cyan dots) 2=rings (colored rim stroke) — see gsplatPS patch
uniform vec4 uHoverSphere;      // xyz = model-space center, w = radius (0 = off)
uniform vec4 uHoverColor;       // rgb = tint, a = strength
uniform int  uRenderBoxEnabled; // 1 = clip to render box in layer-local space
uniform vec3 uRenderBoxCenter;
uniform vec3 uRenderBoxHalf;
// modifySplatColor receives world-space centers; map back to splat/model space for box + hover.
uniform mat4 uWorldToModel;

// Per-layer color grade (viewport; baked on export / Bake to model)
uniform vec4 uGradeBasicA;      // exposure (EV), contrast, blackPoint, whitePoint
uniform vec4 uGradeBasicB;      // saturation, temperature (blue-yellow), tint (green-magenta), _
uniform vec3 uGradeWheelSh;
uniform vec3 uGradeWheelMd;
uniform vec3 uGradeWheelHi;
uniform vec4 uGradeCross;       // luminance split thresholds for shadow / mid / highlight
uniform int  uGradeEnabled;      // 1 = enabled, 0 = preview hidden
uniform int  uGradeSelectedOnly; // 1 = apply grade only to splats in customSelection
uniform vec3 uGradeSec0;
uniform vec3 uGradeSec1;
uniform vec3 uGradeSec2;
uniform vec3 uGradeSec3;
uniform vec3 uGradeSec4;
uniform vec3 uGradeSec5;
uniform vec3 uGradeSec6;
uniform vec3 uGradeSec7;
uniform float uLayerOpacity;    // 0–1, multiplies final splat alpha (layer / base display)
uniform int  uGradeToneMode;      // 0 Linear, 1 Neutral, 2 ACES, 3 ACES2, 4 Filmic, 5 Hejl
uniform vec4 uGradeLutMeta;     // x=1 enabled, y=N, z=mixin, w unused
uniform vec3 uGradeLutDomainMin;
uniform vec3 uGradeLutDomainInv;
uniform sampler2D uGradeLutTex;

void modifySplatCenter(inout vec3 center) {}
void modifySplatRotationScale(vec3 oc, vec3 mc, inout vec4 rotation, inout vec3 scale) {
    // Splat view overlay (cyan center dots + ring strokes) is done in gsplatPS patch.
}

vec3 sp_uch(vec3 x) {
    const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 sp_neutral_tm(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= vec3(offset);
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / max(peak, 1e-6);
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
}
vec3 sp_rrt_odt_fit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}
vec3 sp_aces2_tm(vec3 color) {
    const mat3 inMat = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
    );
    const mat3 outMat = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
    );
    vec3 v = inMat * color;
    v = sp_rrt_odt_fit(v);
    return outMat * v;
}
vec3 sp_hejl_tm(vec3 x) {
    vec3 c = max(vec3(0.0), x - vec3(0.004));
    return (c * (6.2 * c + 0.5)) / (c * (6.2 * c + 1.7) + 0.06);
}
vec3 sp_tone_map(vec3 x, int mode) {
    if (mode <= 0) return clamp(x, 0.0, 1.0); // Linear
    if (mode == 1) return clamp(sp_neutral_tm(x), 0.0, 1.0);
    if (mode == 2) return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); // ACES (Narkowicz)
    if (mode == 3) return clamp(sp_aces2_tm(x), 0.0, 1.0);
    if (mode == 4) return clamp(sp_uch(x) / sp_uch(vec3(11.2)), 0.0, 1.0); // Filmic (Uncharted 2)
    return clamp(sp_hejl_tm(x), 0.0, 1.0);
}
vec3 sp_lut_fetch(ivec3 ijk, int Ni) {
    int xf = ijk.x + ijk.y * Ni;
    int yf = ijk.z;
    return texelFetch(uGradeLutTex, ivec2(xf, yf), 0).rgb;
}
vec3 sp_lut_apply(vec3 c) {
    if (uGradeLutMeta.x <= 0.5) return c;
    float N = uGradeLutMeta.y;
    float NiF = N - 1.0;
    int Ni = int(N + 0.5);
    vec3 p = clamp((c - uGradeLutDomainMin) * uGradeLutDomainInv, 0.0, 1.0) * NiF;
    vec3 p0f = floor(p);
    vec3 p1f = min(p0f + vec3(1.0), vec3(N - 1.0));
    vec3 f = p - p0f;
    ivec3 i0 = ivec3(p0f);
    ivec3 i1 = ivec3(p1f);
    vec3 c000 = sp_lut_fetch(ivec3(i0.x, i0.y, i0.z), Ni);
    vec3 c100 = sp_lut_fetch(ivec3(i1.x, i0.y, i0.z), Ni);
    vec3 c010 = sp_lut_fetch(ivec3(i0.x, i1.y, i0.z), Ni);
    vec3 c110 = sp_lut_fetch(ivec3(i1.x, i1.y, i0.z), Ni);
    vec3 c001 = sp_lut_fetch(ivec3(i0.x, i0.y, i1.z), Ni);
    vec3 c101 = sp_lut_fetch(ivec3(i1.x, i0.y, i1.z), Ni);
    vec3 c011 = sp_lut_fetch(ivec3(i0.x, i1.y, i1.z), Ni);
    vec3 c111 = sp_lut_fetch(ivec3(i1.x, i1.y, i1.z), Ni);
    vec3 cx00 = mix(c000, c100, f.x);
    vec3 cx10 = mix(c010, c110, f.x);
    vec3 cx01 = mix(c001, c101, f.x);
    vec3 cx11 = mix(c011, c111, f.x);
    vec3 cxy0 = mix(cx00, cx10, f.y);
    vec3 cxy1 = mix(cx01, cx11, f.y);
    vec3 outL = mix(cxy0, cxy1, f.z);
    return mix(c, outL, clamp(uGradeLutMeta.z, 0.0, 1.0));
}

vec3 sp_rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 sp_hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 sp_grade_sectors(vec3 rgb) {
    vec3 hsv = sp_rgb2hsv(clamp(rgb, 0.0, 1.0));
    float fsec = hsv.x * 8.0;
    vec3 adj = uGradeSec0;
    if (fsec >= 1.0) adj = uGradeSec1;
    if (fsec >= 2.0) adj = uGradeSec2;
    if (fsec >= 3.0) adj = uGradeSec3;
    if (fsec >= 4.0) adj = uGradeSec4;
    if (fsec >= 5.0) adj = uGradeSec5;
    if (fsec >= 6.0) adj = uGradeSec6;
    if (fsec >= 7.0) adj = uGradeSec7;
    hsv.x = fract(hsv.x + adj.x);
    hsv.y = clamp(hsv.y * (1.0 + adj.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z + adj.z, 0.0, 1.0);
    return sp_hsv2rgb(hsv);
}

vec3 sp_color_grade(vec3 col, float Lsplit) {
    vec3 g = col * exp2(uGradeBasicA.x);
    g = sp_tone_map(g, uGradeToneMode);
    g = sp_lut_apply(g);
    float bp = uGradeBasicA.z;
    float wp = max(uGradeBasicA.w, bp + 1e-4);
    g = (g - bp) / max(wp - bp, 1e-4);
    g = (g - 0.5) * uGradeBasicA.y + 0.5;
    g = clamp(g, 0.0, 1.0);
    g = sp_grade_sectors(g);
    float lu = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(lu), g, clamp(uGradeBasicB.x, 0.0, 4.0));
    g.r += uGradeBasicB.y * 0.14;
    g.b -= uGradeBasicB.y * 0.14;
    g.r += uGradeBasicB.z * 0.10;
    g.g -= uGradeBasicB.z * 0.10;
    float sw = 1.0 - smoothstep(uGradeCross.x, uGradeCross.y, Lsplit);
    float mw = smoothstep(uGradeCross.x, uGradeCross.y, Lsplit) * (1.0 - smoothstep(uGradeCross.z, uGradeCross.w, Lsplit));
    float hw = smoothstep(uGradeCross.z, uGradeCross.w, Lsplit);
    g += uGradeWheelSh * sw + uGradeWheelMd * mw + uGradeWheelHi * hw;
    return clamp(g, 0.0, 1.0);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 mpos = (uWorldToModel * vec4(center, 1.0)).xyz;
    if (uRenderBoxEnabled != 0) {
        vec3 dBox = abs(mpos - uRenderBoxCenter);
        if (any(greaterThan(dBox, uRenderBoxHalf))) {
            color = vec4(0.0);
            return;
        }
    }
    // Paint colour blend
    vec4 c = loadCustomColor();
    if (c.a > 0.0) {
        if      (uBlendMode == 1) color.rgb = mix(color.rgb, color.rgb * c.rgb, c.a);
        else if (uBlendMode == 2) color.rgb = mix(color.rgb, max(color.rgb, c.rgb), c.a);
        else if (uBlendMode == 3) color.rgb = mix(color.rgb, min(color.rgb, c.rgb), c.a);
        else                      color.rgb = mix(color.rgb, c.rgb, c.a);
    }

    // Erase opacity
    vec4 e = loadCustomOpacity();
    if (e.a > 0.0) {
        color.a = max(0.0, color.a * (1.0 - clamp(e.a, 0.0, 1.0)));
    }

    // Brush hover preview: tint splats inside the hover sphere
    if (uHoverSphere.w > 0.0) {
        float nd = length(mpos - uHoverSphere.xyz) / uHoverSphere.w;
        if (nd < 1.0) {
            float f = clamp((1.0 - nd) * uHoverColor.a, 0.0, 1.0);
            color.rgb = mix(color.rgb, uHoverColor.rgb, f);
            color.a   = max(color.a, f * 0.4);
        }
    }

    vec3 pre = color.rgb;
    float Lsplit = clamp(dot(pre, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    bool applyGrade = (uGradeEnabled != 0) && (uGradeSelectedOnly == 0);
    if (uGradeEnabled != 0 && uGradeSelectedOnly != 0) {
        vec4 selG = loadCustomSelection();
        applyGrade = (uGradeEnabled != 0) && (selG.r > 0.5);
    }
    if (applyGrade) color.rgb = sp_color_grade(pre, Lsplit);
    else color.rgb = pre;

    // Selection highlight (after grade)
    if (uShowSelection > 0) {
        vec4 sel = loadCustomSelection();
        if (sel.r > 0.5) {
            color.rgb = mix(color.rgb, uSelectionColor.rgb, uSelectionColor.a);
        }
    }

    color.a *= clamp(uLayerOpacity, 0.0, 1.0);
}
`;

const MODIFIER_WGSL = /* wgsl */`
uniform uBlendMode:     i32;
uniform uShowSelection: i32;
uniform uSelectionColor: vec4f;
uniform uSplatMode:     i32;
uniform uHoverSphere:   vec4f;
uniform uHoverColor:    vec4f;
uniform uRenderBoxEnabled: i32;
uniform uRenderBoxCenter: vec3f;
uniform uRenderBoxHalf: vec3f;
uniform uWorldToModel: mat4x4f;
uniform uGradeBasicA: vec4f;
uniform uGradeBasicB: vec4f;
uniform uGradeWheelSh: vec3f;
uniform uGradeWheelMd: vec3f;
uniform uGradeWheelHi: vec3f;
uniform uGradeCross: vec4f;
uniform uGradeEnabled: i32;
uniform uGradeSelectedOnly: i32;
uniform uGradeSec0: vec3f;
uniform uGradeSec1: vec3f;
uniform uGradeSec2: vec3f;
uniform uGradeSec3: vec3f;
uniform uGradeSec4: vec3f;
uniform uGradeSec5: vec3f;
uniform uGradeSec6: vec3f;
uniform uGradeSec7: vec3f;
uniform uLayerOpacity: f32;
uniform uGradeToneMode: i32;
uniform uGradeLutMeta: vec4f;
uniform uGradeLutDomainMin: vec3f;
uniform uGradeLutDomainInv: vec3f;
var uGradeLutTex: texture_2d<f32>;

fn sp_uch(x: vec3f) -> vec3f {
    let A = 0.15;
    let B = 0.50;
    let C = 0.10;
    let D = 0.20;
    let E = 0.02;
    let F = 0.30;
    return (x * (A * x + vec3f(C * B)) + vec3f(D * E)) / (x * (A * x + vec3f(B)) + vec3f(D * F)) - vec3f(E / F);
}
fn sp_neutral_tm_w(colorIn: vec3f) -> vec3f {
    var color = colorIn;
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;
    let x = min(color.x, min(color.y, color.z));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    color -= vec3f(offset);
    let peak = max(color.x, max(color.y, color.z));
    if peak < startCompression { return color; }
    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / max(peak, 1e-6);
    let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3f(newPeak), g);
}
fn sp_rrt_odt_fit_w(v: vec3f) -> vec3f {
    let a = v * (v + vec3f(0.0245786)) - vec3f(0.000090537);
    let b = v * (0.983729 * v + vec3f(0.4329510)) + vec3f(0.238081);
    return a / b;
}
fn sp_aces2_tm_w(color: vec3f) -> vec3f {
    let inMat = mat3x3f(
        vec3f(0.59719, 0.07600, 0.02840),
        vec3f(0.35458, 0.90834, 0.13383),
        vec3f(0.04823, 0.01566, 0.83777)
    );
    let outMat = mat3x3f(
        vec3f(1.60475, -0.10208, -0.00327),
        vec3f(-0.53108, 1.10813, -0.07276),
        vec3f(-0.07367, -0.00605, 1.07602)
    );
    var v = inMat * color;
    v = sp_rrt_odt_fit_w(v);
    return outMat * v;
}
fn sp_hejl_tm_w(x: vec3f) -> vec3f {
    let c = max(vec3f(0.0), x - vec3f(0.004));
    return (c * (6.2 * c + vec3f(0.5))) / (c * (6.2 * c + vec3f(1.7)) + vec3f(0.06));
}
fn sp_tone_map_w(x: vec3f, mode: i32) -> vec3f {
    if mode <= 0 { return clamp(x, vec3f(0.0), vec3f(1.0)); } // Linear
    if mode == 1 { return clamp(sp_neutral_tm_w(x), vec3f(0.0), vec3f(1.0)); }
    if mode == 2 {
        return clamp((x * (2.51 * x + vec3f(0.03))) / (x * (2.43 * x + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));
    }
    if mode == 3 { return clamp(sp_aces2_tm_w(x), vec3f(0.0), vec3f(1.0)); }
    if mode == 4 { return clamp(sp_uch(x) / sp_uch(vec3f(11.2)), vec3f(0.0), vec3f(1.0)); }
    return clamp(sp_hejl_tm_w(x), vec3f(0.0), vec3f(1.0));
}
fn sp_lut_fetch_w(ijk: vec3i, Ni: i32) -> vec3f {
    let xf = ijk.x + ijk.y * Ni;
    let yf = ijk.z;
    return textureLoad(uGradeLutTex, vec2i(xf, yf), 0).xyz;
}
fn sp_lut_apply_w(c: vec3f) -> vec3f {
    if uniform.uGradeLutMeta.x <= 0.5 { return c; }
    let N = uniform.uGradeLutMeta.y;
    let NiF = N - 1.0;
    let Ni = i32(N + 0.5);
    let p = clamp((c - uniform.uGradeLutDomainMin) * uniform.uGradeLutDomainInv, vec3f(0.0), vec3f(1.0)) * NiF;
    let p0f = floor(p);
    let p1f = min(p0f + vec3f(1.0), vec3f(N - 1.0));
    let f = p - p0f;
    let i0 = vec3i(i32(p0f.x), i32(p0f.y), i32(p0f.z));
    let i1 = vec3i(i32(p1f.x), i32(p1f.y), i32(p1f.z));
    let c000 = sp_lut_fetch_w(vec3i(i0.x, i0.y, i0.z), Ni);
    let c100 = sp_lut_fetch_w(vec3i(i1.x, i0.y, i0.z), Ni);
    let c010 = sp_lut_fetch_w(vec3i(i0.x, i1.y, i0.z), Ni);
    let c110 = sp_lut_fetch_w(vec3i(i1.x, i1.y, i0.z), Ni);
    let c001 = sp_lut_fetch_w(vec3i(i0.x, i0.y, i1.z), Ni);
    let c101 = sp_lut_fetch_w(vec3i(i1.x, i0.y, i1.z), Ni);
    let c011 = sp_lut_fetch_w(vec3i(i0.x, i1.y, i1.z), Ni);
    let c111 = sp_lut_fetch_w(vec3i(i1.x, i1.y, i1.z), Ni);
    let cx00 = mix(c000, c100, f.x);
    let cx10 = mix(c010, c110, f.x);
    let cx01 = mix(c001, c101, f.x);
    let cx11 = mix(c011, c111, f.x);
    let cxy0 = mix(cx00, cx10, f.y);
    let cxy1 = mix(cx01, cx11, f.y);
    let outL = mix(cxy0, cxy1, f.z);
    return mix(c, outL, clamp(uniform.uGradeLutMeta.z, 0.0, 1.0));
}

fn sp_rgb2hsv(c: vec3f) -> vec3f {
    let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    let p = mix(vec4f(c.b, c.g, K.w, K.z), vec4f(c.g, c.b, K.x, K.y), step(c.b, c.g));
    let q = mix(vec4f(p.x, p.y, p.w, c.r), vec4f(c.r, p.y, p.z, p.x), step(p.x, c.r));
    let d = q.x - min(q.w, q.y);
    let e = 1.0e-10;
    return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn sp_hsv2rgb(c: vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn sp_grade_sectors(rgb: vec3f) -> vec3f {
    var hsv = sp_rgb2hsv(clamp(rgb, vec3f(0.0), vec3f(1.0)));
    let fsec = hsv.x * 8.0;
    var adj = uniform.uGradeSec0;
    if fsec >= 1.0 { adj = uniform.uGradeSec1; }
    if fsec >= 2.0 { adj = uniform.uGradeSec2; }
    if fsec >= 3.0 { adj = uniform.uGradeSec3; }
    if fsec >= 4.0 { adj = uniform.uGradeSec4; }
    if fsec >= 5.0 { adj = uniform.uGradeSec5; }
    if fsec >= 6.0 { adj = uniform.uGradeSec6; }
    if fsec >= 7.0 { adj = uniform.uGradeSec7; }
    hsv.x = fract(hsv.x + adj.x);
    hsv.y = clamp(hsv.y * (1.0 + adj.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z + adj.z, 0.0, 1.0);
    return sp_hsv2rgb(hsv);
}

fn sp_color_grade(col: vec3f, Lsplit: f32) -> vec3f {
    var g = col * exp2(uniform.uGradeBasicA.x);
    g = sp_tone_map_w(g, uniform.uGradeToneMode);
    g = sp_lut_apply_w(g);
    let bp = uniform.uGradeBasicA.z;
    let wp = max(uniform.uGradeBasicA.w, bp + 1e-4);
    g = (g - bp) / max(wp - bp, 1e-4);
    g = (g - 0.5) * uniform.uGradeBasicA.y + 0.5;
    g = clamp(g, vec3f(0.0), vec3f(1.0));
    g = sp_grade_sectors(g);
    let lu = dot(g, vec3f(0.2126, 0.7152, 0.0722));
    g = mix(vec3f(lu), g, clamp(uniform.uGradeBasicB.x, 0.0, 4.0));
    g.x += uniform.uGradeBasicB.y * 0.14;
    g.z -= uniform.uGradeBasicB.y * 0.14;
    g.x += uniform.uGradeBasicB.z * 0.10;
    g.y -= uniform.uGradeBasicB.z * 0.10;
    let sw = 1.0 - smoothstep(uniform.uGradeCross.x, uniform.uGradeCross.y, Lsplit);
    let mw = smoothstep(uniform.uGradeCross.x, uniform.uGradeCross.y, Lsplit) * (1.0 - smoothstep(uniform.uGradeCross.z, uniform.uGradeCross.w, Lsplit));
    let hw = smoothstep(uniform.uGradeCross.z, uniform.uGradeCross.w, Lsplit);
    g += uniform.uGradeWheelSh * sw + uniform.uGradeWheelMd * mw + uniform.uGradeWheelHi * hw;
    return clamp(g, vec3f(0.0), vec3f(1.0));
}

fn modifySplatCenter(center: ptr<function, vec3f>) {}
fn modifySplatRotationScale(oc: vec3f, mc: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let mpos = (uniform.uWorldToModel * vec4f(center, 1.0)).xyz;
    if uniform.uRenderBoxEnabled != 0 {
        let dBox = abs(mpos - uniform.uRenderBoxCenter);
        if any(dBox > uniform.uRenderBoxHalf) {
            (*color) = vec4f(0.0);
            return;
        }
    }
    let c = loadCustomColor();
    if c.a > 0.0 {
        if uniform.uBlendMode == 1 {
            (*color).r = mix((*color).r, (*color).r * c.r, c.a);
            (*color).g = mix((*color).g, (*color).g * c.g, c.a);
            (*color).b = mix((*color).b, (*color).b * c.b, c.a);
        } else if uniform.uBlendMode == 2 {
            (*color).r = mix((*color).r, max((*color).r, c.r), c.a);
            (*color).g = mix((*color).g, max((*color).g, c.g), c.a);
            (*color).b = mix((*color).b, max((*color).b, c.b), c.a);
        } else if uniform.uBlendMode == 3 {
            (*color).r = mix((*color).r, min((*color).r, c.r), c.a);
            (*color).g = mix((*color).g, min((*color).g, c.g), c.a);
            (*color).b = mix((*color).b, min((*color).b, c.b), c.a);
        } else {
            (*color).r = mix((*color).r, c.r, c.a);
            (*color).g = mix((*color).g, c.g, c.a);
            (*color).b = mix((*color).b, c.b, c.a);
        }
    }
    let e = loadCustomOpacity();
    if e.a > 0.0 {
        (*color).a = max(0.0, (*color).a * (1.0 - clamp(e.a, 0.0, 1.0)));
    }
    // Brush hover preview
    if uniform.uHoverSphere.w > 0.0 {
        let nd = length(mpos - uniform.uHoverSphere.xyz) / uniform.uHoverSphere.w;
        if nd < 1.0 {
            let f = clamp((1.0 - nd) * uniform.uHoverColor.a, 0.0, 1.0);
            (*color).r = mix((*color).r, uniform.uHoverColor.r, f);
            (*color).g = mix((*color).g, uniform.uHoverColor.g, f);
            (*color).b = mix((*color).b, uniform.uHoverColor.b, f);
            (*color).a = max((*color).a, f * 0.4);
        }
    }
    let pre = vec3f((*color).r, (*color).g, (*color).b);
    let Lsplit = clamp(dot(pre, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    var applyGrade = (uniform.uGradeEnabled != 0) && (uniform.uGradeSelectedOnly == 0);
    if uniform.uGradeEnabled != 0 && uniform.uGradeSelectedOnly != 0 {
        let selG = loadCustomSelection();
        applyGrade = (uniform.uGradeEnabled != 0) && (selG.r > 0.5);
    }
    if applyGrade {
        let graded = sp_color_grade(pre, Lsplit);
        (*color).r = graded.x;
        (*color).g = graded.y;
        (*color).b = graded.z;
    } else {
        (*color).r = pre.x;
        (*color).g = pre.y;
        (*color).b = pre.z;
    }
    if uniform.uShowSelection > 0 {
        let sel = loadCustomSelection();
        if sel.r > 0.5 {
            (*color).r = mix((*color).r, uniform.uSelectionColor.r, uniform.uSelectionColor.a);
            (*color).g = mix((*color).g, uniform.uSelectionColor.g, uniform.uSelectionColor.a);
            (*color).b = mix((*color).b, uniform.uSelectionColor.b, uniform.uSelectionColor.a);
        }
    }
    (*color).a *= clamp(uniform.uLayerOpacity, 0.0, 1.0);
}
`;

/** Ring stroke width in splat UV radius units (0 = center, 1 = ellipse edge). */
const SPLAT_VIEW_RING_THICKNESS = 0.022;

/**
 * Patch engine `gsplatPS` for SuperSplat-style splat view:
 * mode 1 = normal gaussian fill + sharp cyan center dots; mode 2 = fill + per-splat RGB rim stroke.
 */
const installGsplatSplatViewFragmentShaderPatch = (gfxDevice) => {
    const tag = '// photoshock: gsplat view';

    // ── GLSL ──────────────────────────────────────────────────────────────
    const glslMap = pc.ShaderChunks.get(gfxDevice, pc.SHADERLANGUAGE_GLSL ?? 'glsl');
    if (!glslMap?.get) {
        console.warn('[photoshock] ShaderChunks GLSL map unavailable');
        return;
    }
    const glsl = glslMap.get('gsplatPS');
    if (!glsl) {
        console.warn('[photoshock] gsplatPS GLSL chunk not found');
    } else if (glsl.includes(tag)) {
        console.log('[photoshock] gsplatPS GLSL already patched');
    } else {
        const inj = 'varying mediump vec4 gaussianColor;';
        if (!glsl.includes(inj)) {
            console.warn('[photoshock] gsplatPS GLSL: injection point not found');
        } else {
            let code = glsl.replace(
                inj,
                `${inj}\nuniform int uSplatMode;\nuniform float uSplatRingThickness;\n${tag}`,
            );

            // Match the forward rendering block after all the special passes.
            // Use a regex to be whitespace-resilient.
            const forwardRe = /#else\s+if\s*\(\s*alpha\s*<\s*1\.0\s*\/\s*255\.0\s*\)\s*\{\s*discard;\s*\}\s*#ifndef\s+DITHER_NONE\s+opacityDither\(\s*alpha\s*,\s*id\s*\*\s*0\.013\s*\);\s*#endif\s+gl_FragColor\s*=\s*vec4\(\s*gaussianColor\.xyz\s*\*\s*alpha\s*,\s*alpha\s*\);\s*#endif/;

            if (forwardRe.test(code)) {
                code = code.replace(forwardRe,
`#else
\tif (uSplatMode != 0) {
\t\tmediump vec3 rgb = gaussianColor.rgb;
\t\tmediump float ne = normExp(A);
\t\tmediump float ba = ne * gaussianColor.a;
\t\tmediump vec3 basePm = rgb * ba;
\t\tif (uSplatMode == 2 && uSplatRingThickness > 0.0) {
\t\t\tmediump float edge = sqrt(max(A, 1e-8));
\t\t\tmediump float t = clamp(uSplatRingThickness, 0.005, 0.1);
\t\t\tmediump float lo = max(0.05, 1.0 - t);
\t\t\tmediump float ringMask = smoothstep(lo - t * 0.06, lo, edge) * (1.0 - smoothstep(1.0 - 0.0004, 1.0 + t * 0.028, edge));
\t\t\tmediump float rimA = ringMask * 0.98;
\t\t\tgl_FragColor = vec4(basePm + rgb * rimA * 1.65, max(ba, rimA));
\t\t} else if (uSplatMode == 1) {
\t\t\tconst mediump vec3 SPLAT_CENTER_CYAN = vec3(0.18, 0.74, 1.0);
\t\t\tconst mediump float centerRad2 = 0.0028;
\t\t\tmediump float c = 1.0 - smoothstep(0.0, centerRad2, A);
\t\t\tc = c * c * c;
\t\t\tmediump float dotA = c * 0.99;
\t\t\tgl_FragColor = vec4(basePm + SPLAT_CENTER_CYAN * dotA * 2.15, max(ba, dotA));
\t\t} else {
\t\t\tgl_FragColor = vec4(basePm, ba);
\t\t}
\t\tif (gl_FragColor.a < 1.0 / 255.0) { discard; }
\t} else {
\t\tif (alpha < 1.0 / 255.0) { discard; }
\t\t#ifndef DITHER_NONE
\t\t\topacityDither(alpha, id * 0.013);
\t\t#endif
\t\tgl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);
\t}
#endif`);
                glslMap.set('gsplatPS', code);
                console.log('[photoshock] gsplatPS GLSL patched OK');
            } else {
                console.warn('[photoshock] gsplatPS GLSL: forward block regex did not match');
                console.warn('[photoshock] chunk tail:', glsl.slice(-300));
            }
        }
    }

    // ── WGSL ──────────────────────────────────────────────────────────────
    const wgslMap = pc.ShaderChunks.get(gfxDevice, pc.SHADERLANGUAGE_WGSL ?? 'wgsl');
    if (!wgslMap?.get) return;

    const wgsl = wgslMap.get('gsplatPS');
    if (!wgsl) {
        console.warn('[photoshock] gsplatPS WGSL chunk not found');
    } else if (wgsl.includes(tag)) {
        console.log('[photoshock] gsplatPS WGSL already patched');
    } else {
        const winj = 'varying gaussianColor: vec4f;';
        if (!wgsl.includes(winj)) {
            console.warn('[photoshock] gsplatPS WGSL: injection point not found');
        } else {
            let code = wgsl.replace(
                winj,
                `${winj}\nuniform uSplatMode: i32;\nuniform uSplatRingThickness: f32;\n${tag}`,
            );

            const wgslForwardRe = /#else\s+if\s*\(\s*alpha\s*<\s*\(?\s*1\.0\s*\/\s*255\.0\s*\)?\s*\)\s*\{\s*discard;\s*return\s+output;\s*\}\s*#ifndef\s+DITHER_NONE\s+opacityDither\(\s*&alpha\s*,\s*id\s*\*\s*0\.013\s*\);\s*#endif\s+output\.color\s*=\s*vec4f\(\s*input\.gaussianColor\.xyz\s*\*\s*alpha\s*,\s*alpha\s*\);\s*#endif/;

            if (wgslForwardRe.test(code)) {
                code = code.replace(wgslForwardRe,
`#else
\tif (uniform.uSplatMode != 0) {
\t\tlet rgb = gaussianColor.xyz;
\t\tlet ne = normExp(A);
\t\tlet ba = ne * gaussianColor.a;
\t\tlet basePm = rgb * ba;
\t\tif (uniform.uSplatMode == 2 && uniform.uSplatRingThickness > 0.0) {
\t\t\tlet edge = sqrt(max(A, 1e-8));
\t\t\tlet t = clamp(uniform.uSplatRingThickness, 0.005, 0.1);
\t\t\tlet lo = max(0.05, 1.0 - t);
\t\t\tlet ringMask = smoothstep(lo - t * 0.06, lo, edge) * (1.0 - smoothstep(1.0 - 0.0004, 1.0 + t * 0.028, edge));
\t\t\tlet rimA = ringMask * 0.98;
\t\t\toutput.color = vec4f(basePm + rgb * rimA * 1.65, max(ba, rimA));
\t\t} else if (uniform.uSplatMode == 1) {
\t\t\tlet SPLAT_CENTER_CYAN = vec3f(0.18, 0.74, 1.0);
\t\t\tlet centerRad2 = 0.0028;
\t\t\tvar c = 1.0 - smoothstep(0.0, centerRad2, A);
\t\t\tc = c * c * c;
\t\t\tlet dotA = c * 0.99;
\t\t\toutput.color = vec4f(basePm + SPLAT_CENTER_CYAN * dotA * 2.15, max(ba, dotA));
\t\t} else {
\t\t\toutput.color = vec4f(basePm, ba);
\t\t}
\t\tif (output.color.a < (1.0 / 255.0)) { discard; return output; }
\t} else {
\t\tif (alpha < (1.0 / 255.0)) { discard; return output; }
\t\t#ifndef DITHER_NONE
\t\t\topacityDither(&alpha, id * 0.013);
\t\t#endif
\t\toutput.color = vec4f(input.gaussianColor.xyz * alpha, alpha);
\t}
#endif`);
                wgslMap.set('gsplatPS', code);
                console.log('[photoshock] gsplatPS WGSL patched OK');
            } else {
                console.warn('[photoshock] gsplatPS WGSL: forward block regex did not match');
                console.warn('[photoshock] wgsl chunk tail:', wgsl.slice(-300));
            }
        }
    }
};

// ── PlayCanvas app ────────────────────────────────────────────────────────────
const canvas = document.getElementById('application-canvas');

const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2],
    antialias: false,
});

const appOptions = new pc.AppOptions();
appOptions.graphicsDevice = device;
appOptions.mouse = new pc.Mouse(canvas);
appOptions.mouse.disableContextMenu();
appOptions.touch = new pc.TouchDevice(canvas);
appOptions.componentSystems = [
    pc.RenderComponentSystem, pc.CameraComponentSystem, pc.GSplatComponentSystem,
];
appOptions.resourceHandlers = [
    pc.TextureHandler, pc.ContainerHandler, pc.GSplatHandler,
];

const app = new pc.AppBase(canvas);
app.init(appOptions);
// Must run after app.init(): AppBase registers default ShaderChunks (including gsplatPS),
// which would overwrite any earlier patch.
installGsplatSplatViewFragmentShaderPatch(app.graphicsDevice);
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_AUTO);

// GPU-side splat ordering when supported (WebGPU always; WebGL2 if engine exposes it).
try {
    app.scene.gsplat.gpuSorting = true;
} catch (_) { /* ignore */ }

/** 2×2 neutral LUT; bound when no .cube is active so the sampler stays valid. */
let _dummyGradeLutTex = null;
const getDummyGradeLutTex = () => {
    if (_dummyGradeLutTex) return _dummyGradeLutTex;
    const t = new pc.Texture(app.graphicsDevice, {
        width: 2,
        height: 2,
        format: pc.PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: pc.FILTER_NEAREST,
        magFilter: pc.FILTER_NEAREST,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        name: 'dummy-grade-lut',
    });
    const d = t.lock();
    if (d) {
        d.fill(128);
        for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;
        t.unlock();
    }
    _dummyGradeLutTex = t;
    return _dummyGradeLutTex;
};

const canvasContainer = document.getElementById('canvas-container');

/** Blocks user-driven splat file load/import when Supabase auth is configured and there is no session. */
const ensureCanLoadModel = async () => {
    if (!isSupabaseAuthEnabled()) return true;
    const sb = getSupabase();
    if (!sb) return true;
    let session = getCachedSession();
    if (!session?.user) {
        const { data } = await sb.auth.getSession();
        session = data.session ?? null;
    }
    if (session?.user) return true;
    openAuthModal({ reason: 'load' });
    return false;
};

const isSplatDropFile = (name) => {
    const lower = (name || '').toLowerCase();
    return lower.endsWith('.sog') || lower.endsWith('.ply') || lower.endsWith('.compressed.ply');
};

/** SOG bundles default to GPU-compressed data; Photoshock needs full GSplatData for paint/export/CPU layers. */
const gsplatAssetDataForFilename = (filename) => {
    if ((filename || '').toLowerCase().endsWith('.sog')) return { decompress: true };
    return {};
};

/** CPU-side splat table: SOG uses async decompress(); compressed PLY is sync. */
const resolveGsplatCpuData = async (rawData) => {
    if (!rawData) return null;
    if (typeof rawData.decompress !== 'function') return rawData;
    const d = rawData.decompress();
    return d && typeof d.then === 'function' ? await d : d;
};

/** Local splat files at or above this size use staggered CPU cache init (yield between copies). */
const GSPLAT_LARGE_FILE_STAGGER_BYTES = 50 * 1024 * 1024;

/** Optional viewport resolution scale (0.5–1). Smaller = faster GPU, softer image. `?rscale=0.75` or localStorage `photoshock-render-scale`. */
const LS_RENDER_SCALE = 'photoshock-render-scale';
/** Default on: cap effective scale for huge splat counts (set `0` to disable). `?auto_rscale=0` */
const LS_AUTO_RSCALE = 'photoshock-auto-rscale';
/** Default on: adaptive performance governor (budget + rscale) for huge scenes. `?adaptive_perf=0` */
const LS_ADAPTIVE_PERF = 'photoshock-adaptive-perf';
/** Apply soft cap when total splats ≥ this (export still uses full data). */
const RSCALE_AUTO_MIN_SPLATS = 500_000;
/** Max effective scale when auto kicks in (≈39% fewer pixels vs 1.0 at 0.78). */
const RSCALE_AUTO_CAP = 0.78;
/** Runtime cap managed by adaptive controller (null = disabled). */
let adaptiveRenderScaleCap = null;

const getRenderScaleFactor = () => {
    let s = 1;
    try {
        const u = new URLSearchParams(location.search).get('rscale');
        if (u != null) {
            const v = parseFloat(u);
            if (Number.isFinite(v)) s = v;
        } else {
            const ls = localStorage.getItem(LS_RENDER_SCALE);
            if (ls != null) {
                const v = parseFloat(ls);
                if (Number.isFinite(v)) s = v;
            }
        }
    } catch (_) { /* ignore */ }
    return Math.min(1, Math.max(0.5, s));
};

/**
 * User rscale plus optional automatic cap for very large models (better FPS on fill-bound GPUs).
 * Skips auto when `?rscale=` is present (explicit tuning) or `photoshock-auto-rscale=0` / `?auto_rscale=0`.
 */
const getEffectiveRenderScaleFactor = () => {
    const base = getRenderScaleFactor();
    const n = gsplatDataCache?.numSplats ?? 0;
    if (n < RSCALE_AUTO_MIN_SPLATS) {
        return adaptiveRenderScaleCap == null ? base : Math.min(base, adaptiveRenderScaleCap);
    }
    let autoOn = true;
    try {
        if (localStorage.getItem(LS_AUTO_RSCALE) === '0') autoOn = false;
    } catch (_) { /* ignore */ }
    try {
        const q = new URLSearchParams(location.search);
        if (q.get('auto_rscale') === '0') autoOn = false;
        if (q.get('auto_rscale') === '1') autoOn = true;
        if (q.get('rscale') != null) return adaptiveRenderScaleCap == null ? base : Math.min(base, adaptiveRenderScaleCap);
    } catch (_) { /* ignore */ }
    const autoCapped = autoOn ? Math.min(base, RSCALE_AUTO_CAP) : base;
    return adaptiveRenderScaleCap == null ? autoCapped : Math.min(autoCapped, adaptiveRenderScaleCap);
};

/** Reuse engine Float32Array columns when possible — avoids an extra full copy. */
const floatPropToCache = (buf) => {
    if (buf == null) return null;
    return buf instanceof Float32Array ? buf : new Float32Array(buf);
};

/**
 * Build deferred higher-order SH columns (f_rest_*) once; large duplicate of GPU data.
 * Call before any path that reads `gsplatDataCache.shRest`.
 */
const ensureBaseGsplatShRestHydratedFromDeferred = () => {
    const c = gsplatDataCache;
    if (!c || c.shRest != null || !c._cpuGsplatDataForShRest) return;
    const data = c._cpuGsplatDataForShRest;
    const shRest = [];
    for (let i = 0; i < 45; i++) {
        const k = `f_rest_${i}`;
        const a = data.getProp(k);
        if (a) shRest.push({ key: k, data: floatPropToCache(a) });
    }
    c.shRest = shRest;
    c._cpuGsplatDataForShRest = null;
};

// ── Spatial base chunks (distance-cull splats; optional for huge models) ───────
/** `?chunks=1` or localStorage `photoshock-base-chunks=1`, or auto when splat count ≥ min. */
const LS_BASE_CHUNKS = 'photoshock-base-chunks';
const BASE_CHUNK_GRID_DIVISIONS = 3;
const BASE_CHUNK_MIN_SPLATS = 350_000;
/** Smaller multiplier = fewer distant chunks enabled at once (major FPS lever with chunking). */
const BASE_CHUNK_STREAM_RADIUS_MULT = 2.25;
/** SuperSplat-like safety valve: cap active rendered splats (0 disables budget clamp). */
const LS_BASE_SPLAT_BUDGET = 'photoshock-base-splat-budget';
const DEFAULT_BASE_SPLAT_BUDGET = 1_200_000;
/** Frustum-like cone prefilter (behind camera / extreme side chunks). */
const BASE_CHUNK_VIEW_CONE_PAD_DEG = 16;

/** Huge splat counts / files: start orbit closer to scene center (fewer splats on screen → faster). */
const CLOSE_ORBIT_SPLAT_THRESHOLD = 350_000;
const CLOSE_ORBIT_FILE_BYTES = 45 * 1024 * 1024;
/** distance ≈ longest box half-edge (was 2.8× = very wide shot). */
const CLOSE_ORBIT_DIST_MULT = 1.08;
const TIGHT_ORBIT_SPLAT_THRESHOLD = 1_200_000;
const TIGHT_ORBIT_FILE_BYTES = 200 * 1024 * 1024;
/** “Inside” the scan — still outside center but much closer than full-scene framing. */
const TIGHT_ORBIT_DIST_MULT = 0.72;

let baseSpatialChunkingActive = false;
let baseSpatialStreamRadius = null;
/** When spatial chunking is on, layer eye toggles this; `updateSpatialBaseChunkVisibility` respects it. */
let baseLayerHiddenByUser = false;
/** Runtime budget managed by adaptive controller (null = user/default budget only). */
let adaptiveBaseSplatBudget = null;

const getConfiguredBaseSplatBudget = () => {
    let budget = DEFAULT_BASE_SPLAT_BUDGET;
    try {
        const q = new URLSearchParams(location.search).get('sbudget');
        if (q != null) {
            const v = parseInt(q, 10);
            if (Number.isFinite(v)) budget = v;
        } else {
            const ls = localStorage.getItem(LS_BASE_SPLAT_BUDGET);
            if (ls != null) {
                const v = parseInt(ls, 10);
                if (Number.isFinite(v)) budget = v;
            }
        }
    } catch (_) { /* ignore */ }
    return Math.max(0, budget | 0);
};

const getBaseSplatBudget = () => {
    const manual = getConfiguredBaseSplatBudget();
    return adaptiveBaseSplatBudget == null ? manual : Math.min(manual, adaptiveBaseSplatBudget);
};

const shouldSpatialChunkBase = (numSplats, opts = {}) => {
    if (opts.spatialChunkBase === false) return false;
    if (opts.spatialChunkBase === true) return true;
    try {
        const q = new URLSearchParams(location.search).get('chunks');
        if (q === '0' || q === 'false') return false;
        if (q === '1') return true;
        if (localStorage.getItem(LS_BASE_CHUNKS) === '1') return true;
    } catch (_) { /* ignore */ }
    return numSplats >= BASE_CHUNK_MIN_SPLATS;
};

const sliceF32ByIndices = (arr, indices) => {
    if (!arr) return null;
    const n = indices.length;
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) out[j] = arr[indices[j]];
    return out;
};

/**
 * Spatial partition for chunking: counting-sort style (one Uint32 slab + cursors).
 * Avoids O(n) JS `[]` push/GC churn from Map-of-arrays on multi-million splat scenes.
 */
const partitionCacheIndicesByGrid = (cache, divs) => {
    const { x, y, z, numSplats } = cache;
    if (!x || !y || !z || !numSplats) return [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < numSplats; i++) {
        minX = Math.min(minX, x[i]);
        maxX = Math.max(maxX, x[i]);
        minY = Math.min(minY, y[i]);
        maxY = Math.max(maxY, y[i]);
        minZ = Math.min(minZ, z[i]);
        maxZ = Math.max(maxZ, z[i]);
    }
    const sx = (maxX - minX) / divs || 1;
    const sy = (maxY - minY) / divs || 1;
    const sz = (maxZ - minZ) / divs || 1;
    const d = divs;
    const cellCount = d * d * d;
    const counts = new Int32Array(cellCount);
    for (let i = 0; i < numSplats; i++) {
        let ix = Math.floor((x[i] - minX) / sx);
        let iy = Math.floor((y[i] - minY) / sy);
        let iz = Math.floor((z[i] - minZ) / sz);
        ix = Math.max(0, Math.min(d - 1, ix));
        iy = Math.max(0, Math.min(d - 1, iy));
        iz = Math.max(0, Math.min(d - 1, iz));
        const ci = ix + iy * d + iz * d * d;
        counts[ci]++;
    }
    const starts = new Int32Array(cellCount);
    let acc = 0;
    for (let c = 0; c < cellCount; c++) {
        starts[c] = acc;
        acc += counts[c];
    }
    const bucketData = new Uint32Array(numSplats);
    const next = new Int32Array(starts);
    for (let i = 0; i < numSplats; i++) {
        let ix = Math.floor((x[i] - minX) / sx);
        let iy = Math.floor((y[i] - minY) / sy);
        let iz = Math.floor((z[i] - minZ) / sz);
        ix = Math.max(0, Math.min(d - 1, ix));
        iy = Math.max(0, Math.min(d - 1, iy));
        iz = Math.max(0, Math.min(d - 1, iz));
        const ci = ix + iy * d + iz * d * d;
        const pos = next[ci]++;
        bucketData[pos] = i;
    }
    const out = [];
    for (let c = 0; c < cellCount; c++) {
        const cnt = counts[c];
        if (cnt === 0) continue;
        const start = starts[c];
        out.push({ indices: bucketData.subarray(start, start + cnt) });
    }
    return out;
};

const computeCacheBoundingRadius = (cache) => {
    const { x, y, z, numSplats } = cache;
    if (!x?.length || !numSplats) return 10;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < numSplats; i++) {
        minX = Math.min(minX, x[i]);
        maxX = Math.max(maxX, x[i]);
        minY = Math.min(minY, y[i]);
        maxY = Math.max(maxY, y[i]);
        minZ = Math.min(minZ, z[i]);
        maxZ = Math.max(maxZ, z[i]);
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    let r = 0;
    for (let i = 0; i < numSplats; i++) {
        const dx = x[i] - cx;
        const dy = y[i] - cy;
        const dz = z[i] - cz;
        r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return Math.max(r, 0.5);
};

const dataTableFromGsplatCacheIndices = (cache, indices) => {
    ensureBaseGsplatShRestHydratedFromDeferred();
    const columns = [];
    const push = (name, arr) => {
        if (!arr) return;
        columns.push(new Column(name, sliceF32ByIndices(arr, indices)));
    };
    push('x', cache.x);
    push('y', cache.y);
    push('z', cache.z);
    const ex = cache.extra;
    if (ex) {
        push('nx', ex.nx);
        push('ny', ex.ny);
        push('nz', ex.nz);
    }
    push('f_dc_0', cache.fdc0);
    push('f_dc_1', cache.fdc1);
    push('f_dc_2', cache.fdc2);
    if (cache.shRest?.length) {
        for (const sh of cache.shRest) push(sh.key, sh.data);
    }
    push('opacity', cache.opacity);
    if (ex) {
        push('scale_0', ex.scale_0);
        push('scale_1', ex.scale_1);
        push('scale_2', ex.scale_2);
        push('rot_0', ex.rot_0);
        push('rot_1', ex.rot_1);
        push('rot_2', ex.rot_2);
        push('rot_3', ex.rot_3);
    }
    return new DataTable(columns);
};

const initPaintableBundleOnEntity = (entity, gsplatComponent, resource, opts) => {
    const fmt = resource.format;
    if (!fmt.extraStreams?.find((s) => s.name === 'customColor')) {
        fmt.addExtraStreams([
            { name: 'customColor',    format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
            { name: 'customOpacity',  format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
            { name: 'customSelection', format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
        ]);
    }
    const colorTex = gsplatComponent.getInstanceTexture('customColor');
    if (colorTex) { const d = colorTex.lock(); if (d) d.fill(0); colorTex.unlock(); }
    if (opts?.staggerHeavyInit) { /* caller may await outside */ }

    const opacityTex = gsplatComponent.getInstanceTexture('customOpacity');
    if (opacityTex) { const d = opacityTex.lock(); if (d) d.fill(0); opacityTex.unlock(); }

    const selTex = gsplatComponent.getInstanceTexture('customSelection');
    if (selTex) { const d = selTex.lock(); if (d) d.fill(0); selTex.unlock(); }

    gsplatComponent.setWorkBufferModifier({ glsl: MODIFIER_GLSL, wgsl: MODIFIER_WGSL });
    gsplatComponent.setParameter('uBlendMode',     0);
    gsplatComponent.setParameter('uShowSelection', 0);
    gsplatComponent.setParameter('uSelectionColor', selectionHighlightColor());
    pushSplatViewShaderUniforms(gsplatComponent);
    gsplatComponent.setParameter('uHoverSphere',   [0, 0, 0, 0]);
    gsplatComponent.setParameter('uHoverColor',    [1, 1, 1, 0]);
    applyColorGradeToGsplat(gsplatComponent, baseColorGrade);
    pushLayerOpacityToGsplat(gsplatComponent, baseLayerOpacityPct);
    applyRenderBoxToGsplat(gsplatComponent, baseRenderBox);
    pushWorldToModelUniform(gsplatComponent);

    const processors = createGsplatPaintProcessors(gsplatComponent);
    return { entity, gsplatComponent, ...processors };
};

/**
 * Replace the single loaded base gsplat with several spatial chunks (same CPU cache; multiple GPU draws).
 * Far chunks are disabled each frame for FPS (see updateSpatialBaseChunkVisibility).
 */
const replaceMonolithicBaseWithSpatialChunks = async (firstAsset, opts = {}) => {
    if (!gsplatDataCache || paintables.length !== 1) return;
    ensureBaseGsplatShRestHydratedFromDeferred();
    const parts = partitionCacheIndicesByGrid(gsplatDataCache, BASE_CHUNK_GRID_DIVISIONS);
    if (parts.length <= 1) return;

    const pb = paintables.pop();
    pb.paintProcessor?.destroy?.();
    pb.eraseProcessor?.destroy?.();
    pb.resetColorProcessor?.destroy?.();
    pb.resetOpacityProcessor?.destroy?.();
    pb.entity.destroy();
    try {
        app.assets.remove(firstAsset);
    } catch (_) { /* ignore */ }

    const cache = gsplatDataCache;
    const rScene = computeCacheBoundingRadius(cache);
    baseSpatialStreamRadius = Math.max(18, rScene * BASE_CHUNK_STREAM_RADIUS_MULT);
    baseSpatialChunkingActive = true;

    setModelImportProgressIndeterminate(`Spatial chunks 0/${parts.length}…`);

    for (let pi = 0; pi < parts.length; pi++) {
        const { indices } = parts[pi];
        if (!indices.length) continue;
        setModelImportProgressIndeterminate(`Spatial chunks ${pi + 1}/${parts.length}…`);
        await yieldNextMacrotask();

        let sx = 0;
        let sy = 0;
        let sz = 0;
        const nk = indices.length;
        for (let j = 0; j < nk; j++) {
            const ii = indices[j];
            sx += cache.x[ii];
            sy += cache.y[ii];
            sz += cache.z[ii];
        }
        const inv = 1 / nk;
        const chunkCenterLocal = new pc.Vec3(sx * inv, sy * inv, sz * inv);
        let minx = Infinity;
        let miny = Infinity;
        let minz = Infinity;
        let maxx = -Infinity;
        let maxy = -Infinity;
        let maxz = -Infinity;
        for (let j = 0; j < nk; j++) {
            const ii = indices[j];
            const x = cache.x[ii];
            const y = cache.y[ii];
            const z = cache.z[ii];
            minx = Math.min(minx, x);
            miny = Math.min(miny, y);
            minz = Math.min(minz, z);
            maxx = Math.max(maxx, x);
            maxy = Math.max(maxy, y);
            maxz = Math.max(maxz, z);
        }

        const table = dataTableFromGsplatCacheIndices(cache, indices);
        const memFs = new MemoryFileSystem();
        const filename = `base-chunk-${pi}.ply`;
        await writePly(
            { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
            memFs,
        );
        const buffer = memFs.results?.get(filename);
        if (!buffer) {
            console.error('[photoshock] chunk PLY failed', pi);
            continue;
        }
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const file = new File([blob], filename, { type: 'application/octet-stream' });
        const loadUrl = URL.createObjectURL(file);

        await new Promise((resolve, reject) => {
            const asset = new pc.Asset(`baseChunk-${pi}`, 'gsplat', { url: loadUrl, filename });
            app.assets.add(asset);
            asset.once('load', (a) => {
                URL.revokeObjectURL(loadUrl);
                const entity = new pc.Entity(`baseChunk-${pi}`);
                const gsplatComponent = entity.addComponent('gsplat', { asset: a, unified: true });
                baseContainer.addChild(entity);
                const bundle = initPaintableBundleOnEntity(entity, gsplatComponent, a.resource, opts);
                paintables.push({
                    ...bundle,
                    chunkGlobalIndices: indices,
                    chunkCenterLocal,
                    chunkSplatCount: nk,
                    chunkBoundsLocal: {
                        min: [minx, miny, minz],
                        max: [maxx, maxy, maxz],
                    },
                });
                entity.enabled = true;
                resolve();
            });
            asset.once('error', (msg) => {
                URL.revokeObjectURL(loadUrl);
                reject(new Error(msg));
            });
            app.assets.load(asset);
        });
        await yieldNextMacrotask();
    }
    try {
        // SuperSplat-style global budget concept; effective mainly when engine-side LOD exists.
        app.scene.gsplat.splatBudget = getBaseSplatBudget();
    } catch (_) { /* ignore */ }
    invalidateBaseChunkVisibilityCamCache();
    updateSpatialBaseChunkVisibility();
    pruneUnusedGsplatAssetsFromRegistry();
};

/** Skip chunk enable/disable when camera has not moved (orbit idle); big win vs O(chunks) every frame. */
const _chunkVisLastCam = new pc.Vec3(NaN, NaN, NaN);
const _chunkVisScratch = new pc.Vec3();
const _chunkVisToCenter = new pc.Vec3();
const CHUNK_VIS_CAM_EPS = 0.02;
/** SuperSplat-like progressive reveal: cap newly enabled chunks per visibility pass. */
const BASE_CHUNK_ENABLES_PER_PASS = 3;
/** Keep already-enabled chunks a bit longer to reduce flicker/churn while orbiting fast. */
const BASE_CHUNK_ENABLE_HYSTERESIS = 1.08;

const invalidateBaseChunkVisibilityCamCache = () => {
    _chunkVisLastCam.set(NaN, NaN, NaN);
};

const updateSpatialBaseChunkVisibility = () => {
    if (!baseSpatialChunkingActive || !paintables.length) return;
    if (baseLayerHiddenByUser) {
        for (const p of paintables) {
            p.entity.enabled = false;
        }
        return;
    }
    const cam = cameraEntity.getPosition();
    if (Number.isFinite(_chunkVisLastCam.x) && cam.distance(_chunkVisLastCam) < CHUNK_VIS_CAM_EPS) {
        return;
    }
    _chunkVisLastCam.copy(cam);
    const wt = baseContainer.getWorldTransform();
    const R = baseSpatialStreamRadius ?? 100;
    const RKeep = R * BASE_CHUNK_ENABLE_HYSTERESIS;
    const budget = getBaseSplatBudget();
    const camComp = cameraEntity.camera;
    const forward = cameraEntity.forward;
    const vfovRad = (camComp?.fov ?? 60) * Math.PI / 180;
    const hfovRad = 2 * Math.atan(Math.tan(vfovRad * 0.5) * (camComp?.aspectRatio ?? 1.777));
    const coneCos = Math.cos(Math.max(vfovRad, hfovRad) * 0.5 + BASE_CHUNK_VIEW_CONE_PAD_DEG * Math.PI / 180);
    const candidates = [];
    const rb = baseRenderBox;
    const rbOn = !!rb?.enabled;
    const rbHalf = getRenderBoxHalfVec(rb);
    const rbcx = clampRenderBoxNumber(rb?.center?.x, 0);
    const rbcy = clampRenderBoxNumber(rb?.center?.y, 0);
    const rbcz = clampRenderBoxNumber(rb?.center?.z, 0);
    for (const p of paintables) {
        if (!p.chunkCenterLocal) {
            p.entity.enabled = false;
            continue;
        }
        if (rbOn) {
            const b = p.chunkBoundsLocal;
            if (b?.min && b?.max) {
                const rbMinX = rbcx - rbHalf[0];
                const rbMinY = rbcy - rbHalf[1];
                const rbMinZ = rbcz - rbHalf[2];
                const rbMaxX = rbcx + rbHalf[0];
                const rbMaxY = rbcy + rbHalf[1];
                const rbMaxZ = rbcz + rbHalf[2];
                const noOverlap =
                    b.max[0] < rbMinX || b.min[0] > rbMaxX ||
                    b.max[1] < rbMinY || b.min[1] > rbMaxY ||
                    b.max[2] < rbMinZ || b.min[2] > rbMaxZ;
                if (noOverlap) {
                    p.entity.enabled = false;
                    continue;
                }
            } else {
                const lx = p.chunkCenterLocal.x;
                const ly = p.chunkCenterLocal.y;
                const lz = p.chunkCenterLocal.z;
                if (Math.abs(lx - rbcx) > rbHalf[0] || Math.abs(ly - rbcy) > rbHalf[1] || Math.abs(lz - rbcz) > rbHalf[2]) {
                    p.entity.enabled = false;
                    continue;
                }
            }
        }
        const world = _chunkVisScratch.copy(p.chunkCenterLocal);
        wt.transformPoint(world, world);
        const dist = cam.distance(world);
        const allowedR = p.entity.enabled ? RKeep : R;
        if (dist >= allowedR) {
            p.entity.enabled = false;
            continue;
        }
        _chunkVisToCenter.sub2(world, cam);
        const len = _chunkVisToCenter.length();
        if (len > 1e-3) {
            const facing = forward.dot(_chunkVisToCenter) / len;
            if (facing < coneCos) {
                p.entity.enabled = false;
                continue;
            }
        }
        candidates.push({ p, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    let used = 0;
    let enabledAny = false;
    const wantEnabled = new Set();
    for (const c of candidates) {
        const count = c.p.chunkSplatCount ?? c.p.chunkGlobalIndices?.length ?? 0;
        const underBudget = budget <= 0 || used + count <= budget || !enabledAny;
        const on = underBudget;
        if (on) {
            wantEnabled.add(c.p);
            enabledAny = true;
            used += count;
        }
    }
    // Disable immediately when out of desired set.
    for (const p of paintables) {
        if (!p.entity.enabled) continue;
        if (!wantEnabled.has(p)) p.entity.enabled = false;
    }
    // Enable progressively to avoid frame spikes when turning quickly.
    let enablesLeft = BASE_CHUNK_ENABLES_PER_PASS;
    for (const c of candidates) {
        if (!wantEnabled.has(c.p)) continue;
        if (c.p.entity.enabled) continue;
        if (enablesLeft <= 0) break;
        c.p.entity.enabled = true;
        enablesLeft--;
    }
};

['dragenter', 'dragover'].forEach((ev) => {
    canvasContainer.addEventListener(ev, (e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        canvasContainer.classList.add('file-drop-target');
    });
});
canvasContainer.addEventListener('dragleave', (e) => {
    const rel = e.relatedTarget;
    if (rel && canvasContainer.contains(rel)) return;
    canvasContainer.classList.remove('file-drop-target');
});
canvasContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    canvasContainer.classList.remove('file-drop-target');
    const files = [...e.dataTransfer.files].filter((f) => isSplatDropFile(f.name));
    if (!files.length) return;
    if (!(await ensureCanLoadModel())) return;
    for (const file of files) {
        try {
            if (e.shiftKey) await loadSplat(file);
            else await importSplatAsLayer(file);
        } catch (err) {
            console.error('[drop]', file.name, err);
        }
    }
});
canvasContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
}, { capture: true });

const resizeCanvasToContainer = () => {
    const rs = getEffectiveRenderScaleFactor();
    const w = Math.max(1, Math.round(canvasContainer.clientWidth * rs));
    const h = Math.max(1, Math.round(canvasContainer.clientHeight * rs));
    app.resizeCanvas(w, h);
};

const LS_RIGHT_PANEL_W = 'photoshock-right-panel-width';
const clampRightPanelWidthPx = (w) => {
    const min = 160;
    const max = Math.min(560, window.innerWidth * 0.92);
    return Math.max(min, Math.min(max, Math.round(w)));
};
const applyRightPanelWidth = (wPx, persist) => {
    const clamped = clampRightPanelWidthPx(wPx);
    document.documentElement.style.setProperty('--right-panel-width', `${clamped}px`);
    if (persist) {
        try { localStorage.setItem(LS_RIGHT_PANEL_W, String(clamped)); } catch (_) {}
    }
    resizeCanvasToContainer();
};

window.addEventListener('resize', () => {
    const rp = document.getElementById('right-panel');
    if (rp) {
        const w = rp.getBoundingClientRect().width;
        const c = clampRightPanelWidthPx(w);
        if (c !== w) document.documentElement.style.setProperty('--right-panel-width', `${c}px`);
    }
    resizeCanvasToContainer();
});
// Defer initial resize so flex layout has computed; restore saved panel width
requestAnimationFrame(() => {
    try {
        const saved = parseInt(localStorage.getItem(LS_RIGHT_PANEL_W), 10);
        if (Number.isFinite(saved)) applyRightPanelWidth(saved, false);
    } catch (_) {}
    resizeCanvasToContainer();
});

// ── Camera & orbit ────────────────────────────────────────────────────────────
const cameraEntity = new pc.Entity('camera');
cameraEntity.addComponent('camera', {
    clearColor: new pc.Color(36 / 255, 37 / 255, 43 / 255),
    farClip: 100, nearClip: 0.01,
    fov: 60,
});
app.root.addChild(cameraEntity);

const orbit = { yaw: 0, pitch: -10, distance: 3, target: new pc.Vec3() };
let cameraResetState = { target: new pc.Vec3(), distance: 3, yaw: 0, pitch: -15 };
/** Free-fly position when not orbiting; yaw/pitch match orbit convention for continuity. */
const flyCam = { pos: new pc.Vec3(), yaw: 0, pitch: -10 };
let flyCamResetState = { pos: new pc.Vec3(), yaw: 0, pitch: -15 };

const LS_CAMERA_NAV = 'photoshock-camera-nav';
/** @type {'orbit' | 'fly'} */
let cameraNavMode = 'orbit';

const _camFwdScratch = new pc.Vec3();

const getForwardFromYawPitch = (yawDeg, pitchDeg, out) => {
    const yr = (yawDeg * Math.PI) / 180;
    const pr = (pitchDeg * Math.PI) / 180;
    out.set(
        -Math.sin(yr) * Math.cos(pr),
        -Math.sin(pr),
        -Math.cos(yr) * Math.cos(pr),
    );
    return out;
};

const getDefaultPickDepth = () => {
    if (cameraNavMode === 'orbit') return orbit.distance;
    return Math.max(0.35, orbit.distance);
};

// WASD + QE camera movement (when cursor tool active)
const keysNav = { w: false, a: false, s: false, d: false, q: false, e: false };
const NAV_SPEED = 1.5;

const syncFlyCamFromOrbitParams = () => {
    const yr = (orbit.yaw * Math.PI) / 180;
    const pr = (orbit.pitch * Math.PI) / 180;
    flyCam.pos.set(
        orbit.target.x + orbit.distance * Math.sin(yr) * Math.cos(pr),
        orbit.target.y + orbit.distance * Math.sin(pr),
        orbit.target.z + orbit.distance * Math.cos(yr) * Math.cos(pr),
    );
    flyCam.yaw = orbit.yaw;
    flyCam.pitch = orbit.pitch;
};

const updateCamera = () => {
    if (cameraNavMode === 'orbit') {
        const yr = (orbit.yaw * Math.PI) / 180;
        const pr = (orbit.pitch * Math.PI) / 180;
        cameraEntity.setLocalPosition(
            orbit.target.x + orbit.distance * Math.sin(yr) * Math.cos(pr),
            orbit.target.y + orbit.distance * Math.sin(pr),
            orbit.target.z + orbit.distance * Math.cos(yr) * Math.cos(pr),
        );
        cameraEntity.lookAt(orbit.target);
    } else {
        getForwardFromYawPitch(flyCam.yaw, flyCam.pitch, _camFwdScratch);
        cameraEntity.setPosition(flyCam.pos);
        cameraEntity.lookAt(
            flyCam.pos.x + _camFwdScratch.x,
            flyCam.pos.y + _camFwdScratch.y,
            flyCam.pos.z + _camFwdScratch.z,
        );
    }
};
updateCamera();
app.start();

// ── World XZ reference grid (SuperSplat-style: 10 cm · 1 m · 10 m, X red / Z blue, distance fade) ─
const LS_VIEWPORT_GRID = 'photoshock-viewport-grid';
let viewportGridVisible = false;
try {
    if (localStorage.getItem(LS_VIEWPORT_GRID) === '1') viewportGridVisible = true;
} catch (_) { /* ignore */ }

/** Half-extent (meters) of finite line mesh; dense 10 cm lines stay within GPU budget. */
const VIEWPORT_GRID_HALF = 60;
const GRID_MINOR = 0.1;
const GRID_MAJOR = 1;
const GRID_MEGA = 10;

/** Match supersplat infinite-grid fragment: smoothstep(400, 1000, dist). */
const GRID_FADE_NEAR = 400;
const GRID_FADE_RANGE = 600;
const GRID_FADE_MIN = 0.04;

const GRID_EMISSIVE_CHUNK_GLSL = /* glsl */ `
uniform vec3 material_emissive;
uniform float material_emissiveIntensity;
void getEmission() {
    float dist = distance(vPositionW, view_position);
    float fade = 1.0 - smoothstep(${GRID_FADE_NEAR}.0, ${GRID_FADE_NEAR + GRID_FADE_RANGE}.0, dist);
    fade = max(fade, ${GRID_FADE_MIN});
    dEmission = material_emissive * material_emissiveIntensity * fade;
}
`;
const GRID_EMISSIVE_CHUNK_WGSL = /* wgsl */ `
uniform material_emissive: vec3f;
uniform material_emissiveIntensity: f32;
fn getEmission() {
    let dist = length(vPositionW - uniform.view_position);
    var fade = 1.0 - smoothstep(${GRID_FADE_NEAR}.0, ${GRID_FADE_NEAR + GRID_FADE_RANGE}.0, dist);
    fade = max(fade, ${GRID_FADE_MIN});
    dEmission = uniform.material_emissive * uniform.material_emissiveIntensity * fade;
}
`;

const makeViewportGridLineMaterial = (r, g, b) => {
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(0, 0, 0);
    mat.specular = new pc.Color(0, 0, 0);
    mat.emissive = new pc.Color(r, g, b);
    mat.emissiveIntensity = 1;
    mat.useLighting = false;
    mat.shaderChunksVersion = '2.16';
    mat.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('emissivePS', GRID_EMISSIVE_CHUNK_GLSL);
    mat.getShaderChunks(pc.SHADERLANGUAGE_WGSL).set('emissivePS', GRID_EMISSIVE_CHUNK_WGSL);
    mat.update();
    return mat;
};

const gridIsMultiple = (v, period, eps = 1e-4) => {
    const q = v / period;
    return Math.abs(q - Math.round(q)) < eps / Math.max(period, 0.01);
};

/** 10 cm lines; skip 1 m and 10 m (drawn by coarser layers). */
const buildGridMinorPositions = (h) => {
    const pos = [];
    const imin = Math.floor(-h / GRID_MINOR - 1e-6);
    const imax = Math.ceil(h / GRID_MINOR + 1e-6);
    for (let i = imin; i <= imax; i++) {
        const z = i * GRID_MINOR;
        if (Math.abs(z) > h + 1e-5) continue;
        if (gridIsMultiple(z, GRID_MAJOR) || gridIsMultiple(z, GRID_MEGA)) continue;
        pos.push(-h, 0, z, h, 0, z);
    }
    for (let i = imin; i <= imax; i++) {
        const x = i * GRID_MINOR;
        if (Math.abs(x) > h + 1e-5) continue;
        if (gridIsMultiple(x, GRID_MAJOR) || gridIsMultiple(x, GRID_MEGA)) continue;
        pos.push(x, 0, -h, x, 0, h);
    }
    return new Float32Array(pos);
};

/** 1 m lines; skip 10 m and world axes (z=0 / x=0 lines). */
const buildGridMajorPositions = (h) => {
    const pos = [];
    const kmin = Math.floor(-h / GRID_MAJOR - 1e-6);
    const kmax = Math.ceil(h / GRID_MAJOR + 1e-6);
    for (let k = kmin; k <= kmax; k++) {
        const z = k * GRID_MAJOR;
        if (Math.abs(z) > h + 1e-5) continue;
        if (gridIsMultiple(z, GRID_MEGA)) continue;
        if (Math.abs(z) < 1e-5) continue;
        pos.push(-h, 0, z, h, 0, z);
    }
    for (let k = kmin; k <= kmax; k++) {
        const x = k * GRID_MAJOR;
        if (Math.abs(x) > h + 1e-5) continue;
        if (gridIsMultiple(x, GRID_MEGA)) continue;
        if (Math.abs(x) < 1e-5) continue;
        pos.push(x, 0, -h, x, 0, h);
    }
    return new Float32Array(pos);
};

/** 10 m lines (supersplat “colored axes” level density); skip axes at origin. */
const buildGridMegaPositions = (h) => {
    const pos = [];
    const kmin = Math.floor(-h / GRID_MEGA - 1e-6);
    const kmax = Math.ceil(h / GRID_MEGA + 1e-6);
    for (let k = kmin; k <= kmax; k++) {
        const z = k * GRID_MEGA;
        if (Math.abs(z) > h + 1e-5) continue;
        if (Math.abs(z) < 1e-5) continue;
        pos.push(-h, 0, z, h, 0, z);
    }
    for (let k = kmin; k <= kmax; k++) {
        const x = k * GRID_MEGA;
        if (Math.abs(x) > h + 1e-5) continue;
        if (Math.abs(x) < 1e-5) continue;
        pos.push(x, 0, -h, x, 0, h);
    }
    return new Float32Array(pos);
};

const meshFromLinePositions = (positions) => {
    const mesh = new pc.Mesh(device);
    mesh.setPositions(positions);
    mesh.update(pc.PRIMITIVE_LINES);
    return mesh;
};

/* ~ supersplat 0.1 m / 1 m greys (fragment uses ~0.7); 10 m slightly brighter */
const viewportGridMinorMat = makeViewportGridLineMaterial(0.48, 0.48, 0.5);
const viewportGridMajorMat = makeViewportGridLineMaterial(0.62, 0.62, 0.66);
const viewportGridMegaMat = makeViewportGridLineMaterial(0.82, 0.82, 0.86);
const viewportGridAxisXMat = makeViewportGridLineMaterial(0.92, 0.18, 0.14);
const viewportGridAxisZMat = makeViewportGridLineMaterial(0.22, 0.48, 1.0);
const shapePreviewLineMat = makeViewportGridLineMaterial(0.28, 0.62, 1.0);
shapePreviewLineMat.depthTest = true;
shapePreviewLineMat.depthWrite = true;
shapePreviewLineMat.update();
const renderBoxWireMat = makeViewportGridLineMaterial(1.0, 0.82, 0.26);
renderBoxWireMat.depthTest = true;
renderBoxWireMat.depthWrite = true;
renderBoxWireMat.update();
const renderBoxLinePositions = new Float32Array([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,
    -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
    -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
    -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,
    -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,
     0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
    -0.5, -0.5,  0.5, -0.5,  0.5,  0.5,
     0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
    -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
     0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
    -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
     0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
]);
const renderBoxWireMesh = meshFromLinePositions(renderBoxLinePositions);

const shapePreviewFillMat = new pc.StandardMaterial();
shapePreviewFillMat.diffuse = new pc.Color(0.18, 0.48, 0.95);
shapePreviewFillMat.emissive = new pc.Color(0.06, 0.14, 0.28);
shapePreviewFillMat.emissiveIntensity = 0.55;
shapePreviewFillMat.opacity = 0.3;
shapePreviewFillMat.blendType = pc.BLEND_NORMAL;
shapePreviewFillMat.useLighting = false;
shapePreviewFillMat.depthWrite = false;
shapePreviewFillMat.depthTest = true;
shapePreviewFillMat.update();

const hG = VIEWPORT_GRID_HALF;
const gridMinorMesh = meshFromLinePositions(buildGridMinorPositions(hG));
const gridMajorMesh = meshFromLinePositions(buildGridMajorPositions(hG));
const gridMegaMesh = meshFromLinePositions(buildGridMegaPositions(hG));
const gridAxisXMesh = meshFromLinePositions(new Float32Array([-hG, 0, 0, hG, 0, 0]));
const gridAxisZMesh = meshFromLinePositions(new Float32Array([0, 0, -hG, 0, 0, hG]));

const miGridMinor = new pc.MeshInstance(gridMinorMesh, viewportGridMinorMat);
const miGridMajor = new pc.MeshInstance(gridMajorMesh, viewportGridMajorMat);
const miGridMega = new pc.MeshInstance(gridMegaMesh, viewportGridMegaMat);
const miGridAxisX = new pc.MeshInstance(gridAxisXMesh, viewportGridAxisXMat);
const miGridAxisZ = new pc.MeshInstance(gridAxisZMesh, viewportGridAxisZMat);
miGridMinor.drawOrder = 0;
miGridMajor.drawOrder = 1;
miGridMega.drawOrder = 2;
miGridAxisX.drawOrder = 3;
miGridAxisZ.drawOrder = 3;

const viewportGridEntity = new pc.Entity('viewportGrid');
viewportGridEntity.addComponent('render', {
    meshInstances: [miGridMinor, miGridMajor, miGridMega, miGridAxisX, miGridAxisZ],
    castShadows: false,
});
viewportGridEntity.setLocalEulerAngles(0, 0, 0);
viewportGridEntity.enabled = viewportGridVisible;
app.root.addChild(viewportGridEntity);

const updateViewportGridToggleButton = () => {
    const btn = g('toggle-viewport-grid-btn');
    if (!btn) return;
    btn.classList.toggle('grid-shown', viewportGridVisible);
};

// Camera WASD + QE navigation (always active)
const _navStep = new pc.Vec3();
app.on('update', (dt) => {
    pushAllWorldToModelUniforms();
    const dtClamped = Math.min(dt, 0.1);
    let moved = false;
    const fwd = cameraEntity.forward;
    const right = cameraEntity.right;
    const fwdXZ = new pc.Vec3(fwd.x, 0, fwd.z);
    const rightXZ = new pc.Vec3(right.x, 0, right.z);
    if (fwdXZ.length() > 0.001) fwdXZ.normalize();
    if (rightXZ.length() > 0.001) rightXZ.normalize();
    if (cameraNavMode === 'orbit') {
        const speed = NAV_SPEED * orbit.distance * 0.3 * dtClamped;
        if (keysNav.w && fwdXZ.length() > 0.001) { _navStep.copy(fwdXZ).mulScalar(speed); orbit.target.add2(orbit.target, _navStep); moved = true; }
        if (keysNav.s && fwdXZ.length() > 0.001) { _navStep.copy(fwdXZ).mulScalar(speed); orbit.target.sub2(orbit.target, _navStep); moved = true; }
        if (keysNav.d && rightXZ.length() > 0.001) { _navStep.copy(rightXZ).mulScalar(speed); orbit.target.add2(orbit.target, _navStep); moved = true; }
        if (keysNav.a && rightXZ.length() > 0.001) { _navStep.copy(rightXZ).mulScalar(speed); orbit.target.sub2(orbit.target, _navStep); moved = true; }
        if (keysNav.q) { orbit.target.y += speed; moved = true; }
        if (keysNav.e) { orbit.target.y -= speed; moved = true; }
    } else {
        const speed = NAV_SPEED * 0.45 * dtClamped;
        if (keysNav.w && fwd.length() > 0.001) { _navStep.copy(fwd).normalize().mulScalar(speed); flyCam.pos.add(_navStep); moved = true; }
        if (keysNav.s && fwd.length() > 0.001) { _navStep.copy(fwd).normalize().mulScalar(speed); flyCam.pos.sub(_navStep); moved = true; }
        if (keysNav.d && right.length() > 0.001) { _navStep.copy(right).normalize().mulScalar(speed); flyCam.pos.add(_navStep); moved = true; }
        if (keysNav.a && right.length() > 0.001) { _navStep.copy(right).normalize().mulScalar(speed); flyCam.pos.sub(_navStep); moved = true; }
        if (keysNav.q) { flyCam.pos.y += speed; moved = true; }
        if (keysNav.e) { flyCam.pos.y -= speed; moved = true; }
    }
    if (moved) updateCamera();
    updateSpatialBaseChunkVisibility();
    if (viewportGridEntity.enabled) {
        if (cameraNavMode === 'orbit') {
            viewportGridEntity.setPosition(orbit.target.x, orbit.target.y, orbit.target.z);
        } else {
            viewportGridEntity.setPosition(flyCam.pos.x, flyCam.pos.y, flyCam.pos.z);
        }
    }
    // Shape preview (plan V1): Add-placed preview follows orbit.target (WASD pan, etc.).
    if (activeTool === 'shapeLayer' && shapePreviewOrbitLock && shapePreviewRoot?.parent
        && cameraNavMode === 'orbit') {
        shapePreviewRoot.setPosition(orbit.target.x, orbit.target.y, orbit.target.z);
    }
});

// Leave scene.gsplat.enableIds false (default): enabling adds a pcId stream + GSPLAT_ID
// shader path and extra bandwidth. Photoshock uses CPU splat picking (pickFrontSplatAtScreen)
// and depth-based stroke picking, not engine gsplat pick IDs.

// ── World-point hit via GPU depth picker ──────────────────────────────────────
// On each stroke start (mousedown) we use the Picker to read the actual GPU
// depth buffer, giving the true 3D position of the splat surface under the
// cursor.  Subsequent mousemove points during the same stroke reuse that depth
// via camera.screenToWorld() — fast, synchronous, and accurate enough for
// smooth painting along a curved surface.
const picker = new pc.Picker(app, 1, 1, true);  // true = enable depth buffer

// Distance from camera to the surface, established at each stroke start.
// null means "not yet picked this stroke".
let strokeDepth = null;

// Synchronous world-point using the depth established at stroke start.
// Falls back to orbit.distance when called before a pick (e.g. selection tools).
// NOTE: CameraComponent.screenToWorld(x, y, z, [worldCoord]) — only 3 required
// args; the component reads canvas size from the graphics device internally.
const getWorldPoint = (screenX, screenY) => {
    const depth = strokeDepth != null ? strokeDepth : getDefaultPickDepth();
    return cameraEntity.camera.screenToWorld(screenX, screenY, depth);
};

// Async: render picking buffer at low resolution, read depth buffer, return
// camera-to-surface distance. When the depth buffer is clear (sky / void),
// getWorldPointAsync returns null — with fallback=false callers must skip paint
// instead of using orbit.distance (which maps every pixel to a wrong plane and
// can paint an entire layer at once).
const pickStrokeDepth = async (x, y, fallback = true) => {
    const scale = 0.25;
    picker.resize(
        Math.max(1, Math.round(canvas.clientWidth  * scale)),
        Math.max(1, Math.round(canvas.clientHeight * scale)),
    );
    const worldLayer = app.scene.layers.getLayerByName('World');
    picker.prepare(cameraEntity.camera, app.scene, [worldLayer]);
    const worldPt = await picker.getWorldPointAsync(x * scale, y * scale);
    if (worldPt) {
        return worldPt.distance(cameraEntity.getPosition());
    }
    return fallback ? getDefaultPickDepth() : null;
};

// ── State ─────────────────────────────────────────────────────────────────────
let activeTool = 'cursor';
let splatMode  = false;    // M: splat overlay (centers/rings) on true splat colors
/** @type {'centers' | 'rings'} */
let splatViewStyle = 'centers';

const getSplatModeUniform = () => {
    if (!splatMode) return 0;
    return splatViewStyle === 'rings' ? 2 : 1;
};

const pushSplatViewShaderUniforms = (gsplat) => {
    if (!gsplat) return;
    gsplat.setParameter('uSplatMode', getSplatModeUniform());
    gsplat.setParameter('uSplatRingThickness', SPLAT_VIEW_RING_THICKNESS);
};

// Strokes: { isErase, blendMode, ops:[{sphere, color, hardness, isErase}],
//            cpuOps:[...], selectionBefore?, selectionAfter? (captureSelectionSnapshot) }
const strokes   = [];
const redoStack = [];
let   activeStroke = null;

// Selection
let selectionMask   = null;          // Uint8Array(numSplats)
let showSelectionHighlight = true;   // H toggles visibility
let hasSelection    = false;
let selectionSphere = [0, 0, 0, -1]; // model space, w<=0 = disabled
let selectionMode   = 'new';         // new | add | subtract
/** Tools that use new/add/subtract — drives viewport frame stroke (see syncViewportSelectionFrame). */
const SELECTION_FRAME_TOOLS = ['boxSelect', 'lassoSelect', 'vectorSelect', 'brushSelect', 'colorSelect', 'splatSelect'];
/** Snapshot at pointer-down for drag selection tools; committed on pointer-up. */
let pendingSelectionUndoSnap = null;

// Box-select drag
let boxSelectDrag = null; // { x1, y1, x2, y2 }
/** Freehand lasso: points in canvas pixel space while dragging */
let lassoPoints = [];
let lassoDragActive = false;
/** Polygon (vector) select: click to add vertices */
let vectorPolyPoints = [];
let vectorHoverScreen = null; // { x, y } preview line from last vertex

// Paint interaction
let isPainting     = false;
let lastPaintWorld = null;
const paintStrokeScratch = new pc.Vec3();
// Erase depth (view-aligned cylinder): scratch vectors to avoid per-dab allocations
const eraseRayWorldScratch = new pc.Vec3();
const eraseWorldEdgeScratch = new pc.Vec3();
const eraseModelCenterScratch = new pc.Vec3();
const eraseModelEdgeScratch = new pc.Vec3();
const eraseViewModelScratch = new pc.Vec3();

// Brush selection
let isBrushSelecting       = false;
let lastBrushSelectWorld   = null;
let brushSelectFirstDab    = false;
const pendingPaints = [];    // { sphere, color, hardness, isErase }
let pendingRebuild = false;

// Camera interaction
let isOrbiting = false;
let lastMouse  = { x: 0, y: 0 };

// Loaded paintables: { entity, gsplatComponent, paintProcessor, paintBucketProcessor, eraseProcessor, ... }
const paintables = [];

// CPU splat cache for export
let gsplatDataCache = null;

// Debug overlay: add ?perf=1 or set localStorage photoshock-perf=1 — FPS, frame ms, API, splat count
let photoshockPerfHudEl = null;
let photoshockPerfFpsEma = 0;

/** Top-left viewer FPS (Shift+F); persisted in localStorage. */
const LS_VIEWER_FPS_HUD = 'photoshock-viewer-fps';
let viewerFpsHudEl = null;
let viewerFpsHudVisible = false;

const initViewerFpsHud = () => {
    if (!canvasContainer || viewerFpsHudEl) return;
    try {
        viewerFpsHudEl = document.createElement('div');
        viewerFpsHudEl.id = 'viewer-fps-hud';
        viewerFpsHudEl.className = 'viewer-fps-hud';
        viewerFpsHudEl.setAttribute('role', 'status');
        viewerFpsHudEl.setAttribute('aria-live', 'polite');
        try {
            viewerFpsHudVisible = localStorage.getItem(LS_VIEWER_FPS_HUD) === '1';
        } catch (_) { /* ignore */ }
        viewerFpsHudEl.setAttribute('aria-hidden', viewerFpsHudVisible ? 'false' : 'true');
        Object.assign(viewerFpsHudEl.style, {
            position: 'absolute',
            top: '8px',
            left: '8px',
            zIndex: '12',
            font: '12px/1.25 ui-monospace, monospace',
            color: '#e8f4ff',
            background: 'rgba(0,0,0,0.52)',
            padding: '5px 9px',
            borderRadius: '6px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            display: viewerFpsHudVisible ? 'block' : 'none',
        });
        canvasContainer.appendChild(viewerFpsHudEl);
    } catch (_) { /* ignore */ }
};

const toggleViewerFpsHud = () => {
    initViewerFpsHud();
    if (!viewerFpsHudEl) return;
    viewerFpsHudVisible = !viewerFpsHudVisible;
    viewerFpsHudEl.style.display = viewerFpsHudVisible ? 'block' : 'none';
    viewerFpsHudEl.setAttribute('aria-hidden', viewerFpsHudVisible ? 'false' : 'true');
    try {
        localStorage.setItem(LS_VIEWER_FPS_HUD, viewerFpsHudVisible ? '1' : '0');
    } catch (_) { /* ignore */ }
};

// ── Adaptive large-scene FPS governor (SuperSplat-like budget balancing) ─────
const ADAPT_TARGET_FPS = 36;
const ADAPT_INTERVAL_S = 0.6;
const ADAPT_BUDGET_MIN = 280_000;
const ADAPT_RSCALE_MIN = 0.56;
const ADAPT_RSCALE_STEP_DOWN = 0.05;
const ADAPT_RSCALE_STEP_UP = 0.02;
const ADAPT_GOOD_WINDOWS_FOR_UPSCALE = 4;

let adaptTimer = 0;
let adaptGoodWindows = 0;

const isAdaptivePerfEnabled = () => {
    let enabled = true;
    try {
        if (localStorage.getItem(LS_ADAPTIVE_PERF) === '0') enabled = false;
    } catch (_) { /* ignore */ }
    try {
        const q = new URLSearchParams(location.search).get('adaptive_perf');
        if (q === '0' || q === 'false') enabled = false;
        if (q === '1' || q === 'true') enabled = true;
    } catch (_) { /* ignore */ }
    return enabled;
};

const hasExplicitQueryParam = (name) => {
    try {
        return new URLSearchParams(location.search).get(name) != null;
    } catch (_) {
        return false;
    }
};

const tickAdaptivePerfController = (dt) => {
    if (!isAdaptivePerfEnabled()) return;
    const n = gsplatDataCache?.numSplats ?? 0;
    if (n < BASE_CHUNK_MIN_SPLATS) {
        adaptiveBaseSplatBudget = null;
        adaptiveRenderScaleCap = null;
        adaptTimer = 0;
        adaptGoodWindows = 0;
        return;
    }
    adaptTimer += dt;
    if (adaptTimer < ADAPT_INTERVAL_S) return;
    adaptTimer = 0;

    const fps = photoshockPerfFpsEma;
    if (!Number.isFinite(fps) || fps <= 0) return;

    const canAdaptBudget = baseSpatialChunkingActive && !hasExplicitQueryParam('sbudget');
    const canAdaptRscale = !hasExplicitQueryParam('rscale');
    let changedBudget = false;
    let changedRscale = false;

    if (fps < ADAPT_TARGET_FPS - 3) {
        adaptGoodWindows = 0;
        if (canAdaptBudget) {
            const cur = adaptiveBaseSplatBudget ?? getConfiguredBaseSplatBudget();
            const next = Math.max(ADAPT_BUDGET_MIN, Math.floor(cur * 0.88));
            if (next < cur) {
                adaptiveBaseSplatBudget = next;
                changedBudget = true;
            }
        }
        if (canAdaptRscale) {
            const curCap = adaptiveRenderScaleCap ?? 1;
            const nextCap = Math.max(ADAPT_RSCALE_MIN, curCap - ADAPT_RSCALE_STEP_DOWN);
            if (nextCap < curCap - 1e-4) {
                adaptiveRenderScaleCap = nextCap;
                changedRscale = true;
            }
        }
    } else if (fps > ADAPT_TARGET_FPS + 8) {
        adaptGoodWindows++;
        if (adaptGoodWindows >= ADAPT_GOOD_WINDOWS_FOR_UPSCALE) {
            adaptGoodWindows = 0;
            if (canAdaptBudget && adaptiveBaseSplatBudget != null) {
                const up = Math.ceil(adaptiveBaseSplatBudget * 1.12);
                const maxB = getConfiguredBaseSplatBudget();
                const next = Math.min(maxB, up);
                if (next > adaptiveBaseSplatBudget) {
                    adaptiveBaseSplatBudget = next;
                    if (adaptiveBaseSplatBudget >= maxB) adaptiveBaseSplatBudget = null;
                    changedBudget = true;
                }
            }
            if (canAdaptRscale && adaptiveRenderScaleCap != null) {
                const nextCap = Math.min(1, adaptiveRenderScaleCap + ADAPT_RSCALE_STEP_UP);
                if (nextCap > adaptiveRenderScaleCap + 1e-4) {
                    adaptiveRenderScaleCap = nextCap >= 0.999 ? null : nextCap;
                    changedRscale = true;
                }
            }
        }
    } else {
        adaptGoodWindows = 0;
    }

    if (changedBudget) {
        invalidateBaseChunkVisibilityCamCache();
        updateSpatialBaseChunkVisibility();
    }
    if (changedRscale) {
        resizeCanvasToContainer();
    }
};

try {
    if (canvasContainer
        && (new URLSearchParams(location.search).get('perf') === '1'
            || localStorage.getItem('photoshock-perf') === '1')) {
        photoshockPerfHudEl = document.createElement('div');
        photoshockPerfHudEl.setAttribute('aria-hidden', 'true');
        Object.assign(photoshockPerfHudEl.style, {
            position: 'fixed',
            left: '8px',
            bottom: '8px',
            zIndex: '9999',
            font: '12px/1.3 ui-monospace, monospace',
            color: '#cfe8ff',
            background: 'rgba(0,0,0,0.55)',
            padding: '6px 10px',
            borderRadius: '6px',
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            maxWidth: 'min(90vw, 28rem)',
        });
        canvasContainer.appendChild(photoshockPerfHudEl);
    }
} catch (_) { /* ignore */ }

initViewerFpsHud();

app.on('update', (dt) => {
    const instFps = dt > 1e-6 ? 1 / dt : 0;
    photoshockPerfFpsEma = photoshockPerfFpsEma === 0 ? instFps : photoshockPerfFpsEma * 0.92 + instFps * 0.08;
    tickAdaptivePerfController(dt);
    const tickViewerFps = viewerFpsHudEl && viewerFpsHudVisible;
    if (!photoshockPerfHudEl && !tickViewerFps) return;
    if (tickViewerFps) {
        const rsE = getEffectiveRenderScaleFactor();
        const rsBase = getRenderScaleFactor();
        const autoNote = rsE < rsBase - 1e-4 ? ' auto' : '';
        const rsHint = rsE < 0.999 ? `  ·  ${rsE.toFixed(2)}×${autoNote}` : '';
        viewerFpsHudEl.textContent = `${photoshockPerfFpsEma.toFixed(0)} FPS  ${(dt * 1000).toFixed(1)} ms${rsHint}`;
    }
    if (photoshockPerfHudEl) {
        const n = gsplatDataCache?.numSplats ?? 0;
        const api = device.isWebGPU ? 'WebGPU' : 'WebGL2';
        const rsE = getEffectiveRenderScaleFactor();
        const rsBase = getRenderScaleFactor();
        const sb = getBaseSplatBudget();
        const activeChunkSplats = baseSpatialChunkingActive
            ? paintables.reduce((s, pb) => s + (pb.entity.enabled ? (pb.chunkSplatCount ?? pb.chunkGlobalIndices?.length ?? 0) : 0), 0)
            : n;
        const rsLine = rsE < 0.999
            ? (rsE < rsBase - 1e-4 ? `  rscale ${rsE.toFixed(2)} (auto cap, user ${rsBase.toFixed(2)})` : `  rscale ${rsE}`)
            : '';
        const chunkLine = baseSpatialChunkingActive
            ? `  visible ${activeChunkSplats.toLocaleString()} / ${n.toLocaleString()}  sbudget ${sb.toLocaleString()}`
            : `  splats ${n.toLocaleString()}`;
        photoshockPerfHudEl.textContent = `FPS ~${photoshockPerfFpsEma.toFixed(0)}  frame ${(dt * 1000).toFixed(2)} ms\n${api}${rsLine}${chunkLine}`;
    }
});

/** Base splats logically removed (fast delete without PLY reload): 0 = skip in CPU pick/selection. */
let baseSplatAliveMask = null;

const resetBaseSplatAliveMask = (n) => {
    if (!n || n <= 0) {
        baseSplatAliveMask = null;
        return;
    }
    baseSplatAliveMask = new Uint8Array(n);
    baseSplatAliveMask.fill(1);
};

const isBaseSplatAlive = (i) => {
    if (!baseSplatAliveMask || i < 0 || i >= baseSplatAliveMask.length) return true;
    return baseSplatAliveMask[i] !== 0;
};

// ── Layers ───────────────────────────────────────────────────────────────────
// Layer: { id, name, visible, opacityPct (0–100), splats: [...], selectionMask: Uint8Array|null }
// Special id 'base' refers to the loaded base model (paintables[0]).
const layers = [];
let selectedLayerId = 'base';  // default: base model is active

// Saved selections: { id, name, layerId, numSplats, mask: Uint8Array }
const savedSelections = [];

// Swatches: { id, hex }
const swatches = [];
/** True after "pick from splat" — next left-click on canvas samples a splat into swatches. */
let awaitingSwatchSplatPick = false;
/** Split-tone picker target key ('sh'|'md'|'hi') when sampling from viewport. */
let awaitingSplitToneSplatPick = null;
let layerIdCounter = 1;
let baseModelName = '';         // filename of the loaded model
/** Viewport-only: base gsplat alpha multiplier 0–100 (not baked into splats). */
let baseLayerOpacityPct = 100;

/** Default { position, rotation, scale } for base model (not stored on a layer row). */
const createDefaultLayerTransform = () => ({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
});
let baseTransform = createDefaultLayerTransform();

const createDefaultRenderBox = () => ({
    enabled: false,
    center: { x: 0, y: 0, z: 0 },
    size: { x: 2, y: 2, z: 2 },
});
let baseRenderBox = createDefaultRenderBox();

const ensureUserLayerTransform = (layer) => {
    if (!layer || typeof layer !== 'object') return;
    if (!layer.position) layer.position = { x: 0, y: 0, z: 0 };
    if (!layer.rotation) layer.rotation = { x: 0, y: 0, z: 0 };
    if (!layer.scale) layer.scale = { x: 1, y: 1, z: 1 };
};

const ensureLayerRenderBox = (layer) => {
    if (!layer || typeof layer !== 'object') return;
    if (!layer.renderBox || typeof layer.renderBox !== 'object') {
        layer.renderBox = createDefaultRenderBox();
    }
    if (!layer.renderBox.center) layer.renderBox.center = { x: 0, y: 0, z: 0 };
    if (!layer.renderBox.size) layer.renderBox.size = { x: 2, y: 2, z: 2 };
    if (typeof layer.renderBox.enabled !== 'boolean') layer.renderBox.enabled = !!layer.renderBox.enabled;
};

/** Reusable scratch for export baking (world TRS applied to splat attributes). */
const _bakeWorldMat = new pc.Mat4();
const _bakeInvWorld = new pc.Mat4();
const _bakePt = new pc.Vec3();
const _bakeN = new pc.Vec3();
const _bakeQWorld = new pc.Quat();
const _bakeQSplat = new pc.Quat();
const _bakeQOut = new pc.Quat();

/**
 * PLY stores quaternion as rot_0=w, rot_1=x, rot_2=y, rot_3=z (PlayCanvas Quat is x,y,z,w).
 * Bakes entity world TRS into position, rotation, scale, normals for export.
 */
const bakeSplatAttributesForExport = (entity, x, y, z, nx, ny, nz, r0, r1, r2, r3, s0, s1, s2, out) => {
    _bakeWorldMat.copy(entity.getWorldTransform());
    _bakePt.set(x, y, z);
    _bakeWorldMat.transformPoint(_bakePt, _bakePt);
    out.x = _bakePt.x;
    out.y = _bakePt.y;
    out.z = _bakePt.z;

    _bakeQWorld.copy(entity.getRotation());
    _bakeQSplat.set(r1, r2, r3, r0);
    _bakeQOut.mul2(_bakeQWorld, _bakeQSplat).normalize();
    out.rot_0 = _bakeQOut.w;
    out.rot_1 = _bakeQOut.x;
    out.rot_2 = _bakeQOut.y;
    out.rot_3 = _bakeQOut.z;

    const ws = entity.getScale();
    const vol = Math.cbrt(Math.max(1e-12, Math.abs(ws.x * ws.y * ws.z)));
    const dLog = Math.log(vol);
    out.scale_0 = s0 + dLog;
    out.scale_1 = s1 + dLog;
    out.scale_2 = s2 + dLog;

    _bakeInvWorld.copy(_bakeWorldMat).invert();
    const im = _bakeInvWorld.data;
    // Normal: upper 3×3 of inverse-transpose · n  →  dot columns of inv with n
    let nnx = im[0] * nx + im[4] * ny + im[8] * nz;
    let nny = im[1] * nx + im[5] * ny + im[9] * nz;
    let nnz = im[2] * nx + im[6] * ny + im[10] * nz;
    const nlen = Math.max(1e-8, Math.hypot(nnx, nny, nnz));
    out.nx = nnx / nlen;
    out.ny = nny / nlen;
    out.nz = nnz / nlen;
};

// ── Active-layer helpers ──────────────────────────────────────────────────────
// Returns the user Layer object if one is selected, or null for the base model.
const getActiveLayer = () => {
    if (selectedLayerId === 'base' || !selectedLayerId) return null;
    return layers.find(l => l.id === selectedLayerId) ?? null;
};

// Returns a gsplatDataCache-compatible object for the active target:
// - base model  → the real gsplatDataCache
// - user layer  → built on-demand from layer.splats
const getActiveDataCache = () => {
    const layer = getActiveLayer();
    if (!layer) return gsplatDataCache;
    if (!layer.splats.length) return null;
    const n = layer.splats.length;
    const x    = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    const fdc0 = new Float32Array(n), fdc1 = new Float32Array(n), fdc2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const s = layer.splats[i];
        x[i] = s.x; y[i] = s.y; z[i] = s.z;
        fdc0[i] = s.f_dc_0 ?? 0; fdc1[i] = s.f_dc_1 ?? 0; fdc2[i] = s.f_dc_2 ?? 0;
    }
    return { numSplats: n, x, y, z, fdc0, fdc1, fdc2, isLayerData: true };
};

// Returns (and lazily creates) the selection mask for the currently active target.
const getActiveSelectionMask = (n) => {
    const layer = getActiveLayer();
    if (!layer) {
        if (!selectionMask || selectionMask.length !== n) selectionMask = new Uint8Array(n);
        return selectionMask;
    }
    if (!layer.selectionMask || layer.selectionMask.length !== n) layer.selectionMask = new Uint8Array(n);
    return layer.selectionMask;
};

// Returns the active selection mask (or null) without allocating.
const peekActiveSelectionMask = () => {
    const layer = getActiveLayer();
    return layer ? (layer.selectionMask ?? null) : (selectionMask ?? null);
};

const captureSelectionSnapshot = () => {
    const snap = {
        selectedLayerId: selectedLayerId ?? 'base',
        baseMask: null,
        layers: [],
    };
    const nBase = gsplatDataCache?.numSplats ?? 0;
    if (nBase > 0) {
        snap.baseMask = new Uint8Array(nBase);
        if (selectionMask && selectionMask.length === nBase) snap.baseMask.set(selectionMask);
    }
    for (const lyr of layers) {
        const n = lyr.splats?.length ?? 0;
        if (!n) {
            snap.layers.push({ id: lyr.id, mask: null });
            continue;
        }
        const m = new Uint8Array(n);
        if (lyr.selectionMask && lyr.selectionMask.length === n) m.set(lyr.selectionMask);
        snap.layers.push({ id: lyr.id, mask: m });
    }
    return snap;
};

const restoreSelectionSnapshot = (snap) => {
    if (!snap) return;
    let wantId = snap.selectedLayerId ?? 'base';
    if (wantId !== 'base' && wantId && !layers.some((l) => l.id === wantId)) wantId = 'base';

    const nBase = gsplatDataCache?.numSplats ?? 0;
    if (nBase > 0) {
        if (!selectionMask || selectionMask.length !== nBase) selectionMask = new Uint8Array(nBase);
        if (snap.baseMask && snap.baseMask.length === nBase) selectionMask.set(snap.baseMask);
        else selectionMask.fill(0);
    }

    const byId = new Map((snap.layers || []).map((e) => [e.id, e.mask]));
    for (const lyr of layers) {
        const n = lyr.splats?.length ?? 0;
        if (!n) {
            lyr.selectionMask = null;
            continue;
        }
        const saved = byId.get(lyr.id);
        if (saved && saved.length === n) {
            if (!lyr.selectionMask || lyr.selectionMask.length !== n) lyr.selectionMask = new Uint8Array(n);
            lyr.selectionMask.set(saved);
        } else {
            if (!lyr.selectionMask || lyr.selectionMask.length !== n) lyr.selectionMask = new Uint8Array(n);
            lyr.selectionMask.fill(0);
        }
    }

    selectedLayerId = wantId;
    if (wantId === 'base' || !wantId) {
        hasSelection = !!(selectionMask?.some((v) => v > 0));
    } else {
        const layer = layers.find((l) => l.id === wantId);
        hasSelection = !!(layer?.selectionMask?.some((v) => v > 0));
    }
    renderLayersUI();
    refreshLayerGizmoAttachment();
    recomputeSelectionSphere();
    updateSelectionUI();
};

const pushSelectionUndoFromBefore = (before) => {
    if (!before) return;
    redoStack.length = 0;
    strokes.push({
        ops: [],
        cpuOps: [],
        selectionBefore: before,
        selectionAfter: captureSelectionSnapshot(),
    });
    updateUndoRedoUI();
};

/** Entity for world/model transforms of the active paint/selection target (layer entity or base). */
const getWorldMatEntityForActiveTarget = () => {
    const lyr = getActiveLayer();
    if (lyr) {
        const ent = layersContainer.findByName(`layer-${lyr.id}`);
        if (ent) return ent;
    }
    return paintables[0]?.entity ?? null;
};

/** First splat entity for hover / depth reference when there is no base model. */
const getPrimarySplatEntity = () => {
    if (paintables.length) return paintables[0].entity;
    for (const layer of layers) {
        if (!layer.splats.length) continue;
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent) return ent;
    }
    return null;
};

const hasRenderableSplats = () => !!getPrimarySplatEntity();

/** While non-zero, hide empty-scene placeholder (e.g. during load / import). */
let emptySceneLoadingDepth = 0;

const updateEmptyScenePlaceholder = () => {
    const el = g('empty-scene-placeholder');
    if (!el) return;
    const show = !hasRenderableSplats() && emptySceneLoadingDepth === 0;
    el.classList.toggle('hidden', !show);
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
};

// ── Ring-aware selection (splat mode + rings — precise elliptical ring hit test) ──
const _ringW0 = new pc.Vec3();
const _ringS0 = new pc.Vec3();
const _ringAxW = [new pc.Vec3(), new pc.Vec3()];
const _ringAxS = [new pc.Vec3(), new pc.Vec3()];

const useRingHitSelection = () => splatMode && splatViewStyle === 'rings';

/** 0 = foreground only … 100 = include deep splats stacked behind along the view (same screen overlap). */
const LS_SELECTION_DEPTH = 'photoshock-selection-depth';
const parseSelectionDepth = (raw) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 80;
    return Math.max(0, Math.min(100, n));
};
let selectionDepthControl = 80;
try {
    const s = localStorage.getItem(LS_SELECTION_DEPTH);
    if (s != null) selectionDepthControl = parseSelectionDepth(s);
} catch (_) { /* ignore */ }

/**
 * World-space depth band beyond the nearest hit: splats with camera distance in [minD, minD+eps]
 * stay selected when they overlap the region in screen space. Low slider → tiny eps (front only);
 * high slider → large eps (same pixel column, farther from camera).
 */
const selectionDepthEpsilon = (minDistCam) => {
    const minD = Math.max(minDistCam, 1e-5);
    const u = selectionDepthControl / 100;
    const curve = u * u;
    const tight = Math.max(minD * 0.002, 0.005);
    const loose = Math.max(minD * 0.52, minD * 0.12 + 0.4);
    return tight + (loose - tight) * curve;
};

/** hits: { i, d } with d = distance from splat center to camera (world units). */
const filterHitsBySelectionDepth = (hits) => {
    if (!hits?.length) return new Set();
    const minD = Math.min(...hits.map((h) => h.d));
    const eps = selectionDepthEpsilon(minD);
    return new Set(hits.filter((h) => h.d <= minD + eps).map((h) => h.i));
};

const syncSelectionDepthUI = () => {
    const range = document.getElementById('selection-depth-range');
    const label = document.getElementById('selection-depth-label');
    if (range) range.value = String(selectionDepthControl);
    if (label) label.textContent = String(selectionDepthControl);
};

const getSplatScalesAt = (data, layer, i) => {
    if (data.isLayerData && layer?.splats?.[i]) {
        const s = layer.splats[i];
        return { s0: s.scale_0 ?? -5, s1: s.scale_1 ?? -5, s2: s.scale_2 ?? -5 };
    }
    if (!data.isLayerData && gsplatDataCache?.extra) {
        const ex = gsplatDataCache.extra;
        return {
            s0: ex.scale_0?.[i] ?? -5,
            s1: ex.scale_1?.[i] ?? -5,
            s2: ex.scale_2?.[i] ?? -5,
        };
    }
    return { s0: -5, s1: -5, s2: -5 };
};

const getSplatRotationAt = (data, layer, i) => {
    if (data.isLayerData && layer?.splats?.[i]) {
        const s = layer.splats[i];
        return { rw: s.rot_0 ?? 1, rx: s.rot_1 ?? 0, ry: s.rot_2 ?? 0, rz: s.rot_3 ?? 0 };
    }
    if (!data.isLayerData && gsplatDataCache?.extra) {
        const ex = gsplatDataCache.extra;
        return {
            rw: ex.rot_0?.[i] ?? 1,
            rx: ex.rot_1?.[i] ?? 0,
            ry: ex.rot_2?.[i] ?? 0,
            rz: ex.rot_3?.[i] ?? 0,
        };
    }
    return { rw: 1, rx: 0, ry: 0, rz: 0 };
};

/**
 * Compute screen-space ellipse for splat i using Jacobian-based 2D covariance
 * projection — the same math the GPU vertex shader uses.
 * Returns { cx, cy, distCam, a, b, cos, sin } where a/b are 1-sigma semi-axes
 * in pixels and cos/sin define the orientation of semi-axis a.
 * Returns null if behind camera.
 */
const getSplatScreenEllipse = (data, layer, i, wEnt) => {
    if (!data.isLayerData && !isBaseSplatAlive(i)) return null;
    const cam = cameraEntity.camera;
    const wm = wEnt.getWorldTransform();
    const px = data.x[i], py = data.y[i], pz = data.z[i];
    const { s0, s1, s2 } = getSplatScalesAt(data, layer, i);
    const { rw, rx, ry, rz } = getSplatRotationAt(data, layer, i);

    _ringW0.set(px, py, pz);
    wm.transformPoint(_ringW0, _ringW0);
    const distCam = _ringW0.distance(cameraEntity.getPosition());
    cam.worldToScreen(_ringW0, _ringS0);
    if (_ringS0.z <= 0) return null;
    const cx = _ringS0.x, cy = _ringS0.y;

    const sx = Math.exp(s0), sy = Math.exp(s1), sz = Math.exp(s2);

    const len2 = rw * rw + rx * rx + ry * ry + rz * rz;
    const inv = len2 > 1e-10 ? 1 / Math.sqrt(len2) : 1;
    const qw = rw * inv, qx = rx * inv, qy = ry * inv, qz = rz * inv;
    const r00 = 1 - 2*(qy*qy + qz*qz), r01 = 2*(qx*qy - qz*qw), r02 = 2*(qx*qz + qy*qw);
    const r10 = 2*(qx*qy + qz*qw), r11 = 1 - 2*(qx*qx + qz*qz), r12 = 2*(qy*qz - qx*qw);
    const r20 = 2*(qx*qz - qy*qw), r21 = 2*(qy*qz + qx*qw), r22 = 1 - 2*(qx*qx + qy*qy);

    // M = R * S  (columns of the 3×3 model-space matrix)
    const m00 = r00*sx, m01 = r01*sy, m02 = r02*sz;
    const m10 = r10*sx, m11 = r11*sy, m12 = r12*sz;
    const m20 = r20*sx, m21 = r21*sy, m22 = r22*sz;

    // World transform 3×3 (column-major .data)
    const wd = wm.data;
    const w00 = wd[0], w01 = wd[4], w02 = wd[8];
    const w10 = wd[1], w11 = wd[5], w12 = wd[9];
    const w20 = wd[2], w21 = wd[6], w22 = wd[10];

    // M_world = W * M_local
    const mw00 = w00*m00+w01*m10+w02*m20, mw01 = w00*m01+w01*m11+w02*m21, mw02 = w00*m02+w01*m12+w02*m22;
    const mw10 = w10*m00+w11*m10+w12*m20, mw11 = w10*m01+w11*m11+w12*m21, mw12 = w10*m02+w11*m12+w12*m22;
    const mw20 = w20*m00+w21*m10+w22*m20, mw21 = w20*m01+w21*m11+w22*m21, mw22 = w20*m02+w21*m12+w22*m22;

    // View matrix 3×3 (column-major)
    const vd = cam.viewMatrix.data;
    const v00 = vd[0], v01 = vd[4], v02 = vd[8];
    const v10 = vd[1], v11 = vd[5], v12 = vd[9];
    const v20 = vd[2], v21 = vd[6], v22 = vd[10];

    // T = V * M_world  (3×3, columns of the splat axes in camera space)
    const t00 = v00*mw00+v01*mw10+v02*mw20, t01 = v00*mw01+v01*mw11+v02*mw21, t02 = v00*mw02+v01*mw12+v02*mw22;
    const t10 = v10*mw00+v11*mw10+v12*mw20, t11 = v10*mw01+v11*mw11+v12*mw21, t12 = v10*mw02+v11*mw12+v12*mw22;
    const t20 = v20*mw00+v21*mw10+v22*mw20, t21 = v20*mw01+v21*mw11+v22*mw21, t22 = v20*mw02+v21*mw12+v22*mw22;

    // Camera-space center
    const tx = vd[0]*_ringW0.x + vd[4]*_ringW0.y + vd[8]*_ringW0.z  + vd[12];
    const ty = vd[1]*_ringW0.x + vd[5]*_ringW0.y + vd[9]*_ringW0.z  + vd[13];
    const tz = vd[2]*_ringW0.x + vd[6]*_ringW0.y + vd[10]*_ringW0.z + vd[14];
    if (tz >= 0) return null;
    const ntz = -tz;

    // Focal lengths in pixels from the projection matrix
    const pd = cam.projectionMatrix.data;
    const canvasW = app.graphicsDevice.width, canvasH = app.graphicsDevice.height;
    const fx = pd[0] * canvasW * 0.5;
    const fy = pd[5] * canvasH * 0.5;

    // Jacobian of screen projection (y-down screen space):
    //   J = [ fx/ntz,   0,       fx*tx/ntz² ]
    //       [ 0,       -fy/ntz, -fy*ty/ntz² ]
    const ntz2 = ntz * ntz;
    const j00v = fx / ntz,  j02v = fx * tx / ntz2;
    const j11v = -fy / ntz, j12v = -fy * ty / ntz2;

    // JT = J * T  (2×3)
    const jt00 = j00v*t00 + j02v*t20, jt01 = j00v*t01 + j02v*t21, jt02 = j00v*t02 + j02v*t22;
    const jt10 = j11v*t10 + j12v*t20, jt11 = j11v*t11 + j12v*t21, jt12 = j11v*t12 + j12v*t22;

    // Σ_2D = JT * JT^T  (2×2 symmetric)
    const s00 = jt00*jt00 + jt01*jt01 + jt02*jt02;
    const s01 = jt00*jt10 + jt01*jt11 + jt02*jt12;
    const s11 = jt10*jt10 + jt11*jt11 + jt12*jt12;

    // Eigendecompose 2×2 symmetric → semi-axes
    const tr = s00 + s11;
    const det = s00 * s11 - s01 * s01;
    const disc = Math.max(0, tr * tr * 0.25 - det);
    const sqD = Math.sqrt(disc);
    const lambda1 = tr * 0.5 + sqD;
    const lambda2 = Math.max(0, tr * 0.5 - sqD);
    const a = Math.max(3, Math.sqrt(lambda1));
    const b = Math.max(1, Math.sqrt(lambda2));

    let ex, ey;
    if (Math.abs(s01) > 1e-10) {
        ex = lambda1 - s11;
        ey = s01;
    } else {
        ex = s00 >= s11 ? 1 : 0;
        ey = s00 >= s11 ? 0 : 1;
    }
    const eLen = Math.hypot(ex, ey) || 1;
    return { cx, cy, distCam, a, b, cos: ex / eLen, sin: ey / eLen };
};

/**
 * Test if screen point (px, py) is inside the visible area of a splat ellipse.
 * Matches SuperSplat behaviour: selection in ring mode tests against the full
 * splat footprint (not just the ring stroke). The ring is purely visual.
 * A generous outer pad accounts for CPU/GPU projection differences.
 */
const screenHitsSplatEllipse = (px, py, e) => {
    if (!e) return false;
    const dx = px - e.cx, dy = py - e.cy;
    const lx = (dx * e.cos + dy * e.sin) / e.a;
    const ly = (-dx * e.sin + dy * e.cos) / e.b;
    const r = Math.hypot(lx, ly);
    return r <= 1.35;
};

/**
 * Test if a splat ellipse intersects an axis-aligned screen rectangle.
 * Tests the full splat area (not just the ring band), matching SuperSplat.
 */
const splatEllipseIntersectsRect = (e, minX, maxX, minY, maxY) => {
    if (!e) return false;
    const pad = 1.35;
    const maxR = Math.max(e.a, e.b) * pad;
    const ecx = e.cx, ecy = e.cy;
    if (ecx + maxR < minX || ecx - maxR > maxX || ecy + maxR < minY || ecy - maxR > maxY) return false;
    const N = 24;
    for (let k = 0; k < N; k++) {
        const angle = (k / N) * Math.PI * 2;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        for (const frac of [0.5, 0.85, 1.0, pad]) {
            const lx = cosA * frac, ly = sinA * frac;
            const sx = ecx + (lx * e.cos - ly * e.sin) * e.a;
            const sy = ecy + (lx * e.sin + ly * e.cos) * e.b;
            if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) return true;
        }
    }
    for (const [rx, ry] of [[minX,minY],[maxX,minY],[minX,maxY],[maxX,maxY]]) {
        const dx = rx - ecx, dy = ry - ecy;
        const lx = (dx * e.cos + dy * e.sin) / e.a;
        const ly = (-dx * e.sin + dy * e.cos) / e.b;
        if (Math.hypot(lx, ly) <= pad) return true;
    }
    return false;
};

/** Screen-space point-in-polygon (non-zero winding / ray cast). `poly` is closed implicitly. */
const pointInPolygon = (px, py, poly) => {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const denom = (yj - yi) || 1e-20;
        const inter = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / denom + xi);
        if (inter) inside = !inside;
    }
    return inside;
};

const splatEllipseIntersectsPolygon = (e, poly) => {
    if (!e || !poly || poly.length < 3) return false;
    const pad = 1.35;
    if (pointInPolygon(e.cx, e.cy, poly)) return true;
    const N = 32;
    for (let k = 0; k < N; k++) {
        const angle = (k / N) * Math.PI * 2;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const sx = e.cx + (cosA * e.cos - sinA * e.sin) * e.a * pad;
        const sy = e.cy + (cosA * e.sin + sinA * e.cos) * e.b * pad;
        if (pointInPolygon(sx, sy, poly)) return true;
    }
    for (const p of poly) {
        const dx = p.x - e.cx, dy = p.y - e.cy;
        const lx = (dx * e.cos + dy * e.sin) / e.a;
        const ly = (-dx * e.sin + dy * e.cos) / e.b;
        if (Math.hypot(lx, ly) <= pad) return true;
    }
    return false;
};

/** Closest-to-camera splat whose ellipse covers (screenX, screenY), or null. */
const pickFrontSplatAtScreen = (screenX, screenY, data, layer, wEnt) => {
    const hits = [];
    for (let i = 0; i < data.numSplats; i++) {
        const e = getSplatScreenEllipse(data, layer, i, wEnt);
        if (e && screenHitsSplatEllipse(screenX, screenY, e)) hits.push({ i, d: e.distCam });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.d - b.d);
    return hits[0].i;
};

/** Parent for the loaded base splat; global model rotation applies here. */
const baseContainer = new pc.Entity('baseContainer');
app.root.addChild(baseContainer);
const layersContainer = new pc.Entity('layersContainer');
app.root.addChild(layersContainer);

/**
 * PlayCanvas keeps loaded gsplat `Asset` entries in `app.assets` after entities are destroyed.
 * Dropping unreferenced assets releases CPU-side resource data (and associated GPU memory).
 */
const pruneUnusedGsplatAssetsFromRegistry = () => {
    const keep = new Set();
    for (const p of paintables) {
        const id = p.entity?.gsplat?.asset?.id;
        if (id != null) keep.add(id);
    }
    for (const layer of layers) {
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        const id = ent?.gsplat?.asset?.id;
        if (id != null) keep.add(id);
    }
    const list = app.assets.list();
    for (let i = list.length - 1; i >= 0; i--) {
        const a = list[i];
        if (a.type !== 'gsplat' || a.loading) continue;
        if (keep.has(a.id)) continue;
        try {
            app.assets.remove(a);
        } catch (_) { /* ignore */ }
    }
};

// ── Layer transform gizmos (viewport handles for selected layer or base) ──────
const LS_LAYER_GIZMO_VISIBLE = 'photoshock-layer-gizmo-visible';
const LS_LAYER_GIZMO_MODE = 'photoshock-layer-gizmo-mode';
const LS_RIGHT_PANEL_TAB = 'photoshock-right-panel-tab';

let layerGizmoVisible = true;
try {
    if (localStorage.getItem(LS_LAYER_GIZMO_VISIBLE) === '0') layerGizmoVisible = false;
} catch (_) { /* ignore */ }

let layerGizmoMode = 'translate';
try {
    const m = localStorage.getItem(LS_LAYER_GIZMO_MODE);
    if (m === 'rotate' || m === 'scale' || m === 'translate') layerGizmoMode = m;
} catch (_) { /* ignore */ }

const layerTransformGizmoLayer = pc.Gizmo.createLayer(app);
const layerTranslateGizmo = new pc.TranslateGizmo(cameraEntity.camera, layerTransformGizmoLayer);
const layerRotateGizmo = new pc.RotateGizmo(cameraEntity.camera, layerTransformGizmoLayer);
const layerScaleGizmo = new pc.ScaleGizmo(cameraEntity.camera, layerTransformGizmoLayer);

/** Wireframe preview for Shape layer tool (world root + mesh child). */
let shapePreviewRoot = null;
let shapePreviewMeshEntity = null;
/** True after Add (orbit target); false after drag-place — only locked preview follows orbit.target. */
let shapePreviewOrbitLock = false;
/** @type {{ active: boolean, startX: number, startY: number, depth: number|null, world0: pc.Vec3|null, session: number }|null} */
let shapePlacementDrag = null;
let shapePlaceSession = 0;
let syncingShapeUIFromPreview = false;
let gizmoTargetIsShapePreview = false;
let gizmoTargetIsRenderBox = false;
let activeRenderBoxGizmoEntity = null;
let renderBoxGizmoEditMode = false;

/** Local-space centroid of base splats (mean xyz); translate gizmo attaches here. */
const baseGizmoPivotCentroidLocal = new pc.Vec3(0, 0, 0);

for (const gz of [layerTranslateGizmo, layerRotateGizmo, layerScaleGizmo]) {
    gz.coordSpace = 'local';
    gz.size = 1.15;
}

const foldBaseGizmoPivotDeltaIntoParent = () => {
    if (!paintables.length) return;
    const parent = paintables[0].entity;
    const pivot = parent.findByName('base-gizmo-mass-pivot');
    if (!pivot) return;
    const C = baseGizmoPivotCentroidLocal;
    const lp = pivot.getLocalPosition();
    const dx = lp.x - C.x;
    const dy = lp.y - C.y;
    const dz = lp.z - C.z;
    if (Math.hypot(dx, dy, dz) < 1e-8) return;
    const p = parent.getLocalPosition();
    parent.setLocalPosition(p.x + dx, p.y + dy, p.z + dz);
    pivot.setLocalPosition(C.x, C.y, C.z);
};

/** Reposition (or create) empty child at splat center-of-mass for base translate gizmo. */
const refreshBaseGizmoMassPivotChild = () => {
    if (!paintables.length || !gsplatDataCache?.numSplats) return;
    const parent = paintables[0].entity;
    let pivot = parent.findByName('base-gizmo-mass-pivot');
    if (!pivot) {
        pivot = new pc.Entity('base-gizmo-mass-pivot');
        parent.addChild(pivot);
    }
    const { x, y, z, numSplats } = gsplatDataCache;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < numSplats; i++) {
        sx += x[i];
        sy += y[i];
        sz += z[i];
    }
    const inv = 1 / numSplats;
    const cx = sx * inv;
    const cy = sy * inv;
    const cz = sz * inv;
    baseGizmoPivotCentroidLocal.set(cx, cy, cz);
    pivot.setLocalPosition(cx, cy, cz);
};

const syncActiveTargetTransformFromGizmoEntity = () => {
    let ent = null;
    const isBase = selectedLayerId === 'base' || !selectedLayerId;
    if (isBase) {
        foldBaseGizmoPivotDeltaIntoParent();
        ent = paintables[0]?.entity ?? null;
    } else {
        const lyr = layers.find((l) => l.id === selectedLayerId);
        if (lyr) ent = layersContainer.findByName(`layer-${lyr.id}`);
    }
    if (!ent) return;
    const p = ent.getLocalPosition();
    const eAng = ent.getLocalEulerAngles();
    const s = ent.getLocalScale();
    const clampPos = (v) => Math.max(-1000, Math.min(1000, v));
    const clampRot = (v) => Math.max(-360, Math.min(360, v));
    const clampScl = (v) => Math.max(0.01, Math.min(10, v));
    if (isBase) {
        baseTransform.position.x = clampPos(p.x);
        baseTransform.position.y = clampPos(p.y);
        baseTransform.position.z = clampPos(p.z);
        baseTransform.rotation.x = clampRot(eAng.x);
        baseTransform.rotation.y = clampRot(eAng.y);
        baseTransform.rotation.z = clampRot(eAng.z);
        baseTransform.scale.x = clampScl(s.x);
        baseTransform.scale.y = clampScl(s.y);
        baseTransform.scale.z = clampScl(s.z);
        applyBaseEntityTransform();
    } else {
        const lyr = layers.find((l) => l.id === selectedLayerId);
        if (!lyr) return;
        ensureUserLayerTransform(lyr);
        lyr.position.x = clampPos(p.x);
        lyr.position.y = clampPos(p.y);
        lyr.position.z = clampPos(p.z);
        lyr.rotation.x = clampRot(eAng.x);
        lyr.rotation.y = clampRot(eAng.y);
        lyr.rotation.z = clampRot(eAng.z);
        lyr.scale.x = clampScl(s.x);
        lyr.scale.y = clampScl(s.y);
        lyr.scale.z = clampScl(s.z);
    }
    syncLayerTransformUI();
};

const onLayerGizmoTransformChanged = () => {
    if (gizmoTargetIsShapePreview && shapePreviewRoot?.parent) {
        syncingShapeUIFromPreview = true;
        if (layerGizmoMode === 'scale') {
            const s = shapePreviewRoot.getLocalScale();
            const clampS = (v) => Math.max(SHAPE_DIM_MIN, Math.min(SHAPE_DIM_MAX, v));
            if (g('shape-size-x')) g('shape-size-x').value = String(Math.round(clampS(s.x) * 10000) / 10000);
            if (g('shape-size-y')) g('shape-size-y').value = String(Math.round(clampS(s.y) * 10000) / 10000);
            if (g('shape-size-z')) g('shape-size-z').value = String(Math.round(clampS(s.z) * 10000) / 10000);
        } else if (layerGizmoMode === 'rotate') {
            const eAng = shapePreviewRoot.getLocalEulerAngles();
            const fmt = (v) => String(Math.round(v * 100) / 100);
            if (g('shape-rot-x')) g('shape-rot-x').value = fmt(eAng.x);
            if (g('shape-rot-y')) g('shape-rot-y').value = fmt(eAng.y);
            if (g('shape-rot-z')) g('shape-rot-z').value = fmt(eAng.z);
        }
        syncingShapeUIFromPreview = false;
        saveShapeToolPrefs();
        return;
    }
    if (gizmoTargetIsRenderBox && activeRenderBoxGizmoEntity) {
        const rb = getActiveRenderBox();
        if (!rb) return;
        const p = activeRenderBoxGizmoEntity.getLocalPosition();
        const s = activeRenderBoxGizmoEntity.getLocalScale();
        rb.enabled = true;
        rb.center.x = clampRenderBoxNumber(p.x, 0);
        rb.center.y = clampRenderBoxNumber(p.y, 0);
        rb.center.z = clampRenderBoxNumber(p.z, 0);
        rb.size.x = clampRenderBoxSize(s.x, 2);
        rb.size.y = clampRenderBoxSize(s.y, 2);
        rb.size.z = clampRenderBoxSize(s.z, 2);
        syncLayerTransformUI();
        applyActiveRenderBoxToRuntime();
        return;
    }
    syncActiveTargetTransformFromGizmoEntity();
};

layerTranslateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, onLayerGizmoTransformChanged);
layerTranslateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onLayerGizmoTransformChanged);
layerRotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, onLayerGizmoTransformChanged);
layerRotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onLayerGizmoTransformChanged);
layerScaleGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, onLayerGizmoTransformChanged);
layerScaleGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onLayerGizmoTransformChanged);

const updateLayerGizmoToggleButton = () => {
    const btn = g('toggle-layer-gizmo-btn');
    if (!btn) return;
    btn.classList.toggle('gizmo-shown', layerGizmoVisible);
};

const updateLayerGizmoModeButtons = () => {
    document.querySelectorAll('.gizmo-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.gizmoMode === layerGizmoMode);
    });
    document.querySelectorAll('.transform-label[data-gizmo-label]').forEach((el) => {
        el.classList.toggle('gizmo-label-active', el.dataset.gizmoLabel === layerGizmoMode);
    });
};

const updateRenderBoxGizmoEditButton = () => {
    const btn = g('rb-edit-gizmo-btn');
    if (!btn) return;
    btn.classList.toggle('accent', renderBoxGizmoEditMode);
    btn.textContent = renderBoxGizmoEditMode ? 'Editing Box Gizmo' : 'Edit Box Gizmo';
    btn.title = renderBoxGizmoEditMode
        ? 'Stop editing clipping box with gizmo'
        : 'Edit clipping box with gizmo (translate/scale)';
};

const updateFloatingGizmoBarVisibility = () => {
    const bar = g('floating-gizmo-bar');
    if (!bar) return;
    const loaded = paintables.length > 0 || layers.some((l) => l.splats.length > 0);
    const userSel = selectedLayerId !== 'base' && selectedLayerId && layers.some((l) => l.id === selectedLayerId);
    const shapeGizmo = activeTool === 'shapeLayer' && shapePreviewRoot?.parent;
    const show = shapeGizmo || (loaded && (selectedLayerId === 'base' || !selectedLayerId || userSel));
    bar.classList.toggle('hidden', !show);
};

const refreshLayerGizmoAttachment = () => {
    refreshBaseGizmoMassPivotChild();
    layerTranslateGizmo.detach();
    layerRotateGizmo.detach();
    layerScaleGizmo.detach();
    gizmoTargetIsRenderBox = false;
    activeRenderBoxGizmoEntity = null;
    updateLayerGizmoToggleButton();
    updateFloatingGizmoBarVisibility();
    if (!layerGizmoVisible) return;

    if (activeTool === 'shapeLayer' && shapePreviewRoot?.parent) {
        gizmoTargetIsShapePreview = true;
        if (layerGizmoMode === 'rotate') layerRotateGizmo.attach([shapePreviewRoot]);
        else if (layerGizmoMode === 'scale') layerScaleGizmo.attach([shapePreviewRoot]);
        else layerTranslateGizmo.attach([shapePreviewRoot]);
        return;
    }
    gizmoTargetIsShapePreview = false;
    refreshActiveRenderBoxPreview();
    const rb = getActiveRenderBox();
    if (renderBoxGizmoEditMode && rb?.enabled && activeRenderBoxGizmoEntity) {
        gizmoTargetIsRenderBox = true;
        if (layerGizmoMode === 'scale') layerScaleGizmo.attach([activeRenderBoxGizmoEntity]);
        else layerTranslateGizmo.attach([activeRenderBoxGizmoEntity]);
        return;
    }

    let ent = null;
    if (selectedLayerId === 'base' || !selectedLayerId) {
        const baseEnt = paintables[0]?.entity ?? null;
        if (baseEnt && layerGizmoMode === 'translate') {
            const pivot = baseEnt.findByName('base-gizmo-mass-pivot');
            ent = pivot ?? baseEnt;
        } else {
            ent = baseEnt;
        }
    } else {
        const lyr = layers.find((l) => l.id === selectedLayerId);
        if (lyr?.splats?.length)
            ent = layersContainer.findByName(`layer-${lyr.id}`);
    }
    if (!ent) return;

    if (layerGizmoMode === 'rotate') layerRotateGizmo.attach([ent]);
    else if (layerGizmoMode === 'scale') layerScaleGizmo.attach([ent]);
    else layerTranslateGizmo.attach([ent]);
};

// Minimal valid GSplat: 1 dummy splat for PlayCanvas (invisible, off to side)
const createDummySplat = () => ({
    x: -1e6, y: -1e6, z: -1e6,
    scale_0: -10, scale_1: -10, scale_2: -10,  // tiny (log scale)
    rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
    f_dc_0: 0, f_dc_1: 0, f_dc_2: 0,
    opacity: -20,  // nearly invisible (logit)
    nx: 0, ny: 1, nz: 0,
});

// Generate Splats tool state
let generateSplatsSampledColor = [0.5, 0.5, 0.5];  // RGB 0-1, default gray
let isGenerateSplatsPainting = false;
let lastGenerateSplatsWorld = null;
let layerUpdateTimeout = null;

// Additive blend state (for erase accumulation)
const ADDITIVE_BLEND = new pc.BlendState(
    true,
    pc.BLENDEQUATION_ADD, pc.BLENDMODE_ONE, pc.BLENDMODE_ONE,
    pc.BLENDEQUATION_ADD, pc.BLENDMODE_ONE, pc.BLENDMODE_ONE,
);
// Reset blend: result = dst * (1 - src.a). Write (0,0,0,falloff) — no read needed.
const RESET_BLEND = new pc.BlendState(
    true,
    pc.BLENDEQUATION_ADD, pc.BLENDMODE_ZERO, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA,
    pc.BLENDEQUATION_ADD, pc.BLENDMODE_ZERO, pc.BLENDMODE_ONE_MINUS_SRC_ALPHA,
);

// ── UI refs ───────────────────────────────────────────────────────────────────
const brushCursor     = document.getElementById('brush-cursor');
const boxSelectRect   = document.getElementById('box-select-rect');
const selectionOverlaySvg = document.getElementById('selection-overlay-svg');
const instructions    = document.getElementById('instructions');
const loadProgressOverlay = document.getElementById('load-progress-overlay');
const loadProgressBar = document.getElementById('load-progress-bar');
const loadProgressFill = document.getElementById('load-progress-fill');
const loadProgressTitle = document.getElementById('load-progress-title');
const loadProgressDetail = document.getElementById('load-progress-detail');

let modelImportProgressActive = false;

const setModelImportProgressPct = (pct, detail) => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    if (loadProgressFill) {
        loadProgressFill.classList.remove('indeterminate');
        loadProgressFill.style.width = `${p}%`;
    }
    if (loadProgressBar) loadProgressBar.setAttribute('aria-valuenow', String(Math.round(p)));
    if (loadProgressDetail && detail !== undefined) loadProgressDetail.textContent = detail ?? '';
};

const setModelImportProgressIndeterminate = (detail = 'Processing…') => {
    if (loadProgressFill) {
        loadProgressFill.classList.add('indeterminate');
        loadProgressFill.style.width = '100%';
    }
    if (loadProgressBar) loadProgressBar.setAttribute('aria-valuenow', '0');
    if (loadProgressDetail) loadProgressDetail.textContent = detail;
};

const showModelImportProgress = (title) => {
    if (!loadProgressOverlay) return;
    modelImportProgressActive = true;
    if (loadProgressTitle) loadProgressTitle.textContent = title;
    setModelImportProgressPct(0, '');
    loadProgressOverlay.classList.remove('hidden');
    loadProgressOverlay.setAttribute('aria-busy', 'true');
};

const hideModelImportProgress = () => {
    if (!loadProgressOverlay) return;
    if (!modelImportProgressActive) return;
    modelImportProgressActive = false;
    loadProgressFill?.classList.remove('indeterminate');
    if (loadProgressFill) loadProgressFill.style.width = '0%';
    if (loadProgressBar) loadProgressBar.setAttribute('aria-valuenow', '0');
    if (loadProgressDetail) loadProgressDetail.textContent = '';
    loadProgressOverlay.classList.add('hidden');
    loadProgressOverlay.setAttribute('aria-busy', 'false');
};

/** PlayCanvas fires `progress` with (loadedBytes, totalBytes) while fetching asset data. */
const wireAssetDownloadProgress = (asset, downloadCapPct = 88) => {
    const fmtSize = (n) => {
        if (!Number.isFinite(n) || n < 0) return '';
        if (n < 1024) return `${Math.round(n)} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    };
    const onProgress = (loaded, total) => {
        if (!modelImportProgressActive) return;
        let pct = 0;
        if (total > 0) pct = (loaded / total) * downloadCapPct;
        else if (loaded > 0) pct = Math.min(downloadCapPct * 0.92, downloadCapPct);
        const detail = total > 0 ? `${fmtSize(loaded)} / ${fmtSize(total)}` : (loaded > 0 ? `${fmtSize(loaded)} transferred` : '');
        setModelImportProgressPct(pct, detail);
    };
    asset.on('progress', onProgress);
    return () => {
        try {
            asset.off('progress', onProgress);
        } catch (_) { /* ignore */ }
    };
};

const syncSelectionModeToolbar = () => {
    document.querySelectorAll('.sel-mode-toolbar-btn').forEach((btn) => {
        const m = btn.dataset.selMode;
        const on = m === selectionMode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
};

/** Viewport (#canvas-container) inset stroke: selection state + new/add/subtract when a selection tool is active. */
const syncViewportSelectionFrame = () => {
    if (!canvasContainer) return;
    const selTool = SELECTION_FRAME_TOOLS.includes(activeTool);
    let frame = 'none';
    if (!hasSelection) {
        frame = 'none';
    } else if (!selTool) {
        frame = 'idle';
    } else if (selectionMode === 'new') {
        frame = 'new';
    } else if (selectionMode === 'add') {
        frame = 'add';
    } else {
        frame = 'subtract';
    }
    canvasContainer.dataset.selectionFrame = frame;
};

const setSelectionMode = (mode) => {
    if (mode !== 'new' && mode !== 'add' && mode !== 'subtract') return;
    selectionMode = mode;
    syncSelectionModeToolbar();
    syncViewportSelectionFrame();
};

const refreshCursorCameraHint = () => {
    if (activeTool !== 'cursor') return;
    if (!hasRenderableSplats()) {
        instructions.innerHTML = '';
        return;
    }
    const orbitMsg = 'WASD pan target · Q up / E down · Drag orbit · Right-drag pan · Scroll zoom · Double-click focus · ` Fly camera';
    const flyMsg = 'WASD fly forward/strafe · Q world up / E world down · Drag look · Right-drag pan · Scroll along view · Double-click toward surface · ` Orbit camera';
    instructions.innerHTML = `<p>${cameraNavMode === 'orbit' ? orbitMsg : flyMsg}</p>`;
};

const syncCameraNavToolbar = () => {
    document.querySelectorAll('.camera-nav-btn').forEach((btn) => {
        const on = btn.dataset.cameraNav === cameraNavMode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
};

const setCameraNavMode = (mode) => {
    if (mode !== 'orbit' && mode !== 'fly') return;
    if (mode === cameraNavMode) return;
    if (mode === 'fly') {
        flyCam.pos.copy(cameraEntity.getPosition());
        flyCam.yaw = orbit.yaw;
        flyCam.pitch = orbit.pitch;
    } else {
        const yr = (flyCam.yaw * Math.PI) / 180;
        const pr = (flyCam.pitch * Math.PI) / 180;
        const ox = orbit.distance * Math.sin(yr) * Math.cos(pr);
        const oy = orbit.distance * Math.sin(pr);
        const oz = orbit.distance * Math.cos(yr) * Math.cos(pr);
        orbit.target.set(flyCam.pos.x - ox, flyCam.pos.y - oy, flyCam.pos.z - oz);
        orbit.yaw = flyCam.yaw;
        orbit.pitch = flyCam.pitch;
    }
    cameraNavMode = mode;
    try { localStorage.setItem(LS_CAMERA_NAV, mode); } catch (_) {}
    syncCameraNavToolbar();
    updateCamera();
    refreshCursorCameraHint();
};

// ── Tool management ───────────────────────────────────────────────────────────
const setTool = (tool) => {
    if (tool === 'sphereSelect') tool = 'boxSelect';
    if (tool !== 'lassoSelect') {
        lassoDragActive = false;
        lassoPoints.length = 0;
        lassoEffectiveMode = null;
    }
    if (tool !== 'vectorSelect') {
        vectorPolyPoints.length = 0;
        vectorHoverScreen = null;
    }

    activeTool = tool;
    if (tool === 'shapeLayer') {
        updateShapeSplatButtonEnabled();
    } else if (tool !== 'cursor' || !shapePreviewRoot) {
        destroyShapePreview();
        shapePlacementDrag = null;
    }
    redrawSelectionOverlays();
    clearHoverSphere();
    cancelSwatchSplatPick();
    cancelSplitToneSplatPick();

    const toolBtnMap = {
        cursor: 'tool-cursor', brush: 'tool-brush', eraser: 'tool-eraser', resetBrush: 'tool-resetBrush',
        paintBucket: 'tool-paint-bucket',
        boxSelect: 'tool-box-select',
        lassoSelect: 'tool-lasso-select',
        vectorSelect: 'tool-vector-select',
        brushSelect: 'tool-brush-select', colorSelect: 'tool-color-select',
        generateSplats: 'tool-generate-splats', splatSelect: 'tool-splat-select',
        shapeLayer: 'tool-shape-layer',
    };
    Object.entries(toolBtnMap).forEach(([t, id]) => {
        document.getElementById(id)?.classList.toggle('active', t === tool);
    });

    document.querySelectorAll('.tool-options').forEach(el => el.classList.add('hidden'));
    const optMap = {
        cursor: 'options-cursor', brush: 'options-brush', eraser: 'options-eraser', resetBrush: 'options-resetBrush',
        paintBucket: 'options-paint-bucket',
        boxSelect: 'options-box-select',
        lassoSelect: 'options-lasso-select',
        vectorSelect: 'options-vector-select',
        brushSelect: 'options-brush-select', colorSelect: 'options-color-select',
        generateSplats: 'options-generate-splats', splatSelect: 'options-splat-select',
        shapeLayer: 'options-shape-layer',
    };
    const selTools = ['boxSelect', 'lassoSelect', 'vectorSelect', 'brushSelect', 'colorSelect', 'splatSelect'];
    const selStripTools = [...selTools, 'brush', 'eraser', 'resetBrush', 'paintBucket'];
    document.getElementById('selection-options-strip')?.classList.toggle('hidden', !selStripTools.includes(tool));
    const showFloatingSelCmds = selTools.includes(tool);
    g('floating-gizmo-selection-commands')?.classList.toggle('hidden', !showFloatingSelCmds);
    if (showFloatingSelCmds) syncSelectionModeToolbar();
    document.getElementById(optMap[tool])?.classList.remove('hidden');
    if (tool === 'paintBucket') g('options-brush')?.classList.remove('hidden');
    g('brush-bake-paint-group')?.classList.toggle('hidden', tool === 'paintBucket');

    canvasContainer.classList.remove(
        'mode-cursor','mode-brush','mode-eraser','mode-resetBrush','mode-paintBucket','mode-boxSelect',
        'mode-lassoSelect','mode-vectorSelect',
        'mode-brushSelect','mode-colorSelect','mode-generateSplats','mode-splatSelect',
        'mode-shapeLayer',
    );
    canvasContainer.classList.add(`mode-${tool}`);
    brushCursor.classList.toggle('eraser-mode', tool === 'eraser' || tool === 'resetBrush');
    if (tool === 'paintBucket') brushCursor.style.cssText = '';

    const msgs = {
        cursor:       'WASD move · Q up / E down · Drag orbit · Right-drag pan · Scroll zoom · Double-click focus',
        brush:        'Click & drag to paint · Scroll to zoom',
        eraser:       'Click & drag to erase opacity · Brush depth = thickness along view · Scroll to zoom',
        resetBrush:   'Click & drag to restore original colors (clears paint & erase)',
        paintBucket:  'Click to fill all selected splats · Uses brush color, blend & intensity (B) · K',
        boxSelect:    'Drag to draw selection rectangle (R) · In splat + ring mode, selects ring hits (front-most)',
        lassoSelect:  'Drag freehand loop (L) · Release to select enclosed splats · Alt inverts add/subtract',
        vectorSelect: 'Click polygon corners (Y) · Press Enter to close (≥3 points) · Backspace removes last point · Green dot = first vertex',
        brushSelect:  'Click & drag to paint selection with brush (O) · Scroll to zoom',
        colorSelect:  'Click a splat to select all splats of similar color · Loupe shows magnified pixels under the cursor',
        generateSplats: 'Alt+click to sample color · Click & drag to generate splats in gaps (U)',
        splatSelect:  'Click/drag — nearest splat; with splat + ring mode, picks the front ring under the cursor',
        shapeLayer:   '',
    };
    if (tool === 'cursor') {
        refreshCursorCameraHint();
    } else {
        const hint = msgs[tool] || '';
        instructions.innerHTML = hint ? `<p>${hint}</p>` : '';
    }
    if (tool !== 'colorSelect') hideColorPixelLoupe();
    refreshLayerGizmoAttachment();
    syncViewportSelectionFrame();
};

// ── Inline math evaluation for number inputs ────────────────────────────────
// On focus: switch to text so the user can type +, *, /, (, ) etc.
// On blur:  evaluate the expression, clamp, restore to number type.
const MATH_EXPR_RE = /^[\d+\-*/().,%^ e]+$/;
const tryEvalMathExpr = (raw) => {
    const s = raw.trim().replace(/,/g, '.').replace(/\^/g, '**');
    if (!MATH_EXPR_RE.test(raw.trim().replace(/,/g, '.'))) return null;
    if (/^-?\d*\.?\d+$/.test(s)) return null;
    try {
        const val = new Function(`"use strict"; return (${s});`)();
        return Number.isFinite(val) ? val : null;
    } catch { return null; }
};
const _mathInputMeta = new WeakMap();
document.addEventListener('focusin', (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement) || inp.type !== 'number') return;
    _mathInputMeta.set(inp, { min: inp.min, max: inp.max, step: inp.step });
    inp.type = 'text';
    inp.select();
}, true);
document.addEventListener('focusout', (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement) || !_mathInputMeta.has(inp)) return;
    const meta = _mathInputMeta.get(inp);
    _mathInputMeta.delete(inp);
    const result = tryEvalMathExpr(inp.value);
    if (result != null) {
        const min = meta.min !== '' ? parseFloat(meta.min) : -Infinity;
        const max = meta.max !== '' ? parseFloat(meta.max) : Infinity;
        const step = meta.step !== '' ? parseFloat(meta.step) : 1;
        let clamped = Math.max(min, Math.min(max, result));
        if (step && Number.isFinite(step) && step > 0) {
            const decimals = (step.toString().split('.')[1] || '').length;
            clamped = parseFloat(clamped.toFixed(Math.max(decimals, 4)));
        }
        inp.value = String(clamped);
    }
    inp.type = 'number';
    Object.assign(inp, { min: meta.min, max: meta.max, step: meta.step });
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
}, true);

// ── Settings getters ──────────────────────────────────────────────────────────
const g = (id) => document.getElementById(id);
const getF = (id) => {
    const el = g(id);
    if (!el) return NaN;
    const v = parseNumericOrExpr(el.value);
    if (v != null) return v;
    return parseFloat(el.value);
};
const getI = (id) => parseInt(g(id).value);

const brushSize      = () => getF('brush-size');
const brushHardness  = () => getF('brush-hardness');
const brushIntensity = () => getF('brush-intensity');
const brushSpacing   = () => getF('brush-spacing');
const blendMode      = () => getI('blend-mode');
/** User choice when a selection exists: paint everywhere except selected vs only selected. */
const getSelectionPaintScope = () => (g('sel-paint-scope-only')?.checked ? 'only' : 'exclude');
/** 0 = no mask · 1 = exclude selected · 2 = only selected */
const selectionConstraintForPaintTools = () => {
    const mask = peekActiveSelectionMask();
    if (!mask?.some((v) => v)) return 0;
    return getSelectionPaintScope() === 'only' ? 2 : 1;
};
const selectionConstraintForOp = (op) => {
    if (op.selectionConstraint != null) return op.selectionConstraint;
    const mask = peekActiveSelectionMask();
    return mask?.some((v) => v) ? 1 : 0;
};
const eraserSize     = () => getF('eraser-size');
const eraserHardness = () => getF('eraser-hardness');
const eraserIntensity= () => getF('eraser-intensity');
const eraserSpacing  = () => getF('eraser-spacing');
/** World-space full thickness along view; 0 = spherical erase. */
const eraserDepth    = () => getF('eraser-depth');
const paintColorHex    = () => g('paint-color')?.value ?? '#ff0000';

/** Normalize user hex to #rrggbb for <input type="color"> */
const normalizeBrushHex = (raw) => {
    let s = (raw ?? '').trim();
    if (!s) return null;
    if (s[0] !== '#') s = `#${s}`;
    const m3 = /^#([0-9a-fA-F]{3})$/.exec(s);
    if (m3) {
        const x = m3[1];
        return `#${x[0]}${x[0]}${x[1]}${x[1]}${x[2]}${x[2]}`.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    return null;
};

const syncBrushHexFieldFromPicker = () => {
    const picker = g('paint-color');
    const hexEl = g('paint-color-hex');
    if (picker && hexEl) hexEl.value = picker.value.toLowerCase();
};

const applyBrushHexFromTextField = () => {
    const picker = g('paint-color');
    const hexEl = g('paint-color-hex');
    if (!picker || !hexEl) return;
    const norm = normalizeBrushHex(hexEl.value);
    if (norm) {
        picker.value = norm;
        hexEl.value = norm;
    } else {
        hexEl.value = picker.value.toLowerCase();
    }
    persistBrushColor();
};

// ── Cached UI colors (localStorage) ───────────────────────────────────────────
const LS_BRUSH_COLOR_KEY = 'photoshock-brush-color';
const LS_BG_COLOR_KEY = 'photoshock-bg-color';
const LS_SWATCHES_KEY = 'photoshock-swatches-v1';

const persistSwatches = () => {
    try {
        const data = swatches
            .map((s) => {
                const hex = normalizeBrushHex(s.hex);
                return hex ? { id: String(s.id || ''), hex } : null;
            })
            .filter(Boolean);
        localStorage.setItem(LS_SWATCHES_KEY, JSON.stringify(data));
    } catch (_) { /* private mode / quota */ }
};

const loadCachedSwatches = () => {
    try {
        const raw = localStorage.getItem(LS_SWATCHES_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return;
        swatches.length = 0;
        for (const item of data) {
            const hex = normalizeBrushHex(item?.hex);
            if (!hex) continue;
            const id =
                typeof item?.id === 'string' && item.id
                    ? item.id
                    : `swatch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            swatches.push({ id, hex });
        }
    } catch (_) { /* ignore corrupt storage */ }
};

const persistBrushColor = () => {
    try {
        const norm = normalizeBrushHex(g('paint-color')?.value);
        if (norm) localStorage.setItem(LS_BRUSH_COLOR_KEY, norm);
    } catch (_) { /* private mode / quota */ }
};

const loadCachedBrushColor = () => {
    try {
        const norm = normalizeBrushHex(localStorage.getItem(LS_BRUSH_COLOR_KEY));
        if (!norm) return;
        const picker = g('paint-color');
        const hexEl = g('paint-color-hex');
        if (picker) picker.value = norm;
        if (hexEl) hexEl.value = norm;
    } catch (_) { /* ignore */ }
};

// Power-curve so the slider gives fine control at low end:
// slider 0→1 maps to tolerance 0→0.25 via cubic (0.5^3*2=0.0625 at midpoint)
const colorTolerance   = () => Math.pow(getF('color-tolerance'), 3) * 0.25;
const brushSelectSize     = () => getF('brush-select-size');
const brushSelectHardness = () => getF('brush-select-hardness');
const brushSelectSpacing  = () => getF('brush-select-spacing');
const generateSplatsSize  = () => getF('generate-splats-size');
const generateSplatsDensity = () => getI('generate-splats-density');
const resetSize    = () => parseFloat(g('reset-size')?.value ?? g('reset-size-num')?.value ?? '0.15');
const resetHardness= () => getF('reset-hardness');
const resetSpacing = () => getF('reset-spacing');

const hexToRgb = (hex) => [
    parseInt(hex.slice(1,3),16)/255,
    parseInt(hex.slice(3,5),16)/255,
    parseInt(hex.slice(5,7),16)/255,
];

/** Generator points (shape space) → world via preview root matrix → base or layersContainer local. */
const buildShapeSplatsForLayer = ({
    worldMat,
    shapeType,
    dims,
    density,
    hollowEdges,
    colorHex,
}) => {
    const gen = shapeGenerators[shapeType];
    if (!gen) return null;
    const [cr, cg, cb] = hexToRgb(colorHex);
    const points = gen(density, dims, hollowEdges);
    const avgDim = (dims.sx + dims.sy + dims.sz) / 3;
    const logScale = Math.max(-6, Math.min(-1.5, Math.log(avgDim / (Math.sqrt(density) * 1.8))));
    const mkSplat = (lx, ly, lz) => ({
        x: lx, y: ly, z: lz,
        f_dc_0: (cr - 0.5) / SH_C0,
        f_dc_1: (cg - 0.5) / SH_C0,
        f_dc_2: (cb - 0.5) / SH_C0,
        opacity: invSigmoid(0.92),
        scale_0: logScale,
        scale_1: logScale,
        scale_2: logScale,
        rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
        nx: 0, ny: 1, nz: 0,
    });
    const dx = dims.sx || 1e-8;
    const dy = dims.sy || 1e-8;
    const dz = dims.sz || 1e-8;
    const baseEnt = paintables.length > 0 ? paintables[0].entity : null;
    const splats = [];
    if (baseEnt) {
        _shapeInvBaseScratch.copy(baseEnt.getWorldTransform()).invert();
        for (const p of points) {
            _shapeNormScratch.set(p.x / dx, p.y / dy, p.z / dz);
            worldMat.transformPoint(_shapeNormScratch, _shapeWorldTmp);
            _shapeInvBaseScratch.transformPoint(_shapeWorldTmp, _shapeLocalTmp);
            splats.push(mkSplat(_shapeLocalTmp.x, _shapeLocalTmp.y, _shapeLocalTmp.z));
        }
    } else {
        _shapeInvParent.copy(layersContainer.getWorldTransform()).invert();
        for (const p of points) {
            _shapeNormScratch.set(p.x / dx, p.y / dy, p.z / dz);
            worldMat.transformPoint(_shapeNormScratch, _shapeWorldTmp);
            _shapeInvParent.transformPoint(_shapeWorldTmp, _shapeLocalTmp);
            splats.push(mkSplat(_shapeLocalTmp.x, _shapeLocalTmp.y, _shapeLocalTmp.z));
        }
    }
    return splats;
};

const splatShapePreviewToLayer = () => {
    if (!shapePreviewRoot?.parent) return;
    const shapeType = g('shape-type')?.value ?? 'cube';
    const color = g('shape-color')?.value ?? '#cccccc';
    const dims = readShapeDimsFromUI();
    const density = readShapeDensityFromUI();
    const hollowEdges = !!g('shape-hollow-edges')?.checked;
    saveShapeToolPrefs();
    const worldMat = shapePreviewRoot.getWorldTransform();
    const splats = buildShapeSplatsForLayer({
        worldMat,
        shapeType,
        dims,
        density,
        hollowEdges,
        colorHex: color,
    });
    if (!splats) {
        alert(`Unknown shape: ${shapeType}`);
        return;
    }
    const layer = {
        id: `layer-${layerIdCounter++}`,
        name: `${shapeType.charAt(0).toUpperCase() + shapeType.slice(1)}${hollowEdges ? ' (hollow)' : ''}`,
        visible: true,
        opacityPct: 100,
        colorGrade: cloneColorGrade(),
        renderBox: createDefaultRenderBox(),
        ...createDefaultLayerTransform(),
        splats,
        selectionMask: null,
    };
    layers.push(layer);
    selectedLayerId = layer.id;
    hasSelection = false;
    destroyShapePreview();
    renderLayersUI();
    void updateLayerEntity(layer)
        .then(() => {
            applyModelRotation();
            if (!paintables.length) frameOrbitOnLayerSplats(layer);
            updateSelectionUI();
            refreshLayerGizmoAttachment();
        })
        .catch((err) => {
            console.error('[shape layer]', err);
            instructions.innerHTML =
                `<p style="color:#f88">Could not build shape layer: ${err?.message || err}</p>`;
        });
};

const createDefaultColorGrade = () => ({
    enabled: true,
    exposure: 0,
    contrast: 1,
    blackPoint: 0,
    whitePoint: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    wheelShadowHex: '#808080',
    wheelShadowAmt: 0,
    wheelMidHex: '#808080',
    wheelMidAmt: 0,
    wheelHighHex: '#808080',
    wheelHighAmt: 0,
    sectors: Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 })),
    toneMode: 0,
    lutSize: 0,
    lutRgb: null,
    lutDomainMin: [0, 0, 0],
    lutDomainMax: [1, 1, 1],
    lutMix: 1,
    lutName: '',
    lutTexture: null,
});

let baseColorGrade = createDefaultColorGrade();

const cloneColorGrade = (src = null) => {
    const s = src ?? createDefaultColorGrade();
    const j = JSON.parse(JSON.stringify({
        enabled: s.enabled ?? true,
        exposure: s.exposure,
        contrast: s.contrast,
        blackPoint: s.blackPoint,
        whitePoint: s.whitePoint,
        saturation: s.saturation,
        temperature: s.temperature,
        tint: s.tint,
        wheelShadowHex: s.wheelShadowHex,
        wheelShadowAmt: s.wheelShadowAmt,
        wheelMidHex: s.wheelMidHex,
        wheelMidAmt: s.wheelMidAmt,
        wheelHighHex: s.wheelHighHex,
        wheelHighAmt: s.wheelHighAmt,
        sectors: s.sectors,
        toneMode: s.toneMode ?? 0,
        lutSize: s.lutSize || 0,
        lutDomainMin: s.lutDomainMin || [0, 0, 0],
        lutDomainMax: s.lutDomainMax || [1, 1, 1],
        lutMix: s.lutMix ?? 1,
        lutName: s.lutName || '',
    }));
    if (s.lutRgb?.length && s.lutSize) {
        j.lutRgb = new Float32Array(s.lutRgb);
    } else {
        j.lutRgb = null;
    }
    j.lutTexture = null;
    return j;
};

const ensureLayerColorGrade = (layer) => {
    if (!layer || typeof layer !== 'object') return;
    if (!layer.colorGrade?.sectors || layer.colorGrade.sectors.length !== 8) {
        layer.colorGrade = cloneColorGrade();
        return;
    }
    const d = createDefaultColorGrade();
    const g = layer.colorGrade;
    if (g.enabled == null) g.enabled = d.enabled;
    if (g.toneMode == null) g.toneMode = d.toneMode;
    if (g.lutMix == null) g.lutMix = d.lutMix;
    if (!g.lutDomainMin) g.lutDomainMin = [...d.lutDomainMin];
    if (!g.lutDomainMax) g.lutDomainMax = [...d.lutDomainMax];
    if (g.lutName == null) g.lutName = d.lutName;
};

const wheelRgbOffset = (hex, amt) => {
    const h = typeof hex === 'string' && hex.length >= 7 ? hex : '#808080';
    const [r, gr, b] = hexToRgb(h);
    const a = Math.max(0, Math.min(1, Number(amt) || 0));
    return [(r - 0.5) * 2 * a, (gr - 0.5) * 2 * a, (b - 0.5) * 2 * a];
};

const SPLIT_TONE_KEYS = ['sh', 'md', 'hi'];
const splitToneEditors = new Map();

const rgb01ToHex = (r, g0, b) => {
    const toHex = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g0)}${toHex(b)}`;
};

const rgb01ToHsl = (r, g0, b) => {
    const max = Math.max(r, g0, b);
    const min = Math.min(r, g0, b);
    const l = (max + min) * 0.5;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g0 - b) / d + (g0 < b ? 6 : 0)) / 6;
        else if (max === g0) h = ((b - r) / d + 2) / 6;
        else h = ((r - g0) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
};

const hslToRgb01 = (hDeg, sPct, lPct) => {
    const h = ((hDeg % 360) + 360) % 360 / 360;
    const s = Math.max(0, Math.min(100, sPct)) / 100;
    const l = Math.max(0, Math.min(100, lPct)) / 100;
    if (s <= 1e-8) return [l, l, l];
    const hue2rgb = (p, q, tRaw) => {
        let t = tRaw;
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
};

const renderSplitToneWheel = (ed) => {
    if (!ed?.canvas) return;
    const ctx = ed.canvas.getContext('2d');
    if (!ctx) return;
    const w = ed.canvas.width;
    const h = ed.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.5 - 3;
    if (!ed.baseImageData) {
        const img = ctx.createImageData(w, h);
        const d = img.data;
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const dx = px + 0.5 - cx;
                const dy = py + 0.5 - cy;
                const rr = Math.hypot(dx, dy);
                const idx = (py * w + px) * 4;
                if (rr > radius) {
                    d[idx + 3] = 0;
                    continue;
                }
                const sat = Math.max(0, Math.min(1, rr / radius));
                const hue = (((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360);
                const rgb = hslToRgb01(hue, sat * 100, 50);
                d[idx + 0] = Math.round(rgb[0] * 255);
                d[idx + 1] = Math.round(rgb[1] * 255);
                d[idx + 2] = Math.round(rgb[2] * 255);
                d[idx + 3] = 255;
            }
        }
        ed.baseImageData = img;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(ed.baseImageData, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    const ang = ((ed.h || 0) * Math.PI) / 180;
    const satR = Math.max(0, Math.min(1, (ed.s || 0) / 100)) * radius;
    const px = cx + Math.cos(ang) * satR;
    const py = cy + Math.sin(ang) * satR;
    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.5;
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
};

const syncSplitToneEditorUi = (ed, { updateColor = true } = {}) => {
    if (!ed) return;
    ed.h = Math.max(0, Math.min(360, Number(ed.h) || 0));
    ed.s = Math.max(0, Math.min(100, Number(ed.s) || 0));
    ed.l = Math.max(0, Math.min(100, Number(ed.l) || 0));
    const rgb = hslToRgb01(ed.h, ed.s, ed.l);
    const hex = rgb01ToHex(rgb[0], rgb[1], rgb[2]).toLowerCase();
    if (updateColor && ed.colorInput) ed.colorInput.value = hex;
    if (ed.hexInput) ed.hexInput.value = hex;
    if (ed.hInput) ed.hInput.value = String(Math.round(ed.h));
    if (ed.sInput) ed.sInput.value = String(Math.round(ed.s));
    if (ed.lInput) ed.lInput.value = String(Math.round(ed.l));
    if (ed.lumRange) ed.lumRange.value = String(Math.round(ed.l));
    if (ed.lumNum) ed.lumNum.value = String(Math.round(ed.l));
    renderSplitToneWheel(ed);
};

const setSplitToneColorFromHex = (key, hex, { commit = true } = {}) => {
    const ed = splitToneEditors.get(key);
    const norm = normalizeBrushHex(hex);
    if (!ed || !norm) return;
    const [r, g0, b] = hexToRgb(norm);
    const hsl = rgb01ToHsl(r, g0, b);
    ed.h = hsl.h;
    ed.s = hsl.s;
    ed.l = hsl.l;
    syncSplitToneEditorUi(ed, { updateColor: true });
    if (commit) commitActiveColorGradeFromUI();
};

const toggleSplitToneSplatPick = (key) => {
    if (!key) return;
    if (awaitingSplitToneSplatPick === key) {
        cancelSplitToneSplatPick();
        return;
    }
    cancelSwatchSplatPick();
    cancelSplitToneSplatPick();
    awaitingSplitToneSplatPick = key;
    canvasContainer.classList.add('swatch-splat-pick-armed');
    g(`cg-wheel-${key}-pick-btn`)?.classList.add('accent-btn');
};

const syncSplitToneEditorsFromColorInputs = () => {
    for (const key of SPLIT_TONE_KEYS) {
        const ed = splitToneEditors.get(key);
        const norm = normalizeBrushHex(ed?.colorInput?.value);
        if (!ed || !norm) continue;
        const [r, g0, b] = hexToRgb(norm);
        const hsl = rgb01ToHsl(r, g0, b);
        ed.h = hsl.h;
        ed.s = hsl.s;
        ed.l = hsl.l;
        syncSplitToneEditorUi(ed, { updateColor: true });
    }
};

const initSplitToneEditors = () => {
    splitToneEditors.clear();
    for (const key of SPLIT_TONE_KEYS) {
        const ed = {
            key,
            colorInput: g(`cg-wheel-${key}`),
            canvas: g(`cg-wheel-${key}-canvas`),
            lumRange: g(`cg-wheel-${key}-lum`),
            lumNum: g(`cg-wheel-${key}-lum-num`),
            hInput: g(`cg-wheel-${key}-h`),
            sInput: g(`cg-wheel-${key}-s`),
            lInput: g(`cg-wheel-${key}-l`),
            hexInput: g(`cg-wheel-${key}-hex`),
            pickBtn: g(`cg-wheel-${key}-pick-btn`),
            resetBtn: g(`cg-wheel-${key}-reset-btn`),
            h: 0,
            s: 0,
            l: 50,
            baseImageData: null,
        };
        if (!ed.colorInput || !ed.canvas) continue;
        const wheelPointerToHs = (clientX, clientY) => {
            const rect = ed.canvas.getBoundingClientRect();
            const w = ed.canvas.width;
            const h = ed.canvas.height;
            const cx = w * 0.5;
            const cy = h * 0.5;
            const radius = Math.min(w, h) * 0.5 - 3;
            const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * w - cx;
            const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * h - cy;
            const rr = Math.hypot(x, y);
            ed.h = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
            ed.s = Math.max(0, Math.min(100, (rr / Math.max(radius, 1e-6)) * 100));
            syncSplitToneEditorUi(ed, { updateColor: true });
            commitActiveColorGradeFromUI();
        };
        ed.canvas.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            const onMove = (mv) => wheelPointerToHs(mv.clientX, mv.clientY);
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            wheelPointerToHs(ev.clientX, ev.clientY);
        });
        const clampHslInputs = () => {
            ed.h = Math.max(0, Math.min(360, Number(ed.hInput?.value) || 0));
            ed.s = Math.max(0, Math.min(100, Number(ed.sInput?.value) || 0));
            ed.l = Math.max(0, Math.min(100, Number(ed.lInput?.value) || 0));
            syncSplitToneEditorUi(ed, { updateColor: true });
            commitActiveColorGradeFromUI();
        };
        ed.hInput?.addEventListener('input', clampHslInputs);
        ed.sInput?.addEventListener('input', clampHslInputs);
        ed.lInput?.addEventListener('input', clampHslInputs);
        const applyLum = () => {
            const v = Math.max(0, Math.min(100, Number(ed.lumRange?.value ?? ed.lumNum?.value) || 0));
            ed.l = v;
            syncSplitToneEditorUi(ed, { updateColor: true });
            commitActiveColorGradeFromUI();
        };
        ed.lumRange?.addEventListener('input', applyLum);
        ed.lumRange?.addEventListener('change', applyLum);
        ed.lumNum?.addEventListener('input', applyLum);
        ed.lumNum?.addEventListener('change', applyLum);
        ed.hexInput?.addEventListener('input', () => {
            const norm = normalizeBrushHex(ed.hexInput?.value);
            if (norm) setSplitToneColorFromHex(key, norm, { commit: true });
        });
        const commitHex = () => {
            const norm = normalizeBrushHex(ed.hexInput?.value);
            if (norm) setSplitToneColorFromHex(key, norm, { commit: true });
            else if (ed.colorInput) ed.hexInput.value = ed.colorInput.value.toLowerCase();
        };
        ed.hexInput?.addEventListener('change', commitHex);
        ed.hexInput?.addEventListener('blur', commitHex);
        ed.pickBtn?.addEventListener('click', () => toggleSplitToneSplatPick(key));
        ed.resetBtn?.addEventListener('click', () => {
            setSplitToneColorFromHex(key, '#808080', { commit: false });
            if (g(`cg-wheel-${key}-amt`)) g(`cg-wheel-${key}-amt`).value = '0';
            if (g(`cg-wheel-${key}-amt-num`)) g(`cg-wheel-${key}-amt-num`).value = '0';
            commitActiveColorGradeFromUI();
        });
        splitToneEditors.set(key, ed);
    }
    syncSplitToneEditorsFromColorInputs();
};

/** Matches GLSL `sp_rgb2hsv` / `sp_hsv2rgb` / `sp_grade_sectors` / `sp_color_grade` for export + bake. */
const spRgb2hsvCpu = (c) => {
    const cr = c[0], cg = c[1], cb = c[2];
    const mix = (a, b, t) => a * (1 - t) + b * t;
    const step = (e, x) => (x < e ? 0 : 1);
    // p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g))
    //   components:  x    y    z    w
    const t1 = step(cb, cg);
    const px = mix(cb, cg, t1);
    const py = mix(cg, cb, t1);
    const pz = mix(-1, 0, t1);
    const pw = mix(2 / 3, -1 / 3, t1);
    // q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r))
    const t2 = step(px, cr);
    const qx = mix(px, cr, t2);
    const qy = py;
    const qz = mix(pw, pz, t2);
    const qw = mix(cr, px, t2);
    const d = qx - Math.min(qw, qy);
    const e = 1e-10;
    return [
        Math.abs(qz + (qw - qy) / (6 * d + e)),
        d / (qx + e),
        qx,
    ];
};

const spHsv2rgbCpu = (c) => {
    const h = c[0], s = c[1], v = c[2];
    const p = [h + 1, h + 2 / 3, h + 1 / 3].map((u) => {
        const f = u - Math.floor(u);
        return Math.abs(f * 6 - 3);
    });
    return [0, 1, 2].map((i) => {
        const t = Math.max(0, Math.min(1, p[i] - 1));
        const mixed = (1 - s) + s * t;
        return v * mixed;
    });
};

const spGradeSectorsCpu = (rgb, grade) => {
    let hsv = spRgb2hsvCpu([Math.max(0, Math.min(1, rgb[0])), Math.max(0, Math.min(1, rgb[1])), Math.max(0, Math.min(1, rgb[2]))]);
    const fsec = hsv[0] * 8;
    const sectors = grade.sectors || [];
    let adj = [sectors[0]?.h ?? 0, sectors[0]?.s ?? 0, sectors[0]?.l ?? 0];
    for (let k = 1; k < 8; k++) {
        if (fsec >= k) adj = [sectors[k]?.h ?? 0, sectors[k]?.s ?? 0, sectors[k]?.l ?? 0];
    }
    hsv[0] = (hsv[0] + adj[0]) - Math.floor(hsv[0] + adj[0]);
    hsv[1] = Math.max(0, Math.min(1, hsv[1] * (1 + adj[1])));
    hsv[2] = Math.max(0, Math.min(1, hsv[2] + adj[2]));
    return spHsv2rgbCpu(hsv);
};

const clamp01Cpu = (v) => Math.max(0, Math.min(1, v));
const clampArray01Cpu = (arr) => arr.map(clamp01Cpu);
const cpuUch = (x) => {
    const A = 0.15;
    const B = 0.5;
    const C = 0.1;
    const D = 0.2;
    const E = 0.02;
    const F = 0.3;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
};
const cpuNeutralToneMapRgb = (rgb) => {
    const startCompression = 0.8 - 0.04;
    const desaturation = 0.15;
    const out = [rgb[0], rgb[1], rgb[2]];
    const x = Math.min(out[0], out[1], out[2]);
    const offset = x < 0.08 ? (x - 6.25 * x * x) : 0.04;
    out[0] -= offset;
    out[1] -= offset;
    out[2] -= offset;
    const peak = Math.max(out[0], out[1], out[2]);
    if (peak < startCompression) return clampArray01Cpu(out);
    const d = 1 - startCompression;
    const newPeak = 1 - d * d / (peak + d - startCompression);
    const scale = newPeak / Math.max(peak, 1e-6);
    out[0] *= scale;
    out[1] *= scale;
    out[2] *= scale;
    const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
    out[0] = out[0] + (newPeak - out[0]) * g;
    out[1] = out[1] + (newPeak - out[1]) * g;
    out[2] = out[2] + (newPeak - out[2]) * g;
    return clampArray01Cpu(out);
};
const cpuRrtOdtFit = (x) => {
    const a = x * (x + 0.0245786) - 0.000090537;
    const b = x * (0.983729 * x + 0.4329510) + 0.238081;
    return a / Math.max(b, 1e-6);
};
const cpuAces2ToneMapRgb = (rgb) => {
    const inMat = [
        [0.59719, 0.07600, 0.02840],
        [0.35458, 0.90834, 0.13383],
        [0.04823, 0.01566, 0.83777],
    ];
    const outMat = [
        [1.60475, -0.10208, -0.00327],
        [-0.53108, 1.10813, -0.07276],
        [-0.07367, -0.00605, 1.07602],
    ];
    const mulM3 = (m, v) => ([
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]);
    let v = mulM3(inMat, rgb);
    v = [cpuRrtOdtFit(v[0]), cpuRrtOdtFit(v[1]), cpuRrtOdtFit(v[2])];
    v = mulM3(outMat, v);
    return clampArray01Cpu(v);
};
const cpuHejlToneMapRgb = (rgb) => clampArray01Cpu(rgb.map((x) => {
    const c = Math.max(0, x - 0.004);
    return (c * (6.2 * c + 0.5)) / (c * (6.2 * c + 1.7) + 0.06);
}));
/** Mirrors work-buffer `sp_tone_map` (applied after exposure, before levels). */
const cpuToneMapRgb = (rgb, mode) => {
    const m = Math.max(0, Math.min(5, Math.floor(Number(mode) || 0)));
    if (m <= 0) return rgb.map(clamp01Cpu);
    if (m === 1) return cpuNeutralToneMapRgb(rgb);
    if (m === 2) {
        return rgb.map((x) =>
            clamp01Cpu(((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))),
        );
    }
    if (m === 3) return cpuAces2ToneMapRgb(rgb);
    const w = cpuUch(11.2);
    if (m === 4) return rgb.map((x) => clamp01Cpu(cpuUch(x) / w));
    return cpuHejlToneMapRgb(rgb);
};

const cpuSpColorGrade = (col, grade) => {
    const g = grade || createDefaultColorGrade();
    if (g.enabled === false) return [col[0], col[1], col[2]];
    const Lsplit = Math.max(0, Math.min(1, 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]));
    const ba = [
        Math.max(-4, Math.min(4, Number(g.exposure) || 0)),
        Math.max(0.1, Math.min(3, Number(g.contrast) || 1)),
        Math.max(0, Math.min(0.95, Number(g.blackPoint) || 0)),
        Math.max(0.05, Math.min(1, Number(g.whitePoint) || 1)),
    ];
    const bb = [
        Math.max(0, Math.min(2, Number(g.saturation) ?? 1)),
        Math.max(-1, Math.min(1, Number(g.temperature) || 0)),
        Math.max(-1, Math.min(1, Number(g.tint) || 0)),
    ];
    const cross = [0.2, 0.45, 0.55, 0.8];
    const whSh = wheelRgbOffset(g.wheelShadowHex, g.wheelShadowAmt);
    const whMd = wheelRgbOffset(g.wheelMidHex, g.wheelMidAmt);
    const whHi = wheelRgbOffset(g.wheelHighHex, g.wheelHighAmt);

    let rgb = [col[0] * 2 ** ba[0], col[1] * 2 ** ba[0], col[2] * 2 ** ba[0]];
    rgb = cpuToneMapRgb(rgb, g.toneMode ?? 0);
    if (g.lutRgb?.length && g.lutSize) {
        const lutP = {
            size: g.lutSize,
            rgb: g.lutRgb,
            domainMin: g.lutDomainMin || [0, 0, 0],
            domainMax: g.lutDomainMax || [1, 1, 1],
        };
        const lm = Math.max(0, Math.min(1, Number(g.lutMix) ?? 1));
        if (lm > 1e-6) {
            const lut = sampleCubeTrilinear(rgb, lutP);
            rgb = [rgb[0] + (lut[0] - rgb[0]) * lm, rgb[1] + (lut[1] - rgb[1]) * lm, rgb[2] + (lut[2] - rgb[2]) * lm];
        }
    }
    const bp = ba[2];
    const wp = Math.max(ba[3], bp + 1e-4);
    rgb = rgb.map((x) => (x - bp) / Math.max(wp - bp, 1e-4));
    rgb = rgb.map((x) => (x - 0.5) * ba[1] + 0.5);
    rgb = rgb.map((x) => Math.max(0, Math.min(1, x)));
    rgb = spGradeSectorsCpu(rgb, g);
    const lu = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const sat = Math.max(0, Math.min(4, bb[0]));
    rgb = rgb.map((c) => lu + (c - lu) * sat);
    rgb[0] += bb[1] * 0.14;
    rgb[2] -= bb[1] * 0.14;
    rgb[0] += bb[2] * 0.10;
    rgb[1] -= bb[2] * 0.10;
    const sw = 1 - smoothstepJS(cross[0], cross[1], Lsplit);
    const mw = smoothstepJS(cross[0], cross[1], Lsplit) * (1 - smoothstepJS(cross[2], cross[3], Lsplit));
    const hw = smoothstepJS(cross[2], cross[3], Lsplit);
    rgb[0] += whSh[0] * sw + whMd[0] * mw + whHi[0] * hw;
    rgb[1] += whSh[1] * sw + whMd[1] * mw + whHi[1] * hw;
    rgb[2] += whSh[2] * sw + whMd[2] * mw + whHi[2] * hw;
    return rgb.map((x) => Math.max(0, Math.min(1, x)));
};

const rgbFromShDc = (f0, f1, f2) => [
    Math.max(0, Math.min(1, 0.5 + f0 * SH_C0)),
    Math.max(0, Math.min(1, 0.5 + f1 * SH_C0)),
    Math.max(0, Math.min(1, 0.5 + f2 * SH_C0)),
];

const shDcFromRgb = (r, g, b) => [
    (Math.max(0, Math.min(1, r)) - 0.5) / SH_C0,
    (Math.max(0, Math.min(1, g)) - 0.5) / SH_C0,
    (Math.max(0, Math.min(1, b)) - 0.5) / SH_C0,
];

/** In-place f_dc triplets [i..i+count) with `grade`. */
/** True when grade matches defaults (export can skip CPU round-trip / HSV). */
const colorGradeIsIdentity = (grade) => {
    const gd = grade || createDefaultColorGrade();
    if (gd.enabled === false) return true;
    if ((Number(gd.toneMode) || 0) !== 0) return false;
    if (gd.lutRgb?.length && gd.lutSize) return false;
    if (Math.abs(Number(gd.exposure) || 0) > 1e-5) return false;
    if (Math.abs(Number(gd.contrast) - 1) > 1e-5) return false;
    if (Math.abs(Number(gd.blackPoint) || 0) > 1e-5) return false;
    if (Math.abs(Number(gd.whitePoint) - 1) > 1e-5) return false;
    if (Math.abs(Number(gd.saturation) - 1) > 1e-5) return false;
    if (Math.abs(Number(gd.temperature) || 0) > 1e-5) return false;
    if (Math.abs(Number(gd.tint) || 0) > 1e-5) return false;
    if ((Number(gd.wheelShadowAmt) || 0) > 1e-5 || (Number(gd.wheelMidAmt) || 0) > 1e-5 || (Number(gd.wheelHighAmt) || 0) > 1e-5) return false;
    const secs = gd.sectors || [];
    for (let i = 0; i < 8; i++) {
        const s = secs[i] || {};
        if (Math.abs(Number(s.h) || 0) > 1e-5) return false;
        if (Math.abs(Number(s.s) || 0) > 1e-5) return false;
        if (Math.abs(Number(s.l) || 0) > 1e-5) return false;
    }
    return true;
};

const destroyGradeLutGpu = (grade) => {
    grade?.lutTexture?.destroy?.();
    if (grade) {
        grade.lutTexture = null;
        grade._lutTexSource = null;
    }
};

const ensureGradeLutGpuTexture = (grade) => {
    if (!grade?.lutRgb?.length || !grade.lutSize) {
        destroyGradeLutGpu(grade);
        return;
    }
    if (grade.lutTexture && grade._lutTexSource === grade.lutRgb) return;
    const parsed = {
        size: grade.lutSize,
        rgb: grade.lutRgb,
        domainMin: grade.lutDomainMin || [0, 0, 0],
        domainMax: grade.lutDomainMax || [1, 1, 1],
    };
    const rgba = lutFloatRgbToRgba8(parsed);
    const N = grade.lutSize;
    destroyGradeLutGpu(grade);
    const tex = new pc.Texture(app.graphicsDevice, {
        width: N * N,
        height: N,
        format: pc.PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: pc.FILTER_LINEAR,
        magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        name: 'color-grade-lut',
    });
    const d = tex.lock();
    if (d && rgba.length <= d.length) {
        d.set(rgba);
    }
    tex.unlock();
    grade.lutTexture = tex;
    grade._lutTexSource = grade.lutRgb;
};

const applyGradeToFdcTriplets = (f0, f1, f2, i0, count, grade) => {
    if (colorGradeIsIdentity(grade)) return;
    for (let i = i0; i < i0 + count; i++) {
        const rgb = rgbFromShDc(f0[i], f1[i], f2[i]);
        const gRgb = cpuSpColorGrade(rgb, grade);
        const dc = shDcFromRgb(gRgb[0], gRgb[1], gRgb[2]);
        f0[i] = dc[0];
        f1[i] = dc[1];
        f2[i] = dc[2];
    }
};

const clampLayerOpacityPct = (v) => {
    let n;
    if (typeof v === 'string') {
        n = parseNumericOrExpr(v.trim());
        if (n == null) n = Number(v);
    } else {
        n = Number(v);
    }
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, Math.round(n)));
};
const opacityPctToUniform = (pct) => clampLayerOpacityPct(pct) / 100;
/** Multiply Gaussian-splat alpha (stored as logit) by a 0..1 display factor, matching uLayerOpacity in the shader. */
const applyDisplayOpacityMultToLogit = (logit, mult) => {
    const m = Math.max(0, Math.min(1, mult));
    if (m >= 1 - 1e-8) return logit;
    if (m <= 1e-8) return invSigmoid(1e-7);
    const a = sigmoid(logit);
    const aNew = Math.min(1 - 1e-7, Math.max(1e-7, a * m));
    return invSigmoid(aNew);
};
const ensureLayerOpacityPct = (layer) => {
    if (!layer) return;
    if (layer.opacityPct == null || !Number.isFinite(Number(layer.opacityPct))) layer.opacityPct = 100;
    else layer.opacityPct = clampLayerOpacityPct(layer.opacityPct);
};
const pushLayerOpacityToGsplat = (gsplat, pct) => {
    if (!gsplat?.setParameter) return;
    gsplat.setParameter('uLayerOpacity', opacityPctToUniform(pct));
};

const clampRenderBoxNumber = (v, def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(-100000, Math.min(100000, n));
};
const clampRenderBoxSize = (v, def = 2) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(0.01, Math.min(100000, n));
};
const getRenderBoxHalfVec = (rb) => {
    const b = rb || createDefaultRenderBox();
    return [
        clampRenderBoxSize(b.size?.x, 2) * 0.5,
        clampRenderBoxSize(b.size?.y, 2) * 0.5,
        clampRenderBoxSize(b.size?.z, 2) * 0.5,
    ];
};

/** Work-buffer `modifySplatColor` gets world-space centers; inverse maps to splat/model space for box + hover. */
const _scratchWorldToModelForModifier = new pc.Mat4();
const pushWorldToModelUniform = (gsplat) => {
    if (!gsplat?.setParameter) return;
    const ent = gsplat.entity;
    if (!ent) return;
    _scratchWorldToModelForModifier.copy(ent.getWorldTransform()).invert();
    gsplat.setParameter('uWorldToModel', _scratchWorldToModelForModifier.data);
};
const pushAllWorldToModelUniforms = () => {
    for (const p of paintables) {
        pushWorldToModelUniform(p.gsplatComponent);
    }
    for (const layer of layers) {
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent?.gsplat) pushWorldToModelUniform(ent.gsplat);
    }
};

const applyRenderBoxToGsplat = (gsplat, rb) => {
    if (!gsplat?.setParameter) return;
    const box = rb || createDefaultRenderBox();
    gsplat.setParameter('uRenderBoxEnabled', box.enabled ? 1 : 0);
    gsplat.setParameter('uRenderBoxCenter', [
        clampRenderBoxNumber(box.center?.x, 0),
        clampRenderBoxNumber(box.center?.y, 0),
        clampRenderBoxNumber(box.center?.z, 0),
    ]);
    gsplat.setParameter('uRenderBoxHalf', getRenderBoxHalfVec(box));
};

const applyColorGradeToGsplat = (gsplat, grade) => {
    if (!gsplat?.setParameter) return;
    const gd = grade || createDefaultColorGrade();
    ensureGradeLutGpuTexture(gd);
    const lutOn = !!(gd.lutRgb?.length && gd.lutSize && gd.lutTexture);
    const Nlut = lutOn ? gd.lutSize : 2;
    const lo = gd.lutDomainMin || [0, 0, 0];
    const hi = gd.lutDomainMax || [1, 1, 1];
    const inv = [
        1 / Math.max(1e-8, hi[0] - lo[0]),
        1 / Math.max(1e-8, hi[1] - lo[1]),
        1 / Math.max(1e-8, hi[2] - lo[2]),
    ];
    gsplat.setParameter('uGradeToneMode', Math.max(0, Math.min(5, Number(gd.toneMode) || 0)));
    gsplat.setParameter('uGradeLutMeta', [
        lutOn ? 1 : 0,
        Nlut,
        Math.max(0, Math.min(1, Number(gd.lutMix) ?? 1)),
        0,
    ]);
    gsplat.setParameter('uGradeLutDomainMin', [lo[0], lo[1], lo[2]]);
    gsplat.setParameter('uGradeLutDomainInv', inv);
    gsplat.setParameter('uGradeLutTex', lutOn ? gd.lutTexture : getDummyGradeLutTex());
    gsplat.setParameter('uGradeBasicA', [
        Math.max(-4, Math.min(4, Number(gd.exposure) || 0)),
        Math.max(0.1, Math.min(3, Number(gd.contrast) || 1)),
        Math.max(0, Math.min(0.95, Number(gd.blackPoint) || 0)),
        Math.max(0.05, Math.min(1, Number(gd.whitePoint) || 1)),
    ]);
    gsplat.setParameter('uGradeBasicB', [
        Math.max(0, Math.min(2, Number(gd.saturation) ?? 1)),
        Math.max(-1, Math.min(1, Number(gd.temperature) || 0)),
        Math.max(-1, Math.min(1, Number(gd.tint) || 0)),
        1,
    ]);
    gsplat.setParameter('uGradeWheelSh', wheelRgbOffset(gd.wheelShadowHex, gd.wheelShadowAmt));
    gsplat.setParameter('uGradeWheelMd', wheelRgbOffset(gd.wheelMidHex, gd.wheelMidAmt));
    gsplat.setParameter('uGradeWheelHi', wheelRgbOffset(gd.wheelHighHex, gd.wheelHighAmt));
    gsplat.setParameter('uGradeCross', [0.2, 0.45, 0.55, 0.8]);
    gsplat.setParameter('uGradeEnabled', (gd.enabled === false || colorGradeIsIdentity(gd)) ? 0 : 1);
    for (let i = 0; i < 8; i++) {
        const s = gd.sectors[i] || { h: 0, s: 0, l: 0 };
        gsplat.setParameter(`uGradeSec${i}`, [
            Math.max(-0.25, Math.min(0.25, Number(s.h) || 0)),
            Math.max(-0.9, Math.min(3, Number(s.s) || 0)),
            Math.max(-0.5, Math.min(0.5, Number(s.l) || 0)),
        ]);
    }
    gsplat.setParameter('uGradeSelectedOnly', g('cg-grade-selected-only')?.checked ? 1 : 0);
    gsplat.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
};

const pushAllColorGradesToGPU = () => {
    for (const p of paintables) {
        applyColorGradeToGsplat(p.gsplatComponent, baseColorGrade);
        pushLayerOpacityToGsplat(p.gsplatComponent, baseLayerOpacityPct);
    }
    for (const layer of layers) {
        ensureLayerColorGrade(layer);
        ensureLayerOpacityPct(layer);
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent?.gsplat) {
            applyColorGradeToGsplat(ent.gsplat, layer.colorGrade);
            pushLayerOpacityToGsplat(ent.gsplat, layer.opacityPct);
        }
    }
};

let _syncingColorGradeUI = false;

const getActiveColorGradeBundle = () => {
    if (selectedLayerId === 'base' || !selectedLayerId) {
        return {
            grade: baseColorGrade,
            gsplat: paintables[0]?.gsplatComponent ?? null,
            label: 'Base model',
        };
    }
    const layer = layers.find((l) => l.id === selectedLayerId);
    if (!layer) {
        return {
            grade: baseColorGrade,
            gsplat: paintables[0]?.gsplatComponent ?? null,
            label: 'Base model',
        };
    }
    ensureLayerColorGrade(layer);
    const ent = layersContainer.findByName(`layer-${layer.id}`);
    return { grade: layer.colorGrade, gsplat: ent?.gsplat ?? null, label: layer.name };
};

const applyColorGradeBundleToGpu = (grade, bundleGsplat) => {
    if (selectedLayerId === 'base' || !selectedLayerId) {
        for (const p of paintables) applyColorGradeToGsplat(p.gsplatComponent, grade);
    } else if (bundleGsplat) {
        applyColorGradeToGsplat(bundleGsplat, grade);
    }
};

const readColorGradeFromUIInto = (grade) => {
    const rf = (rangeId, def) => {
        const v = parseFloat(g(rangeId)?.value);
        return Number.isFinite(v) ? v : def;
    };
    grade.exposure = rf('cg-exposure', 0);
    grade.contrast = rf('cg-contrast', 1);
    grade.blackPoint = rf('cg-black', 0);
    grade.whitePoint = rf('cg-white', 1);
    if (grade.blackPoint >= grade.whitePoint) {
        grade.whitePoint = Math.min(1, grade.blackPoint + 0.05);
    }
    grade.saturation = rf('cg-sat', 1);
    grade.temperature = rf('cg-temp', 0);
    grade.tint = rf('cg-tint', 0);
    grade.wheelShadowHex = g('cg-wheel-sh')?.value ?? '#808080';
    grade.wheelShadowAmt = rf('cg-wheel-sh-amt', 0);
    grade.wheelMidHex = g('cg-wheel-md')?.value ?? '#808080';
    grade.wheelMidAmt = rf('cg-wheel-md-amt', 0);
    grade.wheelHighHex = g('cg-wheel-hi')?.value ?? '#808080';
    grade.wheelHighAmt = rf('cg-wheel-hi-amt', 0);
    for (let i = 0; i < 8; i++) {
        if (!grade.sectors[i]) grade.sectors[i] = { h: 0, s: 0, l: 0 };
        grade.sectors[i].h = rf(`cg-s${i}-h`, 0);
        grade.sectors[i].s = rf(`cg-s${i}-s`, 0);
        grade.sectors[i].l = rf(`cg-s${i}-l`, 0);
    }
    const toneEl = g('cg-tone-mode');
    grade.toneMode = toneEl ? Math.max(0, Math.min(5, parseInt(toneEl.value, 10) || 0)) : 0;
    grade.lutMix = rf('cg-lut-mix', 1);
};

const commitActiveColorGradeFromUI = () => {
    if (_syncingColorGradeUI) return;
    const { grade, gsplat } = getActiveColorGradeBundle();
    readColorGradeFromUIInto(grade);
    applyColorGradeBundleToGpu(grade, gsplat);
};

const updateCgVisibilityButton = (enabled) => {
    const btn = g('cg-toggle-visibility-btn');
    if (!btn) return;
    const on = enabled !== false;
    btn.title = on ? 'Hide color grade edits for the active layer' : 'Show color grade edits for the active layer';
    btn.setAttribute('aria-label', on ? 'Hide color grade edits' : 'Show color grade edits');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('accent', !on);
    btn.innerHTML = tablerIconHtmlSync(on ? 'eye' : 'eye-off', { size: 14 });
};

const refreshColorGradeUIFromSelection = () => {
    _syncingColorGradeUI = true;
    try {
        const { grade } = getActiveColorGradeBundle();
        const setR = (id, v) => {
            const el = g(id);
            if (el) el.value = String(v);
        };
        setR('cg-exposure', grade.exposure);
        setR('cg-exposure-num', grade.exposure);
        setR('cg-contrast', grade.contrast);
        setR('cg-contrast-num', grade.contrast);
        setR('cg-black', grade.blackPoint);
        setR('cg-black-num', grade.blackPoint);
        setR('cg-white', grade.whitePoint);
        setR('cg-white-num', grade.whitePoint);
        setR('cg-sat', grade.saturation);
        setR('cg-sat-num', grade.saturation);
        setR('cg-temp', grade.temperature);
        setR('cg-temp-num', grade.temperature);
        setR('cg-tint', grade.tint);
        setR('cg-tint-num', grade.tint);
        if (g('cg-wheel-sh')) g('cg-wheel-sh').value = grade.wheelShadowHex ?? '#808080';
        setR('cg-wheel-sh-amt', grade.wheelShadowAmt ?? 0);
        setR('cg-wheel-sh-amt-num', grade.wheelShadowAmt ?? 0);
        if (g('cg-wheel-md')) g('cg-wheel-md').value = grade.wheelMidHex ?? '#808080';
        setR('cg-wheel-md-amt', grade.wheelMidAmt ?? 0);
        setR('cg-wheel-md-amt-num', grade.wheelMidAmt ?? 0);
        if (g('cg-wheel-hi')) g('cg-wheel-hi').value = grade.wheelHighHex ?? '#808080';
        setR('cg-wheel-hi-amt', grade.wheelHighAmt ?? 0);
        setR('cg-wheel-hi-amt-num', grade.wheelHighAmt ?? 0);
        syncSplitToneEditorsFromColorInputs();
        for (let i = 0; i < 8; i++) {
            const s = grade.sectors[i] || { h: 0, s: 0, l: 0 };
            setR(`cg-s${i}-h`, s.h);
            setR(`cg-s${i}-s`, s.s);
            setR(`cg-s${i}-l`, s.l);
        }
        const tm = g('cg-tone-mode');
        if (tm) tm.value = String(Math.max(0, Math.min(5, Number(grade.toneMode) || 0)));
        setR('cg-lut-mix', grade.lutMix ?? 1);
        setR('cg-lut-mix-num', grade.lutMix ?? 1);
        const lutLab = g('cg-lut-name');
        if (lutLab) lutLab.textContent = grade.lutName || '—';
        updateCgVisibilityButton(grade.enabled !== false);
    } finally {
        _syncingColorGradeUI = false;
        refreshCgGradeSliderTracks();
    }
};

const resetActiveColorGrade = () => {
    const { grade, gsplat } = getActiveColorGradeBundle();
    destroyGradeLutGpu(grade);
    const fresh = createDefaultColorGrade();
    for (const k of Object.keys(fresh)) {
        if (k === 'sectors') grade.sectors = fresh.sectors.map((x) => ({ ...x }));
        else grade[k] = fresh[k];
    }
    refreshColorGradeUIFromSelection();
    applyColorGradeBundleToGpu(grade, gsplat);
};

/** Bake current color grade (and optional GPU paint for base) into SH DC, reset grade UI. */
const bakeColorGradeIntoActiveTarget = async () => {
    commitActiveColorGradeFromUI();
    const gradeOnlySel = !!g('cg-grade-selected-only')?.checked;

    const activeLayer = getActiveLayer();
    if (activeLayer) {
        ensureLayerColorGrade(activeLayer);
        const gSnap = cloneColorGrade(activeLayer.colorGrade);
        const ent = layersContainer.findByName(`layer-${activeLayer.id}`);
        const baked = ent?.gsplat ? await getLayerPaintFromGpu(activeLayer, ent.gsplat) : null;
        const mask = activeLayer.selectionMask;
        for (let i = 0; i < activeLayer.splats.length; i++) {
            if (gradeOnlySel && mask && !mask[i]) continue;
            const s = activeLayer.splats[i];
            const f0 = baked ? baked.out0[i] : (s.f_dc_0 ?? 0);
            const f1 = baked ? baked.out1[i] : (s.f_dc_1 ?? 0);
            const f2 = baked ? baked.out2[i] : (s.f_dc_2 ?? 0);
            const rgb = rgbFromShDc(f0, f1, f2);
            const outRgb = cpuSpColorGrade(rgb, gSnap);
            const dc = shDcFromRgb(outRgb[0], outRgb[1], outRgb[2]);
            s.f_dc_0 = dc[0]; s.f_dc_1 = dc[1]; s.f_dc_2 = dc[2];
            if (baked?.outOp) s.opacity = baked.outOp[i];
        }
        destroyGradeLutGpu(activeLayer.colorGrade);
        activeLayer.colorGrade = createDefaultColorGrade();
        await updateLayerEntity(activeLayer);
        refreshColorGradeUIFromSelection();
        pushAllColorGradesToGPU();
        getPosthog()?.capture('color_grade_baked', { target: 'layer', splat_count: activeLayer.splats.length });
        return;
    }

    if (!gsplatDataCache || !paintables.length) {
        alert('Nothing to bake.');
        return;
    }
    const gSnap = cloneColorGrade(baseColorGrade);
    const painted = await getPaintFromGpu() ?? applyAllCpuStrokes();
    if (!painted) {
        alert('Could not read colors for bake.');
        return;
    }
    const n = gsplatDataCache.numSplats;
    const o0 = new Float32Array(painted.out0);
    const o1 = new Float32Array(painted.out1);
    const o2 = new Float32Array(painted.out2);
    const oOp = new Float32Array(painted.outOp);
    const mask = selectionMask;
    for (let i = 0; i < n; i++) {
        if (gradeOnlySel && mask && !mask[i]) continue;
        const rgb = rgbFromShDc(o0[i], o1[i], o2[i]);
        const outRgb = cpuSpColorGrade(rgb, gSnap);
        const dc = shDcFromRgb(outRgb[0], outRgb[1], outRgb[2]);
        o0[i] = dc[0]; o1[i] = dc[1]; o2[i] = dc[2];
    }
    ensureBaseGsplatShRestHydratedFromDeferred();
    const { x: xA, y: yA, z: zA, shRest, extra } = gsplatDataCache;
    const columns = [];
    const addCol = (name, data) => { if (data) columns.push(new Column(name, data)); };
    addCol('x', xA); addCol('y', yA); addCol('z', zA);
    addCol('nx', extra.nx); addCol('ny', extra.ny); addCol('nz', extra.nz);
    addCol('f_dc_0', o0); addCol('f_dc_1', o1); addCol('f_dc_2', o2);
    for (const sh of shRest) addCol(sh.key, sh.data);
    addCol('opacity', oOp);
    addCol('scale_0', extra.scale_0); addCol('scale_1', extra.scale_1); addCol('scale_2', extra.scale_2);
    addCol('rot_0', extra.rot_0); addCol('rot_1', extra.rot_1); addCol('rot_2', extra.rot_2); addCol('rot_3', extra.rot_3);

    const table = new DataTable(columns);
    const memFs = new MemoryFileSystem();
    const filename = 'painted.ply';
    await writePly(
        { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
        memFs,
    );
    const buffer = memFs.results?.get(filename);
    if (!buffer) { alert('Bake failed.'); return; }
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const file = new File([blob], filename, { type: 'application/octet-stream' });
    strokes.length = 0;
    redoStack.length = 0;
    activeStroke = null;
    updateUndoRedoUI();
    destroyGradeLutGpu(baseColorGrade);
    baseColorGrade = createDefaultColorGrade();
    await loadSplat(file, { preserveCamera: true, skipAuthGate: true });
    refreshColorGradeUIFromSelection();
    pushAllColorGradesToGPU();
    getPosthog()?.capture('color_grade_baked', { target: 'base', splat_count: gsplatDataCache?.numSplats ?? 0 });
};

const strokeTouchesLayerId = (stroke, layerId) =>
    (stroke.ops || []).some((o) => o.layerId === layerId)
    || (stroke.cpuOps || []).some((o) => o.layerId === layerId);

const strokeTouchesBaseModel = (stroke) =>
    (stroke.ops || []).some((o) => !o.layerId)
    || (stroke.cpuOps || []).some((o) => !o.layerId);

/** Bake brush/bucket/erase GPU paint into splat SH + opacity; clear textures & undo for this target. Color grade is left as-is. */
const bakeBrushPaintIntoModel = async () => {
    const activeLayer = getActiveLayer();
    if (activeLayer) {
        const ent = layersContainer.findByName(`layer-${activeLayer.id}`);
        const baked = ent?.gsplat ? await getLayerPaintFromGpu(activeLayer, ent.gsplat) : null;
        if (!baked) {
            alert('Could not read paint on this layer.');
            return;
        }
        for (let i = 0; i < activeLayer.splats.length; i++) {
            const s = activeLayer.splats[i];
            s.f_dc_0 = baked.out0[i];
            s.f_dc_1 = baked.out1[i];
            s.f_dc_2 = baked.out2[i];
            s.opacity = baked.outOp[i];
        }
        for (let i = strokes.length - 1; i >= 0; i--) {
            if (strokeTouchesLayerId(strokes[i], activeLayer.id)) strokes.splice(i, 1);
        }
        redoStack.length = 0;
        activeStroke = null;
        updateUndoRedoUI();
        await updateLayerEntity(activeLayer);
        getPosthog()?.capture('paint_baked', { target: 'layer', splat_count: activeLayer.splats.length });
        return;
    }

    if (!gsplatDataCache || !paintables.length) {
        alert('Nothing to bake.');
        return;
    }
    const painted = await getPaintFromGpu() ?? applyAllCpuStrokes();
    if (!painted) {
        alert('Could not read paint for bake.');
        return;
    }
    const n = gsplatDataCache.numSplats;
    const o0 = new Float32Array(painted.out0);
    const o1 = new Float32Array(painted.out1);
    const o2 = new Float32Array(painted.out2);
    const oOp = new Float32Array(painted.outOp);
    ensureBaseGsplatShRestHydratedFromDeferred();
    const { x: xA, y: yA, z: zA, shRest, extra } = gsplatDataCache;
    const columns = [];
    const addCol = (name, data) => { if (data) columns.push(new Column(name, data)); };
    addCol('x', xA); addCol('y', yA); addCol('z', zA);
    addCol('nx', extra.nx); addCol('ny', extra.ny); addCol('nz', extra.nz);
    addCol('f_dc_0', o0); addCol('f_dc_1', o1); addCol('f_dc_2', o2);
    for (const sh of shRest) addCol(sh.key, sh.data);
    addCol('opacity', oOp);
    addCol('scale_0', extra.scale_0); addCol('scale_1', extra.scale_1); addCol('scale_2', extra.scale_2);
    addCol('rot_0', extra.rot_0); addCol('rot_1', extra.rot_1); addCol('rot_2', extra.rot_2); addCol('rot_3', extra.rot_3);

    const table = new DataTable(columns);
    const memFs = new MemoryFileSystem();
    const filename = 'painted.ply';
    await writePly(
        { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
        memFs,
    );
    const buffer = memFs.results?.get(filename);
    if (!buffer) { alert('Bake failed.'); return; }
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const file = new File([blob], filename, { type: 'application/octet-stream' });
    for (let i = strokes.length - 1; i >= 0; i--) {
        if (strokeTouchesBaseModel(strokes[i])) strokes.splice(i, 1);
    }
    redoStack.length = 0;
    activeStroke = null;
    updateUndoRedoUI();
    getPosthog()?.capture('paint_baked', { target: 'base', splat_count: gsplatDataCache?.numSplats ?? 0 });
    await loadSplat(file, { preserveCamera: true, skipAuthGate: true });
    pushAllColorGradesToGPU();
};

const selectionHighlightColor = () => {
    const hex = g('selection-highlight-color')?.value ?? '#2670e8';
    const intensity = parseFloat(g('selection-highlight-intensity')?.value ?? g('selection-highlight-intensity-num')?.value ?? '0.45');
    const [r, grn, b] = hexToRgb(hex);
    return [r, grn, b, Math.max(0.1, Math.min(1, intensity))];
};
const getComputedPaintColor = () => hexToRgb(paintColorHex());

// ── Brush cursor ──────────────────────────────────────────────────────────────
// Per-tool hover tint colors [r, g, b, strength]
const HOVER_COLORS = {
    brush:         () => { const c = getComputedPaintColor(); return [c[0], c[1], c[2], 0.35]; },
    eraser:        () => [1.0, 0.35, 0.1, 0.35],
    resetBrush:    () => [0.2, 0.9, 0.4, 0.35],
    brushSelect:   () => [0.3, 0.7, 1.0, 0.35],
    generateSplats:() => { const [r,g,b] = generateSplatsSampledColor; return [r, g, b, 0.35]; },
    splatSelect:   () => [0.3, 0.7, 1.0, 0.35],
};

const clearHoverSphere = () => {
    for (const p of paintables) {
        p.gsplatComponent.setParameter('uHoverSphere', [0, 0, 0, 0]);
    }
    for (const layer of layers) {
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent?.gsplat) ent.gsplat.setParameter('uHoverSphere', [0, 0, 0, 0]);
    }
};

const updateBrushCursorAt = (x, y) => {
    brushCursor.style.left = `${x}px`;
    brushCursor.style.top  = `${y}px`;
    const wr   = activeTool === 'eraser' ? eraserSize()
        : activeTool === 'resetBrush' ? resetSize()
        : activeTool === 'brushSelect' ? brushSelectSize()
        : activeTool === 'generateSplats' ? generateSplatsSize() : brushSize();
    const fov  = (60 * Math.PI) / 180;
    const px   = Math.max(4, (wr / (orbit.distance * Math.tan(fov / 2))) * (canvas.clientHeight / 2));
    const d    = px * 2;
    brushCursor.style.width  = `${d}px`;
    brushCursor.style.height = `${d}px`;

    // Update 3D hover sphere on the model surface (suppress during active strokes)
    const prim = getPrimarySplatEntity();
    if (!prim || isPainting || isGenerateSplatsPainting || isBrushSelecting) return;
    const worldPt = getWorldPoint(x, y);
    if (!worldPt) return;

    const invMat = new pc.Mat4().copy(prim.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);
    const refM = new pc.Vec3();
    invMat.transformPoint(new pc.Vec3(worldPt.x + wr, worldPt.y, worldPt.z), refM);
    const modelRadius = modelPt.distance(refM);

    const colorFn = HOVER_COLORS[activeTool];
    const hoverColor = colorFn ? colorFn() : [1, 1, 1, 0.3];

    // Apply hover to the base model and to any user layer entities.
    for (const p of paintables) {
        p.gsplatComponent.setParameter('uHoverSphere', [modelPt.x, modelPt.y, modelPt.z, modelRadius]);
        p.gsplatComponent.setParameter('uHoverColor',  hoverColor);
    }
    for (const layer of layers) {
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent?.gsplat) {
            ent.gsplat.setParameter('uHoverSphere', [modelPt.x, modelPt.y, modelPt.z, modelRadius]);
            ent.gsplat.setParameter('uHoverColor',  hoverColor);
        }
    }
};

// ── Processor uniforms ────────────────────────────────────────────────────────
const setUniformsForPaint = (p, sphere, color, hardness, constraint) => {
    p.paintProcessor.setParameter('uPaintSphere',   sphere);
    p.paintProcessor.setParameter('uPaintColor',     color);
    p.paintProcessor.setParameter('uHardness',      hardness);
    p.paintProcessor.setParameter('uSelectionConstraint', constraint);
};

const setUniformsForErase = (p, sphere, color, hardness, eraseDepthHalfModel, eraseViewDirModel, constraint) => {
    p.eraseProcessor.setParameter('uPaintSphere',   sphere);
    p.eraseProcessor.setParameter('uPaintColor',     color);
    p.eraseProcessor.setParameter('uHardness',      hardness);
    p.eraseProcessor.setParameter('uSelectionConstraint', constraint);
    p.eraseProcessor.setParameter('uEraseViewDir',   eraseViewDirModel);
    p.eraseProcessor.setParameter('uEraseDepthHalf', eraseDepthHalfModel);
};

/**
 * View-aligned erase cylinder in model space: half-length along ray and unit axis.
 * depthWorldFull is total world thickness (0 → sphere mode, half-length derived inside).
 */
const computeEraseCylinderInModel = (worldPt, invMat, depthWorldFull) => {
    const z = eraseViewModelScratch;
    let halfModel = 0;
    if (!depthWorldFull || depthWorldFull < 1e-8) {
        z.set(0, 0, 1);
        return { halfModel: 0, viewModel: z };
    }
    const camPos = cameraEntity.getPosition();
    eraseRayWorldScratch.sub2(worldPt, camPos);
    const rayLen = eraseRayWorldScratch.length();
    if (rayLen < 1e-10) {
        z.set(0, 0, 1);
        return { halfModel: 0, viewModel: z };
    }
    eraseRayWorldScratch.mulScalar(1 / rayLen);
    const halfW = depthWorldFull * 0.5;
    eraseWorldEdgeScratch.set(
        worldPt.x + eraseRayWorldScratch.x * halfW,
        worldPt.y + eraseRayWorldScratch.y * halfW,
        worldPt.z + eraseRayWorldScratch.z * halfW,
    );
    invMat.transformPoint(worldPt, eraseModelCenterScratch);
    invMat.transformPoint(eraseWorldEdgeScratch, eraseModelEdgeScratch);
    z.sub2(eraseModelEdgeScratch, eraseModelCenterScratch);
    const ml = z.length();
    if (ml < 1e-10) {
        z.set(0, 0, 1);
        return { halfModel: 0, viewModel: z };
    }
    halfModel = ml;
    z.mulScalar(1 / ml);
    return { halfModel, viewModel: z };
};

const syncDisplayUniforms = (p) => {
    const baseActive = selectedLayerId === 'base' || !selectedLayerId;
    p.gsplatComponent.setParameter('uBlendMode',     blendMode());
    p.gsplatComponent.setParameter('uShowSelection', baseActive && hasSelection && showSelectionHighlight ? 1 : 0);
    p.gsplatComponent.setParameter('uSelectionColor', selectionHighlightColor());
    pushSplatViewShaderUniforms(p.gsplatComponent);
    applyColorGradeToGsplat(p.gsplatComponent, baseColorGrade);
    pushLayerOpacityToGsplat(p.gsplatComponent, baseLayerOpacityPct);
    pushWorldToModelUniform(p.gsplatComponent);
};

const syncSplatViewStyleToolbar = () => {
    const grp = g('splat-view-style-group');
    if (grp) grp.classList.toggle('hidden', !splatMode);
    for (const btn of document.querySelectorAll('.splat-style-btn')) {
        btn.classList.toggle('active', btn.dataset.splatStyle === splatViewStyle);
    }
};

const setSplatViewStyle = (style) => {
    if (style !== 'centers' && style !== 'rings') return;
    splatViewStyle = style;
    syncSplatViewStyleToolbar();
    for (const p of paintables) pushSplatViewShaderUniforms(p.gsplatComponent);
    for (const layer of layers) {
        const entity = layersContainer.findByName(`layer-${layer.id}`);
        if (entity?.gsplat) pushSplatViewShaderUniforms(entity.gsplat);
    }
};

const setSplatMode = (active) => {
    splatMode = active;
    for (const p of paintables) {
        pushSplatViewShaderUniforms(p.gsplatComponent);
    }
    for (const layer of layers) {
        const entity = layersContainer.findByName(`layer-${layer.id}`);
        if (entity?.gsplat) pushSplatViewShaderUniforms(entity.gsplat);
    }
    g('btn-splat-mode')?.classList.toggle('active', active);
    g('btn-splat-mode')?.setAttribute(
        'title',
        active ? 'Splat mode ON (M) — ● cyan center dots · ○ splat-colored ring strokes (SuperSplat-style)' : 'Splat mode (M) — SuperSplat-style centers / rings',
    );
    syncSplatViewStyleToolbar();
};

// ── Model transform (global) + per-layer local TRS on each splat entity ───────
// Global euler (degrees) on baseContainer + layersContainer (no UI; matches former defaults X=0,Y=0,Z=180).
let globalModelRotation = { x: 0, y: 0, z: 180 };

const applyBaseEntityTransform = () => {
    if (!paintables.length) return;
    const t = baseTransform;
    for (const pb of paintables) {
        const e = pb.entity;
        e.setLocalPosition(t.position.x, t.position.y, t.position.z);
        e.setLocalEulerAngles(t.rotation.x, t.rotation.y, t.rotation.z);
        e.setLocalScale(t.scale.x, t.scale.y, t.scale.z);
    }
};

const applySingleLayerEntityTransform = (layer) => {
    const ent = layersContainer.findByName(`layer-${layer.id}`);
    if (!ent) return;
    ensureUserLayerTransform(layer);
    ent.setLocalPosition(layer.position.x, layer.position.y, layer.position.z);
    ent.setLocalEulerAngles(layer.rotation.x, layer.rotation.y, layer.rotation.z);
    ent.setLocalScale(layer.scale.x, layer.scale.y, layer.scale.z);
};

const applyAllLayerEntityTransforms = () => {
    applyBaseEntityTransform();
    for (const layer of layers) applySingleLayerEntityTransform(layer);
    refreshActiveRenderBoxPreview();
};

const applyModelRotation = () => {
    const { x: rx, y: ry, z: rz } = globalModelRotation;
    baseContainer.setLocalEulerAngles(rx, ry, rz);
    layersContainer.setLocalEulerAngles(rx, ry, rz);
    applyAllLayerEntityTransforms();
};

const snapshotCameraResetFromFramedView = () => {
    cameraResetState.target.copy(orbit.target);
    cameraResetState.distance = orbit.distance;
    cameraResetState.yaw = orbit.yaw;
    cameraResetState.pitch = orbit.pitch;
    flyCamResetState.pos.copy(cameraEntity.getPosition());
    flyCamResetState.yaw = orbit.yaw;
    flyCamResetState.pitch = orbit.pitch;
};

const resetCamera = () => {
    if (cameraNavMode === 'orbit') {
        orbit.target.copy(cameraResetState.target);
        orbit.distance = cameraResetState.distance;
        orbit.yaw = cameraResetState.yaw;
        orbit.pitch = cameraResetState.pitch;
    } else {
        flyCam.pos.copy(flyCamResetState.pos);
        flyCam.yaw = flyCamResetState.yaw;
        flyCam.pitch = flyCamResetState.pitch;
    }
    updateCamera();
};

const resetModelRotation = () => {
    globalModelRotation = { x: 0, y: 0, z: 180 };
    applyModelRotation();
};

// ── Layer helpers ────────────────────────────────────────────────────────────
const getUniqueLayerName = () => {
    const used = new Set(layers.map((l) => l.name));
    let n = 1;
    while (used.has(`Layer ${n}`)) n++;
    return `Layer ${n}`;
};

const addLayer = () => {
    const layer = {
        id: `layer-${layerIdCounter++}`,
        name: getUniqueLayerName(),
        visible: true,
        opacityPct: 100,
        splats: [],
        selectionMask: null,
        colorGrade: cloneColorGrade(),
        renderBox: createDefaultRenderBox(),
        ...createDefaultLayerTransform(),
    };
    layers.push(layer);
    selectedLayerId = layer.id;
    hasSelection = false;
    renderLayersUI();
    updateLayerEntity(layer);
    getPosthog()?.capture('layer_added', { layer_name: layer.name });
};

const deleteLayer = (layerId) => {
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    const layer = layers[idx];
    getPosthog()?.capture('layer_deleted', { layer_name: layer.name, splat_count: layer.splats.length });
    destroyLayerGsplatPaint(layer);
    const child = layersContainer.findByName(`layer-${layerId}`);
    if (child) child.destroy();
    layers.splice(idx, 1);
    let removedSavedSel = false;
    for (let i = savedSelections.length - 1; i >= 0; i--) {
        if (savedSelections[i].layerId === layerId) {
            savedSelections.splice(i, 1);
            removedSavedSel = true;
        }
    }
    if (removedSavedSel) renderSavedSelectionsList();
    if (selectedLayerId === layerId) {
        selectedLayerId = layers.length ? layers[Math.min(idx, layers.length - 1)].id : 'base';
        hasSelection = selectedLayerId === 'base'
            ? !!(selectionMask?.some(v => v > 0))
            : !!(layers.find(l => l.id === selectedLayerId)?.selectionMask?.some(v => v > 0));
    }
    renderLayersUI();
    updateSelectionUI();
};

const duplicateLayerDisplayName = (baseName) => {
    const used = new Set(layers.map((l) => l.name));
    let name = `${baseName} copy`;
    let n = 2;
    while (used.has(name)) {
        name = `${baseName} copy ${n}`;
        n++;
    }
    return name;
};

/** Unique name among saved selections (for duplicated layer selections). */
const duplicateSavedSelectionDisplayName = (baseName) => {
    const used = new Set(savedSelections.map((s) => s.name));
    let name = `${baseName} copy`;
    let n = 2;
    while (used.has(name)) {
        name = `${baseName} copy ${n}`;
        n++;
    }
    return name;
};

/** Clone saved selections tied to `fromLayerId` onto `toLayerId` (same splat count / mask indices). */
const duplicateSavedSelectionsForLayer = (fromLayerId, toLayerId, numSplats) => {
    let added = false;
    for (const s of savedSelections) {
        if (s.layerId !== fromLayerId) continue;
        if (s.numSplats !== numSplats || s.mask?.length !== numSplats) continue;
        savedSelections.push({
            id: 'sel-' + Date.now() + '-' + Math.random().toString(36).slice(2),
            name: duplicateSavedSelectionDisplayName(s.name),
            layerId: toLayerId,
            numSplats,
            mask: new Uint8Array(s.mask),
        });
        added = true;
    }
    if (added) renderSavedSelectionsList();
};

/** Deep-copy splats + transform; bakes brush from GPU so the copy matches the viewport. */
const duplicateLayer = async (layerId) => {
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    const src = layers[idx];
    ensureUserLayerTransform(src);

    const splats = src.splats.map((s) => ({ ...s }));
    const ent = layersContainer.findByName(`layer-${src.id}`);
    if (ent?.gsplat && splats.length) {
        const baked = await getLayerPaintFromGpu(src, ent.gsplat);
        if (baked) {
            for (let i = 0; i < splats.length; i++) {
                splats[i].f_dc_0 = baked.out0[i];
                splats[i].f_dc_1 = baked.out1[i];
                splats[i].f_dc_2 = baked.out2[i];
                splats[i].opacity = baked.outOp[i];
            }
        }
    }

    ensureLayerColorGrade(src);
    ensureLayerOpacityPct(src);
    const newLayer = {
        id: `layer-${layerIdCounter++}`,
        name: duplicateLayerDisplayName(src.name),
        visible: src.visible,
        opacityPct: src.opacityPct,
        splats,
        selectionMask:
            src.selectionMask && src.selectionMask.length === splats.length
                ? new Uint8Array(src.selectionMask)
                : null,
        colorGrade: cloneColorGrade(src.colorGrade),
        renderBox: JSON.parse(JSON.stringify(src.renderBox ?? createDefaultRenderBox())),
        ...createDefaultLayerTransform(),
    };
    newLayer.position = { ...src.position };
    newLayer.rotation = { ...src.rotation };
    newLayer.scale = { ...src.scale };

    layers.splice(idx + 1, 0, newLayer);
    selectedLayerId = newLayer.id;
    hasSelection = !!(newLayer.selectionMask?.some((v) => v > 0));
    renderLayersUI();
    updateSelectionUI();

    try {
        await updateLayerEntity(newLayer);
    } catch (e) {
        console.error(e);
        const fi = layers.findIndex((l) => l.id === newLayer.id);
        if (fi >= 0) {
            destroyLayerGsplatPaint(newLayer);
            const ch = layersContainer.findByName(`layer-${newLayer.id}`);
            if (ch) ch.destroy();
            layers.splice(fi, 1);
        }
        selectedLayerId = src.id;
        hasSelection = !!(src.selectionMask?.some((v) => v > 0));
        renderLayersUI();
        updateSelectionUI();
        alert(`Duplicate layer failed: ${e?.message || e}`);
        return;
    }
    duplicateSavedSelectionsForLayer(src.id, newLayer.id, newLayer.splats.length);
    renderLayersUI();
    refreshLayerGizmoAttachment();
};

const separateSelectionDisplayName = (baseName) => {
    const used = new Set(layers.map((l) => l.name));
    let name = `${baseName} selection`;
    let n = 2;
    while (used.has(name)) {
        name = `${baseName} selection ${n}`;
        n++;
    }
    return name;
};

/** Move selected splats on the active user layer into a new layer (same transform & grade); remainder stays on the source. */
const separateSelectionToNewLayer = async () => {
    const src = getActiveLayer();
    if (!src) {
        alert('Select a user layer (not Base), select splats, then separate.');
        return;
    }
    const mask = src.selectionMask;
    if (!mask || mask.length !== src.splats.length || !mask.some((v) => v > 0)) {
        alert('No selection on this layer.');
        return;
    }

    const ent = layersContainer.findByName(`layer-${src.id}`);
    const n = src.splats.length;
    const bakedSplats = src.splats.map((s) => ({ ...s }));
    if (ent?.gsplat && n) {
        const baked = await getLayerPaintFromGpu(src, ent.gsplat);
        if (baked) {
            for (let i = 0; i < n; i++) {
                bakedSplats[i].f_dc_0 = baked.out0[i];
                bakedSplats[i].f_dc_1 = baked.out1[i];
                bakedSplats[i].f_dc_2 = baked.out2[i];
                bakedSplats[i].opacity = baked.outOp[i];
            }
        }
    }

    const fullBakedBackup = bakedSplats.map((s) => ({ ...s }));
    const picked = [];
    const remainder = [];
    for (let i = 0; i < n; i++) {
        if (mask[i]) picked.push(bakedSplats[i]);
        else remainder.push(bakedSplats[i]);
    }
    if (!picked.length) {
        alert('No splats in selection.');
        return;
    }

    const srcIdx = layers.findIndex((l) => l.id === src.id);
    if (srcIdx < 0) return;

    const maskBackup = new Uint8Array(mask);
    ensureLayerColorGrade(src);
    ensureLayerOpacityPct(src);
    const newLayer = {
        id: `layer-${layerIdCounter++}`,
        name: separateSelectionDisplayName(src.name),
        visible: true,
        opacityPct: src.opacityPct,
        splats: picked,
        selectionMask: null,
        colorGrade: cloneColorGrade(src.colorGrade),
        renderBox: JSON.parse(JSON.stringify(src.renderBox ?? createDefaultRenderBox())),
        ...createDefaultLayerTransform(),
    };
    newLayer.position = { ...src.position };
    newLayer.rotation = { ...src.rotation };
    newLayer.scale = { ...src.scale };

    src.splats = remainder;
    src.selectionMask = null;
    layers.splice(srcIdx + 1, 0, newLayer);

    const rollback = async () => {
        const ni = layers.findIndex((l) => l.id === newLayer.id);
        if (ni >= 0) {
            destroyLayerGsplatPaint(layers[ni]);
            const ch = layersContainer.findByName(`layer-${layers[ni].id}`);
            if (ch) ch.destroy();
            layers.splice(ni, 1);
        }
        src.splats = fullBakedBackup;
        src.selectionMask = new Uint8Array(maskBackup);
        hasSelection = maskBackup.some((v) => v > 0);
        selectionSphere = [0, 0, 0, hasSelection ? 9999 : -1];
        selectedLayerId = src.id;
        renderLayersUI();
        updateSelectionUI();
        try {
            await updateLayerEntity(src);
        } catch (_) { /* ignore */ }
    };

    hasSelection = false;
    selectionSphere = [0, 0, 0, -1];
    renderLayersUI();
    updateSelectionUI();

    try {
        await updateLayerEntity(src);
    } catch (e) {
        console.error(e);
        await rollback();
        alert(`Could not update layer: ${e?.message || e}`);
        return;
    }

    try {
        await updateLayerEntity(newLayer);
    } catch (e) {
        console.error(e);
        await rollback();
        alert(`Could not create new layer: ${e?.message || e}`);
        return;
    }

    selectedLayerId = newLayer.id;
    const nn = newLayer.splats.length;
    newLayer.selectionMask = new Uint8Array(nn);
    newLayer.selectionMask.fill(1);
    hasSelection = true;
    recomputeSelectionSphere();

    renderLayersUI();
    updateSelectionUI();
    refreshLayerGizmoAttachment();
};

const toggleLayerVisibility = (layerId) => {
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) return;
    layer.visible = !layer.visible;
    const child = layersContainer.findByName(`layer-${layerId}`);
    if (child) child.enabled = layer.visible;
    renderLayersUI();
};

const selectLayer = (layerId) => {
    selectedLayerId = layerId;
    // Sync global hasSelection to reflect the newly active layer's state
    if (layerId === 'base' || !layerId) {
        hasSelection = !!(selectionMask?.some(v => v > 0));
    } else {
        const layer = layers.find(l => l.id === layerId);
        hasSelection = !!(layer?.selectionMask?.some(v => v > 0));
    }
    renderLayersUI();
    updateSelectionUI();
};

// ── Per-layer / base transform (local TRS on splat entity) ───────────────────
let _syncingLayerTransformUI = false;

const readLayerTransformInputsIntoModel = () => {
    if (_syncingLayerTransformUI) return;
    const num = (id, def = 0) => {
        const v = numericFieldValueOrNull(g(id)?.value);
        return v != null ? v : def;
    };
    const clampPos = (v) => Math.max(-1000, Math.min(1000, v));
    const clampRot = (v) => Math.max(-360, Math.min(360, v));
    const clampScl = (v) => Math.max(0.01, Math.min(10, v));

    if (selectedLayerId === 'base' || !selectedLayerId) {
        baseTransform.position.x = clampPos(num('lt-pos-x', 0));
        baseTransform.position.y = clampPos(num('lt-pos-y', 0));
        baseTransform.position.z = clampPos(num('lt-pos-z', 0));
        baseTransform.rotation.x = clampRot(num('lt-rot-x', 0));
        baseTransform.rotation.y = clampRot(num('lt-rot-y', 0));
        baseTransform.rotation.z = clampRot(num('lt-rot-z', 0));
        baseTransform.scale.x = clampScl(num('lt-scl-x', 1));
        baseTransform.scale.y = clampScl(num('lt-scl-y', 1));
        baseTransform.scale.z = clampScl(num('lt-scl-z', 1));
        applyAllLayerEntityTransforms();
        return;
    }
    const layer = layers.find((l) => l.id === selectedLayerId);
    if (!layer) return;
    ensureUserLayerTransform(layer);
    layer.position.x = clampPos(num('lt-pos-x', 0));
    layer.position.y = clampPos(num('lt-pos-y', 0));
    layer.position.z = clampPos(num('lt-pos-z', 0));
    layer.rotation.x = clampRot(num('lt-rot-x', 0));
    layer.rotation.y = clampRot(num('lt-rot-y', 0));
    layer.rotation.z = clampRot(num('lt-rot-z', 0));
    layer.scale.x = clampScl(num('lt-scl-x', 1));
    layer.scale.y = clampScl(num('lt-scl-y', 1));
    layer.scale.z = clampScl(num('lt-scl-z', 1));
    applyAllLayerEntityTransforms();
};

const resetActiveLayerTransform = () => {
    const d = createDefaultLayerTransform();
    if (selectedLayerId === 'base' || !selectedLayerId) {
        baseTransform.position = { ...d.position };
        baseTransform.rotation = { ...d.rotation };
        baseTransform.scale = { ...d.scale };
    } else {
        const layer = layers.find((l) => l.id === selectedLayerId);
        if (layer) {
            ensureUserLayerTransform(layer);
            layer.position = { ...d.position };
            layer.rotation = { ...d.rotation };
            layer.scale = { ...d.scale };
        }
    }
    syncLayerTransformUI();
    applyAllLayerEntityTransforms();
    refreshLayerGizmoAttachment();
};

const getActiveRenderBox = () => {
    if (selectedLayerId === 'base' || !selectedLayerId) return baseRenderBox;
    const layer = layers.find((l) => l.id === selectedLayerId);
    if (!layer) return null;
    ensureLayerRenderBox(layer);
    return layer.renderBox;
};

const ensureRenderBoxPreviewEntityForParent = (parent) => {
    if (!parent) return null;
    let ent = parent.findByName('render-box-preview');
    if (!ent) {
        ent = new pc.Entity('render-box-preview');
        parent.addChild(ent);
        const mi = new pc.MeshInstance(renderBoxWireMesh, renderBoxWireMat);
        mi.cull = false;
        mi.drawOrder = 210;
        ent.addComponent('render', { castShadows: false, meshInstances: [mi] });
    }
    return ent;
};

const refreshActiveRenderBoxPreview = () => {
    const rb = getActiveRenderBox();
    if (!rb) return;
    let parent = null;
    if (selectedLayerId === 'base' || !selectedLayerId) {
        parent = paintables[0]?.entity ?? null;
    } else {
        parent = layersContainer.findByName(`layer-${selectedLayerId}`) ?? null;
    }
    if (!parent) {
        activeRenderBoxGizmoEntity = null;
        return;
    }
    const ent = ensureRenderBoxPreviewEntityForParent(parent);
    if (!ent) return;
    ent.enabled = !!rb.enabled;
    ent.setLocalPosition(
        clampRenderBoxNumber(rb.center?.x, 0),
        clampRenderBoxNumber(rb.center?.y, 0),
        clampRenderBoxNumber(rb.center?.z, 0),
    );
    ent.setLocalEulerAngles(0, 0, 0);
    ent.setLocalScale(
        clampRenderBoxSize(rb.size?.x, 2),
        clampRenderBoxSize(rb.size?.y, 2),
        clampRenderBoxSize(rb.size?.z, 2),
    );
    activeRenderBoxGizmoEntity = ent;
};

const applyActiveRenderBoxToRuntime = () => {
    const rb = getActiveRenderBox();
    if (!rb) return;
    if (selectedLayerId === 'base' || !selectedLayerId) {
        for (const pb of paintables) applyRenderBoxToGsplat(pb.gsplatComponent, rb);
        invalidateBaseChunkVisibilityCamCache();
        updateSpatialBaseChunkVisibility();
    } else {
        const ent = layersContainer.findByName(`layer-${selectedLayerId}`);
        if (ent?.gsplat) applyRenderBoxToGsplat(ent.gsplat, rb);
    }
    refreshActiveRenderBoxPreview();
};

const getActiveRenderBoxBounds = () => {
    if (selectedLayerId === 'base' || !selectedLayerId) {
        const b = gsplatDataCache?.bounds;
        if (!b) return null;
        return {
            min: { x: b.min[0], y: b.min[1], z: b.min[2] },
            max: { x: b.max[0], y: b.max[1], z: b.max[2] },
        };
    }
    const layer = layers.find((l) => l.id === selectedLayerId);
    if (!layer?.splats?.length) return null;
    let minx = Infinity;
    let miny = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    let maxz = -Infinity;
    for (const s of layer.splats) {
        minx = Math.min(minx, s.x);
        miny = Math.min(miny, s.y);
        minz = Math.min(minz, s.z);
        maxx = Math.max(maxx, s.x);
        maxy = Math.max(maxy, s.y);
        maxz = Math.max(maxz, s.z);
    }
    return {
        min: { x: minx, y: miny, z: minz },
        max: { x: maxx, y: maxy, z: maxz },
    };
};

const fitActiveRenderBoxToBounds = () => {
    const rb = getActiveRenderBox();
    const b = getActiveRenderBoxBounds();
    if (!rb || !b) return;
    rb.enabled = true;
    rb.center.x = (b.min.x + b.max.x) * 0.5;
    rb.center.y = (b.min.y + b.max.y) * 0.5;
    rb.center.z = (b.min.z + b.max.z) * 0.5;
    rb.size.x = Math.max(0.01, b.max.x - b.min.x);
    rb.size.y = Math.max(0.01, b.max.y - b.min.y);
    rb.size.z = Math.max(0.01, b.max.z - b.min.z);
    syncLayerTransformUI();
    applyActiveRenderBoxToRuntime();
};

const resetActiveRenderBox = () => {
    if (selectedLayerId === 'base' || !selectedLayerId) {
        baseRenderBox = createDefaultRenderBox();
    } else {
        const layer = layers.find((l) => l.id === selectedLayerId);
        if (layer) layer.renderBox = createDefaultRenderBox();
    }
    syncLayerTransformUI();
    applyActiveRenderBoxToRuntime();
};

const toggleRenderBoxGizmoEditMode = () => {
    renderBoxGizmoEditMode = !renderBoxGizmoEditMode;
    if (renderBoxGizmoEditMode) {
        const rb = getActiveRenderBox();
        if (rb && !rb.enabled) {
            rb.enabled = true;
            applyActiveRenderBoxToRuntime();
        }
    }
    updateRenderBoxGizmoEditButton();
    refreshLayerGizmoAttachment();
};

const readRenderBoxInputsIntoModel = () => {
    if (_syncingLayerTransformUI) return;
    const rb = getActiveRenderBox();
    if (!rb) return;
    rb.enabled = !!g('rb-enabled')?.checked;
    const num = (id, d = 0) => numericFieldValueOrNull(g(id)?.value) ?? d;
    rb.center.x = clampRenderBoxNumber(num('rb-cx', 0), 0);
    rb.center.y = clampRenderBoxNumber(num('rb-cy', 0), 0);
    rb.center.z = clampRenderBoxNumber(num('rb-cz', 0), 0);
    rb.size.x = clampRenderBoxSize(num('rb-sx', 2), 2);
    rb.size.y = clampRenderBoxSize(num('rb-sy', 2), 2);
    rb.size.z = clampRenderBoxSize(num('rb-sz', 2), 2);
    applyActiveRenderBoxToRuntime();
};

const syncLayerTransformUI = () => {
    const sec = g('layer-transform-section');
    if (!sec) return;
    const loaded = paintables.length > 0 || layers.some((l) => l.splats.length > 0);
    const userSel = selectedLayerId !== 'base' && selectedLayerId && layers.some((l) => l.id === selectedLayerId);
    const show = loaded && (selectedLayerId === 'base' || !selectedLayerId || userSel);
    sec.classList.toggle('hidden', !show);
    if (!show) return;

    _syncingLayerTransformUI = true;
    let pos;
    let rot;
    let scl;
    if (selectedLayerId === 'base' || !selectedLayerId) {
        pos = baseTransform.position;
        rot = baseTransform.rotation;
        scl = baseTransform.scale;
    } else {
        const ly = layers.find((l) => l.id === selectedLayerId);
        if (!ly) {
            _syncingLayerTransformUI = false;
            return;
        }
        ensureUserLayerTransform(ly);
        pos = ly.position;
        rot = ly.rotation;
        scl = ly.scale;
    }
    const setv = (id, v) => {
        const el = g(id);
        if (el) el.value = v;
    };
    setv('lt-pos-x', pos.x);
    setv('lt-pos-y', pos.y);
    setv('lt-pos-z', pos.z);
    setv('lt-rot-x', rot.x);
    setv('lt-rot-y', rot.y);
    setv('lt-rot-z', rot.z);
    setv('lt-scl-x', scl.x);
    setv('lt-scl-y', scl.y);
    setv('lt-scl-z', scl.z);
    const rb = getActiveRenderBox() || createDefaultRenderBox();
    const setb = (id, v) => {
        const el = g(id);
        if (el) el.value = v;
    };
    const ckb = g('rb-enabled');
    if (ckb) ckb.checked = !!rb.enabled;
    setb('rb-cx', rb.center?.x ?? 0);
    setb('rb-cy', rb.center?.y ?? 0);
    setb('rb-cz', rb.center?.z ?? 0);
    setb('rb-sx', rb.size?.x ?? 2);
    setb('rb-sy', rb.size?.y ?? 2);
    setb('rb-sz', rb.size?.z ?? 2);
    updateRenderBoxGizmoEditButton();
    _syncingLayerTransformUI = false;
};

const layerVisIcon = (visible) => tablerIconHtmlSync(visible ? 'eye' : 'eye-off', { size: 14 });

/** Keep gsplat entity order aligned with `layers` (draw / compositing order). */
const syncLayersContainerChildOrder = () => {
    const ents = layers.map((l) => layersContainer.findByName(`layer-${l.id}`)).filter(Boolean);
    for (const e of ents) layersContainer.removeChild(e);
    for (const e of ents) layersContainer.addChild(e);
};

const startLayerRename = (itemEl, layer) => {
    const nameSpan = itemEl.querySelector('.layer-name');
    if (!nameSpan) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'layer-rename-input';
    inp.value = layer.name;
    inp.maxLength = 40;
    const commit = () => {
        const v = inp.value.trim();
        if (v && v !== layer.name) layer.name = v;
        renderLayersUI();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') inp.blur();
        if (ke.key === 'Escape') { inp.value = layer.name; inp.blur(); }
    });
    nameSpan.replaceWith(inp);
    inp.focus();
    inp.select();
};

const startBaseLayerRename = (itemEl) => {
    const nameSpan = itemEl.querySelector('.layer-name');
    if (!nameSpan) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'layer-rename-input';
    inp.value = baseModelName || 'Model';
    inp.maxLength = 40;
    const commit = () => {
        const v = inp.value.trim();
        if (v) baseModelName = v;
        renderLayersUI();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') inp.blur();
        if (ke.key === 'Escape') { inp.value = baseModelName || 'Model'; inp.blur(); }
    });
    nameSpan.replaceWith(inp);
    inp.focus();
    inp.select();
};

const renderLayersUI = () => {
    const list = g('layers-list');
    if (!list) return;
    list.innerHTML = '';

    // ── User-created layers (painted on top) ──────────────────────────────────
    for (const layer of layers) {
        ensureLayerOpacityPct(layer);
        const item = document.createElement('div');
        item.className = `layer-item${selectedLayerId === layer.id ? ' selected' : ''}`;
        item.dataset.layerId = layer.id;
        item.innerHTML = `
          <span class="layer-drag-handle" draggable="true" title="Drag to reorder">${tablerIconHtmlSync('grip-vertical', { size: 14 })}</span>
          <button class="layer-visibility${layer.visible ? '' : ' hidden'}" title="${layer.visible ? 'Hide' : 'Show'}">${layerVisIcon(layer.visible)}</button>
          <span class="layer-icon">${tablerIconHtmlSync('layout-grid', { size: 13 })}</span>
          <span class="layer-name">${layer.name}</span>
          <input type="text" class="layer-opacity-input" inputmode="numeric" spellcheck="false" value="${layer.opacityPct}" title="Opacity %" aria-label="Layer opacity %" />
          <button class="layer-duplicate" title="Duplicate layer">
            ${tablerIconHtmlSync('copy', { size: 12 })}
          </button>
          <button class="layer-delete" title="Delete layer">
            ${tablerIconHtmlSync('trash', { size: 12 })}
          </button>
        `;
        {
            let clickTimer = null;
            item.addEventListener('click', (e) => {
                if (e.target.closest('.layer-delete') || e.target.closest('.layer-duplicate') || e.target.closest('.layer-visibility') || e.target.closest('.layer-opacity-input') || e.target.closest('.layer-rename-input')) return;
                const onName = !!e.target.closest('.layer-name');
                if (onName && selectedLayerId === layer.id) {
                    if (clickTimer) {
                        clearTimeout(clickTimer);
                        clickTimer = null;
                        startLayerRename(item, layer);
                        return;
                    }
                    clickTimer = setTimeout(() => { clickTimer = null; }, 350);
                    return;
                }
                selectLayer(layer.id);
            });
        }
        item.querySelector('.layer-visibility').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleLayerVisibility(layer.id);
        });
        item.querySelector('.layer-duplicate').addEventListener('click', (e) => {
            e.stopPropagation();
            void duplicateLayer(layer.id);
        });
        item.querySelector('.layer-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteLayer(layer.id);
        });
        const opInp = item.querySelector('.layer-opacity-input');
        opInp.addEventListener('click', (e) => e.stopPropagation());
        opInp.addEventListener('keydown', (e) => e.stopPropagation());
        opInp.addEventListener('input', () => {
            layer.opacityPct = clampLayerOpacityPct(opInp.value);
            opInp.value = String(layer.opacityPct);
            const ent = layersContainer.findByName(`layer-${layer.id}`);
            if (ent?.gsplat) pushLayerOpacityToGsplat(ent.gsplat, layer.opacityPct);
        });
        list.appendChild(item);
    }

    // ── Base model layer (bottom row; removable) ──────────────────────────────
    const baseLoaded = paintables.length > 0;
    const baseItem = document.createElement('div');
    baseItem.className = `layer-item layer-item-base${selectedLayerId === 'base' ? ' selected' : ''}`;
    const baseVisible = baseLoaded && (baseSpatialChunkingActive
        ? !baseLayerHiddenByUser
        : paintables[0].entity.enabled);
    baseLayerOpacityPct = clampLayerOpacityPct(baseLayerOpacityPct);
    baseItem.innerHTML = `
      <button class="layer-visibility${baseVisible ? '' : ' hidden'}" title="${baseVisible ? 'Hide' : 'Show'}">${layerVisIcon(baseVisible)}</button>
      <span class="layer-icon">${tablerIconHtmlSync('stack-2', { size: 13 })}</span>
      <span class="layer-name">${baseModelName || 'Model'}</span>
      <input type="text" class="layer-opacity-input" inputmode="numeric" spellcheck="false" value="${baseLayerOpacityPct}" title="Opacity %" aria-label="Base opacity %" ${baseLoaded ? '' : 'disabled'} />
      ${baseLoaded ? `<button class="layer-delete" title="Remove base model (layers kept)">
            ${tablerIconHtmlSync('trash', { size: 12 })}
          </button>` : ''}
    `;
    {
        let clickTimer = null;
        baseItem.addEventListener('click', (e) => {
            if (e.target.closest('.layer-visibility') || e.target.closest('.layer-delete') || e.target.closest('.layer-opacity-input') || e.target.closest('.layer-rename-input')) return;
            const onName = !!e.target.closest('.layer-name');
            if (onName && selectedLayerId === 'base') {
                if (clickTimer) {
                    clearTimeout(clickTimer);
                    clickTimer = null;
                    startBaseLayerRename(baseItem);
                    return;
                }
                clickTimer = setTimeout(() => { clickTimer = null; }, 350);
                return;
            }
            selectLayer('base');
        });
    }
    baseItem.querySelector('.layer-visibility').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!baseLoaded) return;
        if (baseSpatialChunkingActive) {
            baseLayerHiddenByUser = !baseLayerHiddenByUser;
            invalidateBaseChunkVisibilityCamCache();
            updateSpatialBaseChunkVisibility();
        } else {
            const ent = paintables[0].entity;
            ent.enabled = !ent.enabled;
        }
        renderLayersUI();
    });
    const baseDel = baseItem.querySelector('.layer-delete');
    if (baseDel) {
        baseDel.addEventListener('click', (e) => {
            e.stopPropagation();
            removeBaseModel();
        });
    }
    const baseOpInp = baseItem.querySelector('.layer-opacity-input');
    if (baseOpInp) {
        baseOpInp.addEventListener('click', (e) => e.stopPropagation());
        baseOpInp.addEventListener('keydown', (e) => e.stopPropagation());
        baseOpInp.addEventListener('input', () => {
            if (!baseLoaded) return;
            baseLayerOpacityPct = clampLayerOpacityPct(baseOpInp.value);
            baseOpInp.value = String(baseLayerOpacityPct);
            for (const pb of paintables) {
                if (pb.gsplatComponent) pushLayerOpacityToGsplat(pb.gsplatComponent, baseLayerOpacityPct);
            }
        });
    }
    list.appendChild(baseItem);
    syncLayerTransformUI();
    refreshLayerGizmoAttachment();
    refreshColorGradeUIFromSelection();
    updateEmptyScenePlaceholder();
    renderSavedSelectionsList();
};

const LAYER_REORDER_MIME = 'application/x-photoshock-layer';

const clearLayerDropIndicators = () => {
    const list = g('layers-list');
    if (!list) return;
    list.querySelectorAll('.layer-item').forEach((el) => {
        el.classList.remove('layer-drop-before', 'layer-drop-after', 'layer-item-dragging');
    });
};

let layersListDragReorderWired = false;
const wireLayersListDragReorder = () => {
    const list = g('layers-list');
    if (!list || layersListDragReorderWired) return;
    layersListDragReorderWired = true;

    list.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.layer-drag-handle');
        if (!handle) return;
        const row = handle.closest('.layer-item');
        if (!row?.dataset.layerId) return;
        const id = row.dataset.layerId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(LAYER_REORDER_MIME, id);
        e.dataTransfer.setData('text/plain', id);
        row.classList.add('layer-item-dragging');
    });

    list.addEventListener('dragend', () => {
        clearLayerDropIndicators();
    });

    list.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes(LAYER_REORDER_MIME)) return;
        const row = e.target.closest('.layer-item');
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        list.querySelectorAll('.layer-item').forEach((el) => {
            el.classList.remove('layer-drop-before', 'layer-drop-after');
        });

        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height * 0.5;
        row.classList.add(before ? 'layer-drop-before' : 'layer-drop-after');
    });

    list.addEventListener('drop', (e) => {
        const row = e.target.closest('.layer-item');
        if (!row) return;
        const draggedId = e.dataTransfer.getData(LAYER_REORDER_MIME)
            || e.dataTransfer.getData('text/plain');
        if (!draggedId) return;
        e.preventDefault();
        e.stopPropagation();
        clearLayerDropIndicators();

        const fromIdx = layers.findIndex((l) => l.id === draggedId);
        if (fromIdx < 0) return;

        let newIndex;
        if (row.classList.contains('layer-item-base')) {
            newIndex = layers.length;
        } else {
            const targetId = row.dataset.layerId;
            const targetIdx = layers.findIndex((l) => l.id === targetId);
            if (targetIdx < 0) return;
            const rect = row.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height * 0.5;
            newIndex = after ? targetIdx + 1 : targetIdx;
        }

        if (fromIdx < newIndex) newIndex--;
        if (newIndex === fromIdx) return;

        const [item] = layers.splice(fromIdx, 1);
        layers.splice(newIndex, 0, item);
        syncLayersContainerChildOrder();
        renderLayersUI();
    });
};

// Build DataTable from layer splats — caller must ensure splats is non-empty.
const splatsToDataTable = (splats, DataTable, Column) => {
    const arr = splats;
    const n = arr.length;
    const addCol = (name, fn) => new Column(name, new Float32Array(arr.map(fn)));
    const columns = [
        addCol('x', (s) => s.x),
        addCol('y', (s) => s.y),
        addCol('z', (s) => s.z),
        addCol('nx', (s) => s.nx ?? 0),
        addCol('ny', (s) => s.ny ?? 1),
        addCol('nz', (s) => s.nz ?? 0),
        addCol('f_dc_0', (s) => s.f_dc_0 ?? 0),
        addCol('f_dc_1', (s) => s.f_dc_1 ?? 0),
        addCol('f_dc_2', (s) => s.f_dc_2 ?? 0),
    ];
    // Only include f_rest_* columns that exist on the base cache or on splat objects.
    const shKeys = gsplatDataCache?.shRest?.length
        ? gsplatDataCache.shRest.map((sh) => sh.key)
        : collectShKeysFromSplatsArray(arr);
    for (const key of shKeys) {
        columns.push(new Column(key, new Float32Array(arr.map((s) => s[key] ?? 0))));
    }
    columns.push(
        addCol('opacity', (s) => s.opacity ?? 0),
        addCol('scale_0', (s) => s.scale_0 ?? -5),
        addCol('scale_1', (s) => s.scale_1 ?? -5),
        addCol('scale_2', (s) => s.scale_2 ?? -5),
        addCol('rot_0', (s) => s.rot_0 ?? 1),
        addCol('rot_1', (s) => s.rot_1 ?? 0),
        addCol('rot_2', (s) => s.rot_2 ?? 0),
        addCol('rot_3', (s) => s.rot_3 ?? 0),
    );
    return new DataTable(columns);
};

/** Minimum centroid magnitude to trigger re-origin (avoid jitter on already-centered layers). */
const SPLAT_MASS_ORIGIN_EPS = 1e-5;

/**
 * Build a PLY DataTable directly from PlayCanvas GSplatData — avoids splatsToDataTable’s
 * per-column `arr.map` over millions of JS objects (major cost on large layer imports).
 */
const dataTableFromGsplatCpuData = (data) => {
    if (!data?.numSplats) return new DataTable([]);
    const columns = [];
    const push = (name) => {
        const buf = data.getProp(name);
        if (!buf) return;
        columns.push(new Column(name, floatPropToCache(buf)));
    };
    push('x');
    push('y');
    push('z');
    push('nx');
    push('ny');
    push('nz');
    push('f_dc_0');
    push('f_dc_1');
    push('f_dc_2');
    for (let k = 0; k < 45; k++) {
        const name = `f_rest_${k}`;
        if (data.getProp(name)) push(name);
    }
    push('opacity');
    push('scale_0');
    push('scale_1');
    push('scale_2');
    push('rot_0');
    push('rot_1');
    push('rot_2');
    push('rot_3');
    return new DataTable(columns);
};

/**
 * Same mass-origin shift as shiftUserLayerSplatsToMassOrigin, but mutates GSplatData x/y/z.
 * Call before building splats / DataTable from `data`.
 */
const shiftGsplatCpuDataMassOriginForLayer = (layer, data, existingEntity) => {
    const x = data.getProp('x');
    const y = data.getProp('y');
    const z = data.getProp('z');
    if (!x?.length || !y?.length || !z?.length) return null;
    const n = data.numSplats;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
        sx += x[i];
        sy += y[i];
        sz += z[i];
    }
    const inv = 1 / n;
    const C = new pc.Vec3(sx * inv, sy * inv, sz * inv);
    if (C.length() < SPLAT_MASS_ORIGIN_EPS) return null;

    const wc = new pc.Vec3();
    if (existingEntity) {
        existingEntity.getWorldTransform().transformPoint(C, wc);
    } else {
        ensureUserLayerTransform(layer);
        const t = new pc.Vec3(layer.position.x, layer.position.y, layer.position.z);
        const q = new pc.Quat().setFromEulerAngles(layer.rotation.x, layer.rotation.y, layer.rotation.z);
        const s = new pc.Vec3(layer.scale.x, layer.scale.y, layer.scale.z);
        const layerM = new pc.Mat4().setTRS(t, q, s);
        const worldM = new pc.Mat4().mul2(layersContainer.getWorldTransform(), layerM);
        worldM.transformPoint(C, wc);
    }

    for (let i = 0; i < n; i++) {
        x[i] -= C.x;
        y[i] -= C.y;
        z[i] -= C.z;
    }
    return wc;
};

const computeSplatsCentroidVec3 = (splats) => {
    if (!splats?.length) return null;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const s of splats) {
        sx += s.x;
        sy += s.y;
        sz += s.z;
    }
    const n = splats.length;
    return new pc.Vec3(sx / n, sy / n, sz / n);
};

/**
 * Shift all splat positions so their mean is at (0,0,0). Returns the former
 * centroid in **world** space (for snapping the layer entity so the cloud
 * stays in place), or null if no shift was applied.
 *
 * @param {object} layer
 * @param {pc.Entity | null} existingEntity  Layer gsplat entity before rebuild, if any
 */
const shiftUserLayerSplatsToMassOrigin = (layer, existingEntity) => {
    const splats = layer.splats;
    if (!splats.length) return null;
    const C = computeSplatsCentroidVec3(splats);
    if (!C || C.length() < SPLAT_MASS_ORIGIN_EPS) return null;

    const wc = new pc.Vec3();
    if (existingEntity) {
        existingEntity.getWorldTransform().transformPoint(C, wc);
    } else {
        ensureUserLayerTransform(layer);
        const t = new pc.Vec3(layer.position.x, layer.position.y, layer.position.z);
        const q = new pc.Quat().setFromEulerAngles(layer.rotation.x, layer.rotation.y, layer.rotation.z);
        const s = new pc.Vec3(layer.scale.x, layer.scale.y, layer.scale.z);
        const layerM = new pc.Mat4().setTRS(t, q, s);
        const worldM = new pc.Mat4().mul2(layersContainer.getWorldTransform(), layerM);
        worldM.transformPoint(C, wc);
    }

    for (const s of splats) {
        s.x -= C.x;
        s.y -= C.y;
        s.z -= C.z;
    }
    return wc;
};

/** Position / attribute tolerance when matching `layer.splats` to loaded PLY order. */
const SPLAT_MATCH_EPS = 1e-4;

/**
 * PlayCanvas may reorder splats when loading PLY; `layer.splats[i]` is then not
 * the same Gaussian as GPU storage index `i`. Selection / highlight uploads must
 * map CPU mask indices → GPU texel indices or the wrong splats appear selected.
 */
const buildLayerCpuToGpuSplatMap = (layer, resource) => {
    layer._cpuToGpuSplat = null;
    const n = layer.splats.length;
    const raw = resource?.gsplatData;
    const data = typeof raw?.decompress === 'function' ? raw.decompress() : raw;
    if (!data?.getProp || data.numSplats !== n) return;

    const gx = data.getProp('x');
    const gy = data.getProp('y');
    const gz = data.getProp('z');
    if (!gx || !gy || !gz) return;

    let identity = true;
    for (let i = 0; i < n; i++) {
        const s = layer.splats[i];
        if (
            Math.abs(s.x - gx[i]) > SPLAT_MATCH_EPS
            || Math.abs(s.y - gy[i]) > SPLAT_MATCH_EPS
            || Math.abs(s.z - gz[i]) > SPLAT_MATCH_EPS
        ) {
            identity = false;
            break;
        }
    }
    if (identity) return;

    const f0 = data.getProp('f_dc_0');
    const f1 = data.getProp('f_dc_1');
    const f2 = data.getProp('f_dc_2');
    const r0 = data.getProp('rot_0');
    const r1 = data.getProp('rot_1');
    const r2 = data.getProp('rot_2');
    const r3 = data.getProp('rot_3');

    const qk = (x, y, z, a0, a1, a2, q0, q1, q2, q3) =>
        [
            Math.round(x / SPLAT_MATCH_EPS),
            Math.round(y / SPLAT_MATCH_EPS),
            Math.round(z / SPLAT_MATCH_EPS),
            Math.round((a0 ?? 0) / SPLAT_MATCH_EPS),
            Math.round((a1 ?? 0) / SPLAT_MATCH_EPS),
            Math.round((a2 ?? 0) / SPLAT_MATCH_EPS),
            Math.round((q0 ?? 1) / SPLAT_MATCH_EPS),
            Math.round((q1 ?? 0) / SPLAT_MATCH_EPS),
            Math.round((q2 ?? 0) / SPLAT_MATCH_EPS),
            Math.round((q3 ?? 0) / SPLAT_MATCH_EPS),
        ].join(',');

    const buckets = new Map();
    for (let i = 0; i < n; i++) {
        const s = layer.splats[i];
        const k = qk(
            s.x, s.y, s.z,
            s.f_dc_0, s.f_dc_1, s.f_dc_2,
            s.rot_0, s.rot_1, s.rot_2, s.rot_3,
        );
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
    }

    const cpuToGpu = new Int32Array(n);
    cpuToGpu.fill(-1);
    const usedGpu = new Uint8Array(n);

    for (let g = 0; g < n; g++) {
        const k = qk(
            gx[g], gy[g], gz[g],
            f0 ? f0[g] : 0, f1 ? f1[g] : 0, f2 ? f2[g] : 0,
            r0 ? r0[g] : 1, r1 ? r1[g] : 0, r2 ? r2[g] : 0, r3 ? r3[g] : 0,
        );
        const q = buckets.get(k);
        if (!q || !q.length) {
            console.warn('[layer] Could not match loaded splat order to layer.splats; selection highlight may be wrong.');
            return;
        }
        const cpuIdx = q.shift();
        if (usedGpu[g]) {
            console.warn('[layer] GPU splat index collision while mapping selection.');
            return;
        }
        usedGpu[g] = 1;
        cpuToGpu[cpuIdx] = g;
    }

    for (let i = 0; i < n; i++) {
        if (cpuToGpu[i] < 0) {
            console.warn('[layer] Incomplete CPU→GPU splat map; selection highlight may be wrong.');
            return;
        }
    }

    layer._cpuToGpuSplat = cpuToGpu;
};

/** Write `layer.selectionMask` into customSelection using optional `_cpuToGpuSplat` remap. */
const writeLayerSelectionMaskToInstanceTexture = (layer, gsplat) => {
    if (!layer.selectionMask?.length) return;
    const tex = gsplat.getInstanceTexture('customSelection');
    if (!tex) return;
    const d = tex.lock();
    if (!d) return;
    const numTexels = tex.width * tex.height;
    const map = layer._cpuToGpuSplat;
    const n = layer.selectionMask.length;
    for (let i = 0; i < numTexels; i++) {
        const off = i * 4;
        d[off] = 0;
        d[off + 1] = 0;
        d[off + 2] = 0;
        d[off + 3] = 255;
    }
    for (let cpu = 0; cpu < n; cpu++) {
        const gpu = map ? map[cpu] : cpu;
        if (gpu < 0 || gpu >= numTexels) continue;
        if (!layer.selectionMask[cpu]) continue;
        const off = gpu * 4;
        d[off] = 255;
        d[off + 1] = 0;
        d[off + 2] = 0;
        d[off + 3] = 255;
    }
    tex.unlock();
    gsplat.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
};

/** One rebuild pass: keep the previous gsplat visible until the new asset loads (no blink gap). */
const runSingleLayerEntityUpdate = async (layer) => {
    const existing = layersContainer.findByName(`layer-${layer.id}`);

    // Don't create a gsplat entity for an empty layer — a dummy splat entity
    // sitting in the scene causes PlayCanvas to disrupt the base model's
    // depth-sort / alpha-compositing, making the model look wrong.
    if (!layer.splats.length) {
        layer._cpuToGpuSplat = null;
        if (existing) {
            destroyLayerGsplatPaint(layer);
            existing.destroy();
        }
        return;
    }

    // Put layer pivot / gizmo at center of mass: zero mean positions, adjust transform.
    let massWorldSnap = shiftUserLayerSplatsToMassOrigin(layer, existing);
    if (!massWorldSnap && layer._importMassWorldSnap) {
        massWorldSnap = layer._importMassWorldSnap;
        delete layer._importMassWorldSnap;
    }

    const oldEnt = existing;
    const oldPb = layer._gsplatPaint;
    if (oldEnt) {
        oldEnt.name = `__layer_rebuild_${layer.id}`;
    }

    console.log(`[layer] updateLayerEntity: ${layer.id}, splats=${layer.splats.length}`);

    let table;
    if (layer._layerImportPlyTable) {
        table = layer._layerImportPlyTable;
        layer._layerImportPlyTable = null;
    } else {
        table = splatsToDataTable(layer.splats, DataTable, Column);
    }
    const memFs = new MemoryFileSystem();
    const filename = `layer-${layer.id}.ply`;
    await writePly(
        { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
        memFs,
    );
    const buffer = memFs.results?.get(filename);
    console.log(`[layer] PLY buffer size: ${buffer?.byteLength}`);
    if (!buffer) {
        console.error('[layer] writePly produced no buffer');
        if (oldEnt) oldEnt.name = `layer-${layer.id}`;
        return;
    }

    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const file = new File([blob], filename, { type: 'application/octet-stream' });
    const loadUrl = URL.createObjectURL(file);

    return new Promise((resolve, reject) => {
        const asset = new pc.Asset(`layer-${layer.id}`, 'gsplat', { url: loadUrl, filename });
        app.assets.add(asset);
        asset.once('load', (a) => {
            URL.revokeObjectURL(loadUrl);
            const entity = new pc.Entity(`layer-${layer.id}`);
            const gsplat = entity.addComponent('gsplat', { asset: a, unified: true });
            entity.enabled = layer.visible;
            layersContainer.addChild(entity);
            applyModelRotation();

            // After zeroing mean splat position, snap entity so world-space pose is unchanged
            // and the transform gizmo sits at the cloud’s center of mass.
            if (massWorldSnap) {
                entity.setPosition(massWorldSnap.x, massWorldSnap.y, massWorldSnap.z);
                const lp = entity.getLocalPosition();
                ensureUserLayerTransform(layer);
                layer.position.x = lp.x;
                layer.position.y = lp.y;
                layer.position.z = lp.z;
                applySingleLayerEntityTransform(layer);
                syncLayerTransformUI();
            }

            // Add all three extra streams the modifier shader expects so the
            // compiled shader program matches the base model's exactly.  Without
            // customColor + customOpacity the shader references null textures and
            // corrupts the GPU pipeline (model disappears when layer is visible).
            const fmt = a.resource.format;
            if (!fmt.extraStreams?.find(s => s.name === 'customColor')) {
                fmt.addExtraStreams([
                    { name: 'customColor',    format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
                    { name: 'customOpacity',  format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
                    { name: 'customSelection', format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
                ]);
            }
            const initTex = (name) => {
                const t = gsplat.getInstanceTexture(name);
                if (t) { const d = t.lock(); if (d) d.fill(0); t.unlock(); }
            };
            initTex('customColor'); initTex('customOpacity'); initTex('customSelection');

            buildLayerCpuToGpuSplatMap(layer, a.resource);

            gsplat.setWorkBufferModifier({ glsl: MODIFIER_GLSL, wgsl: MODIFIER_WGSL });
            gsplat.setParameter('uBlendMode',     blendMode());
            gsplat.setParameter('uShowSelection', 0);
            gsplat.setParameter('uSelectionColor', selectionHighlightColor());
            pushSplatViewShaderUniforms(gsplat);
            gsplat.setParameter('uHoverSphere',   [0, 0, 0, 0]);
            gsplat.setParameter('uHoverColor',    [1, 1, 1, 0]);
            ensureLayerColorGrade(layer);
            ensureLayerOpacityPct(layer);
            ensureLayerRenderBox(layer);
            applyColorGradeToGsplat(gsplat, layer.colorGrade);
            pushLayerOpacityToGsplat(gsplat, layer.opacityPct);
            applyRenderBoxToGsplat(gsplat, layer.renderBox);
            pushWorldToModelUniform(gsplat);
            refreshActiveRenderBoxPreview();

            layer._gsplatPaint = {
                entity,
                gsplatComponent: gsplat,
                ...createGsplatPaintProcessors(gsplat),
            };

            // Re-upload selection if this layer already has one (uses CPU→GPU splat map)
            if (layer.selectionMask?.some(v => v > 0)) {
                writeLayerSelectionMaskToInstanceTexture(layer, gsplat);
                if (selectedLayerId === layer.id && showSelectionHighlight) {
                    gsplat.setParameter('uShowSelection', 1);
                }
            }

            if (oldEnt) {
                destroyGsplatPaintBundle(oldPb);
                oldEnt.destroy();
            }

            console.log(`[layer] entity created: ${layer.id}, enabled=${entity.enabled}`);
            syncLayersContainerChildOrder();
            refreshLayerGizmoAttachment();
            resolve();
        });
        asset.once('error', (msg) => {
            URL.revokeObjectURL(loadUrl);
            console.error(`[layer] asset load error: ${msg}`);
            if (oldEnt) oldEnt.name = `layer-${layer.id}`;
            reject(new Error(msg));
        });
        app.assets.load(asset);
    });
};

const updateLayerEntity = async (layer) => {
    if (!layer) return;
    if (layer._layerEntityUpdateInFlight) {
        layer._layerEntityUpdatePending = true;
        return;
    }
    layer._layerEntityUpdateInFlight = true;
    try {
        await runSingleLayerEntityUpdate(layer);
    } finally {
        layer._layerEntityUpdateInFlight = false;
        if (layer._layerEntityUpdatePending) {
            layer._layerEntityUpdatePending = false;
            void updateLayerEntity(layer);
        }
    }
};

// ── Selection ─────────────────────────────────────────────────────────────────
const uploadSelectionToTexture = () => {
    // Base model
    if (selectionMask && paintables.length) {
        const n = selectionMask.length;
        const chunkMode = baseSpatialChunkingActive;
        for (const p of paintables) {
            const tex = p.gsplatComponent.getInstanceTexture('customSelection');
            if (!tex) continue;
            const d = tex.lock();
            if (!d) continue;
            const numTexels = tex.width * tex.height;
            if (chunkMode && p.chunkGlobalIndices) {
                const map = p.chunkGlobalIndices;
                const nk = Math.min(map.length, numTexels);
                for (let j = 0; j < nk; j++) {
                    const off = j * 4;
                    const g = map[j];
                    const v = g < n && selectionMask[g] ? 255 : 0;
                    d[off] = v; d[off + 1] = 0; d[off + 2] = 0; d[off + 3] = 255;
                }
            } else {
                for (let i = 0; i < Math.min(n, numTexels); i++) {
                    const off = i * 4;
                    const v = selectionMask[i] ? 255 : 0;
                    d[off] = v; d[off+1] = 0; d[off+2] = 0; d[off+3] = 255;
                }
            }
            tex.unlock();
        }
    }
    // User layers (remap mask indices → GPU storage order when PLY load reordered splats)
    for (const layer of layers) {
        if (!layer.selectionMask) continue;
        const entity = layersContainer.findByName(`layer-${layer.id}`);
        if (!entity?.gsplat) continue;
        writeLayerSelectionMaskToInstanceTexture(layer, entity.gsplat);
    }
};

const updateSelectionUI = () => {
    uploadSelectionToTexture();

    const activeMask = peekActiveSelectionMask();
    const count = hasSelection && activeMask ? activeMask.reduce((s, v) => s + v, 0) : 0;
    const label = hasSelection ? `${count.toLocaleString()} splats selected` : 'No selection';

    g('floating-gizmo-clear-wrap')?.classList.toggle('hidden', !hasSelection);
    g('floating-sel-clear')?.classList.toggle('sel-active', hasSelection);
    ['sel-count-label2','sel-count-label3','sel-count-label-brush','sel-count-label-lasso','sel-count-label-vector'].forEach(id => {
        const el = g(id); if (el) el.textContent = label;
    });

    // Base model paintables: show selection only when base is active
    const baseActive = selectedLayerId === 'base' || !selectedLayerId;
    const selColor = selectionHighlightColor();
    for (const p of paintables) {
        p.gsplatComponent.setParameter('uBlendMode',     blendMode());
        p.gsplatComponent.setParameter('uShowSelection', baseActive && hasSelection && showSelectionHighlight ? 1 : 0);
        p.gsplatComponent.setParameter('uSelectionColor', selColor);
        pushSplatViewShaderUniforms(p.gsplatComponent);
        pushLayerOpacityToGsplat(p.gsplatComponent, baseLayerOpacityPct);
    }

    // User layer entities: show selection only on the active layer
    for (const layer of layers) {
        const entity = layersContainer.findByName(`layer-${layer.id}`);
        if (!entity?.gsplat) continue;
        ensureLayerOpacityPct(layer);
        const isActive = selectedLayerId === layer.id;
        const layerHasSel = isActive && layer.selectionMask?.some(v => v > 0) && showSelectionHighlight;
        entity.gsplat.setParameter('uBlendMode',     blendMode());
        entity.gsplat.setParameter('uShowSelection', layerHasSel ? 1 : 0);
        entity.gsplat.setParameter('uSelectionColor', selColor);
        pushSplatViewShaderUniforms(entity.gsplat);
        pushLayerOpacityToGsplat(entity.gsplat, layer.opacityPct);
    }
    syncViewportSelectionFrame();
};

const saveSelection = () => {
    const name = (g('save-sel-name')?.value || '').trim();
    if (!name) return;
    const layer = getActiveLayer();
    const layerId = layer ? layer.id : 'base';
    const data = getActiveDataCache();
    if (!data) return;
    const n = data.numSplats;
    const mask = getActiveSelectionMask(n);
    const count = mask.reduce((s, v) => s + v, 0);
    if (count === 0) { alert('No selection to save.'); return; }
    const id = 'sel-' + Date.now();
    savedSelections.push({
        id, name, layerId, numSplats: n,
        mask: new Uint8Array(mask),
    });
    g('save-sel-name').value = '';
    renderSavedSelectionsList();
};

const loadSelection = (sel) => {
    const layer = getActiveLayer();
    const layerId = layer ? layer.id : 'base';
    if (sel.layerId !== layerId || sel.numSplats !== (getActiveDataCache()?.numSplats ?? 0)) {
        alert(`Selection "${sel.name}" was saved for a different layer or model (${sel.numSplats} splats).`);
        return;
    }
    const before = captureSelectionSnapshot();
    const n = sel.numSplats;
    const dest = getActiveSelectionMask(n);
    dest.set(sel.mask);
    hasSelection = sel.mask.some(v => v > 0);
    selectionSphere = [0, 0, 0, hasSelection ? 9999 : -1];
    updateSelectionUI();
    pushSelectionUndoFromBefore(before);
};

const deleteSavedSelection = (id) => {
    const i = savedSelections.findIndex(s => s.id === id);
    if (i >= 0) savedSelections.splice(i, 1);
    renderSavedSelectionsList();
};

const exportSelections = () => {
    if (savedSelections.length === 0) { alert('No selections to export.'); return; }
    const data = savedSelections.map(s => ({
        id: s.id,
        name: s.name,
        layerId: s.layerId,
        numSplats: s.numSplats,
        mask: Array.from(s.mask),
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    void triggerBlobDownload(blob, `splat-selections-${Date.now()}.json`);
};

const importSelections = () => {
    const input = g('import-sel-file');
    if (!input) return;
    input.value = '';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const arr = Array.isArray(data) ? data : [data];
            for (const item of arr) {
                if (!item.mask || !item.name) continue;
                const mask = new Uint8Array(item.mask);
                savedSelections.push({
                    id: 'sel-' + Date.now() + '-' + Math.random().toString(36).slice(2),
                    name: item.name,
                    layerId: item.layerId ?? 'base',
                    numSplats: item.numSplats ?? mask.length,
                    mask,
                });
            }
            renderSavedSelectionsList();
        } catch (err) {
            alert('Failed to load file: ' + (err?.message || String(err)));
        }
        input.onchange = null;
    };
    input.click();
};

/** `savedSelections[].layerId` uses `'base'` for the loaded model. */
const activeSavedSelectionLayerKey = () =>
    (selectedLayerId === 'base' || !selectedLayerId ? 'base' : selectedLayerId);

const renderSavedSelectionsList = () => {
    const list = g('saved-selections-list');
    if (!list) return;
    const lid = activeSavedSelectionLayerKey();
    const visible = savedSelections.filter((s) => s.layerId === lid);
    list.innerHTML = visible.map(s => `
        <div class="saved-sel-item">
            <span class="saved-sel-name" title="Load">${s.name}</span>
            <span class="saved-sel-count">${s.mask.reduce((a,b)=>a+b,0).toLocaleString()}</span>
            <button class="opt-btn small-btn" data-load="${s.id}" title="Load">Load</button>
            <button class="opt-btn small-btn" data-delete="${s.id}" title="Delete">×</button>
        </div>
    `).join('') || '<span class="opt-hint">No saved selections for this layer</span>';
    list.querySelectorAll('[data-load]').forEach(btn => {
        btn.addEventListener('click', () => {
            const sel = savedSelections.find(s => s.id === btn.dataset.load);
            if (sel) loadSelection(sel);
        });
    });
    list.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteSavedSelection(btn.dataset.delete));
    });
};

const addSwatch = () => {
    const hex = paintColorHex();
    if (!hex) return;
    swatches.push({ id: 'swatch-' + Date.now(), hex });
    persistSwatches();
    renderSwatchesList();
};

const useSwatch = (hex) => {
    const norm = normalizeBrushHex(hex);
    const input = g('paint-color');
    if (input && norm) input.value = norm;
    syncBrushHexFieldFromPicker();
    persistBrushColor();
};

const deleteSwatch = (id) => {
    const i = swatches.findIndex(s => s.id === id);
    if (i >= 0) swatches.splice(i, 1);
    persistSwatches();
    renderSwatchesList();
};

const renderSwatchesList = () => {
    const list = g('swatches-list');
    if (!list) return;
    list.innerHTML = swatches.map(s => `
        <div class="swatch-item" data-hex="${s.hex}" title="${s.hex}">
            <div class="swatch-color" style="background:${s.hex}"></div>
            <button class="opt-btn small-btn swatch-delete" data-id="${s.id}" title="Remove">×</button>
        </div>
    `).join('') || '<span class="opt-hint">No swatches</span>';
    list.querySelectorAll('.swatch-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (!e.target.closest('.swatch-delete')) useSwatch(el.dataset.hex);
        });
    });
    list.querySelectorAll('.swatch-delete').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); deleteSwatch(btn.dataset.id); });
    });
};

// ── Pixel loupe (magnified framebuffer) for color select & swatch pick-from-splat ──
const COLOR_LOUPE_GRID = 13;
const COLOR_LOUPE_ZOOM = 10;
let colorLoupeRaf = 0;
/** @type {{ cx: number, cy: number, clientX: number, clientY: number } | null} */
let colorLoupePending = null;
/** @type {HTMLCanvasElement | null} */
let colorLoupeScratch = null;

const colorLoupeShouldShow = () =>
    hasRenderableSplats() &&
    (activeTool === 'colorSelect' || awaitingSwatchSplatPick || !!awaitingSplitToneSplatPick);

const hideColorPixelLoupe = () => {
    colorLoupePending = null;
    const el = g('color-pixel-loupe');
    if (el) {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
    }
};

const flushColorPixelLoupe = () => {
    const p = colorLoupePending;
    colorLoupePending = null;
    if (!p || !colorLoupeShouldShow()) return;

    const wrap = g('color-pixel-loupe');
    const loupeCanvas = g('color-pixel-loupe-canvas');
    const hexEl = g('color-pixel-loupe-hex');
    if (!wrap || !loupeCanvas || !hexEl) return;

    const dev = app.graphicsDevice;
    const gsz = COLOR_LOUPE_GRID;
    const z = COLOR_LOUPE_ZOOM;
    const half = (gsz - 1) >> 1;
    const cw = dev.width;
    const ch = dev.height;

    let mx = (p.cx / canvas.clientWidth) * cw;
    let my = (p.cy / canvas.clientHeight) * ch;
    mx = Math.max(0, Math.min(cw - 1, mx));
    my = Math.max(0, Math.min(ch - 1, my));

    let gx = Math.floor(mx - half);
    let gy = Math.floor(my - half);
    gx = Math.max(0, Math.min(cw - gsz, gx));
    gy = Math.max(0, Math.min(ch - gsz, gy));

    if (!colorLoupeScratch) {
        colorLoupeScratch = document.createElement('canvas');
        colorLoupeScratch.width = gsz;
        colorLoupeScratch.height = gsz;
    }
    const sctx = colorLoupeScratch.getContext('2d');
    if (!sctx) return;
    try {
        sctx.imageSmoothingEnabled = false;
        sctx.drawImage(canvas, gx, gy, gsz, gsz, 0, 0, gsz, gsz);
    } catch (_) {
        return;
    }

    const sample = sctx.getImageData(half, half, 1, 1).data;
    const rh = sample[0];
    const gh = sample[1];
    const bh = sample[2];
    hexEl.textContent = `#${[rh, gh, bh].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

    const wPx = gsz * z;
    if (loupeCanvas.width !== wPx || loupeCanvas.height !== wPx) {
        loupeCanvas.width = wPx;
        loupeCanvas.height = wPx;
    }
    const lctx = loupeCanvas.getContext('2d');
    if (!lctx) return;
    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, wPx, wPx);
    lctx.drawImage(colorLoupeScratch, 0, 0, gsz, gsz, 0, 0, wPx, wPx);

    const cx = half * z;
    const cy = half * z;
    lctx.strokeStyle = 'rgba(255,255,255,0.9)';
    lctx.lineWidth = 2;
    lctx.strokeRect(cx + 0.5, cy + 0.5, z - 1, z - 1);
    lctx.strokeStyle = 'rgba(0,0,0,0.5)';
    lctx.lineWidth = 1;
    lctx.strokeRect(cx + 0.5, cy + 0.5, z - 1, z - 1);

    const pad = 18;
    const estW = wPx + 48;
    const estH = wPx + 52;
    let left = p.clientX + pad;
    let top = p.clientY + pad;
    if (left + estW > window.innerWidth - 6) left = p.clientX - estW - pad;
    if (top + estH > window.innerHeight - 6) top = p.clientY - estH - pad;
    left = Math.max(6, Math.min(left, window.innerWidth - estW));
    top = Math.max(6, Math.min(top, window.innerHeight - estH));
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.classList.remove('hidden');
    wrap.setAttribute('aria-hidden', 'false');
};

function cancelSwatchSplatPick() {
    if (!awaitingSwatchSplatPick) return;
    awaitingSwatchSplatPick = false;
    canvasContainer.classList.remove('swatch-splat-pick-armed');
    g('pick-swatch-splat-btn')?.classList.remove('accent-btn');
    hideColorPixelLoupe();
}

function cancelSplitToneSplatPick() {
    if (!awaitingSplitToneSplatPick) return;
    const key = awaitingSplitToneSplatPick;
    awaitingSplitToneSplatPick = null;
    canvasContainer.classList.remove('swatch-splat-pick-armed');
    g(`cg-wheel-${key}-pick-btn`)?.classList.remove('accent-btn');
    hideColorPixelLoupe();
}

canvasContainer.addEventListener('mousemove', (e) => {
    if (!colorLoupeShouldShow()) {
        hideColorPixelLoupe();
        return;
    }
    const rect = canvas.getBoundingClientRect();
    if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
    ) {
        hideColorPixelLoupe();
        return;
    }
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    colorLoupePending = { cx, cy, clientX: e.clientX, clientY: e.clientY };
    if (!colorLoupeRaf) {
        colorLoupeRaf = requestAnimationFrame(() => {
            colorLoupeRaf = 0;
            if (colorLoupeShouldShow() && colorLoupePending) flushColorPixelLoupe();
        });
    }
});

const splatDcToHex = (fdc0, fdc1, fdc2, idx) => {
    const sr = Math.max(0, Math.min(1, 0.5 + fdc0[idx] * SH_C0));
    const sg = Math.max(0, Math.min(1, 0.5 + fdc1[idx] * SH_C0));
    const sb = Math.max(0, Math.min(1, 0.5 + fdc2[idx] * SH_C0));
    const raw = `#${[sr, sg, sb]
        .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
        .join('')}`;
    return normalizeBrushHex(raw);
};

/** Uses active layer/base data; respects ring hit test when enabled. Call after strokeDepth is set for depth-based fallback. */
const pickSplatHexAtScreen = (screenX, screenY) => {
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    const layer = getActiveLayer();
    if (!data || !wEnt) return null;
    const { numSplats, x: xA, y: yA, z: zA, fdc0, fdc1, fdc2 } = data;
    let idx = -1;
    if (useRingHitSelection()) {
        const pr = pickFrontSplatAtScreen(screenX, screenY, data, layer, wEnt);
        if (pr != null) idx = pr;
    }
    if (idx < 0) {
        const worldPt = getWorldPoint(screenX, screenY);
        if (!worldPt) return null;
        const invMat = new pc.Mat4().copy(wEnt.getWorldTransform()).invert();
        const modelPt = new pc.Vec3();
        invMat.transformPoint(worldPt, modelPt);
        let nearestD2 = Infinity;
        for (let i = 0; i < numSplats; i++) {
            const dx = xA[i] - modelPt.x;
            const dy = yA[i] - modelPt.y;
            const dz = zA[i] - modelPt.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearestD2) { nearestD2 = d2; idx = i; }
        }
    }
    if (idx < 0) return null;
    const hex = splatDcToHex(fdc0, fdc1, fdc2, idx);
    return hex || null;
};

/** Uses active layer/base data; respects ring hit test when enabled. Call after strokeDepth is set for depth-based fallback. */
const addSwatchFromSplatAtScreen = (screenX, screenY) => {
    const hex = pickSplatHexAtScreen(screenX, screenY);
    if (!hex) return false;
    swatches.push({ id: 'swatch-' + Date.now(), hex });
    persistSwatches();
    renderSwatchesList();
    useSwatch(hex);
    return true;
};

const clearSelection = (opts = {}) => {
    const recordUndo = opts.recordUndo === true;
    const before = recordUndo ? captureSelectionSnapshot() : null;
    const layer = getActiveLayer();
    if (layer) {
        if (layer.selectionMask) layer.selectionMask.fill(0);
    } else {
        selectionMask?.fill(0);
    }
    hasSelection = false;
    selectionSphere = [0, 0, 0, -1];
    updateSelectionUI();
    if (recordUndo) pushSelectionUndoFromBefore(before);
};

/** Copy `src[kept[j]]` into a dense Float32Array (sync; used by delete-selection and similar). */
const filterArrayByKeptIndicesSync = (src, kept) => {
    if (!src || !kept.length) return null;
    const out = new Float32Array(kept.length);
    for (let j = 0; j < kept.length; j++) out[j] = src[kept[j]];
    return out;
};

const yieldOneFrame = () => new Promise((r) => requestAnimationFrame(r));

const yieldNextMacrotask = () => new Promise((r) => setTimeout(r, 0));

/** Chunked copy for delete-selection compaction — avoids multi‑second main-thread freezes. */
const FILTER_KEPT_YIELD_EVERY = 48_000;

const filterArrayByKeptIndicesAsync = async (src, kept) => {
    if (!src || !kept.length) return null;
    const len = kept.length;
    const out = new Float32Array(len);
    for (let j = 0; j < len; ) {
        const end = Math.min(j + FILTER_KEPT_YIELD_EVERY, len);
        for (; j < end; j++) out[j] = src[kept[j]];
        if (j < len) await yieldNextMacrotask();
    }
    return out;
};

/** Build `kept` (non-deleted indices) with periodic macrotask yields for huge clouds. */
const KEPT_SCAN_YIELD_EVERY = 200_000;

const buildKeptIndicesFromDeleteMaskAsync = async (delMaskCopy, n, kKeep) => {
    const kept = new Uint32Array(kKeep);
    let kw = 0;
    for (let i = 0; i < n; i++) {
        if (!delMaskCopy[i]) kept[kw++] = i;
        if (i > 0 && i % KEPT_SCAN_YIELD_EVERY === 0) await yieldNextMacrotask();
    }
    return kept;
};

/** Yield inside `getPaintFromGpu` merge loop so large clouds stay responsive (delete-selection). */
const GPU_PAINT_MERGE_YIELD_EVERY = 48_000;
/** Tighter cadence while finalizing delete (keeps UI/orbit responsive during merge). */
const DELETE_SEL_MERGE_YIELD_EVERY = 8192;

const yieldThreeFrames = async () => {
    await yieldOneFrame();
    await yieldOneFrame();
    await yieldOneFrame();
};

/**
 * One pass over `delMask`: stamps full erase into base `customOpacity` (same as eraser) and
 * returns how many splats are selected. Avoids an extra O(n) scan before the first paint.
 */
const countSelectedAndStampFullEraseBaseGpu = (delMask) => {
    if (!delMask?.length || !paintables.length || !gsplatDataCache) return 0;
    const nGlob = Math.min(delMask.length, gsplatDataCache.numSplats);
    if (baseSpatialChunkingActive) {
        let nDel = 0;
        for (const p of paintables) {
            const tex = p.gsplatComponent.getInstanceTexture('customOpacity');
            if (!tex) continue;
            const d = tex.lock();
            if (!d) continue;
            const numTexels = tex.width * tex.height;
            const map = p.chunkGlobalIndices;
            if (map) {
                const nk = Math.min(map.length, numTexels);
                for (let j = 0; j < nk; j++) {
                    const g = map[j];
                    if (g >= nGlob || !delMask[g]) continue;
                    nDel++;
                    const off = j * 4;
                    d[off] = 0;
                    d[off + 1] = 0;
                    d[off + 2] = 0;
                    d[off + 3] = 255;
                }
            } else {
                const n = Math.min(nGlob, numTexels);
                for (let i = 0; i < n; i++) {
                    if (!delMask[i]) continue;
                    nDel++;
                    const off = i * 4;
                    d[off] = 0;
                    d[off + 1] = 0;
                    d[off + 2] = 0;
                    d[off + 3] = 255;
                }
            }
            tex.unlock();
            p.gsplatComponent.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
        }
        return nDel;
    }
    const gsp = paintables[0].gsplatComponent;
    const tex = gsp.getInstanceTexture('customOpacity');
    if (!tex) return 0;
    const d = tex.lock();
    if (!d) return 0;
    const numTexels = tex.width * tex.height;
    const n = Math.min(nGlob, numTexels);
    let nDel = 0;
    for (let i = 0; i < n; i++) {
        if (!delMask[i]) continue;
        nDel++;
        const off = i * 4;
        d[off] = 0;
        d[off + 1] = 0;
        d[off + 2] = 0;
        d[off + 3] = 255;
    }
    tex.unlock();
    gsp.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
    return nDel;
};

/** Same as stampFullEraseOnBaseSelectionGpu for a user layer (CPU index → GPU texel map). */
const stampFullEraseOnLayerSelectionGpu = (layer) => {
    if (!layer?.selectionMask?.length || !layer._gsplatPaint?.gsplatComponent) return;
    const gsp = layer._gsplatPaint.gsplatComponent;
    const tex = gsp.getInstanceTexture('customOpacity');
    if (!tex) return;
    const d = tex.lock();
    if (!d) return;
    const numTexels = tex.width * tex.height;
    const map = layer._cpuToGpuSplat;
    const n = layer.selectionMask.length;
    for (let cpu = 0; cpu < n; cpu++) {
        if (!layer.selectionMask[cpu]) continue;
        const gpu = map ? map[cpu] : cpu;
        if (gpu < 0 || gpu >= numTexels) continue;
        const off = gpu * 4;
        d[off] = 0;
        d[off + 1] = 0;
        d[off + 2] = 0;
        d[off + 3] = 255;
    }
    tex.unlock();
    gsp.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
};

let removeSelectedSplatsBusy = false;

// ── Delete selection: PLY encode off main thread (writePly blocks for large clouds) ─
let plyDeleteWorker = null;
let plyDeleteWorkerJobId = 1;
/** @type {Map<number, { resolve: (b: ArrayBuffer) => void, reject: (e: Error) => void }>} */
const plyDeleteWorkerCallbacks = new Map();

const ensurePlyDeleteWorker = () => {
    if (plyDeleteWorker) return plyDeleteWorker;
    plyDeleteWorker = new Worker(new URL('./delete-selection-ply-worker.js', import.meta.url), { type: 'module' });
    plyDeleteWorker.onmessage = (ev) => {
        const { id, buffer, error } = ev.data;
        const cb = plyDeleteWorkerCallbacks.get(id);
        if (!cb) return;
        plyDeleteWorkerCallbacks.delete(id);
        if (error) cb.reject(new Error(error));
        else cb.resolve(buffer);
    };
    plyDeleteWorker.onerror = (ev) => {
        const err = new Error(ev.message || 'PLY worker failed');
        for (const [, cbs] of plyDeleteWorkerCallbacks) cbs.reject(err);
        plyDeleteWorkerCallbacks.clear();
        try {
            plyDeleteWorker?.terminate();
        } catch (_) { /* ignore */ }
        plyDeleteWorker = null;
    };
    return plyDeleteWorker;
};

// ── Delete selection: merge GPU readback (O(n)) off main thread (keeps UI alive) ─
let gpuMergeWorker = null;
let gpuMergeWorkerJobId = 1;
/** @type {Map<number, { resolve: (v: object) => void, reject: (e: Error) => void }>} */
const gpuMergeWorkerCallbacks = new Map();

/** Below this splat count, inline merge is cheaper than worker setup + copies. */
const MIN_SPLATS_FOR_GPU_MERGE_WORKER = 8192;

const ensureGpuMergeWorker = () => {
    if (gpuMergeWorker) return gpuMergeWorker;
    gpuMergeWorker = new Worker(new URL('./delete-selection-gpu-merge-worker.js', import.meta.url), { type: 'module' });
    gpuMergeWorker.onmessage = (ev) => {
        const { id, out0, out1, out2, outOp, error } = ev.data;
        const cb = gpuMergeWorkerCallbacks.get(id);
        if (!cb) return;
        gpuMergeWorkerCallbacks.delete(id);
        if (error) cb.reject(new Error(error));
        else {
            cb.resolve({
                out0: new Float32Array(out0),
                out1: new Float32Array(out1),
                out2: new Float32Array(out2),
                outOp: new Float32Array(outOp),
            });
        }
    };
    gpuMergeWorker.onerror = (ev) => {
        const err = new Error(ev.message || 'GPU merge worker failed');
        for (const [, cbs] of gpuMergeWorkerCallbacks) cbs.reject(err);
        gpuMergeWorkerCallbacks.clear();
        try {
            gpuMergeWorker?.terminate();
        } catch (_) { /* ignore */ }
        gpuMergeWorker = null;
    };
    return gpuMergeWorker;
};

const mergeGpuPaintReadbackInWorker = (n, w, h, curBlend, colorData, opacityData, fdc0, fdc1, fdc2, opacity) =>
    new Promise((resolve, reject) => {
        const id = gpuMergeWorkerJobId++;
        gpuMergeWorkerCallbacks.set(id, { resolve, reject });
        const colorBytes = colorData instanceof Uint8Array
            ? colorData
            : new Uint8Array(colorData.buffer, colorData.byteOffset, colorData.byteLength);
        const opacityBytes = opacityData instanceof Uint8Array
            ? opacityData
            : new Uint8Array(opacityData.buffer, opacityData.byteOffset, opacityData.byteLength);
        const colorCopy = new Uint8Array(colorBytes);
        const opacityCopy = new Uint8Array(opacityBytes);
        const f0 = new Float32Array(fdc0);
        const f1 = new Float32Array(fdc1);
        const f2 = new Float32Array(fdc2);
        const op = new Float32Array(opacity);
        const transfer = [
            colorCopy.buffer,
            opacityCopy.buffer,
            f0.buffer,
            f1.buffer,
            f2.buffer,
            op.buffer,
        ];
        try {
            ensureGpuMergeWorker().postMessage(
                {
                    id,
                    n,
                    w,
                    h,
                    curBlend,
                    colorBuffer: colorCopy.buffer,
                    opacityBuffer: opacityCopy.buffer,
                    f0Buffer: f0.buffer,
                    f1Buffer: f1.buffer,
                    f2Buffer: f2.buffer,
                    opBuffer: op.buffer,
                },
                transfer,
            );
        } catch (err) {
            gpuMergeWorkerCallbacks.delete(id);
            reject(err);
        }
    });

/**
 * Encode compacted splats as binary little-endian PLY in a Web Worker (copies column data; originals stay valid).
 */
const encodeSplatsPlyBinaryWithWorker = (columns) =>
    new Promise((resolve, reject) => {
        if (!columns?.length) {
            reject(new Error('no columns'));
            return;
        }
        const rowCount = columns[0].data.length;
        const names = [];
        const buffers = [];
        for (const col of columns) {
            if (col.data.length !== rowCount) {
                reject(new Error(`column length mismatch: ${col.name}`));
                return;
            }
            names.push(col.name);
            const a = col.data;
            buffers.push(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
        }
        if (typeof Worker === 'undefined') {
            reject(new Error('Worker unavailable'));
            return;
        }
        const id = plyDeleteWorkerJobId++;
        plyDeleteWorkerCallbacks.set(id, { resolve, reject });
        try {
            ensurePlyDeleteWorker().postMessage({ id, names, rowCount, buffers }, buffers);
        } catch (err) {
            plyDeleteWorkerCallbacks.delete(id);
            reject(err);
        }
    });

/** While set, a base-model delete is still merging / encoding / reloading (Delete returns immediately). */
let baseDeleteCompactionPromise = null;
/** Keep selection-delete instant by default; compaction/reload can stall on large clouds. */
const AUTO_COMPACT_ON_BASE_SELECTION_DELETE = false;
/** Same policy for user layers: avoid immediate entity rebuild after selection delete. */
const AUTO_COMPACT_ON_LAYER_SELECTION_DELETE = false;

/** Chunked in-memory compaction for user-layer splat arrays after selection delete. */
const LAYER_DELETE_FILTER_YIELD_EVERY = 40_000;
const compactLayerSplatsByMaskAsync = async (layer, delMaskCopy) => {
    if (!layer?.splats?.length || !delMaskCopy?.length) return;
    const src = layer.splats;
    const out = [];
    for (let i = 0; i < src.length; i++) {
        if (!delMaskCopy[i]) out.push(src[i]);
        if (i > 0 && i % LAYER_DELETE_FILTER_YIELD_EVERY === 0) await yieldNextMacrotask();
    }
    layer.splats = out;
    try {
        await updateLayerEntity(layer);
        applyModelRotation();
        refreshLayerGizmoAttachment();
    } catch (e) {
        console.error('[layer] rebuild after selection delete', e);
    }
};

/**
 * Heavy path after instant GPU erase: merge paint, build compact PLY, replace base gsplat.
 * Runs async so Delete/Backspace is not blocked for seconds. Keeps `selectionMask` until paint
 * merge finishes so bucket stroke replay stays correct; clears it after.
 */
const runBaseSelectionDeleteCompaction = async (n, delMaskCopy, nDel) => {
    const cache = gsplatDataCache;
    if (!cache || cache.numSplats !== n) return;

    instructions.innerHTML = '<p>Finalizing delete…</p>';

    try {
        await yieldOneFrame();
        await yieldOneFrame();
        await yieldNextMacrotask();

        let painted;
        if (strokes.length === 0) {
            painted = applyAllCpuStrokes();
        } else {
            painted = (await getPaintFromGpu({
                yieldEvery: DELETE_SEL_MERGE_YIELD_EVERY,
                yieldBetweenTextureReads: true,
                useWorkerMerge: true,
                flushGpuBeforeRead: true,
            })) ?? applyAllCpuStrokes();
        }

        selectionMask = null;
        updateSelectionUI();

        ensureBaseGsplatShRestHydratedFromDeferred();
        const { x: xA, y: yA, z: zA, shRest, extra } = cache;
        const out0 = painted?.out0 ?? cache.fdc0;
        const out1 = painted?.out1 ?? cache.fdc1;
        const out2 = painted?.out2 ?? cache.fdc2;
        const outOp = painted?.outOp ?? cache.opacity;

        const kKeep = n - nDel;
        const kept = await buildKeptIndicesFromDeleteMaskAsync(delMaskCopy, n, kKeep);

        const columns = [];
        const addColDel = async (name, data) => {
            if (!data) return;
            const colData = await filterArrayByKeptIndicesAsync(data, kept);
            if (colData) columns.push(new Column(name, colData));
            await yieldNextMacrotask();
        };
        await addColDel('x', xA);
        await addColDel('y', yA);
        await addColDel('z', zA);
        await addColDel('nx', extra.nx);
        await addColDel('ny', extra.ny);
        await addColDel('nz', extra.nz);
        await addColDel('f_dc_0', out0);
        await addColDel('f_dc_1', out1);
        await addColDel('f_dc_2', out2);
        for (const sh of shRest) await addColDel(sh.key, sh.data);
        await addColDel('opacity', outOp);
        await addColDel('scale_0', extra.scale_0);
        await addColDel('scale_1', extra.scale_1);
        await addColDel('scale_2', extra.scale_2);
        await addColDel('rot_0', extra.rot_0);
        await addColDel('rot_1', extra.rot_1);
        await addColDel('rot_2', extra.rot_2);
        await addColDel('rot_3', extra.rot_3);

        await yieldNextMacrotask();

        let buffer;
        try {
            buffer = await encodeSplatsPlyBinaryWithWorker(columns);
        } catch (werr) {
            console.warn('[delete-sel] worker PLY encode failed, using main thread', werr);
            const table = new DataTable(columns);
            const memFs = new MemoryFileSystem();
            const filename = 'painted.ply';
            await writePly(
                { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
                memFs,
            );
            buffer = memFs.results?.get(filename);
            if (!buffer) {
                alert('Remove failed.');
                return;
            }
        }

        await yieldNextMacrotask();

        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const file = new File([blob], 'painted.ply', { type: 'application/octet-stream' });
        await replaceBaseModelWithPlyFile(file, {
            preserveCamera: true,
            skipAuthGate: true,
            staggerHeavyInit: true,
        });
    } catch (err) {
        console.error('[delete-sel] compaction', err);
        alert(`Could not finish deleting selection: ${err?.message || err}`);
    } finally {
        if (instructions.textContent?.includes('Finalizing delete')) instructions.innerHTML = '';
    }
};

const removeSelectedSplats = async () => {
    if (removeSelectedSplatsBusy) return;
    if (baseDeleteCompactionPromise) return;
    removeSelectedSplatsBusy = true;
    try {
        // ── User layer: CPU removal ──────────────────────────────────────────────
        const activeLayer = getActiveLayer();
        if (activeLayer) {
            if (!hasSelection || !activeLayer.selectionMask) return;
            const delMaskCopy = new Uint8Array(activeLayer.selectionMask);
            stampFullEraseOnLayerSelectionGpu(activeLayer);
            await yieldThreeFrames();
            await yieldNextMacrotask();
            activeLayer.selectionMask = null;
            hasSelection = false;
            selectionSphere = [0, 0, 0, -1];
            updateSelectionUI();
            if (AUTO_COMPACT_ON_LAYER_SELECTION_DELETE) {
                const before = activeLayer.splats.length;
                activeLayer.splats = activeLayer.splats.filter((_, i) => !delMaskCopy[i]);
                if (activeLayer.splats.length === before) { clearSelection(); return; }
                await updateLayerEntity(activeLayer);
            } else {
                // Keep this path snappy: compact in-memory splats without reloading layer entity now.
                void compactLayerSplatsByMaskAsync(activeLayer, delMaskCopy);
            }
            return;
        }

        // ── Base model: instant GPU erase, then async compaction (no long main-thread block) ─
        if (!gsplatDataCache || !hasSelection || !selectionMask) return;
        const n = gsplatDataCache.numSplats;
        const delMaskCopy = new Uint8Array(selectionMask);

        drainPendingPaints();

        const nDel = countSelectedAndStampFullEraseBaseGpu(delMaskCopy);
        if (nDel === 0) { clearSelection(); return; }
        if (nDel === n) { alert('Cannot remove all splats.'); return; }

        await yieldThreeFrames();
        await yieldNextMacrotask();

        hasSelection = false;
        selectionSphere = [0, 0, 0, -1];
        updateSelectionUI();

        if (AUTO_COMPACT_ON_BASE_SELECTION_DELETE) {
            baseDeleteCompactionPromise = (async () => {
                await yieldOneFrame();
                await yieldNextMacrotask();
                await runBaseSelectionDeleteCompaction(n, delMaskCopy, nDel);
            })().finally(() => {
                baseDeleteCompactionPromise = null;
            });
        } else {
            // Keep delete responsive: hide on GPU but CPU pick/selection must ignore removed indices.
            if (!baseSplatAliveMask || baseSplatAliveMask.length !== n) resetBaseSplatAliveMask(n);
            for (let i = 0; i < n; i++) {
                if (delMaskCopy[i]) baseSplatAliveMask[i] = 0;
            }
            selectionMask = null;
        }
    } finally {
        removeSelectedSplatsBusy = false;
    }
};

const sharpenSelectedSplats = async () => {
    // All three sharpen sliders are kept in sync; read from whichever is non-zero.
    const sharpenStrength = parseFloat(
        g('sharpen-strength')?.value ?? g('sharpen-strength2')?.value ?? g('sharpen-strength3')?.value ?? '0.5'
    );
    // sharpenStrength ∈ [0, 1]: 0 = no change, 1 = maximum shrink
    // In log-scale a negative delta makes the Gaussian smaller:
    //   new_scale = old_scale - delta   (delta > 0 → smaller Gaussian)
    // We map strength [0,1] to a log-space reduction of [0, 3.5] (3.5 covers
    // the full clamped range from -2 to -5.5 used when generating fill splats).
    const delta = sharpenStrength * 3.5;

    // ── User layer: in-memory modification + rebuild ────────────────────────
    const activeLayer = getActiveLayer();
    if (activeLayer) {
        if (!hasSelection || !activeLayer.selectionMask) return;
        let changed = false;
        activeLayer.splats.forEach((s, i) => {
            if (!activeLayer.selectionMask[i]) return;
            s.scale_0 = Math.max(-6.0, s.scale_0 - delta);
            s.scale_1 = Math.max(-6.0, s.scale_1 - delta);
            s.scale_2 = Math.max(-6.0, s.scale_2 - delta);
            changed = true;
        });
        if (!changed) return;
        await updateLayerEntity(activeLayer);
        return;
    }

    // ── Base model: PLY rebuild ─────────────────────────────────────────────
    if (!gsplatDataCache || !hasSelection || !selectionMask) return;

    ensureBaseGsplatShRestHydratedFromDeferred();
    const { x: xA, y: yA, z: zA, shRest, extra } = gsplatDataCache;
    const n = gsplatDataCache.numSplats;
    const painted = applyAllCpuStrokes();
    const out0  = painted?.out0  ?? gsplatDataCache.fdc0;
    const out1  = painted?.out1  ?? gsplatDataCache.fdc1;
    const out2  = painted?.out2  ?? gsplatDataCache.fdc2;
    const outOp = painted?.outOp ?? gsplatDataCache.opacity;

    // Build modified scale arrays: reduce log-scale for selected splats
    const mkScale = (src) => {
        const arr = new Float32Array(src);
        for (let i = 0; i < n; i++) {
            if (selectionMask[i]) arr[i] = Math.max(-6.0, arr[i] - delta);
        }
        return arr;
    };
    const newScale0 = mkScale(extra.scale_0);
    const newScale1 = mkScale(extra.scale_1);
    const newScale2 = mkScale(extra.scale_2);

    const columns = [];
    const addCol = (name, data) => { if (data) columns.push(new Column(name, new Float32Array(data))); };
    addCol('x', xA); addCol('y', yA); addCol('z', zA);
    addCol('nx', extra.nx); addCol('ny', extra.ny); addCol('nz', extra.nz);
    addCol('f_dc_0', out0); addCol('f_dc_1', out1); addCol('f_dc_2', out2);
    for (const sh of shRest) addCol(sh.key, sh.data);
    addCol('opacity', outOp);
    columns.push(new Column('scale_0', newScale0));
    columns.push(new Column('scale_1', newScale1));
    columns.push(new Column('scale_2', newScale2));
    addCol('rot_0', extra.rot_0); addCol('rot_1', extra.rot_1);
    addCol('rot_2', extra.rot_2); addCol('rot_3', extra.rot_3);

    const table = new DataTable(columns);
    const memFs = new MemoryFileSystem();
    const filename = 'painted.ply';
    await writePly(
        { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
        memFs,
    );
    const buffer = memFs.results?.get(filename);
    if (!buffer) { alert('Sharpen failed.'); return; }
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const file = new File([blob], 'painted.ply', { type: 'application/octet-stream' });
    await loadSplat(file, { preserveCamera: true, skipAuthGate: true });
};

const selectAll = (opts = {}) => {
    const recordUndo = opts.recordUndo === true;
    const before = recordUndo ? captureSelectionSnapshot() : null;
    const data = getActiveDataCache();
    if (!data) return;
    const n = data.numSplats;
    const mask = getActiveSelectionMask(n);
    if (!data.isLayerData && baseSplatAliveMask) {
        for (let i = 0; i < n; i++) mask[i] = isBaseSplatAlive(i) ? 1 : 0;
    } else {
        mask.fill(1);
    }
    hasSelection = true;
    selectionSphere = [0, 0, 0, 9999];
    updateSelectionUI();
    if (recordUndo) pushSelectionUndoFromBefore(before);
};

/** Closed screen polygon (≥3 points). Same depth / ring rules as box select. */
const applyPolygonSelection = (poly, mode = selectionMode) => {
    if (!poly || poly.length < 3) return;
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    const layer = getActiveLayer();
    if (!data || !wEnt) return;
    const { numSplats, x: xA, y: yA, z: zA } = data;
    const mask = getActiveSelectionMask(numSplats);

    const worldMat = wEnt.getWorldTransform();
    const worldPt = new pc.Vec3();
    const screenPt = new pc.Vec3();
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let cnt = 0;

    const applyInRegion = (inside, i) => {
        if (mode === 'new') mask[i] = inside ? 1 : 0;
        else if (mode === 'add') { if (inside) mask[i] = 1; }
        else if (mode === 'subtract') { if (inside) mask[i] = 0; }
        if (mask[i]) {
            sumX += xA[i]; sumY += yA[i]; sumZ += zA[i]; cnt++;
        }
    };

    const camPos = cameraEntity.getPosition();
    const collectCenterHits = () => {
        const hits = [];
        for (let i = 0; i < numSplats; i++) {
            if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
            worldMat.transformPoint(new pc.Vec3(xA[i], yA[i], zA[i]), worldPt);
            cameraEntity.camera.worldToScreen(worldPt, screenPt);
            if (screenPt.z < 0) continue;
            if (!pointInPolygon(screenPt.x, screenPt.y, poly)) continue;
            hits.push({ i, d: worldPt.distance(camPos) });
        }
        return hits;
    };

    let hits = [];
    if (useRingHitSelection()) {
        for (let i = 0; i < numSplats; i++) {
            const e = getSplatScreenEllipse(data, layer, i, wEnt);
            if (!e) continue;
            if (splatEllipseIntersectsPolygon(e, poly)) hits.push({ i, d: e.distCam });
        }
        if (!hits.length) hits = collectCenterHits();
    } else {
        hits = collectCenterHits();
    }

    const selected = filterHitsBySelectionDepth(hits);
    for (let i = 0; i < numSplats; i++) {
        applyInRegion(selected.has(i), i);
    }

    hasSelection = mask.some(v => v > 0);
    if (hasSelection && cnt > 0) {
        const cx = sumX/cnt, cy = sumY/cnt, cz = sumZ/cnt;
        let maxD = 0;
        for (let i = 0; i < numSplats; i++) {
            if (!mask[i]) continue;
            const dx = xA[i]-cx, dy = yA[i]-cy, dz = zA[i]-cz;
            const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
            if (d > maxD) maxD = d;
        }
        selectionSphere = [cx, cy, cz, maxD];
    } else if (mode === 'new') {
        selectionSphere = [0, 0, 0, -1];
    }
    updateSelectionUI();
};

const applyBoxSelection = (x1, y1, x2, y2, mode = selectionMode) => {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    applyPolygonSelection(
        [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }],
        mode,
    );
};

/** Close poly by repeating first vertex if needed (for point-in-polygon). */
const closeSelectionPoly = (pts) => {
    if (!pts || pts.length < 3) return null;
    const out = pts.map((p) => ({ x: p.x, y: p.y }));
    const a = out[0], b = out[out.length - 1];
    if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > 9) out.push({ ...a });
    return out;
};

let lassoEffectiveMode = null;

const redrawSelectionOverlays = () => {
    if (!selectionOverlaySvg) return;
    let html = '';
    if (activeTool === 'lassoSelect' && lassoDragActive && lassoPoints.length >= 2) {
        const d = lassoPoints.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
        html += `<path d="${d}" fill="none" stroke="rgba(170,210,255,0.95)" stroke-width="1.5"/>`;
    }
    if (activeTool === 'vectorSelect' && vectorPolyPoints.length) {
        const pts = vectorPolyPoints.map((p) => `${p.x},${p.y}`).join(' ');
        html += `<polyline points="${pts}" fill="none" stroke="rgba(170,210,255,0.95)" stroke-width="1.5"/>`;
        if (vectorHoverScreen) {
            const last = vectorPolyPoints[vectorPolyPoints.length - 1];
            html += `<line x1="${last.x}" y1="${last.y}" x2="${vectorHoverScreen.x}" y2="${vectorHoverScreen.y}" stroke="rgba(170,210,255,0.45)" stroke-width="1" stroke-dasharray="4 3"/>`;
        }
        const f = vectorPolyPoints[0];
        html += `<circle cx="${f.x}" cy="${f.y}" r="4" fill="none" stroke="rgba(140,230,170,0.9)" stroke-width="1.2"/>`;
    }
    selectionOverlaySvg.innerHTML = html;
};

// ── Shared selection helpers ──────────────────────────────────────────────────
// Recompute selectionSphere to the bounding sphere of all selected splats.
const recomputeSelectionSphere = () => {
    const data = getActiveDataCache();
    const mask = peekActiveSelectionMask();
    if (!data || !mask) { hasSelection = false; selectionSphere = [0,0,0,-1]; return; }
    const { numSplats, x: xA, y: yA, z: zA } = data;
    if (!data.isLayerData && baseSplatAliveMask) {
        for (let i = 0; i < numSplats; i++) {
            if (mask[i] && !isBaseSplatAlive(i)) mask[i] = 0;
        }
    }
    hasSelection = mask.some(v => v > 0);
    if (!hasSelection) { selectionSphere = [0, 0, 0, -1]; return; }

    let cnt = 0, sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < numSplats; i++) {
        if (mask[i]) { sumX += xA[i]; sumY += yA[i]; sumZ += zA[i]; cnt++; }
    }
    const cx = sumX/cnt, cy = sumY/cnt, cz = sumZ/cnt;
    let maxD = 0;
    for (let i = 0; i < numSplats; i++) {
        if (!mask[i]) continue;
        const dx = xA[i]-cx, dy = yA[i]-cy, dz = zA[i]-cz;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d > maxD) maxD = d;
    }
    selectionSphere = [cx, cy, cz, maxD];
};

// Select all splats whose color is within tolerance of the splat nearest worldPt.
const applyColorSelection = (worldPt, mode = selectionMode, screenX, screenY) => {
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    const layer = getActiveLayer();
    if (!data || !wEnt) return;
    const { numSplats, x: xA, y: yA, z: zA, fdc0, fdc1, fdc2 } = data;
    const mask = getActiveSelectionMask(numSplats);

    const invMat = new pc.Mat4().copy(wEnt.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    let nearestIdx = -1;
    if (useRingHitSelection() && screenX != null && screenY != null) {
        const pr = pickFrontSplatAtScreen(screenX, screenY, data, layer, wEnt);
        if (pr != null) nearestIdx = pr;
    }
    if (nearestIdx < 0) {
        let nearestD2 = Infinity;
        for (let i = 0; i < numSplats; i++) {
            if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
            const dx = xA[i] - modelPt.x;
            const dy = yA[i] - modelPt.y;
            const dz = zA[i] - modelPt.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearestD2) { nearestD2 = d2; nearestIdx = i; }
        }
    }
    if (nearestIdx < 0) return;

    const tR = Math.max(0, 0.5 + fdc0[nearestIdx] * SH_C0);
    const tG = Math.max(0, 0.5 + fdc1[nearestIdx] * SH_C0);
    const tB = Math.max(0, 0.5 + fdc2[nearestIdx] * SH_C0);
    const tol = colorTolerance();

    for (let i = 0; i < numSplats; i++) {
        if (!data.isLayerData && !isBaseSplatAlive(i)) {
            if (mode === 'new') mask[i] = 0;
            continue;
        }
        const r = Math.max(0, 0.5 + fdc0[i] * SH_C0);
        const g = Math.max(0, 0.5 + fdc1[i] * SH_C0);
        const b = Math.max(0, 0.5 + fdc2[i] * SH_C0);
        const dist = Math.sqrt((r-tR)**2 + (g-tG)**2 + (b-tB)**2);
        const inside = dist <= tol;
        if      (mode === 'new')      mask[i] = inside ? 1 : 0;
        else if (mode === 'add')      { if (inside) mask[i] = 1; }
        else if (mode === 'subtract') { if (inside) mask[i] = 0; }
    }

    recomputeSelectionSphere();
    updateSelectionUI();
};

// Paint selection with brush: select/deselect splats under the brush sphere.
let brushSelectEffectiveMode = null;  // Set at mousedown when Alt; used for whole drag
const brushSelectAt = (screenX, screenY, mode = brushSelectEffectiveMode ?? selectionMode) => {
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    if (!data || !wEnt) return;
    const { numSplats, x: xA, y: yA, z: zA } = data;
    const mask = getActiveSelectionMask(numSplats);

    const worldPt = getWorldPoint(screenX, screenY);
    if (!worldPt) return;

    const worldRadius = brushSelectSize();
    const spacing    = brushSelectSpacing();
    if (lastBrushSelectWorld && worldPt.distance(lastBrushSelectWorld) < worldRadius * 2 * spacing)
        return;
    lastBrushSelectWorld = worldPt.clone();

    if (mode === 'new' && brushSelectFirstDab) {
        mask.fill(0);
        brushSelectFirstDab = false;
    }

    const invMat = new pc.Mat4().copy(wEnt.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    const refW = new pc.Vec3(worldPt.x + worldRadius, worldPt.y, worldPt.z);
    const refM = new pc.Vec3();
    invMat.transformPoint(refW, refM);
    const modelRadius = modelPt.distance(refM);
    const r2 = modelRadius * modelRadius;

    const layer = getActiveLayer();
    if (useRingHitSelection()) {
        const ringHits = [];
        for (let i = 0; i < numSplats; i++) {
            if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
            const e = getSplatScreenEllipse(data, layer, i, wEnt);
            if (e && screenHitsSplatEllipse(screenX, screenY, e)) {
                ringHits.push({ i, d: e.distCam });
            }
        }
        if (ringHits.length) {
            const sel = filterHitsBySelectionDepth(ringHits);
            for (const h of ringHits) {
                if (!sel.has(h.i)) continue;
                if (mode === 'new' || mode === 'add') mask[h.i] = 1;
                else if (mode === 'subtract') mask[h.i] = 0;
            }
        }
    } else {
        for (let i = 0; i < numSplats; i++) {
            if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
            const dx = xA[i] - modelPt.x;
            const dy = yA[i] - modelPt.y;
            const dz = zA[i] - modelPt.z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            if (mode === 'new' || mode === 'add') mask[i] = 1;
            else if (mode === 'subtract') mask[i] = 0;
        }
    }

    hasSelection = mask.some(v => v > 0);
    recomputeSelectionSphere();
    updateSelectionUI();
};

// ── Splat Select tool ────────────────────────────────────────────────────────
// Click to select the single nearest splat, or drag to select all within a radius.
let isSplatSelecting = false;

const splatPickAt = (screenX, screenY, addToSel) => {
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    const layer = getActiveLayer();
    if (!data || !wEnt) return;
    const { numSplats, x: xA, y: yA, z: zA } = data;
    const worldPt = getWorldPoint(screenX, screenY);
    if (!worldPt) return;

    const invMat = new pc.Mat4().copy(wEnt.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    const mask = getActiveSelectionMask(numSplats);
    if (!addToSel) mask.fill(0);

    let nearestIdx = -1;
    if (useRingHitSelection()) {
        const pr = pickFrontSplatAtScreen(screenX, screenY, data, layer, wEnt);
        if (pr != null) nearestIdx = pr;
    }
    if (nearestIdx < 0) {
        let nearestD2 = Infinity;
        for (let i = 0; i < numSplats; i++) {
            if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
            const dx = xA[i] - modelPt.x;
            const dy = yA[i] - modelPt.y;
            const dz = zA[i] - modelPt.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearestD2) { nearestD2 = d2; nearestIdx = i; }
        }
    }
    if (nearestIdx < 0) return;

    mask[nearestIdx] = 1;
    hasSelection = true;
    recomputeSelectionSphere();
    updateSelectionUI();
};

// Drag-select: select all splats within world radius of a point
const splatDragSelectAt = (screenX, screenY, addToSel) => {
    const data = getActiveDataCache();
    const wEnt = getWorldMatEntityForActiveTarget();
    const layer = getActiveLayer();
    if (!data || !wEnt) return;
    const { numSplats, x: xA, y: yA, z: zA } = data;
    const worldPt = getWorldPoint(screenX, screenY);
    if (!worldPt) return;

    const invMat = new pc.Mat4().copy(wEnt.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    const refW = new pc.Vec3(worldPt.x + brushSize(), worldPt.y, worldPt.z);
    const refM = new pc.Vec3();
    invMat.transformPoint(refW, refM);
    const modelRadius = modelPt.distance(refM);
    const r2 = modelRadius * modelRadius;

    const mask = getActiveSelectionMask(numSplats);
    if (!addToSel) mask.fill(0);

    const picks = [];
    for (let i = 0; i < numSplats; i++) {
        if (!data.isLayerData && !isBaseSplatAlive(i)) continue;
        if (useRingHitSelection()) {
            const e = getSplatScreenEllipse(data, layer, i, wEnt);
            if (!e || !screenHitsSplatEllipse(screenX, screenY, e)) continue;
            picks.push({ i, d: e.distCam });
        } else {
            const dx = xA[i] - modelPt.x;
            const dy = yA[i] - modelPt.y;
            const dz = zA[i] - modelPt.z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            picks.push({ i, d: 0 });
        }
    }

    let any = false;
    if (useRingHitSelection() && picks.length) {
        const sel = filterHitsBySelectionDepth(picks);
        for (const p of picks) {
            if (!sel.has(p.i)) continue;
            mask[p.i] = 1;
            any = true;
        }
    } else {
        for (const p of picks) {
            mask[p.i] = 1;
            any = true;
        }
    }
    if (any) {
        hasSelection = true;
        recomputeSelectionSphere();
        updateSelectionUI();
    }
};

// ── Generate Splats tool ─────────────────────────────────────────────────────
// Sample color from base splat at world point (nearest splat's f_dc)
const sampleColorAt = (worldPt) => {
    if (!gsplatDataCache || !paintables.length) return;
    const { numSplats, x: xA, y: yA, z: zA, fdc0, fdc1, fdc2 } = gsplatDataCache;
    const invMat = new pc.Mat4().copy(paintables[0].entity.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    let nearestIdx = -1, nearestD2 = Infinity;
    for (let i = 0; i < numSplats; i++) {
        if (!isBaseSplatAlive(i)) continue;
        const dx = xA[i] - modelPt.x, dy = yA[i] - modelPt.y, dz = zA[i] - modelPt.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearestD2) { nearestD2 = d2; nearestIdx = i; }
    }
    if (nearestIdx < 0) return;

    const sr = Math.max(0, Math.min(1, 0.5 + fdc0[nearestIdx] * SH_C0));
    const sg = Math.max(0, Math.min(1, 0.5 + fdc1[nearestIdx] * SH_C0));
    const sb = Math.max(0, Math.min(1, 0.5 + fdc2[nearestIdx] * SH_C0));
    generateSplatsSampledColor = [sr, sg, sb];
    const colorBox = g('generate-splats-color');
    if (colorBox) colorBox.style.background = `rgb(${Math.round(sr*255)},${Math.round(sg*255)},${Math.round(sb*255)})`;
};

// Count existing splats (base + all layers) within model-space radius of center
const countSplatsInRadius = (modelCenter, modelRadius) => {
    let count = 0;
    const r2 = modelRadius * modelRadius;
    if (gsplatDataCache) {
        const { numSplats, x: xA, y: yA, z: zA } = gsplatDataCache;
        for (let i = 0; i < numSplats; i++) {
            if (!isBaseSplatAlive(i)) continue;
            const dx = xA[i] - modelCenter.x, dy = yA[i] - modelCenter.y, dz = zA[i] - modelCenter.z;
            if (dx * dx + dy * dy + dz * dz <= r2) count++;
        }
    }
    for (const layer of layers) {
        for (const s of layer.splats) {
            const dx = s.x - modelCenter.x, dy = s.y - modelCenter.y, dz = s.z - modelCenter.z;
            if (dx * dx + dy * dy + dz * dz <= r2) count++;
        }
    }
    return count;
};

// ── Parametric shape generators ───────────────────────────────────────────────
// Each returns an array of {x,y,z} points, centred at origin.
// hollow: true → wireframe / edges only. false → filled shell or solid volume (per shape).

/** Distribute n points along 3D segments {a,b}; count per edge scales with edge length. */
const distributeOnEdges = (edges, n) => {
    if (!edges.length || n <= 0) return [];
    const lens = edges.map((e) => {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dz = e.b.z - e.a.z;
        return Math.max(1e-8, Math.hypot(dx, dy, dz));
    });
    const sum = lens.reduce((a, b) => a + b, 0);
    const counts = lens.map((len) => Math.max(1, Math.floor((n * len) / sum)));
    let tot = counts.reduce((a, b) => a + b, 0);
    let k = 0;
    while (tot < n) {
        counts[k % counts.length]++;
        tot++;
        k++;
    }
    while (tot > n) {
        const j = counts.findIndex((c) => c > 1);
        if (j < 0) break;
        counts[j]--;
        tot--;
    }
    const pts = [];
    for (let ei = 0; ei < edges.length; ei++) {
        const { a, b } = edges[ei];
        const c = counts[ei];
        for (let i = 0; i < c; i++) {
            const t = c <= 1 ? 0.5 : i / (c - 1);
            pts.push({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    return pts;
};

const torusPoint = (R, rr, u, v) => ({
    x: (R + rr * Math.cos(v)) * Math.cos(u),
    y: rr * Math.sin(v),
    z: (R + rr * Math.cos(v)) * Math.sin(u),
});

/** Per-axis sizes in model units (sx, sy, sz). */
const shapeGenerators = {
    cube: (n, dims, hollow) => {
        const hx = dims.sx / 2, hy = dims.sy / 2, hz = dims.sz / 2;
        if (hollow) {
            const P = (x, y, z) => ({ x, y, z });
            const edges = [];
            for (const syy of [-1, 1]) for (const szz of [-1, 1])
                edges.push({ a: P(-hx, syy * hy, szz * hz), b: P(hx, syy * hy, szz * hz) });
            for (const sxx of [-1, 1]) for (const szz of [-1, 1])
                edges.push({ a: P(sxx * hx, -hy, szz * hz), b: P(sxx * hx, hy, szz * hz) });
            for (const sxx of [-1, 1]) for (const syy of [-1, 1])
                edges.push({ a: P(sxx * hx, syy * hy, -hz), b: P(sxx * hx, syy * hy, hz) });
            return distributeOnEdges(edges, n);
        }
        const ex = [dims.sx, dims.sy, dims.sz];
        const h = [hx, hy, hz];
        const pts = [];
        const perFace = Math.max(1, Math.ceil(n / 6));
        const faces = [
            { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
            { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
            { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
        ];
        for (const f of faces) {
            for (let i = 0; i < perFace; i++) {
                const a1 = (f.axis + 1) % 3, a2 = (f.axis + 2) % 3;
                const p = [0, 0, 0];
                p[f.axis] = h[f.axis] * f.sign;
                p[a1] = (Math.random() - 0.5) * ex[a1];
                p[a2] = (Math.random() - 0.5) * ex[a2];
                pts.push({ x: p[0], y: p[1], z: p[2] });
            }
        }
        return pts;
    },
    sphere: (n, dims, hollow) => {
        const rx = dims.sx / 2, ry = dims.sy / 2, rz = dims.sz / 2;
        const pts = [];
        if (hollow) {
            for (let i = 0; i < n; i++) {
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(2 * Math.random() - 1);
                const dx = Math.sin(phi) * Math.cos(theta);
                const dy = Math.sin(phi) * Math.sin(theta);
                const dz = Math.cos(phi);
                pts.push({ x: rx * dx, y: ry * dy, z: rz * dz });
            }
            return pts;
        }
        for (let i = 0; i < n; i++) {
            const rad = Math.cbrt(Math.random());
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const dx = Math.sin(phi) * Math.cos(theta);
            const dy = Math.sin(phi) * Math.sin(theta);
            const dz = Math.cos(phi);
            pts.push({ x: rad * rx * dx, y: rad * ry * dy, z: rad * rz * dz });
        }
        return pts;
    },
    cylinder: (n, dims, hollow) => {
        const rx = dims.sx / 2, rz = dims.sz / 2, hh = dims.sy / 2;
        if (hollow) {
            const edges = [];
            const rimSegs = Math.max(8, Math.floor(Math.sqrt(Math.max(n, 64))));
            for (let i = 0; i < rimSegs; i++) {
                const t0 = (i / rimSegs) * Math.PI * 2;
                const t1 = ((i + 1) / rimSegs) * Math.PI * 2;
                edges.push({
                    a: { x: rx * Math.cos(t0), y: -hh, z: rz * Math.sin(t0) },
                    b: { x: rx * Math.cos(t1), y: -hh, z: rz * Math.sin(t1) },
                });
                edges.push({
                    a: { x: rx * Math.cos(t0), y: hh, z: rz * Math.sin(t0) },
                    b: { x: rx * Math.cos(t1), y: hh, z: rz * Math.sin(t1) },
                });
            }
            const K = Math.max(4, Math.min(48, Math.floor(n / Math.max(rimSegs * 2, 1))));
            for (let k = 0; k < K; k++) {
                const th = (k / K) * Math.PI * 2;
                const x0 = rx * Math.cos(th), z0 = rz * Math.sin(th);
                edges.push({ a: { x: x0, y: -hh, z: z0 }, b: { x: x0, y: hh, z: z0 } });
            }
            return distributeOnEdges(edges, n);
        }
        const pts = [];
        const h = dims.sy;
        const nCap = Math.max(1, Math.floor(n * 0.15));
        const nSide = n - nCap * 2;
        for (let i = 0; i < nSide; i++) {
            const theta = Math.random() * Math.PI * 2;
            pts.push({
                x: rx * Math.cos(theta),
                y: (Math.random() - 0.5) * h,
                z: rz * Math.sin(theta),
            });
        }
        for (let sign = -1; sign <= 1; sign += 2) {
            for (let i = 0; i < nCap; i++) {
                const u = Math.sqrt(Math.random());
                const theta = Math.random() * Math.PI * 2;
                pts.push({
                    x: u * rx * Math.cos(theta),
                    y: sign * h / 2,
                    z: u * rz * Math.sin(theta),
                });
            }
        }
        return pts;
    },
    plane: (n, dims, hollow) => {
        const hx = dims.sx / 2, hz = dims.sz / 2;
        if (hollow) {
            const edges = [
                { a: { x: -hx, y: 0, z: -hz }, b: { x: hx, y: 0, z: -hz } },
                { a: { x: hx, y: 0, z: -hz }, b: { x: hx, y: 0, z: hz } },
                { a: { x: hx, y: 0, z: hz }, b: { x: -hx, y: 0, z: hz } },
                { a: { x: -hx, y: 0, z: hz }, b: { x: -hx, y: 0, z: -hz } },
            ];
            return distributeOnEdges(edges, n);
        }
        const pts = [];
        for (let i = 0; i < n; i++) {
            pts.push({
                x: (Math.random() - 0.5) * dims.sx,
                y: 0,
                z: (Math.random() - 0.5) * dims.sz,
            });
        }
        return pts;
    },
    cone: (n, dims, hollow) => {
        const rx = dims.sx / 2, rz = dims.sz / 2, h = dims.sy;
        const apex = { x: 0, y: h / 2, z: 0 };
        if (hollow) {
            const edges = [];
            const rimSegs = Math.max(8, Math.floor(Math.sqrt(Math.max(n, 64))));
            for (let i = 0; i < rimSegs; i++) {
                const t0 = (i / rimSegs) * Math.PI * 2;
                const t1 = ((i + 1) / rimSegs) * Math.PI * 2;
                edges.push({
                    a: { x: rx * Math.cos(t0), y: -h / 2, z: rz * Math.sin(t0) },
                    b: { x: rx * Math.cos(t1), y: -h / 2, z: rz * Math.sin(t1) },
                });
            }
            const M = Math.max(4, Math.min(48, Math.floor(n / Math.max(rimSegs, 1))));
            for (let k = 0; k < M; k++) {
                const th = (k / M) * Math.PI * 2;
                edges.push({
                    a: apex,
                    b: { x: rx * Math.cos(th), y: -h / 2, z: rz * Math.sin(th) },
                });
            }
            return distributeOnEdges(edges, n);
        }
        const pts = [];
        const nBase = Math.max(1, Math.floor(n * 0.2));
        const nSide = n - nBase;
        for (let i = 0; i < nSide; i++) {
            const t = Math.random();
            const crx = rx * (1 - t), crz = rz * (1 - t);
            const theta = Math.random() * Math.PI * 2;
            pts.push({
                x: crx * Math.cos(theta),
                y: t * h - h / 2,
                z: crz * Math.sin(theta),
            });
        }
        for (let i = 0; i < nBase; i++) {
            const u = Math.sqrt(Math.random());
            const theta = Math.random() * Math.PI * 2;
            pts.push({
                x: u * rx * Math.cos(theta),
                y: -h / 2,
                z: u * rz * Math.sin(theta),
            });
        }
        return pts;
    },
    pyramid: (n, dims, hollow) => {
        const hx = dims.sx / 2, hz = dims.sz / 2, hh = dims.sy / 2;
        const apex = { x: 0, y: hh, z: 0 };
        const corners = [
            { x: -hx, y: -hh, z: -hz },
            { x:  hx, y: -hh, z: -hz },
            { x:  hx, y: -hh, z:  hz },
            { x: -hx, y: -hh, z:  hz },
        ];
        if (hollow) {
            const edges = [];
            for (let i = 0; i < 4; i++) {
                edges.push({ a: corners[i], b: corners[(i + 1) % 4] });
                edges.push({ a: corners[i], b: apex });
            }
            return distributeOnEdges(edges, n);
        }
        const pts = [];
        const nBase = Math.max(1, Math.floor(n * 0.25));
        const nSide = n - nBase;
        for (let i = 0; i < nBase; i++) {
            pts.push({
                x: (Math.random() - 0.5) * dims.sx,
                y: -hh,
                z: (Math.random() - 0.5) * dims.sz,
            });
        }
        const tris = [];
        for (let i = 0; i < 4; i++) {
            tris.push([corners[i], corners[(i + 1) % 4], apex]);
        }
        const perTri = Math.max(1, Math.ceil(nSide / tris.length));
        for (const [a, b, c] of tris) {
            for (let j = 0; j < perTri && pts.length < n; j++) {
                let u = Math.random(), v = Math.random();
                if (u + v > 1) { u = 1 - u; v = 1 - v; }
                const w = 1 - u - v;
                pts.push({
                    x: a.x * u + b.x * v + c.x * w,
                    y: a.y * u + b.y * v + c.y * w,
                    z: a.z * u + b.z * v + c.z * w,
                });
            }
        }
        return pts;
    },
    torus: (n, dims, hollow) => {
        const R = Math.max(dims.sx, dims.sz) / 2;
        const rr = Math.max(0.02 * R, Math.min(dims.sy, dims.sx, dims.sz) / 2 * 0.35);
        if (hollow) {
            const edges = [];
            const Nu = Math.max(3, Math.min(32, Math.floor(Math.sqrt(Math.max(n / 24, 9)))));
            const Nv = Nu;
            const segU = Math.max(4, Math.min(256, Math.ceil(n / (2 * Math.max(Nv, 1)))));
            const segV = Math.max(4, Math.min(256, Math.ceil(n / (2 * Math.max(Nu, 1)))));
            for (let j = 0; j < Nv; j++) {
                const v = (j / Nv) * Math.PI * 2;
                for (let i = 0; i < segU; i++) {
                    const u0 = (i / segU) * Math.PI * 2;
                    const u1 = ((i + 1) / segU) * Math.PI * 2;
                    edges.push({ a: torusPoint(R, rr, u0, v), b: torusPoint(R, rr, u1, v) });
                }
            }
            for (let i = 0; i < Nu; i++) {
                const u = (i / Nu) * Math.PI * 2;
                for (let j = 0; j < segV; j++) {
                    const v0 = (j / segV) * Math.PI * 2;
                    const v1 = ((j + 1) / segV) * Math.PI * 2;
                    edges.push({ a: torusPoint(R, rr, u, v0), b: torusPoint(R, rr, u, v1) });
                }
            }
            return distributeOnEdges(edges, n);
        }
        const pts = [];
        for (let i = 0; i < n; i++) {
            const u = Math.random() * Math.PI * 2;
            const v = Math.random() * Math.PI * 2;
            pts.push(torusPoint(R, rr, u, v));
        }
        return pts;
    },
};

// Scratch for parametric shapes: world point → layersContainer local (no-base case).
const _shapeWorldTmp = new pc.Vec3();
const _shapeLocalTmp = new pc.Vec3();
const _shapeNormScratch = new pc.Vec3();
const _shapeInvParent = new pc.Mat4();
const _shapeInvBaseScratch = new pc.Mat4();

/** When there is no imported base, frame the camera on a layer's splats (world AABB). */
const frameOrbitOnLayerSplats = (layer) => {
    const ent = layersContainer.findByName(`layer-${layer.id}`);
    if (!ent || !layer.splats.length) return;
    const wt = ent.getWorldTransform();
    const v = new pc.Vec3();
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (const s of layer.splats) {
        v.set(s.x, s.y, s.z);
        wt.transformPoint(v, v);
        minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
        miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
        minz = Math.min(minz, v.z); maxz = Math.max(maxz, v.z);
    }
    const tcx = (minx + maxx) * 0.5;
    const tcy = (miny + maxy) * 0.5;
    const tcz = (minz + maxz) * 0.5;
    const halfExtent = Math.max(maxx - minx, maxy - miny, maxz - minz) * 0.5;
    orbit.target.set(tcx, tcy, tcz);
    orbit.distance = Math.max(halfExtent * 2.8, 0.35);
    orbit.yaw = 0;
    orbit.pitch = -15;
    if (cameraNavMode === 'fly') syncFlyCamFromOrbitParams();
    updateCamera();
    snapshotCameraResetFromFramedView();
};

const _frameBaseBoundsCorner = new pc.Vec3();

/**
 * Frame base orbit from `gsplatDataCache.bounds` (8 corners → world AABB). O(1).
 * Large splat counts / big files use a closer orbit so fewer splats fill the view (better FPS).
 */
const applyBaseOrbitFromCachedBounds = () => {
    const c = gsplatDataCache;
    if (!c?.bounds || !paintables.length) return false;
    const wt = paintables[0].entity.getWorldTransform();
    const { min: Bmin, max: Bmax } = c.bounds;
    const cx = [Bmin[0], Bmax[0]];
    const cy = [Bmin[1], Bmax[1]];
    const cz = [Bmin[2], Bmax[2]];
    let wx0 = Infinity;
    let wx1 = -Infinity;
    let wy0 = Infinity;
    let wy1 = -Infinity;
    let wz0 = Infinity;
    let wz1 = -Infinity;
    for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
            for (let iz = 0; iz < 2; iz++) {
                _frameBaseBoundsCorner.set(cx[ix], cy[iy], cz[iz]);
                wt.transformPoint(_frameBaseBoundsCorner, _frameBaseBoundsCorner);
                const px = _frameBaseBoundsCorner.x;
                const py = _frameBaseBoundsCorner.y;
                const pz = _frameBaseBoundsCorner.z;
                wx0 = Math.min(wx0, px);
                wx1 = Math.max(wx1, px);
                wy0 = Math.min(wy0, py);
                wy1 = Math.max(wy1, py);
                wz0 = Math.min(wz0, pz);
                wz1 = Math.max(wz1, pz);
            }
        }
    }
    if (!Number.isFinite(wx0)) return false;
    const tcx = (wx0 + wx1) * 0.5;
    const tcy = (wy0 + wy1) * 0.5;
    const tcz = (wz0 + wz1) * 0.5;
    const halfExtent = Math.max(wx1 - wx0, wy1 - wy0, wz1 - wz0) * 0.5;
    const n = c.numSplats;
    const bytes = c._sourceFileBytes ?? 0;
    let distMult = 2.8;
    if (n >= TIGHT_ORBIT_SPLAT_THRESHOLD || bytes >= TIGHT_ORBIT_FILE_BYTES) {
        distMult = TIGHT_ORBIT_DIST_MULT;
    } else if (n >= CLOSE_ORBIT_SPLAT_THRESHOLD || bytes >= CLOSE_ORBIT_FILE_BYTES) {
        distMult = CLOSE_ORBIT_DIST_MULT;
    }
    orbit.target.set(tcx, tcy, tcz);
    orbit.distance = Math.max(halfExtent * distMult, 0.35);
    orbit.yaw = 0;
    orbit.pitch = -15;
    if (cameraNavMode === 'fly') syncFlyCamFromOrbitParams();
    updateCamera();
    snapshotCameraResetFromFramedView();
    return true;
};

/** Center orbit/fly camera on the active layer (base splats or user layer entity). */
const frameCameraOnSelectedLayer = () => {
    const isBase = selectedLayerId === 'base' || !selectedLayerId;
    if (isBase) {
        if (!paintables.length || !gsplatDataCache?.numSplats) return;
        if (applyBaseOrbitFromCachedBounds()) return;
        const wt = paintables[0].entity.getWorldTransform();
        const v = new pc.Vec3();
        const { x, y, z, numSplats } = gsplatDataCache;
        let minx = Infinity, miny = Infinity, minz = Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i = 0; i < numSplats; i++) {
            if (!isBaseSplatAlive(i)) continue;
            v.set(x[i], y[i], z[i]);
            wt.transformPoint(v, v);
            minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
            miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
            minz = Math.min(minz, v.z); maxz = Math.max(maxz, v.z);
        }
        if (!Number.isFinite(minx)) return;
        const tcx = (minx + maxx) * 0.5;
        const tcy = (miny + maxy) * 0.5;
        const tcz = (minz + maxz) * 0.5;
        const halfExtent = Math.max(maxx - minx, maxy - miny, maxz - minz) * 0.5;
        orbit.target.set(tcx, tcy, tcz);
        orbit.distance = Math.max(halfExtent * 2.8, 0.35);
        orbit.yaw = 0;
        orbit.pitch = -15;
        if (cameraNavMode === 'fly') syncFlyCamFromOrbitParams();
        updateCamera();
        snapshotCameraResetFromFramedView();
        return;
    }
    const layer = layers.find((l) => l.id === selectedLayerId);
    if (layer) frameOrbitOnLayerSplats(layer);
};

const SHAPE_DIM_MIN = 0.05;
const SHAPE_DIM_MAX = 20;
const readShapeDimsFromUI = () => {
    const clamp = (v, def) => {
        const x = Number.isFinite(v) ? v : def;
        return Math.max(SHAPE_DIM_MIN, Math.min(SHAPE_DIM_MAX, x));
    };
    const px = numericFieldValueOrNull(g('shape-size-x')?.value);
    const py = numericFieldValueOrNull(g('shape-size-y')?.value);
    const pz = numericFieldValueOrNull(g('shape-size-z')?.value);
    return {
        sx: clamp(px, 0.5),
        sy: clamp(py, 0.5),
        sz: clamp(pz, 0.5),
    };
};

const readShapeRotFromUI = () => {
    const p = (id) => numericFieldValueOrNull(g(id)?.value) ?? 0;
    return { rx: p('shape-rot-x'), ry: p('shape-rot-y'), rz: p('shape-rot-z') };
};

const syncShapeTransformInputsFromApplied = () => {
    const d = readShapeDimsFromUI();
    const r = readShapeRotFromUI();
    const sf = (v) => String(Math.round(v * 10000) / 10000);
    if (g('shape-size-x')) g('shape-size-x').value = sf(d.sx);
    if (g('shape-size-y')) g('shape-size-y').value = sf(d.sy);
    if (g('shape-size-z')) g('shape-size-z').value = sf(d.sz);
    if (g('shape-rot-x')) g('shape-rot-x').value = String(Math.round(r.rx));
    if (g('shape-rot-y')) g('shape-rot-y').value = String(Math.round(r.ry));
    if (g('shape-rot-z')) g('shape-rot-z').value = String(Math.round(r.rz));
};

const LS_SHAPE_TOOL = 'photoshock-shape-tool-v1';
const saveShapeToolPrefs = () => {
    try {
        let k = numericFieldValueOrNull(g('shape-density-num')?.value);
        if (k == null) k = numericFieldValueOrNull(g('shape-density')?.value);
        if (k == null || !Number.isFinite(k)) k = 5;
        localStorage.setItem(LS_SHAPE_TOOL, JSON.stringify({
            type: g('shape-type')?.value ?? 'cube',
            sx: numericFieldValueOrNull(g('shape-size-x')?.value) ?? 0.5,
            sy: numericFieldValueOrNull(g('shape-size-y')?.value) ?? 0.5,
            sz: numericFieldValueOrNull(g('shape-size-z')?.value) ?? 0.5,
            rx: numericFieldValueOrNull(g('shape-rot-x')?.value) ?? 0,
            ry: numericFieldValueOrNull(g('shape-rot-y')?.value) ?? 0,
            rz: numericFieldValueOrNull(g('shape-rot-z')?.value) ?? 0,
            densityK: k,
            hollow: !!g('shape-hollow-edges')?.checked,
            color: g('shape-color')?.value ?? '#cccccc',
        }));
    } catch (_) { /* ignore */ }
};
const loadShapeToolPrefs = () => {
    try {
        const raw = localStorage.getItem(LS_SHAPE_TOOL);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o.type && g('shape-type')) g('shape-type').value = o.type;
        if (Number.isFinite(o.sx) && g('shape-size-x')) g('shape-size-x').value = String(o.sx);
        if (Number.isFinite(o.sy) && g('shape-size-y')) g('shape-size-y').value = String(o.sy);
        if (Number.isFinite(o.sz) && g('shape-size-z')) g('shape-size-z').value = String(o.sz);
        if (Number.isFinite(o.densityK)) {
            const k = o.densityK;
            if (g('shape-density')) g('shape-density').value = String(k);
            if (g('shape-density-num')) g('shape-density-num').value = Math.abs(k % 1) < 1e-6 ? String(Math.round(k)) : String(k);
        }
        if (Number.isFinite(o.rx) && g('shape-rot-x')) g('shape-rot-x').value = String(o.rx);
        if (Number.isFinite(o.ry) && g('shape-rot-y')) g('shape-rot-y').value = String(o.ry);
        if (Number.isFinite(o.rz) && g('shape-rot-z')) g('shape-rot-z').value = String(o.rz);
        if (typeof o.hollow === 'boolean' && g('shape-hollow-edges')) g('shape-hollow-edges').checked = o.hollow;
        if (o.color && /^#[0-9a-fA-F]{6}$/.test(o.color)) {
            if (g('shape-color')) g('shape-color').value = o.color.toLowerCase();
            if (g('shape-color-hex')) g('shape-color-hex').value = o.color.toLowerCase();
        }
    } catch (_) { /* ignore */ }
};

const SHAPE_DENSITY_MIN = 500;
const SHAPE_DENSITY_MAX = 1_000_000; // 1000k splats

/** UI density is in k (1 → 1000 splats). Clamped to SHAPE_DENSITY_MIN…MAX actual. */
const readShapeDensityFromUI = () => {
    let k = numericFieldValueOrNull(g('shape-density-num')?.value);
    if (k == null) k = numericFieldValueOrNull(g('shape-density')?.value ?? '5');
    if (k == null) k = 5;
    const raw = Math.round(k * 1000);
    return Math.max(SHAPE_DENSITY_MIN, Math.min(SHAPE_DENSITY_MAX, raw));
};

/** Normalized wireframe segments in [-0.5, 0.5] per axis; root local scale applies real size. */
const buildShapePreviewLinePositions = (shapeType) => {
    const pos = [];
    const L = (ax, ay, az, bx, by, bz) => { pos.push(ax, ay, az, bx, by, bz); };
    const h = 0.5;
    if (shapeType === 'cube') {
        for (const s of [-1, 1]) {
            L(-h, s * h, -h, h, s * h, -h);
            L(-h, s * h, h, h, s * h, h);
            L(s * h, -h, -h, s * h, h, -h);
            L(s * h, -h, h, s * h, h, h);
            L(-h, -h, s * h, h, -h, s * h);
            L(-h, h, s * h, h, h, s * h);
        }
        return new Float32Array(pos);
    }
    if (shapeType === 'sphere') {
        const segs = 24;
        const r = h;
        for (let i = 0; i < segs; i++) {
            const t0 = (i / segs) * Math.PI * 2;
            const t1 = ((i + 1) / segs) * Math.PI * 2;
            L(r * Math.cos(t0), 0, r * Math.sin(t0), r * Math.cos(t1), 0, r * Math.sin(t1));
            L(0, r * Math.cos(t0), r * Math.sin(t0), 0, r * Math.cos(t1), r * Math.sin(t1));
            L(r * Math.cos(t0), r * Math.sin(t0), 0, r * Math.cos(t1), r * Math.sin(t1), 0);
        }
        return new Float32Array(pos);
    }
    if (shapeType === 'cylinder') {
        const segs = 20;
        const yb = -h;
        const yt = h;
        for (let i = 0; i < segs; i++) {
            const t0 = (i / segs) * Math.PI * 2;
            const t1 = ((i + 1) / segs) * Math.PI * 2;
            L(h * Math.cos(t0), yb, h * Math.sin(t0), h * Math.cos(t1), yb, h * Math.sin(t1));
            L(h * Math.cos(t0), yt, h * Math.sin(t0), h * Math.cos(t1), yt, h * Math.sin(t1));
            L(h * Math.cos(t0), yb, h * Math.sin(t0), h * Math.cos(t0), yt, h * Math.sin(t0));
        }
        return new Float32Array(pos);
    }
    if (shapeType === 'plane') {
        L(-h, 0, -h, h, 0, -h);
        L(h, 0, -h, h, 0, h);
        L(h, 0, h, -h, 0, h);
        L(-h, 0, h, -h, 0, -h);
        return new Float32Array(pos);
    }
    if (shapeType === 'cone') {
        const segs = 16;
        const yb = -h;
        const yt = h;
        for (let i = 0; i < segs; i++) {
            const t0 = (i / segs) * Math.PI * 2;
            const t1 = ((i + 1) / segs) * Math.PI * 2;
            L(h * Math.cos(t0), yb, h * Math.sin(t0), h * Math.cos(t1), yb, h * Math.sin(t1));
            L(0, yt, 0, h * Math.cos(t0), yb, h * Math.sin(t0));
        }
        return new Float32Array(pos);
    }
    if (shapeType === 'pyramid') {
        const c = [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]];
        for (let i = 0; i < 4; i++) {
            const [ax, ay, az] = c[i];
            const [bx, by, bz] = c[(i + 1) % 4];
            L(ax, ay, az, bx, by, bz);
            L(ax, ay, az, 0, h, 0);
        }
        return new Float32Array(pos);
    }
    if (shapeType === 'torus') {
        const R = 0.28;
        const rr = 0.12;
        const Nu = 16;
        const Nv = 12;
        for (let j = 0; j < Nv; j++) {
            const v = (j / Nv) * Math.PI * 2;
            for (let i = 0; i < Nu; i++) {
                const u0 = (i / Nu) * Math.PI * 2;
                const u1 = ((i + 1) / Nu) * Math.PI * 2;
                const a0 = torusPoint(R, rr, u0, v);
                const b0 = torusPoint(R, rr, u1, v);
                L(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z);
            }
        }
        for (let i = 0; i < Nu; i++) {
            const u = (i / Nu) * Math.PI * 2;
            for (let j = 0; j < Nv; j++) {
                const v0 = (j / Nv) * Math.PI * 2;
                const v1 = ((j + 1) / Nv) * Math.PI * 2;
                const a0 = torusPoint(R, rr, u, v0);
                const b0 = torusPoint(R, rr, u, v1);
                L(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z);
            }
        }
        return new Float32Array(pos);
    }
    return buildShapePreviewLinePositions('cube');
};

/** Low-poly solid fill in unit space [-0.5,0.5] (root scale applies); null if procedural mesh fails. */
const buildShapePreviewFillMesh = (shapeType) => {
    try {
        if (shapeType === 'cube') {
            return pc.Mesh.fromGeometry(device, new pc.BoxGeometry({
                halfExtents: new pc.Vec3(0.5, 0.5, 0.5),
                widthSegments: 1,
                lengthSegments: 1,
                heightSegments: 1,
            }));
        }
        if (shapeType === 'sphere') {
            return pc.Mesh.fromGeometry(device, new pc.SphereGeometry({
                radius: 0.5,
                latitudeBands: 8,
                longitudeBands: 10,
            }));
        }
        if (shapeType === 'cylinder') {
            return pc.Mesh.fromGeometry(device, new pc.CylinderGeometry({
                radius: 0.5,
                height: 1,
                heightSegments: 1,
                capSegments: 14,
            }));
        }
        if (shapeType === 'plane') {
            return pc.Mesh.fromGeometry(device, new pc.PlaneGeometry({
                halfExtents: new pc.Vec2(0.5, 0.5),
                widthSegments: 2,
                lengthSegments: 2,
            }));
        }
        if (shapeType === 'cone') {
            return pc.Mesh.fromGeometry(device, new pc.ConeGeometry({
                baseRadius: 0.5,
                height: 1,
                heightSegments: 4,
                capSegments: 14,
            }));
        }
        if (shapeType === 'pyramid') {
            return pc.Mesh.fromGeometry(device, new pc.ConeGeometry({
                baseRadius: 0.5,
                height: 1,
                heightSegments: 1,
                capSegments: 4,
            }));
        }
        if (shapeType === 'torus') {
            return pc.Mesh.fromGeometry(device, new pc.TorusGeometry({
                ringRadius: 0.28,
                tubeRadius: 0.12,
                segments: 14,
                sides: 10,
            }));
        }
    } catch (err) {
        console.warn('[shape preview] fill mesh', shapeType, err);
    }
    return null;
};

const rebuildShapePreviewGeometry = () => {
    if (!shapePreviewMeshEntity) { console.warn('[shape] rebuildGeom: no meshEntity'); return; }
    const shapeType = g('shape-type')?.value ?? 'cube';
    const hollow = !!g('shape-hollow-edges')?.checked;
    console.log('[shape] rebuildGeom:', shapeType, 'hollow:', hollow);
    const instances = [];
    if (!hollow) {
        const fillMesh = buildShapePreviewFillMesh(shapeType);
        if (fillMesh) {
            const miFill = new pc.MeshInstance(fillMesh, shapePreviewFillMat);
            miFill.cull = false;
            miFill.transparent = true;
            miFill.drawOrder = 198;
            instances.push(miFill);
        }
    }
    const positions = buildShapePreviewLinePositions(shapeType);
    const lineMesh = meshFromLinePositions(positions);
    const miLines = new pc.MeshInstance(lineMesh, shapePreviewLineMat);
    miLines.cull = false;
    miLines.drawOrder = 200;
    instances.push(miLines);
    if (shapePreviewMeshEntity.render) {
        shapePreviewMeshEntity.removeComponent('render');
    }
    shapePreviewMeshEntity.addComponent('render', {
        castShadows: false,
        meshInstances: instances,
    });
    console.log('[shape] rebuildGeom: added render component with', instances.length, 'mesh instances, entity.enabled:', shapePreviewMeshEntity.enabled, 'root.enabled:', shapePreviewRoot?.enabled, 'root.parent:', !!shapePreviewRoot?.parent);
};

const ensureShapePreviewRoot = () => {
    if (shapePreviewRoot) return;
    shapePreviewRoot = new pc.Entity('shapePreviewRoot');
    shapePreviewMeshEntity = new pc.Entity('shapePreviewMesh');
    shapePreviewRoot.addChild(shapePreviewMeshEntity);
    app.root.addChild(shapePreviewRoot);
    shapePreviewRoot.enabled = true;
    shapePreviewMeshEntity.enabled = true;
};

/** Place or replace the shape wire preview at the current orbit target (world). */
const placeShapePreviewAtOrbitTarget = () => {
    if (activeTool !== 'shapeLayer') { console.log('[shape] Add btn: wrong tool', activeTool); return; }
    console.log('[shape] Add btn: placing preview at orbit target, orbit.target =', orbit.target.x, orbit.target.y, orbit.target.z, ', cameraNav =', cameraNavMode);
    ensureShapePreviewRoot();
    console.log('[shape] Add btn: root entity created?', !!shapePreviewRoot, 'mesh entity?', !!shapePreviewMeshEntity, 'parent?', !!shapePreviewRoot?.parent);
    let px;
    let py;
    let pz;
    if (cameraNavMode === 'orbit') {
        px = orbit.target.x;
        py = orbit.target.y;
        pz = orbit.target.z;
    } else {
        getForwardFromYawPitch(flyCam.yaw, flyCam.pitch, _camFwdScratch);
        const dist = Math.max(0.35, orbit.distance * 0.35);
        px = flyCam.pos.x + _camFwdScratch.x * dist;
        py = flyCam.pos.y + _camFwdScratch.y * dist;
        pz = flyCam.pos.z + _camFwdScratch.z * dist;
    }
    shapePreviewRoot.setPosition(px, py, pz);
    const rot = readShapeRotFromUI();
    shapePreviewRoot.setLocalEulerAngles(rot.rx, rot.ry, rot.rz);
    const dims = readShapeDimsFromUI();
    shapePreviewRoot.setLocalScale(dims.sx, dims.sy, dims.sz);
    shapePreviewOrbitLock = true;
    rebuildShapePreviewGeometry();
    updateShapeSplatButtonEnabled();
    refreshLayerGizmoAttachment();
};

const destroyShapePreview = () => {
    canvasContainer.classList.remove('shape-placement-active');
    shapePreviewOrbitLock = false;
    if (!shapePreviewRoot) {
        gizmoTargetIsShapePreview = false;
        updateShapeSplatButtonEnabled();
        return;
    }
    layerTranslateGizmo.detach();
    layerRotateGizmo.detach();
    layerScaleGizmo.detach();
    shapePreviewRoot.destroy();
    shapePreviewRoot = null;
    shapePreviewMeshEntity = null;
    gizmoTargetIsShapePreview = false;
    updateShapeSplatButtonEnabled();
    refreshLayerGizmoAttachment();
};

const updateShapeSplatButtonEnabled = () => {
    const btn = g('splat-shape-btn');
    if (btn) btn.disabled = !shapePreviewRoot?.parent;
};

const applyShapePreviewTransformFromInputs = () => {
    if (!shapePreviewRoot || syncingShapeUIFromPreview) return;
    const d = readShapeDimsFromUI();
    const r = readShapeRotFromUI();
    shapePreviewRoot.setLocalScale(d.sx, d.sy, d.sz);
    shapePreviewRoot.setLocalEulerAngles(r.rx, r.ry, r.rz);
};

/** Type / hollow: rebuild line + optional fill mesh; preserve transform. */
const onShapePreviewTopologyChanged = () => {
    saveShapeToolPrefs();
    if (!shapePreviewRoot) return;
    rebuildShapePreviewGeometry();
    applyShapePreviewTransformFromInputs();
};

/** Size / rotation inputs — apply directly without rebuilding meshes. */
const onShapePreviewTransformInputsChanged = () => {
    saveShapeToolPrefs();
    if (!shapePreviewRoot || syncingShapeUIFromPreview) return;
    applyShapePreviewTransformFromInputs();
};

// Create a new splat object for a layer
const createLayerSplat = (x, y, z, r, g, b, rot = null, scl = null) => {
    const fdc0 = (r - 0.5) / SH_C0;
    const fdc1 = (g - 0.5) / SH_C0;
    const fdc2 = (b - 0.5) / SH_C0;
    // If a nearby-splat rotation is provided use it so the disk faces the
    // same way as the local surface.  Fall back to identity otherwise.
    const [q0, q1, q2, q3] = rot ?? [1, 0, 0, 0];
    // For scale: copy the nearby splat's log-scale but clamp to a sensible
    // range so fill splats don't become huge.  Use fixed defaults when absent.
    const s0 = scl ? Math.max(-5.5, Math.min(-2.0, scl[0])) : -3.5;
    const s1 = scl ? Math.max(-5.5, Math.min(-2.0, scl[1])) : -3.5;
    const s2 = scl ? Math.max(-5.5, Math.min(-2.0, scl[2])) : -4.5;
    return {
        x, y, z,
        scale_0: s0, scale_1: s1, scale_2: s2,
        rot_0: q0, rot_1: q1, rot_2: q2, rot_3: q3,
        f_dc_0: fdc0, f_dc_1: fdc1, f_dc_2: fdc2,
        opacity: invSigmoid(0.9),
        nx: 0, ny: 1, nz: 0,
    };
};

// Generate splats in gaps - add to selected layer
const generateSplatsAt = (screenX, screenY) => {
    if (!paintables.length || !gsplatDataCache) return;
    let layer = layers.find((l) => l.id === selectedLayerId);
    if (!layer) {
        addLayer();
        layer = layers[layers.length - 1];
    }

    const worldRadius = generateSplatsSize();
    const density = Math.max(1, generateSplatsDensity());
    const worldPt = getWorldPoint(screenX, screenY);
    if (!worldPt) return;

    if (lastGenerateSplatsWorld && worldPt.distance(lastGenerateSplatsWorld) < worldRadius * 0.4)
        return;
    lastGenerateSplatsWorld = worldPt.clone();

    const invMat = new pc.Mat4().copy(paintables[0].entity.getWorldTransform()).invert();
    const modelPt = new pc.Vec3();
    invMat.transformPoint(worldPt, modelPt);

    const refW = new pc.Vec3(worldPt.x + worldRadius, worldPt.y, worldPt.z);
    const refM = new pc.Vec3();
    invMat.transformPoint(refW, refM);
    const modelRadius = modelPt.distance(refM);

    const [r, g, b] = generateSplatsSampledColor;

    // Pre-filter base-model splats to a small candidate set near the brush
    // centre so per-splat nearest-neighbour lookups stay fast even on dense models.
    const { numSplats, x: xA, y: yA, z: zA } = gsplatDataCache;
    const { rot_0, rot_1, rot_2, rot_3, scale_0, scale_1, scale_2 } = gsplatDataCache.extra;
    const searchR2 = (modelRadius * 3) ** 2;
    const nearby = [];
    for (let i = 0; i < numSplats; i++) {
        const dx = xA[i] - modelPt.x, dy = yA[i] - modelPt.y, dz = zA[i] - modelPt.z;
        if (dx*dx + dy*dy + dz*dz <= searchR2) nearby.push(i);
    }

    const added = [];
    for (let i = 0; i < density; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const u = Math.pow(Math.random(), 1 / 3);
        const sx = modelPt.x + u * Math.sin(phi) * Math.cos(theta) * modelRadius;
        const sy = modelPt.y + u * Math.sin(phi) * Math.sin(theta) * modelRadius;
        const sz = modelPt.z + u * Math.cos(phi) * modelRadius;

        // Find the nearest base-model splat to inherit its orientation / scale.
        let nearIdx = -1, nearD2 = Infinity;
        for (const idx of nearby) {
            const dx = xA[idx] - sx, dy = yA[idx] - sy, dz = zA[idx] - sz;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < nearD2) { nearD2 = d2; nearIdx = idx; }
        }

        const rot = nearIdx >= 0 && rot_0
            ? [rot_0[nearIdx], rot_1[nearIdx], rot_2[nearIdx], rot_3[nearIdx]]
            : null;
        const scl = nearIdx >= 0 && scale_0
            ? [scale_0[nearIdx], scale_1[nearIdx], scale_2[nearIdx]]
            : null;

        const splat = createLayerSplat(sx, sy, sz, r, g, b, rot, scl);
        layer.splats.push(splat);
        added.push(splat);
    }
    if (added.length) {
        if (layerUpdateTimeout) clearTimeout(layerUpdateTimeout);
        layerUpdateTimeout = setTimeout(() => {
            layerUpdateTimeout = null;
            updateLayerEntity(layer);
        }, 150);
    }
};

// Invert the current selection mask.
const invertSelection = (opts = {}) => {
    const recordUndo = opts.recordUndo === true;
    const before = recordUndo ? captureSelectionSnapshot() : null;
    const data = getActiveDataCache();
    if (!data) return;
    const n = data.numSplats;
    const mask = getActiveSelectionMask(n);
    for (let i = 0; i < n; i++) mask[i] = mask[i] ? 0 : 1;
    recomputeSelectionSphere();
    updateSelectionUI();
    if (recordUndo) pushSelectionUndoFromBefore(before);
};

// ── Undo / Redo ───────────────────────────────────────────────────────────────
const updateUndoRedoUI = () => {
    g('undo-btn').disabled = strokes.length === 0;
    g('redo-btn').disabled = redoStack.length === 0;
};

const resetTex = (p, name) => {
    const tex = p.entity.gsplat.getInstanceTexture(name);
    if (!tex) return;
    const d = tex.lock(); if (d) d.fill(0); tex.unlock();
};

const triggerRebuild = () => { pendingRebuild = true; };

const undo = () => {
    if (!strokes.length) return;
    const popped = strokes.pop();
    redoStack.push(popped);
    restoreSelectionSnapshot(popped.selectionBefore);
    updateUndoRedoUI();
    triggerRebuild();
};

const redo = () => {
    if (!redoStack.length) return;
    const s = redoStack.pop();
    strokes.push(s);
    restoreSelectionSnapshot(s.selectionAfter);
    updateUndoRedoUI();
    triggerRebuild();
};

// ── Update loop ───────────────────────────────────────────────────────────────
app.on('update', () => {
    if (pendingRebuild) {
        pendingRebuild = false;
        // Reset both GPU textures
        for (const p of paintables) {
            resetTex(p, 'customColor');
            resetTex(p, 'customOpacity');
        }
        // Re-queue all committed stroke ops
        for (const stroke of strokes) {
            for (const op of stroke.ops) pendingPaints.push(op);
        }
        return; // process re-queued ops next frame
    }

    if (!pendingPaints.length) return;

    const ops = pendingPaints.splice(0);
    for (const op of ops) {
        if (op.layerId) {
            const lyr = layers.find((l) => l.id === op.layerId);
            const pb = lyr?._gsplatPaint;
            if (pb) applyPaintOpToPaintable(pb, op);
            continue;
        }
        for (const p of paintables) {
            applyPaintOpToPaintable(p, op);
        }
    }
});

// ── Painting ──────────────────────────────────────────────────────────────────
// One dab at a world-space hit point (shared by stroke interpolation).
const applyPaintDabWorld = (worldPt, worldRadius, hardness, intensity, isErase, isReset) => {
    const userLayer = getActiveLayer();

    const emitDab = (entity, layerId) => {
        const invMat = new pc.Mat4().copy(entity.getWorldTransform()).invert();
        const modelPt = new pc.Vec3();
        invMat.transformPoint(worldPt, modelPt);

        const refW = new pc.Vec3(worldPt.x + worldRadius, worldPt.y, worldPt.z);
        const refM = new pc.Vec3();
        invMat.transformPoint(refW, refM);
        const modelRadius = modelPt.distance(refM);

        const cyl = computeEraseCylinderInModel(worldPt, invMat, isErase ? eraserDepth() : 0);
        const eraseExtra = isErase
            ? {
                eraseDepthHalf: cyl.halfModel,
                evX: cyl.viewModel.x,
                evY: cyl.viewModel.y,
                evZ: cyl.viewModel.z,
            }
            : {};

        const sphere = [modelPt.x, modelPt.y, modelPt.z, modelRadius];
        const [r, g, b] = isErase ? [0, 0, 0] : hexToRgb(paintColorHex());
        const color = [r, g, b, intensity];
        const selC = selectionConstraintForPaintTools();
        const op = {
            sphere, color, hardness, isErase, isReset,
            blendMode: isErase ? -1 : blendMode(),
            cx: modelPt.x, cy: modelPt.y, cz: modelPt.z,
            radius: modelRadius, r, g, b, intensity,
            selectionConstraint: selC,
            ...(layerId ? { layerId } : {}),
            ...eraseExtra,
        };

        pendingPaints.push(op);

        if (activeStroke) {
            activeStroke.ops.push({
                sphere, color, hardness, isErase, isReset,
                selectionConstraint: selC,
                ...(layerId ? { layerId } : {}),
                ...eraseExtra,
            });
            if (!isReset) {
                activeStroke.cpuOps.push({
                    cx: op.cx, cy: op.cy, cz: op.cz,
                    radius: op.radius, r, g, b, intensity, hardness, isErase,
                    blendMode: op.blendMode,
                    selectionConstraint: selC,
                    ...(layerId ? { layerId } : {}),
                    ...eraseExtra,
                });
            }
        }
    };

    // User layer (shape / import / generated): paint in layer entity model space.
    // Requires _gsplatPaint (GPU processors); skip until updateLayerEntity() finishes loading.
    if (userLayer) {
        if (userLayer._gsplatPaint?.entity) {
            emitDab(userLayer._gsplatPaint.entity, userLayer.id);
        }
        return;
    }

    for (const p of paintables) {
        emitDab(p.entity, undefined);
    }
};

const paintAt = (screenX, screenY) => {
    const isErase   = activeTool === 'eraser';
    const isReset   = activeTool === 'resetBrush';
    const worldRadius = isReset ? resetSize() : isErase ? eraserSize()     : brushSize();
    const hardness    = isReset ? resetHardness() : isErase ? eraserHardness() : brushHardness();
    const intensity   = isErase ? eraserIntensity() : brushIntensity();
    const spacing     = isReset ? resetSpacing() : isErase ? eraserSpacing()  : brushSpacing();

    const worldPt = getWorldPoint(screenX, screenY);
    if (!worldPt) return;

    const minMove = worldRadius * 2 * spacing;
    if (lastPaintWorld && worldPt.distance(lastPaintWorld) < minMove) return;

    // Dense overlap: many weak-edge hits still mottle under ALPHABLEND; keep stride small.
    const dabStride = Math.max(
        worldRadius * 0.09,
        Math.min(worldRadius * 1.05, minMove * 0.55),
    );

    const dabOnce = (wp) => applyPaintDabWorld(wp, worldRadius, hardness, intensity, isErase, isReset);

    if (!lastPaintWorld) {
        dabOnce(worldPt);
        lastPaintWorld = worldPt.clone();
        return;
    }

    const dist = worldPt.distance(lastPaintWorld);
    const n = Math.max(1, Math.ceil(dist / dabStride));
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        paintStrokeScratch.lerp(lastPaintWorld, worldPt, t);
        dabOnce(paintStrokeScratch);
    }
    lastPaintWorld.copy(worldPt);
};

/** One-shot fill: all splats in the active selection get a full-strength paint dab (blend in modifier). */
const applyPaintBucket = () => {
    const userLayer = getActiveLayer();
    const data = getActiveDataCache();
    if (!data?.numSplats) return;
    const n = data.numSplats;
    const mask = getActiveSelectionMask(n);
    if (!mask.some((v) => v)) return;

    const [r, g, b] = hexToRgb(paintColorHex());
    const intensity = brushIntensity();
    const opBase = {
        isBucket: true,
        color: [r, g, b, intensity],
        blendMode: blendMode(),
    };

    if (userLayer) {
        if (!userLayer._gsplatPaint?.entity) return;
        const op = { ...opBase, layerId: userLayer.id };
        const selBefore = captureSelectionSnapshot();
        pendingPaints.push(op);
        redoStack.length = 0;
        strokes.push({
            isBucket: true,
            blendMode: blendMode(),
            ops: [op],
            cpuOps: [{ isBucket: true, r, g, b, intensity, blendMode: blendMode() }],
            selectionBefore: selBefore,
            selectionAfter: captureSelectionSnapshot(),
        });
        updateUndoRedoUI();
        return;
    }

    const selBefore = captureSelectionSnapshot();
    pendingPaints.push(opBase);
    redoStack.length = 0;
    strokes.push({
        isBucket: true,
        blendMode: blendMode(),
        ops: [opBase],
        cpuOps: [{ isBucket: true, r, g, b, intensity, blendMode: blendMode() }],
        selectionBefore: selBefore,
        selectionAfter: captureSelectionSnapshot(),
    });
    updateUndoRedoUI();
};

/** GPU paint / erase / reset processors for a unified gsplat (base or user layer). */
const createGsplatPaintProcessors = (gsplatComponent) => {
    const paintProcessor = new pc.GSplatProcessor(
        device,
        { component: gsplatComponent },
        { component: gsplatComponent, streams: ['customColor'] },
        { processGLSL: PAINT_GLSL, processWGSL: PAINT_WGSL },
    );
    paintProcessor.blendState = pc.BlendState.ALPHABLEND;
    paintProcessor.setParameter('uPaintSphere',   [0, 0, 0, 0]);
    paintProcessor.setParameter('uPaintColor',   [1, 0, 0, 0.5]);
    paintProcessor.setParameter('uHardness',     0.8);
    paintProcessor.setParameter('uSelectionConstraint', 0);

    const paintBucketProcessor = new pc.GSplatProcessor(
        device,
        { component: gsplatComponent },
        { component: gsplatComponent, streams: ['customColor'] },
        { processGLSL: PAINT_BUCKET_GLSL, processWGSL: PAINT_BUCKET_WGSL },
    );
    paintBucketProcessor.blendState = pc.BlendState.ALPHABLEND;
    paintBucketProcessor.setParameter('uBucketColor', [1, 0, 0, 0.5]);

    const eraseProcessor = new pc.GSplatProcessor(
        device,
        { component: gsplatComponent },
        { component: gsplatComponent, streams: ['customOpacity'] },
        { processGLSL: ERASE_GLSL, processWGSL: ERASE_WGSL },
    );
    eraseProcessor.blendState = ADDITIVE_BLEND;
    eraseProcessor.setParameter('uPaintSphere',   [0, 0, 0, 0]);
    eraseProcessor.setParameter('uPaintColor',   [0, 0, 0, 0.5]);
    eraseProcessor.setParameter('uHardness',     0.8);
    eraseProcessor.setParameter('uSelectionConstraint', 0);
    eraseProcessor.setParameter('uEraseViewDir', [0, 0, 1]);
    eraseProcessor.setParameter('uEraseDepthHalf', 0);

    const resetColorProcessor = new pc.GSplatProcessor(
        device,
        { component: gsplatComponent },
        { component: gsplatComponent, streams: ['customColor'] },
        { processGLSL: RESET_COLOR_GLSL, processWGSL: RESET_COLOR_WGSL },
    );
    resetColorProcessor.blendState = RESET_BLEND;
    resetColorProcessor.setParameter('uPaintSphere', [0, 0, 0, 0]);
    resetColorProcessor.setParameter('uHardness', 0.8);
    resetColorProcessor.setParameter('uSelectionConstraint', 0);

    const resetOpacityProcessor = new pc.GSplatProcessor(
        device,
        { component: gsplatComponent },
        { component: gsplatComponent, streams: ['customOpacity'] },
        { processGLSL: RESET_OPACITY_GLSL, processWGSL: RESET_OPACITY_WGSL },
    );
    resetOpacityProcessor.blendState = RESET_BLEND;
    resetOpacityProcessor.setParameter('uPaintSphere', [0, 0, 0, 0]);
    resetOpacityProcessor.setParameter('uHardness', 0.8);
    resetOpacityProcessor.setParameter('uSelectionConstraint', 0);

    return { paintProcessor, paintBucketProcessor, eraseProcessor, resetColorProcessor, resetOpacityProcessor };
};

const destroyGsplatPaintBundle = (pb) => {
    if (!pb) return;
    pb.paintProcessor?.destroy?.();
    pb.paintBucketProcessor?.destroy?.();
    pb.eraseProcessor?.destroy?.();
    pb.resetColorProcessor?.destroy?.();
    pb.resetOpacityProcessor?.destroy?.();
};

const destroyLayerGsplatPaint = (layer) => {
    destroyGsplatPaintBundle(layer?._gsplatPaint);
    if (layer) layer._gsplatPaint = null;
    destroyGradeLutGpu(layer?.colorGrade);
};

/** Run one queued paint op on a paintable bundle (base row or layer._gsplatPaint). */
const applyPaintOpToPaintable = (p, op) => {
    if (op.isBucket) {
        p.paintBucketProcessor.setParameter('uBucketColor', op.color);
        p.paintBucketProcessor.process();
    } else if (op.isReset) {
        const c = selectionConstraintForOp(op);
        p.resetColorProcessor.setParameter('uPaintSphere', op.sphere);
        p.resetColorProcessor.setParameter('uHardness', op.hardness);
        p.resetColorProcessor.setParameter('uSelectionConstraint', c);
        p.resetColorProcessor.process();
        p.resetOpacityProcessor.setParameter('uPaintSphere', op.sphere);
        p.resetOpacityProcessor.setParameter('uHardness', op.hardness);
        p.resetOpacityProcessor.setParameter('uSelectionConstraint', c);
        p.resetOpacityProcessor.process();
    } else if (op.isErase) {
        setUniformsForErase(
            p,
            op.sphere,
            op.color,
            op.hardness,
            op.eraseDepthHalf ?? 0,
            [op.evX ?? 0, op.evY ?? 0, op.evZ ?? 1],
            selectionConstraintForOp(op),
        );
        p.eraseProcessor.process();
    } else {
        setUniformsForPaint(p, op.sphere, op.color, op.hardness, selectionConstraintForOp(op));
        p.paintProcessor.process();
    }
    p.entity.gsplat.workBufferUpdate = pc.WORKBUFFER_UPDATE_ONCE;
};

/** Flush the paint queue in one go (same rules as `update`) so GPU textures match committed strokes. */
const drainPendingPaints = () => {
    while (pendingPaints.length) {
        const ops = pendingPaints.splice(0);
        for (const op of ops) {
            if (op.layerId) {
                const lyr = layers.find((l) => l.id === op.layerId);
                const pb = lyr?._gsplatPaint;
                if (pb) applyPaintOpToPaintable(pb, op);
            } else {
                for (const p of paintables) {
                    applyPaintOpToPaintable(p, op);
                }
            }
        }
    }
};

// ── Splat creation ────────────────────────────────────────────────────────────
const createPaintableSplat = async (asset, opts = {}) => {
    const resource = asset.resource;

    // Follow the official PlayCanvas paint example pattern:
    // 1. Create entity and add gsplat component with the loaded asset + unified:true
    // 2. Add the entity to the scene
    // 3. Add extra streams to the resource format
    // 4. Initialize instance textures to zero
    // 5. Set up workBufferModifier and parameters

    const entity = new pc.Entity('splat');
    // Pass the loaded asset directly so the placement is created immediately.
    // unified:true enables setWorkBufferModifier, setParameter, getInstanceTexture.
    const     gsplatComponent = entity.addComponent('gsplat', { asset, unified: true });
    baseContainer.addChild(entity);

    // Add extra instance streams AFTER the component has the resource.
    // customColor  → accumulates paint   (ALPHABLEND)
    // customOpacity → accumulates erase  (ADDITIVE)
    const fmt = resource.format;
    if (!fmt.extraStreams?.find(s => s.name === 'customColor')) {
        fmt.addExtraStreams([
            { name: 'customColor',    format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
            { name: 'customOpacity',  format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
            { name: 'customSelection', format: pc.PIXELFORMAT_RGBA8, storage: pc.GSPLAT_STREAM_INSTANCE },
        ]);
    }

    // Zero-initialize instance textures so unpainted splats are unaffected.
    // getInstanceTexture only works after streams are added and in unified mode.
    const colorTex = gsplatComponent.getInstanceTexture('customColor');
    if (colorTex) { const d = colorTex.lock(); if (d) d.fill(0); colorTex.unlock(); }
    if (opts?.staggerHeavyInit) await yieldOneFrame();

    const opacityTex = gsplatComponent.getInstanceTexture('customOpacity');
    if (opacityTex) { const d = opacityTex.lock(); if (d) d.fill(0); opacityTex.unlock(); }
    if (opts?.staggerHeavyInit) await yieldOneFrame();

    const selTex = gsplatComponent.getInstanceTexture('customSelection');
    if (selTex) { const d = selTex.lock(); if (d) d.fill(0); selTex.unlock(); }
    if (opts?.staggerHeavyInit) await yieldOneFrame();

    // Apply work-buffer modifier and per-instance parameters AFTER the placement exists.
    gsplatComponent.setWorkBufferModifier({ glsl: MODIFIER_GLSL, wgsl: MODIFIER_WGSL });
    gsplatComponent.setParameter('uBlendMode',     0);
    gsplatComponent.setParameter('uShowSelection', 0);
    gsplatComponent.setParameter('uSelectionColor', selectionHighlightColor());
    pushSplatViewShaderUniforms(gsplatComponent);
    gsplatComponent.setParameter('uHoverSphere',   [0, 0, 0, 0]);
    gsplatComponent.setParameter('uHoverColor',    [1, 1, 1, 0]);
    applyColorGradeToGsplat(gsplatComponent, baseColorGrade);
    pushLayerOpacityToGsplat(gsplatComponent, baseLayerOpacityPct);
    applyRenderBoxToGsplat(gsplatComponent, baseRenderBox);
    pushWorldToModelUniform(gsplatComponent);

    const processors = createGsplatPaintProcessors(gsplatComponent);
    paintables.push({ entity, gsplatComponent, ...processors });

    // Cache splat data for CPU export.
    // We use PlayCanvas's internal getProp() API to pull every standard
    // Gaussian Splat property so the exported file is a valid 3DGS file.
    const data = await resolveGsplatCpuData(resource.gsplatData);
    if (opts?.staggerHeavyInit) await yieldOneFrame();

    if (data) {
        const n = data.numSplats;

        // Higher-order SH (f_rest_*) deferred: duplicate GPU data — hydrate in ensureBaseGsplatShRestHydratedFromDeferred.

        // Collect extra standard Gaussian Splat properties (scale, rotation, normals).
        // These are required for a valid Gaussian Splat PLY/SOG.
        const EXTRA_PROPS = [
            'nx', 'ny', 'nz',
            'scale_0', 'scale_1', 'scale_2',
            'rot_0',   'rot_1',   'rot_2',   'rot_3',
        ];
        const extra = {};
        for (let pi = 0; pi < EXTRA_PROPS.length; pi++) {
            const prop = EXTRA_PROPS[pi];
            const a = data.getProp(prop);
            if (a) extra[prop] = floatPropToCache(a);
            if (opts?.staggerHeavyInit && pi === 2) await yieldOneFrame();
        }

        const xCol = floatPropToCache(data.getProp('x'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const yCol = floatPropToCache(data.getProp('y'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const zCol = floatPropToCache(data.getProp('z'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const f0 = floatPropToCache(data.getProp('f_dc_0'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const f1 = floatPropToCache(data.getProp('f_dc_1'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const f2 = floatPropToCache(data.getProp('f_dc_2'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();
        const op = floatPropToCache(data.getProp('opacity'));
        if (opts?.staggerHeavyInit) await yieldOneFrame();

        const srcBytes = opts.sourceFileBytes ?? 0;
        let bminx = Infinity;
        let bminy = Infinity;
        let bminz = Infinity;
        let bmaxx = -Infinity;
        let bmaxy = -Infinity;
        let bmaxz = -Infinity;
        for (let i = 0; i < n; i++) {
            const xi = xCol[i];
            const yi = yCol[i];
            const zi = zCol[i];
            bminx = Math.min(bminx, xi);
            bmaxx = Math.max(bmaxx, xi);
            bminy = Math.min(bminy, yi);
            bmaxy = Math.max(bmaxy, yi);
            bminz = Math.min(bminz, zi);
            bmaxz = Math.max(bmaxz, zi);
        }

        gsplatDataCache = {
            numSplats: n,
            x:       xCol,
            y:       yCol,
            z:       zCol,
            fdc0:    f0,
            fdc1:    f1,
            fdc2:    f2,
            opacity: op,
            shRest: null,
            _cpuGsplatDataForShRest: data,
            extra,   // scale, rotation, normals, etc.
            bounds: { min: [bminx, bminy, bminz], max: [bmaxx, bmaxy, bmaxz] },
            _sourceFileBytes: srcBytes,
        };
        selectionMask = new Uint8Array(n);
        resetBaseSplatAliveMask(n);
        if (opts?.staggerHeavyInit) await yieldOneFrame();
    }

    applyModelRotation();
    refreshBaseGizmoMassPivotChild();
    refreshLayerGizmoAttachment();

    if (gsplatDataCache && shouldSpatialChunkBase(gsplatDataCache.numSplats, opts)) {
        await replaceMonolithicBaseWithSpatialChunks(asset, opts);
    }
    if (!opts?.preserveCamera && gsplatDataCache?.bounds) {
        applyBaseOrbitFromCachedBounds();
    }
    requestAnimationFrame(() => resizeCanvasToContainer());
};

/** Build layer-style splat objects from PlayCanvas gsplat decompressed data. */
const gsplatDataToSplats = (data) => {
    if (!data?.numSplats) return [];
    const n = data.numSplats;
    const x = data.getProp('x');
    const y = data.getProp('y');
    const z = data.getProp('z');
    const fdc0 = data.getProp('f_dc_0');
    const fdc1 = data.getProp('f_dc_1');
    const fdc2 = data.getProp('f_dc_2');
    const op = data.getProp('opacity');
    const nx = data.getProp('nx');
    const ny = data.getProp('ny');
    const nz = data.getProp('nz');
    const sc0 = data.getProp('scale_0');
    const sc1 = data.getProp('scale_1');
    const sc2 = data.getProp('scale_2');
    const r0 = data.getProp('rot_0');
    const r1 = data.getProp('rot_1');
    const r2 = data.getProp('rot_2');
    const r3 = data.getProp('rot_3');
    const shProps = [];
    for (let k = 0; k < 45; k++) {
        const name = `f_rest_${k}`;
        if (data.getProp(name)) shProps.push(name);
    }
    const splats = [];
    for (let i = 0; i < n; i++) {
        const s = {
            x: x[i], y: y[i], z: z[i],
            f_dc_0: fdc0[i], f_dc_1: fdc1[i], f_dc_2: fdc2[i],
            opacity: op[i],
            scale_0: sc0 ? sc0[i] : -5,
            scale_1: sc1 ? sc1[i] : -5,
            scale_2: sc2 ? sc2[i] : -5,
            rot_0: r0 ? r0[i] : 1,
            rot_1: r1 ? r1[i] : 0,
            rot_2: r2 ? r2[i] : 0,
            rot_3: r3 ? r3[i] : 0,
            nx: nx ? nx[i] : 0,
            ny: ny ? ny[i] : 1,
            nz: nz ? nz[i] : 0,
        };
        for (const key of shProps) {
            s[key] = data.getProp(key)[i];
        }
        splats.push(s);
    }
    return splats;
};

/** Same as gsplatDataToSplats but yields so the UI stays responsive on huge layers. */
const GSPLAT_TO_SPLATS_YIELD_EVERY = 48_000;
const gsplatDataToSplatsAsync = async (data) => {
    if (!data?.numSplats) return [];
    const n = data.numSplats;
    const x = data.getProp('x');
    const y = data.getProp('y');
    const z = data.getProp('z');
    const fdc0 = data.getProp('f_dc_0');
    const fdc1 = data.getProp('f_dc_1');
    const fdc2 = data.getProp('f_dc_2');
    const op = data.getProp('opacity');
    const nx = data.getProp('nx');
    const ny = data.getProp('ny');
    const nz = data.getProp('nz');
    const sc0 = data.getProp('scale_0');
    const sc1 = data.getProp('scale_1');
    const sc2 = data.getProp('scale_2');
    const r0 = data.getProp('rot_0');
    const r1 = data.getProp('rot_1');
    const r2 = data.getProp('rot_2');
    const r3 = data.getProp('rot_3');
    const shProps = [];
    for (let k = 0; k < 45; k++) {
        const name = `f_rest_${k}`;
        if (data.getProp(name)) shProps.push(name);
    }
    const splats = new Array(n);
    for (let i = 0; i < n; i++) {
        const s = {
            x: x[i], y: y[i], z: z[i],
            f_dc_0: fdc0[i], f_dc_1: fdc1[i], f_dc_2: fdc2[i],
            opacity: op[i],
            scale_0: sc0 ? sc0[i] : -5,
            scale_1: sc1 ? sc1[i] : -5,
            scale_2: sc2 ? sc2[i] : -5,
            rot_0: r0 ? r0[i] : 1,
            rot_1: r1 ? r1[i] : 0,
            rot_2: r2 ? r2[i] : 0,
            rot_3: r3 ? r3[i] : 0,
            nx: nx ? nx[i] : 0,
            ny: ny ? ny[i] : 1,
            nz: nz ? nz[i] : 0,
        };
        for (const key of shProps) {
            s[key] = data.getProp(key)[i];
        }
        splats[i] = s;
        if (i > 0 && i % GSPLAT_TO_SPLATS_YIELD_EVERY === 0) await yieldNextMacrotask();
    }
    return splats;
};

const collectShKeysFromSplatsArray = (arr) => {
    if (!arr.length) return [];
    const set = new Set();
    for (const s of arr) {
        for (const k of Object.keys(s)) {
            if (/^f_rest_\d+$/.test(k)) set.add(k);
        }
    }
    return [...set].sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
};

/** Remove imported base splat; user layers are kept. */
const removeBaseModel = () => {
    if (!paintables.length) return;
    if (!confirm('Remove the imported base model? Strokes on it are discarded. Layers are kept.')) return;
    for (const p of paintables) {
        p.paintProcessor.destroy?.();
        p.eraseProcessor.destroy?.();
        p.resetColorProcessor?.destroy?.();
        p.resetOpacityProcessor?.destroy?.();
        p.entity.destroy();
    }
    paintables.length = 0;
    gsplatDataCache = null;
    baseSpatialChunkingActive = false;
    baseSpatialStreamRadius = null;
    baseLayerHiddenByUser = false;
    adaptiveBaseSplatBudget = null;
    adaptiveRenderScaleCap = null;
    adaptTimer = 0;
    adaptGoodWindows = 0;
    baseSplatAliveMask = null;
    selectionMask = null;
    strokes.length = 0;
    redoStack.length = 0;
    activeStroke = null;
    baseModelName = '';
    baseTransform = createDefaultLayerTransform();
    baseRenderBox = createDefaultRenderBox();
    destroyGradeLutGpu(baseColorGrade);
    baseColorGrade = createDefaultColorGrade();
    baseLayerOpacityPct = 100;
    updateUndoRedoUI();
    if (layers.length) {
        selectedLayerId = layers[0].id;
        hasSelection = !!(layers[0].selectionMask?.some((v) => v > 0));
    } else {
        selectedLayerId = 'base';
        hasSelection = false;
    }
    renderLayersUI();
    updateSelectionUI();
    pruneUnusedGsplatAssetsFromRegistry();
    requestAnimationFrame(() => resizeCanvasToContainer());
};

/** Load PLY/SOG as a CPU splat layer (does not replace the scene). */
const importSplatAsLayer = async (source) => {
    if (!(await ensureCanLoadModel())) return;
    emptySceneLoadingDepth++;
    updateEmptyScenePlaceholder();
    showModelImportProgress('Importing layer…');
    instructions.innerHTML = '';

    let loadUrl;
    let originalUrl;
    if (source instanceof File) {
        loadUrl = URL.createObjectURL(source);
        originalUrl = source.name;
    } else {
        loadUrl = originalUrl = source;
    }

    try {
        await new Promise((resolve, reject) => {
        let detachProgress = null;
        const assetName = `importLayer-${Date.now()}`;
        const asset = new pc.Asset(assetName, 'gsplat', { url: loadUrl, filename: originalUrl }, gsplatAssetDataForFilename(originalUrl));
        app.assets.add(asset);
        detachProgress = wireAssetDownloadProgress(asset);
        asset.once('load', async (a) => {
            try {
                detachProgress?.();
                detachProgress = null;
                setModelImportProgressIndeterminate('Reading splat data…');
                const resource = a.resource;
                const data = await resolveGsplatCpuData(resource.gsplatData);
                if (!data?.numSplats) {
                    if (source instanceof File) URL.revokeObjectURL(loadUrl);
                    instructions.innerHTML = '<p style="color:#f88">Could not read splat data.</p>';
                    reject(new Error('No splat data'));
                    return;
                }
                const baseName = source instanceof File
                    ? source.name.replace(/\.[^/.]+$/, '')
                    : (originalUrl.split('/').pop() ?? 'Imported').replace(/\.[^/.]+$/, '');
                const layer = {
                    id: `layer-${layerIdCounter++}`,
                    name: baseName || 'Imported',
                    visible: true,
                    opacityPct: 100,
                    splats: [],
                    selectionMask: null,
                    colorGrade: cloneColorGrade(),
                    renderBox: createDefaultRenderBox(),
                    ...createDefaultLayerTransform(),
                };
                // Mass-origin in typed arrays first (matches later splat objects); keep world snap for GPU entity placement.
                setModelImportProgressIndeterminate('Centering…');
                const wcSnap = shiftGsplatCpuDataMassOriginForLayer(layer, data, null);
                if (wcSnap) layer._importMassWorldSnap = wcSnap;
                // PLY columns from getProp directly — avoids splatsToDataTable’s O(n × columns) maps on huge layers.
                layer._layerImportPlyTable = dataTableFromGsplatCpuData(data);
                setModelImportProgressIndeterminate('Preparing splats…');
                layer.splats = await gsplatDataToSplatsAsync(data);
                layers.push(layer);
                selectedLayerId = layer.id;
                hasSelection = false;
                try {
                    app.assets.remove(asset);
                } catch (_) { /* optional API */ }

                if (source instanceof File) URL.revokeObjectURL(loadUrl);
                instructions.innerHTML = '';
                renderLayersUI();
                setModelImportProgressIndeterminate('Building layer view…');
                updateLayerEntity(layer).then(() => {
                    applyModelRotation();
                    refreshLayerGizmoAttachment();
                    frameCameraOnSelectedLayer();
                    getPosthog()?.capture('layer_imported', {
                        file_name: source instanceof File ? source.name : (originalUrl.split('/').pop() ?? ''),
                        splat_count: layer.splats.length,
                    });
                    resolve();
                }).catch((err) => {
                    instructions.innerHTML = `<p style="color:#f88">${err?.message || err}</p>`;
                    reject(err);
                });
            } catch (err) {
                if (source instanceof File) URL.revokeObjectURL(loadUrl);
                instructions.innerHTML = `<p style="color:#f88">${err.message}</p>`;
                reject(err);
            }
        });
        asset.once('error', (msg) => {
            detachProgress?.();
            detachProgress = null;
            if (source instanceof File) URL.revokeObjectURL(loadUrl);
            instructions.innerHTML = `<p style="color:#f88">Load error: ${msg}</p>`;
            reject(new Error(msg));
        });
        app.assets.load(asset);
        });
    } finally {
        hideModelImportProgress();
        emptySceneLoadingDepth--;
        updateEmptyScenePlaceholder();
    }
};

/** Merge all other user layers into the selected layer (selected must be a user layer). */
const mergeUserLayersIntoSelected = () => {
    const target = layers.find((l) => l.id === selectedLayerId);
    if (!target || selectedLayerId === 'base' || !selectedLayerId) {
        alert('Select a layer in the list (not the base row) to merge into.');
        return;
    }
    const toMerge = layers.filter((l) => l.id !== target.id);
    if (!toMerge.length) {
        alert('Need at least two layers. Add another layer or import one first.');
        return;
    }
    if (!confirm(`Merge ${toMerge.length} other layer(s) into "${target.name}"? Those layers will be removed.`)) return;

    for (const o of toMerge) {
        for (const s of o.splats) target.splats.push({ ...s });
        destroyLayerGsplatPaint(o);
        const ch = layersContainer.findByName(`layer-${o.id}`);
        if (ch) ch.destroy();
    }
    layers.length = 0;
    layers.push(target);
    target.selectionMask = null;
    hasSelection = false;
    selectedLayerId = target.id;
    renderLayersUI();
    updateSelectionUI();
    updateLayerEntity(target);
};

// ── Loading ───────────────────────────────────────────────────────────────────
const unloadAll = () => {
    for (const p of paintables) {
        p.paintProcessor.destroy?.();
        p.eraseProcessor.destroy?.();
        p.resetColorProcessor?.destroy?.();
        p.resetOpacityProcessor?.destroy?.();
        p.entity.destroy();
    }
    paintables.length = 0;
    baseSpatialChunkingActive = false;
    baseSpatialStreamRadius = null;
    baseLayerHiddenByUser = false;
    adaptiveBaseSplatBudget = null;
    adaptiveRenderScaleCap = null;
    adaptTimer = 0;
    adaptGoodWindows = 0;
    for (const layer of [...layers]) {
        destroyLayerGsplatPaint(layer);
    }
    strokes.length = 0; redoStack.length = 0;
    activeStroke = null; gsplatDataCache = null;
    baseSplatAliveMask = null;
    selectionMask = null; hasSelection = false;
    showSelectionHighlight = true;
    { const cb = g('sel-show-highlight'); if (cb) cb.checked = true; }
    selectionSphere = [0,0,0,-1]; lastPaintWorld = null;
    layers.length = 0;
    selectedLayerId = 'base';
    baseModelName = '';
    baseTransform = createDefaultLayerTransform();
    baseRenderBox = createDefaultRenderBox();
    destroyGradeLutGpu(baseColorGrade);
    baseColorGrade = createDefaultColorGrade();
    baseLayerOpacityPct = 100;
    for (const c of layersContainer.children.slice()) c.destroy();
    resetModelRotation();
    pruneUnusedGsplatAssetsFromRegistry();
    updateUndoRedoUI(); updateSelectionUI();
    renderLayersUI();
    requestAnimationFrame(() => resizeCanvasToContainer());
};

/**
 * Swap the base gsplat for a new PLY blob without unloadAll() — keeps user layers, orbit, and
 * global rotation. Clears paint/selection undo stacks (indices no longer match). Used after
 * delete-selected and similar compacting edits.
 */
const replaceBaseModelWithPlyFile = async (file, opts = {}) => {
    if (!opts.skipAuthGate && !(await ensureCanLoadModel())) return;
    const loadUrl = URL.createObjectURL(file);
    const originalUrl = file.name || 'model.ply';
    emptySceneLoadingDepth++;
    updateEmptyScenePlaceholder();
    showModelImportProgress('Updating model…');
    instructions.innerHTML = '';

    try {
        await new Promise((resolve, reject) => {
            let detachProgress = null;
            const assetName = `base-replace-${Date.now()}`;
            const asset = new pc.Asset(assetName, 'gsplat', { url: loadUrl, filename: originalUrl }, gsplatAssetDataForFilename(originalUrl));
            app.assets.add(asset);
            detachProgress = wireAssetDownloadProgress(asset);
            asset.once('load', async (a) => {
                try {
                    detachProgress?.();
                    detachProgress = null;
                    setModelImportProgressIndeterminate('Building scene…');
                    const preserve = opts.preserveCamera;
                    const savedOrbit = preserve ? { target: orbit.target.clone(), distance: orbit.distance, yaw: orbit.yaw, pitch: orbit.pitch } : null;
                    const savedNavMode = preserve ? cameraNavMode : null;
                    const savedFly = preserve ? { pos: flyCam.pos.clone(), yaw: flyCam.yaw, pitch: flyCam.pitch } : null;
                    const savedRot = preserve ? { ...globalModelRotation } : null;
                    const savedLayerId = selectedLayerId;

                    for (const p of paintables) {
                        p.paintProcessor.destroy?.();
                        p.eraseProcessor.destroy?.();
                        p.resetColorProcessor.destroy?.();
                        p.resetOpacityProcessor.destroy?.();
                        p.entity.destroy();
                    }
                    paintables.length = 0;

                    strokes.length = 0;
                    redoStack.length = 0;
                    activeStroke = null;
                    updateUndoRedoUI();

                    for (let i = savedSelections.length - 1; i >= 0; i--) {
                        if (savedSelections[i].layerId === 'base') savedSelections.splice(i, 1);
                    }

                    const staggerHeavyInit = opts.staggerHeavyInit ?? (
                        file instanceof File && file.size >= GSPLAT_LARGE_FILE_STAGGER_BYTES
                    );
                    if (staggerHeavyInit) {
                        await yieldThreeFrames();
                        await yieldNextMacrotask();
                    }
                    await createPaintableSplat(a, {
                        ...opts,
                        staggerHeavyInit,
                        sourceFileBytes: file instanceof File ? file.size : 0,
                    });

                    if (preserve) {
                        if (savedNavMode === 'fly' && savedFly) {
                            flyCam.pos.copy(savedFly.pos);
                            flyCam.yaw = savedFly.yaw;
                            flyCam.pitch = savedFly.pitch;
                            cameraNavMode = 'fly';
                        } else if (savedOrbit) {
                            orbit.target.copy(savedOrbit.target);
                            orbit.distance = savedOrbit.distance;
                            orbit.yaw = savedOrbit.yaw;
                            orbit.pitch = savedOrbit.pitch;
                            cameraNavMode = 'orbit';
                        }
                        syncCameraNavToolbar();
                        updateCamera();
                    }
                    if (preserve && savedRot && paintables.length) {
                        globalModelRotation = { x: savedRot.x, y: savedRot.y, z: savedRot.z };
                        applyModelRotation();
                    }

                    if (layers.some((l) => l.id === savedLayerId)) selectedLayerId = savedLayerId;
                    else selectedLayerId = 'base';

                    setTool(activeTool);
                    URL.revokeObjectURL(loadUrl);
                    instructions.innerHTML = '';
                    renderLayersUI();
                    renderSavedSelectionsList();
                    getPosthog()?.capture('base_model_replaced', { splat_count: gsplatDataCache?.numSplats ?? 0 });
                    resolve();
                } catch (err) {
                    instructions.innerHTML = `<p style="color:#f88">Error: ${err.message}</p>`;
                    console.error('replaceBaseModelWithPlyFile error:', err);
                    reject(err);
                }
            });
            asset.once('error', (msg) => {
                detachProgress?.();
                detachProgress = null;
                URL.revokeObjectURL(loadUrl);
                instructions.innerHTML = `<p style="color:#f88">Load error: ${msg}</p>`;
                console.error('replaceBaseModelWithPlyFile asset error:', msg);
                reject(new Error(msg));
            });
            app.assets.load(asset);
        });
    } finally {
        hideModelImportProgress();
        emptySceneLoadingDepth--;
        updateEmptyScenePlaceholder();
    }
};

const loadSplat = async (source, opts = {}) => {
    if (!opts.skipAuthGate && !(await ensureCanLoadModel())) return;
    emptySceneLoadingDepth++;
    updateEmptyScenePlaceholder();
    showModelImportProgress('Loading model…');
    instructions.innerHTML = '';

    let loadUrl, originalUrl;
    if (source instanceof File) {
        loadUrl = URL.createObjectURL(source);
        originalUrl = source.name;
    } else {
        loadUrl = originalUrl = source;
    }

    try {
        await new Promise((resolve, reject) => {
            let detachProgress = null;
            const asset = new pc.Asset('splat', 'gsplat', { url: loadUrl, filename: originalUrl }, gsplatAssetDataForFilename(originalUrl));
            app.assets.add(asset);
            detachProgress = wireAssetDownloadProgress(asset);
            asset.once('load', async (a) => {
                try {
                    detachProgress?.();
                    detachProgress = null;
                    setModelImportProgressIndeterminate('Building scene…');
                    const preserve = opts.preserveCamera;
                    const savedOrbit = preserve ? { target: orbit.target.clone(), distance: orbit.distance, yaw: orbit.yaw, pitch: orbit.pitch } : null;
                    const savedNavMode = preserve ? cameraNavMode : null;
                    const savedFly = preserve ? { pos: flyCam.pos.clone(), yaw: flyCam.yaw, pitch: flyCam.pitch } : null;
                    const savedRot = preserve ? { ...globalModelRotation } : null;
                    unloadAll();
                    const staggerHeavyInit = opts.staggerHeavyInit ?? (
                        source instanceof File && source.size >= GSPLAT_LARGE_FILE_STAGGER_BYTES
                    );
                    if (staggerHeavyInit) {
                        await yieldThreeFrames();
                        await yieldNextMacrotask();
                    }
                    await createPaintableSplat(a, {
                        ...opts,
                        staggerHeavyInit,
                        sourceFileBytes: source instanceof File ? source.size : 0,
                    });
                    if (preserve) {
                        if (savedNavMode === 'fly' && savedFly) {
                            flyCam.pos.copy(savedFly.pos);
                            flyCam.yaw = savedFly.yaw;
                            flyCam.pitch = savedFly.pitch;
                            cameraNavMode = 'fly';
                        } else if (savedOrbit) {
                            orbit.target.copy(savedOrbit.target);
                            orbit.distance = savedOrbit.distance;
                            orbit.yaw = savedOrbit.yaw;
                            orbit.pitch = savedOrbit.pitch;
                            cameraNavMode = 'orbit';
                        }
                        syncCameraNavToolbar();
                        updateCamera();
                    }
                    if (preserve && savedRot && paintables.length) {
                        globalModelRotation = { x: savedRot.x, y: savedRot.y, z: savedRot.z };
                        applyModelRotation();
                    }
                    baseModelName = source instanceof File ? source.name : (source.split('/').pop() ?? 'Model');
                    selectedLayerId = 'base';
                    setTool(activeTool);
                    updateUndoRedoUI();
                    if (source instanceof File) URL.revokeObjectURL(loadUrl);
                    instructions.innerHTML = '';
                    renderLayersUI();
                    if (!preserve) frameCameraOnSelectedLayer();
                    getPosthog()?.capture('splat_loaded', {
                        file_name: source instanceof File ? source.name : (source.split('/').pop() ?? ''),
                        splat_count: gsplatDataCache?.numSplats ?? 0,
                    });
                    resolve();
                } catch (err) {
                    instructions.innerHTML = `<p style="color:#f88">Error: ${err.message}</p>`;
                    console.error('createPaintableSplat error:', err);
                    reject(err);
                }
            });
            asset.once('error', (msg) => {
                detachProgress?.();
                detachProgress = null;
                instructions.innerHTML = `<p style="color:#f88">Load error: ${msg}</p>`;
                console.error('Asset load error:', msg);
                reject(new Error(msg));
            });
            app.assets.load(asset);
        });
    } finally {
        hideModelImportProgress();
        emptySceneLoadingDepth--;
        updateEmptyScenePlaceholder();
    }
};

// ── Export ────────────────────────────────────────────────────────────────────
// Mirror the GPU pipeline exactly so the exported file matches what you see:
//
//  GPU modifier reads:
//    customColor   = ALPHABLEND accumulation of all paint ops
//    customOpacity = ADDITIVE  accumulation of all erase ops
//  Then applies the CURRENT blend-mode ONCE to the accumulated paint.
//
// We replicate both accumulation strategies and the single blend-mode pass.
const applyAllCpuStrokes = () => {
    if (!gsplatDataCache) return null;
    const { numSplats, x: xA, y: yA, z: zA, fdc0, fdc1, fdc2, opacity } = gsplatDataCache;

    // Per-splat ALPHABLEND paint accumulation (same as GPU customColor texture)
    const cumPR = new Float32Array(numSplats);
    const cumPG = new Float32Array(numSplats);
    const cumPB = new Float32Array(numSplats);
    const cumPA = new Float32Array(numSplats); // accumulated coverage

    // Per-splat ADDITIVE erase accumulation (same as GPU customOpacity texture)
    const cumErase = new Float32Array(numSplats);

    for (const stroke of strokes) {
        // Use cpuOps for export; fallback to ops (sphere data) if cpuOps missing
        const opsToApply = stroke.cpuOps?.length
            ? stroke.cpuOps
            : (stroke.ops || []).map((o) => (
                o.isBucket
                    ? {
                        isBucket: true,
                        r: o.color[0], g: o.color[1], b: o.color[2],
                        intensity: o.color[3], blendMode: blendMode(),
                        ...(o.layerId ? { layerId: o.layerId } : {}),
                    }
                    : {
                        cx: o.sphere[0], cy: o.sphere[1], cz: o.sphere[2],
                        radius: o.sphere[3],
                        r: o.color[0], g: o.color[1], b: o.color[2],
                        intensity: o.color[3], hardness: o.hardness,
                        isErase: o.isErase, blendMode: blendMode(),
                        selectionConstraint: o.selectionConstraint,
                        ...(o.layerId ? { layerId: o.layerId } : {}),
                        ...(o.isErase && o.eraseDepthHalf != null
                            ? { eraseDepthHalf: o.eraseDepthHalf, evX: o.evX, evY: o.evY, evZ: o.evZ }
                            : {}),
                    }
            ));
        if (!opsToApply.length) continue;
        for (const op of opsToApply) {
            if (op.layerId) continue; // layer strokes use GPU textures only (not base CPU cache)
            if (op.isBucket) {
                const a = op.intensity;
                for (let i = 0; i < numSplats; i++) {
                    if (!selectionMask?.[i]) continue;
                    cumPR[i] = op.r * a + cumPR[i] * (1 - a);
                    cumPG[i] = op.g * a + cumPG[i] * (1 - a);
                    cumPB[i] = op.b * a + cumPB[i] * (1 - a);
                    cumPA[i] = a + cumPA[i] * (1 - a);
                }
                continue;
            }
            const r2 = (op.radius * 1.001) ** 2; // small epsilon for fp tolerance
            const sc = op.selectionConstraint != null ? op.selectionConstraint : (hasSelection ? 1 : 0);
            for (let i = 0; i < numSplats; i++) {
                if (sc === 1 && selectionMask?.[i]) continue;
                if (sc === 2 && (!selectionMask || !selectionMask[i])) continue;
                const dx = xA[i] - op.cx, dy = yA[i] - op.cy, dz = zA[i] - op.cz;
                let falloff;
                if (op.isErase) {
                    let tEdge;
                    if ((op.eraseDepthHalf ?? 0) > 1e-8 && op.evX != null) {
                        const evx = op.evX, evy = op.evY, evz = op.evZ;
                        const longitud = dx * evx + dy * evy + dz * evz;
                        const perpSq = dx * dx + dy * dy + dz * dz - longitud * longitud;
                        const perp = Math.sqrt(Math.max(0, perpSq));
                        const R = op.radius;
                        const D = Math.max(op.eraseDepthHalf, 1e-6);
                        if (perp >= R || Math.abs(longitud) > D) continue;
                        tEdge = Math.max(perp / R, Math.abs(longitud) / D);
                    } else {
                        if (dx * dx + dy * dy + dz * dz >= r2) continue;
                        tEdge = Math.sqrt(dx * dx + dy * dy + dz * dz) / op.radius;
                    }
                    const tLin = 1 - tEdge;
                    falloff = op.hardness >= 1
                        ? 1
                        : smoothstepJS(0, Math.max(0.001, 1 - op.hardness), tLin);
                } else {
                    if (dx * dx + dy * dy + dz * dz >= r2) continue;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    falloff = paintPlateauFalloff(dist, op.radius, op.hardness);
                }
                if (falloff < 0.008) continue;
                const a = op.intensity * falloff;

                if (op.isErase) {
                    // GPU erase uses ADDITIVE blend (ONE, ONE) → simple sum
                    cumErase[i] += a;
                } else {
                    // GPU paint uses ALPHABLEND (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
                    // Porter-Duff "over": dst = src*srcA + dst*(1-srcA)
                    cumPR[i] = op.r * a + cumPR[i] * (1 - a);
                    cumPG[i] = op.g * a + cumPG[i] * (1 - a);
                    cumPB[i] = op.b * a + cumPB[i] * (1 - a);
                    cumPA[i] = a + cumPA[i] * (1 - a);
                }
            }
        }
    }

    // Apply accumulated paint/erase to the original SH coefficients.
    // The blend mode is applied ONCE to the accumulated colour — matching how
    // the GPU modifier reads uBlendMode at render time (not per-stroke).
    const curBlend = blendMode();
    const out0  = new Float32Array(fdc0);
    const out1  = new Float32Array(fdc1);
    const out2  = new Float32Array(fdc2);
    const outOp = new Float32Array(opacity);

    for (let i = 0; i < numSplats; i++) {
        // ── paint ────────────────────────────────────────────────────────────
        const a = cumPA[i];
        if (a > 0) {
            const origR = 0.5 + fdc0[i] * SH_C0;
            const origG = 0.5 + fdc1[i] * SH_C0;
            const origB = 0.5 + fdc2[i] * SH_C0;
            let fR, fG, fB;
            switch (curBlend) {
                case 1: // Multiply
                    fR = origR + (origR * cumPR[i] - origR) * a;
                    fG = origG + (origG * cumPG[i] - origG) * a;
                    fB = origB + (origB * cumPB[i] - origB) * a;
                    break;
                case 2: // Lighten
                    fR = origR + (Math.max(origR, cumPR[i]) - origR) * a;
                    fG = origG + (Math.max(origG, cumPG[i]) - origG) * a;
                    fB = origB + (Math.max(origB, cumPB[i]) - origB) * a;
                    break;
                case 3: // Darken
                    fR = origR + (Math.min(origR, cumPR[i]) - origR) * a;
                    fG = origG + (Math.min(origG, cumPG[i]) - origG) * a;
                    fB = origB + (Math.min(origB, cumPB[i]) - origB) * a;
                    break;
                default: // Normal
                    fR = origR + (cumPR[i] - origR) * a;
                    fG = origG + (cumPG[i] - origG) * a;
                    fB = origB + (cumPB[i] - origB) * a;
            }
            out0[i] = (fR - 0.5) / SH_C0;
            out1[i] = (fG - 0.5) / SH_C0;
            out2[i] = (fB - 0.5) / SH_C0;
        }

        // ── erase ────────────────────────────────────────────────────────────
        if (cumErase[i] > 0) {
            outOp[i] = invSigmoid(
                sigmoid(outOp[i]) * (1 - Math.min(1, cumErase[i]))
            );
        }
    }

    return { out0, out1, out2, outOp };
};

// Read paint from GPU textures (guarantees export matches what you see)
const getPaintFromGpu = async (opts = {}) => {
    if (!gsplatDataCache || !paintables.length) return null;
    const n = gsplatDataCache.numSplats;
    const { fdc0, fdc1, fdc2, opacity } = gsplatDataCache;
    const readOptsBase = { mipLevel: 0, face: 0, immediate: true };
    const curBlend = blendMode();

    const useChunks = baseSpatialChunkingActive && paintables.some((pb) => pb.chunkGlobalIndices);
    if (useChunks) {
        const out0 = new Float32Array(fdc0);
        const out1 = new Float32Array(fdc1);
        const out2 = new Float32Array(fdc2);
        const outOp = new Float32Array(opacity);
        const yieldEvery = opts?.yieldEvery ?? 0;
        let iter = 0;
        for (const pb of paintables) {
            const idx = pb.chunkGlobalIndices;
            if (!idx) continue;
            const colorTex = pb.gsplatComponent.getInstanceTexture('customColor');
            const opacityTex = pb.gsplatComponent.getInstanceTexture('customOpacity');
            if (!colorTex || !opacityTex) continue;
            const w = colorTex.width;
            const h = colorTex.height;
            if (w <= 0 || h <= 0) continue;
            if (opts.flushGpuBeforeRead && typeof app.graphicsDevice?.submit === 'function') {
                app.graphicsDevice.submit();
                await yieldNextMacrotask();
            }
            let colorData;
            let opacityData;
            try {
                colorData = await colorTex.read(0, 0, w, h, readOptsBase);
                if (opts.yieldBetweenTextureReads) await yieldNextMacrotask();
                opacityData = await opacityTex.read(0, 0, w, h, readOptsBase);
            } catch (_) {
                continue;
            }
            const maxTex = w * h;
            const nk = idx.length;
            for (let j = 0; j < nk; j++) {
                const i = idx[j];
                if (i < 0 || i >= n) continue;
                const off = Math.min(j, maxTex - 1) * 4;
                const cr = colorData[off] / 255;
                const cg = colorData[off + 1] / 255;
                const cb = colorData[off + 2] / 255;
                const ca = colorData[off + 3] / 255;
                const ea = opacityData[off + 3] / 255;
                const origR = 0.5 + fdc0[i] * SH_C0;
                const origG = 0.5 + fdc1[i] * SH_C0;
                const origB = 0.5 + fdc2[i] * SH_C0;
                let fR;
                let fG;
                let fB;
                if (ca > 0) {
                    switch (curBlend) {
                        case 1: fR = origR + (origR * cr - origR) * ca; fG = origG + (origG * cg - origG) * ca; fB = origB + (origB * cb - origB) * ca; break;
                        case 2: fR = origR + (Math.max(origR, cr) - origR) * ca; fG = origG + (Math.max(origG, cg) - origG) * ca; fB = origB + (Math.max(origB, cb) - origB) * ca; break;
                        case 3: fR = origR + (Math.min(origR, cr) - origR) * ca; fG = origG + (Math.min(origG, cg) - origG) * ca; fB = origB + (Math.min(origB, cb) - origB) * ca; break;
                        default: fR = origR + (cr - origR) * ca; fG = origG + (cg - origG) * ca; fB = origB + (cb - origB) * ca;
                    }
                    out0[i] = (fR - 0.5) / SH_C0;
                    out1[i] = (fG - 0.5) / SH_C0;
                    out2[i] = (fB - 0.5) / SH_C0;
                }
                if (ea > 0) outOp[i] = invSigmoid(sigmoid(opacity[i]) * (1 - Math.min(1, ea)));
                iter++;
                if (yieldEvery > 0 && iter > 0 && iter % yieldEvery === 0) await yieldOneFrame();
            }
        }
        return { out0, out1, out2, outOp };
    }

    const p = paintables[0];
    const colorTex = p.gsplatComponent.getInstanceTexture('customColor');
    const opacityTex = p.gsplatComponent.getInstanceTexture('customOpacity');
    if (!colorTex || !opacityTex) return null;
    const w = colorTex.width;
    const h = colorTex.height;
    if (w <= 0 || h <= 0) return null;
    if (opts.flushGpuBeforeRead && typeof app.graphicsDevice?.submit === 'function') {
        app.graphicsDevice.submit();
        await yieldNextMacrotask();
    }
    let colorData;
    let opacityData;
    try {
        colorData = await colorTex.read(0, 0, w, h, readOptsBase);
        if (opts.yieldBetweenTextureReads) await yieldNextMacrotask();
        opacityData = await opacityTex.read(0, 0, w, h, readOptsBase);
    } catch (_) {
        return null;
    }
    const tryWorker = opts.useWorkerMerge && typeof Worker !== 'undefined' && n >= MIN_SPLATS_FOR_GPU_MERGE_WORKER;
    if (tryWorker) {
        try {
            return await mergeGpuPaintReadbackInWorker(n, w, h, curBlend, colorData, opacityData, fdc0, fdc1, fdc2, opacity);
        } catch (werr) {
            console.warn('[getPaintFromGpu] worker merge failed, using main thread', werr);
        }
    }
    const out0 = new Float32Array(fdc0);
    const out1 = new Float32Array(fdc1);
    const out2 = new Float32Array(fdc2);
    const outOp = new Float32Array(opacity);
    const yieldEvery = opts?.yieldEvery ?? 0;
    for (let i = 0; i < n; i++) {
        const off = Math.min(i, w * h - 1) * 4;
        const cr = colorData[off] / 255;
        const cg = colorData[off + 1] / 255;
        const cb = colorData[off + 2] / 255;
        const ca = colorData[off + 3] / 255;
        const ea = opacityData[off + 3] / 255;
        const origR = 0.5 + fdc0[i] * SH_C0;
        const origG = 0.5 + fdc1[i] * SH_C0;
        const origB = 0.5 + fdc2[i] * SH_C0;
        let fR;
        let fG;
        let fB;
        if (ca > 0) {
            switch (curBlend) {
                case 1: fR = origR + (origR * cr - origR) * ca; fG = origG + (origG * cg - origG) * ca; fB = origB + (origB * cb - origB) * ca; break;
                case 2: fR = origR + (Math.max(origR, cr) - origR) * ca; fG = origG + (Math.max(origG, cg) - origG) * ca; fB = origB + (Math.max(origB, cb) - origB) * ca; break;
                case 3: fR = origR + (Math.min(origR, cr) - origR) * ca; fG = origG + (Math.min(origG, cg) - origG) * ca; fB = origB + (Math.min(origB, cb) - origB) * ca; break;
                default: fR = origR + (cr - origR) * ca; fG = origG + (cg - origG) * ca; fB = origB + (cb - origB) * ca;
            }
            out0[i] = (fR - 0.5) / SH_C0;
            out1[i] = (fG - 0.5) / SH_C0;
            out2[i] = (fB - 0.5) / SH_C0;
        }
        if (ea > 0) outOp[i] = invSigmoid(sigmoid(opacity[i]) * (1 - Math.min(1, ea)));
        if (yieldEvery > 0 && i > 0 && i % yieldEvery === 0) await yieldOneFrame();
    }
    return { out0, out1, out2, outOp };
};

/**
 * Bake GPU customColor/customOpacity into SH DC + opacity for one user layer.
 * Uses `layer._cpuToGpuSplat` so texel indices match the paint pipeline (same as selection).
 */
const getLayerPaintFromGpu = async (layer, gsplat) => {
    const n = layer.splats.length;
    if (!n) return null;
    const colorTex = gsplat.getInstanceTexture('customColor');
    const opacityTex = gsplat.getInstanceTexture('customOpacity');
    if (!colorTex || !opacityTex) return null;
    const w = colorTex.width;
    const h = colorTex.height;
    if (w <= 0 || h <= 0) return null;
    let colorData;
    let opacityData;
    try {
        colorData = await colorTex.read(0, 0, w, h, { immediate: true });
        opacityData = await opacityTex.read(0, 0, w, h, { immediate: true });
    } catch (_) {
        return null;
    }
    const map = layer._cpuToGpuSplat;
    const curBlend = blendMode();
    const numTexels = w * h;
    const out0 = new Float32Array(n);
    const out1 = new Float32Array(n);
    const out2 = new Float32Array(n);
    const outOp = new Float32Array(n);

    for (let cpu = 0; cpu < n; cpu++) {
        const splat = layer.splats[cpu];
        const fdc0 = splat.f_dc_0 ?? 0;
        const fdc1 = splat.f_dc_1 ?? 0;
        const fdc2 = splat.f_dc_2 ?? 0;
        const op = splat.opacity ?? 0;
        const origR = 0.5 + fdc0 * SH_C0;
        const origG = 0.5 + fdc1 * SH_C0;
        const origB = 0.5 + fdc2 * SH_C0;

        out0[cpu] = fdc0;
        out1[cpu] = fdc1;
        out2[cpu] = fdc2;
        outOp[cpu] = op;

        const gpu = map ? map[cpu] : cpu;
        if (gpu < 0 || gpu >= numTexels) continue;
        const off = gpu * 4;
        const cr = colorData[off] / 255;
        const cg = colorData[off + 1] / 255;
        const cb = colorData[off + 2] / 255;
        const ca = colorData[off + 3] / 255;
        const ea = opacityData[off + 3] / 255;

        if (ca > 0) {
            let fR;
            let fG;
            let fB;
            switch (curBlend) {
                case 1:
                    fR = origR + (origR * cr - origR) * ca;
                    fG = origG + (origG * cg - origG) * ca;
                    fB = origB + (origB * cb - origB) * ca;
                    break;
                case 2:
                    fR = origR + (Math.max(origR, cr) - origR) * ca;
                    fG = origG + (Math.max(origG, cg) - origG) * ca;
                    fB = origB + (Math.max(origB, cb) - origB) * ca;
                    break;
                case 3:
                    fR = origR + (Math.min(origR, cr) - origR) * ca;
                    fG = origG + (Math.min(origG, cg) - origG) * ca;
                    fB = origB + (Math.min(origB, cb) - origB) * ca;
                    break;
                default:
                    fR = origR + (cr - origR) * ca;
                    fG = origG + (cg - origG) * ca;
                    fB = origB + (cb - origB) * ca;
            }
            out0[cpu] = (fR - 0.5) / SH_C0;
            out1[cpu] = (fG - 0.5) / SH_C0;
            out2[cpu] = (fB - 0.5) / SH_C0;
        }
        if (ea > 0) {
            outOp[cpu] = invSigmoid(sigmoid(op) * (1 - Math.min(1, ea)));
        }
    }
    return { out0, out1, out2, outOp };
};

/**
 * Save a Blob as a file. Safari/macOS leaves `name.ply.download` if revokeObjectURL runs
 * before the download finishes; we defer revoke. Chromium can use the Save dialog when available.
 */
const triggerBlobDownload = async (blob, downloadFilename) => {
    const lower = downloadFilename.toLowerCase();
    const isPly = lower.endsWith('.ply');
    const isJson = lower.endsWith('.json');

    if (typeof window.showSaveFilePicker === 'function') {
        try {
            const types = isPly
                ? [{ description: 'PLY (Gaussian splat)', accept: { 'application/octet-stream': ['.ply'] } }]
                : isJson
                    ? [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
                    : [{ description: 'File', accept: { 'application/octet-stream': [lower.match(/\.[^.]+$/)?.[0] || '.bin'] } }];
            const handle = await window.showSaveFilePicker({
                suggestedName: downloadFilename,
                types,
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (e) {
            if (e?.name === 'AbortError') return;
            console.warn('Save picker failed, using download link:', e);
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 60_000);
};

const exportToFile = async () => {
    commitActiveColorGradeFromUI();
    const hasBase = !!(gsplatDataCache && paintables.length > 0);
    const layerSplats = [];
    const layerEntities = [];
    for (const layer of layers) {
        if (!layer.visible) continue;
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        for (const s of layer.splats) {
            layerSplats.push(s);
            layerEntities.push(ent);
        }
    }
    if (!hasBase && layerSplats.length === 0) {
        alert('Nothing to export.');
        return;
    }

    let nBase = 0;
    let xA;
    let yA;
    let zA;
    let shRest = [];
    let extra = {};
    let out0;
    let out1;
    let out2;
    let outOp;
    const emptyF = new Float32Array(0);

    if (hasBase) {
        ensureBaseGsplatShRestHydratedFromDeferred();
        ({ x: xA, y: yA, z: zA, shRest, extra } = gsplatDataCache);
        const painted = await getPaintFromGpu() ?? applyAllCpuStrokes();
        const p = painted ?? {
            out0: gsplatDataCache.fdc0, out1: gsplatDataCache.fdc1,
            out2: gsplatDataCache.fdc2, outOp: gsplatDataCache.opacity,
        };
        out0 = p.out0;
        out1 = p.out1;
        out2 = p.out2;
        outOp = p.outOp;
        nBase = gsplatDataCache.numSplats;
    } else {
        xA = emptyF;
        yA = emptyF;
        zA = emptyF;
        out0 = emptyF;
        out1 = emptyF;
        out2 = emptyF;
        outOp = emptyF;
    }

    const nLayer = layerSplats.length;
    const nTotal = nBase + nLayer;

    // Bake layer brush/erase from GPU (customColor / customOpacity) — same logic as base getPaintFromGpu.
    const layerFdc0 = new Float32Array(nLayer);
    const layerFdc1 = new Float32Array(nLayer);
    const layerFdc2 = new Float32Array(nLayer);
    const layerOpBaked = new Float32Array(nLayer);
    const layerPaintTargets = [];
    const layerPaintPromises = [];
    for (const layer of layers) {
        if (!layer.visible || !layer.splats.length) continue;
        const ent = layersContainer.findByName(`layer-${layer.id}`);
        if (ent?.gsplat) {
            layerPaintTargets.push(layer);
            layerPaintPromises.push(getLayerPaintFromGpu(layer, ent.gsplat));
        }
    }
    const layerPaintResults = await Promise.all(layerPaintPromises);
    const layerPaintById = new Map();
    layerPaintTargets.forEach((lyr, i) => layerPaintById.set(lyr.id, layerPaintResults[i]));
    let layerFlatIdx = 0;
    for (const layer of layers) {
        if (!layer.visible) continue;
        const bakedGpu = layerPaintById.get(layer.id);
        for (let k = 0; k < layer.splats.length; k++) {
            const s = layer.splats[k];
            if (bakedGpu) {
                layerFdc0[layerFlatIdx] = bakedGpu.out0[k];
                layerFdc1[layerFlatIdx] = bakedGpu.out1[k];
                layerFdc2[layerFlatIdx] = bakedGpu.out2[k];
                layerOpBaked[layerFlatIdx] = bakedGpu.outOp[k];
            } else {
                layerFdc0[layerFlatIdx] = s.f_dc_0 ?? 0;
                layerFdc1[layerFlatIdx] = s.f_dc_1 ?? 0;
                layerFdc2[layerFlatIdx] = s.f_dc_2 ?? 0;
                layerOpBaked[layerFlatIdx] = s.opacity ?? 0;
            }
            layerFlatIdx++;
        }
    }

    const baseEntity = paintables[0]?.entity;

    const baked = {
        x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
        rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
        scale_0: 0, scale_1: 0, scale_2: 0,
    };

    const bx = new Float32Array(nTotal);
    const by = new Float32Array(nTotal);
    const bz = new Float32Array(nTotal);
    const bnx = new Float32Array(nTotal);
    const bny = new Float32Array(nTotal);
    const bnz = new Float32Array(nTotal);
    const br0 = new Float32Array(nTotal);
    const br1 = new Float32Array(nTotal);
    const br2 = new Float32Array(nTotal);
    const br3 = new Float32Array(nTotal);
    const bs0 = new Float32Array(nTotal);
    const bs1 = new Float32Array(nTotal);
    const bs2 = new Float32Array(nTotal);

    if (nBase > 0 && baseEntity) {
        for (let i = 0; i < nBase; i++) {
            bakeSplatAttributesForExport(
                baseEntity,
                xA[i], yA[i], zA[i],
                extra.nx?.[i] ?? 0, extra.ny?.[i] ?? 1, extra.nz?.[i] ?? 0,
                extra.rot_0?.[i] ?? 1, extra.rot_1?.[i] ?? 0, extra.rot_2?.[i] ?? 0, extra.rot_3?.[i] ?? 0,
                extra.scale_0?.[i] ?? -5, extra.scale_1?.[i] ?? -5, extra.scale_2?.[i] ?? -5,
                baked,
            );
            bx[i] = baked.x; by[i] = baked.y; bz[i] = baked.z;
            bnx[i] = baked.nx; bny[i] = baked.ny; bnz[i] = baked.nz;
            br0[i] = baked.rot_0; br1[i] = baked.rot_1; br2[i] = baked.rot_2; br3[i] = baked.rot_3;
            bs0[i] = baked.scale_0; bs1[i] = baked.scale_1; bs2[i] = baked.scale_2;
        }
    }
    for (let i = 0; i < nLayer; i++) {
        const s = layerSplats[i];
        const ent = layerEntities[i];
        const j = nBase + i;
        if (!ent) {
            bx[j] = s.x; by[j] = s.y; bz[j] = s.z;
            bnx[j] = s.nx ?? 0; bny[j] = s.ny ?? 1; bnz[j] = s.nz ?? 0;
            br0[j] = s.rot_0 ?? 1; br1[j] = s.rot_1 ?? 0; br2[j] = s.rot_2 ?? 0; br3[j] = s.rot_3 ?? 0;
            bs0[j] = s.scale_0 ?? -5; bs1[j] = s.scale_1 ?? -5; bs2[j] = s.scale_2 ?? -5;
            continue;
        }
        bakeSplatAttributesForExport(
            ent,
            s.x, s.y, s.z,
            s.nx ?? 0, s.ny ?? 1, s.nz ?? 0,
            s.rot_0 ?? 1, s.rot_1 ?? 0, s.rot_2 ?? 0, s.rot_3 ?? 0,
            s.scale_0 ?? -5, s.scale_1 ?? -5, s.scale_2 ?? -5,
            baked,
        );
        bx[j] = baked.x; by[j] = baked.y; bz[j] = baked.z;
        bnx[j] = baked.nx; bny[j] = baked.ny; bnz[j] = baked.nz;
        br0[j] = baked.rot_0; br1[j] = baked.rot_1; br2[j] = baked.rot_2; br3[j] = baked.rot_3;
        bs0[j] = baked.scale_0; bs1[j] = baked.scale_1; bs2[j] = baked.scale_2;
    }

    const concatColorOpacity = (baseArr, getVal, layerFlat = null) => {
        const out = new Float32Array(nTotal);
        for (let i = 0; i < nBase; i++) out[i] = baseArr?.[i] ?? 0;
        for (let i = 0; i < nLayer; i++) {
            out[nBase + i] = layerFlat ? layerFlat[i] : (getVal ? getVal(layerSplats[i]) : 0);
        }
        return out;
    };

    const concatShKey = (baseArr, key) => {
        const out = new Float32Array(nTotal);
        for (let i = 0; i < nBase; i++) out[i] = baseArr?.[i] ?? 0;
        for (let i = 0; i < nLayer; i++) out[nBase + i] = layerSplats[i][key] ?? 0;
        return out;
    };

    const columns = [];
    const addCol = (name, data) => { if (data) columns.push(new Column(name, data)); };

    // Column order matches standard 3DGS / Inria-style PLY (SuperSplat, splat-transform):
    // xyz, normals, DC SH, f_rest_*, opacity, log-scale, quaternion.
    addCol('x', bx);
    addCol('y', by);
    addCol('z', bz);
    addCol('nx', bnx);
    addCol('ny', bny);
    addCol('nz', bnz);
    const mergedFdc0 = concatColorOpacity(out0, (s) => s.f_dc_0 ?? 0, layerFdc0);
    const mergedFdc1 = concatColorOpacity(out1, (s) => s.f_dc_1 ?? 0, layerFdc1);
    const mergedFdc2 = concatColorOpacity(out2, (s) => s.f_dc_2 ?? 0, layerFdc2);
    if (nBase > 0) {
        applyGradeToFdcTriplets(mergedFdc0, mergedFdc1, mergedFdc2, 0, nBase, baseColorGrade);
    }
    {
        let off = nBase;
        for (const layer of layers) {
            if (!layer.visible) continue;
            ensureLayerColorGrade(layer);
            const cnt = layer.splats.length;
            applyGradeToFdcTriplets(mergedFdc0, mergedFdc1, mergedFdc2, off, cnt, layer.colorGrade);
            off += cnt;
        }
    }
    addCol('f_dc_0', mergedFdc0);
    addCol('f_dc_1', mergedFdc1);
    addCol('f_dc_2', mergedFdc2);

    const baseShKeys = hasBase ? shRest.map((sh) => sh.key) : [];
    const layerShKeys = collectShKeysFromSplatsArray(layerSplats);
    const shKeySet = new Set([...baseShKeys, ...layerShKeys]);
    const allShKeys = [...shKeySet].sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
    for (const key of allShKeys) {
        const shEntry = hasBase ? shRest.find((sh) => sh.key === key) : null;
        columns.push(new Column(key, concatShKey(shEntry?.data ?? null, key)));
    }

    {
        const rawOp = concatColorOpacity(outOp, (s) => s.opacity ?? 0, layerOpBaked);
        const mergedOp = new Float32Array(nTotal);
        for (let i = 0; i < nBase; i++) {
            mergedOp[i] = applyDisplayOpacityMultToLogit(rawOp[i], opacityPctToUniform(baseLayerOpacityPct));
        }
        let oi = nBase;
        for (const layer of layers) {
            if (!layer.visible) continue;
            ensureLayerOpacityPct(layer);
            const m = opacityPctToUniform(layer.opacityPct);
            for (let k = 0; k < layer.splats.length; k++) {
                mergedOp[oi] = applyDisplayOpacityMultToLogit(rawOp[oi], m);
                oi++;
            }
        }
        addCol('opacity', mergedOp);
    }
    addCol('scale_0', bs0);
    addCol('scale_1', bs1);
    addCol('scale_2', bs2);
    addCol('rot_0', br0);
    addCol('rot_1', br1);
    addCol('rot_2', br2);
    addCol('rot_3', br3);

    if (columns.length === 0) { alert('No splat data to export.'); return; }

    // DataTable v2 API: constructor takes only the columns array
    const table    = new DataTable(columns);
    const memFs    = new MemoryFileSystem();
    const base     = getDefaultSnapshotExportBasename();
    const filename = `${base}.ply`;

    try {
        await writePly(
            { filename, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: table }] } },
            memFs,
        );
    } catch (err) {
        console.error('Export error:', err);
        alert(`Export failed: ${err?.message || err}`);
        return;
    }

    const buffer = memFs.results?.get(filename);
    if (!buffer) { alert('Export failed — no output buffer.'); return; }

    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    await triggerBlobDownload(blob, filename);
    getPosthog()?.capture('splat_exported', { format: 'ply', file_name: filename, splat_count: gsplatDataCache?.numSplats ?? 0 });
};

// ── Mouse events ──────────────────────────────────────────────────────────────
// Alt+click: Add ↔ Subtract. Used for the current selection action.
const getEffectiveSelMode = (altKey) => {
    const m = selectionMode;
    if (!altKey) return m;
    if (m === 'add') return 'subtract';
    if (m === 'subtract') return 'add';
    return m;
};

/** UI that sits above the canvas rect; PlayCanvas still maps coords to the canvas, so we hit-test the stack. */
const VIEWPORT_POINTER_UI_BLOCK_SELECTOR = '#floating-gizmo-bar, #left-panel, #right-panel, #options-bar, #menu-bar, #snapshot-modal, #support-modal, #shortcuts-modal, #auth-modal';

const elementBlocksViewportPointerInput = (el) => el instanceof Element && !!el.closest(VIEWPORT_POINTER_UI_BLOCK_SELECTOR);

const eventShouldIgnoreViewportPointer = (e) => {
    const direct = e?.element;
    if (elementBlocksViewportPointerInput(direct)) return true;
    const ne = e?.event;
    if (!ne || typeof ne.clientX !== 'number') return false;
    const stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(ne.clientX, ne.clientY) : [];
    for (let i = 0; i < stack.length; i++) {
        const el = stack[i];
        if (el === canvas) break;
        if (elementBlocksViewportPointerInput(el)) return true;
    }
    return false;
};

app.mouse.on(pc.EVENT_MOUSEDOWN, async (e) => {
    if (eventShouldIgnoreViewportPointer(e)) return;

    lastMouse.x = e.x; lastMouse.y = e.y;

    const isLeft  = e.button === pc.MOUSEBUTTON_LEFT;
    const isRight = e.button === pc.MOUSEBUTTON_RIGHT;

    if (isRight) e.event?.preventDefault?.();

    if (isLeft && activeTool === 'cursor') {
        isOrbiting = true;
        canvasContainer.classList.add('is-dragging');
    }

    if (!isLeft) return;

    if (awaitingSwatchSplatPick) {
        if (hasRenderableSplats()) {
            strokeDepth = await pickStrokeDepth(e.x, e.y, false);
            if (strokeDepth != null) addSwatchFromSplatAtScreen(e.x, e.y);
            strokeDepth = null;
        }
        cancelSwatchSplatPick();
        return;
    }

    if (awaitingSplitToneSplatPick) {
        if (hasRenderableSplats()) {
            strokeDepth = await pickStrokeDepth(e.x, e.y, false);
            if (strokeDepth != null) {
                const pickedHex = pickSplatHexAtScreen(e.x, e.y);
                if (pickedHex) setSplitToneColorFromHex(awaitingSplitToneSplatPick, pickedHex, { commit: true });
            }
            strokeDepth = null;
        }
        cancelSplitToneSplatPick();
        return;
    }

    if (activeTool === 'paintBucket' && hasRenderableSplats()) {
        clearHoverSphere();
        applyPaintBucket();
        return;
    }

    if (activeTool === 'shapeLayer') {
        canvasContainer.classList.add('shape-placement-active');
        const session = ++shapePlaceSession;
        const sx = e.x;
        const sy = e.y;
        shapePlacementDrag = {
            active: true, startX: sx, startY: sy, depth: null, world0: null, session,
        };
        console.log('[shape] mousedown: starting drag session', session);
        (async () => {
            const d = await pickStrokeDepth(sx, sy, true);
            console.log('[shape] pickStrokeDepth resolved, depth =', d, 'session =', session, 'current =', shapePlaceSession);
            if (session !== shapePlaceSession) { console.log('[shape] session mismatch, aborting'); return; }
            const w0Raw = cameraEntity.camera.screenToWorld(sx, sy, d);
            const w0 = new pc.Vec3(w0Raw.x, w0Raw.y, w0Raw.z);
            console.log('[shape] creating preview at', w0.x.toFixed(2), w0.y.toFixed(2), w0.z.toFixed(2));
            ensureShapePreviewRoot();
            shapePreviewOrbitLock = false;
            shapePreviewRoot.setPosition(w0.x, w0.y, w0.z);
            const rot = readShapeRotFromUI();
            shapePreviewRoot.setLocalEulerAngles(rot.rx, rot.ry, rot.rz);
            const dims = readShapeDimsFromUI();
            shapePreviewRoot.setLocalScale(dims.sx, dims.sy, dims.sz);
            rebuildShapePreviewGeometry();
            updateShapeSplatButtonEnabled();
            // Store into drag state for mouse-move scaling (only if still active)
            const drag = shapePlacementDrag;
            if (drag?.session === session) {
                drag.depth = d;
                drag.world0 = w0;
            }
            canvasContainer.classList.remove('shape-placement-active');
            refreshLayerGizmoAttachment();
        })();
        return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'resetBrush') {
        clearHoverSphere();
        if (!hasRenderableSplats()) return;
        strokeDepth = await pickStrokeDepth(e.x, e.y, false);
        if (strokeDepth == null) return;
        isPainting = true;
        lastPaintWorld = null;
        activeStroke = {
            isErase: activeTool === 'eraser',
            isReset: activeTool === 'resetBrush',
            blendMode: blendMode(), ops: [], cpuOps: [],
            selectionBefore: captureSelectionSnapshot(),
        };
        redoStack.length = 0;
        updateUndoRedoUI();
        paintAt(e.x, e.y);
    }

    if (activeTool === 'brushSelect') {
        if (hasRenderableSplats()) {
            strokeDepth = await pickStrokeDepth(e.x, e.y, false);
            if (strokeDepth == null) return;
            pendingSelectionUndoSnap = captureSelectionSnapshot();
            isBrushSelecting = true;
            brushSelectFirstDab = true;
            lastBrushSelectWorld = null;
            brushSelectEffectiveMode = getEffectiveSelMode(e.altKey);
            brushSelectAt(e.x, e.y);
        }
    }

    if (activeTool === 'colorSelect') {
        if (hasRenderableSplats()) {
            strokeDepth = await pickStrokeDepth(e.x, e.y, false);
            if (strokeDepth != null) {
                const worldPt = getWorldPoint(e.x, e.y);
                if (worldPt) {
                    const before = captureSelectionSnapshot();
                    applyColorSelection(worldPt, getEffectiveSelMode(e.altKey), e.x, e.y);
                    pushSelectionUndoFromBefore(before);
                }
            }
            strokeDepth = null;
        }
    }

    if (activeTool === 'lassoSelect' && hasRenderableSplats()) {
        pendingSelectionUndoSnap = captureSelectionSnapshot();
        lassoDragActive = true;
        lassoPoints = [{ x: e.x, y: e.y }];
        lassoEffectiveMode = getEffectiveSelMode(e.altKey);
        redrawSelectionOverlays();
    }

    if (activeTool === 'vectorSelect' && hasRenderableSplats()) {
        const last = vectorPolyPoints[vectorPolyPoints.length - 1];
        if (!last || Math.hypot(e.x - last.x, e.y - last.y) >= 4) {
            vectorPolyPoints.push({ x: e.x, y: e.y });
            redrawSelectionOverlays();
        }
    }

    if (activeTool === 'boxSelect') {
        pendingSelectionUndoSnap = captureSelectionSnapshot();
        boxSelectDrag = { x1: e.x, y1: e.y, x2: e.x, y2: e.y, effectiveMode: getEffectiveSelMode(e.altKey) };
        Object.assign(boxSelectRect.style, {
            left: `${e.x}px`, top: `${e.y}px`, width: '0', height: '0',
        });
        boxSelectRect.classList.add('active');
    }

    if (activeTool === 'generateSplats') {
        if (e.altKey && paintables.length) {
            strokeDepth = await pickStrokeDepth(e.x, e.y);
            const worldPt = getWorldPoint(e.x, e.y);
            if (worldPt) sampleColorAt(worldPt);
            strokeDepth = null;
        } else if (paintables.length) {
            isGenerateSplatsPainting = true;
            lastGenerateSplatsWorld = null;
            strokeDepth = await pickStrokeDepth(e.x, e.y);
            generateSplatsAt(e.x, e.y);
        }
    }

    if (activeTool === 'splatSelect' && hasRenderableSplats()) {
        strokeDepth = await pickStrokeDepth(e.x, e.y, false);
        if (strokeDepth == null) return;
        pendingSelectionUndoSnap = captureSelectionSnapshot();
        isSplatSelecting = true;
        splatPickAt(e.x, e.y, e.shiftKey);
    }
});

app.mouse.on(pc.EVENT_MOUSEMOVE, (e) => {
    const dx = e.x - lastMouse.x;
    const dy = e.y - lastMouse.y;
    lastMouse.x = e.x; lastMouse.y = e.y;

    // Update brush cursor
    if (activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'resetBrush' || activeTool === 'brushSelect' || activeTool === 'generateSplats' || activeTool === 'splatSelect') updateBrushCursorAt(e.x, e.y);

    if (shapePlacementDrag?.active && activeTool === 'shapeLayer' && shapePlacementDrag.depth != null
        && shapePlacementDrag.world0 && shapePreviewRoot?.parent) {
        const w1 = cameraEntity.camera.screenToWorld(e.x, e.y, shapePlacementDrag.depth);
        const w0 = shapePlacementDrag.world0;
        const pxMove = Math.hypot(e.x - shapePlacementDrag.startX, e.y - shapePlacementDrag.startY);
        if (pxMove < 4) {
            const ui = readShapeDimsFromUI();
            shapePreviewRoot.setLocalScale(ui.sx, ui.sy, ui.sz);
        } else {
            const dist = w0.distance(w1);
            const s = Math.max(SHAPE_DIM_MIN, Math.min(SHAPE_DIM_MAX, dist));
            shapePreviewRoot.setLocalScale(s, s, s);
            syncingShapeUIFromPreview = true;
            const sf = (v) => String(Math.round(v * 10000) / 10000);
            if (g('shape-size-x')) g('shape-size-x').value = sf(s);
            if (g('shape-size-y')) g('shape-size-y').value = sf(s);
            if (g('shape-size-z')) g('shape-size-z').value = sf(s);
            syncingShapeUIFromPreview = false;
        }
        shapePreviewRoot.setPosition(w0.x, w0.y, w0.z);
    }

    // Camera look (cursor + left drag)
    if (isOrbiting && activeTool === 'cursor') {
        if (cameraNavMode === 'orbit') {
            orbit.yaw   -= dx * 0.3;
            orbit.pitch += dy * 0.3;
            orbit.pitch  = Math.max(-89, Math.min(89, orbit.pitch));
        } else {
            flyCam.yaw   -= dx * 0.3;
            flyCam.pitch += dy * 0.3;
            flyCam.pitch  = Math.max(-89, Math.min(89, flyCam.pitch));
        }
        updateCamera();
    }

    // Paint / erase / reset
    if (isPainting && (activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'resetBrush')) {
        paintAt(e.x, e.y);
    }

    // Generate splats drag
    if (isGenerateSplatsPainting && activeTool === 'generateSplats') {
        generateSplatsAt(e.x, e.y);
    }

    // Brush select drag
    if (isBrushSelecting && activeTool === 'brushSelect') {
        brushSelectAt(e.x, e.y);
    }

    // Splat select drag
    if (isSplatSelecting && activeTool === 'splatSelect') {
        splatDragSelectAt(e.x, e.y, e.shiftKey);
    }

    // Box select drag
    if (boxSelectDrag) {
        boxSelectDrag.x2 = e.x; boxSelectDrag.y2 = e.y;
        const x = Math.min(boxSelectDrag.x1, e.x);
        const y = Math.min(boxSelectDrag.y1, e.y);
        Object.assign(boxSelectRect.style, {
            left:   `${x}px`, top:    `${y}px`,
            width:  `${Math.abs(e.x - boxSelectDrag.x1)}px`,
            height: `${Math.abs(e.y - boxSelectDrag.y1)}px`,
        });
    }

    if (lassoDragActive && activeTool === 'lassoSelect') {
        const lp = lassoPoints[lassoPoints.length - 1];
        if (lp && Math.hypot(e.x - lp.x, e.y - lp.y) >= 3) {
            lassoPoints.push({ x: e.x, y: e.y });
            redrawSelectionOverlays();
        }
    }

    if (activeTool === 'vectorSelect' && vectorPolyPoints.length) {
        vectorHoverScreen = { x: e.x, y: e.y };
        redrawSelectionOverlays();
    }
});

app.mouse.on(pc.EVENT_MOUSEUP, (e) => {
    const isLeft  = e.button === pc.MOUSEBUTTON_LEFT;
    const isRight = e.button === pc.MOUSEBUTTON_RIGHT;
    if (isLeft)  isOrbiting = false;
    if (!isOrbiting) canvasContainer.classList.remove('is-dragging');

    if (!isLeft) return;

    if (shapePlacementDrag?.active && activeTool === 'shapeLayer') {
        canvasContainer.classList.remove('shape-placement-active');
        shapePlacementDrag = null;
        refreshLayerGizmoAttachment();
    }

    // Commit paint stroke
    if (isPainting && activeStroke?.ops.length) {
        activeStroke.selectionAfter = captureSelectionSnapshot();
        strokes.push(activeStroke);
        updateUndoRedoUI();
    }
    isPainting = false; activeStroke = null; lastPaintWorld = null;
    strokeDepth = null;   // reset for the next stroke

    if (isGenerateSplatsPainting) {
        isGenerateSplatsPainting = false;
        lastGenerateSplatsWorld = null;
        if (layerUpdateTimeout) {
            clearTimeout(layerUpdateTimeout);
            layerUpdateTimeout = null;
            const layer = layers.find((l) => l.id === selectedLayerId);
            if (layer?.splats.length) updateLayerEntity(layer);
        }
    }

    if (isBrushSelecting) {
        isBrushSelecting = false;
        pushSelectionUndoFromBefore(pendingSelectionUndoSnap);
        pendingSelectionUndoSnap = null;
        lastBrushSelectWorld = null;
        brushSelectEffectiveMode = null;
    }

    if (isSplatSelecting) {
        isSplatSelecting = false;
        pushSelectionUndoFromBefore(pendingSelectionUndoSnap);
        pendingSelectionUndoSnap = null;
        strokeDepth = null;
    }

    if (activeTool !== 'brush' && activeTool !== 'eraser' && activeTool !== 'brushSelect' && activeTool !== 'generateSplats' && activeTool !== 'lassoSelect' && activeTool !== 'vectorSelect') {
        brushCursor.style.cssText = '';
    }

    if (lassoDragActive && activeTool === 'lassoSelect') {
        lassoDragActive = false;
        const pending = pendingSelectionUndoSnap;
        pendingSelectionUndoSnap = null;
        const closed = closeSelectionPoly(lassoPoints);
        const mode = lassoEffectiveMode ?? selectionMode;
        lassoPoints.length = 0;
        lassoEffectiveMode = null;
        redrawSelectionOverlays();
        if (closed && getWorldMatEntityForActiveTarget()) {
            applyPolygonSelection(closed, mode);
            pushSelectionUndoFromBefore(pending);
        }
    }

    // Commit box selection
    if (boxSelectDrag) {
        const { x1, y1, x2, y2 } = boxSelectDrag;
        const pending = pendingSelectionUndoSnap;
        pendingSelectionUndoSnap = null;
        if (Math.abs(x2-x1) > 4 && Math.abs(y2-y1) > 4 && getWorldMatEntityForActiveTarget()) {
            applyBoxSelection(x1, y1, x2, y2, boxSelectDrag?.effectiveMode ?? selectionMode);
            pushSelectionUndoFromBefore(pending);
        }
        boxSelectDrag = null;
        boxSelectRect.classList.remove('active');
    }
});

// Scroll: zoom (ignore wheel events that occur right after double-click)
let lastDblClickTime = 0;
const WHEEL_UI_ROOT_SELECTOR = '#right-panel, #left-panel, #options-bar, #menu-bar, #floating-gizmo-bar, #snapshot-modal, #support-modal, #shortcuts-modal, #auth-modal';
window.addEventListener('wheel', (e) => {
    if (Date.now() - lastDblClickTime < 300) return;
    if (e.target instanceof Element && e.target.closest(WHEEL_UI_ROOT_SELECTOR)) return;
    e.preventDefault();
    const dz = e.deltaY * 0.005;
    if (cameraNavMode === 'orbit') {
        orbit.distance = Math.max(0.05, orbit.distance + dz);
    } else {
        getForwardFromYawPitch(flyCam.yaw, flyCam.pitch, _navStep);
        _navStep.mulScalar(-dz * 3);
        flyCam.pos.add(_navStep);
        orbit.distance = Math.max(0.05, orbit.distance + dz);
    }
    updateCamera();
}, { passive: false });

// Double-click: move camera pivot to clicked point (cursor tool only)
canvas.addEventListener('dblclick', async (e) => {
    if (activeTool !== 'cursor') return;
    e.preventDefault();
    e.stopPropagation();
    lastDblClickTime = Date.now();
    if (!hasRenderableSplats()) return;
    isOrbiting = false;
    canvasContainer.classList.remove('is-dragging');
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    strokeDepth = await pickStrokeDepth(x, y, false);
    const worldPt = strokeDepth != null ? getWorldPoint(x, y) : null;
    strokeDepth = null;
    if (worldPt) {
        if (cameraNavMode === 'orbit') {
            orbit.target.copy(worldPt);
        } else {
            getForwardFromYawPitch(flyCam.yaw, flyCam.pitch, _camFwdScratch);
            const d = Math.max(0.2, Math.min(8, flyCam.pos.distance(worldPt) * 0.65));
            flyCam.pos.set(
                worldPt.x - _camFwdScratch.x * d,
                worldPt.y - _camFwdScratch.y * d,
                worldPt.z - _camFwdScratch.z * d,
            );
        }
        updateCamera();
    }
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
const NAV_KEYS = ['w','a','s','d','q','e'];
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (awaitingSwatchSplatPick) {
            cancelSwatchSplatPick();
            e.preventDefault();
            return;
        }
        if (awaitingSplitToneSplatPick) {
            cancelSplitToneSplatPick();
            e.preventDefault();
            return;
        }
        if (isSupportModalOpen()) {
            closeSupportModalSnoozed();
            e.preventDefault();
            return;
        }
        const shortcutsModalEsc = g('shortcuts-modal');
        if (shortcutsModalEsc?.classList.contains('is-open')) {
            shortcutsModalEsc.classList.remove('is-open');
            shortcutsModalEsc.setAttribute('aria-hidden', 'true');
            e.preventDefault();
            return;
        }
        const snapModal = g('snapshot-modal');
        if (snapModal?.classList.contains('is-open')) {
            snapModal.classList.remove('is-open');
            snapModal.setAttribute('aria-hidden', 'true');
            e.preventDefault();
            return;
        }
    }

    if (g('shortcuts-modal')?.classList.contains('is-open')) {
        return;
    }

    if (e.shiftKey && e.code === 'KeyF') {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        e.preventDefault();
        toggleViewerFpsHud();
        return;
    }

    const key = e.key.toLowerCase();

    // Selection mode: 8=New, 9=Add, 0=Subtract when a selection tool is active — before INPUT check
    const selTools = ['boxSelect', 'lassoSelect', 'vectorSelect', 'brushSelect', 'colorSelect', 'splatSelect'];
    if (selTools.includes(activeTool) && ['8', '9', '0'].includes(key)) {
        e.preventDefault();
        setSelectionMode({ '8': 'new', '9': 'add', '0': 'subtract' }[key]);
        return;
    }

    // Brush size (ArrowUp/Down) when brush, eraser, or reset active — handle before INPUT check
    if ((activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'resetBrush') && (key === 'arrowup' || key === 'arrowdown')) {
        e.preventDefault();
        const sliderId = activeTool === 'brush' ? 'brush-size' : activeTool === 'resetBrush' ? 'reset-size' : 'eraser-size';
        const slider = g(sliderId);
        if (slider) {
            const step = parseFloat(slider.step) || 0.005;
            let v = parseFloat(slider.value) || 0.15;
            v = key === 'arrowup' ? v + step : Math.max(parseFloat(slider.min) || 0.005, v - step);
            v = Math.min(parseFloat(slider.max) || 0.5, v);
            slider.value = v;
            const numEl = g(sliderId + '-num');
            if (numEl) numEl.value = v;
        }
        return;
    }

    if (e.key === 'Enter' && activeTool === 'vectorSelect' && vectorPolyPoints.length >= 3) {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            const before = captureSelectionSnapshot();
            const poly = closeSelectionPoly(vectorPolyPoints);
            vectorPolyPoints.length = 0;
            vectorHoverScreen = null;
            redrawSelectionOverlays();
            if (poly && getWorldMatEntityForActiveTarget()) {
                applyPolygonSelection(poly, selectionMode);
                pushSelectionUndoFromBefore(before);
            }
            return;
        }
    }

    if (key === 'backspace' && activeTool === 'vectorSelect' && vectorPolyPoints.length) {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            vectorPolyPoints.pop();
            redrawSelectionOverlays();
            return;
        }
    }

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === '`' || e.code === 'Backquote') {
        if (e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        setCameraNavMode(cameraNavMode === 'orbit' ? 'fly' : 'orbit');
        return;
    }

    // Layer gizmo: 1=Position 2=Rotation 3=Scale (always; selection uses 8/9/0)
    if (['1', '2', '3'].includes(key)) {
        e.preventDefault();
        const m = key === '1' ? 'translate' : key === '2' ? 'rotate' : 'scale';
        layerGizmoMode = m;
        try { localStorage.setItem(LS_LAYER_GIZMO_MODE, m); } catch (_) { /* ignore */ }
        updateLayerGizmoModeButtons();
        refreshLayerGizmoAttachment();
        return;
    }

    if (NAV_KEYS.includes(key) && !e.ctrlKey && !e.metaKey) {
        keysNav[key] = true;
        e.preventDefault();
        return;
    }
    if (e.ctrlKey || e.metaKey) {
        if (key === 'z') { e.preventDefault(); undo(); return; }
        if (key === 'y' || (e.shiftKey && key === 'z')) { e.preventDefault(); redo(); return; }
        if (key === 'd') {
            e.preventDefault();
            if (selectedLayerId && selectedLayerId !== 'base') void duplicateLayer(selectedLayerId);
            return;
        }
    }

    switch (key) {
        case 'v': setTool('cursor');       break;
        case 'r': setTool('boxSelect');    break;
        case 'c': setTool('colorSelect');  break;
        case 'x': setTool('eraser');       break;
        case 'z': setTool('resetBrush');   break;
        case 'h':
            showSelectionHighlight = !showSelectionHighlight;
            {
                const cb = g('sel-show-highlight');
                if (cb) cb.checked = showSelectionHighlight;
            }
            updateSelectionUI();
            break;
        case 'delete': case 'backspace':
            e.preventDefault();
            if (hasSelection) removeSelectedSplats();
            else clearSelection();
            break;
        case 'b': setTool('brush');        break;
        case 'k': setTool('paintBucket');  break;
        case 'o': setTool('brushSelect');  break;
        case 'l': setTool('lassoSelect'); break;
        case 'y': setTool('vectorSelect'); break;
        case 'm':
            e.preventDefault();
            setSplatMode(!splatMode);
            break;
        case 'g':
            e.preventDefault();
            layerGizmoVisible = !layerGizmoVisible;
            try { localStorage.setItem(LS_LAYER_GIZMO_VISIBLE, layerGizmoVisible ? '1' : '0'); } catch (_) { /* ignore */ }
            updateLayerGizmoToggleButton();
            refreshLayerGizmoAttachment();
            break;
        case 'u': setTool('generateSplats'); break;
        case 'n': setTool('shapeLayer');     break;
        case 's': setTool('splatSelect');   break;
        case 'i': if (e.shiftKey) { e.preventDefault(); invertSelection({ recordUndo: true }); } break;
        case 'escape':
            if (activeTool === 'vectorSelect' && vectorPolyPoints.length) {
                vectorPolyPoints.length = 0;
                vectorHoverScreen = null;
                redrawSelectionOverlays();
                break;
            }
            if (activeTool === 'lassoSelect' && (lassoDragActive || lassoPoints.length)) {
                lassoDragActive = false;
                lassoPoints.length = 0;
                lassoEffectiveMode = null;
                pendingSelectionUndoSnap = null;
                redrawSelectionOverlays();
                break;
            }
            if (boxSelectDrag) {
                pendingSelectionUndoSnap = null;
                boxSelectDrag = null;
                boxSelectRect?.classList.remove('active');
            }
            clearSelection({ recordUndo: true });
            if (selTools.includes(activeTool) || activeTool === 'shapeLayer' || activeTool === 'paintBucket') setTool('cursor');
            break;
    }
});
window.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (NAV_KEYS.includes(key)) keysNav[key] = false;
});
window.addEventListener('blur', () => {
    NAV_KEYS.forEach(k => { keysNav[k] = false; });
});
// Focus canvas on click so keyboard works
canvasContainer.addEventListener('mousedown', () => {
    const c = document.getElementById('application-canvas');
    if (c && document.activeElement !== c) c.focus();
});
canvasContainer.addEventListener('mouseleave', () => {
    hideColorPixelLoupe();
    clearHoverSphere();
});

// ── UI bindings ───────────────────────────────────────────────────────────────
g('tool-cursor').addEventListener('click',        () => setTool('cursor'));
g('tool-brush').addEventListener('click',         () => setTool('brush'));
g('tool-eraser').addEventListener('click',        () => setTool('eraser'));
g('tool-resetBrush').addEventListener('click',    () => setTool('resetBrush'));
g('tool-paint-bucket')?.addEventListener('click', () => setTool('paintBucket'));
g('tool-box-select').addEventListener('click',    () => setTool('boxSelect'));
g('tool-lasso-select')?.addEventListener('click', () => setTool('lassoSelect'));
g('tool-vector-select')?.addEventListener('click', () => setTool('vectorSelect'));
g('tool-brush-select').addEventListener('click',  () => setTool('brushSelect'));
g('tool-color-select').addEventListener('click',  () => setTool('colorSelect'));
g('tool-generate-splats').addEventListener('click', () => setTool('generateSplats'));
g('tool-shape-layer')?.addEventListener('click', () => setTool('shapeLayer'));
g('tool-splat-select').addEventListener('click',   () => setTool('splatSelect'));
g('btn-splat-mode').addEventListener('click',      () => setSplatMode(!splatMode));
for (const btn of document.querySelectorAll('.splat-style-btn')) {
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const s = btn.dataset.splatStyle;
        if (s) setSplatViewStyle(s);
    });
}

wireLayersListDragReorder();
g('add-layer-btn').addEventListener('click', addLayer);

['lt-pos-x', 'lt-pos-y', 'lt-pos-z', 'lt-rot-x', 'lt-rot-y', 'lt-rot-z', 'lt-scl-x', 'lt-scl-y', 'lt-scl-z']
    .forEach((id) => {
        const el = g(id);
        if (!el) return;
        enableNumericExprTyping(el);
        el.addEventListener('input', readLayerTransformInputsIntoModel);
        el.addEventListener('change', readLayerTransformInputsIntoModel);
        el.addEventListener('blur', () => {
            if (_syncingLayerTransformUI) return;
            readLayerTransformInputsIntoModel();
            syncLayerTransformUI();
        });
    });
['rb-cx', 'rb-cy', 'rb-cz', 'rb-sx', 'rb-sy', 'rb-sz']
    .forEach((id) => {
        const el = g(id);
        if (!el) return;
        enableNumericExprTyping(el);
        el.addEventListener('input', readRenderBoxInputsIntoModel);
        el.addEventListener('change', readRenderBoxInputsIntoModel);
        el.addEventListener('blur', () => {
            if (_syncingLayerTransformUI) return;
            readRenderBoxInputsIntoModel();
            syncLayerTransformUI();
        });
    });
g('lt-reset-btn')?.addEventListener('click', resetActiveLayerTransform);
g('rb-enabled')?.addEventListener('change', readRenderBoxInputsIntoModel);
g('rb-edit-gizmo-btn')?.addEventListener('click', toggleRenderBoxGizmoEditMode);
g('rb-fit-btn')?.addEventListener('click', fitActiveRenderBoxToBounds);
g('rb-reset-btn')?.addEventListener('click', resetActiveRenderBox);
g('add-shape-preview-btn')?.addEventListener('click', () => placeShapePreviewAtOrbitTarget());
g('splat-shape-btn')?.addEventListener('click', () => splatShapePreviewToLayer());

// Shape color picker ↔ hex sync + persist
g('shape-color')?.addEventListener('input', () => {
    const hex = g('shape-color').value;
    if (g('shape-color-hex')) g('shape-color-hex').value = hex;
    saveShapeToolPrefs();
});
g('shape-color-hex')?.addEventListener('change', () => {
    const norm = normalizeBrushHex(g('shape-color-hex')?.value);
    if (norm) { g('shape-color').value = norm; g('shape-color-hex').value = norm; }
    else { g('shape-color-hex').value = g('shape-color').value; }
    saveShapeToolPrefs();
});
g('shape-type')?.addEventListener('change', onShapePreviewTopologyChanged);
['shape-size-x', 'shape-size-y', 'shape-size-z', 'shape-rot-x', 'shape-rot-y', 'shape-rot-z'].forEach((id) => {
    const el = g(id);
    if (!el) return;
    enableNumericExprTyping(el);
    el.addEventListener('input', onShapePreviewTransformInputsChanged);
    el.addEventListener('change', onShapePreviewTransformInputsChanged);
    el.addEventListener('blur', () => {
        onShapePreviewTransformInputsChanged();
        syncShapeTransformInputsFromApplied();
    });
});
g('shape-hollow-edges')?.addEventListener('change', onShapePreviewTopologyChanged);

g('save-sel-btn').addEventListener('click', saveSelection);
g('export-sel-btn').addEventListener('click', exportSelections);
g('import-sel-btn').addEventListener('click', importSelections);
g('add-swatch-btn').addEventListener('click', addSwatch);
g('pick-swatch-splat-btn')?.addEventListener('click', () => {
    if (awaitingSwatchSplatPick) {
        cancelSwatchSplatPick();
        return;
    }
    if (!hasRenderableSplats()) return;
    cancelSplitToneSplatPick();
    awaitingSwatchSplatPick = true;
    canvasContainer.classList.add('swatch-splat-pick-armed');
    g('pick-swatch-splat-btn')?.classList.add('accent-btn');
});
renderSavedSelectionsList();
loadCachedSwatches();
renderSwatchesList();

g('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        if (await ensureCanLoadModel()) await loadSplat(file);
    }
    e.target.value = '';
});
g('empty-scene-load-btn')?.addEventListener('click', () => g('file-input')?.click());
g('empty-scene-import-btn')?.addEventListener('click', () => g('import-layer-input')?.click());
g('import-layer-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        try {
            await importSplatAsLayer(file);
        } catch (_) { /* error shown in instructions */ }
    }
    e.target.value = '';
});
g('merge-layers-btn')?.addEventListener('click', mergeUserLayersIntoSelected);
g('separate-sel-layer-btn')?.addEventListener('click', () => { void separateSelectionToNewLayer(); });

g('undo-btn').addEventListener('click', undo);
g('redo-btn').addEventListener('click', redo);
g('export-ply').addEventListener('click', () => exportToFile());

const LS_SNAPSHOT_W = 'photoshock-snapshot-w';
const LS_SNAPSHOT_H = 'photoshock-snapshot-h';
const LS_SNAPSHOT_FMT = 'photoshock-snapshot-fmt';
const LS_SNAPSHOT_TRANSP = 'photoshock-snapshot-transparent';

/** Safe single path segment for downloads (no slashes etc.). */
const sanitizeSnapshotExportBasename = (raw) => {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    s = s.replace(/[\\/:*?"<>|]+/g, '-');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s.-]+|[\s.-]+$/g, '');
    if (s === '.' || s === '..') return '';
    const lower = s.toLowerCase();
    if (lower.endsWith('.png')) s = s.slice(0, -4).trim();
    else if (lower.endsWith('.jpeg')) s = s.slice(0, -5).trim();
    else if (lower.endsWith('.jpg')) s = s.slice(0, -4).trim();
    if (!s || s === '.' || s === '..') return '';
    return s.length > 120 ? s.slice(0, 120).trim() : s;
};

/** Top layer in the panel (first user layer), else loaded base model title. */
const getDefaultSnapshotExportBasename = () => {
    const top = layers.length ? String(layers[0].name ?? '').trim() : '';
    const base = String(baseModelName ?? '').trim();
    const pick = top || base || 'Model';
    return sanitizeSnapshotExportBasename(pick) || 'export';
};

const clampSnapshotDim = (v, fallback) => {
    const s = String(v ?? '').trim();
    const ev = parseNumericOrExpr(s);
    const n = ev != null && Number.isFinite(ev) ? Math.round(ev) : parseInt(s, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(64, Math.min(8192, n));
};

const flipRgbaImageY = (pixels, w, h) => {
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
        const y2 = h - 1 - y;
        const o1 = y * row;
        const o2 = y2 * row;
        tmp.set(pixels.subarray(o1, o1 + row));
        pixels.copyWithin(o1, o2, o2 + row);
        pixels.set(tmp, o2);
    }
};

const syncSnapshotTransparentEnabled = () => {
    const fmt = g('snapshot-format')?.value;
    const cb = g('snapshot-transparent');
    if (!cb) return;
    const isPng = fmt === 'png';
    cb.disabled = !isPng;
    if (!isPng) cb.checked = false;
};

const takeViewportSnapshot = async () => {
    const dev = app.graphicsDevice;
    const wIn = g('snapshot-w');
    const hIn = g('snapshot-h');
    const fmtEl = g('snapshot-format');
    const transpEl = g('snapshot-transparent');
    const w = clampSnapshotDim(wIn?.value, dev.width);
    const h = clampSnapshotDim(hIn?.value, dev.height);
    const mime = fmtEl?.value === 'jpeg' ? 'image/jpeg' : 'image/png';
    const wantTransparent = transpEl?.checked && mime === 'image/png';

    try {
        localStorage.setItem(LS_SNAPSHOT_W, String(w));
        localStorage.setItem(LS_SNAPSHOT_H, String(h));
        localStorage.setItem(LS_SNAPSHOT_FMT, fmtEl?.value || 'png');
        localStorage.setItem(LS_SNAPSHOT_TRANSP, wantTransparent ? '1' : '0');
    } catch (_) { /* ignore */ }

    const cam = cameraEntity.camera;
    const pr = cam.clearColor.r;
    const pg = cam.clearColor.g;
    const pb = cam.clearColor.b;
    const pa = cam.clearColor.a;

    const wasGrid = viewportGridEntity.enabled;
    viewportGridEntity.enabled = false;

    if (wantTransparent) {
        cam.clearColor.set(0, 0, 0, 0);
    } else {
        const hex = g('bg-color-input')?.value || '#24252b';
        hexToColor(hex);
        cam.clearColor.a = 1;
    }

    try {
        app.resizeCanvas(w, h);
        await new Promise((r) => requestAnimationFrame(r));
        app.render();
        await new Promise((r) => requestAnimationFrame(r));
        app.render();

        const hasReadPixels =
            typeof dev.readPixelsAsync === 'function' || typeof dev.readPixels === 'function';

        let blob;
        if (hasReadPixels) {
            const pixels = new Uint8Array(w * h * 4);
            if (typeof dev.readPixelsAsync === 'function') {
                await dev.readPixelsAsync(0, 0, w, h, pixels, true);
            } else {
                dev.readPixels(0, 0, w, h, pixels);
            }
            flipRgbaImageY(pixels, w, h);

            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);

            blob = await new Promise((res, rej) => {
                if (mime === 'image/jpeg') {
                    c.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encode failed'))), mime, 0.92);
                } else {
                    c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), mime);
                }
            });
        } else {
            // WebGPU (and similar): GraphicsDevice has no readPixels; snapshot via the canvas API.
            const canvas = dev.canvas;
            if (!canvas?.toBlob) {
                throw new Error(
                    'This renderer cannot read the framebuffer (try WebGL, or a browser that supports canvas snapshots with WebGPU).',
                );
            }
            blob = await new Promise((res, rej) => {
                if (mime === 'image/jpeg') {
                    canvas.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encode failed'))), mime, 0.92);
                } else {
                    canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), mime);
                }
            });
        }
        const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
        let base = sanitizeSnapshotExportBasename(g('snapshot-filename')?.value);
        if (!base) base = getDefaultSnapshotExportBasename();
        void triggerBlobDownload(blob, `${base}.${ext}`);
        getPosthog()?.capture('viewport_snapshot_taken', { format: ext, width: w, height: h, transparent: wantTransparent, basename: base });
    } catch (err) {
        console.error('[snapshot]', err);
        alert(`Snapshot failed: ${err?.message || err}`);
    } finally {
        cam.clearColor.set(pr, pg, pb, pa);
        viewportGridEntity.enabled = wasGrid;
        resizeCanvasToContainer();
        requestAnimationFrame(() => app.render());
    }
};

g('snapshot-download-btn')?.addEventListener('click', () => { void takeViewportSnapshot(); });
g('snapshot-format')?.addEventListener('change', syncSnapshotTransparentEnabled);

const snapshotModalEl = g('snapshot-modal');
const openSnapshotModal = () => {
    if (!snapshotModalEl) return;
    snapshotModalEl.classList.add('is-open');
    snapshotModalEl.setAttribute('aria-hidden', 'false');
    syncSnapshotTransparentEnabled();
    const fn = g('snapshot-filename');
    if (fn) fn.value = getDefaultSnapshotExportBasename();
    fn?.focus();
};
const closeSnapshotModal = () => {
    if (!snapshotModalEl) return;
    snapshotModalEl.classList.remove('is-open');
    snapshotModalEl.setAttribute('aria-hidden', 'true');
};

g('snapshot-open-btn')?.addEventListener('click', openSnapshotModal);
g('snapshot-modal-backdrop')?.addEventListener('click', closeSnapshotModal);
g('snapshot-modal-close')?.addEventListener('click', closeSnapshotModal);
g('snapshot-modal-cancel')?.addEventListener('click', closeSnapshotModal);

const shortcutsModalEl = g('shortcuts-modal');
const openShortcutsModal = () => {
    if (!shortcutsModalEl) return;
    shortcutsModalEl.classList.add('is-open');
    shortcutsModalEl.setAttribute('aria-hidden', 'false');
    g('shortcuts-modal-close')?.focus();
};
const closeShortcutsModal = () => {
    if (!shortcutsModalEl) return;
    shortcutsModalEl.classList.remove('is-open');
    shortcutsModalEl.setAttribute('aria-hidden', 'true');
};
g('shortcuts-open-btn')?.addEventListener('click', openShortcutsModal);
g('shortcuts-modal-backdrop')?.addEventListener('click', closeShortcutsModal);
g('shortcuts-modal-close')?.addEventListener('click', closeShortcutsModal);
g('shortcuts-modal-close-btn')?.addEventListener('click', closeShortcutsModal);

(() => {
    try {
        const wEl = g('snapshot-w'), hEl = g('snapshot-h'), fEl = g('snapshot-format'), tEl = g('snapshot-transparent');
        enableNumericExprTyping(wEl);
        enableNumericExprTyping(hEl);
        const sw = localStorage.getItem(LS_SNAPSHOT_W);
        const sh = localStorage.getItem(LS_SNAPSHOT_H);
        const sf = localStorage.getItem(LS_SNAPSHOT_FMT);
        const st = localStorage.getItem(LS_SNAPSHOT_TRANSP);
        if (wEl && sw) wEl.value = sw;
        if (hEl && sh) hEl.value = sh;
        if (fEl && (sf === 'png' || sf === 'jpeg')) fEl.value = sf;
        if (tEl && st === '1') tEl.checked = true;
    } catch (_) { /* ignore */ }
    syncSnapshotTransparentEnabled();
})();

// Background color
const bgInput = g('bg-color-input');
const hexToColor = (hex) => {
    if (!hex || hex.length < 7) return;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const gv = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    cameraEntity.camera.clearColor = new pc.Color(r, gv, b);
};

const persistBgColor = (hex) => {
    try {
        const h = (hex ?? '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(h)) localStorage.setItem(LS_BG_COLOR_KEY, h.toLowerCase());
    } catch (_) { /* private mode / quota */ }
};

const loadCachedBgColor = () => {
    try {
        const raw = localStorage.getItem(LS_BG_COLOR_KEY);
        if (!raw) return;
        const h = raw.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(h)) return;
        const v = h.toLowerCase();
        if (bgInput) bgInput.value = v;
        hexToColor(v);
    } catch (_) { /* ignore */ }
};

const onBgColorPick = (e) => {
    const v = e.target.value;
    hexToColor(v);
    persistBgColor(v);
};
bgInput.addEventListener('input', onBgColorPick);
bgInput.addEventListener('change', onBgColorPick);

loadCachedBgColor();

// Brush color: picker ↔ hex field
const onBrushPickerChange = () => {
    syncBrushHexFieldFromPicker();
    persistBrushColor();
};
g('paint-color')?.addEventListener('input', onBrushPickerChange);
g('paint-color')?.addEventListener('change', onBrushPickerChange);
g('paint-color-hex')?.addEventListener('input', () => {
    const norm = normalizeBrushHex(g('paint-color-hex')?.value);
    if (norm) g('paint-color').value = norm;
    persistBrushColor();
});
g('paint-color-hex')?.addEventListener('change', applyBrushHexFromTextField);
g('paint-color-hex')?.addEventListener('blur', applyBrushHexFromTextField);

loadCachedBrushColor();
syncBrushHexFieldFromPicker();
syncLayerTransformUI();

g('floating-sel-clear')?.addEventListener('click', () => clearSelection({ recordUndo: true }));
['select-all-btn2', 'floating-sel-select-all']
    .forEach(id => g(id)?.addEventListener('click', () => selectAll({ recordUndo: true })));
['invert-sel-btn2', 'floating-sel-invert']
    .forEach(id => g(id)?.addEventListener('click', () => invertSelection({ recordUndo: true })));

document.querySelectorAll('.sel-mode-toolbar-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSelectionMode(btn.dataset.selMode));
});

syncSelectionModeToolbar();
['sharpen-sel-btn2','sharpen-sel-btn3']
    .forEach(id => g(id)?.addEventListener('click', () => sharpenSelectedSplats()));

g('blend-mode').addEventListener('change', () => {
    for (const p of paintables) syncDisplayUniforms(p);
});

g('reset-camera-btn').addEventListener('click', resetCamera);
g('frame-active-layer-btn')?.addEventListener('click', frameCameraOnSelectedLayer);

flyCamResetState.pos.copy(cameraEntity.getPosition());
flyCamResetState.yaw = orbit.yaw;
flyCamResetState.pitch = orbit.pitch;
syncCameraNavToolbar();
document.querySelectorAll('.camera-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const m = btn.dataset.cameraNav;
        if (m === 'orbit' || m === 'fly') setCameraNavMode(m);
    });
});
try {
    if (localStorage.getItem(LS_CAMERA_NAV) === 'fly') setCameraNavMode('fly');
} catch (_) { /* ignore */ }

// Slider live labels
const linkSlider = (id, labelId, fmt) => {
    const slider = g(id), label = g(labelId);
    if (!slider || !label) return;
    const update = () => { if (label.tagName === 'SPAN') label.textContent = fmt(parseFloat(slider.value)); };
    slider.addEventListener('input', update);
    update();
};

// Bidirectional sync: slider <-> number input (typing in the field is not overwritten until blur/change)
const linkSliderNum = (sliderId, numId, min, max, step, fmt = (v) => v, onCommit = null) => {
    const slider = g(sliderId), num = g(numId);
    if (!slider || !num) return;
    enableNumericExprTyping(num);
    const clamp = (v) => Math.max(min, Math.min(max, v));
    const snapToStep = (v) => {
        if (!Number.isFinite(step) || step <= 0) return clamp(v);
        const n = Math.round((clamp(v) - min) / step);
        return clamp(min + n * step);
    };
    const maybeCommit = () => { if (onCommit) onCommit(); };
    const syncToNum = () => { num.value = fmt(parseFloat(slider.value)); };
    const commitNum = () => {
        let v = parseNumericOrExpr(String(num.value).trim());
        if (v == null || !Number.isFinite(v)) {
            syncToNum();
            return;
        }
        v = snapToStep(v);
        slider.value = String(v);
        num.value = fmt(v);
        maybeCommit();
    };
    const onNumInput = () => {
        const raw = String(num.value).trim();
        if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return;
        let v = parseNumericOrExpr(raw);
        if (v == null || !Number.isFinite(v)) {
            v = parseFloat(raw);
            if (!Number.isFinite(v)) return;
        }
        slider.value = String(clamp(v));
    };
    slider.addEventListener('input', () => { syncToNum(); maybeCommit(); });
    num.addEventListener('input', onNumInput);
    num.addEventListener('change', commitNum);
    num.addEventListener('blur', commitNum);
    syncToNum();
};
linkSliderNum('brush-size',       'brush-size-num',       0.005, 0.5, 0.005, v => v.toFixed(3));
linkSliderNum('brush-hardness',   'brush-hardness-num',   0, 1, 0.05, v => v.toFixed(2));
linkSliderNum('brush-intensity',  'brush-intensity-num', 0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('brush-spacing',    'brush-spacing-num',   0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('eraser-size',      'eraser-size-num',     0.005, 0.5, 0.005, v => v.toFixed(3));
linkSliderNum('eraser-hardness',  'eraser-hardness-num', 0, 1, 0.05, v => v.toFixed(2));
linkSliderNum('eraser-intensity', 'eraser-intensity-num', 0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('eraser-spacing',   'eraser-spacing-num',  0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('eraser-depth',     'eraser-depth-num',    0, 1, 0.005, v => v.toFixed(3));
linkSliderNum('reset-size',       'reset-size-num',      0.005, 0.5, 0.005, v => v.toFixed(3));
linkSliderNum('selection-highlight-intensity', 'selection-highlight-intensity-num', 0.1, 1, 0.05, v => v.toFixed(2));
['selection-highlight-color', 'selection-highlight-intensity', 'selection-highlight-intensity-num'].forEach(id => {
    g(id)?.addEventListener('input', updateSelectionUI);
    g(id)?.addEventListener('change', updateSelectionUI);
});
syncSelectionDepthUI();
g('selection-depth-range')?.addEventListener('input', (e) => {
    selectionDepthControl = parseSelectionDepth(e.target.value);
    const lab = g('selection-depth-label');
    if (lab) lab.textContent = String(selectionDepthControl);
});
g('selection-depth-range')?.addEventListener('change', () => {
    try { localStorage.setItem(LS_SELECTION_DEPTH, String(selectionDepthControl)); } catch (_) { /* ignore */ }
});
linkSliderNum('reset-hardness',   'reset-hardness-num',  0, 1, 0.05, v => v.toFixed(2));
linkSliderNum('reset-spacing',    'reset-spacing-num',   0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('brush-select-size',     'brush-select-size-num',     0.005, 0.5, 0.005, v => v.toFixed(3));
linkSliderNum('brush-select-hardness','brush-select-hardness-num', 0, 1, 0.05, v => v.toFixed(2));
linkSliderNum('brush-select-spacing',  'brush-select-spacing-num',  0.05, 1, 0.05, v => v.toFixed(2));
linkSliderNum('generate-splats-size',  'generate-splats-size-num',  0.005, 0.5, 0.005, v => v.toFixed(3));
linkSliderNum('shape-density', 'shape-density-num', 0.5, 1000, 0.5, (v) =>
    (Math.abs(v % 1) < 1e-6 ? String(Math.round(v)) : v.toFixed(1)));
g('shape-density')?.addEventListener('input', saveShapeToolPrefs);
g('shape-density')?.addEventListener('change', saveShapeToolPrefs);

loadShapeToolPrefs();

const cgCommit = () => commitActiveColorGradeFromUI();
linkSliderNum('cg-exposure', 'cg-exposure-num', -4, 4, 0.05, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-contrast', 'cg-contrast-num', 0.1, 3, 0.05, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-black', 'cg-black-num', 0, 0.95, 0.005, (v) => v.toFixed(3), cgCommit);
linkSliderNum('cg-white', 'cg-white-num', 0.05, 1, 0.005, (v) => v.toFixed(3), cgCommit);
linkSliderNum('cg-sat', 'cg-sat-num', 0, 2, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-temp', 'cg-temp-num', -1, 1, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-tint', 'cg-tint-num', -1, 1, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-wheel-sh-amt', 'cg-wheel-sh-amt-num', 0, 1, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-wheel-md-amt', 'cg-wheel-md-amt-num', 0, 1, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-wheel-hi-amt', 'cg-wheel-hi-amt-num', 0, 1, 0.02, (v) => v.toFixed(2), cgCommit);
linkSliderNum('cg-lut-mix', 'cg-lut-mix-num', 0, 1, 0.02, (v) => v.toFixed(2), cgCommit);
initSplitToneEditors();
for (let i = 0; i < 8; i++) {
    for (const ax of ['h', 's', 'l']) {
        g(`cg-s${i}-${ax}`)?.addEventListener('input', cgCommit);
    }
}
g('cg-reset-btn')?.addEventListener('click', resetActiveColorGrade);
g('cg-toggle-visibility-btn')?.addEventListener('click', () => {
    const { grade, gsplat } = getActiveColorGradeBundle();
    grade.enabled = !(grade.enabled !== false);
    updateCgVisibilityButton(grade.enabled !== false);
    applyColorGradeBundleToGpu(grade, gsplat);
});
g('cg-bake-grade-btn')?.addEventListener('click', () => { bakeColorGradeIntoActiveTarget(); });
g('brush-bake-paint-btn')?.addEventListener('click', () => { bakeBrushPaintIntoModel(); });
g('paint-bucket-bake-btn')?.addEventListener('click', () => { bakeBrushPaintIntoModel(); });
g('cg-grade-selected-only')?.addEventListener('change', () => { pushAllColorGradesToGPU(); });
g('cg-tone-mode')?.addEventListener('change', cgCommit);
g('cg-lut-load-btn')?.addEventListener('click', () => g('cg-lut-file')?.click());
g('cg-lut-clear-btn')?.addEventListener('click', () => {
    const { grade, gsplat } = getActiveColorGradeBundle();
    destroyGradeLutGpu(grade);
    grade.lutSize = 0;
    grade.lutRgb = null;
    grade.lutName = '';
    grade.lutDomainMin = [0, 0, 0];
    grade.lutDomainMax = [1, 1, 1];
    grade.lutMix = 1;
    refreshColorGradeUIFromSelection();
    applyColorGradeBundleToGpu(grade, gsplat);
});
g('cg-lut-file')?.addEventListener('change', async (ev) => {
    const input = ev.target;
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = parseCubeLut(text);
        const { grade, gsplat } = getActiveColorGradeBundle();
        destroyGradeLutGpu(grade);
        grade.lutSize = parsed.size;
        grade.lutRgb = parsed.rgb;
        grade.lutDomainMin = [...parsed.domainMin];
        grade.lutDomainMax = [...parsed.domainMax];
        grade.lutName = file.name.replace(/\.cube$/i, '') || 'LUT';
        grade.lutMix = 1;
        refreshColorGradeUIFromSelection();
        applyColorGradeBundleToGpu(grade, gsplat);
    } catch (err) {
        console.error('[cube-lut]', err);
        alert(`Could not load LUT: ${err?.message || err}`);
    }
});
g('sel-show-highlight')?.addEventListener('change', (e) => {
    showSelectionHighlight = !!e.target.checked;
    updateSelectionUI();
});
refreshColorGradeUIFromSelection();
initCgGradeSliderUi();

linkSlider('color-tolerance',  'color-tolerance-val',  v => {
    const tol = Math.pow(v, 3) * 0.25;
    return tol < 0.001 ? `${(tol*1000).toFixed(2)}‰` : `${(tol*100).toFixed(2)}%`;
});
linkSlider('generate-splats-density', 'generate-splats-density-val', v => String(Math.round(v)));
linkSlider('sharpen-strength',  'sharpen-strength-val',  v => `${Math.round(v*100)}%`);
linkSlider('sharpen-strength2', 'sharpen-strength-val2', v => `${Math.round(v*100)}%`);
linkSlider('sharpen-strength3', 'sharpen-strength-val3', v => `${Math.round(v*100)}%`);
// Keep all three sharpen sliders in sync so the active panel always shows the right value
['sharpen-strength','sharpen-strength2','sharpen-strength3'].forEach(id => {
    g(id)?.addEventListener('input', (e) => {
        ['sharpen-strength','sharpen-strength2','sharpen-strength3'].forEach(sid => {
            if (sid !== id) { const el = g(sid); if (el) el.value = e.target.value; }
        });
    });
});

// Init sampled color display
const colorBox = g('generate-splats-color');
if (colorBox) colorBox.style.background = 'rgb(128,128,128)';

// ── Init ──────────────────────────────────────────────────────────────────────
setTool('cursor');
updateEmptyScenePlaceholder();
updateUndoRedoUI();
updateSelectionUI();

updateLayerGizmoModeButtons();
updateFloatingGizmoBarVisibility();
document.querySelectorAll('.gizmo-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const m = btn.dataset.gizmoMode;
        if (m !== 'translate' && m !== 'rotate' && m !== 'scale') return;
        layerGizmoMode = m;
        try { localStorage.setItem(LS_LAYER_GIZMO_MODE, m); } catch (_) {}
        updateLayerGizmoModeButtons();
        refreshLayerGizmoAttachment();
    });
});
g('toggle-layer-gizmo-btn')?.addEventListener('click', () => {
    layerGizmoVisible = !layerGizmoVisible;
    try { localStorage.setItem(LS_LAYER_GIZMO_VISIBLE, layerGizmoVisible ? '1' : '0'); } catch (_) {}
    refreshLayerGizmoAttachment();
});
g('toggle-viewport-grid-btn')?.addEventListener('click', () => {
    viewportGridVisible = !viewportGridVisible;
    viewportGridEntity.enabled = viewportGridVisible;
    if (viewportGridVisible) {
        viewportGridEntity.setPosition(orbit.target.x, orbit.target.y, orbit.target.z);
    }
    try { localStorage.setItem(LS_VIEWPORT_GRID, viewportGridVisible ? '1' : '0'); } catch (_) {}
    updateViewportGridToggleButton();
});
updateViewportGridToggleButton();
refreshLayerGizmoAttachment();

(() => {
    const tabs = document.querySelectorAll('.right-panel-tab[data-right-tab]');
    const p1 = g('right-tab-panel-1');
    const p2 = g('right-tab-panel-2');
    const p3 = g('right-tab-panel-3');
    const setPanel = (el, on) => {
        if (!el) return;
        el.classList.toggle('hidden', !on);
        if (on) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    };
    const activate = (id) => {
        tabs.forEach((t) => {
            const on = t.dataset.rightTab === id;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
        });
        setPanel(p1, id === '1');
        setPanel(p2, id === '2');
        setPanel(p3, id === '3');
        try { localStorage.setItem(LS_RIGHT_PANEL_TAB, id); } catch (_) { /* ignore */ }
    };
    tabs.forEach((t) => {
        t.addEventListener('click', () => activate(t.dataset.rightTab));
    });
    let initial = '1';
    try { initial = localStorage.getItem(LS_RIGHT_PANEL_TAB) || '1'; } catch (_) { /* ignore */ }
    if (!['1', '2', '3'].includes(initial)) initial = '1';
    activate(initial);
})();

// Right panel: drag the left edge to change width (saved in localStorage)
(() => {
    const panel = g('right-panel');
    const handle = g('right-panel-resizer');
    if (!panel || !handle) return;
    let startX = 0;
    let startW = 0;
    let raf = null;
    const bumpCanvas = () => {
        if (raf != null) return;
        raf = requestAnimationFrame(() => {
            raf = null;
            resizeCanvasToContainer();
        });
    };
    const startDrag = (clientX) => {
        startX = clientX;
        startW = panel.getBoundingClientRect().width;
        handle.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';
    };
    const endDrag = (e) => {
        if (!handle.classList.contains('dragging')) return;
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        try {
            if (e?.pointerId != null) handle.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        applyRightPanelWidth(panel.getBoundingClientRect().width, true);
    };
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        startDrag(e.clientX);
        try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
        if (!handle.classList.contains('dragging')) return;
        const dx = startX - e.clientX;
        applyRightPanelWidth(startW + dx, false);
        bumpCanvas();
    });
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 20 : 8;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const w = panel.getBoundingClientRect().width;
            const delta = e.key === 'ArrowLeft' ? step : -step;
            applyRightPanelWidth(w + delta, true);
        }
    });
})();

