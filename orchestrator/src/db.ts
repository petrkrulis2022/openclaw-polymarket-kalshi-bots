import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`Environment variable "${name}" is required but not set.`);
  return v;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

export const WDK_TREASURY_URL =
  process.env["WDK_TREASURY_URL"] ?? "http://localhost:3001";
