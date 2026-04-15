import { getSupabase, isSupabaseAuthEnabled } from './supabase-client.js';
import { getPosthog } from './posthog-client.js';

let signUpMode = false;

function setError(msg) {
    const el = document.getElementById('auth-modal-error');
    if (el) {
        el.textContent = msg || '';
        el.hidden = !msg;
    }
}

function hideEmailConfirmBanner() {
    document.getElementById('auth-confirm-email-banner')?.classList.add('hidden');
}

/** After sign-up when Supabase requires email confirmation: show notice + switch to sign-in form. */
function showPostSignupConfirmEmail(email) {
    const banner = document.getElementById('auth-confirm-email-banner');
    const addr = document.getElementById('auth-confirm-email-address');
    if (addr) addr.textContent = email;
    banner?.classList.remove('hidden');
    signUpMode = false;
    syncFormMode();
    const pw = document.getElementById('auth-password');
    if (pw) pw.value = '';
    requestAnimationFrame(() => {
        pw?.focus();
    });
}

function syncFormMode() {
    const title = document.getElementById('auth-modal-title');
    const submit = document.getElementById('auth-modal-submit');
    const toggle = document.getElementById('auth-mode-toggle');
    if (title) title.textContent = signUpMode ? 'Create account' : 'Sign in';
    if (submit) submit.textContent = signUpMode ? 'Create account' : 'Sign in';
    if (toggle) {
        toggle.textContent = signUpMode
            ? 'Already have an account? Sign in'
            : 'Need an account? Create one';
    }
}

export function openAuthModal(opts = {}) {
    const root = document.getElementById('auth-modal');
    if (!root || !isSupabaseAuthEnabled()) return;
    const hint = document.getElementById('auth-modal-hint');
    if (hint) {
        hint.textContent = opts.reason === 'load'
            ? 'Sign in to load or import splat files into the viewer.'
            : 'Sign in to use Photoshock with your account.';
    }
    setError('');
    hideEmailConfirmBanner();
    signUpMode = false;
    syncFormMode();
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        document.getElementById('auth-email')?.focus();
    });
    getPosthog()?.capture('auth_modal_opened', { reason: opts.reason ?? 'manual' });
}

export function closeAuthModal() {
    const root = document.getElementById('auth-modal');
    if (!root) return;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    setError('');
    hideEmailConfirmBanner();
}

export function isAuthModalOpen() {
    return document.getElementById('auth-modal')?.classList.contains('is-open') ?? false;
}

/**
 * @param {import('@supabase/supabase-js').Session | null} session
 */
export function updateAuthBar(session) {
    const bar = document.getElementById('auth-bar');
    const sep = document.getElementById('auth-bar-sep');
    const out = document.getElementById('auth-bar-signed-out');
    const inn = document.getElementById('auth-bar-signed-in');
    const emailEl = document.getElementById('auth-bar-email');
    const hint = document.getElementById('empty-scene-auth-hint');

    if (!bar) return;

    if (!isSupabaseAuthEnabled()) {
        bar.classList.add('hidden');
        sep?.classList.add('hidden');
        document.body.classList.remove('photoshock-auth-guest');
        if (hint) hint.classList.add('hidden');
        return;
    }

    bar.classList.remove('hidden');
    sep?.classList.remove('hidden');
    const user = session?.user;
    if (user) {
        out?.classList.add('hidden');
        inn?.classList.remove('hidden');
        if (emailEl) {
            const e = user.email ?? 'Signed in';
            emailEl.textContent = e.length > 28 ? `${e.slice(0, 26)}…` : e;
            emailEl.title = e;
        }
        document.body.classList.remove('photoshock-auth-guest');
        if (hint) hint.classList.add('hidden');
    } else {
        out?.classList.remove('hidden');
        inn?.classList.add('hidden');
        document.body.classList.add('photoshock-auth-guest');
        if (hint) hint.classList.remove('hidden');
    }
}

export function initAuthModal() {
    const root = document.getElementById('auth-modal');
    const backdrop = document.getElementById('auth-modal-backdrop');
    const closeBtn = document.getElementById('auth-modal-close');
    const form = document.getElementById('auth-form');
    const toggle = document.getElementById('auth-mode-toggle');
    const signOutBar = document.getElementById('auth-bar-sign-out');
    const signInBar = document.getElementById('auth-bar-sign-in');

    closeBtn?.addEventListener('click', closeAuthModal);
    backdrop?.addEventListener('click', closeAuthModal);

    signInBar?.addEventListener('click', () => openAuthModal({ reason: 'manual' }));

    document.getElementById('auth-google-btn')?.addEventListener('click', async () => {
        const sb = getSupabase();
        if (!sb) return;
        setError('');
        const redirectTo = `${window.location.origin}${window.location.pathname || '/'}`;
        const { data, error } = await sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo, queryParams: { prompt: 'select_account' } },
        });
        if (error) {
            setError(error.message);
            return;
        }
        if (data?.url) {
            getPosthog()?.capture('auth_google_redirect');
            window.location.assign(data.url);
        }
    });

    signOutBar?.addEventListener('click', async () => {
        const sb = getSupabase();
        if (sb) await sb.auth.signOut();
        getPosthog()?.capture('auth_signed_out');
    });

    toggle?.addEventListener('click', (e) => {
        e.preventDefault();
        signUpMode = !signUpMode;
        syncFormMode();
        setError('');
        if (signUpMode) hideEmailConfirmBanner();
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const sb = getSupabase();
        if (!sb) return;

        const email = document.getElementById('auth-email')?.value?.trim() ?? '';
        const password = document.getElementById('auth-password')?.value ?? '';
        if (!email || !password) {
            setError('Enter email and password.');
            return;
        }

        const submit = document.getElementById('auth-modal-submit');
        if (submit) submit.disabled = true;
        setError('');

        try {
            if (signUpMode) {
                const { data, error } = await sb.auth.signUp({
                    email,
                    password,
                    options: { emailRedirectTo: `${window.location.origin}/` },
                });
                if (error) throw error;
                getPosthog()?.capture('auth_sign_up_attempt');
                if (data.session) {
                    hideEmailConfirmBanner();
                    closeAuthModal();
                } else {
                    showPostSignupConfirmEmail(email);
                }
            } else {
                const { error } = await sb.auth.signInWithPassword({ email, password });
                if (error) throw error;
                getPosthog()?.capture('auth_signed_in');
                hideEmailConfirmBanner();
                closeAuthModal();
            }
        } catch (err) {
            setError(err?.message ?? 'Something went wrong.');
        } finally {
            if (submit) submit.disabled = false;
        }
    });

    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if (!root?.classList.contains('is-open')) return;
        closeAuthModal();
    });
}
