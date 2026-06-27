/**
 * Supabase browser client (auth).
 *
 * Enabled only when BOTH NEXT_PUBLIC_SUPABASE_URL and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY are set. Otherwise the app falls back to the
 * soft entry gate so it keeps working offline / in tests without any backend.
 *
 * Set these in Vercel (Project → Settings → Environment Variables):
 *   NEXT_PUBLIC_SUPABASE_URL      = https://<project-ref>.supabase.co
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY = <anon public key>
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();

export const supabaseEnabled: boolean = Boolean(url && anon);

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;
