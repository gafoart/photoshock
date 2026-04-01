/**
 * Tabler Icons from `public/tabler-icons/{outline|filled}/` (static fetch + optional warm cache).
 */

const tablerBaseUrl = () => {
    const base = import.meta.env.BASE_URL || '/';
    return `${base.replace(/\/?$/, '/') }tabler-icons`;
};

const cacheKey = (variant, name) => `${variant}/${name}`;

/** @type {Map<string, string>} */
const rawCache = new Map();

/**
 * Load raw SVG text (cached). Used by hydrate and by warmTablerIconCache.
 */
export async function loadTablerRaw(name, variant = 'outline') {
    const k = cacheKey(variant, name);
    if (rawCache.has(k)) return rawCache.get(k);

    const url = `${tablerBaseUrl()}/${variant}/${name}.svg`;
    let res;
    try {
        res = await fetch(url);
    } catch (e) {
        console.warn('[tabler-icons] fetch failed', url, e);
        throw e;
    }
    if (!res.ok) {
        console.warn('[tabler-icons] missing file', url);
        throw new Error(`Tabler icon missing: ${url}`);
    }
    const text = await res.text();
    rawCache.set(k, text);
    return text;
}

/** Preload icon SVGs so `tablerIconHtmlSync` works before first paint (e.g. dynamic layer rows). */
export async function warmTablerIconCache(names, variant = 'outline') {
    await Promise.all(
        names.map((n) =>
            loadTablerRaw(n, variant).catch((err) => {
                console.warn('[tabler-icons] could not warm icon — check public/tabler-icons:', `${variant}/${n}.svg`, err?.message || err);
            }),
        ),
    );
}

const stripLeadingComment = (raw) => raw.replace(/<!--[\s\S]*?-->\s*/, '');

/** Ensure root <svg> has explicit width/height (some exports omit them and blow up in layout). */
function ensureSvgRootDimensions(svg, size) {
    const idx = svg.indexOf('<svg');
    if (idx === -1) return svg;
    const closeIdx = svg.indexOf('>', idx);
    if (closeIdx === -1) return svg;
    const openTag = svg.slice(idx, closeIdx + 1);
    const inner = openTag.slice(4, -1);
    const cleaned = inner
        .replace(/\s+width\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+height\s*=\s*"[^"]*"/gi, '')
        .trim();
    const body = cleaned ? `${cleaned} ` : '';
    const newOpen = `<svg ${body}width="${size}" height="${size}">`;
    return svg.slice(0, idx) + newOpen + svg.slice(closeIdx + 1);
}

/** @param {string} raw */
export function formatTablerSvg(raw, { size = 24, className = '' } = {}) {
    let svg = stripLeadingComment(raw);

    // Adobe / alternate exports: hard-coded black ignores CSS `color`; align with Tabler `currentColor`.
    svg = svg.replace(/stroke:\s*#000000\b/gi, 'stroke: currentColor');
    svg = svg.replace(/stroke:\s*#000\b/gi, 'stroke: currentColor');
    svg = svg.replace(/fill:\s*#000000\b/gi, 'fill: currentColor');
    svg = svg.replace(/fill:\s*#000\b/gi, 'fill: currentColor');
    svg = svg.replace(/stroke="#000000"/gi, 'stroke="currentColor"');
    svg = svg.replace(/stroke="#000"/gi, 'stroke="currentColor"');
    svg = svg.replace(/fill="#000000"/gi, 'fill="currentColor"');
    svg = svg.replace(/fill="#000"/gi, 'fill="currentColor"');
    svg = svg.replace(/stroke-width:\s*2px/gi, 'stroke-width: 2');

    svg = ensureSvgRootDimensions(svg, size);

    if (className) {
        svg = svg.replace('<svg', `<svg class="${className}"`);
    }
    if (!/\baria-hidden=/.test(svg)) {
        svg = svg.replace('<svg', '<svg aria-hidden="true"');
    }
    return svg;
}

/**
 * Inline SVG string from cache. Call `warmTablerIconCache` for these names at startup.
 * If missing, returns a placeholder span for `hydrateTablerIcons` to upgrade later.
 */
export function tablerIconHtmlSync(name, { variant = 'outline', size = 24, className = '' } = {}) {
    const raw = rawCache.get(cacheKey(variant, name));
    if (!raw) {
        return `<span data-tabler-icon="${name}" data-tabler-size="${size}" data-tabler-variant="${variant}"></span>`;
    }
    return formatTablerSvg(raw, { size, className });
}

/**
 * Replace `[data-tabler-icon="kebab-name"]` with inline SVG.
 * Optional: `data-tabler-size`, `data-tabler-variant` (`outline` | `filled`).
 */
export async function hydrateTablerIcons(root) {
    if (!root) return;
    const slots = root.querySelectorAll('[data-tabler-icon]');
    await Promise.all(
        [...slots].map(async (el) => {
            const name = el.getAttribute('data-tabler-icon');
            const variant = el.getAttribute('data-tabler-variant') || 'outline';
            const size = parseInt(el.getAttribute('data-tabler-size') || '24', 10) || 24;
            if (!name || (variant !== 'outline' && variant !== 'filled')) return;

            let raw;
            try {
                raw = await loadTablerRaw(name, variant);
            } catch {
                return;
            }
            el.outerHTML = formatTablerSvg(raw, { size });
        }),
    );
}
