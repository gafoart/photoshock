/** Gradient tracks + hollow thumbs for #color-grade-section range inputs. */

const ZONE_BASE_HUE = [0, 35, 55, 125, 185, 220, 275, 305];

const hslToRgb = (h, s, l) => {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rp = 0;
    let gp = 0;
    let bp = 0;
    if (h < 60) [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else [rp, gp, bp] = [c, 0, x];
    const r = Math.round((rp + m) * 255);
    const g = Math.round((gp + m) * 255);
    const b = Math.round((bp + m) * 255);
    return { r, g, b };
};

const rgbToHex = ({ r, g, b }) =>
    `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`;

const zoneHueHex = (zoneIndex, hSliderValue) => {
    const base = ZONE_BASE_HUE[zoneIndex] ?? 0;
    const hVal = Number(hSliderValue) || 0;
    const hue = (base + hVal * 360 + 3600) % 360;
    return rgbToHex(hslToRgb(hue, 1, 0.5));
};

export function refreshCgGradeSliderTracks() {
    const sec = document.getElementById('color-grade-section');
    if (!sec) return;

    const splitPairs = [
        ['cg-wheel-sh-amt', 'cg-wheel-sh'],
        ['cg-wheel-md-amt', 'cg-wheel-md'],
        ['cg-wheel-hi-amt', 'cg-wheel-hi'],
    ];
    for (const [rid, cid] of splitPairs) {
        const r = document.getElementById(rid);
        const c = document.getElementById(cid);
        if (r && c) {
            const end = c.value || '#808080';
            r.style.setProperty('--cg-track-gradient', `linear-gradient(90deg, #ffffff 0%, ${end} 100%)`);
        }
    }

    for (let i = 0; i < 8; i++) {
        const hEl = document.getElementById(`cg-s${i}-h`);
        const sEl = document.getElementById(`cg-s${i}-s`);
        const lEl = document.getElementById(`cg-s${i}-l`);
        const col = zoneHueHex(i, hEl?.value ?? 0);
        if (sEl) {
            sEl.style.setProperty('--cg-track-gradient', `linear-gradient(90deg, #ffffff 0%, ${col} 100%)`);
        }
        if (lEl) {
            lEl.style.setProperty('--cg-track-gradient', `linear-gradient(90deg, #000000 0%, ${col} 100%)`);
        }
    }
}

export function initCgGradeSliderUi() {
    refreshCgGradeSliderTracks();
    document.getElementById('color-grade-section')?.addEventListener('input', (e) => {
        const t = e.target;
        if (t?.matches?.('input[type="range"], input[type="color"]')) refreshCgGradeSliderTracks();
    });
}
