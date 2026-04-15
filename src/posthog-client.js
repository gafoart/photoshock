/**
 * PostHog product analytics. Set VITE_POSTHOG_KEY (+ optional VITE_POSTHOG_HOST) in `.env` — never commit secrets.
 * @see https://posthog.com/docs/libraries/js
 */
/** @type {import('posthog-js').PostHog | null} */
let posthogClient = null;

/** Active PostHog instance after init (e.g. for `identify` after Supabase login). */
export function getPosthog() {
    return posthogClient;
}

export async function initPosthog() {
    const key = import.meta.env.VITE_POSTHOG_KEY;
    if (!key) return;

    const [{ default: posthog }] = await Promise.all([import('posthog-js')]);
    posthogClient = posthog;

    const apiHost = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

    posthog.init(key, {
        api_host: apiHost,
        defaults: '2026-01-30',
        persistence: 'localStorage+cookie',
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: true,
        capture_pageleave: true,
    });

    const app = document.getElementById('app');
    if (!app) return;

    app.addEventListener(
        'click',
        (e) => {
            const bar = e.target.closest('#menu-bar, #options-bar');
            if (!bar) return;
            const el = e.target.closest('[id]');
            if (!el || !bar.contains(el)) return;
            posthog.capture('ui_click', {
                element_id: el.id,
                tag: el.tagName.toLowerCase(),
            });
        },
        true
    );
}
