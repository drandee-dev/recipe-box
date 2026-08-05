// Supabase client — created only when both env vars are present. When they're absent,
// the app runs in local-only mode (recipes save to localStorage) and `supabase` is null.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseEnabled = Boolean(url && anon)

export const supabase = supabaseEnabled ? createClient(url, anon) : null
