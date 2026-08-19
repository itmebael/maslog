/**
 * Supabase client for Maslog Cold Spring (static HTML app)
 * Publishable key is safe for browser use (RLS must be configured).
 */
(function (global) {
  const SUPABASE_URL = "https://ghabfpeaoksvqfntgrff.supabase.co";
  const SUPABASE_KEY = "sb_publishable_Bs7EYqOC__GO21Z1T6f6Mw_AdN8rBbo";

  function getClient() {
    if (global.__maslogSupabase) return global.__maslogSupabase;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error("Supabase JS not loaded. Include @supabase/supabase-js before this file.");
    }
    global.__maslogSupabase = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    return global.__maslogSupabase;
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  const SESSION_KEY = "maslog_session_v2";

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  global.MaslogConfig = {
    SUPABASE_URL,
    SUPABASE_KEY,
    getClient,
    sha256,
    saveSession,
    getSession,
    clearSession,
    SESSION_KEY,
  };
})(typeof window !== "undefined" ? window : globalThis);
