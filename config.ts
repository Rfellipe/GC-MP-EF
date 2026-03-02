import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Env vars (configure in Supabase dashboard)
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SECRET_KEY = Deno.env.get("SECRET_KEY")!;
export const MP_ACCESS_TOKEN = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN")!;
export const MP_WEBHOOK_SECRET =
  Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") || "";
export const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// Supabase client with service role (bypasses RLS)
export const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});
