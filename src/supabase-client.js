import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** When false, model loading is not gated (local dev without env). */
export function isSupabaseAuthEnabled() {
    return Boolean(url && anonKey);
}

let client = null;
/** @returns {import('@supabase/supabase-js').SupabaseClient | null} */
export function getSupabase() {
    if (!isSupabaseAuthEnabled()) return null;
    if (!client) {
        client = createClient(url, anonKey, {
            auth: {
                flowType: 'pkce',
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true,
            },
        });
    }
    return client;
}

let cachedSession = null;

/** @returns {import('@supabase/supabase-js').Session | null} */
export function getCachedSession() {
    return cachedSession;
}

/**
 * @param {(session: import('@supabase/supabase-js').Session | null) => void} onSession
 */
export async function initSupabaseAuth(onSession) {
    const sb = getSupabase();
    if (!sb) {
        cachedSession = null;
        onSession?.(null);
        return;
    }
    const { data: { session } } = await sb.auth.getSession();
    cachedSession = session ?? null;
    onSession?.(cachedSession);
    sb.auth.onAuthStateChange((_event, session) => {
        cachedSession = session ?? null;
        onSession?.(cachedSession);
    });
}
