/**
 * Adobe / Resolve-style ASCII .cube LUT (3D, regular grid).
 * Table order: blue (B) slowest, green (G) mid, red (R) fastest — matches a 2D atlas
 * with width N*N, height N and texel x = r + g*N, y = b.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * @param {string} text
 * @returns {{ size: number, domainMin: number[], domainMax: number[], rgb: Float32Array }}
 */
export function parseCubeLut(text) {
    const lines = String(text).split(/\r?\n/);
    let size = 0;
    let domainMin = [0, 0, 0];
    let domainMax = [1, 1, 1];
    const triples = [];
    for (let raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const up = line.toUpperCase();
        if (up.startsWith('TITLE')) continue;
        if (up.startsWith('LUT_3D_SIZE')) {
            const p = line.split(/\s+/);
            size = parseInt(p[1], 10);
            continue;
        }
        if (up.startsWith('DOMAIN_MIN')) {
            const p = line.split(/\s+/);
            domainMin = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
            continue;
        }
        if (up.startsWith('DOMAIN_MAX')) {
            const p = line.split(/\s+/);
            domainMax = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
            continue;
        }
        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length >= 3) {
            const r = parseFloat(parts[0]);
            const g = parseFloat(parts[1]);
            const b = parseFloat(parts[2]);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                triples.push(r, g, b);
            }
        }
    }
    if (!Number.isFinite(size) || size < 2 || size > 128) {
        throw new Error(`Invalid or unsupported LUT_3D_SIZE (2–128): ${size}`);
    }
    const expected = size * size * size * 3;
    if (triples.length !== expected) {
        throw new Error(`Expected ${size ** 3} RGB rows, got ${triples.length / 3}`);
    }
    return {
        size,
        domainMin,
        domainMax,
        rgb: new Float32Array(triples),
    };
}

/**
 * Trilinear sample in normalized input space (rgb typically 0–1 after tone map).
 * @param {number[]} rgb length 3
 * @param {{ size: number, domainMin: number[], domainMax: number[], rgb: Float32Array }} parsed
 */
export function sampleCubeTrilinear(rgb, parsed) {
    const N = parsed.size;
    const data = parsed.rgb;
    const lo = parsed.domainMin;
    const hi = parsed.domainMax;
    const inv0 = 1 / Math.max(1e-8, hi[0] - lo[0]);
    const inv1 = 1 / Math.max(1e-8, hi[1] - lo[1]);
    const inv2 = 1 / Math.max(1e-8, hi[2] - lo[2]);
    const p0 = clamp01((rgb[0] - lo[0]) * inv0);
    const p1 = clamp01((rgb[1] - lo[1]) * inv1);
    const p2 = clamp01((rgb[2] - lo[2]) * inv2);
    const fm = N - 1;
    const x = p0 * fm;
    const y = p1 * fm;
    const z = p2 * fm;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const x1 = Math.min(x0 + 1, N - 1);
    const y1 = Math.min(y0 + 1, N - 1);
    const z1 = Math.min(z0 + 1, N - 1);
    const tx = x - x0;
    const ty = y - y0;
    const tz = z - z0;

    const at = (ix, iy, iz) => {
        const t = ix + iy * N + iz * N * N;
        const i = t * 3;
        return [data[i], data[i + 1], data[i + 2]];
    };

    const c000 = at(x0, y0, z0);
    const c100 = at(x1, y0, z0);
    const c010 = at(x0, y1, z0);
    const c110 = at(x1, y1, z0);
    const c001 = at(x0, y0, z1);
    const c101 = at(x1, y0, z1);
    const c011 = at(x0, y1, z1);
    const c111 = at(x1, y1, z1);

    const lerp3 = (a, b, t) => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
    const c00 = lerp3(c000, c100, tx);
    const c10 = lerp3(c010, c110, tx);
    const c01 = lerp3(c001, c101, tx);
    const c11 = lerp3(c011, c111, tx);
    const c0 = lerp3(c00, c10, ty);
    const c1 = lerp3(c01, c11, ty);
    return lerp3(c0, c1, tz);
}

/**
 * Pack LUT RGB (float table) into RGBA8 for GPU upload; clamps output to 0–1.
 * Layout: width N*N, height N, texel (x,y) = (r+g*N, b).
 */
export function lutFloatRgbToRgba8(parsed) {
    const N = parsed.size;
    const data = parsed.rgb;
    const w = N * N;
    const h = N;
    const out = new Uint8Array(w * h * 4);
    for (let b = 0; b < N; b++) {
        for (let g = 0; g < N; g++) {
            for (let r = 0; r < N; r++) {
                const src = (b * N * N + g * N + r) * 3;
                const x = r + g * N;
                const y = b;
                const dst = (y * w + x) * 4;
                out[dst] = Math.round(clamp01(data[src]) * 255);
                out[dst + 1] = Math.round(clamp01(data[src + 1]) * 255);
                out[dst + 2] = Math.round(clamp01(data[src + 2]) * 255);
                out[dst + 3] = 255;
            }
        }
    }
    return out;
}
