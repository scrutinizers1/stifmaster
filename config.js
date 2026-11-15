/* ============================================================================
   Light Bearers — Supabase connection  (config.js)
   ----------------------------------------------------------------------------
   Supabase Dashboard -> Project Settings -> API
       "Project URL"        ->  supabaseUrl
       "anon" / "public" key ->  supabaseAnonKey

   The anon key is DESIGNED to be public — it only allows what your Row Level
   Security policies allow. It is safe to commit this file.

   NEVER put the "service_role" key here. That one is a master key and must stay
   on a server.
   ============================================================================ */
window.LB_CONFIG = {
  supabaseUrl: "https://gbykpzdjvclheizzcint.supabase.co",
  supabaseAnonKey: "sb_publishable_8wGDTQ7CqswS9y9-y4BncQ_fu-CpWEw"
};
