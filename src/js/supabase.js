import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { CONFIG } from './config.js';

if (CONFIG.supabaseUrl.startsWith('https://YOUR-')) {
  console.warn('config.json still holds placeholder Supabase credentials.');
}

export const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 5 } },
});

/** Turn a PostgREST/GoTrue error into something worth showing a person. */
export function readableError(error) {
  if (!error) return 'Something went wrong.';
  const msg = error.message || String(error);
  if (/duplicate key.*profiles_username/i.test(msg)) return 'That name is taken.';
  if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/User already registered/i.test(msg)) return 'That email already has an account.';
  if (/Password should be/i.test(msg)) return 'Password must be at least 8 characters.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Cannot reach the server. Check your connection.';
  if (/not your turn/i.test(msg)) return 'Your opponent moved first — reloading the table.';
  if (/JWT|not authenticated/i.test(msg)) return 'Your session expired. Sign in again.';
  return msg;
}
