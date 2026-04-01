/**
 * Startup lightbox embedding the Gumroad “name a fair price” page.
 * — Close / backdrop: snooze (localStorage) so the prompt can return later.
 * — Permanent hide: purchase detected (URL / Gumroad postMessage) or “I’ve contributed”.
 */
const LS_CONTRIBUTOR = 'photoshock-support-contributor';
const LS_DISMISS_UNTIL = 'photoshock-support-dismiss-until';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

const GUMROAD_ORIGINS = new Set([
    'https://gumroad.com',
    'https://www.gumroad.com',
    'https://app.gumroad.com',
]);

/** Protocol-relative so dev (http) and production (https) both work without mixed-content surprises when possible. */
const DEFAULT_EMBED_PATH = '//buyphotoshock.internektools.com';

/** Set in {@link initSupportModal}; used when opening from the menu bar. */
let supportEmbedUrl = null;

export function openSupportModal() {
    const root = document.getElementById('support-modal');
    const iframe = document.getElementById('support-modal-iframe');
    const closeBtn = document.getElementById('support-modal-close');
    if (!root || !iframe) return;
    const url = supportEmbedUrl || `${window.location.protocol}${DEFAULT_EMBED_PATH}`;
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    if (!iframe.getAttribute('src')) iframe.setAttribute('src', url);
    requestAnimationFrame(() => closeBtn?.focus());
}

function tryParseJson(data) {
    if (typeof data !== 'string') return null;
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function looksLikeGumroadPurchase(data) {
    if (data == null) return false;
    if (typeof data === 'string') {
        const j = tryParseJson(data);
        if (j) return looksLikeGumroadPurchase(j);
        return /\bpurchase\b|\bsale\b|\bcheckout\b/i.test(data) && /gumroad/i.test(data);
    }
    if (typeof data !== 'object') return false;
    const t = String(data.type ?? data.message_type ?? data.event ?? '').toLowerCase();
    if (t.includes('purchase') || t.includes('sale') || t === 'payment' || t === 'paid') return true;
    if (data.gumroad === true && (data.success === true || data.completed === true)) return true;
    return false;
}

/**
 * @param {{ embedUrl?: string }} [opts]
 */
export function initSupportModal(opts = {}) {
    const root = document.getElementById('support-modal');
    const iframe = document.getElementById('support-modal-iframe');
    const closeBtn = document.getElementById('support-modal-close');
    const contribBtn = document.getElementById('support-modal-contributed');
    const backdrop = document.getElementById('support-modal-backdrop');
    if (!root || !iframe) return;

    supportEmbedUrl = opts.embedUrl || `${window.location.protocol}${DEFAULT_EMBED_PATH}`;
    const embedUrl = supportEmbedUrl;

    const hide = () => {
        root.classList.remove('is-open');
        root.setAttribute('aria-hidden', 'true');
    };

    const markContributor = () => {
        try {
            localStorage.setItem(LS_CONTRIBUTOR, '1');
        } catch (_) { /* ignore */ }
        hide();
    };

    const snooze = () => {
        try {
            localStorage.setItem(LS_DISMISS_UNTIL, String(Date.now() + DISMISS_MS));
        } catch (_) { /* ignore */ }
        hide();
    };

    const isContributor = () => {
        try {
            return localStorage.getItem(LS_CONTRIBUTOR) === '1';
        } catch {
            return false;
        }
    };

    const isSnoozed = () => {
        try {
            const t = parseInt(localStorage.getItem(LS_DISMISS_UNTIL), 10);
            return Number.isFinite(t) && Date.now() < t;
        } catch {
            return false;
        }
    };

    const stripSupportParamsFromUrl = () => {
        try {
            const u = new URL(window.location.href);
            const keys = ['photoshock_contributor', 'gumroad_success'];
            let changed = false;
            for (const k of keys) {
                if (u.searchParams.has(k)) {
                    u.searchParams.delete(k);
                    changed = true;
                }
            }
            if (changed) {
                const q = u.searchParams.toString();
                history.replaceState({}, '', `${u.pathname}${q ? `?${q}` : ''}${u.hash}`);
            }
        } catch (_) { /* ignore */ }
    };

    const checkUrlParams = () => {
        try {
            const u = new URL(window.location.href);
            const v = u.searchParams.get('photoshock_contributor');
            const g = u.searchParams.get('gumroad_success');
            if (v === '1' || g === '1' || g === 'true') {
                stripSupportParamsFromUrl();
                markContributor();
                return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    };

    const show = () => {
        openSupportModal();
    };

    document.getElementById('support-open-btn')?.addEventListener('click', () => {
        openSupportModal();
    });

    const onMessage = (ev) => {
        if (!GUMROAD_ORIGINS.has(ev.origin)) return;
        if (looksLikeGumroadPurchase(ev.data)) markContributor();
    };
    window.addEventListener('message', onMessage);

    closeBtn?.addEventListener('click', snooze);
    backdrop?.addEventListener('click', snooze);
    contribBtn?.addEventListener('click', markContributor);

    if (checkUrlParams()) return;
    if (isContributor()) return;
    if (isSnoozed()) return;

    show();
}

export function isSupportModalOpen() {
    return document.getElementById('support-modal')?.classList.contains('is-open') ?? false;
}

export function closeSupportModalSnoozed() {
    const root = document.getElementById('support-modal');
    if (!root?.classList.contains('is-open')) return;
    try {
        localStorage.setItem(LS_DISMISS_UNTIL, String(Date.now() + DISMISS_MS));
    } catch (_) { /* ignore */ }
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
}
