// Supabase client — created only when both env vars are present. When they're absent,
// the app runs in local-only mode (recipes save to localStorage) and `supabase` is null.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseEnabled = Boolean(url && anon)

// These are the client defaults, pinned explicitly because staying signed in is
// a feature here, not an accident: the session sits in localStorage and the
// access token refreshes itself, so a sign-in survives quitting and rebooting.
// storageKey is deliberately left alone — changing it orphans existing sessions
// and signs everyone out once.
export const supabase = supabaseEnabled
  ? createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null
