/**
 * Thin compatibility shim — all data now comes from Supabase via maslog-db.js
 * Keep this file so older script tags still work.
 */
(function (global) {
  if (!global.MaslogDB) {
    console.error("Load supabase-config.js and maslog-db.js before user-app.js");
    return;
  }
  global.MaslogUser = global.MaslogDB;
})(typeof window !== "undefined" ? window : globalThis);
